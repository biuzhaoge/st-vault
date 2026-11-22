import { tr } from '../../shared/lib/i18n';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { coverImages, type ImagePriority } from '../../shared/lib/image-loader';
import { getSyncIntervalMs } from '../../shared/lib/sync';
import { Icon } from '../../design/Icon';

export function CoverImage({
  id,
  revision,
  status,
  priority = 'visible',
  children,
  variant = 'cover',
}: {
  id: string;
  revision: number;
  status: string;
  priority?: ImagePriority;
  children?: ReactNode;
  variant?: 'cover' | 'avatar';
}): JSX.Element {
  const src = `/api/subjects/${encodeURIComponent(id)}/${variant}.jpg`;
  const [image, setImage] = useState(() => ({ src, blob: coverImages.peek(src) }));
  const current = useRef(image);
  current.current = image;
  const blob = image.src === src ? image.blob : null;
  const cover = useRef<HTMLImageElement>(null);
  const [loading, setLoading] = useState(!blob),
    [message, setMessage] = useState('');
  // The cache keeps bytes across virtual unmounts. Each committed view owns a
  // fresh URL, including when React replays setup and cleanup for this view.
  useLayoutEffect(() => {
    if (!blob || !cover.current) return;
    const url = URL.createObjectURL(blob);
    cover.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [src, blob]);
  useEffect(() => {
    const controller = new AbortController();
    let candidate = '',
      retry: number | undefined;
    setLoading(true);
    setMessage('');
    const load = async (attempt = 0): Promise<void> => {
      let decoding: Blob | undefined;
      try {
        const blob = await coverImages.load(src, controller.signal, priority, getSyncIntervalMs());
        if (controller.signal.aborted) return;
        if (current.current.src === src && current.current.blob === blob) {
          setLoading(false);
          return;
        }
        candidate = URL.createObjectURL(blob);
        decoding = blob;
        const next = new Image();
        next.src = candidate;
        await next.decode();
        if (controller.signal.aborted) return;
        setImage({ src, blob });
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (decoding) coverImages.invalidate(src, decoding);
        if (variant === 'cover' && priority !== 'prefetch' && attempt < 2)
          retry = window.setTimeout(
            () => {
              void load(attempt + 1);
            },
            1500 * (attempt + 1),
          );
        else {
          setMessage(tr(variant === 'avatar' ? '头像暂不可用' : '封面暂不可用'));
          setLoading(false);
          if (variant === 'cover' && priority !== 'prefetch')
            console.warn('Cover image unavailable', error);
        }
      } finally {
        if (candidate) {
          URL.revokeObjectURL(candidate);
          candidate = '';
        }
      }
    };
    // Overscan starts immediately at low priority; admission reserves slots for visible covers.
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
    };
  }, [src, revision, status, priority, variant]);
  return (
    <span
      className={`track-cover-wrap${variant === 'avatar' ? ' subject-avatar' : ''}${loading && !blob ? ' is-loading' : ''}`}
      aria-busy={loading}
    >
      {blob ? (
        <img ref={cover} className="track-cover" alt="" decoding="async" />
      ) : (
        <span className="cover-placeholder" title={message}>
          {variant === 'avatar' ? <Icon name="user" /> : message}
        </span>
      )}
      {children}
    </span>
  );
}
