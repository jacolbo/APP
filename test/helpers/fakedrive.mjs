import http from 'node:http';
import crypto from 'node:crypto';

/**
 * A stand-in for Google, so the Drive code is tested for real without needing
 * a Google account, a network, or a credential in CI.
 *
 * It does the part that actually matters: it verifies the RS256 assertion
 * against the public half of a throwaway key pair. If our JWT is malformed or
 * signed wrong, this rejects it exactly as Google would — which is the only
 * way to know the hand-rolled auth is correct.
 */
export async function startFakeDrive({ files = [], folders = {} } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const state = {
    tokensIssued: 0,
    listCalls: 0,
    mediaCalls: 0,
    lastQuery: '',
    lastAssertion: '',
    // Flipped by a test to prove expiry triggers exactly one refresh.
    tokenLifetime: 3600,
    failNextWith: 0,
  };

  const byId = new Map(files.map((f) => [f.id, f]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => {
      const payload = type === 'application/json' ? JSON.stringify(body) : body;
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (state.failNextWith) {
      const status = state.failNextWith;
      state.failNextWith = 0;
      return send(status, { error: { message: 'injected failure' } });
    }

    // ---- token endpoint ----
    if (req.method === 'POST' && url.pathname === '/token') {
      const body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => resolve(raw));
      });
      const form = new URLSearchParams(body);
      const assertion = form.get('assertion') || '';
      state.lastAssertion = assertion;

      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return send(400, { error: 'unsupported_grant_type' });
      }

      const [header, claims, signature] = assertion.split('.');
      if (!header || !claims || !signature) return send(400, { error: 'invalid_assertion' });

      const verified = crypto
        .createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature, 'base64url'));
      if (!verified) return send(401, { error: 'invalid_signature' });

      const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
      if (!parsed.scope?.includes('drive')) return send(400, { error: 'bad_scope' });
      if (parsed.exp <= parsed.iat) return send(400, { error: 'bad_expiry' });

      state.tokensIssued += 1;
      return send(200, {
        access_token: `fake-token-${state.tokensIssued}`,
        expires_in: state.tokenLifetime,
        token_type: 'Bearer',
      });
    }

    // Everything past here needs the bearer token we just issued.
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer fake-token-')) return send(401, { error: 'unauthorized' });

    // ---- files.list ----
    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      state.listCalls += 1;
      const q = url.searchParams.get('q') || '';
      state.lastQuery = q;
      const match = q.match(/'([^']*)' in parents/);
      const folderId = match ? match[1] : '';
      const contents = folders[folderId];
      if (!contents) return send(404, { error: { message: 'File not found' } });
      return send(200, { files: contents });
    }

    // ---- files.get (metadata or media) ----
    const fileMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (req.method === 'GET' && fileMatch) {
      const file = byId.get(decodeURIComponent(fileMatch[1]));
      if (!file) return send(404, { error: { message: 'File not found' } });

      if (url.searchParams.get('alt') === 'media') {
        state.mediaCalls += 1;
        res.writeHead(200, {
          'content-type': file.mimeType,
          'content-length': file.body.length,
        });
        return res.end(file.body);
      }
      return send(200, {
        id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.body.length),
      });
    }

    return send(404, { error: { message: 'no such endpoint' } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    clientEmail: 'gallery@fake.iam.gserviceaccount.com',
    tokenUrl: `http://127.0.0.1:${port}/token`,
    apiBase: `http://127.0.0.1:${port}/drive/v3`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
