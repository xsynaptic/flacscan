import { vi } from 'vitest';

// Spinner stderr, including the red ✖ from .fail(), otherwise reads like a test failure
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
