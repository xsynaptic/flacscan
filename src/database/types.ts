import type { ErrorSeverity } from '../flac/types.js';

export interface FileRow {
	current_path: string;
	error_output: null | string;
	error_severity: ErrorSeverity | null;
	error_timestamp: null | string;
	file_mtime: null | string;
	file_size: null | number;
	first_seen_at: string;
	last_result: FileStatus;
	last_verified_at: null | string;
	updated_at: string;
}

export type FileStatus = 'corrupt' | 'healthy' | 'pending';

export interface UnreadableFileRow {
	current_path: string;
	error_output: string;
	first_seen_at: string;
	updated_at: string;
}
