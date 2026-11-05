import { describe, expect, it } from 'vitest';

import { hasId3Tags } from '#verifiers/flac/fix-id3.ts';

describe('hasId3Tags', () => {
	it('returns true for ID3v2 tag found', () => {
		expect(hasId3Tags('ID3v2 tag found')).toBe(true);
	});

	it('returns true for looks like an ID3v1 tag', () => {
		expect(hasId3Tags('looks like an ID3v1 tag')).toBe(true);
	});

	it('returns false for unrelated text', () => {
		expect(hasId3Tags('FRAME_CRC_MISMATCH')).toBe(false);
	});
});
