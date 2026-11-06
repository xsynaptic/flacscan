import path from 'node:path';

export interface RecoveryClassification {
	accepted: boolean;
	detail: null | string;
	lostSamples: null | number;
}

// flac stops at the first decode error, so missing audio is always the tail `[delivered, claimed)`
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
		return {
			accepted: false,
			detail: 'decodes fully, no truncation (re-encode would keep the corruption)',
			lostSamples: 0,
		};
	}

	const lostSamples = claimedSamples - deliveredSamples;
	const lostSeconds = lostSamples / sampleRate;
	if (lostSeconds > maxTrailingLossSeconds) {
		const printedLoss = Math.ceil((lostSamples * 100) / sampleRate) / 100;
		return {
			accepted: false,
			detail: `trailing loss ${printedLoss.toFixed(2)}s exceeds the ${String(maxTrailingLossSeconds)}s limit`,
			lostSamples,
		};
	}
	if (!reencodeVerified) {
		return { accepted: false, detail: 're-encode failed verification', lostSamples };
	}
	return { accepted: true, detail: null, lostSamples };
}

const RECOVERED_SUFFIX = ' [Recovered]';

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

export function originalNameForRecoveredFile(fileName: string): null | string {
	const extension = path.extname(fileName);
	const base = path.basename(fileName, extension);
	if (!base.endsWith(RECOVERED_SUFFIX)) return null;
	return base.slice(0, -RECOVERED_SUFFIX.length) + extension;
}

export function recoveredFilePath(originalPath: string): string {
	const extension = path.extname(originalPath);
	const base = path.basename(originalPath, extension);
	return path.join(path.dirname(originalPath), `${base}${RECOVERED_SUFFIX}${extension}`);
}
