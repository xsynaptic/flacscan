import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDiscovery } from '../../src/cli/scan-discover.js';
import {
	acknowledgeAllIssues,
	findFileByPath,
	findUnreadableByPath,
	recordRecoveryOutcome,
	updateVerificationResult,
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

		const stats = await runDiscovery(db, [filePath], makeTestConfig(tempDir), [tempDir]);

		expect(stats).toEqual({ moved: 0, processed: 1, skipped: 0, unreadable: 0 });
		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('pending');
		expect(row?.file_size).toBe(stat.size);
		expect(row?.file_mtime).toBe(stat.mtime.toISOString());
	});

	it('skips an unchanged file on a second run', async () => {
		const filePath = touch('same.flac');
		const config = makeTestConfig(tempDir);

		await runDiscovery(db, [filePath], config, [tempDir]);
		const firstUpdatedAt = findFileByPath(db, filePath)?.updated_at;

		const stats = await runDiscovery(db, [filePath], config, [tempDir]);

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

		await runDiscovery(db, [filePath], makeTestConfig(tempDir), [tempDir]);

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

		const stats = await runDiscovery(db, [missing], config, [tempDir]);

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

		const stats = await runDiscovery(db, [badPath], config, [tempDir]);

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

		const stats = await runDiscovery(db, [filePath], makeTestConfig(tempDir), [tempDir]);

		expect(stats.skipped).toBe(0);
		expect(findFileByPath(db, filePath)?.last_result).toBe('pending');
		expect(findUnreadableByPath(db, filePath)).toBeUndefined();
	});
});

describe('runDiscovery move migration', () => {
	it('migrates a renamed file, carrying its verdict and acknowledgement without re-verifying', async () => {
		const oldPath = touch('old.flac');
		const config = makeTestConfig(tempDir);
		await runDiscovery(db, [oldPath], config, [tempDir]);
		updateVerificationResult(db, oldPath, { error_output: 'boom', last_result: 'corrupt' });
		acknowledgeAllIssues(db);
		const before = findFileByPath(db, oldPath)!;

		const newPath = path.join(tempDir, 'renamed.flac');
		fs.renameSync(oldPath, newPath);

		const stats = await runDiscovery(db, [newPath], config, [tempDir]);

		expect(stats.moved).toBe(1);
		expect(findFileByPath(db, oldPath)).toBeUndefined();
		const after = findFileByPath(db, newPath)!;
		expect(after.last_result).toBe('corrupt');
		expect(after.error_output).toBe('boom');
		expect(after.acknowledged_at).toBe(before.acknowledged_at);
		expect(after.last_verified_at).toBe(before.last_verified_at);
		const logLines = fs.readFileSync(config.log_path, 'utf8').trim().split('\n');
		expect(JSON.parse(logLines.at(-1) ?? '')).toMatchObject({
			event: 'moved',
			from: oldPath,
			path: newPath,
		});
	});

	it('treats a copy (original still present) as a new file, not a move', async () => {
		const origPath = touch('orig.flac');
		const config = makeTestConfig(tempDir);
		await runDiscovery(db, [origPath], config, [tempDir]);
		const origStat = fs.statSync(origPath);

		const copyPath = path.join(tempDir, 'copy.flac');
		fs.writeFileSync(copyPath, 'data');
		fs.utimesSync(copyPath, origStat.atime, origStat.mtime);

		const stats = await runDiscovery(db, [copyPath], config, [tempDir]);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, origPath)).toBeDefined();
		expect(findFileByPath(db, copyPath)?.last_result).toBe('pending');
	});

	it('does not migrate when two rows share the same size and mtime (ambiguous)', async () => {
		const aPath = touch('a.flac');
		const bPath = touch('b.flac');
		const config = makeTestConfig(tempDir);
		const mtime = fs.statSync(aPath).mtime;
		fs.utimesSync(bPath, mtime, mtime);
		await runDiscovery(db, [aPath, bPath], config, [tempDir]);

		const cPath = path.join(tempDir, 'c.flac');
		fs.renameSync(aPath, cPath);

		const stats = await runDiscovery(db, [cPath], config, [tempDir]);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, aPath)).toBeDefined();
		expect(findFileByPath(db, cPath)?.last_result).toBe('pending');
	});

	it('does not migrate when the candidate old path is not under an available root', async () => {
		const newPath = touch('arrived.flac');
		const stat = fs.statSync(newPath);
		upsertFile(db, {
			current_path: '/somewhere/offline/gone.flac',
			file_mtime: stat.mtime.toISOString(),
			file_size: stat.size,
		});

		const stats = await runDiscovery(db, [newPath], makeTestConfig(tempDir), [tempDir]);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, newPath)?.last_result).toBe('pending');
		expect(findFileByPath(db, '/somewhere/offline/gone.flac')).toBeDefined();
	});
});
