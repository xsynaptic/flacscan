import chalk from 'chalk';

const ERROR_CODE_PATTERN = /error code \d+:(\S+)/;

export function printCorruptFile(
	spinner: { clear(): void },
	filePath: string,
	result: { errorOutput: string; errorTimestamp: null | string },
	opts: { known: boolean },
): void {
	const firstError = extractFirstError(result.errorOutput);
	const location = result.errorTimestamp ? ` (${result.errorTimestamp})` : '';
	spinner.clear();
	if (opts.known) {
		console.log(chalk.dim(`  CORRUPT (accepted) ${filePath}`));
	} else {
		console.log(chalk.red(`  NEW CORRUPT ${filePath}`));
	}
	console.log(chalk.dim(`          ${firstError}${location}`));
}

function extractFirstError(errorOutput: string): string {
	const match = ERROR_CODE_PATTERN.exec(errorOutput);
	if (match?.[1]) {
		return match[1].replace('FLAC__STREAM_DECODER_ERROR_STATUS_', '');
	}
	const firstLine = errorOutput.split('\n', 1)[0]?.trim();
	return firstLine ?? 'unknown error';
}
