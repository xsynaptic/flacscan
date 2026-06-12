import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/types.js';
import { classifyCorruptFile } from '../../src/verifiers/severity.js';

// Exercises the real metaflac probe and its parsing; requires metaflac on PATH (a project prerequisite)
const goodFlac = fileURLToPath(new URL('../../samples/good.flac', import.meta.url));

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
});

describe('classifyCorruptFile', () => {
	it('probes a readable file and feeds real stream length through the classifier', async () => {
		// Failure at sample 0 means the whole stream is lost, which exceeds any trailing-loss budget
		const severity = await classifyCorruptFile(
			goodFlac,
			'FRAME_CRC_MISMATCH',
			'sample 0',
			DEFAULT_CONFIG,
		);
		expect(severity).toBe('critical');
	});

	it('returns unknown when metaflac cannot read the file', async () => {
		const notFlac = path.join(tempDir, 'not.flac');
		fs.writeFileSync(notFlac, 'this is not a flac file');

		const severity = await classifyCorruptFile(
			notFlac,
			'FRAME_CRC_MISMATCH',
			'sample 0',
			DEFAULT_CONFIG,
		);
		expect(severity).toBe('unknown');
	});
});
