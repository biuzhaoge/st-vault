/** A request budget covers headers, redirects and every body byte. */
export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  allow: (url: URL) => boolean;
  account?: boolean;
  allowRedirects?: boolean;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly challenge = false,
    readonly contentType?: string,
  ) {
    super(code);
  }
}

export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('cancelled');
}

/** Cancellation also bounds injected asynchronous key lookups that ignore their signal. */
export async function waitFor<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  aborted(signal);
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = (): void => reject(new ProviderError('cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), stopped]);
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new ProviderError('cancelled'));
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

interface RequestSession {
  signal?: AbortSignal;
  cookie?: string;
  authorization?: string;
}

interface ByteRequest extends RequestSession {
  maxBytes?: number;
  media?: boolean;
  range?: boolean;
  /** Return at most maxBytes and cancel the body; only explicit throughput sampling uses this. */
  prefix?: boolean;
}

interface JsonTextRequest extends RequestSession {
  acceptForbidden?: true;
}

interface JsonDeleteRequest {
  signal?: AbortSignal;
  cookie: string;
  body: Record<string, unknown>;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderError('invalid-utf8');
  }
}

export function createHttp(options: HttpOptions): {
  bytes(url: string, config?: ByteRequest): Promise<Uint8Array>;
  text(url: string, signal?: AbortSignal, cookie?: string, authorization?: string): Promise<string>;
  htmlPage(url: string, signal?: AbortSignal): Promise<{ text: string; status: number }>;
  jsonText(url: string, config?: JsonTextRequest): Promise<{ text: string; status: number }>;
  deleteJson(url: string, config: JsonDeleteRequest): Promise<{ text: string; status: number }>;
} {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new ProviderError('invalid-timeout');
  const read = async (
    address: string,
    config: ByteRequest & JsonTextRequest & { deleteBody?: string; htmlPage?: true } = {},
  ): Promise<{ bytes: Uint8Array; status: number }> => {
    aborted(config.signal);
    const deleting = config.deleteBody !== undefined;
    if ((config.cookie || config.authorization) && !options.account)
      throw new ProviderError('anonymous-credentials-denied');
    if (deleting && (!options.account || !config.cookie || options.allowRedirects !== false))
      throw new ProviderError('account-mutation-denied');
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    config.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    let cancelPending: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPending = (): void =>
        reject(new ProviderError(config.signal?.aborted ? 'cancelled' : 'request-deadline'));
      controller.signal.addEventListener('abort', cancelPending, { once: true });
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let url = new URL(address);
      const firstOrigin = url.origin;
      for (let redirects = 0; redirects <= 4; redirects++) {
        if ((config.cookie || config.authorization) && url.origin !== firstOrigin)
          throw new ProviderError('account-redirect-denied');
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          (url.port && url.port !== '443') ||
          !options.allow(url)
        )
          throw new ProviderError('upstream-url-denied');
        const headers: Record<string, string> = {
          Accept: config.htmlPage ? 'text/html' : '*/*',
          'User-Agent': 'ST-Vault/3 public-client',
        };
        if (config.cookie) headers.Cookie = config.cookie;
        if (config.authorization) headers.Authorization = config.authorization;
        if (config.range) headers.Range = 'bytes=0-4095';
        if (deleting) {
          headers.Accept = 'application/json';
          headers['Content-Type'] = 'application/json';
          headers.Origin = url.origin;
        }
        const response = await Promise.race([
          request(url.toString(), {
            method: deleting ? 'DELETE' : 'GET',
            ...(deleting ? { body: config.deleteBody } : {}),
            headers,
            credentials: 'omit',
            redirect: 'manual',
            signal: controller.signal,
          }),
          cancelled,
        ]);
        // Cloudflare access-denied HTML also uses 403. The challenge marker distinguishes it.
        const challenge = response.headers.get('cf-mitigated') === 'challenge';
        if (!challenge && response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          if (options.allowRedirects === false) throw new ProviderError('redirect-denied');
          const location = response.headers.get('location');
          if (!location || redirects === 4) throw new ProviderError('redirect-limit');
          url = new URL(location, url);
          continue;
        }
        const contentType = response.headers.get('content-type') ?? '';
        const jsonResponse = /^application\/json(?:\s*;|$)/i.test(contentType);
        const htmlResponse = /^text\/html(?:\s*;|$)/i.test(contentType);
        const inspectJsonError =
          jsonResponse &&
          ((config.acceptForbidden === true && response.status === 403) ||
            (deleting && response.status === 400));
        // An unavailable room can serve its normal HTML template with a 404 status.
        const inspectHtmlNotFound = config.htmlPage && response.status === 404 && htmlResponse;
        if (challenge || (!response.ok && !inspectJsonError && !inspectHtmlNotFound)) {
          void response.body?.cancel().catch(() => undefined);
          const after = response.headers.get('retry-after');
          const delay =
            after === null
              ? NaN
              : /^\d+$/.test(after)
                ? Number(after) * 1000
                : Date.parse(after) - Date.now();
          throw new ProviderError(
            'upstream-http',
            response.status,
            false,
            Number.isFinite(delay) ? Math.min(30000, Math.max(0, delay)) : undefined,
            challenge,
            contentType.split(';', 1)[0].trim().toLowerCase() || undefined,
          );
        }
        if (config.htmlPage && !htmlResponse) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('invalid-html-content-type', response.status);
        }
        if (config.range && response.status !== 206) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('range-not-supported');
        }
        if (deleting && response.status === 200 && !jsonResponse) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('invalid-json-content-type');
        }
        if (
          config.media &&
          !/^(?:video\/[^;]+|application\/octet-stream)(?:;|$)/i.test(contentType)
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('invalid-media-type');
        }
        const maxBytes = inspectJsonError ? 16 * 1024 : (config.maxBytes ?? 2 * 1024 * 1024);
        const declared = response.headers.get('content-length');
        if (
          declared &&
          (!/^\d+$/.test(declared) || (!config.prefix && Number(declared) > maxBytes))
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('body-too-large');
        }
        if (!response.body) return { bytes: new Uint8Array(), status: response.status };
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const item = await Promise.race([reader.read(), cancelled]);
          if (item.done) break;
          if (config.prefix && length + item.value.byteLength >= maxBytes) {
            chunks.push(item.value.subarray(0, maxBytes - length));
            length = maxBytes;
            await Promise.race([reader.cancel(), cancelled]);
            break;
          }
          length += item.value.byteLength;
          if (length > maxBytes) throw new ProviderError('body-too-large');
          chunks.push(item.value);
        }
        aborted(config.signal);
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { bytes: result, status: response.status };
      }
      throw new ProviderError('redirect-limit');
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted)
        throw new ProviderError(config.signal?.aborted ? 'cancelled' : 'request-deadline');
      throw new ProviderError('upstream-request');
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', cancel);
      if (cancelPending) controller.signal.removeEventListener('abort', cancelPending);
      if (reader) void reader.cancel().catch(() => undefined);
    }
  };
  return {
    bytes: async (url, config) => (await read(url, config)).bytes,
    text: async (url, signal, cookie, authorization) =>
      decodeText((await read(url, { signal, cookie, authorization })).bytes),
    htmlPage: async (url, signal) => {
      const { bytes, status } = await read(url, { signal, htmlPage: true });
      return { text: decodeText(bytes), status };
    },
    jsonText: async (url, config) => {
      const { bytes, status } = await read(url, config);
      return { text: decodeText(bytes), status };
    },
    deleteJson: async (url, { cookie, signal, body }) => {
      const { bytes, status } = await read(url, {
        cookie,
        signal,
        deleteBody: JSON.stringify(body),
        maxBytes: 16 * 1024,
      });
      return { text: decodeText(bytes), status };
    },
  };
}
