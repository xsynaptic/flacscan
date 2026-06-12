import type { FlacScanConfig } from '../config/types.js';

import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { FlacScanError } from '../errors.js';

type Database = ReturnType<typeof openDatabase>;

interface RunCommandOptions {
	// Runs after config load and before the database opens; binary checks live here
	prepare?: (config: FlacScanConfig) => Promise<void> | void;
}

export async function runCommand(
	args: Parameters<typeof loadConfig>[0],
	options: RunCommandOptions,
	body: (db: Database, config: FlacScanConfig) => Promise<void> | void,
): Promise<void> {
	try {
		const config = loadConfig(args);
		await options.prepare?.(config);
		const db = openDatabase(config.db_path);
		try {
			await body(db, config);
		} finally {
			db.close();
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
