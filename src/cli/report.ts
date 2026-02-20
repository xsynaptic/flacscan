import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { getAllUnreadableFiles, getCorruptFiles } from '../database/queries.js';
import { FlacScanError } from './errors.js';
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
	run({ args }) {
		try {
			const config = loadConfig(args);
			const db = openDatabase(config.db_path);

			try {
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

				if (totalIssues === 0) {
					write('  No issues found.\n');
				} else {
					write(`  Total issues: ${String(totalIssues)}\n`);

					if (corrupt.length > 0) {
						write(c.bold(`  Corrupt files (${String(corrupt.length)}):\n`));
						for (const file of corrupt) {
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
							if (file.error_output) {
								write(`      Error: ${file.error_output.replaceAll('\n', '\n             ')}`);
							}
							write('');
						}
					}

					if (unreadable.length > 0) {
						write(c.bold(`  Unreadable files (${String(unreadable.length)}):\n`));
						for (const file of unreadable) {
							write(`    ${c.red('[unreadable]')} ${file.current_path}`);
							write(`      Error: ${file.error_output.replaceAll('\n', '\n             ')}`);
							write('');
						}
					}
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
