import chalk from 'chalk';
import { defineCommand } from 'citty';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { getStats } from '../database/queries.js';
import { checkMountedPaths } from '../discovery.js';
import { FlacScanError } from './errors.js';
import { sharedArguments } from './shared-arguments.js';

export const statusCommand = defineCommand({
	args: {
		...sharedArguments,
	},
	meta: {
		description: 'Display database statistics',
		name: 'status',
	},
	run({ args }) {
		try {
			const config = loadConfig(args);
			const db = openDatabase(config.db_path);

			try {
				const stats = getStats(db);
				const mountCheck = checkMountedPaths(config.directories);

				console.log(chalk.bold('\nflacscan status\n'));

				console.log(`  Total files:      ${chalk.bold(String(stats.total))}`);
				console.log(`  Healthy:          ${chalk.green(String(stats.healthy))}`);
				console.log(
					`  Corrupt:          ${stats.corrupt > 0 ? chalk.red(String(stats.corrupt)) : String(stats.corrupt)}`,
				);
				console.log(`  Pending:          ${String(stats.pending)}`);
				console.log(
					`  Unreadable:       ${stats.unreadable > 0 ? chalk.red(String(stats.unreadable)) : String(stats.unreadable)}`,
				);

				if (stats.severityBreakdown.length > 0) {
					console.log(chalk.bold('\n  Corruption by severity:'));
					for (const row of stats.severityBreakdown) {
						const severity = row.error_severity ?? 'unknown';
						const color =
							severity === 'critical'
								? chalk.red
								: severity === 'recoverable'
									? chalk.yellow
									: chalk.dim;
						console.log(`    ${color(severity)}: ${String(row.count)}`);
					}
				}

				console.log(chalk.bold('\n  Configured paths:'));
				for (const dir of mountCheck.available) {
					console.log(`    ${chalk.green('mounted')}  ${dir}`);
				}
				for (const dir of mountCheck.skipped) {
					console.log(`    ${chalk.red('missing')}  ${dir}`);
				}

				console.log();
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
