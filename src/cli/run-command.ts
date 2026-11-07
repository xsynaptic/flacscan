import type { FlacScanConfig } from '#config/types.ts';

import { installShutdownHandler } from '#cli/shutdown.ts';
import { loadConfig } from '#config/loader.ts';
import { openDatabase } from '#database/connection.ts';
import { FlacScanError } from '#errors.ts';
import { acquireRunLock } from '#run-lock.ts';

type Database = ReturnType<typeof openDatabase>;

interface RunCommandOptions {
	exclusive?: boolean;
	interruptible?: boolean;
	prepare?: (config: FlacScanConfig) => Promise<void> | void;
}

function stopSignal(options: RunCommandOptions): AbortSignal {
	return options.interruptible === true ? installShutdownHandler() : new AbortController().signal;
}

function lockIfExclusive(options: RunCommandOptions, dbPath: string) {
	return options.exclusive === true ? acquireRunLock(dbPath) : undefined;
}

export async function runCommand(
	args: Parameters<typeof loadConfig>[0],
	options: RunCommandOptions,
	body: (db: Database, config: FlacScanConfig, signal: AbortSignal) => Promise<void> | void,
): Promise<void> {
	const signal = stopSignal(options);
	try {
		const config = loadConfig(args);
		await options.prepare?.(config);
		const releaseLock = lockIfExclusive(options, config.db_path);
		let db: Database | undefined;
		try {
			db = openDatabase(config.db_path);
			await body(db, config, signal);
		} finally {
			db?.close();
			releaseLock?.();
		}
	} catch (error) {
		if (error instanceof FlacScanError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
			return;
		}
		// An unexpected crash is a tool error (exit 2), never "corruption detected" (exit 1)
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exitCode = 2;
	}
}
