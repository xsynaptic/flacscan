export class FlacScanError extends Error {
	exitCode: number;

	constructor(message: string, exitCode = 2) {
		super(message);
		this.name = 'FlacScanError';
		this.exitCode = exitCode;
	}
}
