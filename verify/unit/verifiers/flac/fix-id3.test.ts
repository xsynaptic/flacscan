import { describe, expect, it, vi } from 'vitest';

import { execFile } from '#shell.ts';
import { hasId3Tags, stripId3Tags } from '#verifiers/flac/fix-id3.ts';

vi.mock('#shell.ts', async (importActual) => ({
	...(await importActual<typeof import('#shell.ts')>()),
	execFile: vi.fn(),
}));

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

describe('stripId3Tags', () => {
	it('deletes every ID3 tag from the file with id3v2', async () => {
		vi.mocked(execFile).mockResolvedValueOnce({ stderr: '', stdout: '' });

		expect(await stripId3Tags('/music/a.flac')).toEqual({ ok: true });
		expect(execFile).toHaveBeenCalledWith('id3v2', ['--delete-all', '/music/a.flac']);
	});

	it('reports the trimmed stderr when id3v2 fails', async () => {
		vi.mocked(execFile).mockRejectedValueOnce(
			Object.assign(new Error('exit 1'), { stderr: ' id3v2: permission denied\n' }),
		);

		expect(await stripId3Tags('/music/a.flac')).toEqual({
			error: 'id3v2: permission denied',
			ok: false,
		});
	});
});
