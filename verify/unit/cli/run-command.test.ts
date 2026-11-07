import type Database from 'better-sqlite3';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommand } from '#cli/run-command.ts';
import { FlacScanError } from '#errors.ts';

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

function deadPid(): number {
	const { pid } = spawnSync(process.execPath, ['-e', '']);
	return pid;
}

describe('runCommand run lock', () => {
	const runLock = path.resolve('src/run-lock.ts');

	it('holds a lock naming this process while an exclusive body runs, then releases it', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		let heldBy: string | undefined;

		await runCommand(args(), { exclusive: true }, () => {
			heldBy = fs.readFileSync(`${dbPath}.lock`, 'utf8');
		});

		expect(heldBy).toBe(String(process.pid));
		expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
	});

	it('refuses a second exclusive run with exit 2, naming the holder, without opening the database', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		const livePid = String(process.pid);
		fs.writeFileSync(`${dbPath}.lock`, livePid);
		const body = vi.fn();

		await runCommand(args(), { exclusive: true }, body);

		expect(process.exitCode).toBe(2);
		expect(body).not.toHaveBeenCalled();
		expect(fs.existsSync(dbPath)).toBe(false);
		expect(console.error).toHaveBeenCalledWith(
			`Another flacscan run (pid ${livePid}) is using ${dbPath}; try again when it finishes.`,
		);
		expect(fs.readFileSync(`${dbPath}.lock`, 'utf8')).toBe(livePid);
	});

	it('refuses an exclusive run nested inside another', async () => {
		const inner = vi.fn();

		await runCommand(args(), { exclusive: true }, async () => {
			await runCommand(args(), { exclusive: true }, inner);
		});

		expect(inner).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
	});

	it('takes over a lock left by a process that is gone', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		fs.writeFileSync(`${dbPath}.lock`, String(deadPid()));
		const body = vi.fn();

		await runCommand(args(), { exclusive: true }, body);

		expect(body).toHaveBeenCalledOnce();
		expect(process.exitCode ?? 0).toBe(0);
		expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
	});

	it('releases the lock when the body throws', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');

		await runCommand(args(), { exclusive: true }, () => {
			throw new Error('unexpected');
		});

		expect(process.exitCode).toBe(2);
		expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
	});

	it('runs a non-exclusive command while the lock is held', async () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		fs.writeFileSync(`${dbPath}.lock`, String(process.pid));
		const body = vi.fn();

		await runCommand(args(), {}, body);

		expect(body).toHaveBeenCalledOnce();
		expect(process.exitCode ?? 0).toBe(0);
	});

	it('releases the lock when the process exits mid-run, as a second Ctrl+C does', () => {
		const dbPath = path.join(tempDir, 'flacscan.db');
		const script = `import fs from 'node:fs';
import { acquireRunLock } from ${JSON.stringify(runLock)};
acquireRunLock(${JSON.stringify(dbPath)});
process.stdout.write(String(fs.existsSync(${JSON.stringify(`${dbPath}.lock`)})));
process.exit(2);`;

		const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
			encoding: 'utf8',
		});

		expect(child.status).toBe(2);
		expect(child.stdout.trim()).toBe('true');
		expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
	});
});
