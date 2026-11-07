import type Database from 'better-sqlite3';
import type fs from 'node:fs';

import type { FlacScanConfig } from '#config/types.ts';
import type {
	FileIdentity,
	FileRow,
	FileStatus,
	RecoveryResult,
	Sighting,
} from '#database/types.ts';
import type { FlacMetadata } from '#metadata.ts';

import { directoryPrefix } from '#paths.ts';

// Re-preparing on every call dominates discovery cost on large collections
const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

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

export function applyMoves(database: Database.Database, moves: { from: string; to: string }[]) {
	if (moves.length === 0) return;
	const sources = new Set(moves.map((move) => move.from));
	const now = new Date().toISOString();
	const rename = prepareCached(
		database,
		`UPDATE files SET current_path = ?, updated_at = ? WHERE current_path = ?`,
	);
	const fileRemoval = prepareCached(database, `DELETE FROM files WHERE current_path = ?`);
	const unreadableRemoval = prepareCached(
		database,
		`DELETE FROM unreadable_files WHERE current_path = ?`,
	);
	database.transaction(() => {
		for (const move of moves) {
			if (!sources.has(move.to)) fileRemoval.run(move.to);
		}
		for (const [index, move] of moves.entries()) {
			rename.run(`moving:${String(index)}`, now, move.from);
		}
		for (const [index, move] of moves.entries()) {
			rename.run(move.to, now, `moving:${String(index)}`);
			unreadableRemoval.run(move.to);
		}
	})();
}

export function classifySightings(
	database: Database.Database,
	sightings: Sighting[],
): { changed: Sighting[]; reread: Sighting[] } {
	const unreadable = new Set(
		prepareCached(database, `SELECT current_path FROM unreadable_files`).pluck().all() as string[],
	);
	const changed: Sighting[] = [];
	const reread: Sighting[] = [];
	for (const sighting of sightings) {
		const row = findFileByPath(database, sighting.path);
		if (row?.file_mtime !== sighting.identity.mtime || row.file_size !== sighting.identity.size) {
			changed.push(sighting);
		} else if (unreadable.has(sighting.path)) {
			reread.push(sighting);
		}
	}
	return { changed, reread };
}

export function countRecoveryAttempted(database: Database.Database): number {
	return (
		prepareCached(
			database,
			`SELECT COUNT(*) AS count FROM files WHERE last_result = 'corrupt' AND recovery_attempted_at IS NOT NULL`,
		).get() as { count: number }
	).count;
}

export function findFileByPath(
	database: Database.Database,
	currentPath: string,
): FileRow | undefined {
	return prepareCached(database, `SELECT * FROM files WHERE current_path = ?`).get(currentPath) as
		FileRow | undefined;
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
      AND NOT EXISTS (SELECT 1 FROM unreadable_files WHERE unreadable_files.current_path = files.current_path)
      AND (last_result = 'pending'
        OR (last_result IN ('healthy', 'corrupt') AND (last_verified_at IS NULL OR last_verified_at < ?)))
    ORDER BY last_verified_at ASC NULLS FIRST
    LIMIT ?
  `,
	).all(...bounds, cutoff, limits.batch_size) as FileRow[];
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

	const recoveryBreakdown = prepareCached(
		database,
		`SELECT recovery_result, COUNT(*) as count FROM files WHERE last_result = 'corrupt' GROUP BY recovery_result`,
	).all() as { count: number; recovery_result: null | RecoveryResult }[];

	return {
		healthy: countsByResult.healthy ?? 0,
		pending: countsByResult.pending ?? 0,
		recoveryBreakdown,
		total,
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

export function identityOf(stats: fs.Stats): FileIdentity {
	return { mtime: stats.mtime.toISOString(), size: stats.size };
}

export function pathsUnder(database: Database.Database, roots: string[]): string[] {
	if (roots.length === 0) return [];
	const { bounds, clauses } = underDirectories(roots);
	const files = prepareCached(database, `SELECT current_path FROM files WHERE ${clauses}`)
		.pluck()
		.all(...bounds) as string[];
	const known = new Set(files);
	const unreadable = (
		prepareCached(database, `SELECT current_path FROM unreadable_files WHERE ${clauses}`)
			.pluck()
			.all(...bounds) as string[]
	).filter((filePath) => !known.has(filePath));
	return [...files, ...unreadable];
}

export function pathsWithIdentity(database: Database.Database, identity: FileIdentity): string[] {
	return prepareCached(
		database,
		`SELECT current_path FROM files WHERE file_size = ? AND file_mtime = ?`,
	)
		.pluck()
		.all(identity.size, identity.mtime) as string[];
}

export function prunePaths(database: Database.Database, paths: string[]) {
	const fileRemoval = prepareCached(database, `DELETE FROM files WHERE current_path = ?`);
	const unreadableRemoval = prepareCached(
		database,
		`DELETE FROM unreadable_files WHERE current_path = ?`,
	);
	database.transaction(() => {
		for (const filePath of paths) {
			fileRemoval.run(filePath);
			unreadableRemoval.run(filePath);
		}
	})();
}

export function recordMetadata(
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

export function recordReadable(database: Database.Database, sightings: Sighting[]) {
	const now = new Date().toISOString();
	const upsert = prepareCached(
		database,
		`
    INSERT INTO files (current_path, file_size, file_mtime, first_seen_at, updated_at)
    VALUES (@path, @size, @mtime, @now, @now)
    ON CONFLICT (current_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      updated_at = excluded.updated_at,
      last_result = 'pending',
      last_verified_at = NULL,
      last_healthy_at = NULL,
      acknowledged_at = NULL,
      recovery_attempted_at = NULL,
      recovery_result = NULL,
      recovery_lost_samples = NULL,
      recovery_detail = NULL
    WHERE files.file_size IS NOT excluded.file_size OR files.file_mtime IS NOT excluded.file_mtime
  `,
	);
	const endOverlay = prepareCached(database, `DELETE FROM unreadable_files WHERE current_path = ?`);
	database.transaction(() => {
		for (const { identity, path } of sightings) {
			upsert.run({ mtime: identity.mtime, now, path, size: identity.size });
			endOverlay.run(path);
		}
	})();
}

export function recordUnreadable(
	database: Database.Database,
	entries: { error: string; path: string }[],
) {
	const now = new Date().toISOString();
	const upsert = prepareCached(
		database,
		`
    INSERT INTO unreadable_files (current_path, error_output, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (current_path) DO UPDATE SET
      error_output = excluded.error_output,
      updated_at = excluded.updated_at
  `,
	);
	database.transaction(() => {
		for (const { error, path } of entries) upsert.run(path, error, now, now);
	})();
}

export function recordVerdict(
	database: Database.Database,
	currentPath: string,
	verdict:
		| { errorOutput: string; errorTimestamp: null | string; status: 'corrupt' }
		| { status: 'healthy' },
) {
	const corrupt = verdict.status === 'corrupt' ? verdict : undefined;
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
		errorOutput: corrupt?.errorOutput ?? null,
		errorTimestamp: corrupt?.errorTimestamp ?? null,
		lastResult: verdict.status,
		now: new Date().toISOString(),
	});
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
