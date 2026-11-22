import { StrictMode, useEffect, useState } from 'react';
import { Brand } from './brand';
import { createRoot } from 'react-dom/client';
import { rememberedClient } from './api';
import { navigate } from './nav';
import { ClientApp } from './client/ClientApp';
import { StaffApp } from './staff/StaffApp';
import './styles.css';

/** The home-screen app opens at "/": resume this tablet's client session if it has one, otherwise staff. */
function startPath(): string {
  if (location.pathname === '/' || location.pathname === '') {
    const remembered = rememberedClient();
    history.replaceState(null, '', remembered ? `/c/${remembered}` : '/staff');
  }
  return location.pathname;
}

function Router() {
  const [path, setPath] = useState(startPath);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const client = path.match(/^\/c\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (client) return <ClientApp key={client[1]} token={client[1]} />;
  if (path.startsWith('/staff')) return <StaffApp path={path} />;
  return (
    <div className="center-screen">
      <Brand large />
      <button className="link-btn" onClick={() => navigate('/staff')}>
        Studio sign-in
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
