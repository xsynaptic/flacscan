import { describe, expect, it } from 'vitest';

import { classifyError, extractErrorTimestamp } from '../../src/flac/verify.js';

describe('classifyError', () => {
	it('returns critical for OUT_OF_BOUNDS', () => {
		expect(classifyError('error: OUT_OF_BOUNDS in frame')).toBe('critical');
	});

	it('returns critical for UNPARSEABLE_STREAM', () => {
		expect(classifyError('UNPARSEABLE_STREAM')).toBe('critical');
	});

	it('returns critical for unexpected EOF', () => {
		expect(classifyError('unexpected EOF reading data')).toBe('critical');
	});

	it('returns critical for got 0 bytes from read callback', () => {
		expect(classifyError('got 0 bytes from read callback')).toBe('critical');
	});

	it('returns critical for truncated sample count', () => {
		expect(
			classifyError(
				'ERROR, decoded number of samples is smaller than the total number of samples set in the STREAMINFO',
			),
		).toBe('critical');
	});

	it('returns recoverable for FRAME_CRC_MISMATCH', () => {
		expect(classifyError('error: FRAME_CRC_MISMATCH')).toBe('recoverable');
	});

	it('returns recoverable for MD5 signature mismatch', () => {
		expect(classifyError('MD5 signature mismatch')).toBe('recoverable');
	});

	it('returns unknown for unrecognized text', () => {
		expect(classifyError('some other error')).toBe('unknown');
	});

	it('critical wins when both patterns present', () => {
		expect(classifyError('OUT_OF_BOUNDS and FRAME_CRC_MISMATCH')).toBe('critical');
	});

	it('returns critical for LOST_SYNC with ABORTED', () => {
		expect(
			classifyError(
				'LOST_SYNC after processing 811008 samples  ERROR while decoding data  state = FLAC__STREAM_DECODER_ABORTED',
			),
		).toBe('critical');
	});

	it('returns recoverable for LOST_SYNC with END_OF_STREAM', () => {
		expect(
			classifyError(
				'LOST_SYNC after processing 20332544 samples  ERROR during decoding  state = FLAC__STREAM_DECODER_END_OF_STREAM',
			),
		).toBe('recoverable');
	});

	it('critical patterns still win over LOST_SYNC + END_OF_STREAM', () => {
		expect(classifyError('UNPARSEABLE_STREAM LOST_SYNC END_OF_STREAM')).toBe('critical');
	});
});

describe('extractErrorTimestamp', () => {
	it('extracts sample number', () => {
		expect(extractErrorTimestamp('error after processing 12345 samples')).toBe('sample 12345');
	});

	it('returns null when no match', () => {
		expect(extractErrorTimestamp('some unrelated error')).toBeNull();
	});
});
