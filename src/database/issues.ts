import type Database from 'better-sqlite3';

import type { FileRow, UnreadableFileRow } from '#database/types.ts';

export type CorruptKind = 'corrupt' | 'regressed';

export type Issue =
	| { acknowledged: boolean; kind: 'unreadable'; row: UnreadableFileRow }
	| { acknowledged: boolean; kind: CorruptKind; row: FileRow };

const corruptKinds: readonly Issue['kind'][] = ['corrupt', 'regressed'];

export interface IssueCounts {
	corrupt: number;
	newCorrupt: number;
	newRegressed: number;
	newUnreadable: number;
	regressed: number;
	unreadable: number;
}

export function classifyCorrupt(row: Pick<FileRow, 'acknowledged_at' | 'last_healthy_at'>): {
	acknowledged: boolean;
	kind: CorruptKind;
} {
	return {
		acknowledged: row.acknowledged_at !== null,
		kind: row.last_healthy_at === null ? 'corrupt' : 'regressed',
	};
}

export function countIssues(issues: readonly Pick<Issue, 'acknowledged' | 'kind'>[]): IssueCounts {
	const fresh = issues.filter((issue) => !issue.acknowledged);
	return {
		corrupt: countKinds(issues, corruptKinds),
		newCorrupt: countKinds(fresh, corruptKinds),
		newRegressed: countKinds(fresh, ['regressed']),
		newUnreadable: countKinds(fresh, ['unreadable']),
		regressed: countKinds(issues, ['regressed']),
		unreadable: countKinds(issues, ['unreadable']),
	};
}

export function listIssues(database: Database.Database): Issue[] {
	const corrupt = database
		.prepare(`SELECT * FROM files WHERE last_result = 'corrupt' ORDER BY current_path`)
		.all() as FileRow[];
	const unreadable = database
		.prepare(`SELECT * FROM unreadable_files ORDER BY current_path`)
		.all() as UnreadableFileRow[];
	return [
		...corrupt.map((row): Issue => ({ ...classifyCorrupt(row), row })),
		...unreadable.map((row): Issue => ({
			acknowledged: row.acknowledged_at !== null,
			kind: 'unreadable',
			row,
		})),
	];
}

function countKinds(
	issues: readonly Pick<Issue, 'kind'>[],
	kinds: readonly Issue['kind'][],
): number {
	return issues.filter((issue) => kinds.includes(issue.kind)).length;
}
