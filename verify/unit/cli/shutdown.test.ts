import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installShutdownHandler } from '#cli/shutdown.ts';

let listenersBefore: NodeJS.SignalsListener[];

beforeEach(() => {
	listenersBefore = process.listeners('SIGINT');
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	for (const listener of process.listeners('SIGINT')) {
		if (!listenersBefore.includes(listener)) process.removeListener('SIGINT', listener);
	}
	vi.restoreAllMocks();
});

describe('installShutdownHandler', () => {
	it('aborts its signal on the first SIGINT without exiting', () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		const signal = installShutdownHandler();

		expect(signal.aborted).toBe(false);
		process.emit('SIGINT');

		expect(signal.aborted).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(
			'\nGracefully shutting down; waiting for in-flight workers to finish...',
		);
	});

	it('force-exits on a second SIGINT', () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		installShutdownHandler();

		process.emit('SIGINT');
		process.emit('SIGINT');

		expect(exitSpy).toHaveBeenCalledWith(2);
	});
});
