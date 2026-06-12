import type Database from 'better-sqlite3';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import ora from 'ora';

import type { FileRow, UnreadableFileRow } from '../database/types.js';

import {
	deleteFileByPath,
	deleteUnreadableByPath,
	findFileByPath,
	getAllUnreadableFiles,
	getCorruptFiles,
	upsertFile,
	upsertUnreadableFile,
} from '../database/queries.js';
import { checkMountedPaths } from '../discovery.js';
import { ensureBinary } from '../shell.js';
import { flacVerifier } from '../verifiers/flac/verify.js';
import { printCorruptFile } from './format-corrupt.js';
import { installShutdownHandler, isShuttingDown, processPool } from './process-pool.js';
import { runCommand } from './run-command.js';
import { sharedArguments } from './shared-arguments.js';
import { verifyAndRecord } from './verify-and-record.js';

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
		installShutdownHandler();
		await runCommand(
			args,
			{
				async prepare() {
					for (const bin of flacVerifier.requiredBinaries) {
						await ensureBinary(bin.name, bin.hint);
					}
				},
			},
			async (db, config) => {
				const mountCheck = checkMountedPaths(config.directories);

				const allItems: RecheckItem[] = [
					...getCorruptFiles(db).map((row): RecheckItem => ({ row, source: 'files' })),
					...getAllUnreadableFiles(db).map((row): RecheckItem => ({ row, source: 'unreadable' })),
				];

				const items = allItems.filter((item) =>
					mountCheck.available.some((dir) => item.row.current_path.startsWith(dir)),
				);

				if (items.length === 0) {
					console.log('No files to recheck.');
					return;
				}

				const spinner = ora({
					discardStdin: false,
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
						console.log(chalk.blue(`  PRUNED ${filePath}`));
						processed++;
						spinner.text = `Rechecking: ${String(processed)}/${String(items.length)} files`;
						return;
					}

					const file = item.source === 'files' ? item.row : promoteUnreadable(db, filePath);
					if (!file) return;

					const outcome = await verifyAndRecord(db, config, flacVerifier, file, { fix: false });

					if (outcome.kind === 'interrupted') return;

					if (outcome.kind === 'corrupt') {
						stats.corrupt++;
						printCorruptFile(spinner, filePath, outcome.severity, outcome);
					} else {
						stats.healthy++;
						spinner.clear();
						console.log(chalk.green(`  HEALTHY ${filePath}`));
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
			},
		);
	},
});

// A previously-unreadable file that now stats moves to files and follows the normal verdict path
function promoteUnreadable(db: Database.Database, filePath: string): FileRow | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		upsertUnreadableFile(db, { current_path: filePath, error_output: String(error) });
		return undefined;
	}
	upsertFile(db, {
		current_path: filePath,
		file_mtime: stat.mtime.toISOString(),
		file_size: stat.size,
	});
	deleteUnreadableByPath(db, filePath);
	return findFileByPath(db, filePath);
}
