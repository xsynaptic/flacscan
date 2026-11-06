import { fc, test } from '@fast-check/vitest';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	classifyRecovery,
	findSpaceViolations,
	originalNameForRecoveredFile,
	recoveredFilePath,
} from '#recovery.ts';

const recoveryInput = fc
	.record(
		{
			claimedSamples: fc.integer({ max: 2000, min: -1 }),
			deliveredAt: fc.constantFrom(
				'anywhere',
				'everything',
				'nothing',
				'limitMinusOne',
				'limit',
				'limitPlusOne',
			),
			deliveredSamples: fc.integer({ max: 2000, min: -1 }),
			maxTrailingLossSeconds: fc.integer({ max: 4, min: 1 }),
			reencodeVerified: fc.boolean(),
			sampleRate: fc.constantFrom(0, 100, 441),
		},
		{ noNullPrototype: true },
	)
	.map(({ deliveredAt, ...input }) => {
		if (deliveredAt === 'anywhere') return input;
		if (deliveredAt === 'everything') return { ...input, deliveredSamples: input.claimedSamples };
		if (deliveredAt === 'nothing') return { ...input, deliveredSamples: 0 };
		const limit = input.maxTrailingLossSeconds * input.sampleRate;
		const lossByBoundary = { limit, limitMinusOne: limit - 1, limitPlusOne: limit + 1 } as const;
		return { ...input, deliveredSamples: input.claimedSamples - lossByBoundary[deliveredAt] };
	});

const namePiece = fc.constantFrom(
	'a',
	'B',
	' ',
	'.',
	'..',
	'[',
	']',
	' [Recovered]',
	'[Recovered]',
	'.flac',
	'.FLAC',
);
const fileName = fc
	.array(namePiece, { maxLength: 5, minLength: 1 })
	.map((pieces) => pieces.join(''))
	.filter((name) => name !== '.' && name !== '..');
const normalizedPath = fc
	.tuple(fc.array(fc.constantFrom('music', 'Album [Recovered]', 'x.y'), { maxLength: 2 }), fileName)
	.map(([directories, name]) => path.join('/', ...directories, name));

describe('classifyRecovery', () => {
	test.prop([recoveryInput], { numRuns: 2000 })(
		'accepts exactly a verified, truncated, non-empty decode within the tail-loss limit',
		(input) => {
			const lost = input.claimedSamples - input.deliveredSamples;
			const expected =
				input.reencodeVerified &&
				input.sampleRate > 0 &&
				input.deliveredSamples > 0 &&
				lost > 0 &&
				lost <= input.maxTrailingLossSeconds * input.sampleRate;

			const result = classifyRecovery(input);

			expect(result.accepted).toBe(expected);
			expect(result.detail === null).toBe(expected);
			if (expected) expect(result.lostSamples).toBe(lost);
		},
	);

	const overLimitLoss = fc
		.record(
			{
				limitCents: fc.integer({ max: 400, min: 1 }),
				sampleRate: fc.constantFrom(100, 441, 44_100, 48_000),
				samplesOverLimit: fc.integer({ max: 3, min: 1 }),
			},
			{ noNullPrototype: true },
		)
		.map(({ limitCents, sampleRate, samplesOverLimit }) => {
			const maxTrailingLossSeconds = limitCents / 100;
			const lostSamples = Math.floor((limitCents * sampleRate) / 100) + samplesOverLimit;
			const claimedSamples = lostSamples + 1000;
			return {
				claimedSamples,
				deliveredSamples: claimedSamples - lostSamples,
				maxTrailingLossSeconds,
				reencodeVerified: true,
				sampleRate,
			};
		});

	test.prop([overLimitLoss], { numRuns: 2000 })(
		'names a rejected loss with a figure above the limit it names, for limits of at most two decimals',
		(input) => {
			const { detail } = classifyRecovery(input);
			const figures = /^trailing loss (\d+\.\d{2})s exceeds the (\d+(?:\.\d{1,2})?)s limit$/.exec(
				detail ?? '',
			);

			expect(figures).not.toBeNull();
			expect(Number(figures?.[1])).toBeGreaterThan(Number(figures?.[2]));
			expect(Number(figures?.[2])).toBe(input.maxTrailingLossSeconds);
		},
	);

	it('rounds a loss just over the limit up rather than to the limit', () => {
		const result = classifyRecovery({
			claimedSamples: 1000,
			deliveredSamples: 696,
			maxTrailingLossSeconds: 3,
			reencodeVerified: true,
			sampleRate: 100,
		});

		expect(result.detail).toBe('trailing loss 3.04s exceeds the 3s limit');
	});
});

describe('recovered file naming', () => {
	test.prop([normalizedPath], { numRuns: 2000 })(
		'names a recovered file beside its original, and maps it back to that original',
		(originalPath) => {
			const recovered = recoveredFilePath(originalPath);

			expect(recovered).not.toBe(originalPath);
			expect(path.dirname(recovered)).toBe(path.dirname(originalPath));
			expect(originalNameForRecoveredFile(path.basename(recovered))).toBe(
				path.basename(originalPath),
			);
		},
	);

	test.prop([normalizedPath, normalizedPath], { numRuns: 2000 })(
		'never gives two originals the same recovered path',
		(left, right) => {
			fc.pre(left !== right);

			expect(recoveredFilePath(left)).not.toBe(recoveredFilePath(right));
		},
	);
});

describe('findSpaceViolations', () => {
	const device = fc.integer({ max: 3, min: 1 });
	const items = fc.array(
		fc.record({ dev: device, size: fc.nat({ max: 50 }) }, { noNullPrototype: true }),
		{
			maxLength: 6,
		},
	);
	const volumes = fc.uniqueArray(
		fc.record({ dev: device, freeBytes: fc.nat({ max: 200 }) }, { noNullPrototype: true }),
		{
			selector: (volume) => volume.dev,
		},
	);

	test.prop([items, volumes, fc.nat({ max: 100 })], { numRuns: 2000 })(
		'flags exactly the volumes whose queued copies would leave less than the buffer free',
		(queued, mounted, minFreeBytes) => {
			const flagged = findSpaceViolations(queued, mounted, minFreeBytes);

			for (const volume of mounted) {
				const queuedBytes = queued
					.filter((item) => item.dev === volume.dev)
					.reduce((total, item) => total + item.size, 0);
				const violation = flagged.find((entry) => entry.dev === volume.dev);
				expect(violation !== undefined).toBe(volume.freeBytes - queuedBytes < minFreeBytes);
				if (violation)
					expect(violation.shortfallBytes).toBe(queuedBytes + minFreeBytes - volume.freeBytes);
			}
			expect(flagged.every((entry) => mounted.some((volume) => volume.dev === entry.dev))).toBe(
				true,
			);
		},
	);
});
