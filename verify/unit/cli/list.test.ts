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
	process.exitCode = 0;
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

	it.each(cases.filter(({ filter }) => filter.length > 0))(
		'emits JSON for filter $filter in the same order',
		async ({ expected, filter }) => {
			const entries = JSON.parse(await list([...filter, '--json'])) as { original_path: string }[];
			expect(entries.map((entry) => entry.original_path)).toEqual(expected);
		},
	);

	it('tags each JSON entry with its kind and acceptance', async () => {
		const entries = JSON.parse(await list(['--json'])) as {
			acknowledged_at: null | string;
			original_path: string;
			type: string;
		}[];
		expect(
			entries.map(({ acknowledged_at, original_path, type }) => ({
				acknowledged_at,
				original_path,
				type,
			})),
		).toEqual([
			{ acknowledged_at: accepted, original_path: '/m/Alpha/c.flac', type: 'corrupt' },
			{ acknowledged_at: accepted, original_path: '/m/alpha/u.flac', type: 'unreadable' },
			{ acknowledged_at: null, original_path: '/m/beta/c.flac', type: 'corrupt' },
			{ acknowledged_at: null, original_path: '/m/Beta/u.flac', type: 'unreadable' },
			{ acknowledged_at: null, original_path: '/m/Zulu/u.flac', type: 'unreadable' },
		]);
	});
	it('emits every field of a corrupt entry, ending the output with a newline', async () => {
		const db = openDatabase(path.join(tempDir, 'flacscan.db'));
		db.prepare(
			`INSERT INTO files (current_path, last_result, acknowledged_at, last_healthy_at, error_severity,
				error_output, error_timestamp, artist, title, album, date, duration, file_size,
				recovery_attempted_at, recovery_result, recovery_lost_samples, recovery_detail,
				first_seen_at, updated_at)
			VALUES ('/m/full.flac', 'corrupt', NULL, ?, 'recoverable', 'LOST_SYNC', 'sample 9',
				' Artist ', ' Title ', 'Album', '1999', 12.5, 4096, '2026-02-01T00:00:00.000Z',
				'recovered', 88200, '(lost 2.0s)', 't', 't')`,
		).run(lastHealthy);
		db.close();

		const raw = await list(['new', '--json']);

		expect(raw.endsWith(']\n')).toBe(true);
		const entries = JSON.parse(raw) as { original_path: string }[];
		expect(entries.find((entry) => entry.original_path === '/m/full.flac')).toEqual({
			acknowledged_at: null,
			album: 'Album',
			artist: ' Artist ',
			duration: 12.5,
			error_output: 'LOST_SYNC',
			error_severity: 'recoverable',
			error_timestamp: 'sample 9',
			file_size: 4096,
			input_text: 'Artist - Title',
			last_healthy_at: lastHealthy,
			original_path: '/m/full.flac',
			recovery_attempted_at: '2026-02-01T00:00:00.000Z',
			recovery_detail: '(lost 2.0s)',
			recovery_lost_samples: 88_200,
			recovery_result: 'recovered',
			title: ' Title ',
			type: 'corrupt',
			year: '1999',
		});
	});

	it('falls back to the basename for input_text unless both artist and title are set', async () => {
		const db = openDatabase(path.join(tempDir, 'flacscan.db'));
		const insertTagged = db.prepare(
			`INSERT INTO files (current_path, last_result, artist, title, first_seen_at, updated_at)
			VALUES (?, 'corrupt', ?, ?, 't', 't')`,
		);
		insertTagged.run('/m/tags/artist-only.flac', 'Artist', null);
		insertTagged.run('/m/tags/blank-title.flac', 'Artist', '  ');
		insertTagged.run('/m/tags/title-only.flac', null, 'Title');
		db.close();

		const entries = JSON.parse(await list(['new', '--json'])) as {
			input_text?: string;
			original_path: string;
		}[];
		expect(
			entries
				.filter((entry) => entry.original_path.startsWith('/m/tags/'))
				.map((entry) => entry.input_text),
		).toEqual(['artist-only', 'blank-title', 'title-only']);
	});

	it('rejects an unknown filter with exit code 1 and the valid filters', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(await list(['bogus'])).toBe('');

		expect(process.exitCode).toBe(1);
		expect(errorSpy.mock.calls).toEqual([
			['Unknown filter: bogus'],
			['Valid filters: accepted, new, regressed, unreadable'],
		]);
	});

	it('exits 0 on a closed pipe and 2 on any other stdout error', async () => {
		const stdoutOn = vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit ${String(code)}`);
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await list([]);
		const [event, handler] = stdoutOn.mock.calls[0]!;
		expect(event).toBe('error');
		const onError = handler as (error: NodeJS.ErrnoException) => void;

		expect(() => {
			onError(Object.assign(new Error('closed'), { code: 'EPIPE' }));
		}).toThrow('exit 0');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(() => {
			onError(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
		}).toThrow('exit 2');
		expect(errorSpy).toHaveBeenCalledWith('Error: disk full');
	});
});
