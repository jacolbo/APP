import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, copyText, imgUrl, rememberClient, type ClientData, type RawStatus, type Session } from '../api';
import { formatRand, type Extras } from '../../../shared/pricing';
import { HeartIcon } from '../icons';
import { navigate } from '../nav';
import { Devices, QrSheet, useAccessInfo } from './Access';
import { fmtTime } from './SessionList';

type Detail = ClientData & { session: Session; raws: RawStatus; extras: Extras };

export function SessionDetail({ id, onAuthLost }: { id: number; onAuthLost: (e: unknown) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [menu, setMenu] = useState(false);
  const [qr, setQr] = useState(false);
  const [busy, setBusy] = useState(false);

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

  // Poll faster while RAWs are being copied so the progress moves.
  const copying = d?.raws.state === 'queued' || d?.raws.state === 'running';
  useEffect(() => {
    void load();
    const t = setInterval(load, copying ? 1500 : 5000);
    return () => clearInterval(t);
  }, [load, copying]);

  const access = useAccessInfo(id, d?.session.token ?? '');

  if (error && !d) return <p className="error">{error}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  const s = d.session;
  const done = s.status === 'done';

  const handoff = async () => {
    const r = await api<{ url: string }>(`/api/staff/sessions/${id}/handoff`, { method: 'POST' });
    rememberClient(s.token);
    navigate(r.url, true);
  };

  const unlock = async () => {
    setBusy(true);
    await api(`/api/staff/sessions/${id}/unlock`, { method: 'POST' }).catch((e) => alert(e.message));
    setBusy(false);
    await load();
  };

  const grid = onlyPicked
    ? d.photos.filter((p) => d.picks[p.name]?.selected || (d.picks[p.name]?.stars ?? 0) > 0)
    : d.photos;

  return (
    <section className="session">
      <button className="back-link" onClick={() => navigate('/staff')}>
        ‹ All sessions
      </button>

      <article className="pane summary-card">
        <header className="summary-head">
          <div className="summary-title">
            <span className="eyebrow">{s.folder.split('/').slice(0, 2).join(' · ')}</span>
            <h1>{s.clientName}</h1>
            <p className="muted small">
              Package {s.packageSize} · {formatRand(s.extraPrice)} per extra picture
            </p>
          </div>
          <span className={`chip status ${done ? 'done' : 'progress'}`}>
            {done ? `Done${s.doneAt ? ` · ${fmtTime(s.doneAt)}` : ''}` : 'In progress'}
          </span>
        </header>

        <dl className="facts">
          <div>
            <dt>Selected</dt>
            <dd>{d.extras.selected}</dd>
          </div>
          <div>
            <dt>Included</dt>
            <dd>{d.extras.included}</dd>
          </div>
          <div className={d.extras.extra ? 'gold' : ''}>
            <dt>Extra</dt>
            <dd>{d.extras.extra}</dd>
          </div>
          <div className={d.extras.extra ? 'gold' : ''}>
            <dt>Extra total</dt>
            <dd>{formatRand(d.extras.total)}</dd>
          </div>
        </dl>

        <RawLine id={id} raws={d.raws} done={done} onChange={load} />

        <div className="actions">
          {done ? (
            <button className="btn" onClick={unlock} disabled={busy}>
              Unlock for changes
            </button>
          ) : (
            <>
              <button className="btn" onClick={handoff}>
                Hand this tablet to the client
              </button>
              <button className="btn ghost" onClick={() => setQr(true)}>
                Show QR code
              </button>
            </>
          )}
          <button className="btn ghost more-btn" onClick={() => setMenu(true)} aria-haspopup="dialog">
            <span aria-hidden="true">⋯</span> More
          </button>
        </div>

        {access.info && <Devices id={id} info={access.info} onChange={access.reload} />}
      </article>

      <div className="photos-head">
        <h2>Photos</h2>
        <label className="check">
          <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} /> Only selected or rated
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

      {menu && <MoreMenu session={s} raws={d.raws} onClose={() => setMenu(false)} onChanged={load} />}
      {qr && (
        <QrSheet
          id={id}
          token={s.token}
          link={access.info?.link ?? ''}
          onClose={() => setQr(false)}
          onRegenerated={() => {
            void load();
            void access.reload();
          }}
        />
      )}
    </section>
  );
}

/* ---------- RAW status, one line ---------- */

function RawLine({ id, raws, done, onChange }: { id: number; raws: RawStatus; done: boolean; onChange: () => void }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  if (!raws.enabled) return <p className="raw-line muted small">RAW copies are off (no projects folder set up).</p>;

  const st = raws.state;
  const where = raws.destination ? `${raws.projectsLabel.replace(/\/+$/, '')}/${raws.destination}` : null;
  const missing = raws.missing ?? [];
  const problems = raws.problems ?? [];
  const issues = missing.length + problems.length;

  if (st === null) {
    return (
      <p className="raw-line muted small">
        {done ? 'RAWs will be copied shortly.' : 'RAWs copy automatically when the client taps “I’m done”.'}
      </p>
    );
  }
  if (st === 'queued' || st === 'running') {
    const pct = raws.totalFiles ? Math.round(((raws.doneFiles ?? 0) / raws.totalFiles) * 100) : 0;
    return (
      <div className="raw-line" aria-live="polite">
        <span>
          {st === 'queued' ? 'Preparing RAW copy…' : `Copying ${raws.doneFiles ?? 0} of ${raws.totalFiles ?? 0}…`}
        </span>
        <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (st === 'failed' || st === 'interrupted') {
    return (
      <div className="raw-line">
        <span className="error">{raws.message}</span>
        <button
          className="text-btn"
          onClick={async () => {
            await api(`/api/staff/sessions/${id}/raws`, { method: 'POST' }).catch((e) => alert(e.message));
            onChange();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="raw-line">
      <span className="raw-ready">
        RAWs ready <span aria-hidden="true">✓</span>
        {issues > 0 && (
          <button className="text-btn warn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {missing.length > 0 && `${missing.length} without a RAW`}
            {missing.length > 0 && problems.length > 0 && ' · '}
            {problems.length > 0 && `${problems.length} not copied`} {open ? '▴' : '▾'}
          </button>
        )}
      </span>
      {where && (
        <span className="raw-path">
          <span className="mono">{where}</span>
          <button
            className="text-btn"
            onClick={async () => {
              setCopied(await copyText(where));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </span>
      )}
      {open && (
        <ul className="raw-issues mono small">
          {missing.map((m) => (
            <li key={m}>{m} · no RAW found</li>
          ))}
          {problems.map((p) => (
            <li key={p} className="error">
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- the ⋯ More menu ---------- */

type View = 'menu' | 'copy' | 'edit' | 'reset' | 'delete';

function MoreMenu({
  session,
  raws,
  onClose,
  onChanged,
}: {
  session: Session;
  raws: RawStatus;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<View>('menu');
  const [busy, setBusy] = useState(false);
  const id = session.id;
  const rawBusy = raws.state === 'queued' || raws.state === 'running';

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') view === 'menu' ? onClose() : setView('menu');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [view, onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch((e) => alert(e.message));
    setBusy(false);
  };

  const title: Record<View, string> = {
    menu: 'More',
    copy: 'Copy list for Capture One',
    edit: 'Package & price',
    reset: 'Reset selections?',
    delete: 'Delete this session?',
  };

  return createPortal(
    <div className="modal-back sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title[view]}>
        <header className="sheet-head">
          {view !== 'menu' ? (
            <button className="text-btn" onClick={() => setView('menu')}>
              ‹ Back
            </button>
          ) : (
            <span />
          )}
          <h2>{title[view]}</h2>
          <button className="text-btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>

        {view === 'menu' && (
          <ul className="menu">
            <li>
              <button className="menu-item" onClick={() => setView('copy')}>
                Copy list for Capture One <span aria-hidden="true">›</span>
              </button>
            </li>
            <li>
              <button
                className="menu-item"
                disabled={!raws.enabled || rawBusy || busy}
                onClick={() =>
                  run(async () => {
                    await api(`/api/staff/sessions/${id}/raws`, { method: 'POST' });
                    onChanged();
                    onClose();
                  })
                }
              >
                Re-copy RAWs
              </button>
            </li>
            <li>
              <a className="menu-item" href={`/api/staff/sessions/${id}/export.csv`} download onClick={() => setTimeout(onClose, 300)}>
                Export CSV
              </a>
            </li>
            <li>
              <button className="menu-item" onClick={() => setView('edit')}>
                Package & price <span aria-hidden="true">›</span>
              </button>
            </li>
            <li className="menu-sep" role="separator" />
            <li>
              <button className="menu-item danger" onClick={() => setView('reset')}>
                Reset selections
              </button>
            </li>
            <li>
              <button className="menu-item danger" onClick={() => setView('delete')}>
                Delete session
              </button>
            </li>
          </ul>
        )}

        {view === 'copy' && <CopyList id={id} />}

        {view === 'edit' && (
          <PackageForm
            session={session}
            onSaved={() => {
              onChanged();
              setView('menu');
            }}
          />
        )}

        {view === 'reset' && (
          <div className="confirm-box">
            <p>All hearts and stars for {session.clientName} will be cleared. Photos are not affected.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setView('menu')}>
                Cancel
              </button>
              <button
                className="btn danger-solid"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(`/api/staff/sessions/${id}/reset`, { method: 'POST' });
                    onChanged();
                    onClose();
                  })
                }
              >
                Reset selections
              </button>
            </div>
          </div>
        )}

        {view === 'delete' && (
          <div className="confirm-box">
            <p>The session for {session.clientName} and its selections will be removed from the app. Photos and RAW copies are never touched.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setView('menu')}>
                Cancel
              </button>
              <button
                className="btn danger-solid"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(`/api/staff/sessions/${id}`, { method: 'DELETE' });
                    navigate('/staff', true);
                  })
                }
              >
                Delete session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PackageForm({ session, onSaved }: { session: Session; onSaved: () => void }) {
  const [v, setV] = useState(String(session.packageSize));
  const [price, setPrice] = useState(String(session.extraPrice));
  return (
    <form
      className="sheet-form"
      onSubmit={async (e) => {
        e.preventDefault();
        await api(`/api/staff/sessions/${session.id}`, {
          method: 'PATCH',
          json: { packageSize: Number(v), extraPrice: price },
        }).catch((er) => alert(er.message));
        onSaved();
      }}
    >
      <label>
        Pictures included
        <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 4))} />
      </label>
      <label>
        Price per extra picture (R)
        <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </label>
      <button className="btn" disabled={!Number(v) || price === ''}>
        Save
      </button>
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
    api<{ text: string; count: number }>(`/api/staff/sessions/${id}/copylist?${q}`)
      .then((r) => {
        setText(r.text);
        setCount(r.count);
      })
      .catch(() => {});
  }, [id, filter, minStars, ext, space]);

  return (
    <div className="copy-list">
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
      <textarea readOnly value={text} rows={4} placeholder="Nothing selected yet" aria-label="File names" />
      <button
        className="btn"
        disabled={!text}
        onClick={async () => {
          const ok = await copyText(text);
          setCopied(ok ? `Copied ${count} file name${count === 1 ? '' : 's'}` : 'Could not copy. Select the text and copy it manually.');
          setTimeout(() => setCopied(''), 3000);
        }}
      >
        Copy list ({count})
      </button>
      {copied && (
        <p className="muted small" role="status">
          {copied}
        </p>
      )}
    </div>
  );
}
