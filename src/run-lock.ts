import fs from 'node:fs';

import { FlacScanError } from '#errors.ts';

export function acquireRunLock(dbPath: string): (() => void) | undefined {
	if (dbPath === ':memory:') return undefined;
	const lockPath = `${dbPath}.lock`;
	takeLock(lockPath, dbPath, true);
	let held = true;
	const release = () => {
		if (!held) return;
		held = false;
		process.off('exit', release);
		fs.rmSync(lockPath, { force: true });
	};
	process.on('exit', release);
	return release;
}

function takeLock(lockPath: string, dbPath: string, mayTakeOver: boolean) {
	try {
		fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const holder = fs.readFileSync(lockPath, 'utf8').trim();
	if (mayTakeOver && isGone(Number(holder))) {
		fs.rmSync(lockPath, { force: true });
		takeLock(lockPath, dbPath, false);
		return;
	}
	throw new FlacScanError(
		`Another flacscan run (pid ${holder}) is using ${dbPath}; try again when it finishes.`,
		2,
	);
}

function isGone(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH';
	}
}
