import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		setupFiles: ['./verify/unit/setup.ts'],
	},
});
