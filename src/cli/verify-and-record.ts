import type Database from 'better-sqlite3';

import fs from 'node:fs';

import type { FileRow } from '#database/types.ts';
import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import { isShuttingDown } from '#cli/process-pool.ts';
import { updateMetadata, updateVerificationResult, upsertFile } from '#database/queries.ts';
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
	verifier: FormatVerifier;
}

export type VerifyOutcome =
	| {
			errorOutput: string;
			errorTimestamp: null | string;
			fix?: FixAnnotation;
			kind: 'corrupt';
	  }
	| { kind: 'fixed'; label: string }
	| { kind: 'healthy' }
	| { kind: 'interrupted' };

export async function verifyAndRecord(
	context: VerifyContext,
	file: FileRow,
): Promise<VerifyOutcome> {
	const { db, verifier } = context;
	const filePath = file.current_path;

	const result = await verifyOnce(verifier, filePath);
	if (result.status === 'interrupted') return { kind: 'interrupted' };

	if (result.status === 'healthy') {
		updateVerificationResult(db, filePath, { last_result: 'healthy' });
		return { kind: 'healthy' };
	}

	const repair = await repairOrAnnotate(context, filePath, result.errorOutput);
	if (repair.kind !== 'unrepaired') return repair;

	await recordCorrupt(db, file, result);
	return {
		errorOutput: result.errorOutput,
		errorTimestamp: result.errorTimestamp,
		kind: 'corrupt',
		...(repair.annotation && { fix: repair.annotation }),
	};
}

function isMetadataEmpty(file: FileRow): boolean {
	return !file.artist && !file.title && !file.album && !file.date && !file.duration;
}

async function recordCorrupt(
	db: Database.Database,
	file: FileRow,
	result: Extract<VerificationResult, { status: 'corrupt' }>,
) {
	// Record the original verify error, not the post-fix re-verify's
	updateVerificationResult(db, file.current_path, {
		error_output: result.errorOutput,
		error_timestamp: result.errorTimestamp,
		last_result: 'corrupt',
	});

	if (!isMetadataEmpty(file)) return;
	const metadata = await extractMetadata(file.current_path);
	if (metadata) updateMetadata(db, file.current_path, metadata);
}

function recordFixed(db: Database.Database, filePath: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		// File vanished after the fix; the next scan will prune or rediscover it
		return false;
	}
	upsertFile(db, {
		current_path: filePath,
		file_mtime: stat.mtime.toISOString(),
		file_size: stat.size,
	});
	updateVerificationResult(db, filePath, { last_result: 'healthy' });
	return true;
}

async function repairOrAnnotate(
	{ db, fix, verifier }: VerifyContext,
	filePath: string,
	errorOutput: string,
): Promise<Repair> {
	const fixer = verifier.fixer;
	if (!fixer?.detect(errorOutput)) return { kind: 'unrepaired' };
	if (!fix) return { annotation: { label: fixer.label, state: 'detected' }, kind: 'unrepaired' };

	const fixResult = await fixer.fix(filePath);
	if (!fixResult.ok) {
		return {
			annotation: { error: fixResult.error ?? 'unknown', label: fixer.label, state: 'failed' },
			kind: 'unrepaired',
		};
	}

	const recheck = await verifier.verify(filePath);
	if (recheck.status !== 'healthy') return { kind: 'unrepaired' };
	if (!recordFixed(db, filePath)) return { kind: 'interrupted' };
	return { kind: 'fixed', label: fixer.label };
}

async function verifyOnce(verifier: FormatVerifier, filePath: string): Promise<VerificationResult> {
	try {
		return await verifier.verify(filePath);
	} catch (error) {
		// A throw is a tool failure, not a file verdict; recording corruption would poison the DB
		if (isShuttingDown()) return { status: 'interrupted' };
		throw error;
	}
}
