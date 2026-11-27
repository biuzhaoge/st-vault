import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { SocksProxySettings } from './socks-proxy.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  let sealed: string | null = null;
  return {
    readSealedSecret: vi.fn((purpose: 'socks-proxy') => {
      expect(purpose).toBe('socks-proxy');
      return Promise.resolve(sealed);
    }),
    writeSealedSecret: vi.fn((purpose: 'socks-proxy', value: string | null) => {
      expect(purpose).toBe('socks-proxy');
      sealed = value;
      return Promise.resolve();
    }),
  };
}

async function settings(vault = fixture()): Promise<SocksProxySettings> {
  const value = await SocksProxySettings.open(vault);
  cleanup.push(() => value.close());
  return value;
}

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

it('stores private credentials, returns a safe view, and restores validated settings on open', async () => {
  const vault = fixture();
  const proxy = await settings(vault);
  expect(proxy.get()).toEqual({ enabled: false, endpoint: '', username: '', passwordSet: false });
  expect(
    await proxy.update({
      enabled: true,
      endpoint: 'socks5://127.0.0.1:31337/',
      username: 'fixture-user',
      password: 'fixture-password',
    }),
  ).toEqual({
    enabled: true,
    endpoint: 'socks5://127.0.0.1:31337',
    username: 'fixture-user',
    passwordSet: true,
  });
  expect(vault.writeSealedSecret).toHaveBeenCalledWith('socks-proxy', expect.any(String));
  expect(JSON.stringify(proxy.get())).not.toContain('fixture-password');
  await proxy.close();
  const restored = await settings(vault);
  expect(restored.get()).toEqual(proxy.get());
  expect(
    await restored.update({
      enabled: false,
      endpoint: proxy.get().endpoint,
      username: 'fixture-user',
    }),
  ).toMatchObject({ enabled: false, passwordSet: true });
  expect(
    await restored.update({ enabled: false, endpoint: proxy.get().endpoint, username: 'renamed' }),
  ).toMatchObject({ passwordSet: false });
  await restored.update({
    enabled: false,
    endpoint: proxy.get().endpoint,
    username: 'renamed',
    password: 'new',
  });
  expect(
    await restored.update({
      enabled: false,
      endpoint: proxy.get().endpoint,
      username: 'renamed',
      password: '',
    }),
  ).toMatchObject({ passwordSet: false });
});

it.each([
  { enabled: true, endpoint: '' },
  { enabled: true, endpoint: 'http://127.0.0.1:1080' },
  { enabled: true, endpoint: 'socks5://user:password@127.0.0.1:8080' },
  { enabled: true, endpoint: 'socks5://localhost:1080/path' },
  { enabled: false, endpoint: 'socks5://localhost:1080/?' },
  { enabled: false, endpoint: 'socks5://localhost:1080/no/..' },
  { enabled: true, endpoint: 'socks5://127.0.0.1:0' },
  { enabled: true, endpoint: 'socks5://127.0.0.1' },
  { enabled: false, endpoint: '', username: 'fixture' },
  { enabled: true, endpoint: 'socks5://localhost:8000', username: 'fixture', password: '\n' },
  { enabled: true, endpoint: 'socks5://localhost:8000', username: 'fixture' },
  { enabled: true, endpoint: 'socks5://localhost:8000', password: 'missing-user' },
  {
    enabled: true,
    endpoint: 'socks5://localhost:8000',
    username: 'fixture',
    password: '密'.repeat(86),
  },
  { enabled: false, endpoint: 'socks5://localhost:8000', unrelated: true },
])('rejects unsafe or incomplete settings without persisting: %j', async (patch) => {
  const vault = fixture();
  const proxy = await settings(vault);
  await expect(proxy.update({ username: '', ...patch })).rejects.toMatchObject({
    name: 'ZodError',
  });
  expect(vault.writeSealedSecret).not.toHaveBeenCalled();
});

it('cancels requests from an old route only after a successful settings change', async () => {
  const target = createServer();
  const targetPort = await listen(target);
  const vault = fixture();
  const proxy = await settings(vault);
  const observer = vi.fn();
  const unsubscribe = proxy.subscribe(observer);
  const firstRoute = proxy.signal();
  const received = new Promise<void>((resolve) => target.once('request', () => resolve()));
  const request = proxy.fetch(`http://127.0.0.1:${targetPort}`, {
    signal: AbortSignal.timeout(3000),
  });
  const aborted = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await received;
  const next = { enabled: true, endpoint: 'socks5://127.0.0.1:31337', username: '' };
  vault.writeSealedSecret.mockRejectedValueOnce(new Error('fixture write failure'));
  await expect(proxy.update(next)).rejects.toThrow('PROXY_SETTINGS_UNAVAILABLE');
  expect(firstRoute.aborted).toBe(false);
  expect(proxy.get().enabled).toBe(false);
  expect(observer).not.toHaveBeenCalled();
  await proxy.update(next);
  expect(firstRoute.aborted).toBe(true);
  expect(proxy.signal()).not.toBe(firstRoute);
  expect(observer).toHaveBeenCalledTimes(1);
  await aborted;
  unsubscribe();
});

it('keeps local requests available and requires an explicit save if the stored proxy is unreadable', async () => {
  const vault = fixture();
  vault.readSealedSecret.mockRejectedValueOnce(new Error('fixture corrupted envelope'));
  const target = createServer((_request, response) => response.end('local fixture'));
  const targetPort = await listen(target);
  const proxy = await settings(vault);
  expect(proxy.get()).toEqual({
    enabled: false,
    endpoint: '',
    username: '',
    passwordSet: false,
    error: 'proxy_settings_unavailable',
  });
  expect(await (await proxy.fetch(`http://127.0.0.1:${targetPort}`)).text()).toBe('local fixture');
  await expect(proxy.fetch('http://fixture.invalid')).rejects.toThrow('PROXY_SETTINGS_UNAVAILABLE');
  const route = proxy.signal();
  expect(await proxy.update({ enabled: false, endpoint: '', username: '' })).not.toHaveProperty(
    'error',
  );
  expect(vault.writeSealedSecret).toHaveBeenCalledTimes(1);
  expect(route.aborted).toBe(true);
});

function proxyFixture(routes: Map<string, number>, auth: boolean) {
  const connections: string[] = [];
  const credentials: { username: string; password: string }[] = [];
  const server = createNetServer((socket) => {
    let step = 0;
    let pending = Buffer.alloc(0);
    const receive = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      if (step === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        const method = auth ? 2 : 0;
        if (pending[0] !== 5 || !pending.subarray(2).includes(method)) {
          socket.end(Buffer.from([5, 255]));
          return;
        }
        pending = pending.subarray(2 + pending[1]);
        step = auth ? 1 : 2;
        socket.write(Buffer.from([5, method]));
      }
      if (step === 1) {
        if (pending.length < 2) return;
        const endUser = 2 + pending[1];
        if (pending.length <= endUser || pending.length <= endUser + pending[endUser]) return;
        const endPassword = endUser + 1 + pending[endUser];
        credentials.push({
          username: pending.toString('utf8', 2, endUser),
          password: pending.toString('utf8', endUser + 1, endPassword),
        });
        pending = pending.subarray(endPassword);
        step = 2;
        socket.write(Buffer.from([1, 0]));
      }
      if (pending.length < 5) return;
      const ipv4 = pending[3] === 1;
      const endAddress = ipv4 ? 8 : 5 + pending[4];
      if (pending.length < endAddress + 2) return;
      const hostname = ipv4
        ? [...pending.subarray(4, 8)].join('.')
        : pending.toString('utf8', 5, endAddress);
      const authority = `${hostname}:${pending.readUInt16BE(endAddress)}`;
      connections.push(authority);
      socket.removeListener('data', receive);
      const port = routes.get(authority);
      if (!port) {
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const peer = connect(port, '127.0.0.1');
      peer.once('connect', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (pending.length > endAddress + 2) peer.write(pending.subarray(endAddress + 2));
        socket.pipe(peer).pipe(socket);
      });
      socket.once('close', () => peer.destroy());
      peer.once('error', (error) => socket.destroy(error));
    };
    socket.on('data', receive);
  });
  return { server, connections, credentials };
}

it('tunnels two origins, delegates their DNS names, and keeps credentials on the proxy handshake', async () => {
  const originAuth: (string | undefined)[] = [];
  const target = createServer((request, response) => {
    originAuth.push(request.headers['proxy-authorization']);
    response.end('origin fixture');
  });
  const targetPort = await listen(target);
  const anotherPort = await listen(
    createServer((_request, response) => response.end('another fixture')),
  );
  const one = `fixture.invalid:${targetPort}`;
  const two = `another.invalid:${anotherPort}`;
  const { server, connections, credentials } = proxyFixture(
    new Map([
      [one, targetPort],
      [two, anotherPort],
    ]),
    true,
  );
  const proxyPort = await listen(server);
  const proxy = await settings();
  const username = '样例%user';
  const password = 'pwd%25:!?';
  await proxy.update({
    enabled: true,
    endpoint: `socks5://127.0.0.1:${proxyPort}`,
    username,
    password,
  });
  const throughProxy = await proxy.fetch(`http://${one}`, {
    signal: AbortSignal.timeout(3000),
  });
  expect(await throughProxy.text()).toBe('origin fixture');
  expect(originAuth).toEqual([undefined]);
  const otherResponse = await proxy.fetch(
    new Request(`http://${two}`, { signal: AbortSignal.timeout(3000) }),
  );
  expect(await otherResponse.text()).toBe('another fixture');
  expect(connections).toEqual([one, two]);
  expect(credentials).toEqual([
    { username, password },
    { username, password },
  ]);
  const loopback = await proxy.fetch(`http://127.0.0.1:${targetPort}`, {
    signal: AbortSignal.timeout(3000),
  });
  expect(await loopback.text()).toBe('origin fixture');
  expect(connections).toHaveLength(2);
});

it('preserves HTTPS certificate validation through the proxy and does not retry direct on proxy rejection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stv-socks-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'fixture.key');
  const cert = path.join(directory, 'fixture.crt');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=secure.invalid',
    '-addext',
    'subjectAltName=DNS:secure.invalid',
    '-days',
    '1',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  const tlsOrigin = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) });
  const tlsPort = await listen(tlsOrigin);
  let directRequests = 0;
  const direct = createServer((_request, response) => {
    directRequests++;
    response.end('direct fixture');
  });
  const directPort = await listen(direct, '127.0.0.2');
  const tlsAuthority = `secure.invalid:${tlsPort}`;
  const { server, connections } = proxyFixture(new Map([[tlsAuthority, tlsPort]]), false);
  const proxyPort = await listen(server, '::1');
  const proxy = await settings();
  await proxy.update({ enabled: true, endpoint: `socks5://[::1]:${proxyPort}`, username: '' });
  await expect(
    proxy.fetch(`https://${tlsAuthority}`, { signal: AbortSignal.timeout(3000) }),
  ).rejects.toMatchObject({ cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
  await expect(
    proxy.fetch(`http://127.0.0.2:${directPort}`, { signal: AbortSignal.timeout(3000) }),
  ).rejects.toThrow();
  expect(connections).toEqual([tlsAuthority, `127.0.0.2:${directPort}`]);
  expect(directRequests).toBe(0);
});
