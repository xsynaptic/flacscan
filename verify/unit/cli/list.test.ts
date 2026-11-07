import { runCommand } from 'citty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listCommand } from '#cli/list.ts';
import { openDatabase } from '#database/connection.ts';
import { recordUnreadable } from '#database/queries.ts';

let tempDir: string;
let output: string[];

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	fs.writeFileSync(path.join(tempDir, 'flacscan.config.yaml'), `directories:\n  - ${tempDir}\n`);
	output = [];
	vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	seed();
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tempDir, { force: true, recursive: true });
});

const accepted = '2026-01-01T00:00:00.000Z';
const lastHealthy = '2025-06-01T00:00:00.000Z';

function seed() {
	const db = openDatabase(path.join(tempDir, 'flacscan.db'));
	const insertFile = db.prepare(
		`INSERT INTO files (current_path, last_result, acknowledged_at, last_healthy_at, first_seen_at, updated_at)
		VALUES (?, ?, ?, ?, 't', 't')`,
	);
	insertFile.run('/m/beta/c.flac', 'corrupt', null, null);
	insertFile.run('/m/Alpha/c.flac', 'corrupt', accepted, lastHealthy);
	insertFile.run('/m/Alpha/ok.flac', 'healthy', null, lastHealthy);
	for (const currentPath of ['/m/Beta/u.flac', '/m/alpha/u.flac', '/m/Zulu/u.flac']) {
		recordUnreadable(db, [{ error: 'read error', path: currentPath }]);
	}
	db.prepare(`UPDATE unreadable_files SET acknowledged_at = ? WHERE current_path = ?`).run(
		accepted,
		'/m/alpha/u.flac',
	);
	db.close();
}

async function list(extraArguments: string[]) {
	await runCommand(listCommand, {
		rawArgs: [
			'--config',
			path.join(tempDir, 'flacscan.config.yaml'),
			'--db-path',
			path.join(tempDir, 'flacscan.db'),
			...extraArguments,
		],
	});
	return output.join('');
}

// Mixed case separates the two orders: byte order puts every capital before any lowercase letter
const cases = [
	{
		expected: [
			'/m/Alpha/c.flac',
			'/m/alpha/u.flac',
			'/m/beta/c.flac',
			'/m/Beta/u.flac',
			'/m/Zulu/u.flac',
		],
		filter: [],
	},
	{ expected: ['/m/beta/c.flac', '/m/Beta/u.flac', '/m/Zulu/u.flac'], filter: ['new'] },
	{ expected: ['/m/Alpha/c.flac', '/m/alpha/u.flac'], filter: ['accepted'] },
	{ expected: ['/m/Alpha/c.flac'], filter: ['regressed'] },
	{ expected: ['/m/Beta/u.flac', '/m/Zulu/u.flac', '/m/alpha/u.flac'], filter: ['unreadable'] },
];

describe('list', () => {
	it.each(cases)('prints paths for filter $filter in order', async ({ expected, filter }) => {
		expect(await list(filter)).toBe(expected.map((filePath) => filePath + '\n').join(''));
	});

	it.each(cases)(
		'emits JSON for filter $filter in the same order',
		async ({ expected, filter }) => {
			const entries = JSON.parse(await list([...filter, '--json'])) as { original_path: string }[];
			expect(entries.map((entry) => entry.original_path)).toEqual(expected);
		},
	);

	it('tags each JSON entry with its kind and acceptance', async () => {
		const entries = JSON.parse(await list(['accepted', '--json'])) as {
			acknowledged_at: null | string;
			type: string;
		}[];
		expect(entries.map(({ acknowledged_at, type }) => ({ acknowledged_at, type }))).toEqual([
			{ acknowledged_at: accepted, type: 'corrupt' },
			{ acknowledged_at: accepted, type: 'unreadable' },
		]);
	});
});
