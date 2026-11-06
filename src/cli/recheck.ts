import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import ora from 'ora';

import type { FileRow, UnreadableFileRow } from '#database/types.ts';

import { corruptSummary, printCorruptFile } from '#cli/format-corrupt.ts';
import { installShutdownHandler, isShuttingDown, processPool } from '#cli/process-pool.ts';
import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { verifyAndRecord } from '#cli/verify-and-record.ts';
import {
	deleteFileByPath,
	deleteUnreadableByPath,
	findFileByPath,
	getAllUnreadableFiles,
	getCorruptFiles,
	upsertFile,
	upsertUnreadableFile,
} from '#database/queries.ts';
import { checkMountedPaths } from '#discovery.ts';
import { logUnreadable } from '#logging/scan-log.ts';
import { directoryPrefix, existsAsSpelled } from '#paths.ts';
import { ensureBinary } from '#shell.ts';
import { flacVerifier } from '#verifiers/flac/verify.ts';

type RecheckItem =
	{ row: FileRow; source: 'files' } | { row: UnreadableFileRow; source: 'unreadable' };

interface RecheckRun {
	db: Database.Database;
	logPath: string;
	spinner: Ora;
	stats: RecheckStats;
}

interface RecheckStats {
	corrupt: number;
	healthy: number;
	newCorrupt: number;
	newRegressed: number;
	pruned: number;
}

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
				exclusive: true,
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
					mountCheck.available.some((dir) =>
						item.row.current_path.startsWith(directoryPrefix(dir)),
					),
				);

				if (items.length === 0) {
					console.log('No files to recheck.');
					return;
				}

				const spinner = ora({
					discardStdin: false,
					text: `Rechecking: 0/${String(items.length)} files`,
				}).start();

				const stats: RecheckStats = {
					corrupt: 0,
					healthy: 0,
					newCorrupt: 0,
					newRegressed: 0,
					pruned: 0,
				};
				const run: RecheckRun = { db, logPath: config.log_path, spinner, stats };
				let processed = 0;

				await processPool(items, config.parallelism, async (item) => {
					if (!(await recheckOne(run, item))) return;
					processed++;
					spinner.text = `Rechecking: ${String(processed)}/${String(items.length)} files`;
				});

				const total = stats.healthy + stats.corrupt + stats.pruned;
				const counts = `${String(stats.healthy)} healthy, ${corruptSummary(stats)}, ${String(stats.pruned)} pruned.`;

				if (isShuttingDown()) {
					spinner.warn(
						`Recheck interrupted: ${String(processed)}/${String(items.length)} files. ${counts}`,
					);
				} else {
					spinner.succeed(`Rechecked ${String(total)} files. ${counts}`);
				}

				process.exitCode = stats.newCorrupt > 0 ? 1 : 0;
			},
		);
	},
});

function promoteUnreadable({ db, logPath }: RecheckRun, filePath: string): FileRow | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		upsertUnreadableFile(db, { current_path: filePath, error_output: String(error) });
		logUnreadable(logPath, filePath, String(error));
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

function pruneItem({ db, spinner, stats }: RecheckRun, item: RecheckItem) {
	const filePath = item.row.current_path;
	if (item.source === 'files') {
		deleteFileByPath(db, filePath);
	} else {
		deleteUnreadableByPath(db, filePath);
	}
	stats.pruned++;
	spinner.clear();
	console.log(chalk.blue(`  PRUNED ${filePath}`));
}

async function recheckOne(run: RecheckRun, item: RecheckItem): Promise<boolean> {
	const { db, logPath, spinner, stats } = run;
	const filePath = item.row.current_path;

	if (!existsAsSpelled(filePath)) {
		pruneItem(run, item);
		return true;
	}

	const file = item.source === 'files' ? item.row : promoteUnreadable(run, filePath);
	if (!file) return false;

	const outcome = await verifyAndRecord({ db, fix: false, logPath, verifier: flacVerifier }, file);
	if (outcome.kind === 'interrupted') return false;

	if (outcome.kind === 'corrupt') {
		printCorruptFile(spinner, filePath, outcome);
		stats.corrupt++;
		if (outcome.known) return true;
		stats.newCorrupt++;
		if (outcome.lastHealthyAt !== null) stats.newRegressed++;
		return true;
	}

	stats.healthy++;
	spinner.clear();
	console.log(chalk.green(`  HEALTHY ${filePath}`));
	return true;
}
