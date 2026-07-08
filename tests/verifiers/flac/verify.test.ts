import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shell.js', async (importActual) => {
	const actual = await importActual<typeof import('../../../src/shell.js')>();
	return { ...actual, execFile: vi.fn() };
});

import { execFile } from '../../../src/shell.js';
import { extractErrorTimestamp, flacVerifier } from '../../../src/verifiers/flac/verify.js';

const mockExecFile = vi.mocked(execFile);

function execError(props: Record<string, unknown>): Error {
	return Object.assign(new Error('flac failed'), props);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('extractErrorTimestamp', () => {
	it('extracts sample number', () => {
		expect(extractErrorTimestamp('error after processing 12345 samples')).toBe('sample 12345');
	});

	it('returns null when no match', () => {
		expect(extractErrorTimestamp('some unrelated error')).toBeNull();
	});
});

describe('flacVerifier.verify', () => {
	it('returns healthy when flac exits cleanly', async () => {
		mockExecFile.mockResolvedValueOnce({ stderr: '', stdout: '' });
		expect(await flacVerifier.verify('/music/ok.flac')).toEqual({ status: 'healthy' });
	});

	it('returns corrupt with a sample offset on a non-zero exit', async () => {
		mockExecFile.mockRejectedValueOnce(
			execError({ code: 1, stderr: 'ERROR after processing 42 samples' }),
		);
		const result = await flacVerifier.verify('/music/bad.flac');
		expect(result.status).toBe('corrupt');
		if (result.status === 'corrupt') {
			expect(result.errorOutput).toContain('after processing 42 samples');
			expect(result.errorTimestamp).toBe('sample 42');
		}
	});

	it('records a corrupt verdict naming the signal when the decoder crashes', async () => {
		mockExecFile.mockRejectedValueOnce(
			execError({ code: null, signal: 'SIGSEGV', stderr: 'boom' }),
		);
		const result = await flacVerifier.verify('/music/crash.flac');
		expect(result.status).toBe('corrupt');
		if (result.status === 'corrupt') {
			expect(result.errorOutput).toContain('SIGSEGV');
			expect(result.errorTimestamp).toBeNull();
		}
	});

	it('treats a SIGINT as an interruption, not corruption', async () => {
		mockExecFile.mockRejectedValueOnce(execError({ code: null, signal: 'SIGINT' }));
		expect(await flacVerifier.verify('/music/x.flac')).toEqual({ status: 'interrupted' });
	});

	it('rethrows a spawn-level failure so it surfaces as a tool error', async () => {
		mockExecFile.mockRejectedValueOnce(execError({ code: 'EMFILE' }));
		await expect(flacVerifier.verify('/music/x.flac')).rejects.toThrow();
	});
});
