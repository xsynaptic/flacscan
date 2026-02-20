import type Database from 'better-sqlite3';

import type { ErrorSeverity } from '../flac/types.js';
import type { FileRow, FileStatus, UnreadableFileRow } from './types.js';

export function deleteFileByPath(database: Database.Database, currentPath: string) {
	database.prepare(`DELETE FROM files WHERE current_path = ?`).run(currentPath);
}

export function deleteUnreadableByPath(database: Database.Database, currentPath: string) {
	database.prepare(`DELETE FROM unreadable_files WHERE current_path = ?`).run(currentPath);
}

export function findFileByPath(
	database: Database.Database,
	currentPath: string,
): FileRow | undefined {
	return database.prepare(`SELECT * FROM files WHERE current_path = ?`).get(currentPath) as
		| FileRow
		| undefined;
}

export function findUnreadableByPath(
	database: Database.Database,
	currentPath: string,
): undefined | UnreadableFileRow {
	return database
		.prepare(`SELECT * FROM unreadable_files WHERE current_path = ?`)
		.get(currentPath) as undefined | UnreadableFileRow;
}

export function getAllUnreadableFiles(database: Database.Database): UnreadableFileRow[] {
	return database
		.prepare(`SELECT * FROM unreadable_files ORDER BY current_path`)
		.all() as UnreadableFileRow[];
}

export function getCorruptFiles(database: Database.Database): FileRow[] {
	return database
		.prepare(
			`SELECT * FROM files WHERE last_result = 'corrupt' ORDER BY
      CASE error_severity
        WHEN 'critical' THEN 1
        WHEN 'recoverable' THEN 2
        WHEN 'unknown' THEN 3
        ELSE 4
      END, current_path`,
		)
		.all() as FileRow[];
}

export function getCorruptFilesBySeverity(
	database: Database.Database,
	severity: ErrorSeverity,
): FileRow[] {
	return database
		.prepare(
			`SELECT * FROM files WHERE last_result = 'corrupt' AND error_severity = ? ORDER BY current_path`,
		)
		.all(severity) as FileRow[];
}

export function getFilesNeedingVerification(
	database: Database.Database,
	rescanDays: number,
	batchSize: number,
	directories: string[],
): FileRow[] {
	const cutoff = new Date(Date.now() - rescanDays * 24 * 60 * 60 * 1000).toISOString();

	if (directories.length === 0) return [];

	const dirClauses = directories.map(() => String.raw`current_path LIKE ? ESCAPE '\'`).join(' OR ');
	const escapedDirs = directories.map((d) => escapeLikePattern(d) + '%');

	return database
		.prepare(
			`
    SELECT * FROM files
    WHERE (${dirClauses})
      AND (last_result = 'pending'
        OR (last_result IN ('healthy', 'corrupt') AND (last_verified_at IS NULL OR last_verified_at < ?)))
    ORDER BY last_verified_at ASC NULLS FIRST
    LIMIT ?
  `,
		)
		.all(...escapedDirs, cutoff, batchSize) as FileRow[];
}

export function getStats(database: Database.Database) {
	const resultCounts = database
		.prepare(`SELECT last_result, COUNT(*) as count FROM files GROUP BY last_result`)
		.all() as { count: number; last_result: FileStatus }[];

	const countsByResult: Record<string, number> = {};
	let total = 0;
	for (const row of resultCounts) {
		countsByResult[row.last_result] = row.count;
		total += row.count;
	}

	const unreadable = (
		database.prepare(`SELECT COUNT(*) as count FROM unreadable_files`).get() as {
			count: number;
		}
	).count;

	const severityBreakdown = database
		.prepare(
			`SELECT error_severity, COUNT(*) as count FROM files WHERE last_result = 'corrupt' GROUP BY error_severity`,
		)
		.all() as { count: number; error_severity: ErrorSeverity | null }[];

	return {
		corrupt: countsByResult['corrupt'] ?? 0,
		healthy: countsByResult['healthy'] ?? 0,
		pending: countsByResult['pending'] ?? 0,
		severityBreakdown,
		total,
		unreadable,
	};
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
	database
		.prepare(
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
		)
		.run(
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
	database
		.prepare(
			`
    INSERT INTO files (current_path, file_size, file_mtime, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (current_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      updated_at = excluded.updated_at
  `,
		)
		.run(file.current_path, file.file_size, file.file_mtime, now, now);
}

export function upsertUnreadableFile(
	database: Database.Database,
	file: { current_path: string; error_output: string },
) {
	const now = new Date().toISOString();
	database
		.prepare(
			`
    INSERT INTO unreadable_files (current_path, error_output, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (current_path) DO UPDATE SET
      error_output = excluded.error_output,
      updated_at = excluded.updated_at
  `,
		)
		.run(file.current_path, file.error_output, now, now);
}

function escapeLikePattern(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('%', String.raw`\%`)
		.replaceAll('_', String.raw`\_`);
}
