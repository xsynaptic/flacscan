import type { KnipConfig } from 'knip';

export default {
	// A Homebrew system binary spawned by `recover-engine.ts`, not an npm package
	ignoreBinaries: ['flac'],
	// Entry exports go unchecked by default; mark a deliberate one `/** @public */`
	includeEntryExports: true,
} satisfies KnipConfig;
