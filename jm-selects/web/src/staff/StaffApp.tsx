import { useCallback, useEffect, useState } from 'react';
import { Brand } from '../brand';
import { ApiError, api } from '../api';
import { navigate } from '../nav';
import { NewSession } from './NewSession';
import { SessionDetail } from './SessionDetail';
import { SessionList } from './SessionList';
import { WifiPoster } from './WifiPoster';

export function StaffApp({ path }: { path: string }) {
  const [staff, setStaff] = useState<boolean | null>(null);

  const check = useCallback(() => {
    api<{ staff: boolean }>('/api/staff/me')
      .then((r) => setStaff(r.staff))
      .catch(() => setStaff(false));
  }, []);
  useEffect(check, [check]);
  const onAuthLost = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setStaff(false);
  }, []);

  if (staff === null) return null;
  if (!staff) return <PinScreen onOk={() => setStaff(true)} />;

  const detail = path.match(/^\/staff\/sessions\/(\d+)/);
  let body;
  if (path === '/staff/new') body = <NewSession onAuthLost={onAuthLost} />;
  else if (path === '/staff/wifi') body = <WifiPoster />;
  else if (detail) body = <SessionDetail key={detail[1]} id={Number(detail[1])} onAuthLost={onAuthLost} />;
  else body = <SessionList onAuthLost={onAuthLost} />;

  return (
    <div className="staff">
      <header className="staff-top">
        <button className="brand-link" onClick={() => navigate('/staff')}>
          <Brand sub="JM Selects · Studio" />
        </button>
        <div className="staff-actions">
          <button className="btn ghost" onClick={() => navigate('/staff/wifi')}>
            Wi-Fi poster
          </button>
          <button className="btn gold" onClick={() => navigate('/staff/new')}>
            New session
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await api('/api/staff/logout', { method: 'POST' }).catch(() => {});
              setStaff(false);
            }}
          >
            Lock
          </button>
        </div>
      </header>
      <div className="staff-body">{body}</div>
    </div>
  );
}

function PinScreen({ onOk }: { onOk: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (busy || value.length < 4) return;
    setBusy(true);
    try {
      await api('/api/staff/login', { method: 'POST', json: { pin: value } });
      onOk();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (d: string) => {
    setError('');
    setPin((p) => (p.length < 12 ? p + d : p));
  };

  return (
    <div className="center-screen pin-screen">
      <Brand large sub="JM Selects" />
      <p className="muted">Studio staff · enter PIN</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(pin);
        }}
      >
        <input
          className="pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
          aria-label="Staff PIN"
          autoFocus
        />
      </form>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
          ⌫
        </button>
        <button onClick={() => press('0')}>0</button>
        <button className="gold" onClick={() => void submit(pin)} disabled={busy || pin.length < 4}>
          OK
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
