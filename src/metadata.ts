import { execFile } from '#shell.ts';

export interface FlacMetadata {
	album: null | string;
	artist: null | string;
	date: null | string;
	duration: null | number;
	title: null | string;
}

type TagKey = keyof Omit<FlacMetadata, 'duration'>;

const TAG_KEYS = new Set(['album', 'artist', 'date', 'title']);

export async function extractMetadata(filePath: string): Promise<FlacMetadata | null> {
	try {
		const [tagsResult, durationResult] = await Promise.all([
			execFile('metaflac', ['--export-tags-to=-', filePath]),
			execFile('metaflac', ['--show-total-samples', '--show-sample-rate', filePath]),
		]);
		return { ...parseTags(tagsResult.stdout), duration: parseDuration(durationResult.stdout) };
	} catch {
		return null;
	}
}

function parseDuration(stdout: string): null | number {
	const lines = stdout.trim().split('\n');
	if (lines.length < 2) return null;
	const totalSamples = Number(lines[0]);
	const sampleRate = Number(lines[1]);
	if (sampleRate > 0 && Number.isFinite(totalSamples)) {
		return Math.round((totalSamples / sampleRate) * 100) / 100;
	}
	return null;
}

function parseTags(stdout: string): Record<TagKey, null | string> {
	const tags: Record<TagKey, null | string> = {
		album: null,
		artist: null,
		date: null,
		title: null,
	};
	for (const line of stdout.split('\n')) {
		const eqIndex = line.indexOf('=');
		if (eqIndex === -1) continue;

		const tag = line.slice(0, eqIndex).toLowerCase();
		if (!TAG_KEYS.has(tag)) continue;

		const key = tag as TagKey;
		tags[key] ??= line.slice(eqIndex + 1);
	}
	return tags;
}
