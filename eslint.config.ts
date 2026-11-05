import type { Linter } from 'eslint';

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

interface Ceilings {
	complexity?: number;
	'max-depth'?: number;
	'max-lines-per-function'?: number;
	'max-params'?: number;
	'max-statements'?: number;
}

// Each file's measured worst on 2026-11-05; a ceiling only ever moves down as its file is refactored
const legacyCeilings: Record<string, Ceilings> = {
	'src/cli/format-corrupt.ts': { 'max-params': 4 },
	'src/cli/recheck.ts': { complexity: 9 },
	'src/cli/recover-attempt.ts': {
		complexity: 19,
		'max-lines-per-function': 142,
		'max-params': 4,
		'max-statements': 45,
	},
	'src/cli/recover.ts': {
		complexity: 11,
		'max-lines-per-function': 160,
		'max-params': 5,
		'max-statements': 60,
	},
	'src/cli/report.ts': { complexity: 10 },
	'src/cli/scan-discover.ts': { complexity: 12, 'max-params': 5, 'max-statements': 38 },
	'src/cli/scan-verify.ts': { complexity: 10, 'max-params': 4, 'max-statements': 35 },
	'src/cli/scan.ts': { complexity: 18 },
	'src/cli/status.ts': { complexity: 12, 'max-statements': 26 },
	'src/cli/verify-and-record.ts': {
		complexity: 19,
		'max-depth': 4,
		'max-params': 4,
		'max-statements': 32,
	},
	'src/config/loader.ts': { complexity: 27, 'max-statements': 47 },
	'src/database/queries.ts': { 'max-params': 4 },
	'src/logging/scan-log.ts': { 'max-params': 4 },
	'src/metadata.ts': { complexity: 9 },
	'src/verifiers/flac/verify.ts': { complexity: 11 },
	'tests/database/queries.test.ts': { complexity: 11 },
};

function ceilingRules(ceilings: Ceilings) {
	const rules: Linter.RulesRecord = {};
	if (ceilings.complexity !== undefined) {
		rules.complexity = ['warn', { max: ceilings.complexity, variant: 'modified' }];
	}
	if (ceilings['max-lines-per-function'] !== undefined) {
		rules['max-lines-per-function'] = [
			'warn',
			{ max: ceilings['max-lines-per-function'], skipBlankLines: true, skipComments: true },
		];
	}
	for (const rule of ['max-depth', 'max-params', 'max-statements'] as const) {
		const max = ceilings[rule];
		if (max !== undefined) rules[rule] = ['warn', max];
	}
	return rules;
}

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
	...Object.entries(legacyCeilings).map(([file, ceilings]) => ({
		files: [file],
		rules: ceilingRules(ceilings),
	})),
	{
		// `no-undef` cannot guard this side; it misreads type namespaces such as `NodeJS`
		files: ['**/*.ts'],
		rules: { 'no-restricted-globals': ['error', ...browserOnlyGlobals] },
	},
);
