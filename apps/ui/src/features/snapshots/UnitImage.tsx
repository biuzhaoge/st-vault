import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { snapshotImages, ImagePendingError } from '../../shared/lib/image-loader';
import { snapshotSeen } from './snapshot-seen';
export const UnitImage = memo(function UnitImage({
  src,
  subjectId,
  unitId,
  toMs,
}: {
  src: string;
  subjectId: string;
  unitId: string;
  toMs: number;
}): JSX.Element | null {
  // Unit identity stays fixed while its coverage grows. Decode new images
  // independently; metadata and neighboring pictures never wait for this one.
  const node = useRef<HTMLSpanElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const boundary = useRef(toMs);
  useLayoutEffect(() => {
    boundary.current = toMs;
  }, [toMs]);
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Proximity admits the initial load; layout/FLIP movement must not
        // discard a decoded image. Virtualization owns eviction on unmount.
        setAdmitted(true);
        observer.disconnect();
      },
      { root: node.current.closest('.snapshot-grid'), rootMargin: '240px' },
    );
    observer.observe(node.current);
    return () => observer.disconnect();
  }, []);
  const [image, setImage] = useState<{ src: string; url: string } | null>(null);
  const ownedUrls = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of ownedUrls.current) URL.revokeObjectURL(url);
      ownedUrls.current.clear();
    },
    [],
  );
  useEffect(
    () => () => {
      if (image?.url) {
        URL.revokeObjectURL(image.url);
        ownedUrls.current.delete(image.url);
      }
    },
    [image?.url],
  );
  useEffect(() => {
    if (!admitted) return;
    const controller = new AbortController();
    let url = '',
      retry: number | undefined,
      failures = 0;
    const run = async () => {
      try {
        const blob = await snapshotImages.load(src, controller.signal, 'visible', 30 * 60000);
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        ownedUrls.current.add(url);
        const bitmap = new Image();
        bitmap.src = url;
        await bitmap.decode();
        if (!controller.signal.aborted) {
          setImage({ src, url });
          url = '';
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (!(error instanceof ImagePendingError)) snapshotImages.invalidate(src);
          if (!(error instanceof ImagePendingError) && !failures)
            console.warn('Snapshot download failed; retrying', error);
          const delay =
            error instanceof ImagePendingError
              ? error.retryAfterMs
              : Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
          retry = window.setTimeout(() => {
            if (!controller.signal.aborted) {
              void run();
            }
          }, delay);
        }
      } finally {
        if (url) {
          URL.revokeObjectURL(url);
          ownedUrls.current.delete(url);
          url = '';
        }
      }
    };
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, admitted]);

  const currentUrl = image?.src === src ? image.url : undefined;
  useEffect(() => {
    const target = picture.current;
    if (!target || !currentUrl) return;
    let reported = false;
    // The viewport root includes all ancestor clipping, including the gallery
    // during page transitions. Only observe after the DOM image has loaded.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (
          reported ||
          document.visibilityState !== 'visible' ||
          !target.isConnected ||
          target.src !== currentUrl ||
          target.currentSrc !== currentUrl ||
          !entry?.isIntersecting ||
          entry.intersectionRect.width <= 0 ||
          entry.intersectionRect.height <= 0 ||
          getComputedStyle(target).visibility !== 'visible'
        )
          return;
        stop();
        snapshotSeen.loaded(subjectId, unitId, boundary.current);
      },
      // A positive threshold distinguishes actual pixels from edge contact.
      { threshold: Number.EPSILON },
    );
    const observe = (): void => {
      observer.unobserve(target);
      observer.takeRecords();
      if (document.visibilityState === 'visible' && target.complete && target.naturalWidth > 0)
        observer.observe(target);
    };
    const stop = (): void => {
      reported = true;
      observer.disconnect();
      target.removeEventListener('load', observe);
      document.removeEventListener('visibilitychange', observe);
    };
    target.addEventListener('load', observe);
    document.addEventListener('visibilitychange', observe);
    observe();
    return stop;
  }, [currentUrl, subjectId, unitId]);

  return (
    <span ref={node} className="minute-image">
      {image ? <img ref={picture} src={image.url} draggable={false} alt="" /> : null}
    </span>
  );
});
