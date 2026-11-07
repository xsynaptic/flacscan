import type { Ora } from 'ora';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import ora from 'ora';

import type { PassOutcome } from '#verification/verification-pass.ts';

import { corruptSummary, printCorruptFile } from '#cli/format-corrupt.ts';
import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { listIssues } from '#database/issues.ts';
import { checkMountedPaths } from '#discovery.ts';
import { directoryPrefix } from '#paths.ts';
import { ensureBinary } from '#shell.ts';
import { runVerificationPass } from '#verification/verification-pass.ts';
import { flacVerifier } from '#verifiers/flac/verify.ts';

export const recheckCommand = defineCommand({
	args: {
		...sharedArguments,
	},
	meta: {
		description: 'Re-verify all known bad files and prune deleted entries',
		name: 'recheck',
	},
	async run({ args }) {
		await runCommand(
			args,
			{
				exclusive: true,
				interruptible: true,
				async prepare() {
					for (const bin of flacVerifier.requiredBinaries) {
						await ensureBinary(bin.name, bin.hint);
					}
				},
			},
			async (db, config, signal) => {
				const prefixes = checkMountedPaths(config.directories).available.map((directory) =>
					directoryPrefix(directory),
				);
				const paths = [...new Set(listIssues(db).map((issue) => issue.row.current_path))].filter(
					(filePath) => prefixes.some((prefix) => filePath.startsWith(prefix)),
				);

				if (paths.length === 0) {
					console.log('No files to recheck.');
					return;
				}

				const spinner = ora({
					discardStdin: false,
					text: `Rechecking: 0/${String(paths.length)} files`,
				}).start();
				let processed = 0;

				const { exitCode, stats } = await runVerificationPass(
					{
						db,
						fix: false,
						logPath: config.log_path,
						parallelism: config.parallelism,
						signal,
						verifier: flacVerifier,
					},
					paths,
					(filePath, outcome) => {
						printOutcome(spinner, filePath, outcome);
						processed++;
						spinner.text = `Rechecking: ${String(processed)}/${String(paths.length)} files`;
					},
				);

				const total = stats.healthy + stats.corrupt + stats.pruned;
				const counts = `${String(stats.healthy)} healthy, ${corruptSummary(stats)}, ${String(stats.pruned)} pruned.`;

				if (signal.aborted) {
					spinner.warn(
						`Recheck interrupted: ${String(total)}/${String(paths.length)} files. ${counts}`,
					);
				} else {
					spinner.succeed(`Rechecked ${String(total)} files. ${counts}`);
				}

				process.exitCode = exitCode;
			},
		);
	},
});

function printOutcome(spinner: Ora, filePath: string, outcome: PassOutcome) {
	if (outcome.kind === 'pruned') {
		spinner.clear();
		console.log(chalk.blue(`  PRUNED ${filePath}`));
		return;
	}
	if (outcome.kind === 'corrupt') {
		printCorruptFile(spinner, filePath, outcome);
		return;
	}
	if (outcome.kind !== 'healthy') {
		return;
	}

	spinner.clear();
	console.log(chalk.green(`  HEALTHY ${filePath}`));
}
