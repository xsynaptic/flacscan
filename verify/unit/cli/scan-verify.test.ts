import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FormatVerifier } from '#verifiers/types.ts';

import { runVerification } from '#cli/scan-verify.ts';
import { findFileByPath, identityOf, recordReadable } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';

import { makeTestConfig } from '../helpers.ts';

const running = { aborted: false };

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

function seedFile(name: string): string {
	const filePath = path.join(tempDir, name);
	fs.writeFileSync(filePath, 'data');
	recordReadable(db, [{ identity: identityOf(fs.statSync(filePath)), path: filePath }]);
	return filePath;
}

describe('runVerification', () => {
	it('prints a line for each pruned, fixed and corrupt outcome and returns the exit code', async () => {
		const vanished = seedFile('vanished.flac');
		fs.rmSync(vanished);
		const fixable = seedFile('fixable.flac');
		const corrupt = seedFile('corrupt.flac');
		seedFile('healthy.flac');
		const checked = new Set<string>();
		const verifier = fakeVerifier(
			(filePath) => {
				const firstCheck = !checked.has(filePath);
				checked.add(filePath);
				if (filePath === corrupt) {
					return Promise.resolve({
						errorOutput: 'LOST_SYNC',
						errorTimestamp: null,
						status: 'corrupt',
					});
				}
				if (filePath === fixable && firstCheck) {
					return Promise.resolve({ errorOutput: 'ID3', errorTimestamp: null, status: 'corrupt' });
				}
				return Promise.resolve({ status: 'healthy' });
			},
			{
				detect: (errorOutput) => errorOutput === 'ID3',
				fix: () => {
					fs.writeFileSync(fixable, 'stripped');
					return Promise.resolve({ ok: true });
				},
				label: 'ID3',
				requiredBinaries: [],
			},
		);

		const result = await runVerification(db, makeTestConfig(tempDir, { fix: true }), {
			directories: [tempDir],
			signal: running,
			verifier: verifier,
		});

		expect(result?.exitCode).toBe(1);
		expect(result?.stats).toMatchObject({ corrupt: 1, fixed: 1, healthy: 1, pruned: 1 });
		const lines = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining(`PRUNED ${vanished}`),
				expect.stringContaining(`ID3_FIXED ${fixable}`),
				expect.stringContaining(`NEW CORRUPT ${corrupt}`),
			]),
		);
		expect(lines.filter((line) => line.includes('healthy.flac'))).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)(
		'keeps the accepted row of a file that has turned unreadable, printing nothing for it',
		async () => {
			fs.mkdirSync(path.join(tempDir, 'locked'));
			const filePath = seedFile(path.join('locked', 'track.flac'));
			db.prepare(`UPDATE files SET acknowledged_at = ? WHERE current_path = ?`).run(
				'2020-01-01T00:00:00.000Z',
				filePath,
			);
			const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);

			try {
				const result = await runVerification(db, makeTestConfig(tempDir), {
					directories: [tempDir],
					signal: running,
					verifier: verifier,
				});

				expect(result).toMatchObject({ exitCode: 0, stats: { pruned: 0 } });
				expect(findFileByPath(db, filePath)?.acknowledged_at).toBe('2020-01-01T00:00:00.000Z');
				expect(vi.mocked(console.log)).not.toHaveBeenCalledWith(expect.stringContaining('PRUNED'));
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		'moves the batch past a file that has turned unreadable instead of selecting it every scan',
		async () => {
			fs.mkdirSync(path.join(tempDir, 'locked'));
			const locked = seedFile(path.join('locked', 'track.flac'));
			const overdue = seedFile('overdue.flac');
			db.prepare(
				`UPDATE files SET last_result = 'healthy', last_verified_at = ? WHERE current_path = ?`,
			).run('2000-01-01T00:00:00.000Z', overdue);
			const config = makeTestConfig(tempDir, { batch_size: 1 });
			const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);

			try {
				for (let scan = 0; scan < 3; scan++) {
					await runVerification(db, config, {
						directories: [tempDir],
						signal: running,
						verifier: verifier,
					});
				}
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}

			expect(findFileByPath(db, overdue)?.last_verified_at).not.toBe('2000-01-01T00:00:00.000Z');
			expect(findFileByPath(db, locked)?.last_result).toBe('pending');
		},
	);

	it('returns null when no files need verification', async () => {
		const verifier = fakeVerifier(() => Promise.resolve({ status: 'healthy' }));

		const result = await runVerification(db, makeTestConfig(tempDir), {
			directories: [tempDir],
			signal: running,
			verifier: verifier,
		});

		expect(result).toBeNull();
	});
});
