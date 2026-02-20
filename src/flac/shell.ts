import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { FlacScanError } from '../cli/errors.js';

export const execFile = promisify(execFileCb);

export async function ensureBinary(name: string, hint?: string): Promise<void> {
	try {
		await execFile(name, ['--version']);
	} catch {
		const message = hint
			? `${name} must be installed (${hint})`
			: `${name} must be installed and on PATH`;
		throw new FlacScanError(message);
	}
}

export function extractStderr(error: unknown): string {
	const stderr =
		error instanceof Error && 'stderr' in error
			? String((error as { stderr: unknown }).stderr)
			: String(error);
	return stderr.trim();
}
