import type Database from 'better-sqlite3';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyCorrupt, countIssues, listIssues } from '#database/issues.ts';
import { recordUnreadable } from '#database/queries.ts';
import { initializeSchema } from '#database/schema.ts';

const accepted = '2020-01-01T00:00:00.000Z';
const healthyAt = '2025-06-01T00:00:00.000Z';

let db: Database.Database;

beforeEach(() => {
	db = new BetterSqlite3(':memory:');
	initializeSchema(db);
});

afterEach(() => {
	db.close();
});

function insertFile(row: {
	acknowledged_at?: string;
	current_path: string;
	last_healthy_at?: string;
	last_result: 'corrupt' | 'healthy' | 'pending';
}) {
	db.prepare(
		`INSERT INTO files (current_path, last_result, last_healthy_at, acknowledged_at, first_seen_at, updated_at)
		VALUES (@current_path, @last_result, @last_healthy_at, @acknowledged_at, 't', 't')`,
	).run({ acknowledged_at: null, last_healthy_at: null, ...row });
}

function unreadable(filePath: string, isAccepted = false) {
	recordUnreadable(db, [{ error: 'EACCES', path: filePath }]);
	if (!isAccepted) return;
	db.prepare(`UPDATE unreadable_files SET acknowledged_at = ? WHERE current_path = ?`).run(
		accepted,
		filePath,
	);
}

function summarize() {
	return listIssues(db).map(({ acknowledged, kind, row }) => ({
		acknowledged,
		kind,
		path: row.current_path,
	}));
}

describe('classifyCorrupt', () => {
	it('reads acceptance from acknowledged_at and regression from healthy history', () => {
		expect(classifyCorrupt({ acknowledged_at: null, last_healthy_at: null })).toEqual({
			acknowledged: false,
			kind: 'corrupt',
		});
		expect(classifyCorrupt({ acknowledged_at: accepted, last_healthy_at: healthyAt })).toEqual({
			acknowledged: true,
			kind: 'regressed',
		});
	});
});

describe('listIssues', () => {
	it('lists corrupt rows in byte order, then unreadable rows in byte order', () => {
		insertFile({ current_path: '/m/b.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/m/Z.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/m/a.flac', last_result: 'corrupt' });
		unreadable('/m/y.flac');
		unreadable('/m/A.flac');

		expect(summarize().map((issue) => issue.path)).toEqual([
			'/m/Z.flac',
			'/m/a.flac',
			'/m/b.flac',
			'/m/A.flac',
			'/m/y.flac',
		]);
	});

	it('leaves out healthy and pending rows', () => {
		insertFile({
			current_path: '/m/healthy.flac',
			last_healthy_at: healthyAt,
			last_result: 'healthy',
		});
		insertFile({ current_path: '/m/pending.flac', last_result: 'pending' });

		expect(listIssues(db)).toEqual([]);
	});

	it('classifies each issue, yielding two for an overlay path', () => {
		insertFile({ current_path: '/m/new.flac', last_result: 'corrupt' });
		insertFile({
			acknowledged_at: accepted,
			current_path: '/m/known.flac',
			last_result: 'corrupt',
		});
		insertFile({
			current_path: '/m/regressed.flac',
			last_healthy_at: healthyAt,
			last_result: 'corrupt',
		});
		unreadable('/m/new.flac');
		unreadable('/m/accepted-unreadable.flac', true);

		expect(summarize()).toEqual([
			{ acknowledged: true, kind: 'corrupt', path: '/m/known.flac' },
			{ acknowledged: false, kind: 'corrupt', path: '/m/new.flac' },
			{ acknowledged: false, kind: 'regressed', path: '/m/regressed.flac' },
			{ acknowledged: true, kind: 'unreadable', path: '/m/accepted-unreadable.flac' },
			{ acknowledged: false, kind: 'unreadable', path: '/m/new.flac' },
		]);
	});
});

describe('countIssues', () => {
	it('returns zeros for no issues', () => {
		expect(countIssues([])).toEqual({
			corrupt: 0,
			newCorrupt: 0,
			newRegressed: 0,
			newUnreadable: 0,
			regressed: 0,
			unreadable: 0,
		});
	});

	it('counts regressed issues within corrupt, split by acceptance, ignoring healthy rows with history', () => {
		insertFile({ current_path: '/m/a.flac', last_healthy_at: healthyAt, last_result: 'corrupt' });
		insertFile({
			acknowledged_at: accepted,
			current_path: '/m/b.flac',
			last_healthy_at: healthyAt,
			last_result: 'corrupt',
		});
		insertFile({ current_path: '/m/c.flac', last_result: 'corrupt' });
		insertFile({ current_path: '/m/d.flac', last_healthy_at: healthyAt, last_result: 'healthy' });

		expect(countIssues(listIssues(db))).toMatchObject({
			corrupt: 3,
			newCorrupt: 2,
			newRegressed: 1,
			regressed: 2,
		});
	});

	it('splits corrupt and unreadable into new and accepted', () => {
		insertFile({ current_path: '/m/new.flac', last_result: 'corrupt' });
		insertFile({
			acknowledged_at: accepted,
			current_path: '/m/known.flac',
			last_result: 'corrupt',
		});
		unreadable('/bad/new.flac');
		unreadable('/bad/known.flac', true);

		expect(countIssues(listIssues(db))).toEqual({
			corrupt: 2,
			newCorrupt: 1,
			newRegressed: 0,
			newUnreadable: 1,
			regressed: 0,
			unreadable: 2,
		});
	});
});
