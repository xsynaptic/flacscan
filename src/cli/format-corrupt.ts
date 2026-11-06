import chalk from 'chalk';

import type { CorruptOutcome } from '#cli/verify-and-record.ts';

const ERROR_CODE_PATTERN = /error code \d+:(\S+)/;

export function corruptSummary({
	corrupt,
	newCorrupt,
	newRegressed,
}: {
	corrupt: number;
	newCorrupt: number;
	newRegressed: number;
}): string {
	if (corrupt === 0) return '0 corrupt';
	const regressed = newRegressed > 0 ? `, ${String(newRegressed)} regressed` : '';
	return `${String(corrupt)} corrupt (${String(newCorrupt)} new${regressed})`;
}

export function printCorruptFile(
	spinner: { clear(): void },
	filePath: string,
	outcome: CorruptOutcome,
): void {
	const firstError = extractFirstError(outcome.errorOutput);
	const location = outcome.errorTimestamp ? ` (${outcome.errorTimestamp})` : '';
	const lastHealthy = outcome.lastHealthyAt ? `, last healthy ${outcome.lastHealthyAt}` : '';
	spinner.clear();
	if (outcome.fix) printFixAnnotation(filePath, outcome.fix);
	console.log(verdictLine(filePath, outcome));
	console.log(chalk.dim(`          ${firstError}${location}${lastHealthy}`));
}

function printFixAnnotation(filePath: string, fix: NonNullable<CorruptOutcome['fix']>) {
	if (fix.state === 'failed') {
		console.log(chalk.red(`  ${fix.label}_FIX_FAILED ${filePath}`));
		console.log(chalk.dim(`          ${fix.error}`));
		return;
	}
	console.log(chalk.yellow(`  ${fix.label}_DETECTED ${filePath}`));
	console.log(chalk.dim(`          Non-standard ${fix.label} tags found, use --fix to strip`));
}

function verdictLine(filePath: string, { known, lastHealthyAt }: CorruptOutcome): string {
	if (known) return chalk.dim(`  CORRUPT (accepted) ${filePath}`);
	if (lastHealthyAt) return chalk.red(`  REGRESSED ${filePath}`);
	return chalk.red(`  NEW CORRUPT ${filePath}`);
}

function extractFirstError(errorOutput: string): string {
	const match = ERROR_CODE_PATTERN.exec(errorOutput);
	if (match?.[1]) {
		return match[1].replace('FLAC__STREAM_DECODER_ERROR_STATUS_', '');
	}
	const firstLine = errorOutput.split('\n', 1)[0]?.trim();
	return firstLine ?? 'unknown error';
}
