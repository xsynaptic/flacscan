import { describe, expect, it } from 'vitest';

import { hasId3Tags } from '../../src/flac/fix-id3.js';

describe('hasId3Tags', () => {
	it('returns true for ID3v2 tag found', () => {
		expect(hasId3Tags('ID3v2 tag found')).toBe(true);
	});

	it('returns true for looks like an ID3v1 tag', () => {
		expect(hasId3Tags('looks like an ID3v1 tag')).toBe(true);
	});

	it('is case insensitive', () => {
		expect(hasId3Tags('id3v2 TAG FOUND')).toBe(true);
	});

	it('returns false for unrelated text', () => {
		expect(hasId3Tags('FRAME_CRC_MISMATCH')).toBe(false);
	});

	it('returns true when ID3 message is among other lines', () => {
		const multiline = 'some error\nID3v2 tag found\nanother line';
		expect(hasId3Tags(multiline)).toBe(true);
	});
});
