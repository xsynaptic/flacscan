import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import path from 'node:path';

import type { CorruptKind, Issue } from '#database/issues.ts';
import type { FileRow } from '#database/types.ts';

import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { listIssues } from '#database/issues.ts';

type CorruptIssue = Extract<Issue, { kind: CorruptKind }>;
type UnreadableIssue = Extract<Issue, { kind: 'unreadable' }>;

type Palette = ReturnType<typeof formatReport>;

function formatReport(useColor: boolean) {
	const c = {
		bold: useColor ? chalk.bold : (s: string) => s,
		dim: useColor ? chalk.dim : (s: string) => s,
		red: useColor ? chalk.red : (s: string) => s,
	};
	return c;
}

export const reportCommand = defineCommand({
	args: {
		...sharedArguments,
		output: {
			description: 'Write report to file instead of stdout',
			type: 'string',
		},
	},
	meta: {
		description: 'Dump all current known issues',
		name: 'report',
	},
	async run({ args }) {
		await runCommand(args, {}, (db) => {
			const outputFile = args.output;
			const c = formatReport(!outputFile);

			const issues = listIssues(db);
			const corrupt = issues.filter((issue): issue is CorruptIssue => issue.kind !== 'unreadable');
			const unreadable = issues.filter(
				(issue): issue is UnreadableIssue => issue.kind === 'unreadable',
			);
			const totalIssues = issues.length;

			const lines = [c.bold('\nflacscan report\n')];
			if (totalIssues === 0) {
				lines.push('  No issues found.\n');
			} else {
				lines.push(
					`  Total issues: ${String(totalIssues)}\n`,
					...corruptSection(
						c,
						'New corrupt files',
						corrupt.filter((issue) => !issue.acknowledged),
					),
					...corruptSection(
						c,
						'Accepted corrupt files',
						corrupt.filter((issue) => issue.acknowledged),
					),
					...unreadableSection(
						c,
						'New unreadable files',
						unreadable.filter((issue) => !issue.acknowledged),
					),
					...unreadableSection(
						c,
						'Accepted unreadable files',
						unreadable.filter((issue) => issue.acknowledged),
					),
				);
			}

			const output = lines.join('\n');

			if (outputFile) {
				const outputPath = path.resolve(outputFile);
				fs.mkdirSync(path.dirname(outputPath), { recursive: true });
				fs.writeFileSync(outputPath, output + '\n');
				console.log(`Report written to ${outputPath}`);
			} else {
				console.log(output);
			}
		});
	},
});

function corruptDetails(file: FileRow): string[] {
	const details: string[] = [];
	if (file.error_timestamp) details.push(`      Glitch at: ${file.error_timestamp}`);
	if (file.last_healthy_at) details.push(`      Last healthy: ${file.last_healthy_at}`);
	if (file.last_verified_at) details.push(`      Last verified: ${file.last_verified_at}`);
	if (file.acknowledged_at) details.push(`      Accepted: ${file.acknowledged_at}`);
	if (file.recovery_result) details.push(recoveryLine(file, file.recovery_result));
	if (file.error_output) details.push(errorLine(file.error_output));
	return details;
}

function corruptSection(c: Palette, heading: string, issues: CorruptIssue[]): string[] {
	if (issues.length === 0) return [];
	return [
		c.bold(`  ${heading} (${String(issues.length)}):\n`),
		...issues.flatMap(({ kind, row }) => [
			`    ${c.red(`[${kind}]`)} ${row.current_path}`,
			...corruptDetails(row),
			'',
		]),
	];
}

function errorLine(errorOutput: string): string {
	return `      Error: ${errorOutput.replaceAll('\n', '\n             ')}`;
}

function recoveryLine(file: FileRow, result: string): string {
	const lost =
		file.recovery_lost_samples === null
			? ''
			: ` (${String(file.recovery_lost_samples)} samples lost off the end)`;
	const why = file.recovery_detail ? ` - ${file.recovery_detail}` : '';
	return `      Recovery: ${result}${lost}${why}`;
}

function unreadableSection(c: Palette, heading: string, issues: UnreadableIssue[]): string[] {
	if (issues.length === 0) return [];
	return [
		c.bold(`  ${heading} (${String(issues.length)}):\n`),
		...issues.flatMap(({ row }) => [
			`    ${c.red('[unreadable]')} ${row.current_path}`,
			...(row.acknowledged_at ? [`      Accepted: ${row.acknowledged_at}`] : []),
			errorLine(row.error_output),
			'',
		]),
	];
}
