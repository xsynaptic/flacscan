import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PassOutcome } from '#verification/verification-pass.ts';
import type { FormatVerifier, VerificationResult } from '#verifiers/types.ts';

import {
	findFileByPath,
	identityOf,
	recordReadable,
	recordUnreadable,
	recordVerdict,
} from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { runVerificationPass } from '#verification/verification-pass.ts';

import { unreadableRow } from '../helpers.ts';

const accepted = '2020-01-01T00:00:00.000Z';
const corrupt: VerificationResult = {
	errorOutput: 'LOST_SYNC',
	errorTimestamp: null,
	status: 'corrupt',
};

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

function verifierFor(results: Record<string, VerificationResult>): FormatVerifier {
	return {
		extensions: ['.flac'],
		requiredBinaries: [],
		verify: (filePath) =>
			Promise.resolve(results[path.basename(filePath)] ?? { status: 'healthy' }),
	};
}

function seed(
	name: string,
	history: { accepted?: boolean; corrupt?: boolean; healthyBefore?: boolean } = {},
): string {
	const filePath = path.join(tempDir, name);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, 'data');
	recordReadable(db, [{ identity: identityOf(fs.statSync(filePath)), path: filePath }]);
	if (history.healthyBefore === true) recordVerdict(db, filePath, { status: 'healthy' });
	if (history.corrupt === true) {
		recordVerdict(db, filePath, {
			errorOutput: 'LOST_SYNC',
			errorTimestamp: null,
			status: 'corrupt',
		});
	}
	if (history.accepted === true) {
		db.prepare(`UPDATE files SET acknowledged_at = ? WHERE current_path = ?`).run(
			accepted,
			filePath,
		);
	}
	return filePath;
}

async function pass(paths: string[], verifier: FormatVerifier = verifierFor({})) {
	const outcomes: [string, PassOutcome][] = [];
	const result = await runVerificationPass(
		{
			db,
			fix: false,
			logPath: path.join(tempDir, 'scan.log'),
			parallelism: 2,
			signal: { aborted: false },
			verifier,
		},
		paths,
		(filePath, outcome) => {
			outcomes.push([filePath, outcome]);
		},
	);
	return { ...result, outcomes };
}

function logEvents(): string[] {
	const logPath = path.join(tempDir, 'scan.log');
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => (JSON.parse(line) as { event: string }).event);
}

describe('runVerificationPass', () => {
	it('prunes a missing path from both tables', async () => {
		const filePath = seed('gone.flac', { accepted: true, corrupt: true });
		recordUnreadable(db, [{ error: 'EACCES', path: filePath }]);
		fs.rmSync(filePath);

		const { outcomes, stats } = await pass([filePath]);

		expect(outcomes).toEqual([[filePath, { kind: 'pruned' }]]);
		expect(stats).toMatchObject({ pruned: 1, verified: 1 });
		expect(findFileByPath(db, filePath)).toBeUndefined();
		expect(unreadableRow(db, filePath)).toBeUndefined();
	});

	it.skipIf(process.getuid?.() === 0)(
		'keeps the files row and acceptance of a path that has turned unreadable, as an overlay',
		async () => {
			const filePath = seed(path.join('locked', 'track.flac'), {
				accepted: true,
				corrupt: true,
				healthyBefore: true,
			});
			const before = findFileByPath(db, filePath);
			fs.chmodSync(path.join(tempDir, 'locked'), 0o000);

			try {
				const { exitCode, outcomes, stats } = await pass([filePath]);

				expect(outcomes.map(([outcomePath, outcome]) => [outcomePath, outcome.kind])).toEqual([
					[filePath, 'unreadable'],
				]);
				const [, outcome] = outcomes[0]!;
				expect(outcome.kind === 'unreadable' && outcome.error).toContain('EACCES');
				expect(stats).toMatchObject({ pruned: 0, unreadable: 0, unreadableNow: 1, verified: 1 });
				expect(exitCode).toBe(0);
			} finally {
				fs.chmodSync(path.join(tempDir, 'locked'), 0o755);
			}
			expect(findFileByPath(db, filePath)).toEqual(before);
			expect(unreadableRow(db, filePath)?.error_output).toContain('EACCES');
			expect(logEvents()).toEqual(['unreadable']);
		},
	);

	it('promotes an unreadable-only path that reads again, then verifies it', async () => {
		const filePath = path.join(tempDir, 'back.flac');
		fs.writeFileSync(filePath, 'data');
		recordUnreadable(db, [{ error: 'EACCES', path: filePath }]);

		const { outcomes } = await pass([filePath]);

		expect(outcomes).toEqual([[filePath, { kind: 'healthy' }]]);
		expect(findFileByPath(db, filePath)?.last_result).toBe('healthy');
		expect(unreadableRow(db, filePath)).toBeUndefined();
	});

	it('ends the overlay of a path that reads again unchanged, keeping its history', async () => {
		const filePath = seed('overlay.flac', { accepted: true, corrupt: true, healthyBefore: true });
		const { last_healthy_at: lastHealthyAt } = findFileByPath(db, filePath)!;
		recordUnreadable(db, [{ error: 'EACCES', path: filePath }]);

		const { exitCode, outcomes } = await pass([filePath], verifierFor({ 'overlay.flac': corrupt }));

		expect(outcomes).toEqual([
			[filePath, expect.objectContaining({ issue: { acknowledged: true, kind: 'regressed' } })],
		]);
		expect(exitCode).toBe(0);
		expect(findFileByPath(db, filePath)).toMatchObject({
			acknowledged_at: accepted,
			last_healthy_at: lastHealthyAt,
		});
		expect(unreadableRow(db, filePath)).toBeUndefined();
	});

	it('starts a new episode for a file whose identity changed since it was selected', async () => {
		const filePath = seed('rewritten.flac', { accepted: true, corrupt: true, healthyBefore: true });
		fs.writeFileSync(filePath, 'different bytes');

		const { exitCode, outcomes } = await pass(
			[filePath],
			verifierFor({ 'rewritten.flac': corrupt }),
		);

		expect(outcomes).toEqual([
			[filePath, expect.objectContaining({ issue: { acknowledged: false, kind: 'corrupt' } })],
		]);
		expect(exitCode).toBe(1);
		expect(findFileByPath(db, filePath)).toMatchObject({
			acknowledged_at: null,
			file_size: fs.statSync(filePath).size,
			last_healthy_at: null,
			last_result: 'corrupt',
		});
	});

	it('counts corrupt outcomes by acceptance and regression, failing only on a new one', async () => {
		const paths = [
			seed('new.flac'),
			seed('accepted.flac', { accepted: true, corrupt: true }),
			seed('regressed.flac', { corrupt: true, healthyBefore: true }),
			seed('accepted-regressed.flac', { accepted: true, corrupt: true, healthyBefore: true }),
			seed('healthy.flac'),
		];
		const verifier = verifierFor({
			'accepted-regressed.flac': corrupt,
			'accepted.flac': corrupt,
			'new.flac': corrupt,
			'regressed.flac': corrupt,
		});

		const { exitCode, stats } = await pass(paths, verifier);

		expect(stats).toEqual({
			corrupt: 4,
			fixed: 0,
			healthy: 1,
			newCorrupt: 2,
			newRegressed: 1,
			newUnreadable: 0,
			pruned: 0,
			regressed: 2,
			unreadable: 0,
			unreadableNow: 0,
			verified: 5,
		});
		expect(exitCode).toBe(1);
	});

	it('exits 0 when every corrupt outcome is accepted', async () => {
		const filePath = seed('accepted.flac', { accepted: true, corrupt: true });

		const { exitCode, stats } = await pass([filePath], verifierFor({ 'accepted.flac': corrupt }));

		expect(stats).toMatchObject({ corrupt: 1, newCorrupt: 0 });
		expect(exitCode).toBe(0);
	});

	it('never passes on or counts an interrupted outcome', async () => {
		const stopped = seed('stopped.flac');
		const healthy = seed('healthy.flac');

		const { outcomes, stats } = await pass(
			[stopped, healthy],
			verifierFor({ 'stopped.flac': { status: 'interrupted' } }),
		);

		expect(outcomes).toEqual([[healthy, { kind: 'healthy' }]]);
		expect(stats).toMatchObject({ healthy: 1, verified: 1 });
		expect(findFileByPath(db, stopped)?.last_result).toBe('pending');
	});
});
