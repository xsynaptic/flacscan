import type { ErrorSeverity } from '../verifiers/types.js';

export interface FileRow {
	album: null | string;
	artist: null | string;
	current_path: string;
	date: null | string;
	duration: null | number;
	error_output: null | string;
	error_severity: ErrorSeverity | null;
	error_timestamp: null | string;
	file_mtime: null | string;
	file_size: null | number;
	first_seen_at: string;
	last_result: FileStatus;
	last_verified_at: null | string;
	recovery_attempted_at: null | string;
	recovery_detail: null | string;
	recovery_lost_samples: null | number;
	recovery_result: null | RecoveryResult;
	title: null | string;
	updated_at: string;
}

export type FileStatus = 'corrupt' | 'healthy' | 'pending';

export type RecoveryResult = 'recovered' | 'unsuitable';

export interface UnreadableFileRow {
	current_path: string;
	error_output: string;
	first_seen_at: string;
	updated_at: string;
}
