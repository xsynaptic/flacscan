import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { execFile } from '../shell.js';
import { isShuttingDown } from './process-pool.js';

export interface FlacFormat {
	bitsPerSample: number;
	channels: number;
	sampleRate: number;
	totalSamples: number;
}

export interface RecoveryEnv {
	carryMetadata(src: string, dest: string): Promise<void>;
	decodeReencode(src: string, dest: string, format: FlacFormat): Promise<void>;
	exists(path: string): boolean;
	probe(path: string): Promise<FlacFormat>;
	rename(from: string, to: string): Promise<void>;
	shouldStop(): boolean;
	testPasses(path: string): Promise<boolean>;
	unlink(path: string): Promise<void>;
	utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
}

export const flacEngine: RecoveryEnv = {
	carryMetadata,
	decodeReencode,
	exists: (path) => fs.existsSync(path),
	probe: probeFlac,
	rename: (from, to) => fs.promises.rename(from, to),
	shouldStop: isShuttingDown,
	testPasses: flacTestPasses,
	unlink: safeUnlink,
	utimes: (path, atimeMs, mtimeMs) => fs.promises.utimes(path, atimeMs / 1000, mtimeMs / 1000),
};

// Curated subset of tags to carry onto the recovered file:
// - Metaflac's tag import is line-based; a value containing newlines aborts the whole import
// - DJ blobs (BEATGRID/SERATO_*) are the usual offenders; these short fields never have newlines
// - And these are the ones a library manager actually needs
const CARRIED_TAGS = [
	'TITLE',
	'ARTIST',
	'ALBUM',
	'ALBUMARTIST',
	'DATE',
	'YEAR',
	'GENRE',
	'TRACKNUMBER',
	'TRACKTOTAL',
	'TOTALTRACKS',
	'DISCNUMBER',
	'DISCTOTAL',
	'TOTALDISCS',
	'COMPOSER',
	'COMMENT',
	'DESCRIPTION',
	'ISRC',
	'LABEL',
	'ORGANIZATION',
	'PUBLISHER',
	'CATALOGNUMBER',
	'BPM',
	'KEY',
	'INITIALKEY',
	'COPYRIGHT',
];

// Copy the original's tags and front-cover onto the re-encode (raw PCM has neither)
// Best effort: callers treat a throw as a warning
async function carryMetadata(src: string, dest: string): Promise<void> {
	const { stdout } = await execFile('metaflac', [
		...CARRIED_TAGS.map((name) => `--show-tag=${name}`),
		src,
	]);
	// Keep only well-formed NAME=value lines; drops stray continuation lines that would abort the import
	const tagLines = stdout.split('\n').filter((line) => /^[^=\n]+=/.test(line));
	if (tagLines.length > 0) {
		const tagsTmp = `${dest}.tags`;
		await fs.promises.writeFile(tagsTmp, tagLines.join('\n') + '\n');
		try {
			await execFile('metaflac', [`--import-tags-from=${tagsTmp}`, dest]);
		} finally {
			await safeUnlink(tagsTmp);
		}
	}

	const coverTmp = `${dest}.cover`;
	let haveCover = false;
	try {
		await execFile('metaflac', [`--export-picture-to=${coverTmp}`, src]);
		haveCover = fs.existsSync(coverTmp) && fs.statSync(coverTmp).size > 0;
	} catch {
		// No PICTURE block (common); nothing to carry over
	}
	try {
		if (haveCover) {
			await execFile('metaflac', [`--import-picture-from=${coverTmp}`, dest]);
		}
	} finally {
		await safeUnlink(coverTmp);
	}
}

// Decode src to raw PCM, pipe it straight into a max-effort re-encode at dest:
// - Decoder runs stop-at-first-error, so it emits a contiguous clean prefix then closes
// - Encoder writes exactly that prefix
function decodeReencode(src: string, dest: string, format: FlacFormat): Promise<void> {
	return new Promise((resolve, reject) => {
		const decoder = spawn(
			'flac',
			[
				'--decode',
				'--force-raw-format',
				'--endian=little',
				'--sign=signed',
				'--silent',
				'--stdout',
				src,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const encoder = spawn(
			'flac',
			[
				'-8',
				'-e',
				'-p',
				'-V',
				'--force-raw-format',
				'--endian=little',
				'--sign=signed',
				`--channels=${String(format.channels)}`,
				`--bps=${String(format.bitsPerSample)}`,
				`--sample-rate=${String(format.sampleRate)}`,
				'--silent',
				'--force',
				'-o',
				dest,
				'-',
			],
			{ stdio: ['pipe', 'ignore', 'pipe'] },
		);

		let settled = false;
		let decoderClosed = false;
		let encoderClosed = false;
		let encoderErr = '';

		function fail(message: string): void {
			if (!settled) {
				settled = true;
				decoder.kill();
				encoder.kill();
				reject(new Error(message));
			}
		}
		function maybeResolve(): void {
			if (!settled && decoderClosed && encoderClosed) {
				settled = true;
				resolve();
			}
		}

		// Swallow stream errors on the wired-up pipes:
		// - On SIGINT (Ctrl+C) the flac children die and these sockets EPIPE
		// - Without listeners that becomes an unhandled 'error' and crashes the process
		// - The close handlers below report the real outcome
		decoder.stdout.on('error', ignoreStreamError);
		decoder.stderr.on('error', ignoreStreamError);
		encoder.stdin.on('error', ignoreStreamError);
		encoder.stderr.on('error', ignoreStreamError);

		decoder.on('error', (error) => {
			fail(`flac decode could not start: ${error.message}`);
		});
		encoder.on('error', (error) => {
			fail(`flac encode could not start: ${error.message}`);
		});
		encoder.stderr.on('data', (chunk: Buffer) => {
			encoderErr += chunk.toString();
		});

		decoder.stdout.pipe(encoder.stdin);

		decoder.on('close', () => {
			// Non-zero decoder exit is expected for a corrupt file; keep what it piped through
			decoderClosed = true;
			maybeResolve();
		});
		encoder.on('close', (code) => {
			encoderClosed = true;
			if (code !== 0) {
				const lastLine = encoderErr.trim().split('\n').pop() ?? '';
				fail(
					`flac encode exited with ${String(code ?? 'a signal')}${lastLine ? `: ${lastLine}` : ''}`,
				);
				return;
			}
			maybeResolve();
		});
	});
}

async function flacTestPasses(filePath: string): Promise<boolean> {
	try {
		await execFile('flac', ['--test', '--silent', filePath]);
		return true;
	} catch {
		return false;
	}
}

function ignoreStreamError(): void {
	// See decodeReencode: EPIPE on a killed child's pipe is expected, not an error
}

async function probeFlac(filePath: string): Promise<FlacFormat> {
	const { stdout } = await execFile('metaflac', [
		'--show-total-samples',
		'--show-sample-rate',
		'--show-channels',
		'--show-bps',
		filePath,
	]);
	const lines = stdout.trim().split('\n');
	if (lines.length < 4) {
		throw new Error(`unexpected metaflac output for ${filePath}: ${stdout.trim()}`);
	}
	const totalSamples = Number(lines[0]);
	const sampleRate = Number(lines[1]);
	const channels = Number(lines[2]);
	const bitsPerSample = Number(lines[3]);
	if (
		![totalSamples, sampleRate, channels, bitsPerSample].every((value) => Number.isFinite(value))
	) {
		throw new Error(`could not parse metaflac output for ${filePath}: ${stdout.trim()}`);
	}
	return { bitsPerSample, channels, sampleRate, totalSamples };
}

async function safeUnlink(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch {
		// Already gone, or can't remove; not fatal
	}
}
