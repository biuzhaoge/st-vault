import { useSyncExternalStore } from 'react';

const query = '(prefers-reduced-motion: reduce)';
const serverSnapshot = () => false;

export function prefersReducedMotion(): boolean {
  return window.matchMedia(query).matches;
}

function subscribe(notify: () => void): () => void {
  const preference = window.matchMedia(query);
  preference.addEventListener('change', notify);
  return () => preference.removeEventListener('change', notify);
}

export function useReducedMotion(): boolean {
  // A page can render with a new preference before the browser delivers its change event.
  return useSyncExternalStore(subscribe, prefersReducedMotion, serverSnapshot);
}
