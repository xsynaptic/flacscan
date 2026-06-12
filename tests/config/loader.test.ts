import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/types.js';

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
	it('maps every field from a valid config file', () => {
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
				'db_path: /tmp/db.sqlite',
				'log_path: /tmp/scan.log',
			].join('\n'),
		);

		const result = loadConfig({ config });

		expect(result.directories).toEqual(['/Volumes/Music']);
		expect(result.batch_size).toBe(50);
		expect(result.parallelism).toBe(4);
		expect(result.rescan_interval_days).toBe(30);
		expect(result.min_free_bytes).toBe(2048);
		expect(result.recover_max_trailing_loss_seconds).toBe(1.5);
		expect(result.fix).toBe(true);
		expect(result.db_path).toBe('/tmp/db.sqlite');
		expect(result.log_path).toBe('/tmp/scan.log');
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

	it('accepts fix: true from the file', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nfix: true');

		expect(loadConfig({ config }).fix).toBe(true);
	});

	it('lets CLI fix override file fix: false', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nfix: false');

		expect(loadConfig({ config, fix: true }).fix).toBe(true);
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

		expect(result.directories).toEqual(['/Volumes/Music']);
		expect(result.batch_size).toBe(DEFAULT_CONFIG.batch_size);
	});

	it('throws when no directories are configured and none passed', () => {
		expect(() => loadConfig({ config: path.join(tempDir, 'does-not-exist.yaml') })).toThrow(
			/No directories configured/,
		);
	});

	it('lets CLI numeric overrides beat file values', () => {
		const config = writeConfig(tempDir, 'directories:\n  - /m\nbatch_size: 50');

		const result = loadConfig({ 'batch-size': '200', config });

		expect(result.batch_size).toBe(200);
	});
});
