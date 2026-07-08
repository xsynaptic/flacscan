import type { FormatVerifier, VerificationResult } from '../types.js';

import { execFile, extractStderr } from '../../shell.js';
import { hasId3Tags, stripId3Tags } from './fix-id3.js';

// The verifier only identifies failure; it captures stderr and the offset where decoding
// first failed. Severity (`recoverable`/`critical`/`unknown`) is decided by the caller via
// `classifyCorruptFile` in `src/verifiers/severity.ts`, which has config + can probe with
// metaflac to compute the actual scan-time prediction of `recover`'s outcome.
async function verifyFile(filePath: string): Promise<VerificationResult> {
	try {
		await execFile('nice', ['-n', '19', 'flac', '-ts', filePath]);
		return { status: 'healthy' };
	} catch (error: unknown) {
		const signal =
			error instanceof Error && 'signal' in error ? (error as { signal: unknown }).signal : null;
		if (signal === 'SIGINT' || signal === 'SIGTERM') {
			return { status: 'interrupted' };
		}
		const code =
			error instanceof Error && 'code' in error ? (error as { code: unknown }).code : null;
		if (typeof code === 'string') {
			// Spawn failure (EMFILE/ENOENT) is the OS refusing, not a file verdict
			throw error;
		}
		if (typeof signal === 'string') {
			// Decoder crash is a verdict about the file
			const stderr = extractStderr(error);
			return {
				errorOutput: `flac terminated by ${signal}${stderr ? `: ${stderr}` : ''}`,
				errorTimestamp: null,
				status: 'corrupt',
			};
		}
		const errorOutput = extractStderr(error);
		return {
			errorOutput,
			errorTimestamp: extractErrorTimestamp(errorOutput),
			status: 'corrupt',
		};
	}
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
