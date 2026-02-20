import { describe, expect, it } from 'vitest';

import { extractStderr } from '../../src/flac/shell.js';

describe('extractStderr', () => {
	it('extracts from zx-style error with stderr property', () => {
		const error = Object.assign(new Error('process failed'), {
			stderr: 'FRAME_CRC_MISMATCH at sample 1234',
		});
		expect(extractStderr(error)).toBe('FRAME_CRC_MISMATCH at sample 1234');
	});

	it('falls back to String() for plain Error', () => {
		const error = new Error('something broke');
		expect(extractStderr(error)).toBe('Error: something broke');
	});

	it('handles non-error values', () => {
		expect(extractStderr('raw string error')).toBe('raw string error');
		expect(extractStderr(42)).toBe('42');
	});

	it('trims whitespace', () => {
		const error = Object.assign(new Error('fail'), {
			stderr: '  some output\n  ',
		});
		expect(extractStderr(error)).toBe('some output');
	});
});
