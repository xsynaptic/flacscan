import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '#config/types.ts';
import type { FileIdentity, Sighting } from '#database/types.ts';
import type { StopSignal } from '#process-pool.ts';

import {
	applyMoves,
	classifySightings,
	identityOf,
	pathsUnder,
	pathsWithIdentity,
	prunePaths,
	recordReadable,
	recordUnreadable,
} from '#database/queries.ts';
import { logFileMoved, logUnreadable } from '#logging/scan-log.ts';
import { directoryPrefix } from '#paths.ts';

// One autocommit per file dominates the initial scan of a large collection
const CHUNK_SIZE = 500;

interface DiscoveryStats {
	moved: number;
	processed: number;
	pruned: number;
	skipped: number;
	unreadable: number;
}

interface Observation {
	observed: Map<string, FileIdentity>;
	unreadable: Set<string>;
}

interface Move {
	from: string;
	to: string;
}

interface DiscoveryRun {
	db: Database.Database;
	logPath: string;
	progress: Progress;
	signal: StopSignal;
	walked: string[];
}

interface Progress {
	spinner: Ora;
	stats: DiscoveryStats;
	total: number;
}

interface Walk {
	files: string[];
	walked: string[];
}

export async function runDiscovery(
	{ config, db, signal }: { config: FlacScanConfig; db: Database.Database; signal: StopSignal },
	{ files, walked }: Walk,
): Promise<DiscoveryStats> {
	const listed = [...new Set(files)];
	const run: DiscoveryRun = {
		db,
		logPath: config.log_path,
		progress: {
			spinner: ora({
				discardStdin: false,
				text: `Discovery: processing 0/${String(listed.length)} files`,
			}).start(),
			stats: { moved: 0, processed: 0, pruned: 0, skipped: 0, unreadable: 0 },
			total: listed.length,
		},
		signal,
		walked,
	};
	const { spinner, stats } = run.progress;

	const observation = await observe(run, listed);
	if (observation !== undefined) {
		const sightings = [...observation.observed].map(([filePath, identity]): Sighting => ({
			identity,
			path: filePath,
		}));
		const { changed, reread } = classifySightings(db, sightings);
		stats.skipped = sightings.length - changed.length;
		const moves = planMoves(run, changed, observation);
		applyMoves(db, moves);
		for (const move of moves) logFileMoved(config.log_path, move.from, move.to);
		stats.moved = moves.length;
		const moved = new Set(moves.map((move) => move.to));
		await recordChanged(run, [
			...changed.filter((sighting) => !moved.has(sighting.path)),
			...reread,
		]);
	}

	if (observation === undefined || signal.aborted) {
		spinner.warn(
			`Discovery interrupted: ${String(stats.processed)}/${String(listed.length)} files processed`,
		);
		return stats;
	}

	stats.pruned = pruneUnlisted(run, observation);
	const movedSummary = stats.moved > 0 ? `, ${String(stats.moved)} moved` : '';
	const prunedSummary = stats.pruned > 0 ? `, ${String(stats.pruned)} pruned` : '';
	spinner.succeed(
		`Discovery complete: ${String(listed.length)} files (${String(stats.skipped)} cached, ${String(stats.unreadable)} unreadable${movedSummary}${prunedSummary})`,
	);
	return stats;
}

async function observe(run: DiscoveryRun, listed: string[]): Promise<Observation | undefined> {
	const observation: Observation = { observed: new Map(), unreadable: new Set() };
	for (let offset = 0; offset < listed.length; offset += CHUNK_SIZE) {
		if (run.signal.aborted) return undefined;
		const chunk = listed.slice(offset, offset + CHUNK_SIZE);
		const unreadable = chunk.flatMap((filePath) => observeFile(run, filePath, observation));
		recordUnreadable(run.db, unreadable);
		// Yield so SIGINT and the spinner can run between chunks
		await new Promise((resolve) => setImmediate(resolve));
	}
	return run.signal.aborted ? undefined : observation;
}

function observeFile(
	{ logPath, progress: { spinner, stats, total } }: DiscoveryRun,
	filePath: string,
	observation: Observation,
): { error: string; path: string }[] {
	stats.processed++;
	spinner.text = `Discovery: ${String(stats.processed)}/${String(total)} files`;
	try {
		observation.observed.set(filePath, identityOf(fs.statSync(filePath)));
		return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		observation.unreadable.add(filePath);
		logUnreadable(logPath, filePath, String(error));
		stats.unreadable++;
		return [{ error: String(error), path: filePath }];
	}
}

function countClaims(candidatesByDestination: string[][]): Map<string, number> {
	const claims = new Map<string, number>();
	for (const candidates of candidatesByDestination) {
		for (const candidate of candidates) claims.set(candidate, (claims.get(candidate) ?? 0) + 1);
	}
	return claims;
}

function planMoves(
	{ db, walked }: DiscoveryRun,
	destinations: Sighting[],
	{ observed, unreadable }: Observation,
): Move[] {
	const prefixes = walked.map((directory) => directoryPrefix(directory));
	const candidatesByDestination = destinations.map(({ identity, path: destination }) =>
		pathsWithIdentity(db, identity).filter((candidate) => {
			if (candidate === destination || unreadable.has(candidate)) return false;
			if (prefixes.every((prefix) => !candidate.startsWith(prefix))) return false;
			const now = observed.get(candidate);
			return now?.size !== identity.size || now.mtime !== identity.mtime;
		}),
	);
	const claims = countClaims(candidatesByDestination);

	const moves: Move[] = [];
	for (const [index, destination] of destinations.entries()) {
		const candidates = candidatesByDestination[index] ?? [];
		const [only] = candidates;
		if (only !== undefined && candidates.length === 1 && claims.get(only) === 1) {
			moves.push({ from: only, to: destination.path });
		}
	}
	return moves;
}

async function recordChanged({ db, signal }: DiscoveryRun, sightings: Sighting[]) {
	for (let offset = 0; offset < sightings.length && !signal.aborted; offset += CHUNK_SIZE) {
		recordReadable(db, sightings.slice(offset, offset + CHUNK_SIZE));
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function pruneUnlisted(
	{ db, progress: { spinner }, walked }: DiscoveryRun,
	{ observed, unreadable }: Observation,
): number {
	const isListed = (filePath: string) => observed.has(filePath) || unreadable.has(filePath);
	const unlisted = pathsUnder(db, walked).filter((filePath) => !isListed(filePath));
	prunePaths(db, unlisted);
	for (const filePath of unlisted) {
		spinner.clear();
		console.log(chalk.blue(`  PRUNED ${filePath}`));
	}
	return unlisted.length;
}
