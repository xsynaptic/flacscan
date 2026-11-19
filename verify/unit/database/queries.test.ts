import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileStatus } from '#database/types.ts';

import {
	acknowledgeAllIssues,
	applyMoves,
	classifySightings,
	countRecoveryAttempted,
	findFileByPath,
	getFilesNeedingVerification,
	getRecoveryCandidates,
	getStats,
	pathsUnder,
	pathsWithIdentity,
	prunePaths,
	recordReadable,
	recordRecoveryOutcome,
	recordUnreadable,
	recordVerdict,
} from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';

import { unreadableRow } from '../helpers.ts';

const identity = { mtime: '2025-01-01T00:00:00.000Z', size: 1024 };
const changedIdentity = { mtime: '2025-06-01T00:00:00.000Z', size: 2048 };

let db: Database.Database;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
});

afterEach(() => {
	db.close();
});

function unreadable(filePath: string, error = 'EACCES') {
	recordUnreadable(db, [{ error, path: filePath }]);
}

function insertFile(overrides: {
	acknowledged_at?: null | string;
	current_path?: string;
	error_output?: null | string;
	error_severity?: null | string;
	file_mtime?: null | string;
	file_size?: null | number;
	first_seen_at?: string;
	last_healthy_at?: null | string;
	last_result?: FileStatus;
	last_verified_at?: null | string;
	updated_at?: string;
}) {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO files (current_path, last_result, last_verified_at, last_healthy_at, acknowledged_at,
		error_severity, error_output, file_size, file_mtime, first_seen_at, updated_at)
		VALUES (@current_path, @last_result, @last_verified_at, @last_healthy_at, @acknowledged_at,
		@error_severity, @error_output, @file_size, @file_mtime, @first_seen_at, @updated_at)`,
	).run({
		acknowledged_at: null,
		current_path: '/music/test.flac',
		error_output: null,
		error_severity: null,
		file_mtime: null,
		file_size: null,
		first_seen_at: now,
		last_healthy_at: null,
		last_result: 'pending',
		last_verified_at: null,
		updated_at: now,
		...overrides,
	});
}

describe('getStats', () => {
	it('returns zeros for empty database', () => {
		const stats = getStats(db);
		expect(stats).toEqual({ healthy: 0, pending: 0, recoveryBreakdown: [], total: 0 });
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

		expect(getStats(db)).toEqual({
			healthy: 2,
			pending: 1,
			recoveryBreakdown: [{ count: 1, recovery_result: null }],
			total: 4,
		});
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
		unreadable('/bad/x.flac');

		const counts = acknowledgeAllIssues(db);

		expect(counts).toEqual({ corrupt: 1, unreadable: 1 });
		expect(findFileByPath(db, '/music/new.flac')?.acknowledged_at).toEqual(expect.any(String));
		expect(findFileByPath(db, '/music/known.flac')?.acknowledged_at).toBe(
			'2020-01-01T00:00:00.000Z',
		);
		expect(findFileByPath(db, '/music/ok.flac')?.acknowledged_at).toBeNull();
	});

	it('recordVerdict clears the stamp on healthy but keeps it on corrupt', () => {
		insertFile({
			acknowledged_at: '2020-01-01T00:00:00.000Z',
			current_path: '/music/a.flac',
			last_result: 'corrupt',
		});

		recordVerdict(db, '/music/a.flac', {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		expect(findFileByPath(db, '/music/a.flac')?.acknowledged_at).toBe('2020-01-01T00:00:00.000Z');

		recordVerdict(db, '/music/a.flac', { status: 'healthy' });
		expect(findFileByPath(db, '/music/a.flac')?.acknowledged_at).toBeNull();
	});

	it('stamps healthy history on a healthy verdict, keeps it through corrupt ones, and drops it on a content change', () => {
		recordReadable(db, [{ identity, path: '/music/a.flac' }]);

		recordVerdict(db, '/music/a.flac', { status: 'healthy' });
		const healthy = findFileByPath(db, '/music/a.flac');
		expect(healthy?.last_healthy_at).toBe(healthy?.last_verified_at);

		recordVerdict(db, '/music/a.flac', {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		expect(findFileByPath(db, '/music/a.flac')?.last_healthy_at).toBe(healthy?.last_healthy_at);

		recordReadable(db, [{ identity: changedIdentity, path: '/music/a.flac' }]);
		expect(findFileByPath(db, '/music/a.flac')?.last_healthy_at).toBeNull();
	});

	it('recordUnreadable keeps the stamp across re-records', () => {
		unreadable('/bad/x.flac', 'first');
		acknowledgeAllIssues(db);
		unreadable('/bad/x.flac', 'second');
		expect(unreadableRow(db, '/bad/x.flac')?.acknowledged_at).toEqual(expect.any(String));
	});
});

function legacyDatabase() {
	const legacy = new BetterSqlite3(':memory:');
	// Schema from before acknowledged_at, duration and recovery_lost_samples existed
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
			file_size       INTEGER,
			file_mtime      TEXT,
			recovery_attempted_at TEXT,
			recovery_result       TEXT,
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
	return legacy;
}

function columnTypes(database: Database.Database, table: string) {
	return (database.pragma(`table_info(${table})`) as { name: string; type: string }[])
		.map((column) => `${column.name} ${column.type}`)
		.toSorted((left, right) => left.localeCompare(right));
}

describe('schema migration', () => {
	it('migrates an older database to the columns and types of a fresh one', () => {
		const legacy = legacyDatabase();
		const fresh = new BetterSqlite3(':memory:');

		initializeSchema(legacy);
		initializeSchema(fresh);

		for (const table of ['files', 'unreadable_files']) {
			expect(columnTypes(legacy, table)).toEqual(columnTypes(fresh, table));
		}
		legacy.close();
		fresh.close();
	});

	it('backfills last_healthy_at from the last verification of healthy rows only', () => {
		const legacy = legacyDatabase();
		const insert = legacy.prepare(
			`INSERT INTO files (current_path, last_result, last_verified_at, first_seen_at, updated_at)
			VALUES (?, ?, ?, 't', 't')`,
		);
		insert.run('/music/healthy.flac', 'healthy', '2026-03-01T00:00:00.000Z');
		insert.run('/music/corrupt.flac', 'corrupt', '2026-03-02T00:00:00.000Z');
		insert.run('/music/pending.flac', 'pending', null);

		initializeSchema(legacy);

		const backfilled = legacy
			.prepare(`SELECT current_path, last_healthy_at FROM files ORDER BY current_path`)
			.all();
		legacy.close();
		expect(backfilled).toEqual([
			{ current_path: '/music/corrupt.flac', last_healthy_at: null },
			{ current_path: '/music/healthy.flac', last_healthy_at: '2026-03-01T00:00:00.000Z' },
			{ current_path: '/music/pending.flac', last_healthy_at: null },
		]);
	});
});

describe('getFilesNeedingVerification', () => {
	it('returns empty array for empty directories', () => {
		insertFile({ current_path: '/music/test.flac' });
		const result = getFilesNeedingVerification(db, [], {
			batch_size: 100,
			rescan_interval_days: 30,
		});
		expect(result).toEqual([]);
	});

	it('skips a row whose path is unreadable right now', () => {
		insertFile({ current_path: '/music/overlay.flac', last_result: 'pending' });
		insertFile({ current_path: '/music/readable.flac', last_result: 'pending' });
		unreadable('/music/overlay.flac');

		const result = getFilesNeedingVerification(db, ['/music/'], {
			batch_size: 100,
			rescan_interval_days: 30,
		});
		expect(result.map((file) => file.current_path)).toEqual(['/music/readable.flac']);
	});
});

describe('recordReadable', () => {
	it('inserts a new file as pending', () => {
		recordReadable(db, [{ identity, path: '/music/test.flac' }]);

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('pending');
		expect(row.file_size).toBe(identity.size);
		expect(row.file_mtime).toBe(identity.mtime);
	});

	it('starts a new episode on a changed identity, preserving first_seen_at', () => {
		recordReadable(db, [{ identity, path: '/music/test.flac' }]);
		const first = findFileByPath(db, '/music/test.flac')!;
		recordVerdict(db, '/music/test.flac', {
			errorOutput: 'boom',
			errorTimestamp: null,
			status: 'corrupt',
		});
		acknowledgeAllIssues(db);
		recordRecoveryOutcome(db, '/music/test.flac', {
			detail: 'too lossy',
			lostSamples: 1,
			result: 'unsuitable',
		});

		recordReadable(db, [{ identity: changedIdentity, path: '/music/test.flac' }]);

		const updated = findFileByPath(db, '/music/test.flac')!;
		expect(updated).toMatchObject({
			acknowledged_at: null,
			file_mtime: changedIdentity.mtime,
			file_size: changedIdentity.size,
			first_seen_at: first.first_seen_at,
			last_healthy_at: null,
			last_result: 'pending',
			last_verified_at: null,
			recovery_attempted_at: null,
			recovery_detail: null,
			recovery_lost_samples: null,
			recovery_result: null,
		});
	});

	it('leaves the row of an unchanged identity untouched and ends its overlay', () => {
		recordReadable(db, [{ identity, path: '/music/test.flac' }]);
		recordVerdict(db, '/music/test.flac', { status: 'healthy' });
		recordVerdict(db, '/music/test.flac', {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		acknowledgeAllIssues(db);
		recordRecoveryOutcome(db, '/music/test.flac', {
			detail: 'too lossy',
			lostSamples: 1,
			result: 'unsuitable',
		});
		unreadable('/music/test.flac');
		const before = findFileByPath(db, '/music/test.flac')!;

		recordReadable(db, [{ identity, path: '/music/test.flac' }]);

		expect(findFileByPath(db, '/music/test.flac')).toEqual(before);
		expect(unreadableRow(db, '/music/test.flac')).toBeUndefined();
	});

	it('promotes an unreadable-only path into a pending row', () => {
		unreadable('/music/test.flac');

		recordReadable(db, [{ identity, path: '/music/test.flac' }]);

		expect(findFileByPath(db, '/music/test.flac')?.last_result).toBe('pending');
		expect(unreadableRow(db, '/music/test.flac')).toBeUndefined();
	});

	it('treats a row with no recorded identity as changed', () => {
		insertFile({ acknowledged_at: '2020-01-01T00:00:00.000Z', last_result: 'corrupt' });

		recordReadable(db, [{ identity, path: '/music/test.flac' }]);

		expect(findFileByPath(db, '/music/test.flac')).toMatchObject({
			acknowledged_at: null,
			file_size: identity.size,
			last_result: 'pending',
		});
	});
});

describe('recordVerdict', () => {
	it('updates result and error fields, clearing any legacy severity', () => {
		insertFile({
			current_path: '/music/test.flac',
			error_severity: 'critical',
			last_verified_at: '2000-01-01T00:00:00.000Z',
		});
		const before = Date.now();

		recordVerdict(db, '/music/test.flac', {
			errorOutput: 'FRAME_CRC_MISMATCH',
			errorTimestamp: 'sample 12345',
			status: 'corrupt',
		});
		const after = Date.now();

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('corrupt');
		expect(row.error_severity).toBeNull();
		expect(row.error_output).toBe('FRAME_CRC_MISMATCH');
		expect(row.error_timestamp).toBe('sample 12345');
		const verifiedAt = Date.parse(row.last_verified_at ?? '');
		expect(verifiedAt).toBeGreaterThanOrEqual(before);
		expect(verifiedAt).toBeLessThanOrEqual(after);
	});

	it('clears the error columns on a healthy verdict', () => {
		insertFile({
			current_path: '/music/test.flac',
			error_output: 'FRAME_CRC_MISMATCH',
			last_result: 'corrupt',
		});

		recordVerdict(db, '/music/test.flac', { status: 'healthy' });

		const row = findFileByPath(db, '/music/test.flac')!;
		expect(row.last_result).toBe('healthy');
		expect(row.error_severity).toBeNull();
		expect(row.error_output).toBeNull();
		expect(row.error_timestamp).toBeNull();
	});
});

describe('prunePaths', () => {
	it('deletes each path from both tables, leaving other rows', () => {
		insertFile({ current_path: '/music/overlay.flac' });
		unreadable('/music/overlay.flac');
		unreadable('/music/unreadable.flac');
		insertFile({ current_path: '/music/kept.flac' });
		unreadable('/music/kept-unreadable.flac');

		prunePaths(db, ['/music/overlay.flac', '/music/unreadable.flac']);

		expect(findFileByPath(db, '/music/overlay.flac')).toBeUndefined();
		expect(unreadableRow(db, '/music/overlay.flac')).toBeUndefined();
		expect(unreadableRow(db, '/music/unreadable.flac')).toBeUndefined();
		expect(findFileByPath(db, '/music/kept.flac')).toBeDefined();
		expect(unreadableRow(db, '/music/kept-unreadable.flac')).toBeDefined();
	});
});

describe('recordUnreadable', () => {
	it('inserts an unreadable path without touching its files row', () => {
		recordReadable(db, [{ identity, path: '/music/known.flac' }]);
		acknowledgeAllIssues(db);
		const before = findFileByPath(db, '/music/known.flac');

		recordUnreadable(db, [
			{ error: 'EACCES', path: '/music/known.flac' },
			{ error: 'read error', path: '/bad/file.flac' },
		]);

		expect(findFileByPath(db, '/music/known.flac')).toEqual(before);
		expect(unreadableRow(db, '/music/known.flac')?.error_output).toBe('EACCES');
		expect(unreadableRow(db, '/bad/file.flac')?.error_output).toBe('read error');
	});

	it('on conflict updates error_output and updated_at, preserves first_seen_at', () => {
		unreadable('/bad/file.flac', 'error 1');
		const first = unreadableRow(db, '/bad/file.flac')!;

		unreadable('/bad/file.flac', 'error 2');
		const second = unreadableRow(db, '/bad/file.flac')!;

		expect(second.error_output).toBe('error 2');
		expect(second.first_seen_at).toBe(first.first_seen_at);
	});
});

describe('findFileByPath', () => {
	it('returns row when exists', () => {
		recordReadable(db, [{ identity, path: '/music/test.flac' }]);
		const row = findFileByPath(db, '/music/test.flac');
		expect(row).toBeDefined();
		expect(row!.current_path).toBe('/music/test.flac');
	});
});

describe('classifySightings', () => {
	it('splits sightings into changed and reread, leaving unchanged readable ones out', () => {
		insertFile({ current_path: '/music/same.flac', file_mtime: identity.mtime, file_size: 1024 });
		insertFile({ current_path: '/music/reread.flac', file_mtime: identity.mtime, file_size: 1024 });
		insertFile({ current_path: '/music/changed.flac', file_mtime: identity.mtime, file_size: 1 });
		insertFile({ current_path: '/music/unknown-identity.flac' });
		unreadable('/music/reread.flac');
		unreadable('/music/promoted.flac');

		const { changed, reread } = classifySightings(
			db,
			[
				'/music/same.flac',
				'/music/reread.flac',
				'/music/changed.flac',
				'/music/unknown-identity.flac',
				'/music/promoted.flac',
				'/music/new.flac',
			].map((filePath) => ({ identity, path: filePath })),
		);

		expect(changed.map((sighting) => sighting.path)).toEqual([
			'/music/changed.flac',
			'/music/unknown-identity.flac',
			'/music/promoted.flac',
			'/music/new.flac',
		]);
		expect(reread.map((sighting) => sighting.path)).toEqual(['/music/reread.flac']);
	});
});

describe('pathsWithIdentity', () => {
	it('matches rows with the exact size and mtime', () => {
		insertFile({ current_path: '/music/a.flac', file_mtime: identity.mtime, file_size: 1024 });
		insertFile({ current_path: '/music/b.flac', file_mtime: identity.mtime, file_size: 1024 });
		insertFile({ current_path: '/music/c.flac', file_mtime: identity.mtime, file_size: 2000 });

		expect(pathsWithIdentity(db, identity).toSorted((a, b) => a.localeCompare(b))).toEqual([
			'/music/a.flac',
			'/music/b.flac',
		]);
	});

	it('does not match on a differing size or mtime', () => {
		insertFile({ current_path: '/music/a.flac', file_mtime: identity.mtime, file_size: 1024 });

		expect(pathsWithIdentity(db, { ...identity, size: 999 })).toHaveLength(0);
		expect(pathsWithIdentity(db, { ...identity, mtime: '2024-01-01T00:00:00.000Z' })).toHaveLength(
			0,
		);
	});

	it('never matches rows with a NULL mtime', () => {
		insertFile({ current_path: '/music/a.flac', file_mtime: null, file_size: 1024 });

		expect(pathsWithIdentity(db, identity)).toHaveLength(0);
	});
});

describe('pathsUnder', () => {
	it('lists both tables under the roots, files first and each overlay path once', () => {
		insertFile({ current_path: '/music/b.flac' });
		insertFile({ current_path: '/music/overlay.flac' });
		unreadable('/music/a.flac');
		unreadable('/music/overlay.flac');
		insertFile({ current_path: '/music-other/x.flac' });
		unreadable('/elsewhere/y.flac');

		expect(pathsUnder(db, ['/music'])).toEqual([
			'/music/b.flac',
			'/music/overlay.flac',
			'/music/a.flac',
		]);
		expect(pathsUnder(db, [])).toEqual([]);
	});
});

describe('applyMoves', () => {
	it('moves the row to the new path, preserving every other column', () => {
		insertFile({
			acknowledged_at: '2025-02-02T00:00:00.000Z',
			current_path: '/music/old.flac',
			error_output: 'FRAME_CRC_MISMATCH',
			file_mtime: '2025-01-01T00:00:00.000Z',
			file_size: 1000,
			last_result: 'corrupt',
			last_verified_at: '2025-01-05T00:00:00.000Z',
		});

		applyMoves(db, [{ from: '/music/old.flac', to: '/music/new.flac' }]);

		expect(findFileByPath(db, '/music/old.flac')).toBeUndefined();
		const moved = findFileByPath(db, '/music/new.flac')!;
		expect(moved.last_result).toBe('corrupt');
		expect(moved.acknowledged_at).toBe('2025-02-02T00:00:00.000Z');
		expect(moved.error_output).toBe('FRAME_CRC_MISMATCH');
		expect(moved.last_verified_at).toBe('2025-01-05T00:00:00.000Z');
		expect(moved.file_size).toBe(1000);
	});

	it('swaps two rows', () => {
		insertFile({ current_path: '/music/left.flac', error_output: 'left' });
		insertFile({ current_path: '/music/right.flac', error_output: 'right' });

		applyMoves(db, [
			{ from: '/music/left.flac', to: '/music/right.flac' },
			{ from: '/music/right.flac', to: '/music/left.flac' },
		]);

		expect(findFileByPath(db, '/music/left.flac')?.error_output).toBe('right');
		expect(findFileByPath(db, '/music/right.flac')?.error_output).toBe('left');
	});

	it('follows a chain onto a vacated name', () => {
		insertFile({ current_path: '/music/1.flac', error_output: 'one' });
		insertFile({ current_path: '/music/2.flac', error_output: 'two' });

		applyMoves(db, [
			{ from: '/music/1.flac', to: '/music/2.flac' },
			{ from: '/music/2.flac', to: '/music/3.flac' },
		]);

		expect(findFileByPath(db, '/music/1.flac')).toBeUndefined();
		expect(findFileByPath(db, '/music/2.flac')?.error_output).toBe('one');
		expect(findFileByPath(db, '/music/3.flac')?.error_output).toBe('two');
	});

	it('replaces a destination row that is not itself moving and ends its overlay', () => {
		insertFile({ current_path: '/music/kept.flac', error_output: 'kept' });
		insertFile({ current_path: '/music/overwritten.flac', error_output: 'overwritten' });
		unreadable('/music/overwritten.flac');

		applyMoves(db, [{ from: '/music/kept.flac', to: '/music/overwritten.flac' }]);

		expect(findFileByPath(db, '/music/kept.flac')).toBeUndefined();
		expect(findFileByPath(db, '/music/overwritten.flac')?.error_output).toBe('kept');
		expect(unreadableRow(db, '/music/overwritten.flac')).toBeUndefined();
	});
});

describe('recovery outcomes', () => {
	it('records a recovery outcome', () => {
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
		const row = findFileByPath(db, '/music/x.flac')!;
		expect(row.recovery_result).toBe('recovered');
		expect(row.recovery_lost_samples).toBe(88_200);
		expect(row.recovery_detail).toBeNull();
		expect(row.recovery_attempted_at).not.toBeNull();
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
		insertFile({ current_path: '/music/c.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/music/b.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/music/d.flac', last_result: 'healthy' });
		recordRecoveryOutcome(db, '/music/a.flac', {
			detail: 'too lossy',
			lostSamples: 1,
			result: 'unsuitable',
		});

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
		recordReadable(db, [{ identity: { ...identity, size: 1 }, path: '/music/first.flac' }]);
		recordReadable(otherDb, [{ identity: { ...identity, size: 2 }, path: '/music/second.flac' }]);

		expect(findFileByPath(db, '/music/first.flac')?.file_size).toBe(1);
		expect(findFileByPath(db, '/music/second.flac')).toBeUndefined();
		expect(findFileByPath(otherDb, '/music/second.flac')?.file_size).toBe(2);
		expect(findFileByPath(otherDb, '/music/first.flac')).toBeUndefined();

		otherDb.close();
	});
});
