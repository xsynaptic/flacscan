import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { initializeSchema } from '#database/schema.ts';

export function openDatabase(databasePath: string): Database.Database {
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	const database = new Database(databasePath);
	database.pragma('journal_mode = WAL');
	initializeSchema(database);
	return database;
}
