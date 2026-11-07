import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDiscovery } from '#cli/scan-discover.ts';
import {
	acknowledgeAllIssues,
	findFileByPath,
	recordReadable,
	recordRecoveryOutcome,
	recordUnreadable,
	recordVerdict,
} from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { discoverFiles } from '#discovery.ts';

import { makeTestConfig, unreadableRow } from '../helpers.ts';

let db: Database.Database;
let tempDir: string;
const running = { aborted: false };

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

function touch(name: string, contents = 'data'): string {
	const filePath = path.join(tempDir, name);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, contents);
	return filePath;
}

function rowNames(): string[] {
	return (db.prepare(`SELECT current_path FROM files`).pluck().all() as string[])
		.map((rowPath) => path.relative(tempDir, rowPath))
		.toSorted((left, right) => left.localeCompare(right));
}

async function acceptedCorrupt(name: string, contents: string, mtimeSeconds: number) {
	const filePath = touch(name, contents);
	fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
	await runDiscovery(
		{ config: makeTestConfig(tempDir), db, signal: running },
		{ files: listedFiles(), walked: [tempDir] },
	);
	recordVerdict(db, filePath, { errorOutput: name, errorTimestamp: null, status: 'corrupt' });
	acknowledgeAllIssues(db);
	return filePath;
}

function listedFiles(): string[] {
	return (fs.readdirSync(tempDir, { recursive: true }) as string[])
		.filter((entry) => entry.endsWith('.flac'))
		.map((entry) => path.join(tempDir, entry));
}

describe('runDiscovery', () => {
	it('creates a pending row for a new file', async () => {
		const filePath = touch('new.flac');
		const stat = fs.statSync(filePath);

		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: [filePath],
				walked: [tempDir],
			},
		);

		expect(stats).toEqual({ moved: 0, processed: 1, pruned: 0, skipped: 0, unreadable: 0 });
		const row = findFileByPath(db, filePath);
		expect(row?.last_result).toBe('pending');
		expect(row?.file_size).toBe(stat.size);
		expect(row?.file_mtime).toBe(stat.mtime.toISOString());
	});

	it('skips an unchanged file on a second run', async () => {
		const filePath = touch('same.flac');
		const config = makeTestConfig(tempDir);

		await runDiscovery({ config, db, signal: running }, { files: [filePath], walked: [tempDir] });
		const firstUpdatedAt = findFileByPath(db, filePath)?.updated_at;

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{ files: [filePath], walked: [tempDir] },
		);

		expect(stats.skipped).toBe(1);
		expect(findFileByPath(db, filePath)?.updated_at).toBe(firstUpdatedAt);
	});

	it('resets a changed file to pending and clears its recovery outcome', async () => {
		const filePath = touch('changed.flac');
		recordReadable(db, [
			{ identity: { mtime: '2000-01-01T00:00:00.000Z', size: 1 }, path: filePath },
		]);
		recordRecoveryOutcome(db, filePath, {
			detail: 'restored',
			lostSamples: 10,
			result: 'recovered',
		});

		await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{ files: [filePath], walked: [tempDir] },
		);

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

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{ files: [missing], walked: [tempDir] },
		);

		expect(stats.unreadable).toBe(0);
		expect(findFileByPath(db, missing)).toBeUndefined();
		expect(unreadableRow(db, missing)).toBeUndefined();
		expect(fs.existsSync(config.log_path)).toBe(false);
	});

	it('records a non-ENOENT stat failure as unreadable and logs it', async () => {
		// A regular file used as a directory component yields ENOTDIR, not ENOENT
		const blocker = touch('blocker.flac');
		const badPath = path.join(blocker, 'child.flac');
		const config = makeTestConfig(tempDir);

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{ files: [badPath], walked: [tempDir] },
		);

		expect(stats.unreadable).toBe(1);
		expect(unreadableRow(db, badPath)).toBeDefined();
		const logLines = fs.readFileSync(config.log_path, 'utf8').trim().split('\n');
		expect(JSON.parse(logLines[0] ?? '')).toMatchObject({ event: 'unreadable', path: badPath });
	});

	it('promotes a formerly-unreadable file back into the pipeline when it stats again', async () => {
		const filePath = touch('recovered.flac');
		recordUnreadable(db, [{ error: 'prior failure', path: filePath }]);
		db.prepare(`UPDATE unreadable_files SET updated_at = ? WHERE current_path = ?`).run(
			'2999-01-01T00:00:00.000Z',
			filePath,
		);

		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: [filePath],
				walked: [tempDir],
			},
		);

		expect(stats.skipped).toBe(0);
		expect(findFileByPath(db, filePath)?.last_result).toBe('pending');
		expect(unreadableRow(db, filePath)).toBeUndefined();
	});
});

describe('runDiscovery move migration', () => {
	it('migrates a renamed file, carrying its verdict and acknowledgement without re-verifying', async () => {
		const oldPath = touch('old.flac');
		const config = makeTestConfig(tempDir);
		await runDiscovery({ config, db, signal: running }, { files: [oldPath], walked: [tempDir] });
		recordVerdict(db, oldPath, { errorOutput: 'boom', errorTimestamp: null, status: 'corrupt' });
		acknowledgeAllIssues(db);
		const before = findFileByPath(db, oldPath)!;

		const newPath = path.join(tempDir, 'renamed.flac');
		fs.renameSync(oldPath, newPath);

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{ files: [newPath], walked: [tempDir] },
		);

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
		await runDiscovery({ config, db, signal: running }, { files: [origPath], walked: [tempDir] });
		const origStat = fs.statSync(origPath);

		const copyPath = path.join(tempDir, 'copy.flac');
		fs.writeFileSync(copyPath, 'data');
		fs.utimesSync(copyPath, origStat.atime, origStat.mtime);

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{
				files: [origPath, copyPath],
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, origPath)).toBeDefined();
		expect(findFileByPath(db, copyPath)?.last_result).toBe('pending');
	});

	it('does not migrate when two vacated rows share the same size and mtime (ambiguous)', async () => {
		const aPath = touch('a.flac');
		const bPath = touch('b.flac');
		const config = makeTestConfig(tempDir);
		const mtime = fs.statSync(aPath).mtime;
		fs.utimesSync(bPath, mtime, mtime);
		await runDiscovery(
			{ config, db, signal: running },
			{ files: [aPath, bPath], walked: [tempDir] },
		);

		const cPath = path.join(tempDir, 'c.flac');
		fs.renameSync(aPath, cPath);
		fs.rmSync(bPath);

		const stats = await runDiscovery(
			{ config, db, signal: running },
			{ files: [cPath], walked: [tempDir] },
		);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, cPath)?.last_result).toBe('pending');
		expect(rowNames()).toEqual(['c.flac']);
	});

	it('swaps two files, each keeping its own row', async () => {
		const left = await acceptedCorrupt('left.flac', 'aaaa', 1_700_000_001);
		const right = await acceptedCorrupt('right.flac', 'bbbbb', 1_700_000_002);

		fs.renameSync(left, path.join(tempDir, 'swap.flac'));
		fs.renameSync(right, left);
		fs.renameSync(path.join(tempDir, 'swap.flac'), right);
		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: listedFiles(),
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(2);
		expect(findFileByPath(db, left)?.error_output).toBe('right.flac');
		expect(findFileByPath(db, right)?.error_output).toBe('left.flac');
		expect(findFileByPath(db, left)?.acknowledged_at).not.toBeNull();
		expect(findFileByPath(db, right)?.acknowledged_at).not.toBeNull();
	});

	it("follows a chain of renames onto each other's names", async () => {
		const first = await acceptedCorrupt('1.flac', 'aaaa', 1_700_000_001);
		const second = await acceptedCorrupt('2.flac', 'bbbbb', 1_700_000_002);
		const third = path.join(tempDir, '3.flac');

		fs.renameSync(second, third);
		fs.renameSync(first, second);
		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: listedFiles(),
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(2);
		expect(rowNames()).toEqual(['2.flac', '3.flac']);
		expect(findFileByPath(db, second)?.error_output).toBe('1.flac');
		expect(findFileByPath(db, third)?.error_output).toBe('2.flac');
	});

	it("replaces the row of a file renamed over, carrying the renamed file's row", async () => {
		const kept = await acceptedCorrupt('kept.flac', 'aaaa', 1_700_000_001);
		const overwritten = touch('overwritten.flac', 'bbbbb');
		await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{ files: listedFiles(), walked: [tempDir] },
		);

		fs.renameSync(kept, overwritten);
		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: listedFiles(),
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(1);
		expect(rowNames()).toEqual(['overwritten.flac']);
		expect(findFileByPath(db, overwritten)?.error_output).toBe('kept.flac');
		expect(findFileByPath(db, overwritten)?.acknowledged_at).not.toBeNull();
	});

	it('does not migrate when two new paths claim one vacated row', async () => {
		const original = await acceptedCorrupt('original.flac', 'aaaa', 1_700_000_001);
		const copy = path.join(tempDir, 'copy.flac');
		fs.copyFileSync(original, copy);
		fs.utimesSync(copy, 1_700_000_001, 1_700_000_001);

		fs.renameSync(original, path.join(tempDir, 'renamed.flac'));
		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: listedFiles(),
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(0);
		expect(rowNames()).toEqual(['copy.flac', 'renamed.flac']);
		expect(findFileByPath(db, copy)?.acknowledged_at).toBeNull();
		expect(findFileByPath(db, path.join(tempDir, 'renamed.flac'))?.acknowledged_at).toBeNull();
	});

	it('prunes rows for files gone from a fully walked root, rows and unreadable rows alike', async () => {
		const kept = touch('kept.flac');
		const gone = touch('gone.flac');
		await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{ files: [kept, gone], walked: [tempDir] },
		);
		recordUnreadable(db, [{ error: 'x', path: path.join(tempDir, 'stuck.flac') }]);
		fs.rmSync(gone);

		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: [kept],
				walked: [tempDir],
			},
		);

		expect(stats.pruned).toBe(2);
		expect(rowNames()).toEqual(['kept.flac']);
		expect(unreadableRow(db, path.join(tempDir, 'stuck.flac'))).toBeUndefined();
	});

	it('prunes nothing when discovery is interrupted at any point, then prunes once it completes', async () => {
		const accepted = await acceptedCorrupt('accepted.flac', 'aaaa', 1_700_000_001);
		const gone = touch('gone.flac');
		await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{ files: listedFiles(), walked: [tempDir] },
		);
		fs.rmSync(gone);
		fs.renameSync(accepted, path.join(tempDir, 'renamed.flac'));
		touch('arrived.flac', 'bbbbb');

		let interruptions = 0;
		let completed: number | undefined;
		for (let checks = 0; completed === undefined; checks++) {
			let remaining = checks;
			const probe = { interrupted: false };
			const signal = {
				get aborted() {
					probe.interrupted ||= remaining <= 0;
					remaining--;
					return probe.interrupted;
				},
			};
			const stats = await runDiscovery(
				{ config: makeTestConfig(tempDir), db, signal },
				{
					files: listedFiles(),
					walked: [tempDir],
				},
			);
			if (probe.interrupted) {
				interruptions++;
				expect(stats.pruned, `interrupted after ${String(checks)} checks`).toBe(0);
				expect(rowNames(), `interrupted after ${String(checks)} checks`).toContain('gone.flac');
			} else {
				completed = stats.pruned;
			}
		}

		expect(interruptions).toBeGreaterThanOrEqual(4);
		expect(completed).toBe(1);
		expect(rowNames()).toEqual(['arrived.flac', 'renamed.flac']);
		expect(findFileByPath(db, path.join(tempDir, 'renamed.flac'))?.acknowledged_at).not.toBeNull();
	});

	it.skipIf(process.getuid?.() === 0)(
		'never hands the row of a file that has turned unreadable to a copy of it',
		async () => {
			const original = await acceptedCorrupt(
				path.join('locked', 'original.flac'),
				'aaaa',
				1_700_000_001,
			);
			const copy = path.join(tempDir, 'copy.flac');
			fs.copyFileSync(original, copy);
			fs.utimesSync(copy, 1_700_000_001, 1_700_000_001);
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);

			try {
				const stats = await runDiscovery(
					{ config: makeTestConfig(tempDir), db, signal: running },
					{
						files: [original, copy],
						walked: [tempDir],
					},
				);

				expect(stats).toMatchObject({ moved: 0, pruned: 0, unreadable: 1 });
				expect(findFileByPath(db, original)?.acknowledged_at).not.toBeNull();
				expect(findFileByPath(db, copy)?.acknowledged_at).toBeNull();
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		'ends the unreadable row of a known file that reads again unchanged, keeping its history',
		async () => {
			const filePath = await acceptedCorrupt(
				path.join('locked', 'track.flac'),
				'aaaa',
				1_700_000_001,
			);
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);
			try {
				await runDiscovery(
					{ config: makeTestConfig(tempDir), db, signal: running },
					{ files: [filePath], walked: [tempDir] },
				);
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}
			expect(unreadableRow(db, filePath)).toBeDefined();

			const stats = await runDiscovery(
				{ config: makeTestConfig(tempDir), db, signal: running },
				{ files: [filePath], walked: [tempDir] },
			);

			expect(stats).toMatchObject({ skipped: 1, unreadable: 0 });
			expect(unreadableRow(db, filePath)).toBeUndefined();
			expect(findFileByPath(db, filePath)?.acknowledged_at).not.toBeNull();
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		'prunes nothing under a root whose walk hit an unreadable subdirectory',
		async () => {
			const kept = touch('kept.flac');
			const gone = touch('gone.flac');
			touch(path.join('locked', 'inside.flac'));
			await runDiscovery(
				{ config: makeTestConfig(tempDir), db, signal: running },
				{
					files: [kept, gone, path.join(tempDir, 'locked', 'inside.flac')],
					walked: [tempDir],
				},
			);
			fs.rmSync(gone);
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);

			try {
				const { files, incomplete, walked } = await discoverFiles([tempDir], ['.flac']);
				const stats = await runDiscovery(
					{ config: makeTestConfig(tempDir), db, signal: running },
					{ files, walked },
				);

				expect(incomplete.map((walk) => walk.directory)).toEqual([tempDir]);
				expect(stats.pruned).toBe(0);
				expect(rowNames()).toEqual(['gone.flac', 'kept.flac', path.join('locked', 'inside.flac')]);
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}
		},
	);

	it('does not migrate when the candidate old path is not under an available root', async () => {
		const newPath = touch('arrived.flac');
		const stat = fs.statSync(newPath);
		recordReadable(db, [
			{
				identity: { mtime: stat.mtime.toISOString(), size: stat.size },
				path: '/somewhere/offline/gone.flac',
			},
		]);

		const stats = await runDiscovery(
			{ config: makeTestConfig(tempDir), db, signal: running },
			{
				files: [newPath],
				walked: [tempDir],
			},
		);

		expect(stats.moved).toBe(0);
		expect(findFileByPath(db, newPath)?.last_result).toBe('pending');
		expect(findFileByPath(db, '/somewhere/offline/gone.flac')).toBeDefined();
	});
});
