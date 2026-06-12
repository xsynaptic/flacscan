import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRecovery } from '../../src/cli/recover.js';
import {
	getRecoveryCandidates,
	updateVerificationResult,
	upsertFile,
} from '../../src/database/queries.js';
import { initializeSchema } from '../../src/database/schema.js';
import { FlacScanError } from '../../src/errors.js';
import { makeTestConfig } from '../helpers.js';

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	db.close();
	fs.rmSync(tempDir, { force: true, recursive: true });
	vi.restoreAllMocks();
});

function seedCorrupt(name: string): string {
	const filePath = path.join(tempDir, name);
	fs.writeFileSync(filePath, 'x'.repeat(1024));
	upsertFile(db, { current_path: filePath, file_mtime: null, file_size: null });
	updateVerificationResult(db, filePath, { error_severity: 'recoverable', last_result: 'corrupt' });
	return filePath;
}

describe('runRecovery disk-space preflight', () => {
	it('aborts before writing when a volume would drop below min_free_bytes', async () => {
		seedCorrupt('a.flac');
		seedCorrupt('b.flac');
		// A min-free larger than any real volume guarantees the preflight finds a shortfall
		const config = makeTestConfig(tempDir, { min_free_bytes: Number.MAX_SAFE_INTEGER });
		const rows = getRecoveryCandidates(db);
		const reportEntries: never[] = [];

		await expect(
			runRecovery(config, db, rows, 'nothing to recover', reportEntries),
		).rejects.toThrow(FlacScanError);

		const written = fs.readdirSync(tempDir).filter((name) => name.includes('[Recovered]'));
		expect(written).toEqual([]);
		expect(reportEntries).toHaveLength(0);
	});

	it('skips a candidate whose source vanished without failing', async () => {
		const gone = seedCorrupt('gone.flac');
		fs.rmSync(gone);
		const rows = getRecoveryCandidates(db);
		const reportEntries: never[] = [];

		await expect(
			runRecovery(makeTestConfig(tempDir), db, rows, 'nothing to recover', reportEntries),
		).resolves.toBeUndefined();

		expect(reportEntries).toHaveLength(0);
	});
});
