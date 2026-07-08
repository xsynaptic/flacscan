export interface FormatVerifier {
	extensions: string[];
	fixer?: FormatFixer;
	requiredBinaries: Array<{ hint?: string; name: string }>;
	verify(filePath: string): Promise<VerificationResult>;
}

export type VerificationResult =
	| { errorOutput: string; errorTimestamp: null | string; status: 'corrupt' }
	| { status: 'healthy' }
	| { status: 'interrupted' };

interface FormatFixer {
	detect(errorOutput: string): boolean;
	fix(filePath: string): Promise<{ error?: string; ok: boolean }>;
	label: string;
	requiredBinaries: Array<{ hint?: string; name: string }>;
}
