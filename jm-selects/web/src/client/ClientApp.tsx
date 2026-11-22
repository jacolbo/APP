import { useEffect, useMemo, useState } from 'react';
import { Brand } from '../brand';
import { extrasFor, formatRand } from '../../../shared/pricing';
import { imgUrl, rememberClient, type Photo, type Pick } from '../api';
import { HeartIcon } from '../icons';
import { navigate } from '../nav';
import { Compare } from './Compare';
import { Stars } from './Stars';
import { JoinScreen } from './JoinScreen';
import { useClientSession } from './usePicks';
import { Viewer } from './Viewer';

type Filter = 'all' | 'selected' | 1 | 2 | 3 | 4 | 5;
const NO_PICK: Pick = { selected: false, stars: 0 };

export function ClientApp({ token }: { token: string }) {
  const { data, error, gate, saving, change, join, markDone, refresh } = useClientSession(token);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewing, setViewing] = useState<string | null>(null);
  const [comparePick, setComparePick] = useState<string[] | null>(null); // null = not choosing
  const [comparing, setComparing] = useState<[string, string] | null>(null);
  const [confirmDone, setConfirmDone] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [extraNotice, setExtraNotice] = useState(false);

  useEffect(() => rememberClient(token), [token]);
  useEffect(() => {
    if (error) rememberClient(null);
  }, [error]);

  const picks = data?.picks ?? {};
  const pickOf = (name: string) => picks[name] ?? NO_PICK;
  const locked = data?.status === 'done';
  const photos = data?.photos ?? [];
  const selectedCount = useMemo(() => photos.filter((p) => picks[p.name]?.selected).length, [photos, picks]);

  const shown = useMemo(() => {
    if (filter === 'all') return photos;
    if (filter === 'selected') return photos.filter((p) => picks[p.name]?.selected);
    return photos.filter((p) => (picks[p.name]?.stars ?? 0) >= filter);
  }, [photos, picks, filter]);

  const counts = useMemo(() => {
    const c = { selected: 0, s: [0, 0, 0, 0, 0, 0] };
    for (const p of photos) {
      const k = picks[p.name];
      if (k?.selected) c.selected++;
      for (let i = 1; i <= (k?.stars ?? 0); i++) c.s[i]++;
    }
    return c;
  }, [photos, picks]);

  if (error) {
    return (
      <div className="center-screen">
        <Brand large />
        <p className="muted">{error}</p>
        <button className="link-btn" onClick={() => navigate('/staff')}>
          Studio sign-in
        </button>
      </div>
    );
  }
  if (gate?.kind === 'needName') {
    return <JoinScreen locked={gate.locked} attemptsLeft={gate.attemptsLeft} onJoin={join} />;
  }
  if (gate?.kind === 'revoked') {
    return (
      <div className="center-screen">
        <Brand large />
        <p className="muted">{gate.message}</p>
      </div>
    );
  }
  if (!data) return <div className="center-screen"><Brand large /><p className="muted">Loading your photos…</p></div>;

  const extras = extrasFor(selectedCount, data.packageSize, data.extraPrice);
  const noticeKey = `jm-selects-extra-notice-${token}`;
  const toggle = (name: string) => {
    if (locked) return;
    const selecting = !pickOf(name).selected;
    change(name, { selected: selecting });
    // The first time the client goes past their package, tell them once, gently.
    if (selecting && selectedCount + 1 > data.packageSize) {
      let seen = false;
      try {
        seen = localStorage.getItem(noticeKey) === '1';
        localStorage.setItem(noticeKey, '1');
      } catch {
        /* private mode: show it anyway */
      }
      if (!seen) setExtraNotice(true);
    }
  };
  const rate = (name: string, stars: number) => !locked && change(name, { stars });

  const onTileTap = (p: Photo) => {
    if (comparePick) {
      const next = comparePick.includes(p.name) ? comparePick.filter((n) => n !== p.name) : [...comparePick, p.name];
      if (next.length === 2) {
        setComparing([next[0], next[1]]);
        setComparePick(null);
      } else setComparePick(next);
      return;
    }
    setViewing(p.name);
  };

  const byName = new Map(photos.map((p) => [p.name, p]));

  return (
    <div className="client">
      <header className="client-top">
        <div className="client-title">
          <Brand />
          <h1 className="client-name">{data.clientName}</h1>
        </div>
        <Summary extras={extras} />
        <div className="client-actions">
          <button
            className={`btn ghost ${comparePick ? 'active' : ''}`}
            onClick={() => setComparePick(comparePick ? null : [])}
          >
            {comparePick ? 'Cancel compare' : 'Compare'}
          </button>
          {locked ? (
            <span className="chip done">Selection sent</span>
          ) : (
            <button className="btn gold" onClick={() => setConfirmDone(true)}>
              I’m done
            </button>
          )}
        </div>
      </header>

      <nav className="filters" aria-label="Filter photos">
        <FilterChip on={filter === 'all'} onClick={() => setFilter('all')} label="All photos" n={photos.length} />
        <FilterChip on={filter === 'selected'} onClick={() => setFilter('selected')} label="♥ Selected" n={counts.selected} />
        {[5, 4, 3, 2, 1].map((s) => (
          <FilterChip
            key={s}
            on={filter === s}
            onClick={() => setFilter(s as Filter)}
            label={`${'★'.repeat(s)}${s < 5 ? '+' : ''}`}
            n={counts.s[s]}
          />
        ))}
        <span className="spacer" />
        <span className={`save-state ${saving}`}>
          {saving === 'saved' ? 'All changes saved' : saving === 'saving' ? 'Saving…' : 'Offline — will save when reconnected'}
        </span>
        <button
          className="btn ghost small"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </nav>

      {locked && (
        <div className="banner">
          Thank you — your selection has been sent to the studio. You can still look through your photos.
        </div>
      )}
      {comparePick && (
        <div className="banner gold">Tap two photos to compare them side by side ({comparePick.length} of 2 chosen)</div>
      )}

      {shown.length === 0 ? (
        <p className="empty muted">
          {photos.length === 0 ? 'Your photos will appear here in a moment.' : 'No photos here yet.'}
        </p>
      ) : (
        <main className="grid">
          {shown.map((p) => {
            const k = pickOf(p.name);
            const chosen = comparePick?.includes(p.name);
            return (
              <figure key={p.name} className={`tile ${k.selected ? 'is-selected' : ''} ${chosen ? 'is-chosen' : ''}`}>
                <button className="tile-img" onClick={() => onTileTap(p)} aria-label={`Open ${p.name}`}>
                  <img src={imgUrl(token, 'thumb', p)} alt="" loading="lazy" decoding="async" draggable={false} />
                </button>
                <figcaption>
                  <Stars value={k.stars} onChange={(s) => rate(p.name, s)} disabled={locked} size="sm" />
                  <button
                    className={`heart ${k.selected ? 'on' : ''}`}
                    onClick={() => toggle(p.name)}
                    disabled={locked}
                    aria-pressed={k.selected}
                    aria-label={k.selected ? 'Unselect' : 'Select'}
                  >
                    <HeartIcon filled={k.selected} />
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </main>
      )}

      {viewing && (
        <Viewer
          token={token}
          photos={shown.some((p) => p.name === viewing) ? shown : photos}
          start={viewing}
          pickOf={pickOf}
          locked={locked}
          onToggle={toggle}
          onRate={rate}
          onClose={() => setViewing(null)}
          onCompare={(name) => {
            setViewing(null);
            setComparePick([name]);
          }}
        />
      )}

      {comparing && byName.get(comparing[0]) && byName.get(comparing[1]) && (
        <Compare
          token={token}
          a={byName.get(comparing[0])!}
          b={byName.get(comparing[1])!}
          pickOf={pickOf}
          locked={locked}
          onToggle={toggle}
          onRate={rate}
          onClose={() => setComparing(null)}
        />
      )}

      {extraNotice && (
        <div className="modal-back" onClick={() => setExtraNotice(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="extra-title">
            <span className="eyebrow">A small note</span>
            <h2 id="extra-title">More favourites than your package</h2>
            <p className="extra-msg">
              You’ve chosen more than your package includes – extra pictures are {formatRand(data.extraPrice)} each.
            </p>
            <p className="muted">Keep choosing freely. Your running total is always shown at the top.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setExtraNotice(false)} autoFocus>
                Continue choosing
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDone && (
        <div className="modal-back" onClick={() => setConfirmDone(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>Finished choosing?</h2>
            <Summary extras={extras} />
            {extras.extra > 0 && (
              <p className="muted">
                {extras.extra} extra picture{extras.extra === 1 ? '' : 's'} at {formatRand(extras.price)} each, {formatRand(extras.total)} in total.
              </p>
            )}
            {selectedCount === 0 && <p className="muted">You haven’t selected any photos yet.</p>}
            <p className="muted">Once you confirm, the studio will take it from here.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmDone(false)}>
                Keep choosing
              </button>
              <button
                className="btn gold"
                onClick={async () => {
                  setConfirmDone(false);
                  await markDone().catch(() => alert('Could not reach the studio system. Please try again.'));
                }}
              >
                Yes, I’m done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "23 selected · 20 included · 3 extra · R750", updated live. */
function Summary({ extras }: { extras: ReturnType<typeof extrasFor> }) {
  const over = extras.extra > 0;
  return (
    <div className={`summary ${over ? 'over' : ''}`} aria-live="polite" aria-atomic="true">
      <span>
        <b>{extras.selected}</b> selected
      </span>
      <span className="dot"> · </span>
      <span>
        <b>{extras.included}</b> included
      </span>
      <span className="dot"> · </span>
      <span className="extra">
        <b>{extras.extra}</b> extra
      </span>
      <span className="dot"> · </span>
      <span className="extra">
        <b>{formatRand(extras.total)}</b>
      </span>
    </div>
  );
}

function FilterChip({ on, onClick, label, n }: { on: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button className={`chip ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on}>
      {label} <span className="chip-n">{n}</span>
    </button>
  );
}
