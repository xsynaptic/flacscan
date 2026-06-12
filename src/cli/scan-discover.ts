import type Database from 'better-sqlite3';

import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';

import {
	clearRecoveryOutcome,
	findFileByPath,
	findUnreadableByPath,
	upsertFile,
	upsertUnreadableFile,
} from '../database/queries.js';
import { logUnreadable } from '../logging/scan-log.js';
import { isShuttingDown } from './process-pool.js';

// Stat and write in chunked transactions; one autocommit per file is the dominant
// cost on the initial scan of a large collection
const CHUNK_SIZE = 500;

interface DiscoveryStats {
	processed: number;
	skipped: number;
	unreadable: number;
}

export async function runDiscovery(
	db: Database.Database,
	files: string[],
	config: FlacScanConfig,
): Promise<DiscoveryStats> {
	const spinner = ora({
		discardStdin: false,
		text: `Discovery: processing 0/${String(files.length)} files`,
	}).start();

	const stats: DiscoveryStats = {
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
					upsertUnreadableFile(db, {
						current_path: filePath,
						error_output: String(error),
					});
					logUnreadable(config.log_path, filePath, String(error));
					stats.unreadable++;
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

				const existingUnreadable = findUnreadableByPath(db, filePath);
				if (existingUnreadable) {
					// Unchanged since the last failed attempt; don't retry
					const lastAttemptedAt = existingUnreadable.updated_at;
					if (lastAttemptedAt && mtime <= lastAttemptedAt) {
						stats.skipped++;
						stats.processed++;
						spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
						continue;
					}
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
		spinner.succeed(
			`Discovery complete: ${String(files.length)} files (${String(stats.skipped)} cached, ${String(stats.unreadable)} unreadable)`,
		);
	}

	return stats;
}
