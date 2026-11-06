import { fc, test } from '@fast-check/vitest';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { FileStatus } from '#database/types.ts';

import { getFilesNeedingVerification } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';
import { directoryPrefix } from '#paths.ts';

const segment = fc.string({
	maxLength: 3,
	minLength: 1,
	unit: fc.constantFrom('a', 'A', 'b', '%', '_', '\\'),
});
const absolutePath = fc
	.array(segment, { maxLength: 3, minLength: 1 })
	.map((parts) => `/${parts.join('/')}`);

const day = 24 * 60 * 60 * 1000;
const verifiedAt = fc
	.constantFrom(null, 200, 100, 100, 1)
	.map((daysAgo) => (daysAgo === null ? null : new Date(Date.now() - daysAgo * day).toISOString()));

const fileRow = fc.record(
	{
		currentPath: absolutePath,
		lastResult: fc.constantFrom<FileStatus>('pending', 'healthy', 'corrupt'),
		lastVerifiedAt: verifiedAt,
	},
	{ noNullPrototype: true },
);

const rootBoundarySuffix = fc.constantFrom('', '/a', '0', '0/a', '.', '/');

function rowsNear(roots: readonly string[]) {
	const nearRoot = fc
		.tuple(fileRow, fc.constantFrom(...roots), rootBoundarySuffix)
		.map(([row, root, suffix]) => ({ ...row, currentPath: root + suffix }));
	return fc.array(fc.oneof(fileRow, nearRoot), { maxLength: 12 });
}

const rowsAndRoots = fc
	.array(absolutePath, { maxLength: 2, minLength: 1 })
	.chain((roots) => fc.tuple(rowsNear(roots), fc.constant(roots)));

type GeneratedRow = typeof fileRow extends fc.Arbitrary<infer Row> ? Row : never;

function seed(rows: readonly GeneratedRow[]) {
	const db = new BetterSqlite3(':memory:');
	initializeSchema(db);
	const insert = db.prepare(
		`INSERT OR IGNORE INTO files (current_path, last_result, last_verified_at, first_seen_at, updated_at)
		VALUES (?, ?, ?, '', '')`,
	);
	for (const row of rows) insert.run(row.currentPath, row.lastResult, row.lastVerifiedAt);
	return db;
}

function byText(left: string, right: string) {
	return left.localeCompare(right);
}

function isUnderARoot(filePath: string, roots: readonly string[]) {
	return roots.some((root) => filePath.startsWith(directoryPrefix(root)));
}

describe('getFilesNeedingVerification', () => {
	test.prop([rowsAndRoots], { numRuns: 1000 })(
		'selects exactly the rows the JS root filter would, for paths full of case variants, range bounds and LIKE metacharacters',
		([rows, roots]) => {
			const db = seed(rows);
			const all = db.prepare(`SELECT current_path FROM files`).all() as { current_path: string }[];
			const selected = getFilesNeedingVerification(db, 0, 1000, roots).map(
				(row) => row.current_path,
			);
			db.close();

			const expected = all
				.map((row) => row.current_path)
				.filter((filePath) => isUnderARoot(filePath, roots));
			expect(selected.toSorted(byText)).toEqual(expected.toSorted(byText));
		},
	);

	test.prop([fc.array(fileRow, { maxLength: 15 }), fc.integer({ max: 6, min: 1 })], {
		numRuns: 1000,
	})(
		'returns the most overdue eligible files, never-verified first, up to the batch size',
		(rows, batchSize) => {
			const root = '/a';
			const db = seed(rows.map((row) => ({ ...row, currentPath: `${root}${row.currentPath}` })));
			const all = db
				.prepare(`SELECT current_path, last_result, last_verified_at FROM files`)
				.all() as {
				current_path: string;
				last_result: FileStatus;
				last_verified_at: null | string;
			}[];
			const batch = getFilesNeedingVerification(db, 90, batchSize, [root]);
			db.close();

			const cutoff = Date.now() - 90 * day;
			const eligible = all.filter(
				(row) =>
					row.last_result === 'pending' ||
					row.last_verified_at === null ||
					Date.parse(row.last_verified_at) < cutoff,
			);
			const overdueOrder = eligible
				.map((row) =>
					row.last_verified_at === null ? -Infinity : Date.parse(row.last_verified_at),
				)
				.toSorted((left, right) => left - right)
				.slice(0, batchSize);

			expect(
				batch
					.map((row) => row.current_path)
					.every((filePath) => eligible.some((row) => row.current_path === filePath)),
			).toBe(true);
			expect(
				batch.map((row) =>
					row.last_verified_at === null ? -Infinity : Date.parse(row.last_verified_at),
				),
			).toEqual(overdueOrder);
		},
	);

	it('leaves out a row under a root spelled in a different case', () => {
		const db = seed([{ currentPath: '/a/a', lastResult: 'pending', lastVerifiedAt: null }]);
		const selected = getFilesNeedingVerification(db, 0, 1000, ['/A']).map(
			(row) => row.current_path,
		);
		db.close();

		expect(selected).toEqual([]);
	});

	it('reaches both selected and filtered rows, so the agreement property is not vacuous', () => {
		let sawSelected = false;
		let sawFiltered = false;
		const samples = fc.sample(rowsAndRoots, { numRuns: 500, seed: 1 });
		for (const [rows, roots] of samples) {
			const db = seed(rows);
			const selected = getFilesNeedingVerification(db, 0, 1000, roots).length;
			const total = (db.prepare(`SELECT COUNT(*) AS count FROM files`).get() as { count: number })
				.count;
			db.close();
			if (selected > 0) sawSelected = true;
			if (selected < total) sawFiltered = true;
		}
		expect([sawSelected, sawFiltered]).toEqual([true, true]);
	});
});
