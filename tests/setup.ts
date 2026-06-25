import { vi } from 'vitest';

// Silence ora spinners during tests. Their stderr writes, including the red ✖
// from .fail(), otherwise leak into the test output and read like failures.
vi.mock('ora', () => {
	const spinner = {
		clear: () => spinner,
		fail: () => spinner,
		info: () => spinner,
		render: () => spinner,
		start: () => spinner,
		stop: () => spinner,
		succeed: () => spinner,
		text: '',
		warn: () => spinner,
	};
	return { default: () => spinner };
});
