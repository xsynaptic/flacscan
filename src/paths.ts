import fs from 'node:fs';
import path from 'node:path';

export function directoryPrefix(directory: string): string {
	return directory.endsWith(path.sep) ? directory : directory + path.sep;
}

interface Found {
	spelled: string;
}

type Lookup = 'missing' | 'unreadable' | Found;

function foldCase(name: string): string {
	return name.normalize('NFC').toLowerCase();
}

function failedLookup(error: unknown): Lookup {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
}

function listedEntry(directory: string, name: string): Lookup {
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (error) {
		return failedLookup(error);
	}
	if (entries.includes(name)) return { spelled: name };
	const folded = foldCase(name);
	const match = entries.find((entry) => foldCase(entry) === folded);
	return match === undefined ? 'missing' : { spelled: match };
}

function statResolved(resolved: string): SpelledStat {
	try {
		return { kind: 'present', stats: fs.statSync(resolved) };
	} catch (error) {
		if (failedLookup(error) === 'missing') return { kind: 'missing' };
		return { error: String(error), kind: 'unreadable' };
	}
}

function onDiskEntry(directory: string, name: string): Lookup {
	const entryPath = path.join(directory, name);
	let realName: string;
	try {
		if (fs.lstatSync(entryPath).isSymbolicLink()) return listedEntry(directory, name);
		realName = path.basename(fs.realpathSync.native(entryPath));
	} catch (error) {
		return failedLookup(error);
	}
	if (foldCase(realName) === foldCase(name)) return { spelled: realName };
	return listedEntry(directory, name);
}

const spelledDirectories = new Set<string>();

function spellDirectory(directory: string): Lookup {
	const parent = path.dirname(directory);
	if (parent === directory || spelledDirectories.has(directory)) return { spelled: directory };
	const parentLookup = spellDirectory(parent);
	if (typeof parentLookup === 'string') return parentLookup;
	const entry = onDiskEntry(parentLookup.spelled, path.basename(directory));
	if (typeof entry === 'string') return entry;
	const spelled = path.join(parentLookup.spelled, entry.spelled);
	if (spelled === directory) spelledDirectories.add(spelled);
	return { spelled };
}

export type SpelledStat =
	| { error: string; kind: 'unreadable' }
	| { kind: 'missing' }
	| { kind: 'present'; stats: fs.Stats };

export function statAsSpelled(filePath: string): SpelledStat {
	const resolved = path.resolve(filePath);
	const directory = path.dirname(resolved);
	if (directory === resolved) return statResolved(resolved);
	const parent = spellDirectory(directory);
	if (parent === 'unreadable') return statResolved(resolved);
	if (parent === 'missing' || parent.spelled !== directory) return { kind: 'missing' };
	const entry = onDiskEntry(directory, path.basename(resolved));
	if (entry === 'unreadable') return statResolved(resolved);
	if (entry === 'missing' || entry.spelled !== path.basename(resolved)) return { kind: 'missing' };
	return statResolved(resolved);
}

export function onDiskSpelling(directory: string): string {
	const resolved = path.resolve(directory);
	const lookup = spellDirectory(resolved);
	return typeof lookup === 'string' ? resolved : lookup.spelled;
}
