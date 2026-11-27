import { useRef, useState } from 'react';
import { Icon } from '../../design/Icon';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { ProgressRing } from '../../shared/ui/ProgressRing';

export function UnfollowButton({
  handle,
  onUnfollow,
}: {
  handle: string;
  onUnfollow: () => Promise<void>;
}): JSX.Element {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const label = tr('取消关注 {{v0}}', { v0: handle });

  async function unfollow(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      await onUnfollow();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <span className="directory-unfollow">
      <button
        type="button"
        className="directory-unfollow-button"
        aria-label={label}
        aria-description={error || undefined}
        aria-busy={pending}
        disabled={pending}
        title={error || label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void unfollow();
        }}
      >
        {pending ? <ProgressRing /> : <Icon name="heart-off" />}
      </button>
      {error && (
        <span className="mode-error" role="alert" aria-label={error}>
          !
        </span>
      )}
    </span>
  );
}
