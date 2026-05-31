#!/usr/bin/env node
import { runMain } from 'citty';

import { main } from './cli/main.js';

const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];

function resolveArgs(): string[] {
	if (firstArg === undefined || firstArg === 'help') return [];
	if (
		firstArg.startsWith('-') &&
		firstArg !== '-h' &&
		firstArg !== '--help' &&
		firstArg !== '--version'
	) {
		return ['scan', ...rawArgs];
	}
	return rawArgs;
}

void runMain(main, { rawArgs: resolveArgs() });
