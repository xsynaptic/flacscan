import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import eslint from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import tseslint from 'typescript-eslint';

// Hoisted, since unicorn reads a call inside `defineConfig` as a side effect
const gitignored = includeIgnoreFile(path.join(import.meta.dirname, '.gitignore'));

const browserOnlyGlobals = Object.keys(globals.browser)
	.filter((name) => !Object.hasOwn(globals.nodeBuiltin, name))
	.map((name) => ({ message: 'flacscan runs in Node only.', name }));

export default defineConfig(
	gitignored,
	eslint.configs.recommended,
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	unicorn.configs.recommended,
	perfectionist.configs['recommended-natural'],
	{
		languageOptions: {
			globals: { ...globals.builtin, ...globals.nodeBuiltin },
			parserOptions: { projectService: true },
		},
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		plugins: { '@eslint-community/eslint-comments': eslintComments },
		rules: {
			'@eslint-community/eslint-comments/require-description': [
				'error',
				{ ignore: ['eslint-enable'] },
			],
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			// Its fixer moves declarations blind to what depends on their order
			'perfectionist/sort-modules': 'off',
			'unicorn/consistent-boolean-name': 'off',
			// Its order is the reverse of perfectionist/sort-classes, which fixes where this only suggests
			'unicorn/consistent-class-member-order': 'off',
			'unicorn/name-replacements': 'off', // I *like* abbreviations!
			'unicorn/no-array-callback-reference': 'off', // I prefer this pattern for filtering/sorting content
			'unicorn/no-invalid-argument-count': 'off', // Off for performance (~1s per run); call arity is already enforced by tsc
			'unicorn/no-null': 'off',
			'unicorn/no-process-exit': 'off',
			'unicorn/no-top-level-assignment-in-function': 'off', // Flags the legitimate lazy-singleton (instance ??= load()) cache pattern
			// Lowercase hex to match Prettier
			'unicorn/number-literal-case': ['error', { hexadecimalValue: 'lowercase' }],
			// Guard clauses state one reason to leave each; this merges them
			'unicorn/prefer-combined-guards': 'off',
			// Fixes to ES2025 helpers the es2023 lib rejects
			'unicorn/prefer-iterator-to-array': 'off',
			'unicorn/prefer-smaller-scope': 'off', // Wants module-level types moved inside functions
			// Rewrites a flat guard-clause ladder into a ternary chain
			'unicorn/prefer-ternary': 'off',
			'unicorn/prevent-abbreviations': 'off',
			// Blows a one-line tag comment up into three lines
			'unicorn/single-line-block-comment-style': 'off',
		},
	},
	{
		rules: {
			complexity: ['warn', { max: 8, variant: 'modified' }],
			'max-depth': ['warn', 3],
			'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
			'max-params': ['warn', 3],
			'max-statements': ['warn', 25],
		},
	},
	{
		extends: [tseslint.configs.disableTypeChecked],
		files: ['**/*.{js,mjs,cjs}'],
	},
	{
		// A suite's length is a table of cases, not a complexity signal
		files: ['**/*.test.ts'],
		rules: {
			// Silencing a console spy takes a no-op implementation
			'@typescript-eslint/no-empty-function': 'off',
			'max-lines-per-function': 'off',
			'max-statements': 'off',
		},
	},
	{
		// `no-undef` cannot guard this side; it misreads type namespaces such as `NodeJS`
		files: ['**/*.ts'],
		rules: { 'no-restricted-globals': ['error', ...browserOnlyGlobals] },
	},
);
