import { defineCommand } from 'citty';

import { runCommand } from '#cli/run-command.ts';
import { sharedArguments } from '#cli/shared-arguments.ts';
import { acknowledgeAllIssues } from '#database/queries.ts';

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
