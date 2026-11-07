export function installShutdownHandler(): AbortSignal {
	const controller = new AbortController();
	process.on('SIGINT', () => {
		if (controller.signal.aborted) {
			process.exit(2);
		}
		controller.abort();
		console.log('\nGracefully shutting down; waiting for in-flight workers to finish...');
	});
	return controller.signal;
}
