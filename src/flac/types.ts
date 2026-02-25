export type ErrorSeverity = 'critical' | 'recoverable' | 'unknown';

export type VerificationResult =
	| {
			errorOutput: string;
			errorTimestamp: null | string;
			severity: ErrorSeverity;
			status: 'corrupt';
	  }
	| { status: 'healthy' }
	| { status: 'interrupted' };
