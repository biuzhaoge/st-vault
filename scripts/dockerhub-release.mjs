import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const image = 'biuzhaoge/st-vault';
const github = `https://github.com/${image}`;
const hub = `https://hub.docker.com/v2/repositories/${image}`;

function validateVersion(version) {
  if (typeof version !== 'string' || !versionPattern.test(version))
    throw new Error(`Invalid release version: ${version}`);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');

export function assertSourceTag(version, taggedCommit, commit) {
  if (taggedCommit && taggedCommit !== commit)
    throw new Error(`v${version} already points to ${taggedCommit}. Choose a new version.`);
}

function plan() {
  const commit = git('rev-parse', 'HEAD').trim();
  if (commit !== process.env.GITHUB_SHA) throw new Error('Release source does not match the run');
  const { version } = JSON.parse(read('package.json'));
  releaseNotes(read('docs/CHANGELOG.md'), version);
  const ref = `refs/tags/v${version}`;
  const lines = git('ls-remote', '--tags', 'origin', ref, `${ref}^{}`).trim().split('\n');
  const taggedCommit = lines.at(-1).split('\t')[0];
  assertSourceTag(version, taggedCommit, commit);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Release v${version} from ${commit}`);
}

async function tagDigest(tag) {
  if (tag !== 'latest') validateVersion(tag);
  const response = await fetch(`${hub}/tags/${tag}/`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Docker Hub tag lookup failed (${response.status})`);
  const { digest } = await response.json();
  if (!digestPattern.test(digest)) throw new Error(`Docker Hub tag ${tag} has no index digest`);
  return digest;
}

async function cleanup() {
  const { GITHUB_RUN_ID, DOCKERHUB_TOKEN } = process.env;
  if (!/^\d+$/.test(GITHUB_RUN_ID) || !DOCKERHUB_TOKEN)
    throw new Error('A workflow run ID and Docker Hub token are required');
  const auth = await fetch('https://hub.docker.com/v2/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'biuzhaoge', secret: DOCKERHUB_TOKEN }),
    signal: AbortSignal.timeout(15000),
  });
  if (!auth.ok) throw new Error(`Docker Hub cleanup login failed (${auth.status})`);
  const { access_token: token } = await auth.json();
  if (!token) throw new Error('Docker Hub cleanup login returned no token');
  for (const arch of ['amd64', 'arm64']) {
    const tag = `build-${GITHUB_RUN_ID}-${arch}`;
    const response = await fetch(`${hub}/tags/${tag}/`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`Docker Hub temporary tag ${tag} could not be removed (${response.status})`);
  }
}

function introduction(readme) {
  const intro = /^---\n\n([^\n]+)$/m.exec(readme)?.[1];
  if (!intro) throw new Error('README introduction is missing');
  return intro;
}

export function releaseNotes(changelog, version) {
  validateVersion(version);
  const notes = changelog
    .split(/^## /m)
    .find((entry) => entry.startsWith(`${version}\n`))
    ?.slice(version.length)
    .trim();
  if (!notes) throw new Error(`No release notes for v${version}`);
  return notes;
}

export function renderOverview({ version, chinese, english, compose }) {
  validateVersion(version);
  const content = [
    '# ST-Vault',
    introduction(chinese),
    introduction(english),
    `[简体中文](${github}/blob/main/README.md) · [English](${github}/blob/main/README.en.md) · [更新日志 / Releases](${github}/releases)`,
    `![ST-Vault 工作台 / Workbench](https://raw.githubusercontent.com/${image}/main/docs/assets/screenshots/workbench.png)`,
    '## 部署 / Deploy',
    '将下列内容保存为 `compose.yml`，再执行 `docker compose up -d`。\nSave as `compose.yml`, then run `docker compose up -d`.',
    `\`\`\`yaml\n${compose.trim()}\n\`\`\``,
    `## 当前版本 / Current release · ${version}`,
    `\`${image}:${version}\` · \`linux/amd64\` · \`linux/arm64\``,
    `[查看更新日志 / Release notes](${github}/releases/tag/v${version})`,
  ].join('\n\n');
  if (Buffer.byteLength(content) + 1 > 25000)
    throw new Error('Docker Hub Overview exceeds 25000 bytes');
  return `${content}\n`;
}

async function main() {
  const [command, value] = process.argv.slice(2);
  switch (command) {
    case 'plan':
      plan();
      break;
    case 'tag':
      console.log((await tagDigest(value)) ?? '');
      break;
    case 'notes':
      writeFileSync(value, `${releaseNotes(read('docs/CHANGELOG.md'), process.env.VERSION)}\n`);
      break;
    case 'cleanup':
      await cleanup();
      break;
    case 'overview':
      writeFileSync(
        value,
        renderOverview({
          version: process.env.VERSION,
          chinese: read('README.md'),
          english: read('README.en.md'),
          compose: read('compose.yml'),
        }),
      );
      break;
    default:
      throw new Error('Expected plan, tag, notes, cleanup, or overview');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
