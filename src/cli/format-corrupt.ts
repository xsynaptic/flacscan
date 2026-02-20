import chalk from 'chalk';

import type { ErrorSeverity } from '../flac/types.js';

const ERROR_CODE_PATTERN = /error code \d+:(\S+)/;

export function printCorruptFile(
	spinner: { clear(): void },
	filePath: string,
	result: { errorOutput: string; errorTimestamp: null | string; severity: ErrorSeverity },
): void {
	const severityColor = result.severity === 'recoverable' ? chalk.yellow : chalk.red;
	const firstError = extractFirstError(result.errorOutput);
	const location = result.errorTimestamp ? ` (${result.errorTimestamp})` : '';
	spinner.clear();
	console.log(severityColor(`  CORRUPT [${result.severity}] ${filePath}`));
	console.log(chalk.dim(`          ${firstError}${location}`));
}

function extractFirstError(errorOutput: string): string {
	const match = ERROR_CODE_PATTERN.exec(errorOutput);
	if (match?.[1]) {
		return match[1].replace('FLAC__STREAM_DECODER_ERROR_STATUS_', '');
	}
	const firstLine = errorOutput.split('\n')[0]?.trim();
	return firstLine ?? 'unknown error';
}
