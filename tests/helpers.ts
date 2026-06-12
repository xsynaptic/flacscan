import path from 'node:path';

import type { FlacScanConfig } from '../src/config/types.js';

import { DEFAULT_CONFIG } from '../src/config/types.js';

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
