import { describe, expect, it } from 'vitest';

import { processPool } from '#process-pool.ts';

const running = { aborted: false };

function deferred<T>() {
	let resolve!: (value?: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res as (value?: T) => void;
	});
	return { promise, resolve };
}

describe('processPool', () => {
	it('drains every item exactly once', async () => {
		const items = Array.from({ length: 10 }, (_, index) => index);
		const seen: number[] = [];

		await processPool(items, { concurrency: 3, signal: running }, (item) => {
			seen.push(item);
		});

		expect(seen.toSorted((a, b) => a - b)).toEqual(items);
	});

	it('never exceeds the concurrency cap and still drains', async () => {
		const gates = Array.from({ length: 6 }, () => deferred<undefined>());
		let inFlight = 0;
		let maxInFlight = 0;
		let index = 0;

		const poolPromise = processPool(gates, { concurrency: 3, signal: running }, async (gate) => {
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

	it('stops pulling work once the signal aborts and leaves the rest unprocessed', async () => {
		const controller = new AbortController();
		const gates = Array.from({ length: 6 }, () => deferred<undefined>());
		const processed: number[] = [];

		const poolPromise = processPool(
			gates,
			{ concurrency: 2, signal: controller.signal },
			async (gate) => {
				const position = gates.indexOf(gate);
				await gate.promise;
				processed.push(position);
			},
		);

		controller.abort();
		for (const gate of gates) gate.resolve();
		await poolPromise;

		expect(processed).toHaveLength(2);
	});
});
