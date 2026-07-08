import { describe, expect, it } from 'vitest';

import { directoryPrefix } from '../src/paths.js';

describe('directoryPrefix', () => {
	it('appends a separator to a bare directory', () => {
		expect(directoryPrefix('/music')).toBe('/music/');
	});

	it('is idempotent when the directory already ends in a separator', () => {
		expect(directoryPrefix('/music/')).toBe('/music/');
	});
});
