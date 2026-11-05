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
					allowDefaultProject: ['prettier.config.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	perfectionist.configs['recommended-natural'],
	unicorn.configs['recommended'],
	{
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
			'unicorn/consistent-boolean-name': 'off',
			'unicorn/consistent-class-member-order': 'off', // Hoists private helpers above public lifecycle methods
			'unicorn/name-replacements': 'off', // I *like* abbreviations!
			'unicorn/no-array-callback-reference': 'off', // I prefer this pattern for filtering/sorting content
			'unicorn/no-invalid-argument-count': 'off', // Off for performance (~1s per run); call arity is already enforced by tsc
			'unicorn/no-null': 'off',
			'unicorn/no-process-exit': 'off',
			'unicorn/no-top-level-assignment-in-function': 'off', // Flags the legitimate lazy-singleton (instance ??= load()) cache pattern
			'unicorn/prefer-combined-guards': 'off', // Each guard names a distinct reason to bail; merging them hides which one fired
			'unicorn/prefer-iterator-to-array': 'off', // Pushes Iterator#toArray(), which needs the esnext.iterator lib
			'unicorn/prefer-smaller-scope': 'off', // Wants module-level types moved inside functions
			'unicorn/prefer-ternary': 'off', // Plain if/else and guard clauses are the house style
			'unicorn/prevent-abbreviations': 'off',
			'unicorn/single-line-block-comment-style': 'off', // Rewrites single-line /* */ comments into a three-line block, churning existing code for no gain
		},
	},
	prettierConfig,
]);
