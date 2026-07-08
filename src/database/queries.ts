import type Database from 'better-sqlite3';

import type { FlacMetadata } from '../metadata.js';
import type { ErrorSeverity } from '../verifiers/types.js';
import type { FileRow, FileStatus, RecoveryResult, UnreadableFileRow } from './types.js';

import { directoryPrefix } from '../paths.js';

// Prepared statements are cached per database handle; re-preparing on every call
// dominates discovery cost on large collections
const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function clearRecoveryOutcome(database: Database.Database, currentPath: string) {
	prepareCached(
		database,
		`UPDATE files SET recovery_attempted_at = NULL, recovery_result = NULL, recovery_lost_samples = NULL, recovery_detail = NULL WHERE current_path = ?`,
	).run(currentPath);
}

export function countRecoveryAttempted(database: Database.Database): number {
	return (
		prepareCached(
			database,
			`SELECT COUNT(*) AS count FROM files WHERE last_result = 'corrupt' AND recovery_attempted_at IS NOT NULL`,
		).get() as { count: number }
	).count;
}

export function deleteFileByPath(database: Database.Database, currentPath: string) {
	prepareCached(database, `DELETE FROM files WHERE current_path = ?`).run(currentPath);
}

export function deleteUnreadableByPath(database: Database.Database, currentPath: string) {
	prepareCached(database, `DELETE FROM unreadable_files WHERE current_path = ?`).run(currentPath);
}

export function findFileByPath(
	database: Database.Database,
	currentPath: string,
): FileRow | undefined {
	return prepareCached(database, `SELECT * FROM files WHERE current_path = ?`).get(currentPath) as
		| FileRow
		| undefined;
}

export function findUnreadableByPath(
	database: Database.Database,
	currentPath: string,
): undefined | UnreadableFileRow {
	return prepareCached(database, `SELECT * FROM unreadable_files WHERE current_path = ?`).get(
		currentPath,
	) as undefined | UnreadableFileRow;
}

export function getAllUnreadableFiles(database: Database.Database): UnreadableFileRow[] {
	return prepareCached(
		database,
		`SELECT * FROM unreadable_files ORDER BY current_path`,
	).all() as UnreadableFileRow[];
}

export function getCorruptFiles(database: Database.Database): FileRow[] {
	return prepareCached(
		database,
		`SELECT * FROM files WHERE last_result = 'corrupt' ORDER BY current_path`,
	).all() as FileRow[];
}

export function getCorruptFilesBySeverity(
	database: Database.Database,
	severity: ErrorSeverity,
): FileRow[] {
	return prepareCached(
		database,
		`SELECT * FROM files WHERE last_result = 'corrupt' AND error_severity = ? ORDER BY current_path`,
	).all(severity) as FileRow[];
}

export function getFilesNeedingVerification(
	database: Database.Database,
	rescanDays: number,
	batchSize: number,
	directories: string[],
): FileRow[] {
	if (directories.length === 0) return [];

	const cutoff = new Date(Date.now() - rescanDays * 24 * 60 * 60 * 1000).toISOString();

	const dirClauses = directories.map(() => String.raw`current_path LIKE ? ESCAPE '\'`).join(' OR ');
	const escapedDirs = directories.map((dir) => escapeLikePattern(directoryPrefix(dir)) + '%');

	return prepareCached(
		database,
		`
    SELECT * FROM files
    WHERE (${dirClauses})
      AND (last_result = 'pending'
        OR (last_result IN ('healthy', 'corrupt') AND (last_verified_at IS NULL OR last_verified_at < ?)))
    ORDER BY last_verified_at ASC NULLS FIRST
    LIMIT ?
  `,
	).all(...escapedDirs, cutoff, batchSize) as FileRow[];
}

export function getRecoveryCandidates(
	database: Database.Database,
	options: { severity?: ErrorSeverity } = {},
): FileRow[] {
	// Always skips files that already have a recovery outcome; to re-attempt them, clear
	// their recovery_* columns in SQLite directly. (Avoids carrying a one-off `--retry` flag
	// on `recover` itself for a workflow that's rare and easy to do with one UPDATE.)
	const clauses = [`last_result = 'corrupt'`, `recovery_attempted_at IS NULL`];
	const params: string[] = [];
	if (options.severity) {
		clauses.push(`error_severity = ?`);
		params.push(options.severity);
	}
	return prepareCached(
		database,
		`SELECT * FROM files WHERE ${clauses.join(' AND ')} ORDER BY current_path`,
	).all(...params) as FileRow[];
}

export function getStats(database: Database.Database) {
	const resultCounts = prepareCached(
		database,
		`SELECT last_result, COUNT(*) as count FROM files GROUP BY last_result`,
	).all() as { count: number; last_result: FileStatus }[];

	const countsByResult: Record<string, number> = {};
	let total = 0;
	for (const row of resultCounts) {
		countsByResult[row.last_result] = row.count;
		total += row.count;
	}

	const unreadable = (
		prepareCached(database, `SELECT COUNT(*) as count FROM unreadable_files`).get() as {
			count: number;
		}
	).count;

	const severityBreakdown = prepareCached(
		database,
		`SELECT error_severity, COUNT(*) as count FROM files WHERE last_result = 'corrupt' GROUP BY error_severity`,
	).all() as { count: number; error_severity: ErrorSeverity | null }[];

	const recoveryBreakdown = prepareCached(
		database,
		`SELECT recovery_result, COUNT(*) as count FROM files WHERE last_result = 'corrupt' GROUP BY recovery_result`,
	).all() as { count: number; recovery_result: null | RecoveryResult }[];

	return {
		corrupt: countsByResult['corrupt'] ?? 0,
		healthy: countsByResult['healthy'] ?? 0,
		pending: countsByResult['pending'] ?? 0,
		recoveryBreakdown,
		severityBreakdown,
		total,
		unreadable,
	};
}

export function recordRecoveryOutcome(
	database: Database.Database,
	currentPath: string,
	outcome: { detail: null | string; lostSamples: null | number; result: RecoveryResult },
) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`
    UPDATE files SET
      recovery_attempted_at = ?,
      recovery_result = ?,
      recovery_lost_samples = ?,
      recovery_detail = ?,
      updated_at = ?
    WHERE current_path = ?
  `,
	).run(now, outcome.result, outcome.lostSamples, outcome.detail, now, currentPath);
}

export function updateMetadata(
	database: Database.Database,
	currentPath: string,
	metadata: FlacMetadata,
) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`
    UPDATE files SET
      artist = ?,
      title = ?,
      album = ?,
      date = ?,
      duration = ?,
      updated_at = ?
    WHERE current_path = ?
  `,
	).run(
		metadata.artist,
		metadata.title,
		metadata.album,
		metadata.date,
		metadata.duration,
		now,
		currentPath,
	);
}

export function updateVerificationResult(
	database: Database.Database,
	currentPath: string,
	result: {
		error_output?: null | string;
		error_severity?: ErrorSeverity | null;
		error_timestamp?: null | string;
		last_result: FileStatus;
	},
) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`
    UPDATE files SET
      last_verified_at = ?,
      last_result = ?,
      error_severity = ?,
      error_output = ?,
      error_timestamp = ?,
      updated_at = ?
    WHERE current_path = ?
  `,
	).run(
		now,
		result.last_result,
		result.error_severity ?? null,
		result.error_output ?? null,
		result.error_timestamp ?? null,
		now,
		currentPath,
	);
}

export function upsertFile(
	database: Database.Database,
	file: {
		current_path: string;
		file_mtime: null | string;
		file_size: null | number;
	},
) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`
    INSERT INTO files (current_path, file_size, file_mtime, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (current_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      updated_at = excluded.updated_at,
      -- the file's bytes changed (different mtime/size), so the previous verification is
      -- stale — mark it pending so the next scan re-verifies it
      last_result = 'pending',
      last_verified_at = NULL
  `,
	).run(file.current_path, file.file_size, file.file_mtime, now, now);
}

export function upsertUnreadableFile(
	database: Database.Database,
	file: { current_path: string; error_output: string },
) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`
    INSERT INTO unreadable_files (current_path, error_output, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (current_path) DO UPDATE SET
      error_output = excluded.error_output,
      updated_at = excluded.updated_at
  `,
	).run(file.current_path, file.error_output, now, now);
}

function escapeLikePattern(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('%', String.raw`\%`)
		.replaceAll('_', String.raw`\_`);
}

function prepareCached(database: Database.Database, sql: string): Database.Statement {
	let cache = statementCaches.get(database);
	if (cache === undefined) {
		cache = new Map();
		statementCaches.set(database, cache);
	}
	let statement = cache.get(sql);
	if (statement === undefined) {
		statement = database.prepare(sql);
		cache.set(sql, statement);
	}
	return statement;
}
