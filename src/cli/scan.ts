import { defineCommand } from 'citty';
import ora from 'ora';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { discoverFiles } from '../discovery.js';
import { logScanComplete, logScanStart } from '../logging/scan-log.js';
import { ensureBinary } from '../shell.js';
import { flacVerifier } from '../verifiers/flac/verify.js';
import { FlacScanError } from './errors.js';
import { installShutdownHandler, isShuttingDown } from './process-pool.js';
import { runDiscovery } from './scan-discover.js';
import { runVerification } from './scan-verify.js';
import { sharedArguments } from './shared-arguments.js';

export const scanCommand = defineCommand({
	args: {
		...sharedArguments,
		'batch-size': {
			description: 'Number of files to verify per invocation',
			type: 'string',
		},
		directory: {
			description: 'Directory to scan for FLAC files',
			type: 'string',
		},
		fix: {
			description: 'Fix issues where possible (ID3 tag stripping)',
			type: 'boolean',
		},
		parallelism: {
			description: 'Maximum concurrent flac -t processes',
			type: 'string',
		},
		'rescan-days': {
			description: 'Re-verify files older than this many days',
			type: 'string',
		},
	},
	meta: {
		description: 'Run one batch of FLAC integrity verification',
		name: 'scan',
	},
	async run({ args }) {
		try {
			installShutdownHandler();
			const config = loadConfig(args);
			for (const bin of flacVerifier.requiredBinaries) {
				await ensureBinary(bin.name, bin.hint);
			}
			if (config.fix && flacVerifier.fixer) {
				for (const bin of flacVerifier.fixer.requiredBinaries) {
					await ensureBinary(bin.name, bin.hint);
				}
			}

			const db = openDatabase(config.db_path);

			try {
				// File walk
				const walkSpinner = ora({ discardStdin: false, text: 'Scanning directories...' }).start();
				const { files, mountCheck } = await discoverFiles(config.directories, flacVerifier.extensions);
				walkSpinner.succeed(
					`Found ${String(files.length)} FLAC files across ${String(mountCheck.available.length)} path(s)`,
				);

				logScanStart(
					config.log_path,
					mountCheck.available.length,
					config.directories.length,
					mountCheck.skipped,
				);

				// Discovery phase
				await runDiscovery(db, files, config);

				if (isShuttingDown()) {
					return;
				}

				// Verification phase
				const verificationStats = await runVerification(db, config, mountCheck.available, flacVerifier);

				logScanComplete(config.log_path, {
					corrupt: verificationStats?.corrupt ?? 0,
					healthy: verificationStats?.healthy ?? 0,
					pruned: verificationStats?.pruned ?? 0,
					total: verificationStats
						? verificationStats.healthy + verificationStats.corrupt + verificationStats.fixed + verificationStats.pruned
						: 0,
				});

				process.exitCode = verificationStats?.exitCode ?? 0;
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
