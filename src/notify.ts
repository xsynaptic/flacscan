import { execFile } from './shell.js';

// AppleScript string literal: backslashes and double quotes are the only escapes needed
export function osaStringLiteral(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)}"`;
}

// Best effort; a failed banner must never affect the scan outcome
export async function sendNotification(title: string, message: string): Promise<boolean> {
	if (process.platform !== 'darwin') {
		console.warn('--notify is only supported on macOS; skipping notification');
		return false;
	}
	const script = `display notification ${osaStringLiteral(message)} with title ${osaStringLiteral(title)}`;
	try {
		await execFile('osascript', ['-e', script]);
		return true;
	} catch (error) {
		console.warn(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
