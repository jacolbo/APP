import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fmtTime } from './SessionList';

interface Device {
  id: number;
  label: string;
  via: 'name' | 'tablet';
  joinedAt: number;
  lastSeen: number;
  revoked: boolean;
  online: boolean;
}
interface AccessInfo {
  link: string;
  joinFailures: number;
  locked: boolean;
  maxJoinAttempts: number;
  devices: Device[];
}
interface WifiInfo {
  configured: boolean;
  ssid: string;
  open: boolean;
}

export function useWifi() {
  const [wifi, setWifi] = useState<WifiInfo | null>(null);
  useEffect(() => {
    api<WifiInfo>('/api/staff/wifi').then(setWifi).catch(() => setWifi(null));
  }, []);
  return wifi;
}

/** The two ways to hand over a session, plus who is connected. */
export function HandoverCard({
  id,
  token,
  onHandoff,
  onTokenChanged,
}: {
  id: number;
  token: string;
  onHandoff: () => void;
  onTokenChanged: () => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const [info, setInfo] = useState<AccessInfo | null>(null);

  const load = useCallback(
    () =>
      api<AccessInfo>(`/api/staff/sessions/${id}/access`)
        .then(setInfo)
        .catch(() => {}),
    [id],
  );
  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load, token]);

  const active = info?.devices.filter((d) => !d.revoked) ?? [];

  return (
    <div className="card handover">
      <h2>Client</h2>
      <p className="muted small">Choose how the client views their photos. They only ever see this session.</p>
      <div className="btn-col">
        <button className="btn gold" onClick={onHandoff}>
          Hand this tablet to the client
        </button>
        <button className="btn ghost" onClick={() => setShowQr(true)}>
          Show QR code
        </button>
      </div>

      {info?.locked && (
        <div className="notice">
          <p className="small">
            Locked after {info.maxJoinAttempts} names that didn’t match. Check the client name above is their full name, then:
          </p>
          <button
            className="btn small"
            onClick={async () => {
              await api(`/api/staff/sessions/${id}/reset-attempts`, { method: 'POST' });
              void load();
            }}
          >
            Allow new attempts
          </button>
        </div>
      )}

      <div className="devices">
        <span className="eyebrow">Connected devices</span>
        {active.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul>
            {active.map((d) => (
              <li key={d.id}>
                <span className={`dot-online ${d.online ? 'on' : ''}`} aria-label={d.online ? 'Online now' : 'Not open now'} />
                <span className="device-name">
                  {d.label}
                  <span className="muted small">
                    {d.via === 'tablet' ? ' · handed over' : ' · confirmed name'} · {d.online ? 'online now' : `seen ${fmtTime(d.lastSeen)}`}
                  </span>
                </span>
                <button
                  className="link-btn danger-link"
                  onClick={async () => {
                    if (!confirm(`Remove access for this ${d.label}?`)) return;
                    await api(`/api/staff/sessions/${id}/devices/${d.id}/revoke`, { method: 'POST' });
                    void load();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showQr && (
        <QrSheet
          id={id}
          token={token}
          link={info?.link ?? ''}
          onClose={() => setShowQr(false)}
          onRegenerated={() => {
            onTokenChanged();
            void load();
          }}
        />
      )}
    </div>
  );
}

function QrSheet({
  id,
  token,
  link,
  onClose,
  onRegenerated,
}: {
  id: number;
  token: string;
  link: string;
  onClose: () => void;
  onRegenerated: () => void;
}) {
  const wifi = useWifi();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  // Rendered at page level: the frosted card it opens from would otherwise trap it.
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal qr-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="QR codes">
        <span className="eyebrow">View on your phone</span>
        <div className="qr-steps">
          <section>
            <span className="step">Step 1</span>
            <h2>Join the studio Wi-Fi</h2>
            {wifi?.configured ? (
              <>
                <img className="qr" src="/api/staff/wifi.svg" alt={`Wi-Fi QR code for ${wifi.ssid}`} />
                <p className="small muted">
                  Network: <b>{wifi.ssid}</b>
                </p>
              </>
            ) : (
              <p className="small muted">
                Wi-Fi QR not set up yet: add WIFI_SSID and WIFI_PASSWORD to the .env file (see README).
              </p>
            )}
          </section>
          <section>
            <span className="step">Step 2</span>
            <h2>Open your gallery</h2>
            {/* token in the URL makes the browser fetch the new code after a regenerate */}
            <img className="qr" src={`/api/staff/sessions/${id}/qr.svg?t=${token}`} alt="QR code for this client’s gallery" />
            <p className="small muted">They’ll be asked to type their full name once.</p>
          </section>
        </div>
        {link && <p className="mono small qr-link">{link}</p>}
        <div className="modal-actions">
          <button
            className="btn ghost small"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Make a new QR code? The old link and code stop working, and phones already connected will need to scan again.')) return;
              setBusy(true);
              await api(`/api/staff/sessions/${id}/regenerate`, { method: 'POST' }).catch((e) => alert(e.message));
              setBusy(false);
              onRegenerated();
            }}
          >
            New QR code
          </button>
          <button className="btn small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
