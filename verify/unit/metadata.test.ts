import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#shell.ts', async (importActual) => {
	const actual = await importActual<typeof import('#shell.ts')>();
	return { ...actual, execFile: vi.fn() };
});

import { extractMetadata } from '#metadata.ts';
import { execFile } from '#shell.ts';

const mockExecFile = vi.mocked(execFile);

function metaflacOutputs(tags: string, samples: string) {
	mockExecFile.mockImplementation(((_file: string, args: string[]) =>
		Promise.resolve({
			stderr: '',
			stdout: args[0] === '--export-tags-to=-' ? tags : samples,
		})) as unknown as typeof execFile);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('extractMetadata', () => {
	it('keeps the first value of a repeated tag and matches keys case-insensitively', async () => {
		metaflacOutputs(
			'ARTIST=First\nartist=Second\nTitle=Song=Remix\nGENRE=Jazz\n',
			'441000\n44100\n',
		);

		expect(await extractMetadata('/music/a.flac')).toEqual({
			album: null,
			artist: 'First',
			date: null,
			duration: 10,
			title: 'Song=Remix',
		});
	});

	it('rounds the duration to hundredths', async () => {
		metaflacOutputs('', '100000\n44100\n');

		const metadata = await extractMetadata('/music/a.flac');

		expect(metadata?.duration).toBe(2.27);
	});

	it.each([
		['a zero sample rate', '441000\n0\n'],
		['a missing sample rate', '441000\n'],
		['non-numeric samples', 'many\n44100\n'],
		['a non-numeric sample rate', '441000\nfast\n'],
	])('leaves the duration null for %s', async (_label, samples) => {
		metaflacOutputs('ALBUM=Record\n', samples);

		const metadata = await extractMetadata('/music/a.flac');

		expect(metadata?.album).toBe('Record');
		expect(metadata?.duration).toBeNull();
	});

	it('returns null when metaflac fails', async () => {
		mockExecFile.mockRejectedValue(new Error('not a FLAC file'));

		expect(await extractMetadata('/music/a.flac')).toBeNull();
	});
});
