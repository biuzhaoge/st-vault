import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import App from './App';
import { tr } from './shared/lib/i18n';
import { LanguageSwitch } from './shared/ui/LanguageSwitch';
import './style.css';
import './design/liquid-glass.css';
import './design/panels.css';
import './design/player-overlays.css';

function ViewportNotice(): JSX.Element {
  useTranslation();
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = notice.current;
    if (!node) return;
    // A fullscreen element would cover the orientation prompt when the CSS gate opens.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && document.fullscreenElement)
        void document.exitFullscreen().catch((error: unknown) => {
          console.warn('Could not exit fullscreen after the viewport changed', error);
        });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <main className="viewport-notice" ref={notice}>
      <LanguageSwitch compact />
      <h1>{tr('当前窗口尺寸不受支持')}</h1>
      <p>{tr('请将平板转为横屏，或调整电脑窗口大小。')}</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="viewport-workspace">
      <App />
    </div>
    <ViewportNotice />
  </React.StrictMode>,
);
