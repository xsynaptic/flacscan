import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { directoryPrefix, existsAsSpelled, onDiskSpelling } from '#paths.ts';

import { caseInsensitiveTmp } from './helpers.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
});

function touch(...segments: string[]): string {
	const filePath = path.join(tempDir, ...segments);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, '');
	return filePath;
}

describe('directoryPrefix', () => {
	it('appends a separator to a bare directory', () => {
		expect(directoryPrefix('/music')).toBe('/music/');
	});

	it('is idempotent when the directory already ends in a separator', () => {
		expect(directoryPrefix('/music/')).toBe('/music/');
	});
});

describe('existsAsSpelled', () => {
	it('is true for a file under its exact spelling, through a symlinked temp directory', () => {
		const filePath = touch('Album', 'Track.flac');

		expect(existsAsSpelled(filePath)).toBe(true);
	});

	it('is false for a missing file and for a file under a missing directory', () => {
		touch('Album', 'Track.flac');

		expect(existsAsSpelled(path.join(tempDir, 'Album', 'Other.flac'))).toBe(false);
		expect(existsAsSpelled(path.join(tempDir, 'Gone', 'Track.flac'))).toBe(false);
	});

	it('turns false once a file it already reported is deleted', () => {
		const filePath = touch('Album', 'Track.flac');
		expect(existsAsSpelled(filePath)).toBe(true);

		fs.rmSync(filePath);

		expect(existsAsSpelled(filePath)).toBe(false);
	});

	it('is true for both names of a hard-linked file', () => {
		const first = touch('Album', 'Alpha.flac');
		const second = path.join(tempDir, 'Album', 'beta.flac');
		fs.linkSync(first, second);

		expect([existsAsSpelled(first), existsAsSpelled(second)]).toEqual([true, true]);
	});

	it('follows a symlinked directory under the spelling of the link', () => {
		touch('Target', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Target'), path.join(tempDir, 'Link'));

		expect(existsAsSpelled(path.join(tempDir, 'Link', 'Track.flac'))).toBe(true);
	});

	it.runIf(caseInsensitiveTmp)('is false for a case alias of the file or of a directory', () => {
		const filePath = touch('Album', 'Track.flac');

		expect(existsAsSpelled(path.join(tempDir, 'Album', 'track.flac'))).toBe(false);
		expect(existsAsSpelled(path.join(tempDir, 'album', 'Track.flac'))).toBe(false);
		expect(existsAsSpelled(filePath)).toBe(true);
	});

	it('keeps the spelling of a symlink whose target differs from it only in case', () => {
		touch('Other', 'album', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Other', 'album'), path.join(tempDir, 'Album'));

		expect(existsAsSpelled(path.join(tempDir, 'Album', 'Track.flac'))).toBe(true);
	});

	it.runIf(caseInsensitiveTmp)('is false for a case alias of a symlink', () => {
		touch('Target', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Target'), path.join(tempDir, 'Link'));

		expect(existsAsSpelled(path.join(tempDir, 'link', 'Track.flac'))).toBe(false);
	});
});

describe('onDiskSpelling', () => {
	it.runIf(caseInsensitiveTmp)(
		'resolves a directory typed in another case to disk spelling',
		() => {
			const directory = path.join(tempDir, 'Music Library');
			fs.mkdirSync(directory);

			expect(onDiskSpelling(directory.toUpperCase())).toBe(directory);
		},
	);

	it.runIf(caseInsensitiveTmp)('fixes the case of a symlink without resolving it', () => {
		fs.mkdirSync(path.join(tempDir, 'Target'));
		fs.symlinkSync(path.join(tempDir, 'Target'), path.join(tempDir, 'Link'));

		expect(onDiskSpelling(path.join(tempDir, 'link'))).toBe(path.join(tempDir, 'Link'));
	});

	it('keeps a directory that is already spelled as on disk', () => {
		expect(onDiskSpelling(tempDir)).toBe(tempDir);
	});
});
