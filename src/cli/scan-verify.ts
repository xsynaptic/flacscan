import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import ora from 'ora';

import type { VerifyOutcome } from '#cli/verify-and-record.ts';
import type { FlacScanConfig } from '#config/types.ts';
import type { FileRow } from '#database/types.ts';
import type { FormatVerifier } from '#verifiers/types.ts';

import { printCorruptFile } from '#cli/format-corrupt.ts';
import { isShuttingDown, processPool } from '#cli/process-pool.ts';
import { verifyAndRecord } from '#cli/verify-and-record.ts';
import { deleteFileByPath, getFilesNeedingVerification } from '#database/queries.ts';
import { logCorruption, logFixApplied, logFixDetected, logFixFailed } from '#logging/scan-log.ts';
import { existsAsSpelled } from '#paths.ts';

type CorruptOutcome = Extract<VerifyOutcome, { kind: 'corrupt' }>;

interface VerificationRun {
	config: FlacScanConfig;
	db: Database.Database;
	spinner: Ora;
	stats: VerificationStats;
	verifier: FormatVerifier;
}

interface VerificationScope {
	directories: string[];
	verifier: FormatVerifier;
}

interface VerificationStats {
	corrupt: number;
	exitCode: number;
	fixed: number;
	healthy: number;
	newCorrupt: number;
	pruned: number;
}

export async function runVerification(
	db: Database.Database,
	config: FlacScanConfig,
	{ directories, verifier }: VerificationScope,
): Promise<null | VerificationStats> {
	const filesToVerify = getFilesNeedingVerification(db, directories, config);

	if (filesToVerify.length === 0) {
		console.log('No files need verification at this time.');
		return null;
	}

	const run: VerificationRun = {
		config,
		db,
		spinner: ora({
			discardStdin: false,
			text: `Verifying: 0/${String(filesToVerify.length)} files`,
		}).start(),
		stats: { corrupt: 0, exitCode: 0, fixed: 0, healthy: 0, newCorrupt: 0, pruned: 0 },
		verifier,
	};
	let verified = 0;

	await processPool(filesToVerify, config.parallelism, async (file) => {
		if (!(await verifyOne(run, file))) return;
		verified++;
		run.spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
	});

	finishSpinner(run, filesToVerify.length);
	return run.stats;
}

function finishSpinner({ spinner, stats }: VerificationRun, total: number) {
	const verifiedTotal = stats.healthy + stats.corrupt + stats.fixed + stats.pruned;
	const corruptSummary =
		stats.corrupt > 0
			? `${String(stats.corrupt)} corrupt (${String(stats.newCorrupt)} new)`
			: '0 corrupt';
	const fixedSummary = stats.fixed > 0 ? `, ${String(stats.fixed)} fixed` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';
	const counts = `${String(stats.healthy)} healthy, ${corruptSummary}${fixedSummary}${prunedSummary}.`;

	if (isShuttingDown()) {
		spinner.warn(
			`Verification interrupted: ${String(verifiedTotal)}/${String(total)} files. ${counts}`,
		);
		return;
	}
	spinner.succeed(`Verified ${String(total)} files. ${counts}`);
}

function reportCorrupt(run: VerificationRun, file: FileRow, outcome: CorruptOutcome) {
	const { config, spinner, stats } = run;
	if (outcome.fix) reportFixAnnotation(run, file.current_path, outcome.fix);
	// Pre-verification row: acknowledged means this corruption was already triaged
	const isKnown = file.acknowledged_at !== null;
	logCorruption(config.log_path, file.current_path, {
		details: outcome.errorOutput.replaceAll('\n', ' '),
		known: isKnown,
	});
	printCorruptFile(spinner, file.current_path, { ...outcome, known: isKnown });
	stats.corrupt++;
	if (isKnown) return;
	stats.newCorrupt++;
	stats.exitCode = 1;
}

function reportFixAnnotation(
	{ config, spinner }: VerificationRun,
	filePath: string,
	fix: NonNullable<CorruptOutcome['fix']>,
) {
	spinner.clear();
	if (fix.state === 'failed') {
		logFixFailed(config.log_path, filePath, { error: fix.error, label: fix.label });
		console.log(chalk.red(`  ${fix.label}_FIX_FAILED ${filePath}`));
		console.log(chalk.dim(`          ${fix.error}`));
		return;
	}
	logFixDetected(config.log_path, filePath, fix.label);
	console.log(chalk.yellow(`  ${fix.label}_DETECTED ${filePath}`));
	console.log(chalk.dim(`          Non-standard ${fix.label} tags found, use --fix to strip`));
}

function reportFixed({ config, spinner, stats }: VerificationRun, filePath: string, label: string) {
	logFixApplied(config.log_path, filePath, label);
	spinner.clear();
	console.log(chalk.green(`  ${label}_FIXED ${filePath}`));
	console.log(chalk.dim(`          Stripped ${label} tags, verification passed`));
	stats.fixed++;
}

async function verifyOne(run: VerificationRun, file: FileRow): Promise<boolean> {
	const { config, db, spinner, stats, verifier } = run;
	if (!existsAsSpelled(file.current_path)) {
		deleteFileByPath(db, file.current_path);
		stats.pruned++;
		spinner.clear();
		console.log(chalk.blue(`  PRUNED ${file.current_path}`));
		return true;
	}

	const outcome = await verifyAndRecord({ db, fix: config.fix, verifier }, file);
	if (outcome.kind === 'interrupted') return false;

	if (outcome.kind === 'healthy') stats.healthy++;
	else if (outcome.kind === 'fixed') reportFixed(run, file.current_path, outcome.label);
	else reportCorrupt(run, file, outcome);
	return true;
}
