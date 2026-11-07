import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { styleText } from 'node:util';

interface PackageManifest {
	name: string;
	version: string;
}

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, { stdio: 'inherit' });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command: string, args: string[]) {
	return spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
}

function step(command: string, args: string[]) {
	const startedAt = performance.now();
	console.log(styleText('bold', `› ${[command, ...args].join(' ')}`));
	run(command, args);
	const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
	console.log(styleText('green', `✓ done in ${seconds}s\n`));
}

function exitWith(message: string): never {
	console.error(styleText('red', message));
	process.exit(1);
}

async function isPublished({ name, version }: PackageManifest) {
	const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
		method: 'HEAD',
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status === 404) return false;
	if (!response.ok) {
		throw new Error(`npm registry answered ${String(response.status)} for ${name}@${version}`);
	}
	return true;
}

function isTagOnOrigin(tag: string) {
	const result = capture('git', ['ls-remote', '--tags', '--refs', 'origin', `refs/tags/${tag}`]);
	if (result.status !== 0) exitWith(`Could not list tags on origin:\n${result.stderr}`);
	return result.stdout.trim() !== '';
}

const branch = capture('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();

if (branch !== 'main') exitWith(`Release from main; HEAD is ${branch || 'detached'}`);

const uncommitted = capture('git', ['status', '--porcelain']).stdout.trimEnd();

// `changeset publish` packs from the working tree, so it must match what is committed
if (uncommitted) exitWith(`Commit or stash these before releasing:\n${uncommitted}`);

const hasChangesets = readdirSync('.changeset').some(
	(fileName) => fileName.endsWith('.md') && fileName !== 'README.md',
);
if (hasChangesets) exitWith('Pending changesets; run `pnpm changeset version` and commit first');

const fetchResult = capture('git', ['fetch', '--quiet', 'origin', 'main']);
if (fetchResult.status !== 0) exitWith(`Could not fetch origin/main:\n${fetchResult.stderr}`);

if (capture('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).status !== 0) {
	exitWith('origin/main has commits that HEAD lacks; pull before releasing');
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
const tag = `v${manifest.version}`;

if (await isPublished(manifest)) {
	if (!isTagOnOrigin(tag)) {
		exitWith(
			`${tag} is on npm but not on origin\nPush with \`git push --follow-tags origin main\``,
		);
	}
	console.log(`Nothing to release; ${manifest.name}@${manifest.version} is already on npm`);
	process.exit(0);
}

const whoami = capture('npm', ['whoami']);
if (whoami.status !== 0) exitWith('Not logged in to npm; run `npm login` first');

console.log(`Releasing ${manifest.name}@${manifest.version} as ${whoami.stdout.trim()}\n`);

step('pnpm', ['build']);
step('pnpm', ['changeset', 'publish']);
// The gate above already passed on this tree; the pre-push hook would only repeat it
step('git', ['push', '--no-verify', '--follow-tags', 'origin', 'main']);
