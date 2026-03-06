import { defineCommand } from 'citty';
import path from 'node:path';

import type { FileRow, UnreadableFileRow } from '../database/types.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import {
	getAllUnreadableFiles,
	getCorruptFiles,
	getCorruptFilesBySeverity,
} from '../database/queries.js';
import { FlacScanError } from './errors.js';
import { sharedArguments } from './shared-arguments.js';

interface CorruptJsonEntry {
	album: null | string;
	artist: null | string;
	duration: null | number;
	error_output: null | string;
	error_severity: null | string;
	error_timestamp: null | string;
	file_size: null | number;
	input_text: string;
	original_path: string;
	title: null | string;
	type: 'corrupt';
	year: null | string;
}

interface UnreadableJsonEntry {
	error_output: string;
	original_path: string;
	type: 'unreadable';
}

const VALID_FILTERS = ['critical', 'recoverable', 'unknown', 'unreadable'] as const;
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
		throw error;
	});
}

function toCorruptJson(file: FileRow): CorruptJsonEntry {
	return {
		album: file.album,
		artist: file.artist,
		duration: file.duration,
		error_output: file.error_output,
		error_severity: file.error_severity,
		error_timestamp: file.error_timestamp,
		file_size: file.file_size,
		input_text: deriveInputText(file),
		original_path: file.current_path,
		title: file.title,
		type: 'corrupt',
		year: file.date,
	};
}

function toUnreadableJson(file: UnreadableFileRow): UnreadableJsonEntry {
	return {
		error_output: file.error_output,
		original_path: file.current_path,
		type: 'unreadable',
	};
}

export const listCommand = defineCommand({
	args: {
		...sharedArguments,
		filter: {
			description: 'Filter: critical, recoverable, unknown, unreadable',
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
	run({ args }) {
		try {
			installPipeHandler();
			const filter = args.filter as Filter | undefined;
			const jsonOutput = args.json === true;

			if (filter && !VALID_FILTERS.includes(filter)) {
				console.error(`Unknown filter: ${filter}`);
				console.error(`Valid filters: ${VALID_FILTERS.join(', ')}`);
				process.exitCode = 1;
				return;
			}

			const config = loadConfig(args);
			const db = openDatabase(config.db_path);

			try {
				if (filter === 'unreadable') {
					const files = getAllUnreadableFiles(db);
					if (jsonOutput) {
						process.stdout.write(
							JSON.stringify(
								files.map((f) => toUnreadableJson(f)),
								null,
								2,
							) + '\n',
						);
					} else {
						for (const file of files) process.stdout.write(file.current_path + '\n');
					}
					return;
				}

				if (filter) {
					const files = getCorruptFilesBySeverity(db, filter);
					if (jsonOutput) {
						process.stdout.write(
							JSON.stringify(
								files.map((f) => toCorruptJson(f)),
								null,
								2,
							) + '\n',
						);
					} else {
						for (const file of files) process.stdout.write(file.current_path + '\n');
					}
					return;
				}

				const corrupt = getCorruptFiles(db);
				const unreadable = getAllUnreadableFiles(db);

				if (jsonOutput) {
					const results: Array<CorruptJsonEntry | UnreadableJsonEntry> = [
						...corrupt.map((f) => toCorruptJson(f)),
						...unreadable.map((f) => toUnreadableJson(f)),
					];
					results.sort((a, b) => a.original_path.localeCompare(b.original_path));
					process.stdout.write(JSON.stringify(results, null, 2) + '\n');
				} else {
					const paths = [
						...corrupt.map((f) => f.current_path),
						...unreadable.map((f) => f.current_path),
					];
					paths.sort((a, b) => a.localeCompare(b));
					for (const filePath of paths) process.stdout.write(filePath + '\n');
				}
			} finally {
				db.close();
			}
		} catch (error) {
			if (error instanceof FlacScanError) {
				console.error(error.message);
				process.exitCode = error.exitCode;
				return;
			}
			throw error;
		}
	},
});
