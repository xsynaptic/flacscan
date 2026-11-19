import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flacscan-test-home-'));

export default defineConfig({
	test: {
		env: {
			HOME: testHome,
		},
		setupFiles: ['./verify/unit/setup.ts'],
	},
});
