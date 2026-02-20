import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import ora from 'ora';

import type { FileRow, UnreadableFileRow } from '../database/types.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import {
	deleteFileByPath,
	deleteUnreadableByPath,
	getAllUnreadableFiles,
	getCorruptFiles,
	updateVerificationResult,
	upsertUnreadableFile,
} from '../database/queries.js';
import { ensureBinary } from '../flac/shell.js';
import { verifyFile } from '../flac/verify.js';
import { FlacScanError } from './errors.js';
import { printCorruptFile } from './format-corrupt.js';
import { installShutdownHandler, isShuttingDown, processPool } from './process-pool.js';
import { sharedArguments } from './shared-arguments.js';

type RecheckItem =
	| { row: FileRow; source: 'files' }
	| { row: UnreadableFileRow; source: 'unreadable' };

export const recheckCommand = defineCommand({
	args: {
		...sharedArguments,
	},
	meta: {
		description: 'Re-verify all known bad files and prune deleted entries',
		name: 'recheck',
	},
	async run({ args }) {
		try {
			installShutdownHandler();
			const config = loadConfig(args);
			await ensureBinary('flac');

			const db = openDatabase(config.db_path);

			try {
				const items: RecheckItem[] = [
					...getCorruptFiles(db).map((row): RecheckItem => ({ row, source: 'files' })),
					...getAllUnreadableFiles(db).map((row): RecheckItem => ({ row, source: 'unreadable' })),
				];

				if (items.length === 0) {
					console.log('No files to recheck.');
					return;
				}

				const spinner = ora({
					text: `Rechecking: 0/${String(items.length)} files`,
				}).start();

				const stats = { corrupt: 0, healthy: 0, pruned: 0 };
				let processed = 0;

				await processPool(items, config.parallelism, async (item) => {
					const filePath = item.row.current_path;

					if (!fs.existsSync(filePath)) {
						if (item.source === 'files') {
							deleteFileByPath(db, filePath);
						} else {
							deleteUnreadableByPath(db, filePath);
						}
						stats.pruned++;
						spinner.clear();
						console.log(chalk.green(`  PRUNED ${filePath}`));
					} else if (item.source === 'files') {
						const result = await verifyFile(filePath);

						if (result.status === 'healthy') {
							updateVerificationResult(db, filePath, { last_result: 'healthy' });
							stats.healthy++;
							spinner.clear();
							console.log(chalk.green(`  HEALTHY ${filePath}`));
						} else {
							updateVerificationResult(db, filePath, {
								error_output: result.errorOutput,
								error_severity: result.severity,
								error_timestamp: result.errorTimestamp,
								last_result: 'corrupt',
							});
							stats.corrupt++;
							printCorruptFile(spinner, filePath, result);
						}
					} else {
						const result = await verifyFile(filePath);

						if (result.status === 'healthy') {
							deleteUnreadableByPath(db, filePath);
							stats.healthy++;
							spinner.clear();
							console.log(chalk.green(`  HEALTHY ${filePath}`));
						} else {
							upsertUnreadableFile(db, {
								current_path: filePath,
								error_output: result.errorOutput,
							});
							stats.corrupt++;
							printCorruptFile(spinner, filePath, result);
						}
					}

					processed++;
					spinner.text = `Rechecking: ${String(processed)}/${String(items.length)} files`;
				});

				const total = stats.healthy + stats.corrupt + stats.pruned;

				if (isShuttingDown()) {
					spinner.warn(
						`Recheck interrupted: ${String(processed)}/${String(items.length)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt, ${String(stats.pruned)} pruned.`,
					);
				} else {
					spinner.succeed(
						`Rechecked ${String(total)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt, ${String(stats.pruned)} pruned.`,
					);
				}

				process.exitCode = stats.corrupt > 0 ? 1 : 0;
			} finally {
				db.close();
			}
		} catch (error) {
			if (error instanceof FlacScanError) {
				console.error(error.message);
				process.exitCode = error.exitCode;
				return;
			}
			throw error;
		}
	},
});
