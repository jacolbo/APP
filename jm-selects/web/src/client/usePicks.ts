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
export type Gate =
  | { kind: 'ok' }
  | { kind: 'needName'; locked: boolean; attemptsLeft: number }
  | { kind: 'revoked'; message: string };

export function useClientSession(token: string) {
  const [data, setData] = useState<ClientData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
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
        setGate({ kind: 'ok' });
      } catch (e) {
        if (!(e instanceof ApiError)) return; // network blip: keep showing what we have
        if (e.status === 404) {
          setError('This link is no longer valid. Please scan the new code from the studio.');
          setData(null);
        } else if (e.data.needName) {
          setData(null);
          setGate({ kind: 'needName', locked: Boolean(e.data.locked), attemptsLeft: Number(e.data.attemptsLeft ?? 0) });
        } else if (e.data.revoked) {
          setData(null);
          setGate({ kind: 'revoked', message: e.message });
        }
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
          if (e instanceof ApiError && e.status === 401) {
            // This device needs to confirm the name again: keep the taps for afterwards.
            await load();
            return;
          }
          if (e instanceof ApiError && e.status < 500) {
            delete pending.current[name]; // rejected (locked / removed / photo gone): drop it
            if (e.status === 403) {
              pending.current = {};
              await load();
              return;
            }
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

  /** Confirm the client's name on this device. Returns an error message, or null when let in. */
  const join = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        await api(`/api/c/${token}/join`, { method: 'POST', json: { name } });
        await load();
        return null;
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.data.needName) {
            setGate({ kind: 'needName', locked: Boolean(e.data.locked), attemptsLeft: Number(e.data.attemptsLeft ?? 0) });
          }
          if (e.status === 404) setError('This link is no longer valid. Please scan the new code from the studio.');
          return e.message;
        }
        return 'Can’t reach the studio system. Check you’re on the studio Wi-Fi.';
      }
    },
    [token, load],
  );

  const markDone = useCallback(async () => {
    await flush();
    await api(`/api/c/${token}/done`, { method: 'POST' });
    await load();
  }, [token, flush, load]);

  // Live updates from other phones/tablets in this session.
  const allowed = gate?.kind === 'ok';
  useEffect(() => {
    if (!allowed || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/c/${token}/events`);
    const refresh = () => void load();
    es.addEventListener('changed', refresh);
    es.addEventListener('revoked', refresh);
    es.addEventListener('gone', refresh);
    es.onerror = () => {
      // The browser retries by itself; if access was removed, find out why.
      if (es.readyState === EventSource.CLOSED) void load();
    };
    return () => es.close();
  }, [allowed, token, load]);

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

  return { data, error, gate, saving, change, join, markDone, refresh: () => load(true) };
}
