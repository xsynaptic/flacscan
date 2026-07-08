import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FormatVerifier } from '../../src/verifiers/types.js';

import { runVerification } from '../../src/cli/scan-verify.js';
import { findFileByPath, upsertFile } from '../../src/database/queries.js';
import { initializeSchema } from '../../src/database/schema.js';
import { makeTestConfig } from '../helpers.js';

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	db.close();
	fs.rmSync(tempDir, { force: true, recursive: true });
	vi.restoreAllMocks();
});

function fakeVerifier(
	verify: FormatVerifier['verify'],
	fixer?: FormatVerifier['fixer'],
): FormatVerifier {
	return {
		extensions: ['.flac'],
		requiredBinaries: [],
		verify,
		...(fixer && { fixer }),
	};
}

function logEvents(logPath: string): string[] {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => (JSON.parse(line) as { event: string }).event);
}

function seedFile(name: string): string {
	const filePath = path.join(tempDir, name);
	fs.writeFileSync(filePath, 'data');
	upsertFile(db, { current_path: filePath, file_mtime: null, file_size: null });
	return filePath;
}

describe('runVerification', () => {
	it('records a healthy file', async () => {
		const filePath = seedFile('ok.flac');
		const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));

		const stats = await runVerification(db, makeTestConfig(tempDir), [tempDir], verifier);

		expect(stats).toMatchObject({ exitCode: 0, healthy: 1 });
		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('healthy');
		expect(row?.last_verified_at).not.toBeNull();
	});

	it('records a corrupt file, sets exit code 1, and logs it', async () => {
		const filePath = seedFile('bad.flac');
		const config = makeTestConfig(tempDir);
		const verifier = fakeVerifier(() =>
			Promise.resolve({ errorOutput: 'boom', errorTimestamp: 'sample 1', status: 'corrupt' }),
		);

		const stats = await runVerification(db, config, [tempDir], verifier);

		expect(stats?.corrupt).toBe(1);
		expect(stats?.exitCode).toBe(1);
		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('corrupt');
		expect(row?.error_severity).toBe('unknown');
		expect(logEvents(config.log_path)).toContain('corrupt');
	});

	it('alarms on an unacknowledged corrupt file (exit 1, one new)', async () => {
		seedFile('new-bad.flac');
		const verifier = fakeVerifier(() =>
			Promise.resolve({ errorOutput: 'boom', errorTimestamp: null, status: 'corrupt' }),
		);

		const stats = await runVerification(db, makeTestConfig(tempDir), [tempDir], verifier);

		expect(stats?.corrupt).toBe(1);
		expect(stats?.newCorrupt).toBe(1);
		expect(stats?.exitCode).toBe(1);
	});

	it('stays green on an acknowledged corrupt file (exit 0, none new)', async () => {
		const filePath = seedFile('known-bad.flac');
		const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
		db.prepare(
			`UPDATE files SET last_result = 'corrupt', acknowledged_at = ?, last_verified_at = ? WHERE current_path = ?`,
		).run('2020-01-01T00:00:00.000Z', old, filePath);
		const verifier = fakeVerifier(() =>
			Promise.resolve({ errorOutput: 'boom', errorTimestamp: null, status: 'corrupt' }),
		);

		const stats = await runVerification(db, makeTestConfig(tempDir), [tempDir], verifier);

		expect(stats?.corrupt).toBe(1);
		expect(stats?.newCorrupt).toBe(0);
		expect(stats?.exitCode).toBe(0);
	});

	it('prunes a row whose file no longer exists', async () => {
		const filePath = seedFile('vanished.flac');
		fs.rmSync(filePath);
		const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));

		const stats = await runVerification(db, makeTestConfig(tempDir), [tempDir], verifier);

		expect(stats?.pruned).toBe(1);
		expect(findFileByPath(db, filePath)).toBeUndefined();
	});

	it('fixes a corrupt file when fix is enabled', async () => {
		const filePath = seedFile('fixable.flac');
		const config = makeTestConfig(tempDir, { fix: true });
		let calls = 0;
		const verify: FormatVerifier['verify'] = () => {
			calls++;
			if (calls === 1) {
				return Promise.resolve({
					errorOutput: 'ID3 tag found',
					errorTimestamp: null,
					status: 'corrupt',
				});
			}
			return Promise.resolve({ status: 'healthy' });
		};
		const verifier = fakeVerifier(verify, {
			detect: () => true,
			fix: () => Promise.resolve({ ok: true }),
			label: 'ID3',
			requiredBinaries: [],
		});

		const stats = await runVerification(db, config, [tempDir], verifier);

		expect(stats?.fixed).toBe(1);
		expect(findFileByPath(db, filePath)?.last_result).toBe('healthy');
		expect(logEvents(config.log_path)).toContain('id3_fixed');
	});

	it('detects a fixable issue but does not fix when fix is disabled', async () => {
		seedFile('detectable.flac');
		const config = makeTestConfig(tempDir, { fix: false });
		const fixSpy = vi.fn(() => Promise.resolve({ ok: true }));
		const verifier = fakeVerifier(
			() =>
				Promise.resolve({ errorOutput: 'ID3 tag found', errorTimestamp: null, status: 'corrupt' }),
			{
				detect: () => true,
				fix: fixSpy,
				label: 'ID3',
				requiredBinaries: [],
			},
		);

		const stats = await runVerification(db, config, [tempDir], verifier);

		expect(fixSpy).not.toHaveBeenCalled();
		expect(stats?.corrupt).toBe(1);
		expect(logEvents(config.log_path)).toContain('id3_detected');
	});

	it('returns null when no files need verification', async () => {
		const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));

		const result = await runVerification(db, makeTestConfig(tempDir), [tempDir], verifier);

		expect(result).toBeNull();
	});
});
