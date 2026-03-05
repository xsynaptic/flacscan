import type Database from 'better-sqlite3';

import chalk from 'chalk';
import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';
import type { FormatVerifier } from '../verifiers/types.js';

import {
	deleteFileByPath,
	getFilesNeedingVerification,
	updateMetadata,
	updateVerificationResult,
	upsertFile,
} from '../database/queries.js';
import { logCorruption, logFixApplied, logFixDetected, logFixFailed } from '../logging/scan-log.js';
import { extractMetadata } from '../metadata.js';
import { printCorruptFile } from './format-corrupt.js';
import { isShuttingDown, processPool } from './process-pool.js';

interface VerificationStats {
	corrupt: number;
	exitCode: number;
	fixed: number;
	healthy: number;
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
		pruned: 0,
	};
	let verified = 0;

	const fixer = verifier.fixer;

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

		try {
			const result = await verifier.verify(file.current_path);

			if (result.status === 'interrupted') {
				return;
			}

			if (result.status === 'healthy') {
				updateVerificationResult(db, file.current_path, { last_result: 'healthy' });
				stats.healthy++;
			} else {
				const fixDetected = fixer?.detect(result.errorOutput);

				if (fixDetected && fixer && config.fix) {
					const fixResult = await fixer.fix(file.current_path);
					if (fixResult.ok) {
						const recheck = await verifier.verify(file.current_path);
						if (recheck.status === 'healthy') {
							// Update mtime/size after in-place modification
							const stat = fs.statSync(file.current_path);
							upsertFile(db, {
								current_path: file.current_path,
								file_mtime: stat.mtime.toISOString(),
								file_size: stat.size,
							});
							updateVerificationResult(db, file.current_path, { last_result: 'healthy' });
							logFixApplied(config.log_path, file.current_path, fixer.label);
							stats.fixed++;
							spinner.clear();
							console.log(chalk.green(`  ${fixer.label}_FIXED ${file.current_path}`));
							console.log(chalk.dim(`          Stripped ${fixer.label} tags, verification passed`));
							verified++;
							spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
							return;
						}
						// Still corrupt after stripping — fall through to log as corrupt
					} else {
						logFixFailed(
							config.log_path,
							file.current_path,
							fixer.label,
							fixResult.error ?? 'unknown',
						);
						spinner.clear();
						console.log(chalk.red(`  ${fixer.label}_FIX_FAILED ${file.current_path}`));
						console.log(chalk.dim(`          ${fixResult.error ?? 'unknown'}`));
					}
				} else if (fixDetected && fixer) {
					logFixDetected(config.log_path, file.current_path, fixer.label);
					spinner.clear();
					console.log(chalk.yellow(`  ${fixer.label}_DETECTED ${file.current_path}`));
					console.log(
						chalk.dim(`          Non-standard ${fixer.label} tags found, use --fix to strip`),
					);
				}

				updateVerificationResult(db, file.current_path, {
					error_output: result.errorOutput,
					error_severity: result.severity,
					error_timestamp: result.errorTimestamp,
					last_result: 'corrupt',
				});

				const metadata = await extractMetadata(file.current_path);
				if (metadata) {
					updateMetadata(db, file.current_path, metadata);
				}

				logCorruption(
					config.log_path,
					result.severity,
					file.current_path,
					result.errorOutput.replaceAll('\n', ' '),
				);

				printCorruptFile(spinner, file.current_path, result);

				stats.corrupt++;
				stats.exitCode = 1;
			}
		} catch (error) {
			if (isShuttingDown()) {
				return;
			}

			updateVerificationResult(db, file.current_path, {
				error_output: String(error),
				error_severity: 'unknown',
				last_result: 'corrupt',
			});
			stats.corrupt++;
			stats.exitCode = 1;
		}

		verified++;
		spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
	});

	const verifiedTotal = stats.healthy + stats.corrupt + stats.fixed + stats.pruned;
	const fixedSummary = stats.fixed > 0 ? `, ${String(stats.fixed)} fixed` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';

	if (isShuttingDown()) {
		spinner.warn(
			`Verification interrupted: ${String(verifiedTotal)}/${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt${fixedSummary}${prunedSummary}.`,
		);
	} else {
		spinner.succeed(
			`Verified ${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt${fixedSummary}${prunedSummary}.`,
		);
	}

	return stats;
}
