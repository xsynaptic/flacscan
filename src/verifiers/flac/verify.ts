import type { ErrorSeverity, FormatVerifier, VerificationResult } from '../types.js';

import { execFile, extractStderr } from '../../shell.js';
import { hasId3Tags, stripId3Tags } from './fix-id3.js';

async function verifyFile(filePath: string): Promise<VerificationResult> {
	try {
		await execFile('nice', ['-n', '19', 'flac', '-ts', filePath]);
		return { status: 'healthy' };
	} catch (error: unknown) {
		if (error instanceof Error && 'signal' in error && error.signal) {
			return { status: 'interrupted' };
		}

		const errorOutput = extractStderr(error);
		return {
			errorOutput,
			errorTimestamp: extractErrorTimestamp(errorOutput),
			severity: classifyError(errorOutput),
			status: 'corrupt',
		};
	}
}

// Specific, explanatory patterns checked first — most diagnostic value
// Structural/total damage: truncation, unparseable data, premature EOF
const CRITICAL_PATTERNS = [
	'decoded number of samples is smaller than the total number of samples',
	'OUT_OF_BOUNDS',
	'UNPARSEABLE_STREAM',
	'unexpected EOF',
	'got 0 bytes from read callback',
];

// Localized frame damage (potentially recoverable via re-encode)
const RECOVERABLE_PATTERNS = ['FRAME_CRC_MISMATCH', 'MD5 signature mismatch'];

// Classification order: specific patterns → generic compound patterns → unknown
export function classifyError(stderr: string): ErrorSeverity {
	const hasCritical = CRITICAL_PATTERNS.some((p) => stderr.includes(p));
	if (hasCritical) return 'critical';

	const hasRecoverable = RECOVERABLE_PATTERNS.some((p) => stderr.includes(p));
	if (hasRecoverable) return 'recoverable';

	// LOST_SYNC + ABORTED = decoder gave up mid-file (major data loss)
	if (stderr.includes('LOST_SYNC') && stderr.includes('ABORTED')) return 'critical';

	// LOST_SYNC + END_OF_STREAM = tail damage, most of the track is intact
	if (stderr.includes('LOST_SYNC') && stderr.includes('END_OF_STREAM')) return 'recoverable';

	return 'unknown';
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
