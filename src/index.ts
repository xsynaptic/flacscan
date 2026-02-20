#!/usr/bin/env node
import { runMain } from 'citty';

import { main } from './cli/main.js';

const subcommands = new Set(['list', 'recheck', 'report', 'scan', 'status']);
const rawArgs = process.argv.slice(2);
const hasHelp = rawArgs.includes('--help') || rawArgs.includes('-h');
const hasVersion = rawArgs.length === 1 && rawArgs[0] === '--version';
const firstPositional = rawArgs.find((arg) => !arg.startsWith('-'));

const effectiveArgs =
	!hasHelp && !hasVersion && (!firstPositional || !subcommands.has(firstPositional))
		? ['scan', ...rawArgs]
		: rawArgs;

void runMain(main, { rawArgs: effectiveArgs });
