import type Database from 'better-sqlite3';

import fs from 'node:fs';

import type { CorruptKind } from '#database/issues.ts';
import type { FileRow } from '#database/types.ts';
import type { StopSignal } from '#process-pool.ts';
import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import { classifyCorrupt } from '#database/issues.ts';
import { identityOf, recordMetadata, recordReadable, recordVerdict } from '#database/queries.ts';
import { logCorruption, logFixApplied, logFixDetected, logFixFailed } from '#logging/scan-log.ts';
import { extractMetadata } from '#metadata.ts';

type FixAnnotation =
	{ error: string; label: string; state: 'failed' } | { label: string; state: 'detected' };

type Repair =
	| { annotation?: FixAnnotation; kind: 'unrepaired' }
	| { kind: 'fixed'; label: string }
	| { kind: 'interrupted' };

interface VerifyContext {
	db: Database.Database;
	fix: boolean;
	logPath: string;
	signal: StopSignal;
	verifier: FormatVerifier;
}

export type CorruptOutcome = Extract<VerifyOutcome, { kind: 'corrupt' }>;

export type VerifyOutcome =
	| {
			errorOutput: string;
			errorTimestamp: null | string;
			fix?: FixAnnotation;
			issue: { acknowledged: boolean; kind: CorruptKind };
			kind: 'corrupt';
			lastHealthyAt: null | string;
	  }
	| { kind: 'fixed'; label: string }
	| { kind: 'healthy' }
	| { kind: 'interrupted' };

export async function verifyAndRecord(
	context: VerifyContext,
	file: FileRow,
): Promise<VerifyOutcome> {
	const { db, signal, verifier } = context;
	const filePath = file.current_path;

	const result = await verifyOnce(verifier, filePath, signal);
	if (result.status === 'interrupted') return { kind: 'interrupted' };

	if (result.status === 'healthy') {
		recordVerdict(db, filePath, { status: 'healthy' });
		return { kind: 'healthy' };
	}

	const repair = await repairOrAnnotate(context, filePath, result.errorOutput);
	if (repair.kind !== 'unrepaired') return repair;

	recordCorrupt(context, file, result);
	await refreshMissingMetadata(db, file);
	return {
		errorOutput: result.errorOutput,
		errorTimestamp: result.errorTimestamp,
		issue: classifyCorrupt(file),
		kind: 'corrupt',
		lastHealthyAt: file.last_healthy_at,
		...(repair.annotation && { fix: repair.annotation }),
	};
}

function isMetadataEmpty(file: FileRow): boolean {
	return !file.artist && !file.title && !file.album && !file.date && !file.duration;
}

function recordCorrupt(
	{ db, logPath }: VerifyContext,
	file: FileRow,
	result: Extract<VerificationResult, { status: 'corrupt' }>,
) {
	// Record the original verify error, not the post-fix re-verify's
	recordVerdict(db, file.current_path, {
		errorOutput: result.errorOutput,
		errorTimestamp: result.errorTimestamp,
		status: 'corrupt',
	});
	logCorruption(logPath, file.current_path, {
		details: result.errorOutput.replaceAll('\n', ' '),
		known: file.acknowledged_at !== null,
		lastHealthyAt: file.last_healthy_at,
	});
}

async function refreshMissingMetadata(db: Database.Database, file: FileRow) {
	if (!isMetadataEmpty(file)) return;
	const metadata = await extractMetadata(file.current_path);
	if (metadata) recordMetadata(db, file.current_path, metadata);
}

function recordFixed(db: Database.Database, filePath: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		// File vanished after the fix; the next scan will prune or rediscover it
		return false;
	}
	recordReadable(db, [{ identity: identityOf(stat), path: filePath }]);
	recordVerdict(db, filePath, { status: 'healthy' });
	return true;
}

async function repairOrAnnotate(
	{ db, fix, logPath, verifier }: VerifyContext,
	filePath: string,
	errorOutput: string,
): Promise<Repair> {
	const fixer = verifier.fixer;
	if (!fixer?.detect(errorOutput)) return { kind: 'unrepaired' };
	if (!fix) {
		logFixDetected(logPath, filePath, fixer.label);
		return { annotation: { label: fixer.label, state: 'detected' }, kind: 'unrepaired' };
	}

	const fixResult = await fixer.fix(filePath);
	if (!fixResult.ok) {
		const error = fixResult.error ?? 'unknown';
		logFixFailed(logPath, filePath, { error, label: fixer.label });
		return { annotation: { error, label: fixer.label, state: 'failed' }, kind: 'unrepaired' };
	}

	const recheck = await verifier.verify(filePath);
	if (recheck.status !== 'healthy') return { kind: 'unrepaired' };
	if (!recordFixed(db, filePath)) return { kind: 'interrupted' };
	logFixApplied(logPath, filePath, fixer.label);
	return { kind: 'fixed', label: fixer.label };
}

async function verifyOnce(
	verifier: FormatVerifier,
	filePath: string,
	signal: StopSignal,
): Promise<VerificationResult> {
	try {
		return await verifier.verify(filePath);
	} catch (error) {
		// A throw is a tool failure, not a file verdict; recording corruption would poison the DB
		if (signal.aborted) return { status: 'interrupted' };
		throw error;
	}
}
