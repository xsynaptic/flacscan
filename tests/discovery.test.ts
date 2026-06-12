import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkMountedPaths, discoverFiles } from '../src/discovery.js';

const EXTENSIONS = ['.flac'];

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

describe('checkMountedPaths', () => {
	it('sorts existing dirs into available and missing dirs into skipped', () => {
		const missing = path.join(tempDir, 'gone');

		const result = checkMountedPaths([tempDir, missing]);

		expect(result.available).toEqual([tempDir]);
		expect(result.skipped).toEqual([missing]);
	});
});

describe('discoverFiles', () => {
	it('finds nested flac files and returns absolute paths', async () => {
		const top = touch('albumA', 'track.flac');
		const nested = touch('albumA', 'sub', 'track2.flac');

		const { files } = await discoverFiles([tempDir], EXTENSIONS);

		expect(files.toSorted()).toEqual([top, nested].toSorted());
	});

	it('matches extensions case-insensitively and excludes non-matching files', async () => {
		const upper = touch('TRACK.FLAC');
		touch('cover.jpg');

		const { files } = await discoverFiles([tempDir], EXTENSIONS);

		expect(files).toEqual([upper]);
	});

	it('skips a recovered file while its original exists, then finds it once gone', async () => {
		const original = touch('Track.flac');
		const recovered = touch('Track [Recovered].flac');

		const withOriginal = await discoverFiles([tempDir], EXTENSIONS);
		expect(withOriginal.files).toEqual([original]);

		fs.rmSync(original);

		const withoutOriginal = await discoverFiles([tempDir], EXTENSIONS);
		expect(withoutOriginal.files).toEqual([recovered]);
	});

	it('skips a nonexistent directory without throwing', async () => {
		const found = touch('albumA', 'track.flac');
		const missing = path.join(tempDir, 'gone');

		const { files, mountCheck } = await discoverFiles([tempDir, missing], EXTENSIONS);

		expect(files).toEqual([found]);
		expect(mountCheck.skipped).toEqual([missing]);
	});
});
