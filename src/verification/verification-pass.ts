import type Database from 'better-sqlite3';

import type { IssueCounts } from '#database/issues.ts';
import type { StopSignal } from '#process-pool.ts';
import type { VerifyOutcome } from '#verification/verify-and-record.ts';
import type { FormatVerifier } from '#verifiers/types.ts';

import { countIssues } from '#database/issues.ts';
import {
	findFileByPath,
	identityOf,
	prunePaths,
	recordReadable,
	recordUnreadable,
} from '#database/queries.ts';
import { logUnreadable } from '#logging/scan-log.ts';
import { statAsSpelled } from '#paths.ts';
import { processPool } from '#process-pool.ts';
import { verifyAndRecord } from '#verification/verify-and-record.ts';

export interface PassContext {
	db: Database.Database;
	fix: boolean;
	logPath: string;
	parallelism: number;
	signal: StopSignal;
	verifier: FormatVerifier;
}

export type PassOutcome =
	| Exclude<VerifyOutcome, { kind: 'interrupted' }>
	| { error: string; kind: 'unreadable' }
	| { kind: 'pruned' };

export interface PassStats extends IssueCounts {
	fixed: number;
	healthy: number;
	pruned: number;
	unreadableNow: number;
	verified: number;
}

type Tally = Omit<PassStats, keyof IssueCounts> & {
	corruptIssues: Extract<PassOutcome, { kind: 'corrupt' }>['issue'][];
};

export function emptyPassStats(): PassStats {
	return { ...countIssues([]), fixed: 0, healthy: 0, pruned: 0, unreadableNow: 0, verified: 0 };
}

export async function runVerificationPass(
	context: PassContext,
	paths: string[],
	onOutcome: (path: string, outcome: PassOutcome) => void,
): Promise<{ exitCode: 0 | 1; stats: PassStats }> {
	const tally: Tally = {
		corruptIssues: [],
		fixed: 0,
		healthy: 0,
		pruned: 0,
		unreadableNow: 0,
		verified: 0,
	};
	await processPool(
		paths,
		{ concurrency: context.parallelism, signal: context.signal },
		async (filePath) => {
			const outcome = await passOne(context, filePath);
			if (outcome === undefined) return;
			count(tally, outcome);
			onOutcome(filePath, outcome);
		},
	);
	const { corruptIssues, ...counters } = tally;
	const stats: PassStats = { ...countIssues(corruptIssues), ...counters };
	return { exitCode: stats.newCorrupt > 0 ? 1 : 0, stats };
}

function count(tally: Tally, outcome: PassOutcome) {
	tally.verified++;
	switch (outcome.kind) {
		case 'corrupt': {
			tally.corruptIssues.push(outcome.issue);
			break;
		}
		case 'fixed': {
			tally.fixed++;
			break;
		}
		case 'healthy': {
			tally.healthy++;
			break;
		}
		case 'pruned': {
			tally.pruned++;
			break;
		}
		case 'unreadable': {
			tally.unreadableNow++;
			break;
		}
	}
}

async function passOne(context: PassContext, filePath: string): Promise<PassOutcome | undefined> {
	const { db, logPath } = context;
	const look = statAsSpelled(filePath);
	if (look.kind === 'missing') {
		prunePaths(db, [filePath]);
		return { kind: 'pruned' };
	}
	if (look.kind === 'unreadable') {
		recordUnreadable(db, [{ error: look.error, path: filePath }]);
		logUnreadable(logPath, filePath, look.error);
		return look;
	}
	recordReadable(db, [{ identity: identityOf(look.stats), path: filePath }]);
	const outcome = await verifyAndRecord(context, findFileByPath(db, filePath)!);
	return outcome.kind === 'interrupted' ? undefined : outcome;
}
