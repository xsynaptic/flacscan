import type Database from 'better-sqlite3';

import path from 'node:path';

import type { FlacFormat, RecoveryEnv } from '#cli/recover-engine.ts';
import type { FlacScanConfig } from '#config/types.ts';
import type { FileRow } from '#database/types.ts';
import type { StopSignal } from '#process-pool.ts';
import type { RecoveryClassification } from '#recovery.ts';

import { recordRecoveryOutcome } from '#database/queries.ts';
import { classifyRecovery } from '#recovery.ts';

export interface AttemptResult {
	claimedSamples: number;
	deliveredSamples: null | number;
	detail: null | string;
	kind: 'failed' | 'interrupted' | 'recovered' | 'unsuitable';
	lostSamples: null | number;
	note: null | string;
	sampleRate: number;
	warning: null | string;
}

interface AttemptContext {
	config: FlacScanConfig;
	db: Database.Database;
	env: RecoveryEnv;
	signal: StopSignal;
}

type Outcome = Partial<Omit<AttemptResult, 'detail' | 'kind' | 'lostSamples'>> &
	Pick<AttemptResult, 'detail' | 'kind' | 'lostSamples'>;

export interface RecoverItem {
	atimeMs: number;
	dest: string;
	dev: number;
	mtimeMs: number;
	row: FileRow;
	size: number;
	src: string;
}

interface Stream {
	claimedSamples: number;
	deliveredSamples: number;
	sampleRate: number;
}

const interrupted: Outcome = { detail: 'interrupted', kind: 'interrupted', lostSamples: null };

const unsettled = {
	claimedSamples: 0,
	deliveredSamples: null,
	note: null,
	sampleRate: 0,
	warning: null,
} satisfies Omit<AttemptResult, 'detail' | 'kind' | 'lostSamples'>;

export async function attemptRecovery(
	context: AttemptContext,
	item: RecoverItem,
): Promise<AttemptResult> {
	const outcome = await runAttempt(context, item);
	// Persist only settled verdicts (recovered/unsuitable); failed/interrupted stays unrecorded so the next run retries
	if (outcome.kind === 'recovered' || outcome.kind === 'unsuitable') {
		recordRecoveryOutcome(context.db, item.src, {
			detail: outcome.detail,
			lostSamples: outcome.lostSamples,
			result: outcome.kind,
		});
	}
	return { ...unsettled, ...outcome };
}

async function judge(
	{ config, env, signal }: AttemptContext,
	partial: string,
	stream: Stream,
): Promise<Outcome | RecoveryClassification> {
	const reencodeVerified = await env.testPasses(partial);
	if (!reencodeVerified && signal.aborted) {
		// A false verdict during shutdown may just be the child killed by SIGINT; don't persist it
		await env.unlink(partial);
		return interrupted;
	}
	const verdict = classifyRecovery({
		claimedSamples: stream.claimedSamples,
		deliveredSamples: stream.deliveredSamples,
		maxTrailingLossSeconds: config.recover_max_trailing_loss_seconds,
		reencodeVerified,
		sampleRate: stream.sampleRate,
	});
	if (verdict.accepted) return verdict;
	await env.unlink(partial);
	return {
		...stream,
		detail: verdict.detail ?? 'not safely recoverable',
		kind: 'unsuitable',
		lostSamples: verdict.lostSamples,
	};
}

async function place(
	{ env, signal }: AttemptContext,
	item: RecoverItem,
	accepted: Stream & { lostSamples: null | number },
): Promise<Outcome> {
	const { dest, src } = item;
	const partial = `${dest}.partial`;

	let warning: string | undefined;
	try {
		await env.carryMetadata(src, partial);
	} catch (error) {
		warning = `tags/cover art not carried over to ${path.basename(dest)}: ${stringifyError(error)}`;
	}

	try {
		await env.rename(partial, dest);
	} catch (error) {
		await env.unlink(partial);
		if (signal.aborted) return interrupted;
		return {
			...accepted,
			detail: `could not place recovered file: ${stringifyError(error)}`,
			kind: 'failed',
		};
	}
	try {
		await env.utimes(dest, item.atimeMs, item.mtimeMs);
	} catch {
		// Best effort; a recovered file keeping "now" as its mtime is fine
	}

	const lostSeconds = (accepted.lostSamples ?? 0) / accepted.sampleRate;
	return {
		...accepted,
		detail: null,
		kind: 'recovered',
		note: `(lost ${lostSeconds.toFixed(1)}s)`,
		...(warning !== undefined && { warning }),
	};
}

async function probeSource(context: AttemptContext, src: string): Promise<FlacFormat | Outcome> {
	try {
		return await context.env.probe(src);
	} catch (error) {
		// Metaflac ran but couldn't read the file: a verdict about the file, not a glitch, so record it
		return stageFailure(context, src, {
			detail: `metaflac could not read the file: ${stringifyError(error)}`,
		});
	}
}

async function reencode(
	context: AttemptContext,
	item: RecoverItem,
	format: FlacFormat,
): Promise<number | Outcome> {
	const { env } = context;
	const partial = `${item.dest}.partial`;
	try {
		await env.decodeReencode(item.src, partial, format);
		const partialFormat = await env.probe(partial);
		return partialFormat.totalSamples;
	} catch (error) {
		await env.unlink(partial);
		return stageFailure(context, item.src, {
			claimedSamples: format.totalSamples,
			detail: `decode/re-encode failed: ${stringifyError(error)}`,
			sampleRate: format.sampleRate,
		});
	}
}

async function runAttempt(context: AttemptContext, item: RecoverItem): Promise<Outcome> {
	if (context.signal.aborted) return interrupted;

	const format = await probeSource(context, item.src);
	if ('kind' in format) return format;

	const measured = { claimedSamples: format.totalSamples, sampleRate: format.sampleRate };
	if (format.totalSamples <= 0) {
		return {
			...measured,
			detail: 'unknown length (STREAMINFO total samples = 0)',
			kind: 'unsuitable',
			lostSamples: null,
		};
	}

	const delivered = await reencode(context, item, format);
	if (typeof delivered !== 'number') return delivered;

	const stream = { ...measured, deliveredSamples: delivered };
	const verdict = await judge(context, `${item.dest}.partial`, stream);
	if ('kind' in verdict) return verdict;

	return place(context, item, { ...stream, lostSamples: verdict.lostSamples });
}

function stageFailure(
	{ env, signal }: AttemptContext,
	src: string,
	failure: { claimedSamples?: number; detail: string; sampleRate?: number },
): Outcome {
	if (signal.aborted) return interrupted;
	if (!env.exists(src)) {
		return {
			...failure,
			detail: 'source disappeared during recovery',
			kind: 'failed',
			lostSamples: null,
		};
	}
	return { ...failure, kind: 'unsuitable', lostSamples: null };
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
