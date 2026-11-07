import type Database from 'better-sqlite3';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FlacScanConfig } from '#config/types.ts';

import { DEFAULT_CONFIG } from '#config/types.ts';
import { listIssues } from '#database/issues.ts';

export function makeTestConfig(
	tempDir: string,
	overrides: Partial<FlacScanConfig> = {},
): FlacScanConfig {
	return {
		...DEFAULT_CONFIG,
		db_path: ':memory:',
		directories: [tempDir],
		log_path: path.join(tempDir, 'scan.log'),
		parallelism: 2,
		...overrides,
	};
}

export const caseInsensitiveTmp =
	fs.existsSync(os.tmpdir().toUpperCase()) && fs.existsSync(os.tmpdir().toLowerCase());

export function unreadableRow(db: Database.Database, filePath: string) {
	for (const issue of listIssues(db)) {
		if (issue.kind === 'unreadable' && issue.row.current_path === filePath) return issue.row;
	}
	return;
}
