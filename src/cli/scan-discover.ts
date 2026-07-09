import type Database from 'better-sqlite3';

import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';
import type { FileRow } from '../database/types.js';

import {
	clearRecoveryOutcome,
	deleteUnreadableByPath,
	findFileByPath,
	findFilesBySizeAndMtime,
	findUnreadableByPath,
	updateFilePath,
	upsertFile,
	upsertUnreadableFile,
} from '../database/queries.js';
import { logFileMoved, logUnreadable } from '../logging/scan-log.js';
import { directoryPrefix } from '../paths.js';
import { isShuttingDown } from './process-pool.js';

// Stat and write in chunked transactions; one autocommit per file is the dominant
// cost on the initial scan of a large collection
const CHUNK_SIZE = 500;

interface DiscoveryStats {
	moved: number;
	processed: number;
	skipped: number;
	unreadable: number;
}

export async function runDiscovery(
	db: Database.Database,
	files: string[],
	config: FlacScanConfig,
	availableDirectories: string[],
): Promise<DiscoveryStats> {
	const spinner = ora({
		discardStdin: false,
		text: `Discovery: processing 0/${String(files.length)} files`,
	}).start();

	const stats: DiscoveryStats = {
		moved: 0,
		processed: 0,
		skipped: 0,
		unreadable: 0,
	};

	for (let offset = 0; offset < files.length && !isShuttingDown(); offset += CHUNK_SIZE) {
		const chunk = files.slice(offset, offset + CHUNK_SIZE);
		db.transaction(() => {
			for (const filePath of chunk) {
				let mtime: string;
				let size: number;

				try {
					const stat = fs.statSync(filePath);
					mtime = stat.mtime.toISOString();
					size = stat.size;
				} catch (error) {
					// ENOENT means it vanished between walk and stat; not an unreadable issue, skip it
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						upsertUnreadableFile(db, {
							current_path: filePath,
							error_output: String(error),
						});
						logUnreadable(config.log_path, filePath, String(error));
						stats.unreadable++;
					}
					stats.processed++;
					spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
					continue;
				}

				const existing = findFileByPath(db, filePath);
				if (existing?.file_mtime === mtime && existing.file_size === size) {
					stats.skipped++;
					stats.processed++;
					spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
					continue;
				}

				if (!existing) {
					const moved = findMoveSource(db, filePath, mtime, size, availableDirectories);
					if (moved) {
						updateFilePath(db, moved.current_path, filePath);
						logFileMoved(config.log_path, moved.current_path, filePath);
						stats.moved++;
						stats.processed++;
						spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
						continue;
					}
				}

				if (findUnreadableByPath(db, filePath)) {
					// Readable again; rejoin the normal pipeline
					deleteUnreadableByPath(db, filePath);
				}

				try {
					upsertFile(db, {
						current_path: filePath,
						file_mtime: mtime,
						file_size: size,
					});
					// The file changed (or is new); any prior `recover` verdict is moot now
					if (existing) {
						clearRecoveryOutcome(db, filePath);
					}
				} catch (error) {
					console.warn(`Warning: failed to update database for ${filePath}: ${String(error)}`);
				}

				stats.processed++;
				spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
			}
		})();
		// Yield so SIGINT and the spinner can run between chunks
		await new Promise((resolve) => setImmediate(resolve));
	}

	if (isShuttingDown()) {
		spinner.warn(
			`Discovery interrupted: ${String(stats.processed)}/${String(files.length)} files processed`,
		);
	} else {
		const movedSummary = stats.moved > 0 ? `, ${String(stats.moved)} moved` : '';
		spinner.succeed(
			`Discovery complete: ${String(files.length)} files (${String(stats.skipped)} cached, ${String(stats.unreadable)} unreadable${movedSummary})`,
		);
	}

	return stats;
}

// A new path is a move destination only when exactly one row shares size+mtime,
// its old path is gone, and that old path sits under a mounted root (else we
// can't tell a move from a copy of an offline original)
function findMoveSource(
	db: Database.Database,
	newPath: string,
	mtime: string,
	size: number,
	availableDirectories: string[],
): FileRow | undefined {
	const candidates = findFilesBySizeAndMtime(db, size, mtime);
	if (candidates.length !== 1) return undefined;
	const candidate = candidates[0];
	if (candidate === undefined || candidate.current_path === newPath) return undefined;
	const underAvailableRoot = availableDirectories.some((directory) =>
		candidate.current_path.startsWith(directoryPrefix(directory)),
	);
	if (!underAvailableRoot) return undefined;
	if (fs.existsSync(candidate.current_path)) return undefined;
	return candidate;
}
