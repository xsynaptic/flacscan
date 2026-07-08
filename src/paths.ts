import path from 'node:path';

// Compare against "dir + sep" so /music doesn't match /music-other
export function directoryPrefix(directory: string): string {
	return directory.endsWith(path.sep) ? directory : directory + path.sep;
}
