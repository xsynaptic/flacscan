import { defineCommand } from 'citty';
import path from 'node:path';

import type { FileRow, UnreadableFileRow } from '#database/types.ts';

import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import {
	getAllUnreadableFiles,
	getCorruptFiles,
	getCorruptFilesByAcknowledged,
	getRegressedFiles,
	getUnreadableFilesByAcknowledged,
} from '#database/queries.ts';

interface CorruptJsonEntry {
	acknowledged_at: null | string;
	album: null | string;
	artist: null | string;
	duration: null | number;
	error_output: null | string;
	error_severity: null | string;
	error_timestamp: null | string;
	file_size: null | number;
	input_text: string;
	last_healthy_at: null | string;
	original_path: string;
	recovery_attempted_at: null | string;
	recovery_detail: null | string;
	recovery_lost_samples: null | number;
	recovery_result: null | string;
	title: null | string;
	type: 'corrupt';
	year: null | string;
}

interface UnreadableJsonEntry {
	acknowledged_at: null | string;
	error_output: string;
	original_path: string;
	type: 'unreadable';
}

const VALID_FILTERS = ['accepted', 'new', 'regressed', 'unreadable'] as const;
type Filter = (typeof VALID_FILTERS)[number];

function deriveInputText(file: FileRow): string {
	const artist = file.artist?.trim();
	const title = file.title?.trim();
	if (artist && title) return `${artist} - ${title}`;
	return path.basename(file.current_path, path.extname(file.current_path));
}

function installPipeHandler() {
	process.stdout.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code === 'EPIPE') process.exit(0);
		// Throwing here would exit 1, which this tool reads as "corruption found"
		console.error(String(error));
		process.exit(2);
	});
}

function toCorruptJson(file: FileRow): CorruptJsonEntry {
	return {
		acknowledged_at: file.acknowledged_at,
		album: file.album,
		artist: file.artist,
		duration: file.duration,
		error_output: file.error_output,
		error_severity: file.error_severity,
		error_timestamp: file.error_timestamp,
		file_size: file.file_size,
		input_text: deriveInputText(file),
		last_healthy_at: file.last_healthy_at,
		original_path: file.current_path,
		recovery_attempted_at: file.recovery_attempted_at,
		recovery_detail: file.recovery_detail,
		recovery_lost_samples: file.recovery_lost_samples,
		recovery_result: file.recovery_result,
		title: file.title,
		type: 'corrupt',
		year: file.date,
	};
}

function toUnreadableJson(file: UnreadableFileRow): UnreadableJsonEntry {
	return {
		acknowledged_at: file.acknowledged_at,
		error_output: file.error_output,
		original_path: file.current_path,
		type: 'unreadable',
	};
}

export const listCommand = defineCommand({
	args: {
		...sharedArguments,
		filter: {
			description: 'Filter: new, accepted, regressed, unreadable',
			required: false,
			type: 'positional',
		},
		json: {
			description: 'Output as JSON',
			required: false,
			type: 'boolean',
		},
	},
	meta: {
		description: 'List file paths for scripting (pipe to xargs, wc -l, etc.)',
		name: 'list',
	},
	async run({ args }) {
		installPipeHandler();
		const filter = args.filter as Filter | undefined;

		if (filter && !VALID_FILTERS.includes(filter)) {
			console.error(`Unknown filter: ${filter}`);
			console.error(`Valid filters: ${VALID_FILTERS.join(', ')}`);
			process.exitCode = 1;
			return;
		}

		const jsonOutput = args.json === true;

		await runCommand(args, {}, (db) => {
			if (filter === 'unreadable') {
				// Keeps the query's byte order; the merged filters below sort with localeCompare
				writeEntries(
					getAllUnreadableFiles(db).map((file) => toUnreadableJson(file)),
					jsonOutput,
				);
				return;
			}
			if (filter === 'regressed') {
				writeEntries(
					getRegressedFiles(db).map((file) => toCorruptJson(file)),
					jsonOutput,
				);
				return;
			}
			if (filter === 'new' || filter === 'accepted') {
				const accepted = filter === 'accepted';
				writeIssues(
					getCorruptFilesByAcknowledged(db, accepted),
					getUnreadableFilesByAcknowledged(db, accepted),
					jsonOutput,
				);
				return;
			}
			writeIssues(getCorruptFiles(db), getAllUnreadableFiles(db), jsonOutput);
		});
	},
});

function writeIssues(corrupt: FileRow[], unreadable: UnreadableFileRow[], jsonOutput: boolean) {
	const entries: (CorruptJsonEntry | UnreadableJsonEntry)[] = [
		...corrupt.map((file) => toCorruptJson(file)),
		...unreadable.map((file) => toUnreadableJson(file)),
	];
	entries.sort((a, b) => a.original_path.localeCompare(b.original_path));
	writeEntries(entries, jsonOutput);
}

function writeEntries(entries: (CorruptJsonEntry | UnreadableJsonEntry)[], jsonOutput: boolean) {
	if (jsonOutput) {
		process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
		return;
	}
	for (const entry of entries) process.stdout.write(entry.original_path + '\n');
}
