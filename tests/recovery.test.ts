import { describe, expect, it } from 'vitest';

import {
	classifyRecovery,
	findSpaceViolations,
	originalNameForRecoveredFile,
	recoveredFilePath,
} from '../src/recovery.js';

const base = {
	claimedSamples: 1_000_000,
	deliveredSamples: 990_000,
	maxTrailingLossSeconds: 3,
	reencodeVerified: true,
	sampleRate: 44_100,
};

describe('classifyRecovery', () => {
	it('accepts a clean re-encode that lost only a small tail', () => {
		const result = classifyRecovery({ ...base, deliveredSamples: 1_000_000 - 44_100 });
		expect(result.accepted).toBe(true);
		expect(result.detail).toBeNull();
		expect(result.lostSamples).toBe(44_100);
	});

	it('accepts loss exactly at the limit', () => {
		// 3.0s at 44.1kHz = 132300 samples lost off the tail.
		const result = classifyRecovery({ ...base, deliveredSamples: 1_000_000 - 132_300 });
		expect(result.accepted).toBe(true);
		expect(result.lostSamples).toBe(132_300);
	});

	it('rejects loss one sample over the limit', () => {
		const result = classifyRecovery({ ...base, deliveredSamples: 1_000_000 - 132_301 });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('exceeds');
		expect(result.lostSamples).toBe(132_301);
	});

	it('rejects when the claimed length is unknown', () => {
		const result = classifyRecovery({ ...base, claimedSamples: 0 });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('unknown length');
		expect(result.lostSamples).toBeNull();
	});

	it('rejects when the sample rate is unknown', () => {
		const result = classifyRecovery({ ...base, sampleRate: 0 });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('sample rate');
	});

	it('rejects when the decode produced nothing', () => {
		const result = classifyRecovery({ ...base, deliveredSamples: 0 });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('no usable audio');
		expect(result.lostSamples).toBe(1_000_000);
	});

	it('rejects a fully-decoded file with no truncation (MD5-only mismatch)', () => {
		const result = classifyRecovery({ ...base, deliveredSamples: 1_000_000 });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('no truncation');
		expect(result.lostSamples).toBe(0);
	});

	it('rejects when the re-encode failed verification', () => {
		const result = classifyRecovery({ ...base, reencodeVerified: false });
		expect(result.accepted).toBe(false);
		expect(result.detail).toContain('verification');
		expect(result.lostSamples).toBe(10_000);
	});
});

describe('recoveredFilePath', () => {
	it('inserts the [Recovered] suffix before the extension', () => {
		expect(recoveredFilePath('/music/A/01 - Track.flac')).toBe(
			'/music/A/01 - Track [Recovered].flac',
		);
		expect(recoveredFilePath('Track.flac')).toBe('Track [Recovered].flac');
	});
});

describe('originalNameForRecoveredFile', () => {
	it('round-trips the recovered suffix', () => {
		expect(originalNameForRecoveredFile('Song [Recovered].flac')).toBe('Song.flac');
		expect(originalNameForRecoveredFile('01 - Track [Recovered].flac')).toBe('01 - Track.flac');
	});

	it('returns null for plain filenames or unrelated bracketed text', () => {
		expect(originalNameForRecoveredFile('Track.flac')).toBeNull();
		expect(originalNameForRecoveredFile('Track [Live].flac')).toBeNull();
		expect(originalNameForRecoveredFile('Track [Recoverable].flac')).toBeNull();
		expect(originalNameForRecoveredFile('Track [Recovered] (remix).flac')).toBeNull();
	});

	it('ignores any leading directory in the name', () => {
		expect(originalNameForRecoveredFile('A/B/Song [Recovered].flac')).toBe('Song.flac');
	});
});

describe('findSpaceViolations', () => {
	it('returns nothing when every volume fits with margin', () => {
		const items = [
			{ dev: 1, size: 100 },
			{ dev: 1, size: 200 },
			{ dev: 2, size: 50 },
		];
		const volumes = [
			{ dev: 1, freeBytes: 1000 },
			{ dev: 2, freeBytes: 1000 },
		];
		expect(findSpaceViolations(items, volumes, 500)).toEqual([]);
	});

	it('treats a volume that ends exactly at the buffer as fitting', () => {
		expect(
			findSpaceViolations([{ dev: 1, size: 500 }], [{ dev: 1, freeBytes: 1000 }], 500),
		).toEqual([]);
	});

	it('flags a single volume that comes up short', () => {
		expect(
			findSpaceViolations([{ dev: 1, size: 600 }], [{ dev: 1, freeBytes: 1000 }], 500),
		).toEqual([{ dev: 1, freeBytes: 1000, requiredBytes: 1100, shortfallBytes: 100 }]);
	});

	it('reports each short volume independently', () => {
		const items = [
			{ dev: 1, size: 900 },
			{ dev: 2, size: 100 },
			{ dev: 3, size: 950 },
		];
		const volumes = [
			{ dev: 1, freeBytes: 1000 },
			{ dev: 2, freeBytes: 1000 },
			{ dev: 3, freeBytes: 1000 },
		];
		expect(findSpaceViolations(items, volumes, 200)).toEqual([
			{ dev: 1, freeBytes: 1000, requiredBytes: 1100, shortfallBytes: 100 },
			{ dev: 3, freeBytes: 1000, requiredBytes: 1150, shortfallBytes: 150 },
		]);
	});

	it('requires the buffer even on a volume with no copies queued', () => {
		expect(findSpaceViolations([], [{ dev: 1, freeBytes: 100 }], 500)).toEqual([
			{ dev: 1, freeBytes: 100, requiredBytes: 500, shortfallBytes: 400 },
		]);
	});

	it('returns nothing when there are no volumes', () => {
		expect(findSpaceViolations([{ dev: 1, size: 100 }], [], 500)).toEqual([]);
	});
});
