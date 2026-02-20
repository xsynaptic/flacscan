import type { ArgsDef } from 'citty';

export const sharedArguments = {
	config: {
		description: 'Path to config file',
		type: 'string',
	},
	'db-path': {
		description: 'Path to SQLite database file',
		type: 'string',
	},
	'log-path': {
		description: 'Path to corruption log file',
		type: 'string',
	},
} as const satisfies ArgsDef;
