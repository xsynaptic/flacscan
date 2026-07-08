import type Database from 'better-sqlite3';

import path from 'node:path';

import type { FlacScanConfig } from '../config/types.js';
import type { FileRow } from '../database/types.js';
import type { FlacFormat, RecoveryEnv } from './recover-engine.js';

import { recordRecoveryOutcome } from '../database/queries.js';
import { classifyRecovery } from '../recovery.js';

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

// A reachable corrupt file paired with the `[Recovered].flac` path that would sit next to it.
export interface RecoverItem {
	atimeMs: number;
	dest: string;
	dev: number;
	mtimeMs: number;
	row: FileRow;
	size: number;
	src: string;
}

export async function attemptRecovery(
	env: RecoveryEnv,
	db: Database.Database,
	config: FlacScanConfig,
	item: RecoverItem,
): Promise<AttemptResult> {
	const { dest, src } = item;
	const partial = `${dest}.partial`;

	// Persist only settled verdicts (recovered/unsuitable); failed/interrupted stays unrecorded so the next run retries
	function result(
		kind: AttemptResult['kind'],
		extra: {
			claimedSamples?: number;
			deliveredSamples?: number;
			detail: null | string;
			lostSamples: null | number;
			note?: string;
			sampleRate?: number;
			warning?: string;
		},
	): AttemptResult {
		if (kind === 'recovered' || kind === 'unsuitable') {
			recordRecoveryOutcome(db, src, {
				detail: extra.detail,
				lostSamples: extra.lostSamples,
				result: kind === 'recovered' ? 'recovered' : 'unsuitable',
			});
		}
		return {
			claimedSamples: extra.claimedSamples ?? 0,
			deliveredSamples: extra.deliveredSamples ?? null,
			detail: extra.detail,
			kind,
			lostSamples: extra.lostSamples,
			note: extra.note ?? null,
			sampleRate: extra.sampleRate ?? 0,
			warning: extra.warning ?? null,
		};
	}

	function interrupted(): AttemptResult {
		return result('interrupted', { detail: 'interrupted', lostSamples: null });
	}

	// Queued when Ctrl+C arrived: don't start, leave unrecorded for the next run
	if (env.shouldStop()) return interrupted();

	let format: FlacFormat;
	try {
		format = await env.probe(src);
	} catch (error) {
		if (env.shouldStop()) return interrupted();
		if (!env.exists(src)) {
			// Source vanished since the worklist was built; transient, retry next run
			return result('failed', { detail: 'source disappeared during recovery', lostSamples: null });
		}
		// Metaflac ran but couldn't read the file: a verdict about the file, not a glitch, so record it
		return result('unsuitable', {
			detail: `metaflac could not read the file: ${stringifyError(error)}`,
			lostSamples: null,
		});
	}

	if (format.totalSamples <= 0) {
		return result('unsuitable', {
			claimedSamples: format.totalSamples,
			detail: 'unknown length (STREAMINFO total samples = 0)',
			lostSamples: null,
			sampleRate: format.sampleRate,
		});
	}

	let delivered: number;
	try {
		await env.decodeReencode(src, partial, format);
		const partialFormat = await env.probe(partial);
		delivered = partialFormat.totalSamples;
	} catch (error) {
		await env.unlink(partial);
		if (env.shouldStop()) return interrupted();
		if (!env.exists(src)) {
			return result('failed', {
				claimedSamples: format.totalSamples,
				detail: 'source disappeared during recovery',
				lostSamples: null,
				sampleRate: format.sampleRate,
			});
		}
		return result('unsuitable', {
			claimedSamples: format.totalSamples,
			detail: `decode/re-encode failed: ${stringifyError(error)}`,
			lostSamples: null,
			sampleRate: format.sampleRate,
		});
	}

	const reencodeVerified = await env.testPasses(partial);
	if (!reencodeVerified && env.shouldStop()) {
		// A false verdict during shutdown may just be the child killed by SIGINT; don't persist it
		await env.unlink(partial);
		return interrupted();
	}
	const verdict = classifyRecovery({
		claimedSamples: format.totalSamples,
		deliveredSamples: delivered,
		maxTrailingLossSeconds: config.recover_max_trailing_loss_seconds,
		reencodeVerified,
		sampleRate: format.sampleRate,
	});
	if (!verdict.accepted) {
		await env.unlink(partial);
		return result('unsuitable', {
			claimedSamples: format.totalSamples,
			deliveredSamples: delivered,
			detail: verdict.detail ?? 'not safely recoverable',
			lostSamples: verdict.lostSamples,
			sampleRate: format.sampleRate,
		});
	}

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
		if (env.shouldStop()) return interrupted();
		// Clean re-encode but couldn't place it (dest dir vanished, etc.); leave unrecorded to retry
		return result('failed', {
			claimedSamples: format.totalSamples,
			deliveredSamples: delivered,
			detail: `could not place recovered file: ${stringifyError(error)}`,
			lostSamples: verdict.lostSamples,
			sampleRate: format.sampleRate,
		});
	}
	try {
		await env.utimes(dest, item.atimeMs, item.mtimeMs);
	} catch {
		// Best effort; a recovered file keeping "now" as its mtime is fine
	}

	const lostSeconds = (verdict.lostSamples ?? 0) / format.sampleRate;
	return result('recovered', {
		claimedSamples: format.totalSamples,
		deliveredSamples: delivered,
		detail: null,
		lostSamples: verdict.lostSamples,
		note: `(lost ${lostSeconds.toFixed(1)}s)`,
		sampleRate: format.sampleRate,
		...(warning !== undefined && { warning }),
	});
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
