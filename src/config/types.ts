export interface FlacScanConfig {
	batch_size: number;
	db_path: string;
	directories: string[];
	fix: boolean;
	log_path: string;
	parallelism: number;
	rescan_interval_days: number;
}

export const DEFAULT_CONFIG: FlacScanConfig = {
	batch_size: 100,
	db_path: '~/.flacscan/flacscan.db',
	directories: [],
	fix: false,
	log_path: '~/.flacscan/flacscan.log',
	parallelism: 1,
	rescan_interval_days: 90,
};
