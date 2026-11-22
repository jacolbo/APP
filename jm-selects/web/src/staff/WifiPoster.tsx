import { Brand } from '../brand';
import { useWifi } from './Access';

/** Printable Wi-Fi sign for the studio wall. The password is only inside the QR code. */
export function WifiPoster() {
  const wifi = useWifi();
  if (!wifi) return <p className="muted">Loading…</p>;
  if (!wifi.configured) {
    return (
      <div className="empty-card">
        <p>The Wi-Fi QR isn’t set up yet. Add WIFI_SSID and WIFI_PASSWORD to the .env file and redeploy (see README).</p>
      </div>
    );
  }
  return (
    <>
      <div className="poster-tools">
        <p className="muted small">Print on A4 or A5. The Wi-Fi password is never printed as text, only inside the code.</p>
        <button className="btn" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <article className="poster">
        <Brand large />
        <hr className="poster-rule" />
        <span className="eyebrow">Studio Wi-Fi</span>
        <h1>Connect to view your gallery</h1>
        <img className="poster-qr" src="/api/staff/wifi.svg" alt={`Wi-Fi QR code for ${wifi.ssid}`} />
        <p className="poster-net">{wifi.ssid}</p>
        <p className="poster-how">Open your phone’s camera, point it at the code, and tap to join.</p>
      </article>
    </>
  );
}
