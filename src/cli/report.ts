import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import path from 'node:path';

import type { FileRow, UnreadableFileRow } from '../database/types.js';

import { getAllUnreadableFiles, getCorruptFiles } from '../database/queries.js';
import { runCommand } from './run-command.js';
import { sharedArguments } from './shared-arguments.js';

function formatReport(useColor: boolean) {
	const c = {
		bold: useColor ? chalk.bold : (s: string) => s,
		dim: useColor ? chalk.dim : (s: string) => s,
		red: useColor ? chalk.red : (s: string) => s,
		yellow: useColor ? chalk.yellow : (s: string) => s,
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
			const useColor = !outputFile;
			const c = formatReport(useColor);

			const lines: string[] = [];
			function write(line: string) {
				lines.push(line);
			}

			const corrupt = getCorruptFiles(db);
			const unreadable = getAllUnreadableFiles(db);

			const totalIssues = corrupt.length + unreadable.length;

			write(c.bold('\nflacscan report\n'));

			function writeCorruptSection(heading: string, files: FileRow[]) {
				if (files.length === 0) return;
				write(c.bold(`  ${heading} (${String(files.length)}):\n`));
				for (const file of files) {
					const severity = file.error_severity ?? 'unknown';
					const severityColor =
						severity === 'critical' ? c.red : severity === 'recoverable' ? c.yellow : c.dim;
					write(`    ${severityColor(`[${severity}]`)} ${file.current_path}`);
					if (file.error_timestamp) {
						write(`      Glitch at: ${file.error_timestamp}`);
					}
					if (file.last_verified_at) {
						write(`      Last verified: ${file.last_verified_at}`);
					}
					if (file.acknowledged_at) {
						write(`      Accepted: ${file.acknowledged_at}`);
					}
					if (file.recovery_result) {
						const lost =
							file.recovery_lost_samples === null
								? ''
								: ` (${String(file.recovery_lost_samples)} samples lost off the end)`;
						const why = file.recovery_detail ? ` - ${file.recovery_detail}` : '';
						write(`      Recovery: ${file.recovery_result}${lost}${why}`);
					}
					if (file.error_output) {
						write(`      Error: ${file.error_output.replaceAll('\n', '\n             ')}`);
					}
					write('');
				}
			}

			function writeUnreadableSection(heading: string, files: UnreadableFileRow[]) {
				if (files.length === 0) return;
				write(c.bold(`  ${heading} (${String(files.length)}):\n`));
				for (const file of files) {
					write(`    ${c.red('[unreadable]')} ${file.current_path}`);
					if (file.acknowledged_at) {
						write(`      Accepted: ${file.acknowledged_at}`);
					}
					write(`      Error: ${file.error_output.replaceAll('\n', '\n             ')}`);
					write('');
				}
			}

			if (totalIssues === 0) {
				write('  No issues found.\n');
			} else {
				write(`  Total issues: ${String(totalIssues)}\n`);

				writeCorruptSection(
					'New corrupt files',
					corrupt.filter((file) => file.acknowledged_at === null),
				);
				writeCorruptSection(
					'Accepted corrupt files',
					corrupt.filter((file) => file.acknowledged_at !== null),
				);
				writeUnreadableSection(
					'New unreadable files',
					unreadable.filter((file) => file.acknowledged_at === null),
				);
				writeUnreadableSection(
					'Accepted unreadable files',
					unreadable.filter((file) => file.acknowledged_at !== null),
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
