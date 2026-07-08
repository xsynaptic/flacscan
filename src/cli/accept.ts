import { defineCommand } from 'citty';

import { acknowledgeAllIssues } from '../database/queries.js';
import { runCommand } from './run-command.js';
import { sharedArguments } from './shared-arguments.js';

export const acceptCommand = defineCommand({
	args: {
		...sharedArguments,
	},
	meta: {
		description: 'Accept all current issues; future runs alarm only on new corruption',
		name: 'accept',
	},
	async run({ args }) {
		await runCommand(args, {}, (db) => {
			const { corrupt, unreadable } = acknowledgeAllIssues(db);
			console.log(
				`Accepted ${String(corrupt)} corrupt and ${String(unreadable)} unreadable file(s).`,
			);
		});
	},
});
