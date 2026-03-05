import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileStatus } from '../../src/database/types.js';
import type { ErrorSeverity } from '../../src/verifiers/types.js';

import {
	deleteFileByPath,
	findFileByPath,
	getCorruptFiles,
	getFilesNeedingVerification,
	getStats,
	updateVerificationResult,
	upsertFile,
	upsertUnreadableFile,
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

function insertFile(overrides: {
	current_path?: string;
	error_output?: null | string;
	error_severity?: ErrorSeverity | null;
	file_mtime?: null | string;
	file_size?: null | number;
	first_seen_at?: string;
	last_result?: FileStatus;
	last_verified_at?: null | string;
	updated_at?: string;
}) {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO files (current_path, last_result, last_verified_at,
		error_severity, error_output, file_size, file_mtime, first_seen_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		overrides.current_path ?? '/music/test.flac',
		overrides.last_result ?? 'pending',
		overrides.last_verified_at ?? null,
		overrides.error_severity ?? null,
		overrides.error_output ?? null,
		overrides.file_size ?? null,
		overrides.file_mtime ?? null,
		overrides.first_seen_at ?? now,
		overrides.updated_at ?? now,
	);
}

describe('getStats', () => {
	it('returns zeros for empty database', () => {
		const stats = getStats(db);
		expect(stats).toEqual({
			corrupt: 0,
			healthy: 0,
			pending: 0,
			severityBreakdown: [],
			total: 0,
			unreadable: 0,
		});
	});

	it('returns correct counts by status', () => {
		insertFile({ current_path: '/music/a.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/b.flac', last_result: 'healthy' });
		insertFile({ current_path: '/music/c.flac', last_result: 'healthy' });
		insertFile({
			current_path: '/music/d.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});

		const stats = getStats(db);
		expect(stats.pending).toBe(1);
		expect(stats.healthy).toBe(2);
		expect(stats.corrupt).toBe(1);
	});

	it('includes unreadable count', () => {
		upsertUnreadableFile(db, { current_path: '/bad/file.flac', error_output: 'read error' });
		const stats = getStats(db);
		expect(stats.unreadable).toBe(1);
	});

	it('returns severity breakdown for corrupt files', () => {
		insertFile({
			current_path: '/music/a.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/b.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/c.flac',
			error_severity: 'recoverable',
			last_result: 'corrupt',
		});

		const stats = getStats(db);
		const breakdown = new Map(stats.severityBreakdown.map((r) => [r.error_severity, r.count]));
		expect(breakdown.get('critical')).toBe(2);
		expect(breakdown.get('recoverable')).toBe(1);
	});

	it('total equals sum of all statuses', () => {
		insertFile({ current_path: '/music/a.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/b.flac', last_result: 'healthy' });
		insertFile({
			current_path: '/music/c.flac',
			error_severity: 'unknown',
			last_result: 'corrupt',
		});

		const stats = getStats(db);
		expect(stats.total).toBe(stats.pending + stats.healthy + stats.corrupt);
	});
});

describe('getFilesNeedingVerification', () => {
	it('returns empty array for empty directories', () => {
		insertFile({ current_path: '/music/test.flac' });
		const result = getFilesNeedingVerification(db, 30, 100, []);
		expect(result).toEqual([]);
	});

	it('returns pending files in specified directories', () => {
		insertFile({ current_path: '/music/album/track.flac', last_result: 'pending' });
		const result = getFilesNeedingVerification(db, 30, 100, ['/music/']);
		expect(result).toHaveLength(1);
		expect(result[0]!.current_path).toBe('/music/album/track.flac');
	});

	it('returns stale healthy files', () => {
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
		insertFile({
			current_path: '/music/old.flac',
			last_result: 'healthy',
			last_verified_at: old,
		});
		const result = getFilesNeedingVerification(db, 30, 100, ['/music/']);
		expect(result).toHaveLength(1);
	});

	it('skips recently verified healthy files', () => {
		const recent = new Date().toISOString();
		insertFile({
			current_path: '/music/recent.flac',
			last_result: 'healthy',
			last_verified_at: recent,
		});
		const result = getFilesNeedingVerification(db, 30, 100, ['/music/']);
		expect(result).toHaveLength(0);
	});

	it('skips files outside specified directories', () => {
		insertFile({ current_path: '/other/track.flac', last_result: 'pending' });
		const result = getFilesNeedingVerification(db, 30, 100, ['/music/']);
		expect(result).toHaveLength(0);
	});

	it('respects batch limit', () => {
		insertFile({ current_path: '/music/1.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/2.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/3.flac', last_result: 'pending' });
		const result = getFilesNeedingVerification(db, 30, 2, ['/music/']);
		expect(result).toHaveLength(2);
	});

	it('orders by last_verified_at ASC NULLS FIRST', () => {
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
		const older = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
		insertFile({
			current_path: '/music/old.flac',
			last_result: 'healthy',
			last_verified_at: old,
		});
		insertFile({
			current_path: '/music/null.flac',
			last_result: 'pending',
			last_verified_at: null,
		});
		insertFile({
			current_path: '/music/older.flac',
			last_result: 'healthy',
			last_verified_at: older,
		});

		const result = getFilesNeedingVerification(db, 30, 100, ['/music/']);
		expect(result[0]!.current_path).toBe('/music/null.flac');
		expect(result[1]!.current_path).toBe('/music/older.flac');
		expect(result[2]!.current_path).toBe('/music/old.flac');
	});

	it('escapes LIKE wildcards in directory paths', () => {
		insertFile({ current_path: '/music/100%_done/track.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/100X_done/other.flac', last_result: 'pending' });

		const result = getFilesNeedingVerification(db, 30, 100, ['/music/100%_done/']);
		expect(result).toHaveLength(1);
		expect(result[0]!.current_path).toBe('/music/100%_done/track.flac');
	});
});

describe('upsertFile', () => {
	it('inserts a new file', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: '2025-01-01T00:00:00.000Z',
			file_size: 1024,
		});
		const row = findFileByPath(db, '/music/test.flac');
		expect(row).toBeDefined();
		expect(row!.last_result).toBe('pending');
	});

	it('on conflict updates size/mtime/updated_at but preserves first_seen_at and last_result', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: null,
			file_size: null,
		});
		const first = findFileByPath(db, '/music/test.flac')!;

		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: '2025-06-01T00:00:00.000Z',
			file_size: 2048,
		});

		const updated = findFileByPath(db, '/music/test.flac')!;
		expect(updated.file_size).toBe(2048);
		expect(updated.first_seen_at).toBe(first.first_seen_at);
		expect(updated.last_result).toBe('pending');
	});
});

describe('updateVerificationResult', () => {
	it('updates result and error fields', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: null,
			file_size: null,
		});

		updateVerificationResult(db, '/music/test.flac', {
			error_output: 'FRAME_CRC_MISMATCH',
			error_severity: 'recoverable',
			error_timestamp: 'sample 12345',
			last_result: 'corrupt',
		});

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('corrupt');
		expect(row.error_severity).toBe('recoverable');
		expect(row.error_output).toBe('FRAME_CRC_MISMATCH');
		expect(row.error_timestamp).toBe('sample 12345');
		expect(row.last_verified_at).toBeTruthy();
	});

	it('handles null optional fields', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: null,
			file_size: null,
		});

		updateVerificationResult(db, '/music/test.flac', {
			last_result: 'healthy',
		});

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('healthy');
		expect(row.error_severity).toBeNull();
		expect(row.error_output).toBeNull();
		expect(row.error_timestamp).toBeNull();
	});
});

describe('deleteFileByPath', () => {
	it('deletes by current_path', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: null,
			file_size: null,
		});
		deleteFileByPath(db, '/music/test.flac');
		expect(findFileByPath(db, '/music/test.flac')).toBeUndefined();
	});
});

describe('upsertUnreadableFile', () => {
	it('inserts an unreadable file', () => {
		upsertUnreadableFile(db, { current_path: '/bad/file.flac', error_output: 'read error' });
		const stats = getStats(db);
		expect(stats.unreadable).toBe(1);
	});

	it('on conflict updates error_output and updated_at, preserves first_seen_at', () => {
		upsertUnreadableFile(db, { current_path: '/bad/file.flac', error_output: 'error 1' });
		const first = db
			.prepare(`SELECT * FROM unreadable_files WHERE current_path = ?`)
			.get('/bad/file.flac') as {
			first_seen_at: string;
			updated_at: string;
		};

		upsertUnreadableFile(db, { current_path: '/bad/file.flac', error_output: 'error 2' });
		const second = db
			.prepare(`SELECT * FROM unreadable_files WHERE current_path = ?`)
			.get('/bad/file.flac') as {
			error_output: string;
			first_seen_at: string;
			updated_at: string;
		};

		expect(second.error_output).toBe('error 2');
		expect(second.first_seen_at).toBe(first.first_seen_at);
	});
});

describe('findFileByPath', () => {
	it('returns row when exists', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: null,
			file_size: null,
		});
		const row = findFileByPath(db, '/music/test.flac');
		expect(row).toBeDefined();
		expect(row!.current_path).toBe('/music/test.flac');
	});

	it('returns undefined when not found', () => {
		expect(findFileByPath(db, '/nonexistent.flac')).toBeUndefined();
	});
});

describe('getCorruptFiles', () => {
	it('orders by path', () => {
		insertFile({
			current_path: '/music/z.flac',
			error_severity: 'recoverable',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/b.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/a.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/x.flac',
			error_severity: 'unknown',
			last_result: 'corrupt',
		});

		const result = getCorruptFiles(db);
		expect(result.map((r) => r.current_path)).toEqual([
			'/music/a.flac',
			'/music/b.flac',
			'/music/x.flac',
			'/music/z.flac',
		]);
	});

	it('excludes non-corrupt files', () => {
		insertFile({ current_path: '/music/a.flac', last_result: 'healthy' });
		insertFile({
			current_path: '/music/b.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});

		const result = getCorruptFiles(db);
		expect(result).toHaveLength(1);
		expect(result[0]!.current_path).toBe('/music/b.flac');
	});
});
