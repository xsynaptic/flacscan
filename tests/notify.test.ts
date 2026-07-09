import { afterEach, describe, expect, it, vi } from 'vitest';

import { osaStringLiteral, sendNotification } from '../src/notify.js';
import { execFile } from '../src/shell.js';

vi.mock('../src/shell.js', () => ({
	execFile: vi.fn(() => Promise.resolve({ stderr: '', stdout: '' })),
}));

describe('osaStringLiteral', () => {
	it('wraps a plain string in double quotes', () => {
		expect(osaStringLiteral('hello')).toBe('"hello"');
	});

	it('escapes embedded double quotes and backslashes', () => {
		expect(osaStringLiteral('a "b" c')).toBe(String.raw`"a \"b\" c"`);
		expect(osaStringLiteral(String.raw`path\to`)).toBe(String.raw`"path\\to"`);
	});
});

describe('sendNotification', () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		vi.clearAllMocks();
	});

	it('returns false without spawning on a non-macOS platform', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await sendNotification('flacscan', 'new corruption');

		expect(result).toBe(false);
		expect(execFile).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('spawns osascript with a display-notification script on macOS', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });

		const result = await sendNotification('flacscan', 'new corruption');

		expect(result).toBe(true);
		expect(execFile).toHaveBeenCalledWith('osascript', [
			'-e',
			'display notification "new corruption" with title "flacscan"',
		]);
	});
});
