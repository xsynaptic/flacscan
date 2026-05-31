import fs from 'node:fs';
import path from 'node:path';

import { originalNameForRecoveredFile } from './recovery.js';

interface MountCheckResult {
	available: string[];
	skipped: string[];
}

export function checkMountedPaths(directories: string[]): MountCheckResult {
	const available: string[] = [];
	const skipped: string[] = [];

	for (const directory of directories) {
		try {
			fs.accessSync(directory, fs.constants.R_OK);
			available.push(directory);
		} catch {
			skipped.push(directory);
		}
	}

	return { available, skipped };
}

export async function discoverFiles(
	directories: string[],
	extensions: string[],
): Promise<{ files: string[]; mountCheck: MountCheckResult }> {
	const mountCheck = checkMountedPaths(directories);
	const results = await Promise.all(
		mountCheck.available.map(async (directory) => {
			const entries = await fs.promises.readdir(directory, { recursive: true });
			const matched: string[] = [];
			for (const entry of entries) {
				if (
					typeof entry !== 'string' ||
					!extensions.some((extension) => entry.toLowerCase().endsWith(extension))
				) {
					continue;
				}

				// A recovered file ("Track [Recovered].flac") is skipped only while its original
				// still sits in the same directory; once the original is gone it's a normal file.
				const originalName = originalNameForRecoveredFile(path.basename(entry));
				if (
					originalName !== null &&
					fs.existsSync(path.join(directory, path.dirname(entry), originalName))
				) {
					continue;
				}

				matched.push(path.join(directory, entry));
			}
			return matched;
		}),
	);
	const files = results.flat();

	return { files, mountCheck };
}
