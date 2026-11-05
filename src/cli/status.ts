import chalk from 'chalk';
import { defineCommand } from 'citty';

import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { getStats } from '#database/queries.ts';
import { checkMountedPaths } from '#discovery.ts';

const plain = (value: string) => value;

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

			const corruptColor = stats.newCorrupt > 0 ? chalk.red : plain;
			const unreadableColor = stats.newUnreadable > 0 ? chalk.red : plain;

			console.log(`  Total files:      ${chalk.bold(String(stats.total))}`);
			console.log(`  Healthy:          ${chalk.green(String(stats.healthy))}`);
			console.log(
				`  Corrupt:          ${corruptColor(String(stats.corrupt))} (${String(stats.newCorrupt)} new, ${String(stats.corrupt - stats.newCorrupt)} accepted)`,
			);
			console.log(`  Pending:          ${String(stats.pending)}`);
			console.log(
				`  Unreadable:       ${unreadableColor(String(stats.unreadable))} (${String(stats.newUnreadable)} new, ${String(stats.unreadable - stats.newUnreadable)} accepted)`,
			);

			const totalIssues = stats.corrupt + stats.unreadable;
			if (stats.newCorrupt + stats.newUnreadable === 0 && totalIssues > 0) {
				console.log(chalk.green('  No new issues.'));
			}

			if (stats.recoveryBreakdown.some((row) => row.recovery_result !== null)) {
				console.log(chalk.bold('\n  Recovery:'));
				for (const row of stats.recoveryBreakdown) {
					const label = row.recovery_result ?? 'not yet attempted';
					let color = chalk.dim;
					if (row.recovery_result === 'recovered') color = chalk.green;
					else if (row.recovery_result === 'unsuitable') color = chalk.yellow;
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
