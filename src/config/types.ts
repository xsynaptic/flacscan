export interface FlacScanConfig {
	batch_size: number;
	db_path: string;
	directories: string[];
	fix: boolean;
	log_path: string;
	min_free_bytes: number;
	notify: boolean;
	parallelism: number;
	recover_max_trailing_loss_seconds: number;
	rescan_interval_days: number;
}

export const DEFAULT_CONFIG: FlacScanConfig = {
	batch_size: 100,
	db_path: '~/.flacscan/flacscan.db',
	directories: [],
	fix: false,
	log_path: '~/.flacscan/flacscan.log',
	min_free_bytes: 1_073_741_824,
	notify: false,
	parallelism: 1,
	recover_max_trailing_loss_seconds: 3,
	rescan_interval_days: 90,
};
