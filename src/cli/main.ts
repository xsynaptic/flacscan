import { defineCommand } from 'citty';

import { listCommand } from './list.js';
import { recheckCommand } from './recheck.js';
import { reportCommand } from './report.js';
import { scanCommand } from './scan.js';
import { statusCommand } from './status.js';

export const main = defineCommand({
	meta: {
		description: 'Periodic integrity verification for large FLAC collections',
		name: 'flacscan',
		version: '0.1.0',
	},
	subCommands: {
		list: listCommand,
		recheck: recheckCommand,
		report: reportCommand,
		scan: scanCommand,
		status: statusCommand,
	},
});
