let shuttingDown = false;

export function installShutdownHandler() {
	process.on('SIGINT', () => {
		if (shuttingDown) {
			process.exit(2);
		}
		shuttingDown = true;
		console.log('\nGracefully shutting down — waiting for in-flight workers to finish...');
	});
}

export function isShuttingDown() {
	return shuttingDown;
}

export async function processPool<T>(
	items: T[],
	concurrency: number,
	function_: (item: T) => Promise<void> | void,
) {
	const queue = [...items];
	const workers = Array.from({ length: concurrency }, async () => {
		while (queue.length > 0 && !shuttingDown) {
			const item = queue.shift();
			if (item !== undefined) {
				await function_(item);
			}
		}
	});
	await Promise.all(workers);
}
