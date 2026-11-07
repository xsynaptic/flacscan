import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecoverItem } from '#cli/recover-attempt.ts';
import type { FlacFormat, RecoveryEnv } from '#cli/recover-engine.ts';
import type { StopSignal } from '#process-pool.ts';

import { attemptRecovery } from '#cli/recover-attempt.ts';
import { DEFAULT_CONFIG } from '#config/types.ts';
import { findFileByPath, recordReadable, recordVerdict } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';

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

const fmt = (totalSamples: number): FlacFormat => ({
	bitsPerSample: 16,
	channels: 2,
	sampleRate: 44_100,
	totalSamples,
});

const probeBy =
	(srcTotal: number, partialTotal: number) =>
	(p: string): Promise<FlacFormat> =>
		Promise.resolve(fmt(p.endsWith('.partial') ? partialTotal : srcTotal));

function makeEnv(overrides: Partial<RecoveryEnv>): RecoveryEnv {
	return {
		carryMetadata: () => Promise.resolve(),
		decodeReencode: () => Promise.resolve(),
		exists: () => true,
		probe: () => Promise.resolve(fmt(1000)),
		rename: () => Promise.resolve(),
		testPasses: () => Promise.resolve(true),
		unlink: () => Promise.resolve(),
		utimes: () => Promise.resolve(),
		...overrides,
	};
}

function seed(): RecoverItem {
	recordReadable(db, [{ identity: { mtime: '2025-01-01T00:00:00.000Z', size: 100 }, path: SRC }]);
	recordVerdict(db, SRC, { errorOutput: 'LOST_SYNC', errorTimestamp: null, status: 'corrupt' });
	return {
		atimeMs: 1000,
		dest: DEST,
		dev: 1,
		mtimeMs: 2000,
		row: findFileByPath(db, SRC)!,
		size: 100,
		src: SRC,
	};
}

const running: StopSignal = { aborted: false };

const recoveryResult = () => findFileByPath(db, SRC)!.recovery_result;

describe('attemptRecovery', () => {
	it('does not start or record a verdict when shutting down', async () => {
		const item = seed();
		const result = await attemptRecovery(
			{ config: DEFAULT_CONFIG, db, env: makeEnv({}), signal: { aborted: true } },
			item,
		);

		expect(result.kind).toBe('interrupted');
		expect(recoveryResult()).toBeNull();
	});

	it('treats a vanished source as failed without recording a verdict', async () => {
		const item = seed();
		const result = await attemptRecovery(
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({ exists: () => false, probe: () => Promise.reject(new Error('gone')) }),
				signal: running,
			},
			item,
		);

		expect(result.kind).toBe('failed');
		expect(result.detail).toContain('source disappeared');
		expect(recoveryResult()).toBeNull();
	});

	it('records unsuitable when metaflac cannot read a present file', async () => {
		const item = seed();
		const result = await attemptRecovery(
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({ probe: () => Promise.reject(new Error('bad header')) }),
				signal: running,
			},
			item,
		);

		expect(result.kind).toBe('unsuitable');
		expect(result.detail).toContain('metaflac could not read');
		expect(recoveryResult()).toBe('unsuitable');
	});

	it('records unsuitable when the stream claims zero samples', async () => {
		const item = seed();
		const result = await attemptRecovery(
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({ probe: () => Promise.resolve(fmt(0)) }),
				signal: running,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({
					decodeReencode: () => Promise.reject(new Error('boom')),
					probe: probeBy(1000, 1000),
					unlink,
				}),
				signal: running,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({
					decodeReencode: () => Promise.reject(new Error('boom')),
					exists: () => false,
					probe: probeBy(1000, 1000),
					unlink,
				}),
				signal: running,
			},
			item,
		);

		expect(result.kind).toBe('failed');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBeNull();
	});

	it('does not record a verdict when the re-encode test fails during shutdown', async () => {
		const item = seed();
		const unlink = vi.fn(() => Promise.resolve());
		let checks = 0;
		const stopsAfterFirstCheck = {
			get aborted() {
				checks++;
				return checks > 1;
			},
		};
		const result = await attemptRecovery(
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({
					probe: probeBy(1000, 900),
					testPasses: () => Promise.resolve(false),
					unlink,
				}),
				signal: stopsAfterFirstCheck,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({ probe: probeBy(200_000, 10_000), unlink }),
				signal: running,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({ probe: probeBy(1000, 900), utimes }),
				signal: running,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({
					carryMetadata: () => Promise.reject(new Error('tag blob')),
					probe: probeBy(1000, 900),
				}),
				signal: running,
			},
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
			{
				config: DEFAULT_CONFIG,
				db,
				env: makeEnv({
					probe: probeBy(1000, 900),
					rename: () => Promise.reject(new Error('nope')),
					unlink,
				}),
				signal: running,
			},
			item,
		);

		expect(result.kind).toBe('failed');
		expect(result.detail).toContain('could not place');
		expect(unlink).toHaveBeenCalledWith(PARTIAL);
		expect(recoveryResult()).toBeNull();
	});
});
