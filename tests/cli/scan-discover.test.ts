import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDiscovery } from '../../src/cli/scan-discover.js';
import {
	findFileByPath,
	findUnreadableByPath,
	recordRecoveryOutcome,
	upsertFile,
	upsertUnreadableFile,
} from '../../src/database/queries.js';
import { initializeSchema } from '../../src/database/schema.js';
import { makeTestConfig } from '../helpers.js';

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	db.close();
	fs.rmSync(tempDir, { force: true, recursive: true });
});

function touch(name: string): string {
	const filePath = path.join(tempDir, name);
	fs.writeFileSync(filePath, 'data');
	return filePath;
}

describe('runDiscovery', () => {
	it('creates a pending row for a new file', async () => {
		const filePath = touch('new.flac');
		const stat = fs.statSync(filePath);

		const stats = await runDiscovery(db, [filePath], makeTestConfig(tempDir));

		expect(stats).toEqual({ processed: 1, skipped: 0, unreadable: 0 });
		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('pending');
		expect(row?.file_size).toBe(stat.size);
		expect(row?.file_mtime).toBe(stat.mtime.toISOString());
	});

	it('skips an unchanged file on a second run', async () => {
		const filePath = touch('same.flac');
		const config = makeTestConfig(tempDir);

		await runDiscovery(db, [filePath], config);
		const firstUpdatedAt = findFileByPath(db, filePath)?.updated_at;

		const stats = await runDiscovery(db, [filePath], config);

		expect(stats.skipped).toBe(1);
		expect(findFileByPath(db, filePath)?.updated_at).toBe(firstUpdatedAt);
	});

	it('resets a changed file to pending and clears its recovery outcome', async () => {
		const filePath = touch('changed.flac');
		upsertFile(db, {
			current_path: filePath,
			file_mtime: '2000-01-01T00:00:00.000Z',
			file_size: 1,
		});
		recordRecoveryOutcome(db, filePath, {
			detail: 'restored',
			lostSamples: 10,
			result: 'recovered',
		});

		await runDiscovery(db, [filePath], makeTestConfig(tempDir));

		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('pending');
		expect(row?.recovery_attempted_at).toBeNull();
		expect(row?.recovery_result).toBeNull();
		expect(row?.recovery_lost_samples).toBeNull();
		expect(row?.recovery_detail).toBeNull();
	});

	it('skips a path deleted before discovery (ENOENT) without recording it', async () => {
		const missing = path.join(tempDir, 'gone.flac');
		const config = makeTestConfig(tempDir);

		const stats = await runDiscovery(db, [missing], config);

		expect(stats.unreadable).toBe(0);
		expect(findFileByPath(db, missing)).toBeUndefined();
		expect(findUnreadableByPath(db, missing)).toBeUndefined();
		expect(fs.existsSync(config.log_path)).toBe(false);
	});

	it('records a non-ENOENT stat failure as unreadable and logs it', async () => {
		// A regular file used as a directory component yields ENOTDIR, not ENOENT
		const blocker = touch('blocker.flac');
		const badPath = path.join(blocker, 'child.flac');
		const config = makeTestConfig(tempDir);

		const stats = await runDiscovery(db, [badPath], config);

		expect(stats.unreadable).toBe(1);
		expect(findUnreadableByPath(db, badPath)).toBeDefined();
		const logLines = fs.readFileSync(config.log_path, 'utf8').trim().split('\n');
		expect(JSON.parse(logLines[0] ?? '')).toMatchObject({ event: 'unreadable', path: badPath });
	});

	it('promotes a formerly-unreadable file back into the pipeline when it stats again', async () => {
		const filePath = touch('recovered.flac');
		upsertUnreadableFile(db, { current_path: filePath, error_output: 'prior failure' });
		// Failure timestamp in the future: the old mtime skip would have kept this file stranded
		db.prepare(`UPDATE unreadable_files SET updated_at = ? WHERE current_path = ?`).run(
			'2999-01-01T00:00:00.000Z',
			filePath,
		);

		const stats = await runDiscovery(db, [filePath], makeTestConfig(tempDir));

		expect(stats.skipped).toBe(0);
		expect(findFileByPath(db, filePath)?.last_result).toBe('pending');
		expect(findUnreadableByPath(db, filePath)).toBeUndefined();
	});
});
