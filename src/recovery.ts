// Pure helpers for recover: the accept/reject rule, `[Recovered].flac` naming, and the
// per-volume disk-space check. No I/O, no CLI deps.

import path from 'node:path';

// The reference decoder, in its default mode, stops at the first decode error, so it emits
// a contiguous run `[0 .. delivered)` and nothing after. Whatever audio is missing is
// therefore provably the *tail* (`[delivered .. claimed)`). `classifyRecovery` keeps the
// re-encode only when that tail loss is small, the decoder actually truncated (so this
// isn't a fully-decodable file with an un-glitch-detected MD5 mismatch), the claimed length
// is known, and the re-encoded file itself passes `flac -t`.

export interface RecoveryClassification {
	accepted: boolean;
	// Reason text when rejected (maps to `recovery_detail`); null when accepted.
	detail: null | string;
	// `claimed - delivered`, the audio lost off the end; null when the claimed length is unknown.
	lostSamples: null | number;
}

export function classifyRecovery(input: {
	claimedSamples: number;
	deliveredSamples: number;
	maxTrailingLossSeconds: number;
	reencodeVerified: boolean;
	sampleRate: number;
}): RecoveryClassification {
	const { claimedSamples, deliveredSamples, maxTrailingLossSeconds, reencodeVerified, sampleRate } =
		input;

	if (claimedSamples <= 0) {
		return {
			accepted: false,
			detail: 'unknown length (STREAMINFO total samples = 0)',
			lostSamples: null,
		};
	}
	if (sampleRate <= 0) {
		return { accepted: false, detail: 'unknown sample rate', lostSamples: null };
	}
	if (deliveredSamples <= 0) {
		return {
			accepted: false,
			detail: 'decode produced no usable audio',
			lostSamples: claimedSamples,
		};
	}
	if (deliveredSamples >= claimedSamples) {
		// Decoded the whole stream without truncating e.g. an MD5-only mismatch. A re-encode
		// would just carry the un-glitch-detected corruption forward, so it isn't a clean copy.
		return {
			accepted: false,
			detail: 'decodes fully, no truncation (re-encode would keep the corruption)',
			lostSamples: 0,
		};
	}

	const lostSamples = claimedSamples - deliveredSamples;
	const lostSeconds = lostSamples / sampleRate;
	if (lostSeconds > maxTrailingLossSeconds) {
		return {
			accepted: false,
			detail: `trailing loss ${lostSeconds.toFixed(1)}s exceeds the ${maxTrailingLossSeconds.toFixed(1)}s limit`,
			lostSamples,
		};
	}
	if (!reencodeVerified) {
		return { accepted: false, detail: 're-encode failed verification', lostSamples };
	}
	return { accepted: true, detail: null, lostSamples };
}

const RECOVERED_SUFFIX = ' [Recovered]';
// Matches the trailing " [Recovered]" on a file's basename (extension already removed).
const RECOVERED_BASENAME_RE = / \[Recovered\]$/;

/** Per volume, flag any that can't hold its pending recovered files while keeping `minFreeBytes` free; empty array means all fit. Pure. */
export function findSpaceViolations(
	items: readonly { dev: number; size: number }[],
	volumes: readonly { dev: number; freeBytes: number }[],
	minFreeBytes: number,
): { dev: number; freeBytes: number; requiredBytes: number; shortfallBytes: number }[] {
	const bytesByDev = new Map<number, number>();
	for (const item of items) {
		bytesByDev.set(item.dev, (bytesByDev.get(item.dev) ?? 0) + item.size);
	}

	const violations: {
		dev: number;
		freeBytes: number;
		requiredBytes: number;
		shortfallBytes: number;
	}[] = [];
	for (const volume of volumes) {
		const requiredBytes = (bytesByDev.get(volume.dev) ?? 0) + minFreeBytes;
		if (volume.freeBytes < requiredBytes) {
			violations.push({
				dev: volume.dev,
				freeBytes: volume.freeBytes,
				requiredBytes,
				shortfallBytes: requiredBytes - volume.freeBytes,
			});
		}
	}
	return violations;
}

/**
 * If `fileName` looks like a recovered file (`Track [Recovered].flac`), the name of the
 * original it was made from (`Track.flac`); otherwise `null`. Used by discovery to skip a
 * recovered file only while its original is still present alongside it.
 */
export function originalNameForRecoveredFile(fileName: string): null | string {
	const extension = path.extname(fileName);
	const base = path.basename(fileName, extension);
	if (!RECOVERED_BASENAME_RE.test(base)) return null;
	return base.replace(RECOVERED_BASENAME_RE, '') + extension;
}

/**
 * Path of the re-encoded copy `recover` writes next to `originalPath`; the suffix goes
 * before the extension so the `.flac` stays last (`Track.flac` → `Track [Recovered].flac`).
 */
export function recoveredFilePath(originalPath: string): string {
	const extension = path.extname(originalPath);
	const base = path.basename(originalPath, extension);
	return path.join(path.dirname(originalPath), `${base}${RECOVERED_SUFFIX}${extension}`);
}
