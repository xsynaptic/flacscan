import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRecovery } from '#cli/recover.ts';
import {
	getRecoveryCandidates,
	identityOf,
	recordReadable,
	recordVerdict,
} from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { FlacScanError } from '#errors.ts';

import { caseInsensitiveTmp, makeTestConfig } from '../helpers.ts';

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

function seedCorrupt(name: string): string {
	const filePath = path.join(tempDir, name);
	fs.writeFileSync(filePath, 'x'.repeat(1024));
	recordReadable(db, [{ identity: identityOf(fs.statSync(filePath)), path: filePath }]);
	recordVerdict(db, filePath, {
		errorOutput: 'LOST_SYNC',
		errorTimestamp: null,
		status: 'corrupt',
	});
	return filePath;
}

describe('runRecovery disk-space preflight', () => {
	it('aborts before writing when a volume would drop below min_free_bytes', async () => {
		seedCorrupt('a.flac');
		seedCorrupt('b.flac');
		const config = makeTestConfig(tempDir, { min_free_bytes: Number.MAX_SAFE_INTEGER });
		const rows = getRecoveryCandidates(db);
		await expect(runRecovery({ config, db, signal: running }, rows)).rejects.toThrow(FlacScanError);

		const written = fs.readdirSync(tempDir).filter((name) => name.includes('[Recovered]'));
		expect(written).toEqual([]);
	});

	it('skips a candidate whose source vanished without failing', async () => {
		const gone = seedCorrupt('gone.flac');
		fs.rmSync(gone);
		const rows = getRecoveryCandidates(db);
		await expect(
			runRecovery({ config: makeTestConfig(tempDir), db, signal: running }, rows),
		).resolves.toEqual([]);
	});

	it('stops a volume at the buffer floor without attempting its files', async () => {
		seedCorrupt('a.flac');
		seedCorrupt('b.flac');
		const config = makeTestConfig(tempDir, { min_free_bytes: 10_000, parallelism: 1 });
		const roomy = { bavail: 1_000_000, bsize: 1 } as fs.StatsFs;
		const tight = { bavail: 10_500, bsize: 1 } as fs.StatsFs;
		vi.spyOn(fs.promises, 'statfs').mockResolvedValueOnce(roomy).mockResolvedValue(tight);
		const logSpy = vi.mocked(console.log);

		const entries = await runRecovery({ config, db, signal: running }, getRecoveryCandidates(db));

		expect(entries).toEqual([]);
		const floorMessages = logSpy.mock.calls.filter(([line]) =>
			String(line).includes('buffer floor reached'),
		);
		expect(floorMessages).toHaveLength(1);
		const written = fs.readdirSync(tempDir).filter((name) => name.includes('[Recovered]'));
		expect(written).toEqual([]);
	});

	it.runIf(caseInsensitiveTmp)('skips a candidate keyed by a case alias of its file', async () => {
		const filePath = seedCorrupt('Track.flac');
		fs.renameSync(filePath, path.join(tempDir, 'track.flac'));
		const rows = getRecoveryCandidates(db);
		await expect(
			runRecovery({ config: makeTestConfig(tempDir), db, signal: running }, rows),
		).resolves.toEqual([]);

		expect(rows.map((row) => row.current_path)).toEqual([filePath]);
	});
});
