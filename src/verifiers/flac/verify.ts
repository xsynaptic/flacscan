import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import { execFile, extractStderr } from '#shell.ts';
import { hasId3Tags, stripId3Tags } from '#verifiers/flac/fix-id3.ts';

async function verifyFile(filePath: string): Promise<VerificationResult> {
	try {
		await execFile('nice', ['-n', '19', 'flac', '-ts', filePath]);
		return { status: 'healthy' };
	} catch (error: unknown) {
		return failureVerdict(error);
	}
}

function failureVerdict(error: unknown): VerificationResult {
	const { code, signal } = readExecFailure(error);
	if (signal === 'SIGINT' || signal === 'SIGTERM') {
		return { status: 'interrupted' };
	}
	if (typeof code === 'string') {
		// Spawn failure (EMFILE/ENOENT) is the OS refusing, not a file verdict
		throw error;
	}
	const stderr = extractStderr(error);
	if (typeof signal === 'string') {
		// Decoder crash is a verdict about the file
		return {
			errorOutput: `flac terminated by ${signal}${stderr ? `: ${stderr}` : ''}`,
			errorTimestamp: null,
			status: 'corrupt',
		};
	}
	return { errorOutput: stderr, errorTimestamp: extractErrorTimestamp(stderr), status: 'corrupt' };
}

function readExecFailure(error: unknown): { code: unknown; signal: unknown } {
	if (!(error instanceof Error)) return { code: null, signal: null };
	const failure = error as Error & { code?: unknown; signal?: unknown };
	return {
		code: 'code' in error ? failure.code : null,
		signal: 'signal' in error ? failure.signal : null,
	};
}

const SAMPLES_PATTERN = /after processing (\d+) samples/;

export function extractErrorTimestamp(stderr: string): null | string {
	const match = SAMPLES_PATTERN.exec(stderr);
	if (!match?.[1]) return null;
	return `sample ${match[1]}`;
}

export const flacVerifier: FormatVerifier = {
	extensions: ['.flac'],
	fixer: {
		detect: hasId3Tags,
		fix: stripId3Tags,
		label: 'ID3',
		requiredBinaries: [{ hint: 'brew install id3v2', name: 'id3v2' }],
	},
	requiredBinaries: [{ name: 'flac' }],
	verify: verifyFile,
};
