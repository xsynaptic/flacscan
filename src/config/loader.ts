import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { FlacScanConfig } from '#config/types.ts';

import { DEFAULT_CONFIG } from '#config/types.ts';
import { FlacScanError } from '#errors.ts';

interface CliArgs {
	'batch-size'?: string | undefined;
	config?: string | undefined;
	'db-path'?: string | undefined;
	directory?: string | undefined;
	fix?: boolean | string | undefined;
	'log-path'?: string | undefined;
	'max-trailing-loss'?: string | undefined;
	'min-free-bytes'?: string | undefined;
	notify?: boolean | string | undefined;
	parallelism?: string | undefined;
	'rescan-days'?: string | undefined;
}

interface FileSetting<Value> {
	expected: string;
	read(value: unknown): undefined | Value;
}

export function loadConfig(cliArgs: CliArgs): FlacScanConfig {
	const fileConfig = readFileConfig(resolveConfigPath(cliArgs.config));
	const pick = <Key extends keyof FlacScanConfig>(
		key: Key,
		cliValue: FlacScanConfig[Key] | undefined,
	) => cliValue ?? fileConfig[key] ?? DEFAULT_CONFIG[key];

	const config: FlacScanConfig = {
		batch_size: pick('batch_size', parseNumeric(cliArgs['batch-size'], 'batch-size')),
		db_path: expandTilde(pick('db_path', cliArgs['db-path'])),
		directories: pick('directories', cliDirectories(cliArgs.directory)),
		fix: pick('fix', cliFlag(cliArgs.fix)),
		log_path: expandTilde(pick('log_path', cliArgs['log-path'])),
		min_free_bytes: pick(
			'min_free_bytes',
			parseNumeric(cliArgs['min-free-bytes'], 'min-free-bytes'),
		),
		notify: pick('notify', cliFlag(cliArgs.notify)),
		parallelism: pick('parallelism', parseNumeric(cliArgs.parallelism, 'parallelism')),
		recover_max_trailing_loss_seconds: pick(
			'recover_max_trailing_loss_seconds',
			parsePositiveNumber(cliArgs['max-trailing-loss'], 'max-trailing-loss'),
		),
		rescan_interval_days: pick(
			'rescan_interval_days',
			parseNumeric(cliArgs['rescan-days'], 'rescan-days'),
		),
	};

	if (config.directories.length === 0) {
		throw new FlacScanError(
			'No directories configured. Provide directories in config.yaml or use --directory.',
		);
	}

	return config;
}

function cliDirectories(directory: string | undefined): string[] | undefined {
	if (!directory) return undefined;
	return [expandTilde(directory)];
}

function cliFlag(value: boolean | string | undefined): true | undefined {
	return value === true ? true : undefined;
}

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const booleanSetting: FileSetting<boolean> = {
	expected: 'true or false',
	read: (value) => (typeof value === 'boolean' ? value : undefined),
};

const positiveIntegerSetting: FileSetting<number> = {
	expected: 'a positive integer',
	read: (value) =>
		typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined,
};

const stringSetting: FileSetting<string> = {
	expected: 'a string',
	read: (value) => (typeof value === 'string' ? value : undefined),
};

const fileSettings: { [Key in keyof FlacScanConfig]: FileSetting<FlacScanConfig[Key]> } = {
	batch_size: positiveIntegerSetting,
	db_path: stringSetting,
	directories: {
		expected: 'a list of strings',
		read: (value) => (isStringList(value) ? value.map((entry) => expandTilde(entry)) : undefined),
	},
	fix: booleanSetting,
	log_path: stringSetting,
	min_free_bytes: positiveIntegerSetting,
	notify: booleanSetting,
	parallelism: positiveIntegerSetting,
	recover_max_trailing_loss_seconds: {
		expected: 'a positive number',
		read: (value) =>
			typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined,
	},
	rescan_interval_days: positiveIntegerSetting,
};

const fileSettingOrder = [
	'directories',
	'batch_size',
	'min_free_bytes',
	'parallelism',
	'rescan_interval_days',
	'recover_max_trailing_loss_seconds',
	'fix',
	'notify',
	'db_path',
	'log_path',
] as const satisfies readonly (keyof FlacScanConfig)[];

const knownKeys = new Set<string>(fileSettingOrder);

function getFlacScanDir(): string {
	return path.join(os.homedir(), '.flacscan');
}

function parseNumeric(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new FlacScanError(`Invalid value for ${name}: "${value}" (must be a positive integer)`);
	}
	return parsed;
}

function parsePositiveNumber(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new FlacScanError(`Invalid value for ${name}: "${value}" (must be a positive number)`);
	}
	return parsed;
}

function readFileConfig(configPath: string): Partial<FlacScanConfig> {
	if (!fs.existsSync(configPath)) return {};
	let parsed: unknown;
	try {
		parsed = parseYaml(fs.readFileSync(configPath, 'utf8'));
	} catch (error) {
		throw new FlacScanError(`Failed to parse config file at ${configPath}: ${String(error)}`);
	}
	return validateFileConfig(parsed, configPath);
}

function readSetting<Key extends keyof FlacScanConfig>(
	key: Key,
	value: unknown,
	configPath: string,
): FlacScanConfig[Key] {
	const setting = fileSettings[key];
	const read = setting.read(value);
	if (read === undefined) {
		throw new FlacScanError(
			`Invalid value for ${key} in ${configPath} (must be ${setting.expected})`,
		);
	}
	return read;
}

function resolveConfigPath(explicit?: string): string {
	if (explicit) return expandTilde(explicit);

	const cwdConfig = './flacscan.config.yaml';
	if (fs.existsSync(cwdConfig)) return cwdConfig;

	return path.join(getFlacScanDir(), 'flacscan.config.yaml');
}

function validateFileConfig(parsed: unknown, configPath: string): Partial<FlacScanConfig> {
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new FlacScanError(`Config file at ${configPath} must be a YAML mapping`);
	}

	const source = parsed as Record<string, unknown>;
	warnUnknownKeys(source, configPath);

	const result: Partial<FlacScanConfig> = {};
	const assign = <Key extends keyof FlacScanConfig>(key: Key, value: FlacScanConfig[Key]) => {
		result[key] = value;
	};
	for (const key of fileSettingOrder) {
		const value = source[key];
		if (value !== undefined) assign(key, readSetting(key, value, configPath));
	}
	return result;
}

function warnUnknownKeys(source: Record<string, unknown>, configPath: string) {
	for (const key of Object.keys(source)) {
		if (!knownKeys.has(key)) {
			console.warn(`Warning: unknown config key "${key}" in ${configPath}`);
		}
	}
}
