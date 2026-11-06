import type Database from 'better-sqlite3';

import { fc, test } from '@fast-check/vitest';
import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FlacScanConfig } from '#config/types.ts';
import type { FileRow } from '#database/types.ts';
import type { FormatVerifier } from '#verifiers/types.ts';

import { runDiscovery } from '#cli/scan-discover.ts';
import { runVerification } from '#cli/scan-verify.ts';
import { acknowledgeAllIssues, findFileByPath, getRegressedFiles } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { discoverFiles } from '#discovery.ts';

import { caseInsensitiveTmp, makeTestConfig } from '../helpers.ts';

vi.mock('#metadata.ts', () => ({ extractMetadata: () => Promise.resolve(null) }));

const verifier: FormatVerifier = {
	extensions: ['.flac'],
	requiredBinaries: [],
	verify(filePath) {
		const bad = fs.readFileSync(filePath, 'utf8').startsWith('B');
		return Promise.resolve(
			bad
				? { errorOutput: 'bad frame', errorTimestamp: null, status: 'corrupt' }
				: { status: 'healthy' },
		);
	},
};

function byText(left: string, right: string) {
	return left.localeCompare(right);
}

interface Instance {
	accepted: boolean;
	bad: boolean;
	duplicated: boolean;
	mayBeAccepted: boolean;
	mayHaveHealthyHistory: boolean;
	mustHaveHealthyHistory: boolean;
	renames: number;
	rotted: boolean;
	rowVerified: boolean;
}

function freshInstance(bad: boolean): Instance {
	return {
		accepted: false,
		bad,
		duplicated: false,
		mayBeAccepted: false,
		mayHaveHealthyHistory: false,
		mustHaveHealthyHistory: false,
		renames: 0,
		rotted: false,
		rowVerified: false,
	};
}

async function scanCollection(db: Database.Database, root: string, config: FlacScanConfig) {
	const { files, mountCheck } = await discoverFiles([root], verifier.extensions);
	const discovery = await runDiscovery(db, config, { files, walked: mountCheck.available });
	const verification = await runVerification(db, config, {
		directories: mountCheck.available,
		verifier: verifier,
	});
	return {
		discovery,
		files,
		newCorrupt: verification?.newCorrupt ?? 0,
		newRegressed: verification?.newRegressed ?? 0,
	};
}

function writeFlac(filePath: string, bad: boolean, size: number) {
	fs.writeFileSync(filePath, (bad ? 'B' : 'G').padEnd(size, 'x'));
}

interface ModelFile {
	instance: Instance;
	name: string;
}

interface Model {
	files: Map<string, ModelFile>;
	key(name: string): string;
}

interface Real {
	config: FlacScanConfig;
	db: Database.Database;
	nextMtimeSeconds(): number;
	root: string;
}

const reached = { acceptedRows: 0, carriedAcceptances: 0, moves: 0, regressions: 0 };

let workspace: string;

beforeAll(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-lifecycle-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
	fs.rmSync(workspace, { force: true, recursive: true });
	vi.restoreAllMocks();
});

class WriteFile implements fc.AsyncCommand<Model, Real> {
	bad: boolean;
	name: string;
	size: number;
	constructor(name: string, bad: boolean, size: number) {
		this.name = name;
		this.bad = bad;
		this.size = size;
	}
	check() {
		return true;
	}
	run(model: Model, real: Real) {
		const filePath = path.join(real.root, this.name);
		writeFlac(filePath, this.bad, this.size);
		const mtime = real.nextMtimeSeconds();
		fs.utimesSync(filePath, mtime, mtime);
		const key = model.key(this.name);
		const displayName = model.files.get(key)?.name ?? this.name;
		model.files.set(key, { instance: freshInstance(this.bad), name: displayName });
		return Promise.resolve();
	}
	toString() {
		return `write ${this.name} ${this.bad ? 'bad' : 'good'} ${String(this.size)}B`;
	}
}

class CopyPreservingMtime implements fc.AsyncCommand<Model, Real> {
	from: string;
	to: string;
	constructor(from: string, to: string) {
		this.from = from;
		this.to = to;
	}
	check(model: Readonly<Model>) {
		return model.files.has(model.key(this.from)) && !model.files.has(model.key(this.to));
	}
	run(model: Model, real: Real) {
		const fromPath = path.join(real.root, this.from);
		const toPath = path.join(real.root, this.to);
		fs.copyFileSync(fromPath, toPath);
		const stat = fs.statSync(fromPath);
		fs.utimesSync(toPath, stat.atime, stat.mtime);
		const source = model.files.get(model.key(this.from))!.instance;
		source.accepted = false;
		source.duplicated = true;
		source.mustHaveHealthyHistory = false;
		source.rowVerified = false;
		model.files.set(model.key(this.to), {
			instance: {
				...freshInstance(source.bad),
				duplicated: true,
				mayBeAccepted: source.mayBeAccepted,
				mayHaveHealthyHistory: source.mayHaveHealthyHistory,
				rotted: source.rotted,
			},
			name: this.to,
		});
		return Promise.resolve();
	}
	toString() {
		return `cp -p ${this.from} ${this.to}`;
	}
}

class RenameFile implements fc.AsyncCommand<Model, Real> {
	from: string;
	to: string;
	constructor(from: string, to: string) {
		this.from = from;
		this.to = to;
	}
	check(model: Readonly<Model>) {
		const source = model.files.get(model.key(this.from));
		return source !== undefined && source.name !== this.to;
	}
	run(model: Model, real: Real) {
		const source = model.files.get(model.key(this.from))!;
		const caseOnly = model.key(this.from) === model.key(this.to);
		const overwritten = caseOnly ? undefined : model.files.get(model.key(this.to));
		fs.renameSync(path.join(real.root, source.name), path.join(real.root, this.to));
		source.instance.renames++;
		if (source.instance.duplicated) {
			source.instance.accepted = false;
			source.instance.mustHaveHealthyHistory = false;
			source.instance.rowVerified = false;
		}
		model.files.delete(model.key(this.from));
		model.files.set(model.key(this.to), {
			instance: source.instance,
			name: overwritten?.name ?? this.to,
		});
		return Promise.resolve();
	}
	toString() {
		return `mv ${this.from} ${this.to}`;
	}
}

class RotInPlace implements fc.AsyncCommand<Model, Real> {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	check(model: Readonly<Model>) {
		const entry = model.files.get(model.key(this.name));
		return entry !== undefined && !entry.instance.bad && !entry.instance.duplicated;
	}
	run(model: Model, real: Real) {
		const { instance, name } = model.files.get(model.key(this.name))!;
		const filePath = path.join(real.root, name);
		const stat = fs.statSync(filePath);
		writeFlac(filePath, true, stat.size);
		fs.utimesSync(filePath, stat.atime, stat.mtime);
		instance.bad = true;
		instance.rotted = true;
		instance.rowVerified = false;
		return Promise.resolve();
	}
	toString() {
		return `rot ${this.name} in place`;
	}
}

class DeleteFile implements fc.AsyncCommand<Model, Real> {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	check(model: Readonly<Model>) {
		return model.files.has(model.key(this.name));
	}
	run(model: Model, real: Real) {
		const entry = model.files.get(model.key(this.name))!;
		fs.unlinkSync(path.join(real.root, entry.name));
		model.files.delete(model.key(this.name));
		return Promise.resolve();
	}
	toString() {
		return `rm ${this.name}`;
	}
}

class Accept implements fc.AsyncCommand<Model, Real> {
	check() {
		return true;
	}
	run(model: Model, real: Real) {
		acknowledgeAllIssues(real.db);
		for (const { instance } of model.files.values()) {
			if (!instance.bad) continue;
			instance.mayBeAccepted = true;
			if (instance.rowVerified) instance.accepted = true;
		}
		return Promise.resolve();
	}
	toString() {
		return 'flacscan accept';
	}
}

class TimePasses implements fc.AsyncCommand<Model, Real> {
	check() {
		return true;
	}
	run(_model: Model, real: Real) {
		real.db
			.prepare(
				`UPDATE files SET last_verified_at = '2000-01-01T00:00:00.000Z' WHERE last_verified_at IS NOT NULL`,
			)
			.run();
		return Promise.resolve();
	}
	toString() {
		return '91 days pass';
	}
}

function checkAcceptance({ instance, name }: ModelFile, row: FileRow) {
	if (row.acknowledged_at !== null) {
		reached.acceptedRows++;
		expect(instance.mayBeAccepted, `${name} carries an acceptance its bytes never earned`).toBe(
			true,
		);
	}
	if (!instance.accepted) {
		return;
	}

	expect(row.acknowledged_at, `${name} lost the acceptance it was given`).not.toBeNull();
	if (instance.renames > 0) reached.carriedAcceptances++;
}

function checkHealthyHistory({ instance, name }: ModelFile, row: FileRow) {
	if (row.last_result === 'healthy') {
		instance.mayHaveHealthyHistory = true;
		instance.mustHaveHealthyHistory = true;
	}
	if (row.last_healthy_at === null) {
		expect(instance.mustHaveHealthyHistory, `${name} lost the healthy history it earned`).toBe(
			false,
		);
		return;
	}
	expect(
		instance.mayHaveHealthyHistory,
		`${name} carries healthy history its bytes never earned`,
	).toBe(true);
	if (row.last_result === 'corrupt') reached.regressions++;
}

function checkVerdict({ instance, name }: ModelFile, row: FileRow, wholeCollection: boolean) {
	const verdict = instance.bad ? 'corrupt' : 'healthy';
	const allowed: string[] = [verdict];
	if (!wholeCollection) allowed.push('pending');
	if (instance.rotted && (instance.duplicated || !instance.rowVerified)) allowed.push('healthy');
	expect(allowed, `verdict for ${name}`).toContain(row.last_result);
	if (row.last_result === verdict) instance.rowVerified = true;
}

class Scan implements fc.AsyncCommand<Model, Real> {
	batchSize: number;
	constructor(batchSize: number) {
		this.batchSize = batchSize;
	}
	check() {
		return true;
	}
	async run(model: Model, real: Real) {
		const config = { ...real.config, batch_size: this.batchSize };
		const { discovery, files } = await scanCollection(real.db, real.root, config);
		reached.moves += discovery.moved;
		const wholeCollection = this.batchSize >= model.files.size;

		const listed = files.toSorted(byText);
		const modelPaths = [...model.files.values()].map(({ name }) => path.join(real.root, name));
		expect(listed).toEqual(modelPaths.toSorted(byText));

		for (const file of model.files.values()) {
			const row = findFileByPath(real.db, path.join(real.root, file.name));
			expect(row, `row for ${file.name}`).toBeDefined();
			if (row === undefined) continue;
			checkVerdict(file, row, wholeCollection);
			checkAcceptance(file, row);
			checkHealthyHistory(file, row);
		}

		const rowPaths = real.db.prepare(`SELECT current_path FROM files`).pluck().all() as string[];
		expect(rowPaths.toSorted(byText), 'rows under the root').toEqual(listed);
	}
	toString() {
		return 'flacscan scan';
	}
}

function lifecycleCommands(names: readonly string[]) {
	const name = fc.constantFrom(...names);
	return fc.commands(
		[
			fc
				.tuple(name, fc.boolean(), fc.constantFrom(4, 5))
				.map(([file, bad, size]) => new WriteFile(file, bad, size)),
			fc.tuple(name, name).map(([from, to]) => new CopyPreservingMtime(from, to)),
			fc.tuple(name, name).map(([from, to]) => new RenameFile(from, to)),
			name.map((file) => new RotInPlace(file)),
			name.map((file) => new DeleteFile(file)),
			fc.constant(new Accept()),
			fc.constant(new TimePasses()),
			fc.constantFrom(1, 1, 1000).map((batchSize) => new Scan(batchSize)),
			fc
				.tuple(name, fc.boolean(), fc.constantFrom(4, 5))
				.map(([file, bad, size]) => new WriteFile(file, bad, size)),
			fc.constant(new Accept()),
			fc.constant(new TimePasses()),
			fc.constantFrom(1, 1, 1000).map((batchSize) => new Scan(batchSize)),
		],
		{ maxCommands: 25 },
	);
}

function moveCommands(names: readonly string[]) {
	const name = fc.constantFrom(...names);
	const rename = fc.tuple(name, name).map(([from, to]) => new RenameFile(from, to));
	const copy = fc.tuple(name, name).map(([from, to]) => new CopyPreservingMtime(from, to));
	return fc.commands(
		[
			fc
				.tuple(name, fc.boolean(), fc.constantFrom(4, 5))
				.map(([file, bad, size]) => new WriteFile(file, bad, size)),
			copy,
			copy,
			rename,
			rename,
			rename,
			name.map((file) => new DeleteFile(file)),
			fc.constant(new Accept()),
			fc.constant(new Scan(1000)),
		],
		{ maxCommands: 15 },
	);
}

function rotCommands(names: readonly string[]) {
	const name = fc.constantFrom(...names);
	const rot = name.map((file) => new RotInPlace(file));
	return fc.commands(
		[
			fc
				.tuple(name, fc.boolean(), fc.constantFrom(4, 5))
				.map(([file, bad, size]) => new WriteFile(file, bad, size)),
			rot,
			rot,
			fc.tuple(name, name).map(([from, to]) => new RenameFile(from, to)),
			name.map((file) => new DeleteFile(file)),
			fc.constant(new Accept()),
			fc.constant(new TimePasses()),
			fc.constantFrom(1, 1000).map((batchSize) => new Scan(batchSize)),
			fc.constant(new Scan(1000)),
		],
		{ maxCommands: 20, size: '+1' },
	);
}

let runCounter = 0;

async function runLifecycle(commands: Iterable<fc.AsyncCommand<Model, Real>>) {
	runCounter++;
	const root = path.join(workspace, `run-${String(runCounter)}`);
	fs.mkdirSync(root);
	const db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	let mtimeSeconds = 1_700_000_000;
	const setup = () => ({
		model: {
			files: new Map(),
			key: (name: string) => (caseInsensitiveTmp ? name.toLowerCase() : name),
		},
		real: {
			config: makeTestConfig(root, {
				batch_size: 1000,
				log_path: path.join(workspace, `run-${String(runCounter)}.log`),
				parallelism: 1,
			}),
			db,
			nextMtimeSeconds: () => ++mtimeSeconds,
			root,
		},
	});
	try {
		await fc.asyncModelRun(setup, [...commands, new Scan(1000)]);
	} finally {
		db.close();
	}
}

let findingCounter = 0;
function freshCollection() {
	findingCounter++;
	const root = path.join(workspace, `finding-${String(findingCounter)}`);
	fs.mkdirSync(root);
	const db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	const config = makeTestConfig(root, { log_path: `${root}.log`, parallelism: 1 });
	const rowFor = (name: string) => findFileByPath(db, path.join(root, name));
	const rowNames = () =>
		(db.prepare(`SELECT current_path FROM files`).pluck().all() as string[])
			.map((rowPath) => path.basename(rowPath))
			.toSorted(byText);
	return {
		at: (name: string) => path.join(root, name),
		db,
		rowFor,
		rowNames,
		scan: () => scanCollection(db, root, config),
	};
}

describe('scan lifecycle against a reference model', () => {
	test.prop([lifecycleCommands(['a.flac', 'A.flac', 'b.flac', 'c.flac'])], { numRuns: 3000 })(
		'rows are exactly the files, each verdict matches its bytes, and acceptance follows a file that is never duplicated or rewritten through any renames',
		async (commands) => {
			await runLifecycle(commands);
		},
		60_000,
	);

	test.prop([moveCommands(['a.flac', 'A.flac', 'b.flac'])], { numRuns: 1000 })(
		'the same holds when renames, deletes and copies crowd between scans',
		async (commands) => {
			await runLifecycle(commands);
		},
		60_000,
	);

	test.prop([rotCommands(['a.flac', 'A.flac', 'b.flac'])], { numRuns: 1000 })(
		'healthy history follows a file that rots in place through renames, and a rescan flags it as a regression',
		async (commands) => {
			await runLifecycle(commands);
		},
		60_000,
	);

	describe('former findings', () => {
		it.runIf(caseInsensitiveTmp)(
			'a case-only rename keeps accepted corruption quiet and leaves one row',
			async () => {
				const collection = freshCollection();
				writeFlac(collection.at('track.flac'), true, 4);
				await collection.scan();
				acknowledgeAllIssues(collection.db);
				fs.renameSync(collection.at('track.flac'), collection.at('Track.flac'));
				const { newCorrupt } = await collection.scan();
				const rows = collection.rowNames();
				collection.db.close();

				expect(newCorrupt).toBe(0);
				expect(rows).toEqual(['Track.flac']);
			},
		);

		it('renaming onto the name of a deleted file carries accepted corruption', async () => {
			const collection = freshCollection();
			writeFlac(collection.at('old.flac'), false, 5);
			await collection.scan();
			fs.unlinkSync(collection.at('old.flac'));
			writeFlac(collection.at('track.flac'), true, 4);
			await collection.scan();
			acknowledgeAllIssues(collection.db);
			fs.renameSync(collection.at('track.flac'), collection.at('old.flac'));
			const { newCorrupt } = await collection.scan();
			const moved = collection.rowFor('old.flac');
			const rows = collection.rowNames();
			collection.db.close();

			expect(newCorrupt).toBe(0);
			expect(moved?.acknowledged_at).not.toBeNull();
			expect(rows).toEqual(['old.flac']);
		});

		it('renaming an accepted file and reusing its old name carries the acceptance', async () => {
			const collection = freshCollection();
			writeFlac(collection.at('track.flac'), true, 4);
			await collection.scan();
			acknowledgeAllIssues(collection.db);
			fs.renameSync(collection.at('track.flac'), collection.at('track (damaged).flac'));
			writeFlac(collection.at('track.flac'), false, 5);
			const { newCorrupt } = await collection.scan();
			const moved = collection.rowFor('track (damaged).flac');
			collection.db.close();

			expect(newCorrupt).toBe(0);
			expect(moved?.acknowledged_at).not.toBeNull();
		});
	});

	describe('regression', () => {
		it('flags a file that rots in place after verifying healthy, follows it through a move, and forgets a rewritten one', async () => {
			const collection = freshCollection();
			writeFlac(collection.at('rots.flac'), false, 4);
			fs.utimesSync(collection.at('rots.flac'), 1_700_000_001, 1_700_000_001);
			writeFlac(collection.at('rewritten.flac'), false, 4);
			fs.utimesSync(collection.at('rewritten.flac'), 1_700_000_002, 1_700_000_002);
			await collection.scan();
			const healthyAt = collection.rowFor('rots.flac')?.last_healthy_at;

			writeFlac(collection.at('rots.flac'), true, 4);
			fs.utimesSync(collection.at('rots.flac'), 1_700_000_001, 1_700_000_001);
			fs.renameSync(collection.at('rots.flac'), collection.at('moved.flac'));
			writeFlac(collection.at('rewritten.flac'), true, 4);
			collection.db.prepare(`UPDATE files SET last_verified_at = '2000-01-01T00:00:00.000Z'`).run();
			const { newRegressed } = await collection.scan();
			const moved = collection.rowFor('moved.flac');
			const rewritten = collection.rowFor('rewritten.flac');
			const listed = getRegressedFiles(collection.db).map((row) => path.basename(row.current_path));
			collection.db.close();

			expect(healthyAt).toEqual(expect.any(String));
			expect(newRegressed).toBe(1);
			expect(moved).toMatchObject({ last_healthy_at: healthyAt, last_result: 'corrupt' });
			expect(rewritten).toMatchObject({ last_healthy_at: null, last_result: 'corrupt' });
			expect(listed).toEqual(['moved.flac']);
		});
	});

	it('reached moves and accepted corruption in the runs above, so the property is not vacuous', () => {
		expect(reached.moves).toBeGreaterThan(0);
		expect(reached.acceptedRows).toBeGreaterThan(0);
		expect(reached.carriedAcceptances).toBeGreaterThan(0);
		expect(reached.regressions).toBeGreaterThan(0);
	});
});
