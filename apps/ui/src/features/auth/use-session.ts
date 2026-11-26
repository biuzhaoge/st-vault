import type { SessionInfo } from '@st-vault/api-schema';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { setTimeZone } from '../../shared/lib/time';

const locked: SessionInfo = { authenticated: false, setupRequired: false };
type LogoutState = 'idle' | 'sending' | 'unconfirmed';

// The history entry survives refresh in this tab without storing a session token.
function entryState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? { ...state } : {};
}

function rememberLogout(pending: boolean): void {
  window.history.replaceState({ ...entryState(), stvLogoutPending: pending }, '');
}

export function useSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const initialRead = useRef<AbortController | null>(null);
  const [logoutState, setLogoutState] = useState<LogoutState>(() =>
    entryState().stvLogoutPending === true ? 'unconfirmed' : 'idle',
  );

  useEffect(() => {
    const controller = new AbortController();
    initialRead.current = controller;
    const resumingLogout = entryState().stvLogoutPending === true;
    void request<SessionInfo>('/api/session', { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        if (resumingLogout) {
          // A delayed authenticated read must never reopen a locally locked tab.
          if (next.authenticated) return;
          rememberLogout(false);
          setLogoutState('idle');
        }
        setTimeZone(next.timeZone ?? 'Asia/Shanghai');
        setSession(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setSessionError(messageFor(error));
      });
    return () => controller.abort();
  }, [readAttempt]);

  function retrySession(): void {
    setSessionError('');
    setReadAttempt((attempt) => attempt + 1);
  }

  async function revokeSession(): Promise<void> {
    initialRead.current?.abort();
    rememberLogout(true);
    setSession(locked);
    setLogoutState('sending');
    try {
      await request('/api/logout', { method: 'POST' });
    } catch (error) {
      setSessionError(messageFor(error));
      // The mutation may have committed even if its response was lost.
      try {
        const current = await request<SessionInfo>('/api/session');
        if (current.authenticated) {
          setLogoutState('unconfirmed');
          return;
        }
      } catch (readError) {
        setSessionError(messageFor(readError));
        setLogoutState('unconfirmed');
        return;
      }
    }
    rememberLogout(false);
    setSessionError('');
    setLogoutState('idle');
  }

  return { session, setSession, sessionError, retrySession, logoutState, revokeSession };
}
