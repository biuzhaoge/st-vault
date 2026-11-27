import { useEffect, useState } from 'react';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { PanelFeedback, PanelField, PanelSection } from '../../shared/ui/PanelContent';

interface SocksProxySettings {
  enabled: boolean;
  endpoint: string;
  username: string;
  passwordSet: boolean;
  error?: 'proxy_settings_unavailable';
}

type ProxyDraft = Pick<SocksProxySettings, 'enabled' | 'endpoint' | 'username'> & {
  password: string;
  clearPassword: boolean;
};

const settingsPath = '/api/settings/socks-proxy';

function proxyAddress(input: string): string | undefined {
  const endpoint = input.trim();
  if (!endpoint) return '';
  if (!/^socks5:\/\/[^/\\?#@\s]+\/?$/i.test(endpoint)) return;
  try {
    const url = new URL(endpoint);
    if (!url.hostname || !url.port || url.port === '0') return;
    return `socks5://${url.host}`;
  } catch {
    return undefined;
  }
}

export function SocksProxySettingsForm(): JSX.Element {
  const [settings, setSettings] = useState<SocksProxySettings | null>(null);
  const [edits, setEdits] = useState<Partial<ProxyDraft>>({});
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void request<SocksProxySettings>(settingsPath, { signal: controller.signal }).then(
      setSettings,
      (error: unknown) => {
        if (!controller.signal.aborted) setLoadError(messageFor(error));
      },
    );
    return () => controller.abort();
  }, [loadVersion]);

  function edit<K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]): void {
    setEdits((previous) => ({ ...previous, [key]: value }));
    setResult(null);
  }

  const draft = settings && { password: '', clearPassword: false, ...settings, ...edits };
  const endpoint = draft ? proxyAddress(draft.endpoint) : undefined;
  const sameLogin =
    !!draft && endpoint === settings?.endpoint && draft.username === settings?.username;
  const keepPassword = sameLogin && !!settings?.passwordSet;
  const dirty =
    !!draft &&
    (!!settings?.error ||
      draft.enabled !== settings?.enabled ||
      !sameLogin ||
      !!draft.password ||
      draft.clearPassword);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft || !dirty || saving) return;
    if (endpoint === undefined || (draft.enabled && !endpoint)) {
      setResult({
        kind: 'error',
        message: tr('请输入 SOCKS5 代理地址，格式为 socks5://主机:端口。'),
      });
      return;
    }
    if (draft.password && !draft.username) {
      setResult({ kind: 'error', message: tr('填写代理密码时也需要填写用户名。') });
      return;
    }
    if (
      draft.enabled &&
      draft.username &&
      !draft.password &&
      (!keepPassword || draft.clearPassword)
    ) {
      setResult({ kind: 'error', message: tr('启用代理认证时须填写密码。清空用户名可移除认证。') });
      return;
    }
    const utf8 = new TextEncoder();
    if (utf8.encode(draft.username).length > 255 || utf8.encode(draft.password).length > 255) {
      setResult({ kind: 'error', message: tr('代理用户名和密码各最多 255 字节。') });
      return;
    }
    setResult(null);
    setSaving(true);
    try {
      const { enabled, username } = draft;
      const password = draft.password || (keepPassword && draft.clearPassword ? '' : undefined);
      const saved = await request<SocksProxySettings>(settingsPath, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, endpoint, username, password }),
      });
      setSettings(saved);
      setEdits({});
      setResult({ kind: 'success', message: tr('代理设置已保存') });
    } catch (error) {
      setResult({ kind: 'error', message: tr('设置保存失败：{{v0}}', { v0: messageFor(error) }) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <PanelSection title={tr('SOCKS5 代理')}>
        {draft ? (
          <>
            <PanelField label={tr('启用 SOCKS5 代理')}>
              <button
                type="button"
                className="panel-switch"
                role="switch"
                aria-label={tr('启用 SOCKS5 代理')}
                aria-checked={draft.enabled}
                disabled={saving}
                onClick={() => edit('enabled', !draft.enabled)}
              >
                <i aria-hidden="true" />
              </button>
            </PanelField>
            <PanelField label={tr('代理地址')} stacked>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="socks5://proxy.local:1080"
                disabled={saving}
                value={draft.endpoint}
                onChange={(event) => edit('endpoint', event.target.value)}
              />
            </PanelField>
            <PanelField label={tr('代理用户名')}>
              <input
                autoComplete="off"
                maxLength={255}
                disabled={saving}
                value={draft.username}
                onChange={(event) => edit('username', event.target.value)}
              />
            </PanelField>
            <PanelField label={tr('代理密码')}>
              <input
                type="password"
                autoComplete="new-password"
                maxLength={255}
                placeholder={keepPassword && !draft.clearPassword ? tr('已保存') : tr('选填')}
                disabled={saving}
                value={draft.password}
                onChange={(event) => edit('password', event.target.value)}
              />
            </PanelField>
            <p className="muted">
              {tr('保存后对新的服务器出站请求生效。代理故障时，修正设置或关闭代理可恢复连接。')}
            </p>
            {settings?.passwordSet && !sameLogin && (
              <p className="muted">{tr('更改代理地址或用户名后，请重新填写所需的代理密码。')}</p>
            )}
            {settings?.error && (
              <PanelFeedback kind="error">
                {tr('保存的代理设置无法读取，服务器已暂停出站请求。请重新保存代理设置。')}
              </PanelFeedback>
            )}
            {result && <PanelFeedback kind={result.kind}>{result.message}</PanelFeedback>}
            <div className="panel-actions">
              <button type="submit" className="primary" disabled={saving || !dirty}>
                {saving ? tr('保存中…') : tr('保存代理设置')}
              </button>
              {keepPassword && !draft.password && (
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => edit('clearPassword', !draft.clearPassword)}
                >
                  {draft.clearPassword ? tr('保留已保存密码') : tr('清除已保存密码')}
                </button>
              )}
            </div>
          </>
        ) : loadError ? (
          <>
            <PanelFeedback kind="error">{loadError}</PanelFeedback>
            <div className="panel-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setLoadError('');
                  setLoadVersion((version) => version + 1);
                }}
              >
                {tr('重试')}
              </button>
            </div>
          </>
        ) : (
          <PanelFeedback kind="busy">{tr('正在读取代理设置…')}</PanelFeedback>
        )}
      </PanelSection>
    </form>
  );
}
