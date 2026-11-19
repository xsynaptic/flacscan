import { describe, expect, it } from 'vitest';

import { FlacScanError } from '#errors.ts';
import { ensureBinary, extractStderr } from '#shell.ts';

describe('extractStderr', () => {
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

describe('ensureBinary', () => {
	const missing = 'flacscan-test-no-such-binary';

	it('resolves for a binary that answers --version', async () => {
		await expect(ensureBinary(process.execPath)).resolves.toBeUndefined();
	});

	it('names a missing binary with its install hint', async () => {
		const failure = ensureBinary(missing, 'brew install flac');

		await expect(failure).rejects.toThrow(FlacScanError);
		await expect(failure).rejects.toThrow(`${missing} must be installed (brew install flac)`);
	});

	it('asks for the binary on PATH when there is no hint', async () => {
		await expect(ensureBinary(missing)).rejects.toThrow(`${missing} must be installed and on PATH`);
	});
});
