import { runCommand } from 'citty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FormatVerifier } from '#verifiers/types.ts';

import { recheckCommand } from '#cli/recheck.ts';
import { openDatabase } from '#database/connection.ts';
import {
	acknowledgeAllIssues,
	findFileByPath,
	identityOf,
	recordReadable,
	recordUnreadable,
	recordVerdict,
} from '#database/queries.ts';

import { caseInsensitiveTmp, unreadableRow } from '../helpers.ts';

vi.mock('#shell.ts', async (importActual) => ({
	...(await importActual<typeof import('#shell.ts')>()),
	ensureBinary: () => Promise.resolve(),
}));

const verify = vi.hoisted(() =>
	vi.fn<FormatVerifier['verify']>(() =>
		Promise.resolve({ errorOutput: 'LOST_SYNC', errorTimestamp: null, status: 'corrupt' }),
	),
);

vi.mock('#verifiers/flac/verify.ts', () => ({
	flacVerifier: { extensions: ['.flac'], requiredBinaries: [], verify },
}));

const accepted = '2026-01-01T00:00:00.000Z';
const lastHealthy = '2025-06-01T00:00:00.000Z';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	fs.writeFileSync(path.join(tempDir, 'flacscan.config.yaml'), `directories:\n  - ${tempDir}\n`);
	dbPath = path.join(tempDir, 'flacscan.db');
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tempDir, { force: true, recursive: true });
	process.exitCode = 0;
});

function seedCorrupt(filePath: string) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, 'data');
	const seeded = openDatabase(dbPath);
	recordReadable(seeded, [{ identity: identityOf(fs.statSync(filePath)), path: filePath }]);
	recordVerdict(seeded, filePath, {
		errorOutput: 'LOST_SYNC',
		errorTimestamp: null,
		status: 'corrupt',
	});
	seeded.close();
}

function logLines() {
	return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
}

async function recheck() {
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
}

describe('recheck', () => {
	it.runIf(caseInsensitiveTmp)('prunes a corrupt row keyed by a case alias of a file', async () => {
		fs.writeFileSync(path.join(tempDir, 'Track.flac'), 'data');
		const alias = path.join(tempDir, 'track.flac');
		const seeded = openDatabase(dbPath);
		recordReadable(seeded, [{ identity: identityOf(fs.statSync(alias)), path: alias }]);
		recordVerdict(seeded, alias, {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		seeded.close();

		await recheck();

		const db = openDatabase(dbPath);
		const row = findFileByPath(db, alias);
		db.close();
		expect(row).toBeUndefined();
	});

	it('keeps the acceptance and healthy history of a known file that reads again', async () => {
		const filePath = path.join(tempDir, 'track.flac');
		fs.writeFileSync(filePath, 'data');
		const stat = fs.statSync(filePath);
		const seeded = openDatabase(dbPath);
		recordReadable(seeded, [{ identity: identityOf(stat), path: filePath }]);
		recordVerdict(seeded, filePath, { status: 'healthy' });
		recordVerdict(seeded, filePath, {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		acknowledgeAllIssues(seeded);
		seeded
			.prepare('UPDATE files SET acknowledged_at = ?, last_healthy_at = ? WHERE current_path = ?')
			.run(accepted, lastHealthy, filePath);
		recordUnreadable(seeded, [{ error: 'EACCES', path: filePath }]);
		seeded.close();

		await recheck();

		const db = openDatabase(dbPath);
		const row = findFileByPath(db, filePath);
		const unreadable = unreadableRow(db, filePath);
		db.close();
		expect(row).toMatchObject({
			acknowledged_at: accepted,
			last_healthy_at: lastHealthy,
			last_result: 'corrupt',
		});
		expect(unreadable).toBeUndefined();
		expect(process.exitCode ?? 0).toBe(0);
	});

	it('checks and prints an overlay path once, failing on its new corruption', async () => {
		const filePath = path.join(tempDir, 'overlay.flac');
		fs.writeFileSync(filePath, 'data');
		const seeded = openDatabase(dbPath);
		recordReadable(seeded, [{ identity: identityOf(fs.statSync(filePath)), path: filePath }]);
		recordVerdict(seeded, filePath, {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
		recordUnreadable(seeded, [{ error: 'EACCES', path: filePath }]);
		seeded.close();

		await recheck();

		const verdictLines = vi
			.mocked(console.log)
			.mock.calls.map(([line]) => String(line))
			.filter((line) => line.includes(filePath));
		expect(verdictLines).toEqual([expect.stringContaining(`NEW CORRUPT ${filePath}`)]);
		expect(process.exitCode).toBe(1);
	});

	it('says so and checks nothing when there are no known issues', async () => {
		await recheck();

		expect(logLines()).toEqual(['No files to recheck.']);
		expect(verify).not.toHaveBeenCalled();
	});

	it('rechecks issues under any mounted root, printing HEALTHY and PRUNED, and skips the rest', async () => {
		const first = path.join(tempDir, 'one');
		const second = path.join(tempDir, 'two');
		const healthy = path.join(first, 'healthy.flac');
		const deleted = path.join(second, 'deleted.flac');
		const outside = path.join(tempDir, 'three', 'outside.flac');
		for (const filePath of [healthy, deleted, outside]) seedCorrupt(filePath);
		fs.rmSync(deleted);
		fs.rmSync(outside);
		fs.writeFileSync(
			path.join(tempDir, 'flacscan.config.yaml'),
			`directories:\n  - ${first}\n  - ${second}\n`,
		);
		verify.mockResolvedValueOnce({ status: 'healthy' });

		await recheck();

		expect(logLines()).toEqual([`  HEALTHY ${healthy}`, `  PRUNED ${deleted}`]);
		const db = openDatabase(dbPath);
		expect(findFileByPath(db, outside)?.last_result).toBe('corrupt');
		db.close();
	});
});
