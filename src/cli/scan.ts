import type { Ora } from 'ora';

import { defineCommand } from 'citty';
import ora from 'ora';

import { runCommand } from '#cli/run-command.ts';
import { runDiscovery } from '#cli/scan-discover.ts';
import { runVerification } from '#cli/scan-verify.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { discoverFiles } from '#discovery.ts';
import { logScanComplete, logScanStart } from '#logging/scan-log.ts';
import { sendNotification } from '#notify.ts';
import { ensureBinary } from '#shell.ts';
import { emptyPassStats } from '#verification/verification-pass.ts';
import { flacVerifier } from '#verifiers/flac/verify.ts';

function reportWalk(spinner: Ora, walk: Awaited<ReturnType<typeof discoverFiles>>) {
	const { files, incomplete, mountCheck } = walk;
	if (mountCheck.available.length === 0) {
		spinner.warn(`No configured paths are available; skipped: ${mountCheck.skipped.join(', ')}`);
	} else {
		spinner.succeed(
			`Found ${String(files.length)} FLAC files across ${String(mountCheck.available.length)} path(s)`,
		);
	}
	for (const { directory, error } of incomplete) {
		console.warn(`Warning: could not walk ${directory} (${error}); its rows are left as they are`);
	}
}

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
		notify: {
			description: 'Send a macOS notification when new corruption is found',
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
		await runCommand(
			args,
			{
				exclusive: true,
				interruptible: true,
				async prepare(config) {
					for (const bin of flacVerifier.requiredBinaries) {
						await ensureBinary(bin.name, bin.hint);
					}
					if (config.fix && flacVerifier.fixer) {
						for (const bin of flacVerifier.fixer.requiredBinaries) {
							await ensureBinary(bin.name, bin.hint);
						}
					}
				},
			},
			async (db, config, signal) => {
				const walkSpinner = ora({ discardStdin: false, text: 'Scanning directories...' }).start();
				const walk = await discoverFiles(config.directories, flacVerifier.extensions);
				reportWalk(walkSpinner, walk);
				const { mountCheck } = walk;

				logScanStart(config.log_path, {
					available: mountCheck.available.length,
					skipped: mountCheck.skipped,
					total: config.directories.length,
				});

				const discoveryStats = await runDiscovery({ config, db, signal }, walk);

				if (signal.aborted) {
					return;
				}

				const verification = (await runVerification(db, config, {
					directories: mountCheck.available,
					signal,
					verifier: flacVerifier,
				})) ?? { exitCode: 0, stats: emptyPassStats() };
				const verificationStats = verification.stats;

				const pruned = discoveryStats.pruned + verificationStats.pruned;
				logScanComplete(config.log_path, {
					corrupt: verificationStats.corrupt,
					healthy: verificationStats.healthy,
					newCorrupt: verificationStats.newCorrupt,
					newRegressed: verificationStats.newRegressed,
					pruned,
					total:
						verificationStats.healthy +
						verificationStats.corrupt +
						verificationStats.fixed +
						pruned,
				});

				if (config.notify && verificationStats.newCorrupt > 0) {
					const regressed =
						verificationStats.newRegressed > 0
							? ` (${String(verificationStats.newRegressed)} regressed)`
							: '';
					await sendNotification(
						'flacscan',
						`${String(verificationStats.newCorrupt)} new corrupt file(s) found${regressed}. Run "flacscan report" for details.`,
					);
				}

				process.exitCode = verification.exitCode;
			},
		);
	},
});
