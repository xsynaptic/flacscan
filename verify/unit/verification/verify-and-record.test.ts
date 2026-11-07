import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileRow } from '#database/types.ts';
import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import {
	findFileByPath,
	identityOf,
	recordReadable,
	recordRecoveryOutcome,
} from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { extractMetadata } from '#metadata.ts';
import { verifyAndRecord } from '#verification/verify-and-record.ts';

vi.mock('#metadata.ts', () => ({
	extractMetadata: vi.fn(() =>
		Promise.resolve({ album: 'A', artist: 'B', date: '2020', duration: 1, title: 'T' }),
	),
}));

const running = { aborted: false };

let db: Database.Database;
let logDir: string;
let logPath: string;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	logPath = path.join(logDir, 'scan.log');
	vi.clearAllMocks();
});

afterEach(() => {
	db.close();
	fs.rmSync(logDir, { force: true, recursive: true });
});

function logEntries(): Record<string, unknown>[] {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const PATH = '/music/test.flac';

function makeVerifier(opts: {
	detect?: boolean;
	fixError?: string;
	fixOk?: boolean;
	verify: VerificationResult[];
}): FormatVerifier {
	const results = [...opts.verify];
	return {
		extensions: ['.flac'],
		fixer: {
			detect: () => opts.detect ?? false,
			fix: () =>
				Promise.resolve(
					opts.fixOk === false ? { error: opts.fixError ?? 'boom', ok: false } : { ok: true },
				),
			label: 'ID3',
			requiredBinaries: [{ name: 'id3v2' }],
		},
		requiredBinaries: [{ name: 'flac' }],
		verify: () => Promise.resolve(results.shift() ?? { status: 'healthy' }),
	};
}

function seed(currentPath = PATH): FileRow {
	const identity = fs.existsSync(currentPath)
		? identityOf(fs.statSync(currentPath))
		: { mtime: '2025-01-01T00:00:00.000Z', size: 1 };
	recordReadable(db, [{ identity, path: currentPath }]);
	return findFileByPath(db, currentPath)!;
}

const corrupt = (
	errorOutput: string,
	errorTimestamp: null | string = null,
): VerificationResult => ({
	errorOutput,
	errorTimestamp,
	status: 'corrupt',
});

describe('verifyAndRecord', () => {
	it('marks a healthy file healthy and clears error columns', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [{ status: 'healthy' }] }),
			},
			file,
		);

		expect(outcome).toEqual({ kind: 'healthy' });
		const row = findFileByPath(db, PATH)!;
		expect(row.last_result).toBe('healthy');
		expect(row.error_output).toBeNull();
		expect(row.error_severity).toBeNull();
	});

	it('persists a corrupt verdict and refreshes metadata when empty', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [corrupt('LOST_SYNC', 'sample 42')] }),
			},
			file,
		);

		expect(outcome).toEqual({
			errorOutput: 'LOST_SYNC',
			errorTimestamp: 'sample 42',
			issue: { acknowledged: false, kind: 'corrupt' },
			kind: 'corrupt',
			lastHealthyAt: null,
		});
		expect(extractMetadata).toHaveBeenCalledOnce();

		const row = findFileByPath(db, PATH)!;
		expect(row.last_result).toBe('corrupt');
		expect(row.error_severity).toBeNull();
		expect(row.error_timestamp).toBe('sample 42');
		expect(row.artist).toBe('B');
	});

	it('skips the metadata refresh when the file already has tags', async () => {
		const file = { ...seed(), artist: 'existing' };
		await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [corrupt('LOST_SYNC')] }),
			},
			file,
		);

		expect(extractMetadata).not.toHaveBeenCalled();
		expect(findFileByPath(db, PATH)!.artist).toBeNull();
	});

	it('returns fixed when a strip makes the file pass', async () => {
		const tmp = path.join(os.tmpdir(), `flacscan-fixed-${String(process.pid)}.flac`);
		fs.writeFileSync(tmp, 'data');
		try {
			const file = seed(tmp);
			const outcome = await verifyAndRecord(
				{
					db,
					fix: true,
					logPath,
					signal: running,
					verifier: makeVerifier({ detect: true, verify: [corrupt('ID3'), { status: 'healthy' }] }),
				},
				file,
			);

			expect(outcome).toEqual({ kind: 'fixed', label: 'ID3' });
			const row = findFileByPath(db, tmp)!;
			expect(row.last_result).toBe('healthy');
			expect(row.file_size).toBe(fs.statSync(tmp).size);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it('clears the recovery outcome of a file a fix rewrites', async () => {
		const filePath = path.join(logDir, 'stripped.flac');
		fs.writeFileSync(filePath, 'data with tags');
		const file = seed(filePath);
		recordRecoveryOutcome(db, filePath, {
			detail: 'too lossy',
			lostSamples: 1,
			result: 'unsuitable',
		});
		const verifier = makeVerifier({
			detect: true,
			verify: [corrupt('ID3'), { status: 'healthy' }],
		});
		const fixer = {
			...verifier.fixer!,
			fix: () => {
				fs.writeFileSync(filePath, 'data');
				return Promise.resolve({ ok: true });
			},
		};

		const outcome = await verifyAndRecord(
			{ db, fix: true, logPath, signal: running, verifier: { ...verifier, fixer } },
			file,
		);

		expect(outcome).toEqual({ kind: 'fixed', label: 'ID3' });
		const row = findFileByPath(db, filePath)!;
		expect(row.recovery_attempted_at).toBeNull();
		expect(row.recovery_result).toBeNull();
		expect(row.recovery_lost_samples).toBeNull();
		expect(row.recovery_detail).toBeNull();
	});

	it('returns interrupted without recording when the file vanishes after a fix', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: true,
				logPath,
				signal: running,
				verifier: makeVerifier({ detect: true, verify: [corrupt('ID3'), { status: 'healthy' }] }),
			},
			file,
		);

		expect(outcome).toEqual({ kind: 'interrupted' });
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});

	it('keeps the pre-fix error when a strip succeeds but the file is still corrupt', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: true,
				logPath,
				signal: running,
				verifier: makeVerifier({ detect: true, verify: [corrupt('before'), corrupt('after')] }),
			},
			file,
		);

		expect(outcome).toEqual({
			errorOutput: 'before',
			errorTimestamp: null,
			issue: { acknowledged: false, kind: 'corrupt' },
			kind: 'corrupt',
			lastHealthyAt: null,
		});
		expect(findFileByPath(db, PATH)!.error_output).toBe('before');
	});

	it('annotates a corrupt outcome when the fix command fails', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: true,
				logPath,
				signal: running,
				verifier: makeVerifier({
					detect: true,
					fixError: 'cannot strip',
					fixOk: false,
					verify: [corrupt('ID3')],
				}),
			},
			file,
		);

		expect(outcome.kind).toBe('corrupt');
		if (outcome.kind === 'corrupt') {
			expect(outcome.fix).toEqual({ error: 'cannot strip', label: 'ID3', state: 'failed' });
		}
	});

	it('annotates a corrupt outcome as detected when fixing is off', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ detect: true, verify: [corrupt('ID3')] }),
			},
			file,
		);

		expect(outcome.kind).toBe('corrupt');
		if (outcome.kind === 'corrupt') {
			expect(outcome.fix).toEqual({ label: 'ID3', state: 'detected' });
		}
	});

	it('logs a corrupt verdict with the acceptance and healthy history of the row it was given', async () => {
		seed();
		db.prepare(
			`UPDATE files SET acknowledged_at = ?, last_healthy_at = ? WHERE current_path = ?`,
		).run('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', PATH);
		const outcome = await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [corrupt('LOST_SYNC')] }),
			},
			findFileByPath(db, PATH)!,
		);

		expect(outcome).toMatchObject({
			issue: { acknowledged: true, kind: 'regressed' },
			lastHealthyAt: '2026-01-01T00:00:00.000Z',
		});
		expect(logEntries()).toMatchObject([
			{ event: 'corrupt', known: true, last_healthy_at: '2026-01-01T00:00:00.000Z', path: PATH },
		]);
	});

	it('logs a detected fixable issue ahead of the corrupt verdict it annotates', async () => {
		const file = seed();
		await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ detect: true, verify: [corrupt('ID3')] }),
			},
			file,
		);

		expect(logEntries().map((entry) => entry.event)).toEqual(['id3_detected', 'corrupt']);
	});

	it('logs nothing for a healthy verdict', async () => {
		const file = seed();
		await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [{ status: 'healthy' }] }),
			},
			file,
		);

		expect(logEntries()).toEqual([]);
	});

	it('rethrows when verify throws unexpectedly, leaving the row pending', async () => {
		const file = seed();
		const verifier: FormatVerifier = {
			extensions: ['.flac'],
			requiredBinaries: [{ name: 'flac' }],
			verify: () => Promise.reject(new Error('flac exploded')),
		};

		await expect(
			verifyAndRecord({ db, fix: false, logPath, signal: running, verifier }, file),
		).rejects.toThrow('flac exploded');
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});

	it('returns interrupted without recording when verify throws during shutdown', async () => {
		const file = seed();
		const verifier: FormatVerifier = {
			extensions: ['.flac'],
			requiredBinaries: [{ name: 'flac' }],
			verify: () => Promise.reject(new Error('killed')),
		};

		const outcome = await verifyAndRecord(
			{ db, fix: false, logPath, signal: { aborted: true }, verifier },
			file,
		);

		expect(outcome).toEqual({ kind: 'interrupted' });
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});

	it('returns interrupted without touching the database', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: false,
				logPath,
				signal: running,
				verifier: makeVerifier({ verify: [{ status: 'interrupted' }] }),
			},
			file,
		);

		expect(outcome).toEqual({ kind: 'interrupted' });
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});
});
