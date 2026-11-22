import type { SystemRetry, SystemRetryTarget } from '@st-vault/api-schema';
import { useState } from 'react';
import { ApiError, request } from '../../shared/lib/api';
import { tr } from '../../shared/lib/i18n';
import { ProgressRing } from '../../shared/ui/ProgressRing';

export function StatusRetry({
  target,
  label,
  available,
  observed,
  onRefresh,
}: {
  target: SystemRetryTarget;
  label: string;
  available: boolean;
  observed?: SystemRetry;
  onRefresh: () => Promise<unknown>;
}): JSX.Element | null {
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState(false);
  const [accepted, setAccepted] = useState<SystemRetry | null>(null);
  const attempt =
    accepted && accepted.startedAtMs > (observed?.startedAtMs ?? -1) ? accepted : observed;
  const pending = submitting || attempt?.state === 'running';
  if (!available && !pending) return null;
  const labelText = pending ? '重试中' : submissionError ? '提交失败' : '重试';
  const title =
    submissionError || attempt?.state === 'failed'
      ? tr('重试未完成，请核对当前状态。')
      : attempt?.state === 'finished'
        ? tr('重试已执行，恢复情况见当前状态。')
        : undefined;
  const retry = async (): Promise<void> => {
    setSubmitting(true);
    setSubmissionError(false);
    try {
      try {
        setAccepted(
          await request<SystemRetry>('/api/system/retry', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target }),
          }),
        );
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
      await onRefresh();
    } catch {
      setSubmissionError(true);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <button
      className="secondary panel-button-compact system-retry"
      type="button"
      disabled={pending}
      aria-label={tr('{{v0}}：重试', { v0: label })}
      title={title}
      onClick={() => void retry()}
    >
      {pending && <ProgressRing />}
      {tr(labelText)}
    </button>
  );
}
