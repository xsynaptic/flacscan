import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	process.removeAllListeners('SIGINT');
	vi.restoreAllMocks();
});

function deferred<T>() {
	let resolve!: (value?: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res as (value?: T) => void;
	});
	return { promise, resolve };
}

async function freshPool() {
	return await import('../../src/cli/process-pool.js');
}

describe('processPool', () => {
	it('drains every item exactly once', async () => {
		const { processPool } = await freshPool();
		const items = Array.from({ length: 10 }, (_, index) => index);
		const seen: number[] = [];

		await processPool(items, 3, (item) => {
			seen.push(item);
		});

		expect(seen.toSorted((a, b) => a - b)).toEqual(items);
	});

	it('never exceeds the concurrency cap and still drains', async () => {
		const { processPool } = await freshPool();
		const gates = Array.from({ length: 6 }, () => deferred<undefined>());
		let inFlight = 0;
		let maxInFlight = 0;
		let index = 0;

		const poolPromise = processPool(gates, 3, async (gate) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await gate.promise;
			inFlight--;
		});

		while (index < gates.length) {
			gates[index]?.resolve();
			index++;
		}

		await poolPromise;

		expect(maxInFlight).toBeLessThanOrEqual(3);
	});

	it('stops pulling work after SIGINT and leaves the rest unprocessed', async () => {
		const { installShutdownHandler, isShuttingDown, processPool } = await freshPool();
		installShutdownHandler();

		const gates = Array.from({ length: 6 }, () => deferred<undefined>());
		const processed: number[] = [];

		const poolPromise = processPool(gates, 2, async (gate) => {
			const position = gates.indexOf(gate);
			await gate.promise;
			processed.push(position);
		});

		process.emit('SIGINT');
		for (const gate of gates) gate.resolve();
		await poolPromise;

		expect(isShuttingDown()).toBe(true);
		expect(processed.length).toBeLessThan(gates.length);
	});

	it('force-exits on a second SIGINT', async () => {
		const { installShutdownHandler } = await freshPool();
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		installShutdownHandler();

		process.emit('SIGINT');
		process.emit('SIGINT');

		expect(exitSpy).toHaveBeenCalledWith(2);
	});
});
