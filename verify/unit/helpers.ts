import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FlacScanConfig } from '#config/types.ts';

import { DEFAULT_CONFIG } from '#config/types.ts';

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
