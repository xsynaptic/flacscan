import type Database from 'better-sqlite3';

import fs from 'node:fs';

import type { FlacScanConfig } from '../config/types.js';
import type { FileRow } from '../database/types.js';
import type { ErrorSeverity, FormatVerifier, VerificationResult } from '../verifiers/types.js';

import { updateMetadata, updateVerificationResult, upsertFile } from '../database/queries.js';
import { extractMetadata } from '../metadata.js';
import { classifyCorruptFile } from '../verifiers/severity.js';
import { isShuttingDown } from './process-pool.js';

type FixAnnotation =
	| { error: string; label: string; state: 'failed' }
	| { label: string; state: 'detected' };

type VerifyOutcome =
	| {
			errorOutput: string;
			errorTimestamp: null | string;
			fix?: FixAnnotation;
			kind: 'corrupt';
			severity: ErrorSeverity;
	  }
	| { kind: 'fixed'; label: string }
	| { kind: 'healthy' }
	| { kind: 'interrupted' };

export async function verifyAndRecord(
	db: Database.Database,
	config: FlacScanConfig,
	verifier: FormatVerifier,
	file: FileRow,
	opts: { fix: boolean },
): Promise<VerifyOutcome> {
	const filePath = file.current_path;

	let result: VerificationResult;
	try {
		result = await verifier.verify(filePath);
	} catch (error) {
		// A throw is a tool failure, not a file verdict; recording corruption would poison the DB
		if (isShuttingDown()) return { kind: 'interrupted' };
		throw error;
	}

	if (result.status === 'interrupted') return { kind: 'interrupted' };

	if (result.status === 'healthy') {
		updateVerificationResult(db, filePath, { last_result: 'healthy' });
		return { kind: 'healthy' };
	}

	const fixer = verifier.fixer;
	const fixDetected = fixer?.detect(result.errorOutput) ?? false;
	let annotation: FixAnnotation | undefined;

	if (fixDetected && fixer && opts.fix) {
		const fixResult = await fixer.fix(filePath);
		if (fixResult.ok) {
			const recheck = await verifier.verify(filePath);
			if (recheck.status === 'healthy') {
				let stat: fs.Stats;
				try {
					stat = fs.statSync(filePath);
				} catch {
					// File vanished after the fix; the next scan will prune or rediscover it
					return { kind: 'interrupted' };
				}
				upsertFile(db, {
					current_path: filePath,
					file_mtime: stat.mtime.toISOString(),
					file_size: stat.size,
				});
				updateVerificationResult(db, filePath, { last_result: 'healthy' });
				return { kind: 'fixed', label: fixer.label };
			}
		} else {
			annotation = { error: fixResult.error ?? 'unknown', label: fixer.label, state: 'failed' };
		}
	} else if (fixDetected && fixer) {
		annotation = { label: fixer.label, state: 'detected' };
	}

	// Record the original verify error, not the post-fix re-verify's
	const severity = await classifyCorruptFile(
		filePath,
		result.errorOutput,
		result.errorTimestamp,
		config,
	);
	updateVerificationResult(db, filePath, {
		error_output: result.errorOutput,
		error_severity: severity,
		error_timestamp: result.errorTimestamp,
		last_result: 'corrupt',
	});

	if (isMetadataEmpty(file)) {
		const metadata = await extractMetadata(filePath);
		if (metadata) updateMetadata(db, filePath, metadata);
	}

	return {
		errorOutput: result.errorOutput,
		errorTimestamp: result.errorTimestamp,
		kind: 'corrupt',
		severity,
		...(annotation && { fix: annotation }),
	};
}

function isMetadataEmpty(file: FileRow): boolean {
	return !file.artist && !file.title && !file.album && !file.date && !file.duration;
}
