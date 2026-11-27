import type { SiteRoutesStatus } from '@st-vault/api-schema';
import { aborted, createHttp, ProviderError } from './http.js';

// Reviewed website origins. Credentials remain restricted to the selected account host.
export const PUBLIC_SITE_ORIGINS = [
  'https://stripchat.com',
  'https://superchat.live',
  'https://aznudelive.com',
  'https://xhamsterlive.com',
  'https://stripchat.global',
  'https://stripchat.org',
  'https://stripchat1.com',
  'https://stripchat3.com',
  'https://stripchat.army',
  'https://stripchat.cam',
  'https://stripchat.dad',
  'https://stripchat.mov',
  'https://stripchat.porn',
  'https://stripchat.webcam',
  'https://stripchatgirls.com',
  'https://stripchatcam.com',
  'https://superchatlive.com',
  'https://cambaddies.com',
  'https://xham.live',
  'https://camsvibes.com',
  'https://freestrip.chat',
  'https://hotchinacams.com',
  'https://rarecams.com',
  'https://primetime-cams.live',
  'https://vrhub.live',
  'https://sexygirlspics.live',
  'https://xmates.com',
  'https://omg.adult',
  'https://myavlive.com',
  'https://mywebcamroom.com',
  'https://stripchats.io',
  'https://stripchat.io',
  'https://topcams.tv',
  'https://spankbanglive.com',
] as const;
// Localized login pages can hold host-only sessions distinct from the root site.
export const ACCOUNT_SITE_ORIGINS = [...PUBLIC_SITE_ORIGINS, 'https://zh.stripchat.com'] as const;
export function accountSiteOrigin(value: string = PUBLIC_SITE_ORIGINS[0]): string {
  if (!(ACCOUNT_SITE_ORIGINS as readonly string[]).includes(value))
    throw new Error('INVALID_ACCOUNT_ORIGIN');
  return value;
}
interface Candidate {
  origin: string;
  client: ReturnType<typeof createHttp>;
  latencyMs: number | null;
  failures: number;
  checkedAtMs: number;
  generation: number;
  testing: boolean;
  error: string | null;
}
interface Options {
  origins?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  observationPeriod?: () => number;
}
const configPath = '/api/front/v3/config/initial-dynamic?requestPath=/';
function verifySiteConfig(text: string): void {
  const body = JSON.parse(text) as { initialDynamic?: unknown };
  if (
    !body.initialDynamic ||
    typeof body.initialDynamic !== 'object' ||
    Array.isArray(body.initialDynamic)
  )
    throw new ProviderError('invalid-upstream-json');
}
function retryable(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    ([
      'upstream-request',
      'request-deadline',
      'invalid-upstream-json',
      'upstream-item-unavailable',
      'upstream-identity-mismatch',
      'invalid-utf8',
      'upstream-url-denied',
      'redirect-limit',
      'body-too-large',
    ].includes(error.code) ||
      (error.code === 'upstream-http' &&
        (error.status === 403 ||
          error.status === 408 ||
          error.status === 425 ||
          error.status === 429 ||
          (error.status ?? 0) >= 500)))
  );
}

function transientAccess(error: string): boolean {
  if (error === 'upstream-request' || error === 'request-deadline' || error === 'site-deadline')
    return true;
  const status = Number(error.split(':')[1]);
  return error.startsWith('upstream-http:') && ([408, 425, 429].includes(status) || status >= 500);
}
/** One account-bound website; anonymous reads never fail over to another host. */
export class SiteRoutes {
  private readonly candidates: Candidate[];
  private readonly controller = new AbortController();
  private selected: string | null = null;
  private binding = new AbortController();
  private access: NonNullable<SiteRoutesStatus['access']>;
  private sequence = 0;
  private accessSequence = 0;
  private bindingSequence = 0;
  private lastObservedPeriod: number | undefined;
  private lastSuccessfulRound?: { period: number; atMs: number };
  private failedRound?: NonNullable<NonNullable<SiteRoutesStatus['access']>['lastFailedRound']> & {
    period: number;
  };
  private transientFailure?: { confirmAfter: number; at: number };
  private lastProbeAtMs: number | null = null;
  private refreshing: Promise<void> | undefined;
  private measurement: AbortController | undefined;
  private probeProgress = { completed: 0, total: 0, failed: 0 };
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  constructor(private readonly options: Options = {}) {
    const origins = [...new Set(options.origins ?? ACCOUNT_SITE_ORIGINS)];
    if (!origins.length || origins.length > 128) throw new Error('INVALID_SITE_ORIGINS');
    this.selected = origins[0];
    this.access = { origin: origins[0], checkedAtMs: null, lastSuccessAtMs: null, error: null };
    this.candidates = origins.map((origin) => {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('INVALID_SITE_ORIGIN');
      return {
        origin,
        client: createHttp({
          fetch: options.fetch,
          timeoutMs: options.timeoutMs ?? 4000,
          allow: (url) => url.origin === origin,
        }),
        latencyMs: null,
        failures: 0,
        checkedAtMs: 0,
        generation: 0,
        testing: false,
        error: null,
      };
    });
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  status(): SiteRoutesStatus {
    const round = this.failedRound;
    return {
      lastProbeAtMs: this.lastProbeAtMs,
      access: {
        ...this.access,
        lastSuccessAtMs: this.lastSuccessfulRound?.atMs ?? this.access.lastSuccessAtMs,
        lastFailedRound: round
          ? { error: round.error, atMs: round.atMs, consecutiveFailures: round.consecutiveFailures }
          : null,
      },
      selectedOrigin: this.selected,
      probing: Boolean(this.refreshing),
      probeProgress: { ...this.probeProgress },
      candidates: this.candidates.map(
        ({ origin, latencyMs, failures, checkedAtMs, testing, error }) => ({
          origin,
          latencyMs: latencyMs === null ? null : Math.round(latencyMs),
          failures,
          checkedAtMs,
          testing,
          error,
        }),
      ),
    };
  }
  activeBinding(): AbortSignal {
    return this.binding.signal;
  }
  configure(origin: string | null): void {
    if (origin !== null && !this.candidates.some((site) => site.origin === origin))
      throw new Error('INVALID_SITE_ORIGIN');
    this.measurement?.abort();
    const next = origin ?? this.candidates[0].origin;
    if (next === this.selected) return;
    this.resetBinding(next);
  }
  resetTransport(): void {
    this.measurement?.abort();
    this.lastProbeAtMs = null;
    this.probeProgress = { completed: 0, total: this.candidates.length, failed: 0 };
    for (const site of this.candidates) {
      site.latencyMs = null;
      site.checkedAtMs = 0;
      site.failures = 0;
      site.testing = false;
      site.error = null;
      site.generation = this.sequence + 1;
    }
    this.resetBinding(this.selected ?? this.candidates[0].origin);
  }
  private resetBinding(next: string): void {
    this.binding.abort();
    this.binding = new AbortController();
    this.bindingSequence = ++this.sequence;
    this.accessSequence = this.bindingSequence;
    this.lastObservedPeriod = undefined;
    this.lastSuccessfulRound = undefined;
    this.failedRound = undefined;
    this.transientFailure = undefined;
    this.access = { origin: next, checkedAtMs: null, lastSuccessAtMs: null, error: null };
    this.selected = next;
    this.changed();
  }

  private fail(
    site: Candidate,
    sequence: number,
    reason: string,
    status?: number,
    probe = false,
  ): void {
    site.generation = sequence;
    site.failures++;
    site.checkedAtMs = this.now();
    site.error = status ? `${reason}:${status}` : reason;
    if (probe)
      console.warn(
        JSON.stringify({ event: 'public_site_failed', origin: site.origin, reason, status }),
      );
  }
  private observeAccess(
    origin: string,
    error: string | null,
    sequence: number,
    period: number,
  ): void {
    if (
      this.controller.signal.aborted ||
      origin !== this.selected ||
      sequence < this.bindingSequence
    )
      return;
    const at = this.now();
    // Independent requests share a heartbeat. One valid response proves the site was
    // reachable in that period; bursts of failures still count as one observation.
    if (this.lastObservedPeriod === undefined || period >= this.lastObservedPeriod) {
      this.lastObservedPeriod = period;
      const previous = this.failedRound;
      if (!error) {
        this.lastSuccessfulRound = { period, atMs: at };
        this.failedRound = undefined;
      } else if (this.lastSuccessfulRound?.period !== period) {
        this.failedRound = {
          period,
          error,
          atMs: at,
          consecutiveFailures:
            (previous?.consecutiveFailures ?? 0) + Number(previous?.period !== period),
        };
      }
    }
    if (sequence < this.accessSequence) return;
    if (
      error &&
      transientAccess(error) &&
      !this.access.error &&
      this.access.lastSuccessAtMs !== null
    ) {
      const first = this.transientFailure;
      // Requests already in flight can all fail during the same short network stall.
      // Confirm with a later admission before invalidating known-good connectivity.
      if (!first) this.transientFailure = { confirmAfter: this.sequence, at };
      if (!first || sequence <= first.confirmAfter || at - first.at < 2000) return;
    }
    this.transientFailure = undefined;
    this.accessSequence = sequence;
    const changed = this.access.checkedAtMs === null || this.access.error !== error;
    this.access = {
      origin,
      error,
      checkedAtMs: at,
      lastSuccessAtMs: error ? this.access.lastSuccessAtMs : at,
    };
    // Timestamp refreshes use the existing heartbeat; only health transitions push an update.
    if (changed) {
      console.info(JSON.stringify({ event: 'site_access_changed', origin, error }));
      this.changed();
    }
  }
  /** A real account request supplies the same connectivity evidence as an anonymous read. */
  beginAccess(origin: string): (error?: unknown) => void {
    const sequence = ++this.sequence;
    const period = this.options.observationPeriod?.() ?? sequence;
    return (error) => {
      if (
        error instanceof ProviderError &&
        error.code === 'upstream-http' &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status) &&
        !error.challenge
      ) {
        this.observeAccess(origin, null, sequence, period);
        return;
      }
      if (error && !retryable(error)) return;
      this.observeAccess(
        origin,
        error instanceof ProviderError
          ? error.challenge
            ? 'upstream-challenge:403'
            : `${error.code}${error.status ? `:${error.status}` : ''}`
          : null,
        sequence,
        period,
      );
    };
  }
  private async attempt<T>(
    site: Candidate,
    path: string,
    decode: (text: string, origin: string) => T,
    signal: AbortSignal,
    probe = false,
    verifyPayload = false,
  ): Promise<T> {
    const sequence = ++this.sequence,
      period = this.options.observationPeriod?.() ?? sequence,
      started = this.now();
    let transportReady = false;
    if (site.failures || probe) site.testing = true;
    try {
      const text = await site.client.text(site.origin + path, signal);
      aborted(signal);
      if (!probe) {
        // Validate the wire response independently of model-specific decoding.
        // A missing/wrong model is not evidence that the website is unreachable.
        try {
          JSON.parse(text);
        } catch {
          throw new ProviderError('invalid-upstream-json');
        }
        if (!verifyPayload) {
          transportReady = true;
          this.observeAccess(site.origin, null, sequence, period);
        }
      }
      let value: T;
      try {
        value = decode(text, site.origin);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('invalid-upstream-json');
      }
      aborted(signal);
      if (!probe && verifyPayload) this.observeAccess(site.origin, null, sequence, period);
      // Order evidence by request admission, not a failure counter: a newer
      // in-flight success can recover, but an older late response cannot overwrite it.
      if (sequence >= site.generation) {
        site.generation = sequence;
        const elapsed = Math.max(1, this.now() - started);
        site.latencyMs =
          probe || site.latencyMs === null ? elapsed : site.latencyMs * 0.75 + elapsed * 0.25;
        site.failures = 0;
        site.checkedAtMs = this.now();
        site.error = null;
      }
      return value;
    } catch (error) {
      const requestRestriction =
        error instanceof ProviderError &&
        !probe &&
        !verifyPayload &&
        ((error.status === 403 && !error.challenge) || error.code === 'upstream-item-unavailable');
      if (!probe && !signal.aborted && requestRestriction)
        this.observeAccess(site.origin, null, sequence, period);
      if (!signal.aborted && retryable(error) && !requestRestriction && !transportReady) {
        if (sequence >= site.generation)
          this.fail(
            site,
            sequence,
            error instanceof ProviderError ? error.code : 'unknown',
            error instanceof ProviderError ? error.status : undefined,
            probe,
          );
        if (!probe)
          this.observeAccess(
            site.origin,
            error instanceof ProviderError && error.challenge
              ? 'upstream-challenge:403'
              : error instanceof ProviderError
                ? `${error.code}${error.status ? `:${error.status}` : ''}`
                : 'upstream-request',
            sequence,
            period,
          );
      }
      throw error;
    } finally {
      site.testing = false;
      if (probe) this.changed();
    }
  }
  async read<T>(
    path: string,
    decode: (text: string, origin: string) => T,
    signal?: AbortSignal,
    verifyPayload = false,
  ): Promise<T> {
    if (!path.startsWith('/api/front/') || path.includes('\\') || path.includes('#'))
      throw new ProviderError('upstream-url-denied');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 8000);
    const binding = this.binding.signal;
    const stopped = AbortSignal.any([
      this.controller.signal,
      binding,
      ...(signal ? [signal] : []),
      deadline.signal,
    ]);
    try {
      aborted(stopped);
      const site = this.candidates.find((candidate) => candidate.origin === this.selected)!;
      try {
        return await this.attempt(site, path, decode, stopped, false, verifyPayload);
      } catch (error) {
        if (stopped.aborted)
          throw new ProviderError(
            signal?.aborted || this.controller.signal.aborted || binding.aborted
              ? 'cancelled'
              : 'site-deadline',
          );
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async recheck(): Promise<void> {
    if (this.access.error === 'upstream-http:429') return;
    await this.read(configPath, verifySiteConfig, undefined, true);
  }
  /** Explicit pre-login measurements only; results never select a website. */
  probe(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (this.controller.signal.aborted) return Promise.resolve();
    const measurement = (this.measurement = new AbortController());
    const signal = AbortSignal.any([this.controller.signal, measurement.signal]);
    const candidates = this.candidates;
    this.lastProbeAtMs = this.now();
    const progress = (this.probeProgress = { completed: 0, total: candidates.length, failed: 0 });
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < candidates.length && !signal.aborted) {
        const site = candidates[index++];
        try {
          await this.attempt(site, configPath, verifySiteConfig, signal, true);
        } catch (error) {
          if (!signal.aborted) progress.failed++;
          if (!signal.aborted && !retryable(error))
            console.warn(
              JSON.stringify({
                event: 'public_site_probe_failed',
                origin: site.origin,
                reason: error instanceof ProviderError ? error.code : 'unknown',
              }),
            );
        } finally {
          progress.completed++;
          this.changed();
        }
      }
    };
    this.refreshing = Promise.all([worker(), worker()])
      .then(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
        this.measurement = undefined;
        this.changed();
      });
    this.changed();
    return this.refreshing;
  }
  close(): void {
    this.controller.abort();
    this.listeners.clear();
  }
}
