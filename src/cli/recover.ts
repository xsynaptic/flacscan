import type Database from 'better-sqlite3';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import path from 'node:path';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';
import type { FileRow } from '../database/types.js';
import type { ErrorSeverity } from '../verifiers/types.js';
import type { AttemptResult, RecoverItem } from './recover-attempt.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { countRecoveryAttempted, getRecoveryCandidates } from '../database/queries.js';
import { checkMountedPaths } from '../discovery.js';
import { findSpaceViolations, recoveredFilePath } from '../recovery.js';
import { ensureBinary } from '../shell.js';
import { FlacScanError } from './errors.js';
import { installShutdownHandler, isShuttingDown, processPool } from './process-pool.js';
import { attemptRecovery } from './recover-attempt.js';
import { flacEngine } from './recover-engine.js';
import { sharedArguments } from './shared-arguments.js';

const SEVERITY_FILTERS = [
	'critical',
	'recoverable',
	'unknown',
] as const satisfies readonly ErrorSeverity[];

interface ReportEntry {
	claimedSamples: number;
	deliveredSamples: null | number;
	detail: null | string;
	lostSamples: null | number;
	outcome: 'failed' | 'recovered' | 'unsuitable';
	sampleRate: number;
	severity: ErrorSeverity | null;
	src: string;
}

export const recoverCommand = defineCommand({
	args: {
		...sharedArguments,
		'max-trailing-loss': {
			description: 'Accept a re-encode only if it loses at most this many seconds off the end',
			type: 'string',
		},
		'min-free-bytes': {
			description:
				'Free space (bytes) to keep on every volume; recover aborts if any volume is short',
			type: 'string',
		},
		output: {
			description: 'Write a per-file recovery report to this file',
			type: 'string',
		},
		severity: {
			description:
				'Only consider this severity: critical, recoverable, unknown (default: all corrupt)',
			required: false,
			type: 'positional',
		},
	},
	meta: {
		description:
			'Re-encode salvageable corrupt FLACs in place, e.g. "Track [Recovered].flac" (clean stream minus a few seconds off the end at most)',
		name: 'recover',
	},
	async run({ args }) {
		try {
			installShutdownHandler();
			await ensureBinary('flac');
			await ensureBinary('metaflac', 'brew install flac');

			const severity = args.severity as ErrorSeverity | undefined;
			if (severity !== undefined && !SEVERITY_FILTERS.includes(severity)) {
				console.error(`Unknown severity: ${severity}`);
				console.error(`Valid values: ${SEVERITY_FILTERS.join(', ')}`);
				process.exitCode = 1;
				return;
			}

			const config = loadConfig(args);
			const db = openDatabase(config.db_path);

			try {
				const alreadyAttempted = countRecoveryAttempted(db);
				if (alreadyAttempted > 0) {
					console.log(
						`${String(alreadyAttempted)} file(s) already attempted; skipping them. ` +
							`To re-attempt, clear their recovery_* columns in ${config.db_path} via sqlite3.`,
					);
				}

				const rows = getRecoveryCandidates(db, severity ? { severity } : {});
				const emptyMessage =
					alreadyAttempted === 0
						? 'No corrupt files to recover.'
						: 'No un-attempted corrupt files to recover.';
				const reportEntries: ReportEntry[] = [];

				await runRecovery(config, db, rows, emptyMessage, reportEntries);

				if (args.output && reportEntries.length > 0) {
					writeReport(args.output, reportEntries);
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

function durationLabel(samples: null | number, sampleRate: number): string {
	return samples !== null && sampleRate > 0 ? `${(samples / sampleRate).toFixed(1)}s` : '?';
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units.at(unitIndex) ?? 'KiB'}`;
}

// - Mount-check the dirs, build a worklist of reachable corrupt files (skipping recovered/gone)
// - Run an all-or-nothing per-volume disk-space preflight
// - Iterate at config.parallelism, stopping a volume once a write would breach its free buffer
async function runRecovery(
	config: FlacScanConfig,
	db: Database.Database,
	rows: FileRow[],
	emptyMessage: string,
	reportEntries: ReportEntry[],
): Promise<void> {
	const mountCheck = checkMountedPaths(config.directories);
	const candidates = rows.filter((row) =>
		mountCheck.available.some((directory) => row.current_path.startsWith(directory)),
	);
	if (candidates.length === 0) {
		console.log(emptyMessage);
		return;
	}

	// Pass 1: stat every reachable source; skip ones already recovered or gone
	const prepSpinner = ora({
		discardStdin: false,
		text: `Preparing: 0/${String(candidates.length)} files`,
	}).start();

	const items: RecoverItem[] = [];
	let alreadyPresent = 0;
	let unavailable = 0;
	let prepared = 0;
	for (const row of candidates) {
		prepared++;
		prepSpinner.text = `Preparing: ${String(prepared)}/${String(candidates.length)} files`;

		const src = row.current_path;
		const dest = recoveredFilePath(src);
		if (fs.existsSync(dest)) {
			alreadyPresent++;
			continue;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(src);
		} catch {
			// Moved, deleted, or volume gone since the last scan; skip, never fail
			unavailable++;
			continue;
		}
		items.push({
			atimeMs: stat.atimeMs,
			dest,
			dev: stat.dev,
			mtimeMs: stat.mtimeMs,
			row,
			size: stat.size,
			src,
		});
	}

	// Per-volume free space, grouped by device id
	// A volume that vanished between stat and statfs drops out here rather than aborting
	const volumes: { dev: number; freeBytes: number }[] = [];
	const droppedDevs = new Set<number>();
	for (const dev of new Set(items.map((item) => item.dev))) {
		const sample = items.find((item) => item.dev === dev);
		if (!sample) continue;
		try {
			const fsStat = await fs.promises.statfs(sample.src);
			volumes.push({ dev, freeBytes: fsStat.bavail * fsStat.bsize });
		} catch {
			droppedDevs.add(dev);
		}
	}

	const plannedItems = items.filter((item) => !droppedDevs.has(item.dev));
	unavailable += items.length - plannedItems.length;

	if (plannedItems.length === 0) {
		prepSpinner.succeed(
			`Nothing to do (${String(alreadyPresent)} already recovered, ${String(unavailable)} unavailable).`,
		);
		return;
	}

	const violations = findSpaceViolations(plannedItems, volumes, config.min_free_bytes);
	if (violations.length > 0) {
		prepSpinner.fail('Not enough free space; nothing written.');
		const detail = violations
			.map(
				(violation) =>
					`  volume ${String(violation.dev)}: ${formatBytes(violation.freeBytes)} free, needs ${formatBytes(violation.requiredBytes)} (short ${formatBytes(violation.shortfallBytes)})`,
			)
			.join('\n');
		throw new FlacScanError(
			`Disk space check failed:\n${detail}\nFree up space or lower min_free_bytes, then retry.`,
		);
	}

	prepSpinner.succeed(
		`Prepared ${String(plannedItems.length)} file(s) (${String(alreadyPresent)} already recovered, ${String(unavailable)} unavailable).`,
	);

	// Pass 2: re-encode; once a write would breach a volume's buffer, stop using that volume
	const spinner = ora({
		discardStdin: false,
		text: `Recovering: 0/${String(plannedItems.length)} files`,
	}).start();

	const stoppedDevs = new Set<number>();
	let recovered = 0;
	let skipped = 0;
	let failed = 0;
	let bufferStopped = 0;
	let runUnavailable = 0;
	let processed = 0;

	const pushEntry = (item: RecoverItem, result: AttemptResult, outcome: ReportEntry['outcome']) => {
		reportEntries.push({
			claimedSamples: result.claimedSamples,
			deliveredSamples: result.deliveredSamples,
			detail: result.detail,
			lostSamples: result.lostSamples,
			outcome,
			sampleRate: result.sampleRate,
			severity: item.row.error_severity,
			src: item.src,
		});
	};

	await processPool(plannedItems, config.parallelism, async (item) => {
		processed++;
		spinner.text = `Recovering: ${String(processed)}/${String(plannedItems.length)} files`;

		if (stoppedDevs.has(item.dev)) {
			bufferStopped++;
			return;
		}
		let fsStat;
		try {
			fsStat = await fs.promises.statfs(item.src);
		} catch {
			runUnavailable++;
			return;
		}
		if (fsStat.bavail * fsStat.bsize - item.size < config.min_free_bytes) {
			stoppedDevs.add(item.dev);
			bufferStopped++;
			spinner.clear();
			console.log(
				chalk.yellow(`  buffer floor reached on volume ${String(item.dev)}; stopping there`),
			);
			return;
		}

		const result = await attemptRecovery(flacEngine, db, config, item);
		spinner.clear();
		if (result.kind === 'recovered') {
			pushEntry(item, result, 'recovered');
			recovered++;
			if (result.warning) console.log(chalk.yellow(`  WARNING ${result.warning}`));
			console.log(chalk.green(`  RECOVERED ${item.dest}`) + chalk.dim(` ${result.note ?? ''}`));
		} else if (result.kind === 'unsuitable') {
			pushEntry(item, result, 'unsuitable');
			skipped++;
			console.log(chalk.yellow(`  SKIPPED ${item.src}`) + chalk.dim(` - ${result.detail ?? ''}`));
		} else {
			failed++;
			if (result.kind === 'failed') pushEntry(item, result, 'failed');
			console.log(chalk.red(`  FAILED ${item.src}`) + chalk.dim(` - ${result.detail ?? ''}`));
		}
	});

	const totalUnavailable = unavailable + runUnavailable;
	const summary = `${String(recovered)} recovered, ${String(skipped)} skipped (unsuitable), ${String(failed)} failed, ${String(alreadyPresent)} already recovered, ${String(totalUnavailable)} unavailable, ${String(bufferStopped)} stopped (buffer floor)`;
	if (isShuttingDown()) {
		spinner.warn(
			`Recovering interrupted at ${String(processed)}/${String(plannedItems.length)}: ${summary}`,
		);
	} else {
		spinner.succeed(`Recovering complete: ${summary}`);
	}
}

function writeReport(outputFile: string, entries: ReportEntry[]): void {
	const sorted = entries.toSorted((a, b) => a.src.localeCompare(b.src));
	const lines = ['flacscan recover report', ''];
	for (const entry of sorted) {
		const length = durationLabel(
			entry.claimedSamples > 0 ? entry.claimedSamples : null,
			entry.sampleRate,
		);
		const kept = durationLabel(entry.deliveredSamples, entry.sampleRate);
		const lost = durationLabel(entry.lostSamples, entry.sampleRate);
		lines.push(
			[
				entry.outcome.toUpperCase(),
				entry.severity ?? '-',
				`len=${length}`,
				`kept=${kept}`,
				`lost=${lost}`,
				entry.src,
				entry.detail ? `(${entry.detail})` : '',
			]
				.filter((field) => field !== '')
				.join('\t'),
		);
	}
	const outputPath = path.resolve(outputFile);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, lines.join('\n') + '\n');
	console.log(`Recovery report written to ${outputPath}`);
}
