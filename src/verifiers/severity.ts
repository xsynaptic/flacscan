import type { FlacScanConfig } from '../config/types.js';
import type { ErrorSeverity } from './types.js';

import { classifySeverity } from '../recovery.js';
import { execFile } from '../shell.js';

/**
 * For a file `flac -t` flagged as corrupt, probe its STREAMINFO with `metaflac` and predict
 * `recover`'s outcome via `classifySeverity`. Returns the severity to store in `error_severity`:
 *
 * - `'recoverable'` ⇒ `recover` will succeed on this file (loss within the configured limit).
 * - `'critical'` ⇒ `recover` will reject (loss too large / decoded fully / decoded nothing).
 * - `'unknown'` ⇒ couldn't probe, usually because metaflac can't read the file either.
 *
 * Called from both `scan-verify` and `recheck`, hence sitting in `verifiers/` rather than
 * either CLI module.
 */
export async function classifyCorruptFile(
	filePath: string,
	errorOutput: string,
	errorTimestamp: null | string,
	config: FlacScanConfig,
): Promise<ErrorSeverity> {
	let claimedSamples: null | number = null;
	let sampleRate: null | number = null;
	try {
		const { stdout } = await execFile('metaflac', [
			'--show-total-samples',
			'--show-sample-rate',
			filePath,
		]);
		const lines = stdout.trim().split('\n');
		const total = Number(lines[0]);
		const rate = Number(lines[1]);
		if (Number.isFinite(total)) claimedSamples = total;
		if (Number.isFinite(rate)) sampleRate = rate;
	} catch {
		// metaflac can't read the file, leaves claimed/rate null; classifySeverity returns 'unknown'.
	}
	return classifySeverity({
		claimedSamples,
		errorOutput,
		errorTimestamp,
		maxTrailingLossSeconds: config.recover_max_trailing_loss_seconds,
		sampleRate,
	});
}
