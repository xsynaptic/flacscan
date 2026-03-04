import fs from 'node:fs';
import path from 'node:path';

import type { ErrorSeverity } from '../verifiers/types.js';

export function logCorruption(
	logPath: string,
	severity: ErrorSeverity,
	filePath: string,
	details: string,
) {
	appendEntry(logPath, {
		details,
		event: 'corrupt',
		level: 'error',
		path: filePath,
		severity,
	});
}

export function logFixApplied(logPath: string, filePath: string, label: string) {
	appendEntry(logPath, {
		details: `Stripped ${label} tags`,
		event: `${label.toLowerCase()}_fixed`,
		level: 'info',
		path: filePath,
	});
}

export function logFixDetected(logPath: string, filePath: string, label: string) {
	appendEntry(logPath, {
		details: `Non-standard ${label} tags found, use --fix to strip`,
		event: `${label.toLowerCase()}_detected`,
		level: 'warn',
		path: filePath,
	});
}

export function logFixFailed(logPath: string, filePath: string, label: string, error: string) {
	appendEntry(logPath, {
		error,
		event: `${label.toLowerCase()}_fix_failed`,
		level: 'error',
		path: filePath,
	});
}

export function logScanComplete(
	logPath: string,
	stats: { corrupt: number; healthy: number; pruned: number; total: number },
) {
	appendEntry(logPath, {
		event: 'scan_complete',
		level: 'info',
		stats,
	});
}

export function logScanStart(
	logPath: string,
	available: number,
	total: number,
	skippedPaths: string[],
) {
	appendEntry(logPath, {
		event: 'scan_start',
		level: 'info',
		paths: { available, skipped: skippedPaths, total },
	});
}

export function logUnreadable(logPath: string, filePath: string, errorOutput: string) {
	appendEntry(logPath, {
		error: errorOutput,
		event: 'unreadable',
		level: 'error',
		path: filePath,
	});
}

function appendEntry(logPath: string, entry: Record<string, unknown>) {
	ensureDirectory(logPath);
	const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
	fs.appendFileSync(logPath, line + '\n');
}

const ensuredDirectories = new Set<string>();

function ensureDirectory(filePath: string) {
	const directory = path.dirname(filePath);
	if (ensuredDirectories.has(directory)) return;
	fs.mkdirSync(directory, { recursive: true });
	ensuredDirectories.add(directory);
}
