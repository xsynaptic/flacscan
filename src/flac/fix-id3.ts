import { execFile, extractStderr } from './shell.js';

const ID3_PATTERN = /ID3v\d tag found|looks like an ID3v1 tag/i;

interface Id3FixResult {
	error?: string;
	ok: boolean;
}

export function hasId3Tags(errorOutput: string): boolean {
	return ID3_PATTERN.test(errorOutput);
}

export async function stripId3Tags(filePath: string): Promise<Id3FixResult> {
	try {
		await execFile('id3v2', ['--delete-all', filePath]);
		return { ok: true };
	} catch (error: unknown) {
		return { error: extractStderr(error), ok: false };
	}
}
