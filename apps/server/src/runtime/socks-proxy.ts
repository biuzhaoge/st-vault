import { buildConnector, Dispatcher1Wrapper, Socks5ProxyAgent } from 'undici';
import { z } from 'zod';
import type { KeyVault } from '../http/key-vault.js';

type ProxyVault = Pick<KeyVault, 'readSealedSecret' | 'writeSealedSecret'>;
export interface SocksProxyView {
  enabled: boolean;
  endpoint: string;
  username: string;
  passwordSet: boolean;
  error?: 'proxy_settings_unavailable';
}

const credentialCharacters = (value: string): boolean =>
  Buffer.byteLength(value, 'utf8') <= 255 && !/[\p{Control}\p{Surrogate}]/u.test(value);

function normalizeEndpoint(value: string): string | null {
  if (!value) return '';
  if (!/^socks5:\/\/[^/?#\\@\s]+\/?$/i.test(value) || !URL.canParse(value)) return null;
  const { hostname, port } = new URL(value);
  // The special HTTP parser supplies standard hostname normalization for this authority.
  if (!hostname || !port || port === '0' || !URL.canParse(`http://${hostname}`)) return null;
  return `socks5://${new URL(`http://${hostname}`).hostname}:${port}`;
}

const proxyInput = z
  .strictObject({
    enabled: z.boolean(),
    endpoint: z
      .string()
      .trim()
      .max(1024)
      .transform((value, ctx) => {
        const endpoint = normalizeEndpoint(value);
        if (endpoint !== null) return endpoint;
        ctx.addIssue({ code: 'custom', message: 'Invalid SOCKS5 proxy endpoint' });
        return z.NEVER;
      }),
    username: z.string().refine(credentialCharacters),
    password: z.string().refine(credentialCharacters).optional(),
  })
  .refine(
    ({ enabled, endpoint, username, password }) =>
      (!enabled || endpoint !== '') && (!username || endpoint !== '') && (!password || !!username),
    { message: 'Incomplete SOCKS5 proxy settings' },
  );

const savedProxy = proxyInput
  .safeExtend({ password: z.string().refine(credentialCharacters) })
  .refine(({ enabled, username, password }) => !enabled || !username || !!password, {
    message: 'SOCKS5 authentication requires a password',
  });

type ProxyConfig = z.output<typeof savedProxy>;
const defaultConfig: ProxyConfig = { enabled: false, endpoint: '', username: '', password: '' };
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

interface Transport {
  agent: Socks5ProxyAgent;
  dispatcher: RequestInit['dispatcher'];
}

function createTransport(value: ProxyConfig): Transport | null {
  if (!value.enabled) return null;
  const url = new URL(value.endpoint);
  // Undici passes the proxy URL's hostname directly to net.connect, whose IPv6 input omits brackets.
  const connector = buildConnector({ timeout: 5000 });
  const agent = new Socks5ProxyAgent(url, {
    username: value.username || undefined,
    password: value.password || undefined,
    ...(url.hostname.startsWith('[') && {
      connect: (options, callback) =>
        connector({ ...options, hostname: options.hostname.slice(1, -1) }, callback),
    }),
  });
  // Node 24's built-in fetch uses the older Undici callback contract.
  const dispatcher = new Dispatcher1Wrapper(agent) as unknown as RequestInit['dispatcher'];
  return { agent, dispatcher };
}

function isLocal(input: Parameters<typeof globalThis.fetch>[0]): boolean {
  const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
  return loopbackHosts.has(url.hostname.replace(/\.$/, ''));
}

/** Owns this app process's proxy override and the lifetime of its route-scoped requests. */
export class SocksProxySettings {
  private queue: Promise<unknown> = Promise.resolve();
  private route = new AbortController();
  private closing?: Promise<void>;
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly vault: ProxyVault,
    private value: ProxyConfig,
    private transport: Transport | null,
    private unavailable = false,
  ) {}

  static async open(vault: ProxyVault): Promise<SocksProxySettings> {
    try {
      const saved = await vault.readSealedSecret('socks-proxy');
      const value = saved === null ? defaultConfig : savedProxy.parse(JSON.parse(saved) as unknown);
      return new SocksProxySettings(vault, value, createTransport(value));
    } catch {
      // Keep the local workbench available without silently opening a direct route.
      return new SocksProxySettings(vault, defaultConfig, null, true);
    }
  }

  get(): SocksProxyView {
    const { enabled, endpoint, username, password } = this.value;
    return {
      enabled,
      endpoint,
      username,
      passwordSet: password.length > 0,
      ...(this.unavailable && { error: 'proxy_settings_unavailable' as const }),
    };
  }

  signal = (): AbortSignal => this.route.signal;

  fetch: typeof globalThis.fetch = async (input, init) => {
    const caller =
      init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
    const signal = caller ? AbortSignal.any([caller, this.signal()]) : this.signal();
    const local = (this.unavailable || this.transport) && isLocal(input);
    if (this.unavailable && !local) throw new Error('PROXY_SETTINGS_UNAVAILABLE');
    const dispatcher = local ? undefined : this.transport?.dispatcher;
    return await globalThis.fetch(input, { ...init, signal, ...(dispatcher && { dispatcher }) });
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async update(input: unknown): Promise<SocksProxyView> {
    if (this.closing) throw new Error('PROXY_SETTINGS_UNAVAILABLE');
    const patch = proxyInput.parse(input);
    const operation = this.queue.then(async () => {
      const sameIdentity =
        patch.endpoint === this.value.endpoint && patch.username === this.value.username;
      const next = savedProxy.parse({
        ...patch,
        password: patch.password ?? (sameIdentity ? this.value.password : ''),
      });
      const sameCredentials = sameIdentity && next.password === this.value.password;
      if (!this.unavailable && sameCredentials && next.enabled === this.value.enabled)
        return this.get();
      const routeChanged =
        this.unavailable ||
        next.enabled !== this.value.enabled ||
        (next.enabled && !sameCredentials);
      if (!routeChanged) {
        await this.persist(next);
        this.value = next;
        return this.get();
      }
      const transport = createTransport(next);
      try {
        await this.persist(next);
      } catch (error) {
        await transport?.agent.destroy();
        throw error;
      }
      const retired = this.transport;
      this.transport = transport;
      this.value = next;
      this.unavailable = false;
      this.changeRoute();
      await retired?.agent.destroy();
      return this.get();
    });
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  private async persist(config: ProxyConfig): Promise<void> {
    const serialized = JSON.stringify(config);
    try {
      await this.vault.writeSealedSecret('socks-proxy', serialized);
    } catch {
      // The catalog may acknowledge a write after committing it.
      const committed = await this.vault.readSealedSecret('socks-proxy').catch(() => null);
      if (committed !== serialized) throw new Error('PROXY_SETTINGS_UNAVAILABLE');
    }
  }

  private changeRoute(): void {
    const previous = this.route;
    this.route = new AbortController();
    previous.abort();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn(JSON.stringify({ event: 'socks_proxy_route_notification_failed' }));
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= this.queue.then(async () => {
      this.listeners.clear();
      this.route.abort();
      await this.transport?.agent.destroy();
    });
    return this.closing;
  }
}
