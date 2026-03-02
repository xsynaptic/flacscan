import type Database from 'better-sqlite3';

import chalk from 'chalk';
import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';

import {
	deleteFileByPath,
	getFilesNeedingVerification,
	updateVerificationResult,
	upsertFile,
} from '../database/queries.js';
import { hasId3Tags, stripId3Tags } from '../flac/fix-id3.js';
import { verifyFile } from '../flac/verify.js';
import { logCorruption, logId3Detected, logId3Fixed, logId3FixFailed } from '../logging/scan-log.js';
import { printCorruptFile } from './format-corrupt.js';
import { isShuttingDown, processPool } from './process-pool.js';

interface VerificationStats {
	corrupt: number;
	exitCode: number;
	healthy: number;
	id3Fixed: number;
	pruned: number;
}

export async function runVerification(
	db: Database.Database,
	config: FlacScanConfig,
	directories: string[],
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
		healthy: 0,
		id3Fixed: 0,
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

		try {
			const result = await verifyFile(file.current_path);

			if (result.status === 'interrupted') {
				return;
			}

			if (result.status === 'healthy') {
				updateVerificationResult(db, file.current_path, { last_result: 'healthy' });
				stats.healthy++;
			} else {
				const id3Detected = hasId3Tags(result.errorOutput);

				if (id3Detected && config.fix) {
					const stripResult = await stripId3Tags(file.current_path);
					if (stripResult.ok) {
						const recheck = await verifyFile(file.current_path);
						if (recheck.status === 'healthy') {
							// Update mtime/size after in-place modification
							const stat = fs.statSync(file.current_path);
							upsertFile(db, {
								current_path: file.current_path,
								file_mtime: stat.mtime.toISOString(),
								file_size: stat.size,
							});
							updateVerificationResult(db, file.current_path, { last_result: 'healthy' });
							logId3Fixed(config.log_path, file.current_path);
							stats.id3Fixed++;
							spinner.clear();
							console.log(chalk.green(`  ID3_FIXED ${file.current_path}`));
							console.log(chalk.dim(`          Stripped ID3 tags, verification passed`));
							verified++;
							spinner.text = `Verifying: ${String(verified)}/${String(filesToVerify.length)} files`;
							return;
						}
						// Still corrupt after stripping — fall through to log as corrupt
					} else {
						logId3FixFailed(config.log_path, file.current_path, stripResult.error ?? 'unknown');
						spinner.clear();
						console.log(chalk.red(`  ID3_FIX_FAILED ${file.current_path}`));
						console.log(chalk.dim(`          ${stripResult.error ?? 'unknown'}`));
					}
				} else if (id3Detected) {
					logId3Detected(config.log_path, file.current_path);
					spinner.clear();
					console.log(chalk.yellow(`  ID3_DETECTED ${file.current_path}`));
					console.log(chalk.dim(`          Non-standard ID3 tags found, use --fix to strip`));
				}

				updateVerificationResult(db, file.current_path, {
					error_output: result.errorOutput,
					error_severity: result.severity,
					error_timestamp: result.errorTimestamp,
					last_result: 'corrupt',
				});

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

	const verifiedTotal = stats.healthy + stats.corrupt + stats.id3Fixed + stats.pruned;
	const id3Summary = stats.id3Fixed > 0 ? `, ${String(stats.id3Fixed)} ID3 fixed` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';

	if (isShuttingDown()) {
		spinner.warn(
			`Verification interrupted: ${String(verifiedTotal)}/${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt${id3Summary}${prunedSummary}.`,
		);
	} else {
		spinner.succeed(
			`Verified ${String(filesToVerify.length)} files. ${String(stats.healthy)} healthy, ${String(stats.corrupt)} corrupt${id3Summary}${prunedSummary}.`,
		);
	}

	return stats;
}
