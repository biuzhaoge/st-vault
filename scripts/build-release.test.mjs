import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { linkWorkspaceDependencies } from './lib/workspace-dependencies.mjs';
test('includes upstream notices for bundled browser dependencies in the release output', async () => {
  const { build } = await import('vite');
  const outDir = await mkdtemp(path.join(tmpdir(), 'stv-ui-licenses-'));
  try {
    await build({ root: 'apps/ui', logLevel: 'silent', build: { outDir } });
    const notices = await readFile(path.join(outDir, 'assets/third-party-licenses.md'), 'utf8');
    const scheduler = await readFile('node_modules/scheduler/LICENSE', 'utf8');
    assert.match(notices, /^## scheduler - /m);
    assert.ok(notices.includes(scheduler.trim()));
    assert.match(notices, /^## hls\.js - /m);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
test('keeps server request validators out of the initial browser chunk', async () => {
  const { build } = await import('vite');
  const result = await build({ root: 'apps/ui', logLevel: 'silent', build: { write: false } });
  const entry = result.output.find((asset) => asset.type === 'chunk' && asset.isEntry);
  assert.ok(entry, 'the release has a browser entry chunk');
  const modules = Object.keys(entry.modules).map((id) => id.replaceAll('\\', '/'));
  assert.ok(!modules.some((id) => id.includes('/node_modules/zod/')), 'Zod is server-only');
});
test('rejects a malformed release version before building', () => {
  const result = spawnSync(process.execPath, ['scripts/build-release.mjs'], {
    env: { ...process.env, STV_BUILD_VERSION: '0.0.01' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_RELEASE_VERSION/);
});
test('local compiled workspaces resolve nested runtime dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-')),
    output = path.join(root, 'build');
  try {
    const dependency = path.join(root, 'apps/server/node_modules/fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dep', type: 'module', exports: './index.js' }),
    );
    await writeFile(path.join(dependency, 'index.js'), 'export default 42;');
    await mkdir(path.join(output, 'apps/server'), { recursive: true });
    const entry = path.join(output, 'apps/server/entry.mjs');
    await writeFile(entry, "import answer from 'fixture-dep';export default answer;");
    await assert.rejects(import(pathToFileURL(entry).href + '?unlinked'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await linkWorkspaceDependencies(root, output, ['apps/server']);
    assert.equal((await import(pathToFileURL(entry).href)).default, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('hoisted-only workspaces need no generated link', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-'));
  try {
    const output = path.join(root, 'build');
    await linkWorkspaceDependencies(root, output, ['apps/server']);
    await assert.rejects(lstat(path.join(output, 'apps/server/node_modules')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('never replaces an existing build dependency directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-'));
  try {
    const output = path.join(root, 'build');
    await mkdir(path.join(root, 'apps/server/node_modules'), { recursive: true });
    await mkdir(path.join(output, 'apps/server/node_modules'), { recursive: true });
    await assert.rejects(
      linkWorkspaceDependencies(root, output, ['apps/server']),
      /BUILD_DEPENDENCIES_EXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
