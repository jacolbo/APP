import { useEffect, useState } from 'react';
import { api, type Session } from '../api';
import { navigate } from '../nav';

interface Entry {
  name: string;
  path: string;
  jpegCount?: number;
}

export function NewSession({ onAuthLost }: { onAuthLost: (e: unknown) => void }) {
  const [rel, setRel] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [depth, setDepth] = useState(0);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<Entry | null>(null);
  const [packages, setPackages] = useState<number[]>([]);
  const [defaultPrice, setDefaultPrice] = useState<number>(250);

  useEffect(() => {
    api<{ packageSizes: number[]; extraImagePrice: number }>('/api/config')
      .then((c) => {
        setPackages(c.packageSizes);
        setDefaultPrice(c.extraImagePrice);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setEntries(null);
    setError('');
    api<{ entries: Entry[]; depth: number }>(`/api/staff/browse?path=${encodeURIComponent(rel)}`)
      .then((r) => {
        setEntries(r.entries);
        setDepth(r.depth);
      })
      .catch((e) => {
        onAuthLost(e);
        setError(e.message);
      });
  }, [rel, onAuthLost]);

  const crumbs = rel ? rel.split('/') : [];
  const heading = depth === 0 ? 'Choose the year' : depth === 1 ? 'Choose the week (backup folders)' : 'Choose the client folder';

  if (chosen) return <StartForm folder={chosen} packages={packages} defaultPrice={defaultPrice} onBack={() => setChosen(null)} />;

  return (
    <section>
      <div className="section-head">
        <h1>New session</h1>
      </div>
      <nav className="crumbs" aria-label="Folder">
        <button onClick={() => setRel('')}>Photos</button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <span className="sep">›</span>
            <button onClick={() => setRel(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
      </nav>
      <h2 className="sub">{heading}</h2>
      {error && <p className="error">{error}</p>}
      {!entries ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <ul className="folder-list">
          {entries.map((e) => (
            <li key={e.path}>
              <button className="folder-row" onClick={() => setRel(e.path)}>
                <span className="folder-name">{e.name}</span>
                {e.jpegCount !== undefined && <span className="muted small">{e.jpegCount} JPEGs</span>}
              </button>
              {depth >= 2 && (
                <button className="btn gold small" onClick={() => setChosen(e)}>
                  Start session
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StartForm({
  folder,
  packages,
  defaultPrice,
  onBack,
}: {
  folder: Entry;
  packages: number[];
  defaultPrice: number;
  onBack: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [price, setPrice] = useState(String(defaultPrice));
  const [size, setSize] = useState<string>(packages[0] ? String(packages[0]) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api<Session>('/api/staff/sessions', {
        method: 'POST',
        json: { clientName: name, packageSize: Number(size), folder: folder.path, extraPrice: price },
      });
      navigate(`/staff/sessions/${s.id}`, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the session');
      setBusy(false);
    }
  };

  return (
    <section className="form-card">
      <span className="eyebrow">New session</span>
      <h1>Start session</h1>
      <p className="muted small">{folder.path}</p>
      <label>
        Client name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <div className="label">Package (images included)</div>
      <div className="seg wrap">
        {packages.map((p) => (
          <button key={p} className={size === String(p) ? 'on' : ''} onClick={() => setSize(String(p))}>
            {p}
          </button>
        ))}
        <input
          className="size-input"
          inputMode="numeric"
          placeholder="Other"
          value={packages.includes(Number(size)) ? '' : size}
          onChange={(e) => setSize(e.target.value.replace(/\D/g, '').slice(0, 4))}
          aria-label="Other package size"
        />
      </div>
      <label>
        Extra pictures (rand each)
        <span className="money-input">
          <span>R</span>
          <input
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            aria-label="Price per extra picture in rand"
          />
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button className="btn gold" disabled={busy || !name.trim() || !Number(size) || price === ''} onClick={start}>
          Start session
        </button>
      </div>
    </section>
  );
}
