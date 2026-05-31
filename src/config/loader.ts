import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { FlacScanConfig } from './types.js';

import { FlacScanError } from '../cli/errors.js';
import { DEFAULT_CONFIG } from './types.js';

interface CliArgs {
	'batch-size'?: string | undefined;
	config?: string | undefined;
	'db-path'?: string | undefined;
	directory?: string | undefined;
	fix?: boolean | string | undefined;
	'log-path'?: string | undefined;
	'max-trailing-loss'?: string | undefined;
	'min-free-bytes'?: string | undefined;
	parallelism?: string | undefined;
	'rescan-days'?: string | undefined;
}

export function loadConfig(cliArgs: CliArgs): FlacScanConfig {
	const configPath = resolveConfigPath(cliArgs.config);

	let fileConfig: Partial<FlacScanConfig> = {};

	if (fs.existsSync(configPath)) {
		try {
			const raw = fs.readFileSync(configPath, 'utf8');
			const parsed: unknown = parseYaml(raw);
			if (parsed && typeof parsed === 'object') {
				fileConfig = parsed;
			}
		} catch (error) {
			throw new FlacScanError(`Failed to parse config file at ${configPath}: ${String(error)}`);
		}
	}

	const config: FlacScanConfig = {
		batch_size:
			parseNumeric(cliArgs['batch-size'], 'batch-size') ??
			fileConfig.batch_size ??
			DEFAULT_CONFIG.batch_size,
		db_path: expandTilde(cliArgs['db-path'] ?? fileConfig.db_path ?? DEFAULT_CONFIG.db_path),
		directories: fileConfig.directories ?? DEFAULT_CONFIG.directories,
		fix: cliArgs.fix === true || fileConfig.fix || DEFAULT_CONFIG.fix,
		log_path: expandTilde(cliArgs['log-path'] ?? fileConfig.log_path ?? DEFAULT_CONFIG.log_path),
		min_free_bytes:
			parseNumeric(cliArgs['min-free-bytes'], 'min-free-bytes') ??
			fileConfig.min_free_bytes ??
			DEFAULT_CONFIG.min_free_bytes,
		parallelism:
			parseNumeric(cliArgs.parallelism, 'parallelism') ??
			fileConfig.parallelism ??
			DEFAULT_CONFIG.parallelism,
		recover_max_trailing_loss_seconds:
			parsePositiveNumber(cliArgs['max-trailing-loss'], 'max-trailing-loss') ??
			fileConfig.recover_max_trailing_loss_seconds ??
			DEFAULT_CONFIG.recover_max_trailing_loss_seconds,
		rescan_interval_days:
			parseNumeric(cliArgs['rescan-days'], 'rescan-days') ??
			fileConfig.rescan_interval_days ??
			DEFAULT_CONFIG.rescan_interval_days,
	};

	if (cliArgs.directory) {
		config.directories = [expandTilde(cliArgs.directory)];
	}

	if (config.directories.length === 0) {
		throw new FlacScanError(
			'No directories configured. Provide directories in config.yaml or use --directory.',
		);
	}

	return config;
}

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

function getFlacScanDir(): string {
	return path.join(os.homedir(), '.flacscan');
}

function parseNumeric(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		throw new FlacScanError(`Invalid value for ${name}: "${value}" (must be a positive integer)`);
	}
	return parsed;
}

function parsePositiveNumber(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new FlacScanError(`Invalid value for ${name}: "${value}" (must be a positive number)`);
	}
	return parsed;
}

function resolveConfigPath(explicit?: string): string {
	if (explicit) return expandTilde(explicit);

	const cwdConfig = './flacscan.config.yaml';
	if (fs.existsSync(cwdConfig)) return cwdConfig;

	return path.join(getFlacScanDir(), 'flacscan.config.yaml');
}
