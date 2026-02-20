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

export async function discoverFlacFiles(
	directories: string[],
): Promise<{ files: string[]; mountCheck: MountCheckResult }> {
	const mountCheck = checkMountedPaths(directories);
	const results = await Promise.all(
		mountCheck.available.map(async (directory) => {
			const entries = await fs.promises.readdir(directory, { recursive: true });
			const flacs: string[] = [];
			for (const entry of entries) {
				if (typeof entry === 'string' && entry.toLowerCase().endsWith('.flac')) {
					flacs.push(path.join(directory, entry));
				}
			}
			return flacs;
		}),
	);
	const files = results.flat();

	return { files, mountCheck };
}
