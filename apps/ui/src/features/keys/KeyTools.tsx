import { useEffect, useRef, useState } from 'react';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { PanelBadge, PanelFeedback, PanelField, PanelIdentity } from '../../shared/ui/PanelContent';
import { Icon } from '../../design/Icon';

export interface KeyInfo {
  keyCount: number;
}
interface CurrentKey extends KeyInfo {
  key: { name: string; value: string } | null;
  status: 'pending' | 'usable' | 'unusable';
  checking: boolean;
}
const statusText = { pending: '等待直播验证', usable: '可用', unusable: '不可用' } as const;

export function KeyTools({
  onBusyChange,
  onChanged,
}: {
  onBusyChange: (busy: boolean) => void;
  onChanged: (value: KeyInfo) => void;
}): JSX.Element {
  const [current, setCurrent] = useState<CurrentKey | null>(null),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [readError, setReadError] = useState(''),
    [writeError, setWriteError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(): Promise<void> {
      try {
        const data = await request<CurrentKey>('/api/keys/current', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && !operation.current) {
          setCurrent(data);
          setReadError('');
        }
      } catch (error) {
        if (!controller.signal.aborted && !operation.current) setReadError(messageFor(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(
    () => () => {
      operation.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );
  async function update(action: { name: string; value: string }): Promise<void> {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    onBusyChange(true);
    setWriteError('');
    try {
      const result = await request<CurrentKey>('/api/keys/current', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setInput('');
      setCurrent(result);
      setReadError('');
      onChanged({ keyCount: result.keyCount });
    } catch (error) {
      if (!controller.signal.aborted) setWriteError(messageFor(error));
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChange(false);
        setRefresh((value) => value + 1);
      }
    }
  }
  function add(event: React.FormEvent): void {
    event.preventDefault();
    const match = /^([^:\s]+)\s*:\s*(\S.*)$/.exec(input.trim());
    if (!match) {
      setWriteError(tr('请填写“密钥名:密钥值”。'));
      return;
    }
    void update({ name: match[1], value: match[2] });
  }
  return (
    <section className="key-tools">
      {current?.key ? (
        <PanelIdentity
          icon={<Icon name="key" />}
          label={current.key.name}
          value={<code tabIndex={0}>{current.key.value}</code>}
          accessory={
            <PanelBadge
              live
              tone={
                current.checking || current.status === 'pending'
                  ? 'neutral'
                  : current.status === 'usable'
                    ? 'success'
                    : 'error'
              }
            >
              {tr(current.checking ? '正在验证密钥…' : statusText[current.status])}
            </PanelBadge>
          }
        />
      ) : (
        !readError && (
          <PanelFeedback kind={current ? 'info' : 'busy'}>
            {tr(current ? '请先粘贴导入密钥' : '读取中')}
          </PanelFeedback>
        )
      )}
      <form className="panel-inline-form" onSubmit={add}>
        <PanelField label={tr('密钥名:密钥值')} stacked>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={1153}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setWriteError('');
            }}
            disabled={busy}
          />
        </PanelField>
        <button className="primary" disabled={busy || !input.trim()}>
          {tr(current?.key ? '更换密钥' : '添加密钥')}
        </button>
      </form>
      {(writeError || readError) && (
        <PanelFeedback kind="error">{writeError || readError}</PanelFeedback>
      )}
    </section>
  );
}
