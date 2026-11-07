export interface StopSignal {
	readonly aborted: boolean;
}

export async function processPool<T>(
	items: T[],
	{ concurrency, signal }: { concurrency: number; signal: StopSignal },
	worker: (item: T) => Promise<void> | void,
) {
	const queue = [...items];
	const workers = Array.from({ length: concurrency }, async () => {
		while (!signal.aborted && queue.length > 0) {
			const item = queue.shift();
			if (item !== undefined) {
				await worker(item);
			}
		}
	});
	await Promise.all(workers);
}
