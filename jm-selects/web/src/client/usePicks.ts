import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type ClientData, type Pick } from '../api';

type Change = { selected?: boolean; stars?: number };
const POLL_MS = 5000;

const pendingKey = (token: string) => `jm-selects-pending-${token}`;
function loadPending(token: string): Record<string, Change> {
  try {
    return JSON.parse(localStorage.getItem(pendingKey(token)) ?? '{}');
  } catch {
    return {};
  }
}
function savePending(token: string, p: Record<string, Change>) {
  try {
    if (Object.keys(p).length) localStorage.setItem(pendingKey(token), JSON.stringify(p));
    else localStorage.removeItem(pendingKey(token));
  } catch {
    /* ignore */
  }
}

/**
 * Loads the client's photos and picks, polls for new photos, and saves every tap
 * straight away. Taps that can't reach the NAS (Wi-Fi blip, tablet asleep) are kept on
 * the tablet and re-sent automatically, so nothing is lost.
 */
export function useClientSession(token: string) {
  const [data, setData] = useState<ClientData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'offline'>('saved');
  const pending = useRef<Record<string, Change>>(loadPending(token));
  const flushing = useRef(false);

  const merge = useCallback((server: ClientData): ClientData => {
    const picks: Record<string, Pick> = { ...server.picks };
    for (const [name, ch] of Object.entries(pending.current)) {
      const base = picks[name] ?? { selected: false, stars: 0 };
      picks[name] = { selected: ch.selected ?? base.selected, stars: ch.stars ?? base.stars };
    }
    return { ...server, picks };
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      try {
        const d = await api<ClientData>(`/api/c/${token}${refresh ? '?refresh=1' : ''}`);
        setData(merge(d));
        setError(null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setError(e.message);
        // network errors: keep showing what we have
      }
    },
    [token, merge],
  );

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (const name of Object.keys(pending.current)) {
        const change = pending.current[name];
        setSaving('saving');
        try {
          await api(`/api/c/${token}/picks/${encodeURIComponent(name)}`, { method: 'PUT', json: change });
          if (pending.current[name] === change) delete pending.current[name];
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) {
            delete pending.current[name]; // rejected (locked / photo removed): drop it
            if (e.status === 409) {
              pending.current = {};
              savePending(token, pending.current);
              await load();
              return;
            }
          } else {
            setSaving('offline');
            return;
          }
        } finally {
          savePending(token, pending.current);
        }
      }
      setSaving('saved');
    } finally {
      flushing.current = false;
      if (Object.keys(pending.current).length && navigator.onLine) setTimeout(() => void flush(), 50);
    }
  }, [token, load]);

  const change = useCallback(
    (name: string, ch: Change) => {
      pending.current[name] = { ...pending.current[name], ...ch };
      savePending(token, pending.current);
      setData((d) => {
        if (!d) return d;
        const base = d.picks[name] ?? { selected: false, stars: 0 };
        return { ...d, picks: { ...d.picks, [name]: { selected: ch.selected ?? base.selected, stars: ch.stars ?? base.stars } } };
      });
      void flush();
    },
    [token, flush],
  );

  const markDone = useCallback(async () => {
    await flush();
    await api(`/api/c/${token}/done`, { method: 'POST' });
    await load();
  }, [token, flush, load]);

  useEffect(() => {
    void load();
    void flush();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load();
        if (Object.keys(pending.current).length) void flush();
      }
    }, POLL_MS);
    const wake = () => {
      void flush();
      void load();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(poll);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [load, flush]);

  return { data, error, saving, change, markDone, refresh: () => load(true) };
}
