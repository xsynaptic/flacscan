import { afterEach, describe, expect, it, vi } from 'vitest';

import { osaStringLiteral, sendNotification } from '#notify.ts';
import { execFile } from '#shell.ts';

vi.mock('#shell.ts', () => ({
	execFile: vi.fn(() => Promise.resolve({ stderr: '', stdout: '' })),
}));

describe('osaStringLiteral', () => {
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

	it('warns and skips the spawn on a non-macOS platform', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await sendNotification('flacscan', 'new corruption');

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('only supported on macOS'));
		expect(execFile).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('spawns osascript with a display-notification script on macOS', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });

		await sendNotification('flacscan', 'new corruption');

		expect(execFile).toHaveBeenCalledWith('osascript', [
			'-e',
			'display notification "new corruption" with title "flacscan"',
		]);
	});

	it('warns and resolves when osascript fails, so a finished scan is not failed', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		vi.mocked(execFile).mockRejectedValueOnce(new Error('osascript exited 1'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await sendNotification('flacscan', 'new corruption');

		expect(warnSpy).toHaveBeenCalledWith('Notification failed: osascript exited 1');
		warnSpy.mockRestore();
	});
});
