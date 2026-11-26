import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSecurityIndex } from './check-debian-security.mjs';

const inventory = 'installed\tlibexample\tamd64\t1:2.0-1~deb12u2\ninstalled\tcommon\tall\t1\n';
const entry = (pkg, arch, version) =>
  `Package: ${pkg}\nArchitecture: ${arch}\nVersion: ${version}\n`;

test('matches native and architecture-independent binaries and honors Debian version ordering', () => {
  const index = [
    entry('libexample', 'amd64', '1:2.0-1~deb12u10'),
    entry('common', 'all', '1'),
    entry('unused', 'amd64', '3'),
  ].join('\n');
  assert.deepEqual(compareSecurityIndex(inventory, index, 'amd64'), {
    installed: 2,
    matched: 2,
    behind: ['libexample:amd64 1:2.0-1~deb12u2 -> 1:2.0-1~deb12u10'],
  });
  assert.deepEqual(
    compareSecurityIndex(inventory.replace('deb12u2', 'deb12u11'), index, 'amd64').behind,
    [],
  );
});

test('rejects missing, nonmatching or wrong-architecture inventory and indexes', () => {
  const index = entry('libexample', 'amd64', '2');
  assert.throws(() => compareSecurityIndex('', index, 'amd64'), /installed packages/);
  assert.throws(() => compareSecurityIndex(inventory, '', 'amd64'), /matches/);
  assert.throws(
    () => compareSecurityIndex(inventory, entry('libexample', 'arm64', '2'), 'amd64'),
    /matches/,
  );
  assert.throws(
    () => compareSecurityIndex(inventory.replace('amd64', 'arm64'), index, 'amd64'),
    /architecture/,
  );
});
