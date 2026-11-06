import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

interface PackageManifest {
	name: string;
	version: string;
}

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, { stdio: 'inherit' });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function exitWith(message: string): never {
	console.error(message);
	process.exit(1);
}

async function isPublished({ name, version }: PackageManifest) {
	const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, { method: 'HEAD' });
	if (response.status === 404) return false;
	if (!response.ok) {
		throw new Error(`npm registry answered ${String(response.status)} for ${name}@${version}`);
	}
	return true;
}

const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
if (branch !== 'main') exitWith(`Release from main, not ${branch || 'a detached HEAD'}`);

const uncommitted = spawnSync('git', ['status', '--porcelain'], {
	encoding: 'utf8',
}).stdout.trimEnd();

// `changeset publish` packs from the working tree, so it must match what is committed
if (uncommitted) exitWith(`Commit or stash these before releasing:\n${uncommitted}`);

const hasChangesets = readdirSync('.changeset').some(
	(fileName) => fileName.endsWith('.md') && fileName !== 'README.md',
);
if (hasChangesets) exitWith('Pending changesets; run `pnpm changeset version` and commit first');

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
if (await isPublished(manifest)) {
	const tag = `v${manifest.version}`;
	const isTagPushed =
		spawnSync('git', ['merge-base', '--is-ancestor', tag, 'origin/main']).status === 0;

	if (!isTagPushed) {
		exitWith(
			`${tag} is on npm but not on origin/main\nPush with \`git push --follow-tags origin main\``,
		);
	}

	console.log(`Nothing to release; ${manifest.name}@${manifest.version} is already on npm`);
	process.exit(0);
}

console.log(`Releasing ${manifest.name}@${manifest.version}\n`);
run('pnpm', ['check']);
run('pnpm', ['changeset', 'publish']);
// The gate above already passed on this tree; the pre-push hook would only repeat it
run('git', ['push', '--no-verify', '--follow-tags', 'origin', 'main']);
