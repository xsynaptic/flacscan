import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileRow } from '#database/types.ts';
import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import { isShuttingDown } from '#cli/process-pool.ts';
import { verifyAndRecord } from '#cli/verify-and-record.ts';
import { findFileByPath, upsertFile } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { extractMetadata } from '#metadata.ts';

vi.mock('#cli/process-pool.ts', () => ({
	isShuttingDown: vi.fn(() => false),
}));

vi.mock('#metadata.ts', () => ({
	extractMetadata: vi.fn(() =>
		Promise.resolve({ album: 'A', artist: 'B', date: '2020', duration: 1, title: 'T' }),
	),
}));

let db: Database.Database;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	vi.clearAllMocks();
});

afterEach(() => {
	db.close();
});

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
	upsertFile(db, { current_path: currentPath, file_mtime: null, file_size: null });
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
			{ db, fix: false, verifier: makeVerifier({ verify: [{ status: 'healthy' }] }) },
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
			{ db, fix: false, verifier: makeVerifier({ verify: [corrupt('LOST_SYNC', 'sample 42')] }) },
			file,
		);

		expect(outcome).toEqual({
			errorOutput: 'LOST_SYNC',
			errorTimestamp: 'sample 42',
			kind: 'corrupt',
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
			{ db, fix: false, verifier: makeVerifier({ verify: [corrupt('LOST_SYNC')] }) },
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

	it('returns interrupted without recording when the file vanishes after a fix', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: true,
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
				verifier: makeVerifier({ detect: true, verify: [corrupt('before'), corrupt('after')] }),
			},
			file,
		);

		expect(outcome).toEqual({
			errorOutput: 'before',
			errorTimestamp: null,
			kind: 'corrupt',
		});
		expect(findFileByPath(db, PATH)!.error_output).toBe('before');
	});

	it('annotates a corrupt outcome when the fix command fails', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{
				db,
				fix: true,
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
			{ db, fix: false, verifier: makeVerifier({ detect: true, verify: [corrupt('ID3')] }) },
			file,
		);

		expect(outcome.kind).toBe('corrupt');
		if (outcome.kind === 'corrupt') {
			expect(outcome.fix).toEqual({ label: 'ID3', state: 'detected' });
		}
	});

	it('rethrows when verify throws unexpectedly, leaving the row pending', async () => {
		const file = seed();
		const verifier: FormatVerifier = {
			extensions: ['.flac'],
			requiredBinaries: [{ name: 'flac' }],
			verify: () => Promise.reject(new Error('flac exploded')),
		};

		await expect(verifyAndRecord({ db, fix: false, verifier }, file)).rejects.toThrow(
			'flac exploded',
		);
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});

	it('returns interrupted without recording when verify throws during shutdown', async () => {
		vi.mocked(isShuttingDown).mockReturnValueOnce(true);
		const file = seed();
		const verifier: FormatVerifier = {
			extensions: ['.flac'],
			requiredBinaries: [{ name: 'flac' }],
			verify: () => Promise.reject(new Error('killed')),
		};

		const outcome = await verifyAndRecord({ db, fix: false, verifier }, file);

		expect(outcome).toEqual({ kind: 'interrupted' });
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});

	it('returns interrupted without touching the database', async () => {
		const file = seed();
		const outcome = await verifyAndRecord(
			{ db, fix: false, verifier: makeVerifier({ verify: [{ status: 'interrupted' }] }) },
			file,
		);

		expect(outcome).toEqual({ kind: 'interrupted' });
		expect(findFileByPath(db, PATH)!.last_result).toBe('pending');
	});
});
