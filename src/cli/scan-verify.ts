import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import ora from 'ora';

import type { FlacScanConfig } from '#config/types.ts';
import type { StopSignal } from '#process-pool.ts';
import type { PassOutcome, PassStats } from '#verification/verification-pass.ts';
import type { FormatVerifier } from '#verifiers/types.ts';

import { corruptSummary, printCorruptFile } from '#cli/format-corrupt.ts';
import { getFilesNeedingVerification } from '#database/queries.ts';
import { runVerificationPass } from '#verification/verification-pass.ts';

interface VerificationScope {
	directories: string[];
	signal: StopSignal;
	verifier: FormatVerifier;
}

export async function runVerification(
	db: Database.Database,
	config: FlacScanConfig,
	{ directories, signal, verifier }: VerificationScope,
): Promise<null | { exitCode: 0 | 1; stats: PassStats }> {
	const filesToVerify = getFilesNeedingVerification(db, directories, config);

	if (filesToVerify.length === 0) {
		console.log('No files need verification at this time.');
		return null;
	}

	const total = filesToVerify.length;
	const spinner = ora({ discardStdin: false, text: `Verifying: 0/${String(total)} files` }).start();
	let verified = 0;

	const result = await runVerificationPass(
		{
			db,
			fix: config.fix,
			logPath: config.log_path,
			parallelism: config.parallelism,
			signal,
			verifier,
		},
		filesToVerify.map((file) => file.current_path),
		(filePath, outcome) => {
			printOutcome(spinner, filePath, outcome);
			verified++;
			spinner.text = `Verifying: ${String(verified)}/${String(total)} files`;
		},
	);

	finishSpinner({ signal, spinner, total }, result.stats);
	return result;
}

function finishSpinner(
	{ signal, spinner, total }: { signal: StopSignal; spinner: Ora; total: number },
	stats: PassStats,
) {
	const verifiedTotal = stats.healthy + stats.corrupt + stats.fixed + stats.pruned;
	const fixedSummary = stats.fixed > 0 ? `, ${String(stats.fixed)} fixed` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';
	const counts = `${String(stats.healthy)} healthy, ${corruptSummary(stats)}${fixedSummary}${prunedSummary}.`;

	if (signal.aborted) {
		spinner.warn(
			`Verification interrupted: ${String(verifiedTotal)}/${String(total)} files. ${counts}`,
		);
		return;
	}
	spinner.succeed(`Verified ${String(total)} files. ${counts}`);
}

function printOutcome(spinner: Ora, filePath: string, outcome: PassOutcome) {
	if (outcome.kind === 'pruned') {
		spinner.clear();
		console.log(chalk.blue(`  PRUNED ${filePath}`));
		return;
	}
	if (outcome.kind === 'fixed') {
		spinner.clear();
		console.log(chalk.green(`  ${outcome.label}_FIXED ${filePath}`));
		console.log(chalk.dim(`          Stripped ${outcome.label} tags, verification passed`));
		return;
	}
	if (outcome.kind === 'corrupt') printCorruptFile(spinner, filePath, outcome);
}
