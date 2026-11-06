import { fc, test } from '@fast-check/vitest';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { RecoverItem } from '#cli/recover-attempt.ts';
import type { FlacFormat, RecoveryEnv } from '#cli/recover-engine.ts';

import { attemptRecovery } from '#cli/recover-attempt.ts';
import { DEFAULT_CONFIG } from '#config/types.ts';
import { findFileByPath, updateVerificationResult, upsertFile } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';

const src = '/music/song.flac';
const dest = '/music/song [Recovered].flac';
const sampleRate = 100;
const config = { ...DEFAULT_CONFIG, recover_max_trailing_loss_seconds: 3 };

interface StoredFile {
	delivered: number;
	testPassed: boolean;
}

const faultPlan = fc.record(
	{
		carryFails: fc.boolean(),
		claimedSamples: fc.constantFrom(0, 1000),
		ctrlCKillsChildren: fc.boolean(),
		decodeFails: fc.boolean(),
		deliveredSamples: fc.constantFrom(0, 699, 700, 701, 999, 1000),
		probePartialFails: fc.boolean(),
		probeSourceFails: fc.boolean(),
		renameFails: fc.boolean(),
		sourceVanishesAfterCall: fc.option(fc.nat({ max: 9 })),
		stopAfterCall: fc.option(fc.nat({ max: 9 })),
		testPasses: fc.boolean(),
		utimesFails: fc.boolean(),
	},
	{ noNullPrototype: true },
);

type FaultPlan = typeof faultPlan extends fc.Arbitrary<infer Plan> ? Plan : never;

function format(totalSamples: number): FlacFormat {
	return { bitsPerSample: 16, channels: 2, sampleRate, totalSamples };
}

function makeFakeEnv(plan: FaultPlan) {
	const files = new Map<string, StoredFile>([[src, { delivered: 0, testPassed: false }]]);
	const touchedPaths: string[] = [];
	let calls = 0;
	let killedStepSeen = false;

	function step() {
		calls++;
		if (plan.sourceVanishesAfterCall !== null && calls > plan.sourceVanishesAfterCall) {
			files.delete(src);
		}
	}
	function killedByCtrlC() {
		const killed = plan.ctrlCKillsChildren && env.shouldStop();
		if (killed) killedStepSeen = true;
		return killed;
	}
	const env: RecoveryEnv = {
		carryMetadata(from, to) {
			step();
			touchedPaths.push(to);
			if (plan.carryFails || !files.has(from)) return Promise.reject(new Error('metaflac failed'));
			return Promise.resolve();
		},
		decodeReencode(from, to) {
			step();
			touchedPaths.push(to);
			if (!files.has(from)) return Promise.reject(new Error('no source'));
			files.set(to, { delivered: plan.deliveredSamples, testPassed: false });
			if (plan.decodeFails || killedByCtrlC()) return Promise.reject(new Error('encoder exited 1'));
			return Promise.resolve();
		},
		exists: (path) => files.has(path),
		probe(path) {
			step();
			const file = files.get(path);
			const fails = path === src ? plan.probeSourceFails : plan.probePartialFails;
			if (file === undefined || fails || killedByCtrlC())
				return Promise.reject(new Error('metaflac failed'));
			return Promise.resolve(format(path === src ? plan.claimedSamples : file.delivered));
		},
		rename(from, to) {
			step();
			touchedPaths.push(from, to);
			const file = files.get(from);
			if (file === undefined || plan.renameFails) return Promise.reject(new Error('EXDEV'));
			files.delete(from);
			files.set(to, file);
			return Promise.resolve();
		},
		shouldStop: () => plan.stopAfterCall !== null && calls >= plan.stopAfterCall,
		testPasses(path) {
			step();
			const file = files.get(path);
			if (file === undefined || killedByCtrlC()) return Promise.resolve(false);
			file.testPassed = plan.testPasses;
			return Promise.resolve(plan.testPasses);
		},
		unlink(path) {
			step();
			touchedPaths.push(path);
			files.delete(path);
			return Promise.resolve();
		},
		utimes(path) {
			step();
			touchedPaths.push(path);
			if (plan.utimesFails || !files.has(path)) return Promise.reject(new Error('EPERM'));
			return Promise.resolve();
		},
	};

	return { env, files, killedStepSeen: () => killedStepSeen, touchedPaths };
}

function seedCorruptRow(db: BetterSqlite3.Database): RecoverItem {
	upsertFile(db, { current_path: src, file_mtime: null, file_size: null });
	updateVerificationResult(db, src, { last_result: 'corrupt' });
	return {
		atimeMs: 1000,
		dest,
		dev: 1,
		mtimeMs: 2000,
		row: findFileByPath(db, src)!,
		size: 100,
		src,
	};
}

describe('attemptRecovery under generated failures', () => {
	test.prop([faultPlan], { numRuns: 2000 })(
		'never touches the original, cleans up its partial, and stores only settled verdicts',
		async (plan) => {
			const db = new BetterSqlite3(':memory:');
			initializeSchema(db);
			const { env, files, killedStepSeen, touchedPaths } = makeFakeEnv(plan);

			const result = await attemptRecovery({ config, db, env }, seedCorruptRow(db));
			const stored = findFileByPath(db, src)!.recovery_result;
			db.close();

			expect(touchedPaths).not.toContain(src);
			if (killedStepSeen()) expect(stored).toBeNull();
			expect([...files.keys()].filter((path) => path.endsWith('.partial'))).toEqual([]);
			expect(files.has(dest)).toBe(result.kind === 'recovered');

			const settled = result.kind === 'recovered' || result.kind === 'unsuitable';
			expect(stored).toBe(settled ? result.kind : null);

			if (result.kind !== 'recovered') return;
			const placed = files.get(dest)!;
			expect(placed.testPassed).toBe(true);
			expect(placed.delivered).toBeGreaterThan(0);
			expect(plan.claimedSamples - placed.delivered).toBeGreaterThan(0);
			expect(plan.claimedSamples - placed.delivered).toBeLessThanOrEqual(300);
		},
	);

	test.prop([faultPlan.filter((plan) => plan.stopAfterCall === 0)])(
		'starts nothing and stores nothing when Ctrl+C arrived before the item began',
		async (plan) => {
			const db = new BetterSqlite3(':memory:');
			initializeSchema(db);
			const { env, touchedPaths } = makeFakeEnv(plan);

			const result = await attemptRecovery({ config, db, env }, seedCorruptRow(db));
			const stored = findFileByPath(db, src)!.recovery_result;
			db.close();

			expect(result.kind).toBe('interrupted');
			expect(touchedPaths).toEqual([]);
			expect(stored).toBeNull();
		},
	);

	it('reaches every outcome kind, so the properties above are not vacuous', async () => {
		const reachedKinds = new Set<string>();
		const plans = fc.sample(faultPlan, { numRuns: 2000, seed: 1 });
		for (const plan of plans) {
			const db = new BetterSqlite3(':memory:');
			initializeSchema(db);
			const { env } = makeFakeEnv(plan);
			const result = await attemptRecovery({ config, db, env }, seedCorruptRow(db));
			db.close();
			reachedKinds.add(result.kind);
		}
		expect([...reachedKinds].toSorted((left, right) => left.localeCompare(right))).toEqual([
			'failed',
			'interrupted',
			'recovered',
			'unsuitable',
		]);
	});
});
