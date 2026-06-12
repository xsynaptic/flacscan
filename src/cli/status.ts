import chalk from 'chalk';
import { defineCommand } from 'citty';

import { getStats } from '../database/queries.js';
import { checkMountedPaths } from '../discovery.js';
import { runCommand } from './run-command.js';
import { sharedArguments } from './shared-arguments.js';

export const statusCommand = defineCommand({
	args: {
		...sharedArguments,
	},
	meta: {
		description: 'Display database statistics',
		name: 'status',
	},
	async run({ args }) {
		await runCommand(args, {}, (db, config) => {
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

			if (stats.recoveryBreakdown.some((row) => row.recovery_result !== null)) {
				console.log(chalk.bold('\n  Recovery:'));
				for (const row of stats.recoveryBreakdown) {
					const label = row.recovery_result ?? 'not yet attempted';
					const color =
						row.recovery_result === 'recovered'
							? chalk.green
							: row.recovery_result === 'unsuitable'
								? chalk.yellow
								: chalk.dim;
					console.log(`    ${color(label)}: ${String(row.count)}`);
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
		});
	},
});
