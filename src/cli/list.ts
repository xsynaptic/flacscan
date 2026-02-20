import { defineCommand } from 'citty';

import type { FileRow } from '../database/types.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import {
	getAllUnreadableFiles,
	getCorruptFiles,
	getCorruptFilesBySeverity,
} from '../database/queries.js';
import { FlacScanError } from './errors.js';
import { sharedArguments } from './shared-arguments.js';

const VALID_FILTERS = ['critical', 'recoverable', 'unknown', 'unreadable'] as const;
type Filter = (typeof VALID_FILTERS)[number];

function groupBySeverity(files: FileRow[]) {
	const groups = {
		critical: [] as FileRow[],
		recoverable: [] as FileRow[],
		unknown: [] as FileRow[],
	};
	for (const file of files) {
		const severity = file.error_severity ?? 'unknown';
		if (severity in groups) {
			groups[severity as keyof typeof groups].push(file);
		} else {
			groups.unknown.push(file);
		}
	}
	return groups;
}

function writeSection(label: string, files: { current_path: string }[]) {
	const count = files.length;
	process.stderr.write(`# ${String(count)} ${label}\n`);
	for (const file of files) {
		process.stdout.write(file.current_path + '\n');
	}
}

export const listCommand = defineCommand({
	args: {
		...sharedArguments,
		filter: {
			description: 'Filter by severity: critical, recoverable, unknown, unreadable',
			required: false,
			type: 'positional',
		},
	},
	meta: {
		description: 'List file paths for scripting (pipe to xargs, wc -l, etc.)',
		name: 'list',
	},
	run({ args }) {
		try {
			const filter = args.filter as Filter | undefined;

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
					writeSection('unreadable files', files);
					return;
				}

				if (filter) {
					const files = getCorruptFilesBySeverity(db, filter);
					writeSection(`${filter} files`, files);
					return;
				}

				// No filter: all corrupt grouped by severity, then unreadable
				const corrupt = getCorruptFiles(db);
				const groups = groupBySeverity(corrupt);
				const unreadable = getAllUnreadableFiles(db);

				let first = true;
				for (const severity of ['critical', 'recoverable', 'unknown'] as const) {
					if (groups[severity].length === 0) continue;
					if (!first) process.stderr.write('\n');
					writeSection(`${severity} files`, groups[severity]);
					first = false;
				}

				if (unreadable.length > 0) {
					if (!first) process.stderr.write('\n');
					writeSection('unreadable files', unreadable);
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
