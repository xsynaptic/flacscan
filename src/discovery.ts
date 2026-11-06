import fs from 'node:fs';
import path from 'node:path';

import { onDiskSpelling } from '#paths.ts';
import { originalNameForRecoveredFile } from '#recovery.ts';

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
			const spelled = onDiskSpelling(directory);
			if (!available.includes(spelled)) available.push(spelled);
		} catch {
			skipped.push(directory);
		}
	}

	return { available, skipped };
}

interface IncompleteWalk {
	directory: string;
	error: string;
}

export async function discoverFiles(
	directories: string[],
	extensions: string[],
): Promise<{
	files: string[];
	incomplete: IncompleteWalk[];
	mountCheck: MountCheckResult;
	walked: string[];
}> {
	const mountCheck = checkMountedPaths(directories);
	const incomplete: IncompleteWalk[] = [];
	const results = await Promise.all(
		mountCheck.available.map(async (directory) => {
			try {
				return matchingFiles(
					directory,
					await fs.promises.readdir(directory, { recursive: true }),
					extensions,
				);
			} catch (error) {
				incomplete.push({ directory, error: String(error) });
				return [];
			}
		}),
	);
	const files = results.flat();
	const walked = mountCheck.available.filter((directory) =>
		incomplete.every((walk) => walk.directory !== directory),
	);

	return { files, incomplete, mountCheck, walked };
}

function matchingFiles(directory: string, entries: string[], extensions: string[]): string[] {
	const matched: string[] = [];
	for (const entry of entries) {
		if (extensions.every((extension) => !entry.toLowerCase().endsWith(extension))) {
			continue;
		}

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
}
