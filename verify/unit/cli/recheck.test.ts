import { runCommand } from 'citty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recheckCommand } from '#cli/recheck.ts';
import { openDatabase } from '#database/connection.ts';
import { findFileByPath, updateVerificationResult, upsertFile } from '#database/queries.ts';

import { caseInsensitiveTmp } from '../helpers.ts';

vi.mock('#shell.ts', async (importActual) => ({
	...(await importActual<typeof import('#shell.ts')>()),
	ensureBinary: () => Promise.resolve(),
}));

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	fs.writeFileSync(path.join(tempDir, 'flacscan.config.yaml'), `directories:\n  - ${tempDir}\n`);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tempDir, { force: true, recursive: true });
	process.exitCode = 0;
});

describe('recheck', () => {
	it.runIf(caseInsensitiveTmp)('prunes a corrupt row keyed by a case alias of a file', async () => {
		fs.writeFileSync(path.join(tempDir, 'Track.flac'), 'data');
		const alias = path.join(tempDir, 'track.flac');
		const dbPath = path.join(tempDir, 'flacscan.db');
		const seeded = openDatabase(dbPath);
		upsertFile(seeded, { current_path: alias, file_mtime: null, file_size: null });
		updateVerificationResult(seeded, alias, { last_result: 'corrupt' });
		seeded.close();

		await runCommand(recheckCommand, {
			rawArgs: [
				'--config',
				path.join(tempDir, 'flacscan.config.yaml'),
				'--db-path',
				dbPath,
				'--log-path',
				path.join(tempDir, 'flacscan.log'),
			],
		});

		const db = openDatabase(dbPath);
		const row = findFileByPath(db, alias);
		db.close();
		expect(row).toBeUndefined();
	});
});
