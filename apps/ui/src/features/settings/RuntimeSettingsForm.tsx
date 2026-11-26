import { useState } from 'react';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { LanguageSwitch } from '../../shared/ui/LanguageSwitch';
import { PanelFeedback, PanelField, PanelSection } from '../../shared/ui/PanelContent';
import type { RuntimeSettings } from '../status/system';
interface SettingsDraft {
  pollSeconds: string;
  retentionDays: string;
  minFreeGiB: string;
}
const GIB = 1024 ** 3;
const SETTINGS_MAX_FREE_BYTES = 2 ** 50;

function settingsToDraft(settings: RuntimeSettings): SettingsDraft {
  return {
    pollSeconds: String(settings.pollMs / 1000),
    retentionDays: String(settings.retentionDays),
    minFreeGiB: String(settings.minFreeBytes / GIB),
  };
}

export function RuntimeSettingsForm({
  settings,
  onSaved,
  recording,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings) => Promise<void>;
  recording: React.ReactNode;
}): JSX.Element {
  const [edits, setEdits] = useState<Partial<SettingsDraft>>({});
  const current = settingsToDraft(settings);
  const draft = { ...current, ...edits };
  const dirty = Object.keys(edits).length > 0;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function edit(field: keyof SettingsDraft, value: string): void {
    setEdits((previous) => {
      const next = { ...previous, [field]: value };
      if (value.trim() !== '' && Number(value) === Number(current[field])) delete next[field];
      return next;
    });
    setError('');
    setMessage('');
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setMessage('');

    const pollSeconds = Number(draft.pollSeconds);
    const pollMs = Math.round(pollSeconds * 1000);
    const retentionDays = Number(draft.retentionDays);
    const minFreeGiB = Number(draft.minFreeGiB);
    const minFreeBytesFloat = minFreeGiB * GIB;
    const minFreeBytes = Math.round(minFreeBytesFloat);
    if (
      draft.pollSeconds.trim() === '' ||
      !Number.isFinite(pollSeconds) ||
      pollMs < 1000 ||
      pollMs > 300000 ||
      pollMs / 1000 !== pollSeconds
    ) {
      setError(tr('轮询间隔须为 1–300 秒，最多精确到毫秒（小数点后三位）。'));
      return;
    }
    if (
      draft.retentionDays.trim() === '' ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 0 ||
      retentionDays > 3650
    ) {
      setError(tr('保留天数须为 0–3650 的整数；0 表示永久保留。'));
      return;
    }
    if (
      draft.minFreeGiB.trim() === '' ||
      !Number.isFinite(minFreeGiB) ||
      minFreeGiB < 0 ||
      minFreeBytesFloat > SETTINGS_MAX_FREE_BYTES ||
      !Number.isSafeInteger(minFreeBytes)
    ) {
      setError(tr('最低剩余空间须为 0–1048576 GiB，并换算为整数 Byte。'));
      return;
    }
    const values: Partial<RuntimeSettings> = {};
    if (edits.pollSeconds !== undefined) values.pollMs = pollMs;
    if (edits.retentionDays !== undefined) values.retentionDays = retentionDays;
    if (edits.minFreeGiB !== undefined) values.minFreeBytes = minFreeBytes;
    if (!dirty) return;
    setSaving(true);
    try {
      const saved = await request<RuntimeSettings>('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      setEdits({});
      setMessage(tr('设置已保存'));
      void onSaved(saved).catch((cause: unknown) => setError(messageFor(cause)));
    } catch (cause) {
      setError(tr('设置保存失败：{{v0}}', { v0: messageFor(cause) }));
    } finally {
      setSaving(false);
    }
  }

  function resetDraft(): void {
    setEdits({});
    setError('');
    setMessage('');
  }

  return (
    <div className="runtime-settings">
      <PanelSection title={tr('即时生效')}>
        <LanguageSwitch />
        {recording}
      </PanelSection>
      <form onSubmit={(event) => void submit(event)}>
        <PanelSection title={tr('同步与存储')}>
          <PanelField
            label={tr('统一同步间隔（秒）')}
            hint={tr('清单、状态、图片和时间线共用此间隔。')}
          >
            <input
              type="number"
              required
              min="1"
              max="300"
              step="0.001"
              value={draft.pollSeconds}
              disabled={saving}
              onChange={(event) => edit('pollSeconds', event.target.value)}
            />
          </PanelField>
          <PanelField label={tr('录像保留天数')} hint={tr('0 为永久保留。')}>
            <input
              type="number"
              required
              min="0"
              max="3650"
              step="1"
              value={draft.retentionDays}
              disabled={saving}
              onChange={(event) => edit('retentionDays', event.target.value)}
            />
          </PanelField>
          <PanelField
            label={tr('最低剩余空间（GiB）')}
            hint={tr('低于阈值时暂停录制；0 关闭保护。')}
          >
            <input
              type="number"
              required
              min="0"
              max="1048576"
              step="any"
              value={draft.minFreeGiB}
              disabled={saving}
              onChange={(event) => edit('minFreeGiB', event.target.value)}
            />
          </PanelField>
          {error && <PanelFeedback kind="error">{error}</PanelFeedback>}
        </PanelSection>
        {message && <PanelFeedback kind="success">{message}</PanelFeedback>}
        <div className="panel-actions">
          <button className="primary" disabled={saving || !dirty}>
            {saving ? tr('保存中…') : tr('保存运行设置')}
          </button>
          {dirty && (
            <button
              className="text-button"
              type="button"
              disabled={saving || !dirty}
              onClick={resetDraft}
            >
              {tr('撤销未保存修改')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
