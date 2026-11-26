import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function output(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function compareSecurityIndex(inventory, index, architecture) {
  const installed = new Map();
  for (const line of inventory.trimEnd().split('\n')) {
    const [status, name, arch, version] = line.split('\t');
    if (status !== 'installed') continue;
    if (arch !== architecture && arch !== 'all')
      throw Error(`Unsupported installed architecture: ${arch}`);
    if (!name || !version) throw Error('Incomplete installed package record');
    installed.set(`${name}:${arch}`, version);
  }
  if (!installed.size) throw Error('No installed packages in the runtime inventory');
  const matched = new Set();
  const behind = [];
  for (const record of index.trimEnd().split(/\n\n+/)) {
    const name = /^Package: (\S+)$/m.exec(record)?.[1];
    const arch = /^Architecture: (\S+)$/m.exec(record)?.[1];
    const key = `${name}:${arch}`;
    if (!installed.has(key)) continue;
    const available = /^Version: (\S+)$/m.exec(record)?.[1];
    if (!available) throw Error(`No published version for ${key}`);
    matched.add(key);
    const current = installed.get(key);
    const compare = spawnSync('dpkg', ['--compare-versions', current, 'lt', available], {
      encoding: 'utf8',
    });
    if (compare.error) throw compare.error;
    if (compare.status === 0) behind.push(`${key} ${current} -> ${available}`);
    else if (compare.status !== 1)
      throw Error(`dpkg version comparison failed for ${key}: ${compare.stderr}`);
  }
  if (!matched.size) throw Error('No installed package matches the verified security index');
  return { installed: installed.size, matched: matched.size, behind: behind.sort() };
}

function check(mirror) {
  const os = readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=debian$/m.test(os)) throw Error('Expected a Debian runtime');
  const suite = /^VERSION_CODENAME=([a-z][a-z0-9]+)$/m.exec(os)?.[1];
  if (!suite) throw Error('Missing Debian suite');
  const architecture = output('dpkg', ['--print-architecture']).trim();
  const root = mkdtempSync(path.join(tmpdir(), 'stv-security-'));
  try {
    chmodSync(root, 0o755);
    const lists = path.join(root, 'lists');
    mkdirSync(lists);
    const sources = path.join(root, 'sources.list');
    // File mirrors are for replaying signed Debian indexes offline. APT still verifies them.
    const url = mirror
      ? pathToFileURL(path.resolve(mirror)).href
      : 'https://deb.debian.org/debian-security';
    writeFileSync(
      sources,
      `deb [arch=${architecture} signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] ${url} ${suite}-security main\n`,
    );
    const apt = [
      '-o',
      `Dir::Etc::sourcelist=${sources}`,
      '-o',
      'Dir::Etc::sourceparts=-',
      '-o',
      `Dir::State::lists=${lists}`,
      '-o',
      'Acquire::Languages=none',
      '-o',
      'Acquire::https::Timeout=20',
    ];
    // An empty cache and --error-on=any prevent failed refreshes from becoming a successful scan.
    execFileSync('apt-get', [...apt, 'update', '--error-on=any'], { stdio: 'inherit' });
    const indexFile = output('apt-get', [
      ...apt,
      'indextargets',
      '--format',
      '$(FILENAME)',
      'Created-By: Packages',
      `Codename: ${suite}-security`,
      'Label: Debian-Security',
      `Architecture: ${architecture}`,
    ]).trim();
    if (!indexFile || indexFile.includes('\n'))
      throw Error('Expected exactly one signed native Debian Security package index');
    const index = output('/usr/lib/apt/apt-helper', ['cat-file', indexFile]);
    console.log(
      `Verified ${suite}-security main/${architecture} Packages SHA256 ${createHash('sha256').update(index).digest('hex')}`,
    );
    const inventory = output('dpkg-query', [
      '-W',
      '-f=${db:Status-Status}\t${Package}\t${Architecture}\t${Version}\n',
    ]);
    const result = compareSecurityIndex(inventory, index, architecture);
    console.log(
      `${suite}-security main/${architecture}: ${result.installed} installed, ${result.matched} present in security index, ${result.behind.length} behind`,
    );
    if (result.behind.length)
      throw Error(`Published security package updates:\n${result.behind.join('\n')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) check(process.argv[2]);
