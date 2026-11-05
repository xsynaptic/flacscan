import { defineCommand } from 'citty';

import { acceptCommand } from '#cli/accept.ts';
import { listCommand } from '#cli/list.ts';
import { recheckCommand } from '#cli/recheck.ts';
import { recoverCommand } from '#cli/recover.ts';
import { reportCommand } from '#cli/report.ts';
import { scanCommand } from '#cli/scan.ts';
import { statusCommand } from '#cli/status.ts';

import packageJson from '../../package.json' with { type: 'json' };

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
