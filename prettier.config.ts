import type { Config } from 'prettier';

export default {
	printWidth: 100,
	// Editing a sentence never re-wraps its neighbours
	proseWrap: 'never',
	singleQuote: true,
	useTabs: true,
} satisfies Config;
