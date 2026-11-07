import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { directoryPrefix, onDiskSpelling, statAsSpelled } from '#paths.ts';

import { caseInsensitiveTmp } from './helpers.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
});

function lookAt(...segments: string[]) {
	return statAsSpelled(path.join(...segments)).kind;
}

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

describe('statAsSpelled', () => {
	it('is present for a file under its exact spelling, through a symlinked temp directory', () => {
		const filePath = touch('Album', 'Track.flac');
		const look = statAsSpelled(filePath);

		expect(look.kind === 'present' && look.stats.isFile()).toBe(true);
	});

	it('is missing for a missing file and for a file under a missing directory', () => {
		touch('Album', 'Track.flac');

		expect(lookAt(tempDir, 'Album', 'Other.flac')).toBe('missing');
		expect(lookAt(tempDir, 'Gone', 'Track.flac')).toBe('missing');
	});

	it('turns missing once a file it already reported is deleted', () => {
		const filePath = touch('Album', 'Track.flac');
		expect(lookAt(filePath)).toBe('present');

		fs.rmSync(filePath);

		expect(lookAt(filePath)).toBe('missing');
	});

	it('is present under both names of a hard-linked file', () => {
		const first = touch('Album', 'Alpha.flac');
		const second = path.join(tempDir, 'Album', 'beta.flac');
		fs.linkSync(first, second);

		expect([lookAt(first), lookAt(second)]).toEqual(['present', 'present']);
	});

	it('follows a symlinked directory under the spelling of the link', () => {
		touch('Target', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Target'), path.join(tempDir, 'Link'));

		expect(lookAt(tempDir, 'Link', 'Track.flac')).toBe('present');
	});

	it.runIf(caseInsensitiveTmp)('is missing for a case alias of the file or of a directory', () => {
		const filePath = touch('Album', 'Track.flac');

		expect(lookAt(tempDir, 'Album', 'track.flac')).toBe('missing');
		expect(lookAt(tempDir, 'album', 'Track.flac')).toBe('missing');
		expect(lookAt(filePath)).toBe('present');
	});

	it('keeps the spelling of a symlink whose target differs from it only in case', () => {
		touch('Other', 'album', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Other', 'album'), path.join(tempDir, 'Album'));

		expect(lookAt(tempDir, 'Album', 'Track.flac')).toBe('present');
	});

	it.runIf(caseInsensitiveTmp)('is missing for a case alias of a symlink', () => {
		touch('Target', 'Track.flac');
		fs.symlinkSync(path.join(tempDir, 'Target'), path.join(tempDir, 'Link'));

		expect(lookAt(tempDir, 'link', 'Track.flac')).toBe('missing');
	});

	it.skipIf(process.getuid?.() === 0)(
		'is unreadable, with the stat error, for a file under a directory it cannot search',
		() => {
			const filePath = touch('Locked', 'Track.flac');
			fs.chmodSync(path.join(tempDir, 'Locked'), 0o000);
			try {
				const look = statAsSpelled(filePath);
				expect(look.kind).toBe('unreadable');
				expect(look.kind === 'unreadable' && look.error).toContain('EACCES');
			} finally {
				fs.chmodSync(path.join(tempDir, 'Locked'), 0o755);
			}
		},
	);
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
