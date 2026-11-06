import type Database from 'better-sqlite3';

import type { FlacScanConfig } from '#config/types.ts';
import type { FileRow, FileStatus, RecoveryResult, UnreadableFileRow } from '#database/types.ts';
import type { FlacMetadata } from '#metadata.ts';

import { directoryPrefix } from '#paths.ts';

// Re-preparing on every call dominates discovery cost on large collections
const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

const regressedClause = `last_result = 'corrupt' AND last_healthy_at IS NOT NULL`;

export function acknowledgeAllIssues(database: Database.Database): {
	corrupt: number;
	unreadable: number;
} {
	const now = new Date().toISOString();
	const corrupt = prepareCached(
		database,
		`UPDATE files SET acknowledged_at = ?, updated_at = ? WHERE last_result = 'corrupt' AND acknowledged_at IS NULL`,
	).run(now, now).changes;
	const unreadable = prepareCached(
		database,
		`UPDATE unreadable_files SET acknowledged_at = ?, updated_at = ? WHERE acknowledged_at IS NULL`,
	).run(now, now).changes;
	return { corrupt, unreadable };
}

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
		FileRow | undefined;
}

export function findFilesBySizeAndMtime(
	database: Database.Database,
	fileSize: number,
	fileMtime: string,
): FileRow[] {
	return prepareCached(database, `SELECT * FROM files WHERE file_size = ? AND file_mtime = ?`).all(
		fileSize,
		fileMtime,
	) as FileRow[];
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

export function getCorruptFilesByAcknowledged(
	database: Database.Database,
	acknowledged: boolean,
): FileRow[] {
	const clause = acknowledged ? 'acknowledged_at IS NOT NULL' : 'acknowledged_at IS NULL';
	return prepareCached(
		database,
		`SELECT * FROM files WHERE last_result = 'corrupt' AND ${clause} ORDER BY current_path`,
	).all() as FileRow[];
}

export function getFilesNeedingVerification(
	database: Database.Database,
	directories: string[],
	limits: Pick<FlacScanConfig, 'batch_size' | 'rescan_interval_days'>,
): FileRow[] {
	if (directories.length === 0) return [];

	const cutoff = new Date(
		Date.now() - limits.rescan_interval_days * 24 * 60 * 60 * 1000,
	).toISOString();

	const { bounds, clauses } = underDirectories(directories);

	return prepareCached(
		database,
		`
    SELECT * FROM files
    WHERE (${clauses})
      AND (last_result = 'pending'
        OR (last_result IN ('healthy', 'corrupt') AND (last_verified_at IS NULL OR last_verified_at < ?)))
    ORDER BY last_verified_at ASC NULLS FIRST
    LIMIT ?
  `,
	).all(...bounds, cutoff, limits.batch_size) as FileRow[];
}

export function getPathsUnder(
	database: Database.Database,
	table: 'files' | 'unreadable_files',
	directories: string[],
): string[] {
	if (directories.length === 0) return [];
	const { bounds, clauses } = underDirectories(directories);
	return prepareCached(database, `SELECT current_path FROM ${table} WHERE ${clauses}`)
		.pluck()
		.all(...bounds) as string[];
}

export function getRecoveryCandidates(database: Database.Database): FileRow[] {
	return prepareCached(
		database,
		`SELECT * FROM files WHERE last_result = 'corrupt' AND recovery_attempted_at IS NULL ORDER BY current_path`,
	).all() as FileRow[];
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

	const newCorrupt = (
		prepareCached(
			database,
			`SELECT COUNT(*) as count FROM files WHERE last_result = 'corrupt' AND acknowledged_at IS NULL`,
		).get() as { count: number }
	).count;

	const newUnreadable = (
		prepareCached(
			database,
			`SELECT COUNT(*) as count FROM unreadable_files WHERE acknowledged_at IS NULL`,
		).get() as { count: number }
	).count;

	const regressed = prepareCached(
		database,
		`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE acknowledged_at IS NULL) AS new FROM files WHERE ${regressedClause}`,
	).get() as { new: number; total: number };

	const recoveryBreakdown = prepareCached(
		database,
		`SELECT recovery_result, COUNT(*) as count FROM files WHERE last_result = 'corrupt' GROUP BY recovery_result`,
	).all() as { count: number; recovery_result: null | RecoveryResult }[];

	return {
		corrupt: countsByResult.corrupt ?? 0,
		healthy: countsByResult.healthy ?? 0,
		newCorrupt,
		newRegressed: regressed.new,
		newUnreadable,
		pending: countsByResult.pending ?? 0,
		recoveryBreakdown,
		regressed: regressed.total,
		total,
		unreadable,
	};
}

export function getRegressedFiles(database: Database.Database): FileRow[] {
	return prepareCached(
		database,
		`SELECT * FROM files WHERE ${regressedClause} ORDER BY current_path`,
	).all() as FileRow[];
}

export function getUnreadableFilesByAcknowledged(
	database: Database.Database,
	acknowledged: boolean,
): UnreadableFileRow[] {
	const clause = acknowledged ? 'acknowledged_at IS NOT NULL' : 'acknowledged_at IS NULL';
	return prepareCached(
		database,
		`SELECT * FROM unreadable_files WHERE ${clause} ORDER BY current_path`,
	).all() as UnreadableFileRow[];
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

export function updateFilePath(database: Database.Database, oldPath: string, newPath: string) {
	const now = new Date().toISOString();
	prepareCached(
		database,
		`UPDATE files SET current_path = ?, updated_at = ? WHERE current_path = ?`,
	).run(newPath, now, oldPath);
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
		error_timestamp?: null | string;
		last_result: FileStatus;
	},
) {
	prepareCached(
		database,
		`
    UPDATE files SET
      last_verified_at = @now,
      last_result = @lastResult,
      last_healthy_at = CASE WHEN @lastResult = 'healthy' THEN @now ELSE last_healthy_at END,
      acknowledged_at = CASE WHEN @lastResult = 'healthy' THEN NULL ELSE acknowledged_at END,
      error_severity = NULL,
      error_output = @errorOutput,
      error_timestamp = @errorTimestamp,
      updated_at = @now
    WHERE current_path = @currentPath
  `,
	).run({
		currentPath,
		errorOutput: result.error_output ?? null,
		errorTimestamp: result.error_timestamp ?? null,
		lastResult: result.last_result,
		now: new Date().toISOString(),
	});
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
      -- changed bytes are a new episode: re-verify from scratch and drop any acknowledgement
      last_result = 'pending',
      last_verified_at = NULL,
      last_healthy_at = NULL,
      acknowledged_at = NULL
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

function underDirectories(directories: string[]) {
	const clauses = directories.map(() => '(current_path >= ? AND current_path < ?)').join(' OR ');
	const bounds = directories.flatMap((directory) => {
		const prefix = directoryPrefix(directory);
		const separator = prefix.codePointAt(prefix.length - 1) ?? 0;
		return [prefix, prefix.slice(0, -1) + String.fromCodePoint(separator + 1)];
	});
	return { bounds, clauses };
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
