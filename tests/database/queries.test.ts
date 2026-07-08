import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileStatus } from '../../src/database/types.js';

import {
	acknowledgeAllIssues,
	clearRecoveryOutcome,
	countRecoveryAttempted,
	deleteFileByPath,
	findFileByPath,
	findUnreadableByPath,
	getCorruptFiles,
	getCorruptFilesByAcknowledged,
	getFilesNeedingVerification,
	getRecoveryCandidates,
	getStats,
	getUnreadableFilesByAcknowledged,
	recordRecoveryOutcome,
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
	acknowledged_at?: null | string;
	current_path?: string;
	error_output?: null | string;
	error_severity?: null | string;
	file_mtime?: null | string;
	file_size?: null | number;
	first_seen_at?: string;
	last_result?: FileStatus;
	last_verified_at?: null | string;
	updated_at?: string;
}) {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO files (current_path, last_result, last_verified_at, acknowledged_at,
		error_severity, error_output, file_size, file_mtime, first_seen_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		overrides.current_path ?? '/music/test.flac',
		overrides.last_result ?? 'pending',
		overrides.last_verified_at ?? null,
		overrides.acknowledged_at ?? null,
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
			newCorrupt: 0,
			newUnreadable: 0,
			pending: 0,
			recoveryBreakdown: [],
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
		expect(stats.total).toBe(4);
	});

	it('includes unreadable count', () => {
		upsertUnreadableFile(db, { current_path: '/bad/file.flac', error_output: 'read error' });
		const stats = getStats(db);
		expect(stats.unreadable).toBe(1);
	});

	it('splits corrupt and unreadable into new vs acknowledged', () => {
		insertFile({ current_path: '/music/new.flac', last_result: 'corrupt' });
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/known.flac',
			last_result: 'corrupt',
		});
		upsertUnreadableFile(db, { current_path: '/bad/x.flac', error_output: 'e' });

		const stats = getStats(db);
		expect(stats.corrupt).toBe(2);
		expect(stats.newCorrupt).toBe(1);
		expect(stats.unreadable).toBe(1);
		expect(stats.newUnreadable).toBe(1);
	});
});

describe('acknowledgement', () => {
	it('acknowledgeAllIssues stamps only un-stamped corrupt and unreadable rows', () => {
		insertFile({ current_path: '/music/new.flac', last_result: 'corrupt' });
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/known.flac',
			last_result: 'corrupt',
		});
		insertFile({ current_path: '/music/ok.flac', last_result: 'healthy' });
		upsertUnreadableFile(db, { current_path: '/bad/x.flac', error_output: 'e' });

		const counts = acknowledgeAllIssues(db);

		expect(counts).toEqual({ corrupt: 1, unreadable: 1 });
		expect(findFileByPath(db, '/music/new.flac')?.acknowledged_at).not.toBeNull();
		expect(findFileByPath(db, '/music/known.flac')?.acknowledged_at).toBe(
			'2020-01-01T00:00:00.000Z',
		);
		expect(findFileByPath(db, '/music/ok.flac')?.acknowledged_at).toBeNull();
	});

	it('updateVerificationResult clears the stamp on healthy but keeps it on corrupt', () => {
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/a.flac',
			last_result: 'corrupt',
		});

		updateVerificationResult(db, '/music/a.flac', { last_result: 'corrupt' });
		expect(findFileByPath(db, '/music/a.flac')?.acknowledged_at).toBe('2020-01-01T00:00:00.000Z');

		updateVerificationResult(db, '/music/a.flac', { last_result: 'healthy' });
		expect(findFileByPath(db, '/music/a.flac')?.acknowledged_at).toBeNull();
	});

	it('upsertFile clears the stamp when content changes', () => {
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/a.flac',
			file_mtime: '2020-01-01T00:00:00.000Z',
			file_size: 1,
			last_result: 'corrupt',
		});

		upsertFile(db, {
			current_path: '/music/a.flac',
			file_mtime: '2026-01-01T00:00:00.000Z',
			file_size: 2,
		});

		const row = findFileByPath(db, '/music/a.flac');
		expect(row?.acknowledged_at).toBeNull();
		expect(row?.last_result).toBe('pending');
	});

	it('upsertUnreadableFile keeps the stamp across re-upserts', () => {
		upsertUnreadableFile(db, { current_path: '/bad/x.flac', error_output: 'first' });
		acknowledgeAllIssues(db);
		upsertUnreadableFile(db, { current_path: '/bad/x.flac', error_output: 'second' });
		expect(findUnreadableByPath(db, '/bad/x.flac')?.acknowledged_at).not.toBeNull();
	});

	it('partitions corrupt and unreadable rows by acknowledgement', () => {
		insertFile({ current_path: '/music/new.flac', last_result: 'corrupt' });
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/known.flac',
			last_result: 'corrupt',
		});
		upsertUnreadableFile(db, { current_path: '/bad/new.flac', error_output: 'e' });
		upsertUnreadableFile(db, { current_path: '/bad/known.flac', error_output: 'e' });
		db.prepare(`UPDATE unreadable_files SET acknowledged_at = ? WHERE current_path = ?`).run(
			'2020-01-01T00:00:00.000Z',
			'/bad/known.flac',
		);

		expect(getCorruptFilesByAcknowledged(db, false).map((file) => file.current_path)).toEqual([
			'/music/new.flac',
		]);
		expect(getCorruptFilesByAcknowledged(db, true).map((file) => file.current_path)).toEqual([
			'/music/known.flac',
		]);
		expect(getUnreadableFilesByAcknowledged(db, false).map((file) => file.current_path)).toEqual([
			'/bad/new.flac',
		]);
		expect(getUnreadableFilesByAcknowledged(db, true).map((file) => file.current_path)).toEqual([
			'/bad/known.flac',
		]);
	});
});

describe('schema migration', () => {
	it('adds acknowledged_at to a database created without it', () => {
		const legacy = new BetterSqlite3(':memory:');
		// Pre-007 schema literal: everything except acknowledged_at
		legacy.exec(`
			CREATE TABLE files (
				current_path    TEXT PRIMARY KEY,
				last_verified_at TEXT,
				last_result     TEXT NOT NULL DEFAULT 'pending',
				error_severity  TEXT,
				error_output    TEXT,
				error_timestamp TEXT,
				artist          TEXT,
				title           TEXT,
				album           TEXT,
				date            TEXT,
				duration        REAL,
				file_size       INTEGER,
				file_mtime      TEXT,
				recovery_attempted_at TEXT,
				recovery_result       TEXT,
				recovery_lost_samples INTEGER,
				recovery_detail       TEXT,
				first_seen_at   TEXT NOT NULL,
				updated_at      TEXT NOT NULL
			);
			CREATE TABLE unreadable_files (
				current_path  TEXT PRIMARY KEY,
				error_output  TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				updated_at    TEXT NOT NULL
			);
		`);

		initializeSchema(legacy);

		const fileCols = (legacy.pragma('table_info(files)') as Array<{ name: string }>).map(
			(col) => col.name,
		);
		const unreadableCols = (
			legacy.pragma('table_info(unreadable_files)') as Array<{ name: string }>
		).map((col) => col.name);
		expect(fileCols).toContain('acknowledged_at');
		expect(unreadableCols).toContain('acknowledged_at');
		legacy.close();
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

	it('does not match a sibling directory that shares a name prefix', () => {
		insertFile({ current_path: '/music-other/x.flac', last_result: 'pending' });

		expect(getFilesNeedingVerification(db, 90, 10, ['/music'])).toHaveLength(0);

		const scoped = getFilesNeedingVerification(db, 90, 10, ['/music-other']);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]!.current_path).toBe('/music-other/x.flac');
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

	it('on conflict updates stats, preserves first_seen_at, and resets verification state', () => {
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: '2025-01-01T00:00:00.000Z',
			file_size: 1024,
		});
		const first = findFileByPath(db, '/music/test.flac')!;
		updateVerificationResult(db, '/music/test.flac', {
			error_output: 'boom',
			last_result: 'corrupt',
		});

		// Re-discovered with different stats means the bytes changed; the prior verdict is stale.
		upsertFile(db, {
			current_path: '/music/test.flac',
			file_mtime: '2025-06-01T00:00:00.000Z',
			file_size: 2048,
		});

		const updated = findFileByPath(db, '/music/test.flac')!;
		expect(updated.file_size).toBe(2048);
		expect(updated.first_seen_at).toBe(first.first_seen_at);
		expect(updated.last_result).toBe('pending');
		expect(updated.last_verified_at).toBeNull();
	});
});

describe('updateVerificationResult', () => {
	it('updates result and error fields, clearing any legacy severity', () => {
		insertFile({ current_path: '/music/test.flac', error_severity: 'critical' });

		updateVerificationResult(db, '/music/test.flac', {
			error_output: 'FRAME_CRC_MISMATCH',
			error_timestamp: 'sample 12345',
			last_result: 'corrupt',
		});

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('corrupt');
		expect(row.error_severity).toBeNull();
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

describe('recovery outcomes', () => {
	it('records and clears a recovery outcome', () => {
		insertFile({
			current_path: '/music/x.flac',
			error_severity: 'recoverable',
			last_result: 'corrupt',
		});

		recordRecoveryOutcome(db, '/music/x.flac', {
			detail: null,
			lostSamples: 88_200,
			result: 'recovered',
		});
		let row = findFileByPath(db, '/music/x.flac')!;
		expect(row.recovery_result).toBe('recovered');
		expect(row.recovery_lost_samples).toBe(88_200);
		expect(row.recovery_detail).toBeNull();
		expect(row.recovery_attempted_at).not.toBeNull();

		clearRecoveryOutcome(db, '/music/x.flac');
		row = findFileByPath(db, '/music/x.flac')!;
		expect(row.recovery_result).toBeNull();
		expect(row.recovery_lost_samples).toBeNull();
		expect(row.recovery_detail).toBeNull();
		expect(row.recovery_attempted_at).toBeNull();
	});

	it('counts only corrupt files that have been attempted', () => {
		insertFile({
			current_path: '/music/a.flac',
			error_severity: 'recoverable',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/music/b.flac',
			error_severity: 'critical',
			last_result: 'corrupt',
		});
		insertFile({ current_path: '/music/c.flac', last_result: 'healthy' });

		expect(countRecoveryAttempted(db)).toBe(0);
		recordRecoveryOutcome(db, '/music/a.flac', {
			detail: 'too lossy',
			lostSamples: 999_999,
			result: 'unsuitable',
		});
		expect(countRecoveryAttempted(db)).toBe(1);
	});

	it('lists corrupt candidates, skipping already-attempted files', () => {
		insertFile({ current_path: '/music/a.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/music/b.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/music/c.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/music/d.flac', last_result: 'healthy' });
		recordRecoveryOutcome(db, '/music/a.flac', {
			detail: 'too lossy',
			lostSamples: 1,
			result: 'unsuitable',
		});

		// Skips already-attempted ('/music/a.flac' has a recovery_result).
		expect(getRecoveryCandidates(db).map((file) => file.current_path)).toEqual([
			'/music/b.flac',
			'/music/c.flac',
		]);
	});
});

describe('statement caching', () => {
	it('keeps statements isolated per database handle', () => {
		const otherDb = new BetterSqlite3(':memory:');
		initializeSchema(otherDb);
		upsertFile(db, { current_path: '/music/first.flac', file_mtime: null, file_size: 1 });
		upsertFile(otherDb, { current_path: '/music/second.flac', file_mtime: null, file_size: 2 });

		expect(findFileByPath(db, '/music/first.flac')?.file_size).toBe(1);
		expect(findFileByPath(db, '/music/second.flac')).toBeUndefined();
		expect(findFileByPath(otherDb, '/music/second.flac')?.file_size).toBe(2);
		expect(findFileByPath(otherDb, '/music/first.flac')).toBeUndefined();

		otherDb.close();
	});

	it('does not resurrect statements from a closed handle', () => {
		const closedDb = new BetterSqlite3(':memory:');
		initializeSchema(closedDb);
		findFileByPath(closedDb, '/music/track.flac');
		closedDb.close();

		const freshDb = new BetterSqlite3(':memory:');
		initializeSchema(freshDb);
		expect(findFileByPath(freshDb, '/music/track.flac')).toBeUndefined();
		freshDb.close();
	});
});
