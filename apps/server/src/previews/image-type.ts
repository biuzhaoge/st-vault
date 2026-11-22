import { jpeg } from './ffmpeg.js';
import { ProviderError, type createHttp } from '../provider/http.js';

export function missingImageResponse(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.code === 'upstream-item-unavailable' ||
      (error.code === 'upstream-http' && (error.status === 404 || error.status === 410)))
  );
}

/** The static image hosts serve the same immutable preview paths. Route hints
 * affect transport only, so switching hosts never invalidates a cached image. */
export function createPreviewImageReader(http: Pick<ReturnType<typeof createHttp>, 'bytes'>) {
  const mirrors: Record<string, string | undefined> = {
    'static-cdn.strpst.com': 'static-proxy.strpst.com',
    'static-proxy.strpst.com': 'static-cdn.strpst.com',
  };
  const preferred = new Map<string, string>();
  return async (source: string, signal: AbortSignal): Promise<Uint8Array> => {
    const url = new URL(source);
    const origin = url.hostname;
    const read = async (host: string): Promise<Uint8Array> => {
      url.hostname = host;
      const bytes = await http.bytes(url.href, { signal, maxBytes: 512 * 1024 });
      if (!previewImageType(bytes)) throw Error('INVALID_PREVIEW_IMAGE');
      return bytes;
    };
    const first = preferred.get(origin) ?? origin;
    try {
      return await read(first);
    } catch (error) {
      const fallback = mirrors[first];
      if (
        !fallback ||
        signal.aborted ||
        !(error instanceof ProviderError) ||
        !['upstream-request', 'request-deadline'].includes(error.code)
      )
        throw error;
      const bytes = await read(fallback);
      preferred.set(origin, fallback);
      console.info(
        JSON.stringify({
          event: 'preview_image_route_recovered',
          sourceHost: origin,
          routeHost: fallback,
        }),
      );
      return bytes;
    }
  };
}

export type PreviewImageType = 'image/jpeg' | 'image/png' | 'image/webp';
/** Identify bounded raster payloads from bytes, never from a URL or untrusted MIME. */
export function previewImageType(bytes: Uint8Array): PreviewImageType | null {
  if (jpeg(bytes)) return 'image/jpeg';
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
    bytes[12] === 73 &&
    bytes[13] === 72 &&
    bytes[14] === 68 &&
    bytes[15] === 82
  )
    return 'image/png';
  if (
    bytes.length >= 20 &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  ) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      4,
      true,
    );
    if (
      declared + 8 === bytes.length &&
      bytes[12] === 86 &&
      bytes[13] === 80 &&
      bytes[14] === 56 &&
      [32, 76, 88].includes(bytes[15])
    )
      return 'image/webp';
  }
  return null;
}
