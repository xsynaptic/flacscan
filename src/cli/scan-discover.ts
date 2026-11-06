import type Database from 'better-sqlite3';
import type { Ora } from 'ora';

import chalk from 'chalk';
import fs from 'node:fs';
import ora from 'ora';

import type { FlacScanConfig } from '#config/types.ts';

import { isShuttingDown } from '#cli/process-pool.ts';
import {
	clearRecoveryOutcome,
	deleteFileByPath,
	deleteUnreadableByPath,
	findFileByPath,
	findFilesBySizeAndMtime,
	findUnreadableByPath,
	getPathsUnder,
	updateFilePath,
	upsertFile,
	upsertUnreadableFile,
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

interface Observed {
	mtime: string;
	size: number;
}

interface Observation {
	observed: Map<string, Observed>;
	unreadable: Set<string>;
}

interface Destination {
	existing: boolean;
	filePath: string;
	stat: Observed;
}

interface Move {
	from: string;
	to: Destination;
}

interface DiscoveryRun {
	db: Database.Database;
	logPath: string;
	progress: Progress;
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
	db: Database.Database,
	config: FlacScanConfig,
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
		walked,
	};
	const { spinner, stats } = run.progress;

	const observation = await observe(run, listed);
	if (observation !== undefined) {
		const destinations = classify(db, observation, stats);
		const moves = planMoves(run, destinations, observation);
		applyMoves(db, moves, config);
		stats.moved = moves.length;
		const moved = new Set(moves.map((move) => move.to.filePath));
		await upsertChanged(
			db,
			destinations.filter((destination) => !moved.has(destination.filePath)),
		);
	}

	if (observation === undefined || isShuttingDown()) {
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
		if (isShuttingDown()) return undefined;
		const chunk = listed.slice(offset, offset + CHUNK_SIZE);
		run.db.transaction(() => {
			for (const filePath of chunk) observeFile(run, filePath, observation);
		})();
		// Yield so SIGINT and the spinner can run between chunks
		await new Promise((resolve) => setImmediate(resolve));
	}
	return isShuttingDown() ? undefined : observation;
}

function observeFile(
	{ db, logPath, progress: { spinner, stats, total } }: DiscoveryRun,
	filePath: string,
	observation: Observation,
) {
	stats.processed++;
	spinner.text = `Discovery: ${String(stats.processed)}/${String(total)} files`;
	try {
		const stat = fs.statSync(filePath);
		observation.observed.set(filePath, { mtime: stat.mtime.toISOString(), size: stat.size });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		observation.unreadable.add(filePath);
		upsertUnreadableFile(db, { current_path: filePath, error_output: String(error) });
		logUnreadable(logPath, filePath, String(error));
		stats.unreadable++;
	}
}

function classify(
	db: Database.Database,
	{ observed }: Observation,
	stats: DiscoveryStats,
): Destination[] {
	const destinations: Destination[] = [];
	for (const [filePath, stat] of observed) {
		const existing = findFileByPath(db, filePath);
		if (existing?.file_mtime === stat.mtime && existing.file_size === stat.size) {
			stats.skipped++;
			continue;
		}
		destinations.push({ existing: existing !== undefined, filePath, stat });
	}
	return destinations;
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
	destinations: Destination[],
	{ observed, unreadable }: Observation,
): Move[] {
	const prefixes = walked.map((directory) => directoryPrefix(directory));
	const candidatesByDestination = destinations.map((destination) =>
		findFilesBySizeAndMtime(db, destination.stat.size, destination.stat.mtime)
			.map((row) => row.current_path)
			.filter((candidate) => {
				if (candidate === destination.filePath || unreadable.has(candidate)) return false;
				if (prefixes.every((prefix) => !candidate.startsWith(prefix))) return false;
				const now = observed.get(candidate);
				return now?.size !== destination.stat.size || now.mtime !== destination.stat.mtime;
			}),
	);
	const claims = countClaims(candidatesByDestination);

	const moves: Move[] = [];
	for (const [index, destination] of destinations.entries()) {
		const candidates = candidatesByDestination[index] ?? [];
		const [only] = candidates;
		if (only !== undefined && candidates.length === 1 && claims.get(only) === 1) {
			moves.push({ from: only, to: destination });
		}
	}
	return moves;
}

function applyMoves(db: Database.Database, moves: Move[], config: FlacScanConfig) {
	if (moves.length === 0) return;
	const sources = new Set(moves.map((move) => move.from));
	db.transaction(() => {
		for (const move of moves) {
			if (move.to.existing && !sources.has(move.to.filePath)) {
				deleteFileByPath(db, move.to.filePath);
			}
		}
		for (const [index, move] of moves.entries()) {
			updateFilePath(db, move.from, `moving:${String(index)}`);
		}
		for (const [index, move] of moves.entries()) {
			updateFilePath(db, `moving:${String(index)}`, move.to.filePath);
			deleteUnreadableByPath(db, move.to.filePath);
		}
	})();
	for (const move of moves) logFileMoved(config.log_path, move.from, move.to.filePath);
}

async function upsertChanged(db: Database.Database, destinations: Destination[]) {
	for (let offset = 0; offset < destinations.length && !isShuttingDown(); offset += CHUNK_SIZE) {
		const chunk = destinations.slice(offset, offset + CHUNK_SIZE);
		db.transaction(() => {
			for (const destination of chunk) upsertDestination(db, destination);
		})();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function upsertDestination(db: Database.Database, { existing, filePath, stat }: Destination) {
	if (findUnreadableByPath(db, filePath)) {
		deleteUnreadableByPath(db, filePath);
	}
	try {
		upsertFile(db, { current_path: filePath, file_mtime: stat.mtime, file_size: stat.size });
		if (existing) clearRecoveryOutcome(db, filePath);
	} catch (error) {
		console.warn(`Warning: failed to update database for ${filePath}: ${String(error)}`);
	}
}

function pruneUnlisted(
	{ db, progress: { spinner }, walked }: DiscoveryRun,
	{ observed, unreadable }: Observation,
): number {
	const isListed = (filePath: string) => observed.has(filePath) || unreadable.has(filePath);
	const files = getPathsUnder(db, 'files', walked).filter((row) => !isListed(row));
	const unreadableRows = getPathsUnder(db, 'unreadable_files', walked).filter(
		(row) => !isListed(row),
	);
	db.transaction(() => {
		for (const filePath of files) deleteFileByPath(db, filePath);
		for (const filePath of unreadableRows) deleteUnreadableByPath(db, filePath);
	})();
	for (const filePath of [...files, ...unreadableRows]) {
		spinner.clear();
		console.log(chalk.blue(`  PRUNED ${filePath}`));
	}
	return files.length + unreadableRows.length;
}
