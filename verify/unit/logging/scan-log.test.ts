import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logCorruption, logFileMoved, logScanComplete, logScanStart } from '#logging/scan-log.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
});

function parseLine(line: string): Record<string, unknown> {
	return JSON.parse(line) as Record<string, unknown>;
}

function readLines(logPath: string): string[] {
	return fs.readFileSync(logPath, 'utf8').trim().split('\n');
}

function uniqueLogPath(...segments: string[]): string {
	return path.join(tempDir, ...segments);
}

describe('scan-log', () => {
	it('writes one parseable corruption line', () => {
		const logPath = uniqueLogPath('a.log');

		logCorruption(logPath, '/music/bad.flac', {
			details: 'decode error',
			known: false,
			lastHealthyAt: null,
		});

		const lines = readLines(logPath);
		expect(lines).toHaveLength(1);
		const entry = parseLine(lines[0] ?? '');
		expect(entry).toMatchObject({
			details: 'decode error',
			event: 'corrupt',
			known: false,
			last_healthy_at: null,
			level: 'error',
			path: '/music/bad.flac',
		});
		const timestamp = Date.parse(String(entry.timestamp));
		expect(Number.isNaN(timestamp)).toBe(false);
	});

	it('appends a separate line per call', () => {
		const logPath = uniqueLogPath('b.log');

		logCorruption(logPath, '/music/one.flac', {
			details: 'first',
			known: false,
			lastHealthyAt: null,
		});
		logCorruption(logPath, '/music/two.flac', {
			details: 'second',
			known: true,
			lastHealthyAt: '2026-08-01T00:00:00.000Z',
		});

		const lines = readLines(logPath);
		expect(lines).toHaveLength(2);
		expect(parseLine(lines[0] ?? '').path).toBe('/music/one.flac');
		expect(parseLine(lines[1] ?? '')).toMatchObject({
			known: true,
			last_healthy_at: '2026-08-01T00:00:00.000Z',
			path: '/music/two.flac',
		});
	});

	it('creates the parent directory when missing', () => {
		const logPath = uniqueLogPath('nested', 'deeper', 'c.log');

		logCorruption(logPath, '/music/x.flac', { details: 'boom', known: false, lastHealthyAt: null });

		expect(fs.existsSync(logPath)).toBe(true);
	});

	it('records a move with from and to paths', () => {
		const logPath = uniqueLogPath('moved.log');

		logFileMoved(logPath, '/music/old.flac', '/music/new.flac');

		const entry = parseLine(readLines(logPath)[0] ?? '');
		expect(entry).toMatchObject({
			event: 'moved',
			from: '/music/old.flac',
			level: 'info',
			path: '/music/new.flac',
		});
	});

	it('round-trips scan start and complete payloads', () => {
		const logPath = uniqueLogPath('d.log');

		logScanStart(logPath, { available: 2, skipped: ['/Volumes/Gone'], total: 3 });
		logScanComplete(logPath, {
			corrupt: 1,
			healthy: 9,
			newCorrupt: 1,
			newRegressed: 1,
			pruned: 2,
			total: 12,
		});

		const lines = readLines(logPath);
		const start = parseLine(lines[0] ?? '');
		const complete = parseLine(lines[1] ?? '');
		expect(start).toMatchObject({
			event: 'scan_start',
			paths: { available: 2, skipped: ['/Volumes/Gone'], total: 3 },
		});
		expect(complete).toMatchObject({
			event: 'scan_complete',
			stats: { corrupt: 1, healthy: 9, newCorrupt: 1, newRegressed: 1, pruned: 2, total: 12 },
		});
	});
});
