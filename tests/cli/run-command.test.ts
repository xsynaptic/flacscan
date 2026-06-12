import type Database from 'better-sqlite3';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlacScanError } from '../../src/cli/errors.js';
import { runCommand } from '../../src/cli/run-command.js';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
	vi.restoreAllMocks();
	// runCommand sets process.exitCode; leaving it non-zero would fail the vitest run
	process.exitCode = 0;
});

function args(overrides: Record<string, string> = {}): Record<string, string> {
	const configPath = path.join(tempDir, 'flacscan.config.yaml');
	fs.writeFileSync(configPath, `directories:\n  - ${tempDir}\n`);
	return { config: configPath, 'db-path': path.join(tempDir, 'flacscan.db'), ...overrides };
}

describe('runCommand', () => {
	it('opens the database and passes the loaded config to the body', async () => {
		let received: undefined | { db: Database.Database; directories: string[] };

		await runCommand(args(), {}, (db, config) => {
			received = { db, directories: config.directories };
			expect(db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
		});

		expect(received?.directories).toEqual([tempDir]);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it('maps a FlacScanError from the body to its exit code and closes the db', async () => {
		let captured: Database.Database | undefined;

		await runCommand(args(), {}, (db) => {
			captured = db;
			throw new FlacScanError('boom', 1);
		});

		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith('boom');
		expect(captured?.open).toBe(false);
	});

	it('maps an unexpected error to exit 2 and closes the db', async () => {
		let captured: Database.Database | undefined;

		await runCommand(args(), {}, (db) => {
			captured = db;
			throw new Error('unexpected');
		});

		expect(process.exitCode).toBe(2);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unexpected'));
		expect(captured?.open).toBe(false);
	});

	it('fails with exit 2 and never runs the body when config load fails', async () => {
		const configPath = path.join(tempDir, 'flacscan.config.yaml');
		fs.writeFileSync(configPath, 'batch_size: 50\n');
		const body = vi.fn();

		await runCommand({ config: configPath }, {}, body);

		expect(process.exitCode).toBe(2);
		expect(body).not.toHaveBeenCalled();
	});

	it('does not open the database when prepare throws', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		const body = vi.fn();

		await runCommand(
			args({ 'db-path': dbPath }),
			{
				prepare() {
					throw new FlacScanError('missing binary');
				},
			},
			body,
		);

		expect(process.exitCode).toBe(2);
		expect(body).not.toHaveBeenCalled();
		expect(fs.existsSync(dbPath)).toBe(false);
	});
});
