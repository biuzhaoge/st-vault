import { createHttp, ProviderError } from './http.js';
import { ACCOUNT_SITE_ORIGINS } from './site-routes.js';

type NoticeField = 'heading' | 'description';
type Notice = Partial<Record<NoticeField, string>>;
interface Element {
  name: string;
  hidden: boolean;
  notice?: Notice;
  noticeRoot?: true;
  field?: NoticeField;
  text?: string[];
  camPage?: true;
  camContainer?: true;
}

const roomHandle = /^[a-z0-9_-]{1,200}$/i;
const disabledPhrases = [
  { heading: /^账户(?:已)?被禁用[。.]?$/, description: /^([a-z0-9_-]+)\s*的账户已被禁用[。.]?$/i },
  {
    heading: /^Account Disabled$/i,
    description: /^([a-z0-9_-]+)'s account has been disabled\.?$/i,
  },
];
const rawText = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
]);
const inert = new Set(['head', 'template', 'noscript', 'nav', 'header', 'footer', 'svg']);
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, name, double, single, bare] of source.matchAll(
    /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g,
  )) {
    const key = name.toLowerCase();
    if (!result.has(key)) result.set(key, double ?? single ?? bare ?? '');
  }
  return result;
}

function visibleText(source: string): string {
  return source
    .replace(
      /&(?:nbsp|apos|#(\d+)|#x([a-f\d]+));/gi,
      (entity: string, decimal?: string, hex?: string) => {
        if (!decimal && !hex) return entity.toLowerCase() === '&apos;' ? "'" : ' ';
        const point = Number.parseInt(decimal ?? hex ?? '', decimal ? 10 : 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesNotice({ heading, description }: Notice, handle: string): boolean {
  return Boolean(
    heading &&
    description &&
    disabledPhrases.some(
      (phrase) =>
        phrase.heading.test(heading) &&
        phrase.description.exec(description)?.[1].toLowerCase() === handle,
    ),
  );
}

/** A missing template is inconclusive without positive evidence of an ordinary room. */
function roomPageEvidence(
  { text: html, status }: { text: string; status: number },
  handle: string,
  canonicalRoom: (href: string) => boolean,
  onScript?: (source: string) => void,
): boolean | undefined {
  const stack: Element[] = [];
  let canonical: boolean | undefined;
  let hasCamContainer = false;
  let hasDisabledNotice = false;
  let hasUnknownNotice = false;
  let openNoticeCount = 0;
  const tokens =
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-z][\w:-]*)([^"'><]*(?:(?:"[^"]*"|'[^']*')[^"'><]*)*)>|([^<]+)|</gi;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(html)) !== null) {
    const [, close, tag, source, words] = token;
    const parent = stack.at(-1);
    if (!tag) {
      if (words && !parent?.hidden) parent?.text?.push(words);
      continue;
    }
    const name = tag.toLowerCase();
    if (close) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== name) {
        if (stack[index].hidden && !stack[index - 1]?.hidden) break;
        index--;
      }
      if (index < 0 || stack[index].name !== name) continue;
      const element = stack[index];
      stack.length = index;
      if (element.field && element.notice && element.text)
        element.notice[element.field] = visibleText(element.text.join(''));
      if (element.noticeRoot && element.notice) {
        openNoticeCount--;
        if (matchesNotice(element.notice, handle)) hasDisabledNotice = true;
        else hasUnknownNotice = true;
      }
      if (element.camContainer) hasCamContainer = true;
      continue;
    }
    if (name === 'plaintext') return undefined;
    if (rawText.has(name)) {
      const end = new RegExp('</' + name + '\\s*>', 'gi');
      end.lastIndex = tokens.lastIndex;
      const closingTag = end.exec(html);
      if (!closingTag) return undefined;
      if (
        onScript &&
        name === 'script' &&
        (!parent?.hidden || (parent.name === 'head' && stack.at(-2)?.name === 'html'))
      ) {
        const attrs = attributes(source);
        const type = attrs.get('type')?.trim().toLowerCase();
        if (!attrs.has('src') && (!type || type === 'text/javascript'))
          onScript(html.slice(tokens.lastIndex, closingTag.index));
      }
      tokens.lastIndex = end.lastIndex;
      continue;
    }
    if (name === 'link' && parent?.name === 'head' && stack.at(-2)?.name === 'html') {
      const attrs = attributes(source);
      if (attrs.get('rel')?.toLowerCase().split(/\s+/).includes('canonical'))
        canonical = canonical !== false && canonicalRoom(attrs.get('href') ?? '');
    }
    if (voidElements.has(name)) continue;
    if (stack.length >= 128) return undefined;
    const attrs = attributes(source);
    const hidden =
      parent?.hidden === true ||
      inert.has(name) ||
      attrs.has('hidden') ||
      attrs.get('aria-hidden')?.trim().toLowerCase() === 'true' ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i.test(
        attrs.get('style') ?? '',
      );
    const classes = attrs.get('class')?.split(/\s+/) ?? [];
    const element: Element = {
      name,
      hidden,
      notice: parent?.notice,
      text: parent?.text,
      camPage: parent?.camPage,
    };
    if (name === 'div' && !hidden) {
      if (classes.includes('view-cam-page')) element.camPage = true;
      if (parent?.camPage && classes.includes('view-cam-container')) element.camContainer = true;
      if (classes.includes('deleted-wrapper')) {
        openNoticeCount++;
        element.noticeRoot = true;
        element.notice = {};
        element.text = undefined;
      } else if (element.notice) {
        if (classes.includes('account-disabled-header')) element.field = 'heading';
        if (classes.includes('account-disabled-description')) element.field = 'description';
        if (element.field) element.text = [];
      }
    }
    if (/\/\s*$/.test(source) && (parent?.hidden === true || name === 'svg')) continue;
    stack.push(element);
  }
  if (
    canonical === false ||
    hasUnknownNotice ||
    (hasDisabledNotice && hasCamContainer) ||
    openNoticeCount !== 0
  )
    return undefined;
  if (hasDisabledNotice) return true;
  return status === 200 && canonical === true && hasCamContainer ? false : undefined;
}

function createRoomPageReader(origin: string, fetch?: typeof globalThis.fetch, timeoutMs?: number) {
  const bound = new URL(origin);
  if (
    bound.protocol !== 'https:' ||
    bound.username ||
    bound.password ||
    bound.port ||
    bound.pathname !== '/' ||
    bound.search ||
    bound.hash
  )
    throw new ProviderError('invalid-room-origin');
  const boundOrigin = bound.origin;
  // The root .mov room can return a generic 404 for a room with a localized notice.
  const pageOrigin =
    boundOrigin === 'https://stripchat.mov' ? 'https://zh.stripchat.mov' : boundOrigin;
  // These locale redirects serve the same public room. The HTML read carries no credentials.
  const origins = new Set([boundOrigin]);
  if ((ACCOUNT_SITE_ORIGINS as readonly string[]).includes(boundOrigin)) {
    origins.add('https://stripchat.com');
    origins.add('https://zh.stripchat.com');
    origins.add('https://zh.stripchat.mov');
  }
  return async (handle: string, signal?: AbortSignal, onScript?: (source: string) => void) => {
    if (!roomHandle.test(handle)) throw new ProviderError('invalid-room-handle');
    const expected = '/' + handle.toLowerCase();
    const allowRoom = (url: URL): boolean => {
      if (!origins.has(url.origin) || url.username || url.password || url.search || url.hash)
        return false;
      try {
        return decodeURIComponent(url.pathname).toLowerCase() === expected;
      } catch {
        return false;
      }
    };
    const http = createHttp({ fetch, timeoutMs, allow: allowRoom });
    const page = await http.htmlPage(pageOrigin + '/' + handle, signal);
    return roomPageEvidence(
      page,
      handle.toLowerCase(),
      (href) => {
        if (!href.trim()) return false;
        try {
          return allowRoom(new URL(href, pageOrigin));
        } catch {
          return false;
        }
      },
      onScript,
    );
  };
}

export function createDisabledPageProbe(
  origin: string,
  fetch?: typeof globalThis.fetch,
  timeoutMs?: number,
): (handle: string, signal?: AbortSignal) => Promise<boolean | undefined> {
  return createRoomPageReader(origin, fetch, timeoutMs);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  return undefined;
}

function roomPlayerAvailable(payload: string, providerId: number, handle: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim().replace(/;$/, ''));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const state = jsonObject(parsed);
  const viewCam = jsonObject(state?.viewCam);
  const model = jsonObject(viewCam?.model);
  const config = jsonObject(jsonObject(state?.configV3)?.dynamic);
  const ageVerification = jsonObject(config?.ageVerification);
  return (
    model?.id === providerId &&
    typeof model.username === 'string' &&
    model.username.toLowerCase() === handle.toLowerCase() &&
    viewCam?.playerIsAvailable === true &&
    viewCam.isGeoBanned !== true &&
    viewCam.isGeoRestricted !== true &&
    model.isGeoBanned !== true &&
    model.isGeoRestricted !== true &&
    ageVerification?.isGeoRestricted !== true
  );
}

export function createRoomAccessProbe(
  origin: string,
  fetch?: typeof globalThis.fetch,
  timeoutMs?: number,
): (handle: string, providerId: number, signal?: AbortSignal) => Promise<boolean> {
  const readRoomPage = createRoomPageReader(origin, fetch, timeoutMs);
  return async (handle, providerId, signal) => {
    if (!Number.isSafeInteger(providerId) || providerId <= 0) return false;
    let bootState: string | undefined;
    let conflictingState = false;
    const ordinaryRoom = await readRoomPage(handle, signal, (source) => {
      const assignment = /^\s*window\.__PRELOADED_STATE__\s*=([\s\S]*)$/.exec(source);
      if (!assignment) return;
      if (bootState !== undefined) conflictingState = true;
      bootState = assignment[1];
    });
    return (
      ordinaryRoom === false &&
      !conflictingState &&
      bootState !== undefined &&
      roomPlayerAvailable(bootState, providerId, handle)
    );
  };
}
