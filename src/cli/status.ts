import chalk from 'chalk';
import { defineCommand } from 'citty';

import type { IssueCounts } from '#database/issues.ts';

import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { countIssues, listIssues } from '#database/issues.ts';
import { getStats } from '#database/queries.ts';
import { checkMountedPaths } from '#discovery.ts';

type Stats = ReturnType<typeof getStats>;

const plain = (value: string) => value;

const recoveryColors: Record<string, (value: string) => string> = {
	recovered: chalk.green,
	unsuitable: chalk.yellow,
};

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
			const counts = countIssues(listIssues(db));
			const mountCheck = checkMountedPaths(config.directories);

			console.log(chalk.bold('\nflacscan status\n'));
			printCounts(stats, counts);
			printRecovery(stats.recoveryBreakdown);

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

function printCounts(stats: Stats, counts: IssueCounts) {
	const corruptColor = counts.newCorrupt > 0 ? chalk.red : plain;
	const regressedColor = counts.newRegressed > 0 ? chalk.red : plain;
	const unreadableColor = counts.newUnreadable > 0 ? chalk.red : plain;

	console.log(`  Total files:      ${chalk.bold(String(stats.total))}`);
	console.log(`  Healthy:          ${chalk.green(String(stats.healthy))}`);
	console.log(
		`  Corrupt:          ${corruptColor(String(counts.corrupt))} (${String(counts.newCorrupt)} new, ${String(counts.corrupt - counts.newCorrupt)} accepted)`,
	);
	if (counts.regressed > 0) {
		console.log(
			`  Regressed:        ${regressedColor(String(counts.regressed))} (${String(counts.newRegressed)} new, ${String(counts.regressed - counts.newRegressed)} accepted)`,
		);
	}
	console.log(`  Pending:          ${String(stats.pending)}`);
	console.log(
		`  Unreadable:       ${unreadableColor(String(counts.unreadable))} (${String(counts.newUnreadable)} new, ${String(counts.unreadable - counts.newUnreadable)} accepted)`,
	);

	const totalIssues = counts.corrupt + counts.unreadable;
	if (counts.newCorrupt + counts.newUnreadable === 0 && totalIssues > 0) {
		console.log(chalk.green('  No new issues.'));
	}
}

function printRecovery(breakdown: Stats['recoveryBreakdown']) {
	if (breakdown.every((row) => row.recovery_result === null)) return;
	console.log(chalk.bold('\n  Recovery:'));
	for (const row of breakdown) {
		const label = row.recovery_result ?? 'not yet attempted';
		const color = (row.recovery_result && recoveryColors[row.recovery_result]) ?? chalk.dim;
		console.log(`    ${color(label)}: ${String(row.count)}`);
	}
}
