import type Database from 'better-sqlite3';

import chalk from 'chalk';
import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';
import type { FormatVerifier } from '../verifiers/types.js';

import { deleteFileByPath, getFilesNeedingVerification } from '../database/queries.js';
import { logCorruption, logFixApplied, logFixDetected, logFixFailed } from '../logging/scan-log.js';
import { printCorruptFile } from './format-corrupt.js';
import { isShuttingDown, processPool } from './process-pool.js';
import { verifyAndRecord } from './verify-and-record.js';

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
	directories: string[],
	verifier: FormatVerifier,
): Promise<null | VerificationStats> {
	const filesToVerify = getFilesNeedingVerification(
		db,
		config.rescan_interval_days,
		config.batch_size,
		directories,
	);

	if (filesToVerify.length === 0) {
		console.log('No files need verification at this time.');
		return null;
	}

	const spinner = ora({
		discardStdin: false,
		text: `Verifying: 0/${String(filesToVerify.length)} files`,
	}).start();

	const stats: VerificationStats = {
		corrupt: 0,
		exitCode: 0,
		fixed: 0,
		healthy: 0,
		newCorrupt: 0,
		pruned: 0,
	};
	let verified = 0;

	await processPool(filesToVerify, config.parallelism, async (file) => {
		if (!fs.existsSync(file.current_path)) {
			deleteFileByPath(db, file.current_path);
			stats.pruned++;
			spinner.clear();
			console.log(chalk.blue(`  PRUNED ${file.current_path}`));
			verified++;
			spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
			return;
		}

		const outcome = await verifyAndRecord(db, config, verifier, file, { fix: config.fix });

		if (outcome.kind === 'interrupted') return;

		if (outcome.kind === 'healthy') {
			stats.healthy++;
		} else if (outcome.kind === 'fixed') {
			logFixApplied(config.log_path, file.current_path, outcome.label);
			spinner.clear();
			console.log(chalk.green(`  ${outcome.label}_FIXED ${file.current_path}`));
			console.log(chalk.dim(`          Stripped ${outcome.label} tags, verification passed`));
			stats.fixed++;
		} else {
			if (outcome.fix?.state === 'failed') {
				logFixFailed(config.log_path, file.current_path, outcome.fix.label, outcome.fix.error);
				spinner.clear();
				console.log(chalk.red(`  ${outcome.fix.label}_FIX_FAILED ${file.current_path}`));
				console.log(chalk.dim(`          ${outcome.fix.error}`));
			} else if (outcome.fix?.state === 'detected') {
				logFixDetected(config.log_path, file.current_path, outcome.fix.label);
				spinner.clear();
				console.log(chalk.yellow(`  ${outcome.fix.label}_DETECTED ${file.current_path}`));
				console.log(
					chalk.dim(`          Non-standard ${outcome.fix.label} tags found, use --fix to strip`),
				);
			}
			// Pre-verification row: acknowledged means this corruption was already triaged
			const isKnown = file.acknowledged_at !== null;
			logCorruption(
				config.log_path,
				outcome.severity,
				file.current_path,
				outcome.errorOutput.replaceAll('\n', ' '),
				isKnown,
			);
			printCorruptFile(spinner, file.current_path, outcome.severity, outcome, { known: isKnown });
			stats.corrupt++;
			if (!isKnown) {
				stats.newCorrupt++;
				stats.exitCode = 1;
			}
		}

		verified++;
		spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
	});

	const verifiedTotal = stats.healthy + stats.corrupt + stats.fixed + stats.pruned;
	const corruptSummary =
		stats.corrupt > 0
			? `${String(stats.corrupt)} corrupt (${String(stats.newCorrupt)} new)`
			: '0 corrupt';
	const fixedSummary = stats.fixed > 0 ? `, ${String(stats.fixed)} fixed` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';

	if (isShuttingDown()) {
		spinner.warn(
			`Verification interrupted: ${String(verifiedTotal)}/${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${corruptSummary}${fixedSummary}${prunedSummary}.`,
		);
	} else {
		spinner.succeed(
			`Verified ${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${corruptSummary}${fixedSummary}${prunedSummary}.`,
		);
	}

	return stats;
}
