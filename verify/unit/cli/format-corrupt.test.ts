import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorruptOutcome } from '#verification/verify-and-record.ts';

import { printCorruptFile } from '#cli/format-corrupt.ts';

const filePath = '/music/track.flac';
const spinner = { clear: () => {} };

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function printed(outcome: Partial<CorruptOutcome>) {
	printCorruptFile(spinner, filePath, {
		errorOutput: 'LOST_SYNC',
		errorTimestamp: null,
		issue: { acknowledged: false, kind: 'corrupt' },
		kind: 'corrupt',
		lastHealthyAt: null,
		...outcome,
	});
	return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
}

describe('printCorruptFile', () => {
	it('announces detected tags with the --fix hint above the verdict', () => {
		expect(printed({ fix: { label: 'ID3', state: 'detected' } })).toEqual([
			`  ID3_DETECTED ${filePath}`,
			'          Non-standard ID3 tags found, use --fix to strip',
			`  NEW CORRUPT ${filePath}`,
			'          LOST_SYNC',
		]);
	});

	it('announces a failed fix with its error above the verdict', () => {
		expect(printed({ fix: { error: 'metaflac exited 1', label: 'ID3', state: 'failed' } })).toEqual(
			[
				`  ID3_FIX_FAILED ${filePath}`,
				'          metaflac exited 1',
				`  NEW CORRUPT ${filePath}`,
				'          LOST_SYNC',
			],
		);
	});

	it('shortens a decoder error code and appends the sample location', () => {
		expect(
			printed({
				errorOutput:
					'track.flac: *** Got error code 0:FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC after processing 18796544 samples',
				errorTimestamp: 'sample 18796544',
			}),
		).toEqual([`  NEW CORRUPT ${filePath}`, '          LOST_SYNC (sample 18796544)']);
	});
});
