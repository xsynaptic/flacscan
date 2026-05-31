import type Database from 'better-sqlite3';

import chalk from 'chalk';
import { defineCommand } from 'citty';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ora from 'ora';

import type { FlacScanConfig } from '../config/types.js';
import type { FileRow } from '../database/types.js';
import type { ErrorSeverity } from '../verifiers/types.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import {
	countRecoveryAttempted,
	getRecoveryCandidates,
	recordRecoveryOutcome,
} from '../database/queries.js';
import { checkMountedPaths } from '../discovery.js';
import { classifyRecovery, findSpaceViolations, recoveredFilePath } from '../recovery.js';
import { ensureBinary, execFile } from '../shell.js';
import { FlacScanError } from './errors.js';
import { installShutdownHandler, isShuttingDown, processPool } from './process-pool.js';
import { sharedArguments } from './shared-arguments.js';

const SEVERITY_FILTERS = [
	'critical',
	'recoverable',
	'unknown',
] as const satisfies readonly ErrorSeverity[];

interface FlacFormat {
	bitsPerSample: number;
	channels: number;
	sampleRate: number;
	totalSamples: number;
}

// A reachable corrupt file paired with the `[Recovered].flac` path that would sit next to it.
interface RecoverItem {
	atimeMs: number;
	dest: string;
	dev: number;
	mtimeMs: number;
	row: FileRow;
	size: number;
	src: string;
}

type RecoverOutcome =
	| { kind: 'failed'; reason: string }
	| { kind: 'recovered'; note: string; warning?: string }
	| { kind: 'unsuitable'; reason: string };

interface ReportEntry {
	claimedSamples: number;
	deliveredSamples: null | number;
	detail: null | string;
	lostSamples: null | number;
	outcome: RecoverOutcome['kind'];
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

async function attemptRecovery(
	item: RecoverItem,
	config: FlacScanConfig,
	db: Database.Database,
	reportEntries: ReportEntry[],
): Promise<RecoverOutcome> {
	const { dest, row, src } = item;
	const severity = row.error_severity;
	const partial = `${dest}.partial`;

	// If a Ctrl+C arrived while this item was queued, don't even start, and never record a
	// verdict for a file interrupted mid-flight; leave it for the next run.
	if (isShuttingDown()) return { kind: 'failed', reason: 'interrupted' };

	function record(
		outcome: ReportEntry['outcome'],
		extra: {
			claimedSamples?: number;
			deliveredSamples?: number;
			detail: null | string;
			lostSamples: null | number;
			sampleRate?: number;
		},
	): void {
		reportEntries.push({
			claimedSamples: extra.claimedSamples ?? 0,
			deliveredSamples: extra.deliveredSamples ?? null,
			detail: extra.detail,
			lostSamples: extra.lostSamples,
			outcome,
			sampleRate: extra.sampleRate ?? 0,
			severity,
			src,
		});
		if (outcome !== 'failed') {
			recordRecoveryOutcome(db, src, {
				detail: extra.detail,
				lostSamples: extra.lostSamples,
				result: outcome === 'recovered' ? 'recovered' : 'unsuitable',
			});
		}
	}

	let format: FlacFormat;
	try {
		format = await probeFlac(src);
	} catch (error) {
		if (isShuttingDown()) return { kind: 'failed', reason: 'interrupted' };
		if (!fs.existsSync(src)) {
			// Source vanished since the worklist was built; transient, leave it for a future run.
			const reason = 'source disappeared during recovery';
			record('failed', { detail: reason, lostSamples: null });
			return { kind: 'failed', reason };
		}
		// metaflac (which we checked exists up front) ran but couldn't read the file; that's a
		// verdict about the file, not a tooling glitch, so record it and don't retry next run.
		const reason = `metaflac could not read the file: ${stringifyError(error)}`;
		record('unsuitable', { detail: reason, lostSamples: null });
		return { kind: 'unsuitable', reason };
	}

	if (format.totalSamples <= 0) {
		const reason = 'unknown length (STREAMINFO total samples = 0)';
		record('unsuitable', {
			claimedSamples: format.totalSamples,
			detail: reason,
			lostSamples: null,
			sampleRate: format.sampleRate,
		});
		return { kind: 'unsuitable', reason };
	}

	let delivered: number;
	try {
		await decodeReencode(src, partial, format);
		const partialFormat = await probeFlac(partial);
		delivered = partialFormat.totalSamples;
	} catch (error) {
		await safeUnlink(partial);
		if (isShuttingDown()) return { kind: 'failed', reason: 'interrupted' };
		if (!fs.existsSync(src)) {
			const reason = 'source disappeared during recovery';
			record('failed', {
				claimedSamples: format.totalSamples,
				detail: reason,
				lostSamples: null,
				sampleRate: format.sampleRate,
			});
			return { kind: 'failed', reason };
		}
		const reason = `decode/re-encode failed: ${stringifyError(error)}`;
		record('unsuitable', {
			claimedSamples: format.totalSamples,
			detail: reason,
			lostSamples: null,
			sampleRate: format.sampleRate,
		});
		return { kind: 'unsuitable', reason };
	}

	const reencodeVerified = await flacTestPasses(partial);
	const verdict = classifyRecovery({
		claimedSamples: format.totalSamples,
		deliveredSamples: delivered,
		maxTrailingLossSeconds: config.recover_max_trailing_loss_seconds,
		reencodeVerified,
		sampleRate: format.sampleRate,
	});
	if (!verdict.accepted) {
		await safeUnlink(partial);
		const reason = verdict.detail ?? 'not safely recoverable';
		record('unsuitable', {
			claimedSamples: format.totalSamples,
			deliveredSamples: delivered,
			detail: reason,
			lostSamples: verdict.lostSamples,
			sampleRate: format.sampleRate,
		});
		return { kind: 'unsuitable', reason };
	}

	let warning: string | undefined;
	try {
		await carryMetadata(src, partial);
	} catch (error) {
		warning = `tags/cover art not carried over to ${path.basename(dest)}: ${stringifyError(error)}`;
	}

	try {
		await fs.promises.rename(partial, dest);
	} catch (error) {
		await safeUnlink(partial);
		if (isShuttingDown()) return { kind: 'failed', reason: 'interrupted' };
		// Had a clean re-encode but couldn't place it (dest dir vanished, etc.); leave the row
		// unrecorded so the next run picks it up.
		const reason = `could not place recovered file: ${stringifyError(error)}`;
		record('failed', {
			claimedSamples: format.totalSamples,
			deliveredSamples: delivered,
			detail: reason,
			lostSamples: verdict.lostSamples,
			sampleRate: format.sampleRate,
		});
		return { kind: 'failed', reason };
	}
	try {
		await fs.promises.utimes(dest, item.atimeMs / 1000, item.mtimeMs / 1000);
	} catch {
		// Best effort; a recovered file with "now" as its mtime is fine.
	}

	record('recovered', {
		claimedSamples: format.totalSamples,
		deliveredSamples: delivered,
		detail: null,
		lostSamples: verdict.lostSamples,
		sampleRate: format.sampleRate,
	});
	const lostSeconds = (verdict.lostSamples ?? 0) / format.sampleRate;
	return warning
		? { kind: 'recovered', note: `(lost ${lostSeconds.toFixed(1)}s)`, warning }
		: { kind: 'recovered', note: `(lost ${lostSeconds.toFixed(1)}s)` };
}

// Decode `src` to raw PCM and pipe it straight into a max-effort re-encode at `dest`. The
// decoder runs in default (stop-at-first-error) mode, so it emits a contiguous clean prefix
// and then closes. The encoder writes exactly that.
function decodeReencode(src: string, dest: string, format: FlacFormat): Promise<void> {
	return new Promise((resolve, reject) => {
		const decoder = spawn(
			'flac',
			[
				'--decode',
				'--force-raw-format',
				'--endian=little',
				'--sign=signed',
				'--silent',
				'--stdout',
				src,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const encoder = spawn(
			'flac',
			[
				'-8',
				'-e',
				'-p',
				'-V',
				'--force-raw-format',
				'--endian=little',
				'--sign=signed',
				`--channels=${String(format.channels)}`,
				`--bps=${String(format.bitsPerSample)}`,
				`--sample-rate=${String(format.sampleRate)}`,
				'--silent',
				'--force',
				'-o',
				dest,
				'-',
			],
			{ stdio: ['pipe', 'ignore', 'pipe'] },
		);

		let settled = false;
		let decoderClosed = false;
		let encoderClosed = false;
		let encoderErr = '';

		function fail(message: string): void {
			if (!settled) {
				settled = true;
				decoder.kill();
				encoder.kill();
				reject(new Error(message));
			}
		}
		function maybeResolve(): void {
			if (!settled && decoderClosed && encoderClosed) {
				settled = true;
				resolve();
			}
		}

		// Swallow stream errors on the wired-up pipes. When the process group gets SIGINT
		// (Ctrl+C) the flac children die and these sockets EPIPE; without listeners that
		// surfaces as an unhandled 'error' and crashes the whole process. The close handlers
		// below report the real outcome.
		decoder.stdout.on('error', ignoreStreamError);
		decoder.stderr.on('error', ignoreStreamError);
		encoder.stdin.on('error', ignoreStreamError);
		encoder.stderr.on('error', ignoreStreamError);

		decoder.on('error', (error) => {
			fail(`flac decode could not start: ${error.message}`);
		});
		encoder.on('error', (error) => {
			fail(`flac encode could not start: ${error.message}`);
		});
		encoder.stderr.on('data', (chunk: Buffer) => {
			encoderErr += chunk.toString();
		});

		decoder.stdout.pipe(encoder.stdin);

		decoder.on('close', () => {
			// A non-zero decoder exit is expected for a corrupt file; keep whatever it piped through.
			decoderClosed = true;
			maybeResolve();
		});
		encoder.on('close', (code) => {
			encoderClosed = true;
			if (code !== 0) {
				const lastLine = encoderErr.trim().split('\n').pop() ?? '';
				fail(
					`flac encode exited with ${String(code ?? 'a signal')}${lastLine ? `: ${lastLine}` : ''}`,
				);
				return;
			}
			maybeResolve();
		});
	});
}

// Mount-check the configured dirs, build a worklist of reachable corrupt files (skipping
// ones already recovered or gone), run an all-or-nothing per-volume disk-space preflight,
// then iterate at `config.parallelism`; stopping a volume once a write would breach its
// free-space buffer.
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

	// Pass 1; stat every reachable source; skip ones already recovered or gone.
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
			// Moved, deleted, or its volume went away since the last scan; skip, never fail.
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

	// Per-volume free space, grouped by device id. A volume that vanished between the stat
	// above and statfs drops out here rather than aborting the run.
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

	// Pass 2; re-encode. Once a write would breach a volume's buffer, stop using that volume.
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

		const outcome = await attemptRecovery(item, config, db, reportEntries);
		spinner.clear();
		if (outcome.kind === 'recovered') {
			recovered++;
			if (outcome.warning) console.log(chalk.yellow(`  WARNING ${outcome.warning}`));
			console.log(chalk.green(`  RECOVERED ${item.dest}`) + chalk.dim(` ${outcome.note}`));
		} else if (outcome.kind === 'unsuitable') {
			skipped++;
			console.log(chalk.yellow(`  SKIPPED ${item.src}`) + chalk.dim(` - ${outcome.reason}`));
		} else {
			failed++;
			console.log(chalk.red(`  FAILED ${item.src}`) + chalk.dim(` - ${outcome.reason}`));
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

// Standard text tags carried onto the recovered file. Deliberately a curated subset:
// metaflac's bulk tag export/import is line-based and a tag whose value contains newlines
// (DJ-software blobs like BEATGRID/SERATO_*) aborts the whole import; these short fields
// don't have that problem, and they're the ones a library manager actually needs.
const CARRIED_TAGS = [
	'TITLE',
	'ARTIST',
	'ALBUM',
	'ALBUMARTIST',
	'DATE',
	'YEAR',
	'GENRE',
	'TRACKNUMBER',
	'TRACKTOTAL',
	'TOTALTRACKS',
	'DISCNUMBER',
	'DISCTOTAL',
	'TOTALDISCS',
	'COMPOSER',
	'COMMENT',
	'DESCRIPTION',
	'ISRC',
	'LABEL',
	'ORGANIZATION',
	'PUBLISHER',
	'CATALOGNUMBER',
	'BPM',
	'KEY',
	'INITIALKEY',
	'COPYRIGHT',
];

// Copy the original's standard tags and front-cover picture onto the re-encode (which is
// built from raw PCM and so has neither). Best effort; callers treat a throw as a warning.
async function carryMetadata(src: string, dest: string): Promise<void> {
	const { stdout } = await execFile('metaflac', [
		...CARRIED_TAGS.map((name) => `--show-tag=${name}`),
		src,
	]);
	// Keep only well-formed `NAME=value` lines (drops any stray continuation line so a freak
	// multi-line value can't abort the import).
	const tagLines = stdout.split('\n').filter((line) => /^[^=\n]+=/.test(line));
	if (tagLines.length > 0) {
		const tagsTmp = `${dest}.tags`;
		await fs.promises.writeFile(tagsTmp, tagLines.join('\n') + '\n');
		try {
			await execFile('metaflac', [`--import-tags-from=${tagsTmp}`, dest]);
		} finally {
			await safeUnlink(tagsTmp);
		}
	}

	const coverTmp = `${dest}.cover`;
	let haveCover = false;
	try {
		await execFile('metaflac', [`--export-picture-to=${coverTmp}`, src]);
		haveCover = fs.existsSync(coverTmp) && fs.statSync(coverTmp).size > 0;
	} catch {
		// No PICTURE block (common); nothing to carry over.
	}
	try {
		if (haveCover) {
			await execFile('metaflac', [`--import-picture-from=${coverTmp}`, dest]);
		}
	} finally {
		await safeUnlink(coverTmp);
	}
}

function durationLabel(samples: null | number, sampleRate: number): string {
	return samples !== null && sampleRate > 0 ? `${(samples / sampleRate).toFixed(1)}s` : '?';
}

async function flacTestPasses(filePath: string): Promise<boolean> {
	try {
		await execFile('flac', ['--test', '--silent', filePath]);
		return true;
	} catch {
		return false;
	}
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

function ignoreStreamError(): void {
	/* see decodeReencode; EPIPE on a killed child's pipe is expected, not an error */
}

async function probeFlac(filePath: string): Promise<FlacFormat> {
	const { stdout } = await execFile('metaflac', [
		'--show-total-samples',
		'--show-sample-rate',
		'--show-channels',
		'--show-bps',
		filePath,
	]);
	const lines = stdout.trim().split('\n');
	if (lines.length < 4) {
		throw new Error(`unexpected metaflac output for ${filePath}: ${stdout.trim()}`);
	}
	const totalSamples = Number(lines[0]);
	const sampleRate = Number(lines[1]);
	const channels = Number(lines[2]);
	const bitsPerSample = Number(lines[3]);
	if (
		![totalSamples, sampleRate, channels, bitsPerSample].every((value) => Number.isFinite(value))
	) {
		throw new Error(`could not parse metaflac output for ${filePath}: ${stdout.trim()}`);
	}
	return { bitsPerSample, channels, sampleRate, totalSamples };
}

async function safeUnlink(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch {
		// Already gone, or can't remove; not fatal
	}
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
