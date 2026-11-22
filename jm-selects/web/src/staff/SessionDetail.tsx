import { useCallback, useEffect, useState } from 'react';
import { api, copyText, imgUrl, rememberClient, type ClientData, type Session } from '../api';
import { HeartIcon } from '../icons';
import { navigate } from '../nav';
import { fmtTime } from './SessionList';

type Detail = ClientData & { session: Session };

export function SessionDetail({ id, onAuthLost }: { id: number; onAuthLost: (e: unknown) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);

  const load = useCallback(
    () =>
      api<Detail>(`/api/staff/sessions/${id}`)
        .then((r) => {
          setD(r);
          setError('');
        })
        .catch((e) => {
          onAuthLost(e);
          setError(e.message);
        }),
    [id, onAuthLost],
  );

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !d) return <p className="error">{error}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  const s = d.session;
  const selected = d.photos.filter((p) => d.picks[p.name]?.selected).length;
  const rated = d.photos.filter((p) => (d.picks[p.name]?.stars ?? 0) > 0).length;

  const act = async (path: string, method = 'POST') => {
    await api(`/api/staff/sessions/${id}${path}`, { method }).catch((e) => alert(e.message));
    await load();
  };

  const handoff = async () => {
    const r = await api<{ url: string }>(`/api/staff/sessions/${id}/handoff`, { method: 'POST' });
    rememberClient(s.token);
    navigate(r.url, true);
  };

  const grid = onlyPicked
    ? d.photos.filter((p) => d.picks[p.name]?.selected || (d.picks[p.name]?.stars ?? 0) > 0)
    : d.photos;

  return (
    <section>
      <button className="link-btn" onClick={() => navigate('/staff')}>
        ‹ All sessions
      </button>
      <div className="section-head">
        <div>
          <h1>{s.clientName}</h1>
          <div className="muted small">{s.folder}</div>
        </div>
        <span className={`chip ${s.status === 'done' ? 'done' : 'progress'}`}>
          {s.status === 'done' ? `Done ${s.doneAt ? fmtTime(s.doneAt) : ''}` : 'In progress'}
        </span>
      </div>

      <div className="stat-row">
        <div className="stat">
          <strong>{selected}</strong>
          <span>selected of {s.packageSize}</span>
        </div>
        <div className="stat">
          <strong>{rated}</strong>
          <span>rated</span>
        </div>
        <div className="stat">
          <strong>{d.photos.length}</strong>
          <span>photos</span>
        </div>
        <PackageEdit session={s} onSaved={load} />
      </div>

      <div className="card-row">
        <div className="card">
          <h2>Client</h2>
          <p className="muted small">
            Signs you out on this device and opens the client view. Only this client’s photos are visible.
          </p>
          <button className="btn gold" onClick={handoff}>
            Hand this tablet to the client
          </button>
          <p className="muted small">
            Or open on another device:{' '}
            <a href={`/c/${s.token}`} target="_blank" rel="noreferrer">
              client link
            </a>
          </p>
        </div>
        <CopyList id={id} />
        <div className="card">
          <h2>Manage</h2>
          <div className="btn-col">
            <a className="btn ghost" href={`/api/staff/sessions/${id}/export.csv`} download>
              Export CSV
            </a>
            {s.status === 'done' && (
              <button className="btn ghost" onClick={() => act('/unlock')}>
                Unlock for changes
              </button>
            )}
            <button
              className="btn ghost"
              onClick={() => confirm('Clear all hearts and stars for this session? Photos are not affected.') && act('/reset')}
            >
              Reset selections
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm(`Delete the session for ${s.clientName}? This removes app data only — photos are never touched.`))
                  return;
                await api(`/api/staff/sessions/${id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
                navigate('/staff', true);
              }}
            >
              Delete session
            </button>
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>Photos</h2>
        <label className="check">
          <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} /> Only selected or
          rated
        </label>
      </div>
      <div className="grid staff-grid">
        {grid.map((p) => {
          const k = d.picks[p.name];
          return (
            <figure key={p.name} className={`tile ${k?.selected ? 'is-selected' : ''}`}>
              <div className="tile-img">
                <img src={imgUrl(s.token, 'thumb', p)} alt="" loading="lazy" decoding="async" />
              </div>
              <figcaption>
                <span className="small">{p.name}</span>
                <span className="tile-marks">
                  {k?.stars ? <span className="gold-text">{'★'.repeat(k.stars)}</span> : null}
                  {k?.selected ? (
                    <span className="heart on tiny">
                      <HeartIcon filled />
                    </span>
                  ) : null}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

function PackageEdit({ session, onSaved }: { session: Session; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(String(session.packageSize));
  if (!editing)
    return (
      <button className="link-btn" onClick={() => setEditing(true)}>
        Change package
      </button>
    );
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        await api(`/api/staff/sessions/${session.id}`, { method: 'PATCH', json: { packageSize: Number(v) } }).catch((er) =>
          alert(er.message),
        );
        setEditing(false);
        onSaved();
      }}
    >
      <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 4))} />
      <button className="btn gold small">Save</button>
    </form>
  );
}

function CopyList({ id }: { id: number }) {
  const [filter, setFilter] = useState<'hearted' | 'stars'>('hearted');
  const [minStars, setMinStars] = useState(3);
  const [ext, setExt] = useState(false);
  const [space, setSpace] = useState(false);
  const [text, setText] = useState('');
  const [count, setCount] = useState(0);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const q = new URLSearchParams({ filter, minStars: String(minStars), ext: ext ? '1' : '0', sep: space ? 'space' : 'comma' });
    const load = () =>
      api<{ text: string; count: number }>(`/api/staff/sessions/${id}/copylist?${q}`)
        .then((r) => {
          setText(r.text);
          setCount(r.count);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id, filter, minStars, ext, space]);

  return (
    <div className="card copy-card">
      <h2>Copy list for Capture One</h2>
      <div className="seg">
        <button className={filter === 'hearted' ? 'on' : ''} onClick={() => setFilter('hearted')}>
          ♥ Hearted
        </button>
        <button className={filter === 'stars' ? 'on' : ''} onClick={() => setFilter('stars')}>
          ★ Stars
        </button>
        {filter === 'stars' && (
          <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))} aria-label="Minimum stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}★ and up
              </option>
            ))}
          </select>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={ext} onChange={(e) => setExt(e.target.checked)} /> Include file extension (.jpg)
      </label>
      <label className="check">
        <input type="checkbox" checked={space} onChange={(e) => setSpace(e.target.checked)} /> Space after each comma
      </label>
      <textarea readOnly value={text} rows={4} placeholder="Nothing selected yet" />
      <button
        className="btn gold"
        disabled={!text}
        onClick={async () => {
          const ok = await copyText(text);
          setCopied(ok ? `Copied ${count} file name${count === 1 ? '' : 's'}` : 'Could not copy — select the text and copy it manually');
          setTimeout(() => setCopied(''), 3000);
        }}
      >
        Copy list ({count})
      </button>
      {copied && <p className="muted small">{copied}</p>}
    </div>
  );
}
