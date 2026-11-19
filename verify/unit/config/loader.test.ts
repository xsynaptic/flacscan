import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/loader.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { force: true, recursive: true });
	vi.restoreAllMocks();
});

function writeConfig(dir: string, yaml: string): string {
	const configPath = path.join(dir, 'flacscan.config.yaml');
	fs.writeFileSync(configPath, yaml);
	return configPath;
}

describe('loadConfig', () => {
	it('maps every field from a valid config file, warning about none', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config = writeConfig(
			tempDir,
			[
				'directories:',
				'  - /Volumes/Music',
				'batch_size: 50',
				'parallelism: 4',
				'rescan_interval_days: 30',
				'min_free_bytes: 2048',
				'recover_max_trailing_loss_seconds: 1.5',
				'fix: true',
				'notify: true',
				'db_path: /tmp/db.sqlite',
				'log_path: /tmp/scan.log',
			].join('\n'),
		);

		expect(loadConfig({ config })).toEqual({
			batch_size: 50,
			db_path: '/tmp/db.sqlite',
			directories: ['/Volumes/Music'],
			fix: true,
			log_path: '/tmp/scan.log',
			min_free_bytes: 2048,
			notify: true,
			parallelism: 4,
			recover_max_trailing_loss_seconds: 1.5,
			rescan_interval_days: 30,
		});
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('expands a tilde in YAML directories (headline regression)', () => {
		const config = writeConfig(tempDir, 'directories:\n  - ~/Music');

		const result = loadConfig({ config });

		expect(result.directories).toEqual([path.join(os.homedir(), 'Music')]);
	});

	it('lets a tilde-expanded --directory override file directories', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /Volumes/Music');

		const result = loadConfig({ config, directory: '~/Other' });

		expect(result.directories).toEqual([path.join(os.homedir(), 'Other')]);
	});

	it('throws when directories is a string, not a list', () => {
		const config = writeConfig(tempDir, 'directories: /Volumes/Music');

		expect(() => loadConfig({ config })).toThrow(/directories/);
	});

	it('throws when batch_size is negative', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nbatch_size: -5');

		expect(() => loadConfig({ config })).toThrow(/batch_size/);
	});

	it('throws when batch_size is not a number', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nbatch_size: abc');

		expect(() => loadConfig({ config })).toThrow(/batch_size/);
	});

	it('throws when fix is a truthy string', () => {
		const config = writeConfig(tempDir, "directories:\n  - /m\nfix: 'no'");

		expect(() => loadConfig({ config })).toThrow(/fix/);
	});

	it('lets CLI fix override file fix: false', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nfix: false');

		expect(loadConfig({ config, fix: true }).fix).toBe(true);
	});

	it('defaults notify to false', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m');

		expect(loadConfig({ config }).notify).toBe(false);
	});

	it('throws when notify is a non-boolean', () => {
		const config = writeConfig(tempDir, "directories:\n  - /m\nnotify: 'yes'");

		expect(() => loadConfig({ config })).toThrow(/notify/);
	});

	it('lets CLI notify override file notify: false', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nnotify: false');

		expect(loadConfig({ config, notify: true }).notify).toBe(true);
	});

	it('warns on an unknown key without throwing', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config = writeConfig(tempDir, 'directories:\n  - /m\nrecover_max_trailing_loss: 3');

		const result = loadConfig({ config });

		expect(result.directories).toEqual(['/m']);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('recover_max_trailing_loss'));
	});

	it('throws when the config is a bare scalar', () => {
		const config = writeConfig(tempDir, '42');

		expect(() => loadConfig({ config })).toThrow(/must be a YAML mapping/);
	});

	it('throws a parse error on malformed YAML', () => {
		const config = writeConfig(tempDir, 'directories: [');

		expect(() => loadConfig({ config })).toThrow(/^Failed to parse config file/);
	});

	it('returns defaults plus the CLI directory when the config file is missing', () => {
		const result = loadConfig({
			config: path.join(tempDir, 'does-not-exist.yaml'),
			directory: '/Volumes/Music',
		});

		expect(result).toEqual({
			batch_size: 100,
			db_path: path.join(os.homedir(), '.flacscan/flacscan.db'),
			directories: ['/Volumes/Music'],
			fix: false,
			log_path: path.join(os.homedir(), '.flacscan/flacscan.log'),
			min_free_bytes: 1_073_741_824,
			notify: false,
			parallelism: 1,
			recover_max_trailing_loss_seconds: 3,
			rescan_interval_days: 90,
		});
	});

	it('throws when no directories are configured and none passed', () => {
		expect(() => loadConfig({ config: path.join(tempDir, 'does-not-exist.yaml') })).toThrow(
			/No directories configured/,
		);
	});

	it.each([
		['directories:\n  - /m\n  - 7', 'directories', 'a list of strings'],
		['directories:\n  - /m\nmin_free_bytes: 1.5', 'min_free_bytes', 'a positive integer'],
		[
			'directories:\n  - /m\nrecover_max_trailing_loss_seconds: 0',
			'recover_max_trailing_loss_seconds',
			'a positive number',
		],
		['directories:\n  - /m\nnotify: 1', 'notify', 'true or false'],
		['directories:\n  - /m\nlog_path: 3', 'log_path', 'a string'],
		['directories:\n  - /m\nparallelism: ~', 'parallelism', 'a positive integer'],
		['directories:\n  - /m\nbatch_size: 0', 'batch_size', 'a positive integer'],
		[
			'directories:\n  - /m\nrecover_max_trailing_loss_seconds: .inf',
			'recover_max_trailing_loss_seconds',
			'a positive number',
		],
	])('rejects an invalid %s with its expectation', (yaml, key, expected) => {
		const config = writeConfig(tempDir, yaml);

		expect(() => loadConfig({ config })).toThrow(
			`Invalid value for ${key} in ${config} (must be ${expected})`,
		);
	});

	it('reports the first invalid key in validation order', () => {
		const config = writeConfig(tempDir, 'directories: 5\nbatch_size: 0\nfix: 2');

		expect(() => loadConfig({ config })).toThrow(/for directories in/);
	});

	it('accepts a fractional trailing-loss limit from the file and the CLI', () => {
		const config = writeConfig(
			tempDir,
			'directories:\n  - /m\nrecover_max_trailing_loss_seconds: 1.5',
		);

		expect(loadConfig({ config }).recover_max_trailing_loss_seconds).toBe(1.5);
		expect(
			loadConfig({ config, 'max-trailing-loss': '0.5' }).recover_max_trailing_loss_seconds,
		).toBe(0.5);
	});

	it.each([
		[{ 'batch-size': '2.5' }, 'Invalid value for batch-size: "2.5" (must be a positive integer)'],
		[{ 'batch-size': '0' }, 'Invalid value for batch-size: "0" (must be a positive integer)'],
		[{ parallelism: 'x' }, 'Invalid value for parallelism: "x" (must be a positive integer)'],
		[
			{ 'max-trailing-loss': '0' },
			'Invalid value for max-trailing-loss: "0" (must be a positive number)',
		],
		[
			{ 'max-trailing-loss': '-1' },
			'Invalid value for max-trailing-loss: "-1" (must be a positive number)',
		],
	])('rejects an invalid CLI value %o', (cliArgs, message) => {
		const config = writeConfig(tempDir, 'directories:\n  - /m');

		expect(() => loadConfig({ config, ...cliArgs })).toThrow(message);
	});

	it('lets CLI numeric overrides beat file values', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nbatch_size: 50');

		const result = loadConfig({ 'batch-size': '200', config });

		expect(result.batch_size).toBe(200);
	});

	it('applies the --log-path, --min-free-bytes and --rescan-days overrides', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nlog_path: /tmp/file.log');

		expect(
			loadConfig({ config, 'log-path': '~/cli.log', 'min-free-bytes': '5', 'rescan-days': '7' }),
		).toMatchObject({
			log_path: path.join(os.homedir(), 'cli.log'),
			min_free_bytes: 5,
			rescan_interval_days: 7,
		});
	});

	it('treats an empty config file as no settings', () => {
		const config = writeConfig(tempDir, '');

		expect(loadConfig({ config, directory: '/m' }).batch_size).toBe(100);
	});

	it('looks for an explicit path, then ./flacscan.config.yaml, then ~/.flacscan', () => {
		const home = path.join(tempDir, 'home');
		const cwd = path.join(tempDir, 'cwd');
		fs.mkdirSync(path.join(home, '.flacscan'), { recursive: true });
		fs.mkdirSync(cwd);
		writeConfig(path.join(home, '.flacscan'), 'directories:\n  - /from-home');
		const cwdConfig = writeConfig(cwd, 'directories:\n  - /from-cwd');
		const explicit = path.join(tempDir, 'explicit.yaml');
		fs.writeFileSync(explicit, 'directories:\n  - /explicit');
		vi.spyOn(os, 'homedir').mockReturnValue(home);
		const original = process.cwd();
		process.chdir(cwd);
		try {
			expect(loadConfig({ config: explicit }).directories).toEqual(['/explicit']);
			expect(loadConfig({}).directories).toEqual(['/from-cwd']);
			fs.rmSync(cwdConfig);
			expect(loadConfig({}).directories).toEqual(['/from-home']);
		} finally {
			process.chdir(original);
		}
	});
});
