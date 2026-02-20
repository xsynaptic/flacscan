import type Database from 'better-sqlite3';

import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';

import {
	findFileByPath,
	findUnreadableByPath,
	upsertFile,
	upsertUnreadableFile,
} from '../database/queries.js';
import { logUnreadable } from '../logging/scan-log.js';
import { isShuttingDown, processPool } from './process-pool.js';

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

	await processPool(files, config.parallelism, (filePath) => {
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
			return;
		}

		const existing = findFileByPath(db, filePath);
		if (existing?.file_mtime === mtime && existing.file_size === size) {
			stats.skipped++;
			stats.processed++;
			spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
			return;
		}

		// Check unreadable_files table too
		const existingUnreadable = findUnreadableByPath(db, filePath);
		if (existingUnreadable) {
			// If file hasn't changed since we last tried, skip
			const lastAttemptedAt = existingUnreadable.updated_at;
			if (lastAttemptedAt && mtime <= lastAttemptedAt) {
				stats.skipped++;
				stats.processed++;
				spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
				return;
			}
		}

		try {
			upsertFile(db, {
				current_path: filePath,
				file_mtime: mtime,
				file_size: size,
			});
		} catch (error) {
			console.warn(`Warning: failed to update database for ${filePath}: ${String(error)}`);
		}

		stats.processed++;
		spinner.text = `Discovery: ${String(stats.processed)}/${String(files.length)} files (${String(stats.skipped)} cached)`;
	});

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
