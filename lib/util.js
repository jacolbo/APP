import crypto from 'node:crypto';

/** Short, unguessable, URL-safe identifier. 12 random bytes ≈ 96 bits of entropy. */
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Buffer a request body, rejecting anything over `limit` bytes. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 256 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(400, 'Body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw httpError(400, 'Invalid JSON body');
  }
}

/** Trim + length-cap untrusted text. Anything that is not a string becomes ''. */
export function text(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

/** Constant-time comparison of two secrets of any length. */
export function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
