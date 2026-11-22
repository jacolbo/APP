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

export interface AccessInfo {
  link: string;
  joinFailures: number;
  locked: boolean;
  maxJoinAttempts: number;
  devices: Device[];
}

/** Who is connected to a session, refreshed every few seconds. */
export function useAccessInfo(id: number, token: string) {
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
  return { info, reload: load };
}

/** Compact list of connected phones/tablets, each removable after a confirm. */
export function Devices({ id, info, onChange }: { id: number; info: AccessInfo; onChange: () => void }) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const active = info.devices.filter((d) => !d.revoked);
  return (
    <div className="devices">
      {info.locked && (
        <div className="notice">
          <span className="small">Locked after {info.maxJoinAttempts} names that didn’t match.</span>
          <button
            className="btn small"
            onClick={async () => {
              await api(`/api/staff/sessions/${id}/reset-attempts`, { method: 'POST' });
              onChange();
            }}
          >
            Allow new attempts
          </button>
        </div>
      )}
      {active.length > 0 && (
        <>
          <span className="eyebrow">Connected</span>
          <ul>
            {active.map((d) => (
              <li key={d.id}>
                <span className={`dot-online ${d.online ? 'on' : ''}`} aria-label={d.online ? 'Online now' : 'Not open now'} />
                <span className="device-name">
                  {d.label}
                  <span className="muted small"> · {d.online ? 'online' : `seen ${fmtTime(d.lastSeen)}`}</span>
                </span>
                {confirming === d.id ? (
                  <span className="inline-confirm">
                    <button className="text-btn" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                    <button
                      className="text-btn danger"
                      onClick={async () => {
                        await api(`/api/staff/sessions/${id}/devices/${d.id}/revoke`, { method: 'POST' });
                        setConfirming(null);
                        onChange();
                      }}
                    >
                      Remove access
                    </button>
                  </span>
                ) : (
                  <button className="text-btn" onClick={() => setConfirming(d.id)} aria-label={`Remove ${d.label}`}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function QrSheet({
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
  const [confirmNew, setConfirmNew] = useState(false);

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
        {confirmNew ? (
          <div className="confirm-box">
            <p>Make a new code? The old one stops working and connected phones must scan again.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmNew(false)}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await api(`/api/staff/sessions/${id}/regenerate`, { method: 'POST' }).catch((e) => alert(e.message));
                  setBusy(false);
                  setConfirmNew(false);
                  onRegenerated();
                }}
              >
                Make new code
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setConfirmNew(true)}>
              New QR code
            </button>
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
