import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecoverItem } from '../../src/cli/recover-attempt.js';
import type { FlacFormat, RecoveryEnv } from '../../src/cli/recover-engine.js';

import { attemptRecovery } from '../../src/cli/recover-attempt.js';
import { DEFAULT_CONFIG } from '../../src/config/types.js';
import {
	findFileByPath,
	updateVerificationResult,
	upsertFile,
} from '../../src/database/queries.js';
import { initializeSchema } from '../../src/database/schema.js';

let db: Database.Database;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
});

afterEach(() => {
	db.close();
});

const SRC = '/music/song.flac';
const DEST = '/music/song [Recovered].flac';
const PARTIAL = `${DEST}.partial`;

const fmt = (totalSamples: number, sampleRate = 44_100): FlacFormat => ({
	bitsPerSample: 16,
	channels: 2,
	sampleRate,
	totalSamples,
});

const probeBy =
	(srcTotal: number, partialTotal: number, sampleRate = 44_100) =>
	(p: string): Promise<FlacFormat> =>
		Promise.resolve(fmt(p.endsWith('.partial') ? partialTotal : srcTotal, sampleRate));

function makeEnv(overrides: Partial<RecoveryEnv>): RecoveryEnv {
	return {
		carryMetadata: () => Promise.resolve(),
		decodeReencode: () => Promise.resolve(),
		exists: () => true,
		probe: () => Promise.resolve(fmt(1000)),
		rename: () => Promise.resolve(),
		shouldStop: () => false,
		testPasses: () => Promise.resolve(true),
		unlink: () => Promise.resolve(),
		utimes: () => Promise.resolve(),
		...overrides,
	};
}

function seed(src = SRC): RecoverItem {
	upsertFile(db, { current_path: src, file_mtime: null, file_size: null });
	updateVerificationResult(db, src, { error_severity: 'recoverable', last_result: 'corrupt' });
	return {
		atimeMs: 1000,
		dest: DEST,
		dev: 1,
		mtimeMs: 2000,
		row: findFileByPath(db, src)!,
		size: 100,
		src,
	};
}

const recoveryResult = (src = SRC) => findFileByPath(db, src)!.recovery_result;

describe('attemptRecovery', () => {
	it('does not start or record a verdict when shutting down', async () => {
		const item = seed();
		const result = await attemptRecovery(
			makeEnv({ shouldStop: () => true }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('interrupted');
		expect(recoveryResult()).toBeNull();
	});

	it('treats a vanished source as failed without recording a verdict', async () => {
		const item = seed();
		const result = await attemptRecovery(
			makeEnv({ exists: () => false, probe: () => Promise.reject(new Error('gone')) }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('failed');
		expect(result.detail).toContain('source disappeared');
		expect(recoveryResult()).toBeNull();
	});

	it('records unsuitable when metaflac cannot read a present file', async () => {
		const item = seed();
		const result = await attemptRecovery(
			makeEnv({ probe: () => Promise.reject(new Error('bad header')) }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('unsuitable');
		expect(result.detail).toContain('metaflac could not read');
		expect(recoveryResult()).toBe('unsuitable');
	});

	it('records unsuitable when the stream claims zero samples', async () => {
		const item = seed();
		const result = await attemptRecovery(
			makeEnv({ probe: () => Promise.resolve(fmt(0)) }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('unsuitable');
		expect(result.detail).toContain('unknown length');
		expect(recoveryResult()).toBe('unsuitable');
	});

	it('records unsuitable and cleans up when the re-encode fails on a present file', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		const result = await attemptRecovery(
			makeEnv({
				decodeReencode: () => Promise.reject(new Error('boom')),
				probe: probeBy(1000, 1000),
				unlink,
			}),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('unsuitable');
		expect(result.detail).toContain('decode/re-encode failed');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBe('unsuitable');
	});

	it('treats a source that vanished mid-re-encode as failed', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		const result = await attemptRecovery(
			makeEnv({
				decodeReencode: () => Promise.reject(new Error('boom')),
				exists: () => false,
				probe: probeBy(1000, 1000),
				unlink,
			}),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('failed');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBeNull();
	});

	it('does not record a verdict when the re-encode test fails during shutdown', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		const shouldStop = vi.fn<() => boolean>();
		// False at the pre-flight guard, true at the post-testPasses check
		shouldStop.mockReturnValueOnce(false).mockReturnValue(true);
		const result = await attemptRecovery(
			makeEnv({
				probe: probeBy(1000, 900),
				shouldStop,
				testPasses: () => Promise.resolve(false),
				unlink,
			}),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('interrupted');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(findFileByPath(db, SRC)!.recovery_attempted_at).toBeNull();
		expect(recoveryResult()).toBeNull();
	});

	it('records unsuitable when the trailing loss exceeds the limit', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		const result = await attemptRecovery(
			makeEnv({ probe: probeBy(200_000, 10_000), unlink }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('unsuitable');
		expect(result.detail).toContain('trailing loss');
		expect(result.lostSamples).toBe(190_000);
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBe('unsuitable');
	});

	it('recovers an accepted file and stamps its mtime', async () => {
		const item = seed();
		const utimes = vi.fn(() => Promise.resolve());
		const result = await attemptRecovery(
			makeEnv({ probe: probeBy(1000, 900), utimes }),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('recovered');
		expect(result.note).toBe('(lost 0.0s)');
		expect(result.warning).toBeNull();
		expect(utimes).toHaveBeenCalledWith(DEST, 1000, 2000);
		const row = findFileByPath(db, SRC)!;
		expect(row.recovery_result).toBe('recovered');
		expect(row.recovery_lost_samples).toBe(100);
	});

	it('recovers with a warning when metadata cannot be carried over', async () => {
		const item = seed();
		const result = await attemptRecovery(
			makeEnv({
				carryMetadata: () => Promise.reject(new Error('tag blob')),
				probe: probeBy(1000, 900),
			}),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('recovered');
		expect(result.warning).toContain('not carried over');
		expect(recoveryResult()).toBe('recovered');
	});

	it('treats a failed placement as failed without recording a verdict', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		const result = await attemptRecovery(
			makeEnv({
				probe: probeBy(1000, 900),
				rename: () => Promise.reject(new Error('nope')),
				unlink,
			}),
			db,
			DEFAULT_CONFIG,
			item,
		);

		expect(result.kind).toBe('failed');
		expect(result.detail).toContain('could not place');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBeNull();
	});
});
