import type Database from 'better-sqlite3';

const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  current_path    TEXT PRIMARY KEY,
  last_verified_at TEXT,
  last_result     TEXT NOT NULL DEFAULT 'pending',
  error_severity  TEXT,
  error_output    TEXT,
  error_timestamp TEXT,
  artist          TEXT,
  title           TEXT,
  album           TEXT,
  date            TEXT,
  duration        REAL,
  file_size       INTEGER,
  file_mtime      TEXT,
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

const CREATE_FILES_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_last_verified ON files (last_result, last_verified_at);
`;

const CREATE_UNREADABLE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS unreadable_files (
  current_path  TEXT PRIMARY KEY,
  error_output  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

export function initializeSchema(database: Database.Database) {
	database.exec(CREATE_FILES_TABLE);
	database.exec(CREATE_FILES_INDEXES);
	database.exec(CREATE_UNREADABLE_FILES_TABLE);
	applyMigrations(database);
}

function applyMigrations(database: Database.Database) {
	const columns = database.pragma('table_info(files)') as Array<{ name: string }>;
	const existing = new Set(columns.map((c) => c.name));
	for (const col of ['artist', 'title', 'album', 'date']) {
		if (!existing.has(col)) {
			database.exec(`ALTER TABLE files ADD COLUMN ${col} TEXT`);
		}
	}
	if (!existing.has('duration')) {
		database.exec(`ALTER TABLE files ADD COLUMN duration REAL`);
	}
}
