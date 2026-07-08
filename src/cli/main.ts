import { defineCommand } from 'citty';

import packageJson from '../../package.json' with { type: 'json' };
import { acceptCommand } from './accept.js';
import { listCommand } from './list.js';
import { recheckCommand } from './recheck.js';
import { recoverCommand } from './recover.js';
import { reportCommand } from './report.js';
import { scanCommand } from './scan.js';
import { statusCommand } from './status.js';

export const main = defineCommand({
	meta: {
		description: 'Periodic integrity verification for large FLAC collections',
		name: 'flacscan',
		version: packageJson.version,
	},
	subCommands: {
		accept: acceptCommand,
		list: listCommand,
		recheck: recheckCommand,
		recover: recoverCommand,
		report: reportCommand,
		scan: scanCommand,
		status: statusCommand,
	},
});
