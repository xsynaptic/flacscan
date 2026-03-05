import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FlacMetadata {
	album: null | string;
	artist: null | string;
	date: null | string;
	duration: null | number;
	title: null | string;
}

const TAG_KEYS = new Set(['album', 'artist', 'date', 'title']);

export async function extractMetadata(filePath: string): Promise<FlacMetadata | null> {
	try {
		const [tagsResult, durationResult] = await Promise.all([
			execFileAsync('metaflac', ['--export-tags-to=-', filePath]),
			execFileAsync('metaflac', ['--show-total-samples', '--show-sample-rate', filePath]),
		]);

		const metadata: FlacMetadata = {
			album: null,
			artist: null,
			date: null,
			duration: null,
			title: null,
		};

		for (const line of tagsResult.stdout.split('\n')) {
			const eqIndex = line.indexOf('=');
			if (eqIndex === -1) continue;

			const tag = line.slice(0, eqIndex).toLowerCase();
			if (!TAG_KEYS.has(tag)) continue;

			const key = tag as keyof Omit<FlacMetadata, 'duration'>;
			if (metadata[key] === null) {
				metadata[key] = line.slice(eqIndex + 1);
			}
		}

		const lines = durationResult.stdout.trim().split('\n');
		if (lines.length >= 2) {
			const totalSamples = Number(lines[0]);
			const sampleRate = Number(lines[1]);
			if (sampleRate > 0 && Number.isFinite(totalSamples)) {
				metadata.duration = Math.round((totalSamples / sampleRate) * 100) / 100;
			}
		}

		return metadata;
	} catch {
		return null;
	}
}
