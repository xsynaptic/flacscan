import { describe, expect, it } from 'vitest';

import { extractErrorTimestamp } from '../../../src/verifiers/flac/verify.js';

describe('extractErrorTimestamp', () => {
	it('extracts sample number', () => {
		expect(extractErrorTimestamp('error after processing 12345 samples')).toBe('sample 12345');
	});

	it('returns null when no match', () => {
		expect(extractErrorTimestamp('some unrelated error')).toBeNull();
	});
});
