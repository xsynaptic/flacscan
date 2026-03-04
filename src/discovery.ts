import fs from 'node:fs';
import path from 'node:path';

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
					typeof entry === 'string' &&
					extensions.some((ext) => entry.toLowerCase().endsWith(ext))
				) {
					matched.push(path.join(directory, entry));
				}
			}
			return matched;
		}),
	);
	const files = results.flat();

	return { files, mountCheck };
}
