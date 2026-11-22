import { useEffect, useState } from 'react';
import { api, type Session } from '../api';
import { formatRand } from '../../../shared/pricing';
import { navigate } from '../nav';

export const fmtTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function SessionList({ onAuthLost }: { onAuthLost: (e: unknown) => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [show, setShow] = useState<'all' | 'in_progress' | 'done'>('all');

  useEffect(() => {
    const load = () => api<Session[]>('/api/staff/sessions').then(setSessions).catch(onAuthLost);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [onAuthLost]);

  if (!sessions) return <p className="muted">Loading…</p>;
  const list = sessions.filter((s) => show === 'all' || s.status === show);

  return (
    <section>
      <div className="section-head">
        <div>
          <span className="eyebrow">Studio</span>
          <h1>Sessions</h1>
        </div>
        <div className="seg">
          {(['all', 'in_progress', 'done'] as const).map((k) => (
            <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>
              {k === 'all' ? 'All' : k === 'done' ? 'Done' : 'In progress'}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <div className="empty-card">
          <p>No sessions yet.</p>
          <button className="btn gold" onClick={() => navigate('/staff/new')}>
            Start a session
          </button>
        </div>
      ) : (
        <ul className="session-list">
          {list.map((s) => (
            <li key={s.id}>
              <button className="session-row" onClick={() => navigate(`/staff/sessions/${s.id}`)}>
                <div>
                  <div className="session-name">{s.clientName}</div>
                  <div className="muted small">{s.folder}</div>
                </div>
                <div className="session-meta">
                  <span>
                    <strong>{s.selectedCount}</strong> selected · {s.packageSize} included
                    {s.extras && s.extras.extra > 0 && (
                      <span className="gold-text">
                        {' '}
                        · {s.extras.extra} extra · {formatRand(s.extras.total)}
                      </span>
                    )}
                  </span>
                  {s.rawState && (
                    <span className={`chip ${s.rawState === 'done' ? 'done' : s.rawState === 'done_with_issues' || s.rawState === 'failed' || s.rawState === 'interrupted' ? 'warn' : 'progress'}`}>
                      {s.rawState === 'running' || s.rawState === 'queued'
                        ? 'Copying RAWs…'
                        : s.rawState === 'done'
                          ? 'RAWs copied'
                          : s.rawState === 'done_with_issues'
                            ? 'RAWs: check'
                            : 'RAW copy failed'}
                    </span>
                  )}
                  <span className={`chip ${s.status === 'done' ? 'done' : 'progress'}`}>
                    {s.status === 'done' ? 'Done' : 'In progress'}
                  </span>
                  <span className="muted small">{fmtTime(s.updatedAt)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
