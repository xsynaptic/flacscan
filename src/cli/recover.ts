import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import fs from 'node:fs';
import path from 'node:path';
import ora from 'ora';

import type { AttemptResult, RecoverItem } from '#cli/recover-attempt.ts';
import type { FlacScanConfig } from '#config/types.ts';
import type { FileRow } from '#database/types.ts';

import { installShutdownHandler, isShuttingDown, processPool } from '#cli/process-pool.ts';
import { attemptRecovery } from '#cli/recover-attempt.ts';
import { flacEngine } from '#cli/recover-engine.ts';
import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { countRecoveryAttempted, getRecoveryCandidates } from '#database/queries.ts';
import { checkMountedPaths } from '#discovery.ts';
import { FlacScanError } from '#errors.ts';
import { directoryPrefix, existsAsSpelled } from '#paths.ts';
import { findSpaceViolations, recoveredFilePath } from '#recovery.ts';
import { ensureBinary } from '#shell.ts';

interface PreparedCounts {
	alreadyPresent: number;
	unavailable: number;
}

interface RecoveryRun {
	config: FlacScanConfig;
	entries: ReportEntry[];
	spinner: Ora;
	stoppedDevs: Set<number>;
	tally: RecoveryTally;
}

interface RecoveryTally {
	bufferStopped: number;
	failed: number;
	processed: number;
	recovered: number;
	skipped: number;
	unavailable: number;
}

interface ReportEntry {
	claimedSamples: number;
	deliveredSamples: null | number;
	detail: null | string;
	lostSamples: null | number;
	outcome: 'failed' | 'recovered' | 'unsuitable';
	sampleRate: number;
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
	},
	meta: {
		description:
			'Re-encode salvageable corrupt FLACs in place, e.g. "Track [Recovered].flac" (clean stream minus a few seconds off the end at most)',
		name: 'recover',
	},
	async run({ args }) {
		installShutdownHandler();

		await runCommand(
			args,
			{
				exclusive: true,
				async prepare() {
					await ensureBinary('flac');
					await ensureBinary('metaflac', 'brew install flac');
				},
			},
			async (db, config) => {
				const alreadyAttempted = countRecoveryAttempted(db);
				if (alreadyAttempted > 0) {
					console.log(
						`${String(alreadyAttempted)} file(s) already attempted; skipping them. ` +
							`To re-attempt, clear their recovery_* columns in ${config.db_path} via sqlite3.`,
					);
				}

				const rows = getRecoveryCandidates(db);
				const emptyMessage =
					alreadyAttempted === 0
						? 'No corrupt files to recover.'
						: 'No un-attempted corrupt files to recover.';
				const reportEntries = await runRecovery(config, db, rows);
				if (reportEntries === undefined) {
					console.log(emptyMessage);
					return;
				}

				if (args.output && reportEntries.length > 0) {
					writeReport(args.output, reportEntries);
				}
			},
		);
	},
});

export async function runRecovery(
	config: FlacScanConfig,
	db: Database.Database,
	rows: FileRow[],
): Promise<ReportEntry[] | undefined> {
	const mountCheck = checkMountedPaths(config.directories);
	const candidates = rows.filter((row) =>
		mountCheck.available.some((directory) =>
			row.current_path.startsWith(directoryPrefix(directory)),
		),
	);
	if (candidates.length === 0) return undefined;

	const prepSpinner = ora({
		discardStdin: false,
		text: `Preparing: 0/${String(candidates.length)} files`,
	}).start();

	const prepared = prepareItems(candidates, prepSpinner);
	const { items, volumes } = await measureVolumes(prepared.items);
	const counts: PreparedCounts = {
		alreadyPresent: prepared.alreadyPresent,
		unavailable: prepared.unavailable + prepared.items.length - items.length,
	};

	if (items.length === 0) {
		prepSpinner.succeed(
			`Nothing to do (${String(counts.alreadyPresent)} already recovered, ${String(counts.unavailable)} unavailable).`,
		);
		return [];
	}

	const violations = findSpaceViolations(items, volumes, config.min_free_bytes);
	if (violations.length > 0) {
		prepSpinner.fail('Not enough free space; nothing written.');
		throw spaceError(violations);
	}

	prepSpinner.succeed(
		`Prepared ${String(items.length)} file(s) (${String(counts.alreadyPresent)} already recovered, ${String(counts.unavailable)} unavailable).`,
	);

	return recoverAll({ config, db }, items, counts);
}

function finishRecovery({ spinner, tally }: RecoveryRun, total: number, counts: PreparedCounts) {
	const totalUnavailable = counts.unavailable + tally.unavailable;
	const summary = `${String(tally.recovered)} recovered, ${String(tally.skipped)} skipped (unsuitable), ${String(tally.failed)} failed, ${String(counts.alreadyPresent)} already recovered, ${String(totalUnavailable)} unavailable, ${String(tally.bufferStopped)} stopped (buffer floor)`;
	if (isShuttingDown()) {
		spinner.warn(
			`Recovering interrupted at ${String(tally.processed)}/${String(total)}: ${summary}`,
		);
		return;
	}
	spinner.succeed(`Recovering complete: ${summary}`);
}

async function hasRoom({ config, spinner, stoppedDevs, tally }: RecoveryRun, item: RecoverItem) {
	if (stoppedDevs.has(item.dev)) {
		tally.bufferStopped++;
		return false;
	}
	let fsStat;
	try {
		fsStat = await fs.promises.statfs(item.src);
	} catch {
		tally.unavailable++;
		return false;
	}
	if (fsStat.bavail * fsStat.bsize - item.size >= config.min_free_bytes) return true;

	stoppedDevs.add(item.dev);
	tally.bufferStopped++;
	spinner.clear();
	console.log(chalk.yellow(`  buffer floor reached on volume ${String(item.dev)}; stopping there`));
	return false;
}

async function measureVolumes(prepared: RecoverItem[]) {
	const volumes: { dev: number; freeBytes: number }[] = [];
	const droppedDevs = new Set<number>();
	const devs = new Set(prepared.map((item) => item.dev));
	for (const dev of devs) {
		const sample = prepared.find((item) => item.dev === dev);
		if (!sample) continue;
		try {
			const fsStat = await fs.promises.statfs(sample.src);
			volumes.push({ dev, freeBytes: fsStat.bavail * fsStat.bsize });
		} catch {
			droppedDevs.add(dev);
		}
	}
	return { items: prepared.filter((item) => !droppedDevs.has(item.dev)), volumes };
}

function prepareItems(candidates: FileRow[], spinner: Ora) {
	const items: RecoverItem[] = [];
	let alreadyPresent = 0;
	let unavailable = 0;
	for (const [index, row] of candidates.entries()) {
		spinner.text = `Preparing: ${String(index + 1)}/${String(candidates.length)} files`;

		const src = row.current_path;
		const dest = recoveredFilePath(src);
		if (fs.existsSync(dest)) {
			alreadyPresent++;
			continue;
		}
		const stat = statSpelledSource(src);
		if (stat === undefined) {
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
	return { alreadyPresent, items, unavailable };
}

async function recoverAll(
	{ config, db }: { config: FlacScanConfig; db: Database.Database },
	items: RecoverItem[],
	counts: PreparedCounts,
): Promise<ReportEntry[]> {
	const run: RecoveryRun = {
		config,
		entries: [],
		spinner: ora({
			discardStdin: false,
			text: `Recovering: 0/${String(items.length)} files`,
		}).start(),
		stoppedDevs: new Set(),
		tally: { bufferStopped: 0, failed: 0, processed: 0, recovered: 0, skipped: 0, unavailable: 0 },
	};

	await processPool(items, config.parallelism, async (item) => {
		run.tally.processed++;
		run.spinner.text = `Recovering: ${String(run.tally.processed)}/${String(items.length)} files`;
		if (!(await hasRoom(run, item))) return;

		const result = await attemptRecovery({ config, db, env: flacEngine }, item);
		reportAttempt(run, item, result);
	});

	finishRecovery(run, items.length, counts);
	return run.entries;
}

function reportAttempt(
	{ entries, spinner, tally }: RecoveryRun,
	item: RecoverItem,
	result: AttemptResult,
) {
	const entry = (outcome: ReportEntry['outcome']): ReportEntry => ({
		claimedSamples: result.claimedSamples,
		deliveredSamples: result.deliveredSamples,
		detail: result.detail,
		lostSamples: result.lostSamples,
		outcome,
		sampleRate: result.sampleRate,
		src: item.src,
	});

	spinner.clear();
	if (result.kind === 'recovered') {
		entries.push(entry('recovered'));
		tally.recovered++;
		if (result.warning) console.log(chalk.yellow(`  WARNING ${result.warning}`));
		console.log(chalk.green(`  RECOVERED ${item.dest}`) + chalk.dim(` ${result.note ?? ''}`));
		return;
	}
	if (result.kind === 'unsuitable') {
		entries.push(entry('unsuitable'));
		tally.skipped++;
		console.log(chalk.yellow(`  SKIPPED ${item.src}`) + chalk.dim(` - ${result.detail ?? ''}`));
		return;
	}
	tally.failed++;
	if (result.kind === 'failed') entries.push(entry('failed'));
	console.log(chalk.red(`  FAILED ${item.src}`) + chalk.dim(` - ${result.detail ?? ''}`));
}

function spaceError(violations: ReturnType<typeof findSpaceViolations>): FlacScanError {
	const detail = violations
		.map(
			(violation) =>
				`  volume ${String(violation.dev)}: ${formatBytes(violation.freeBytes)} free, needs ${formatBytes(violation.requiredBytes)} (short ${formatBytes(violation.shortfallBytes)})`,
		)
		.join('\n');
	return new FlacScanError(
		`Disk space check failed:\n${detail}\nFree up space or lower min_free_bytes, then retry.`,
	);
}

function statSpelledSource(src: string): fs.Stats | undefined {
	if (!existsAsSpelled(src)) return undefined;
	try {
		return fs.statSync(src);
	} catch {
		return undefined;
	}
}

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
