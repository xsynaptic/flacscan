import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
	{ ignores: ['node_modules/', 'dist/', 'samples/'] },
	eslint.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.ts',
						'prettier.config.mjs',
						'tsdown.config.ts',
						'vitest.config.ts',
					],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	perfectionist.configs['recommended-natural'],
	unicorn.configs['recommended'],
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'unicorn/no-null': 'off',
			'unicorn/no-process-exit': 'off',
			'unicorn/prevent-abbreviations': 'off',
		},
	},
	{
		files: ['tests/**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
	prettierConfig,
]);
