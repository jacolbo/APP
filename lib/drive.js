import crypto from 'node:crypto';

/**
 * Google Drive, without the googleapis package.
 *
 * Drive is a plain JSON REST API. The only thing the official SDK really buys
 * you is the OAuth dance, and the service-account flavour of that is one
 * RS256-signed JWT — which node:crypto does natively. So this file keeps the
 * project's one real property intact: no dependencies.
 *
 * Why a service account and not "sign in with Google": a service account has
 * no human attached, so its credential does not expire on a schedule, does not
 * need a consent screen, and never shows a client an unverified-app warning.
 * The studio shares a Drive folder with the service account's email address
 * and that is the whole setup.
 *
 * What this deliberately does NOT do: hand Drive URLs to a browser. Everything
 * is fetched server-side. A Drive link that works in a browser works for
 * anyone who has it, which would make the gallery's PIN decorative.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const DEFAULT_TIMEOUT_MS = 20000;
// Refresh a little early rather than discover expiry mid-import.
const TOKEN_EARLY_REFRESH_SECONDS = 120;

/** Images we can actually show. Drive folders hold all sorts; this filters. */
const IMPORTABLE = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
]);

/**
 * Accepts anything the studio is likely to paste: a folder URL, a "shared
 * with me" URL with query junk on the end, or the bare id.
 */
export function parseFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  // .../folders/<id> — the normal "copy link" shape.
  const inPath = raw.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (inPath) return inPath[1];
  // ...?id=<id> — the older open?id= shape.
  const inQuery = raw.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (inQuery) return inQuery[1];
  // Already an id.
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
  return '';
}

/**
 * Drive's query language quotes strings with single quotes and escapes with a
 * backslash. A folder id never contains either, but the id arrives from a
 * request body, so it is escaped rather than trusted.
 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(
    typeof input === 'string' ? input : JSON.stringify(input),
  );
  return buf.toString('base64url');
}

/**
 * Reads the service-account credential out of the environment.
 *
 * Two shapes are accepted, because hosting panels differ in what they let you
 * paste into a single value: the whole downloaded JSON key, or the two fields
 * that matter as separate variables.
 */
export function readCredentials(env = process.env) {
  const blob = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (blob && blob.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(blob);
    } catch {
      // A key pasted into a hosting panel often arrives base64-encoded,
      // because the raw JSON has newlines in it.
      try {
        parsed = JSON.parse(Buffer.from(blob.trim(), 'base64').toString('utf8'));
      } catch {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON).');
      }
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
    }
    return { clientEmail: parsed.client_email, privateKey: normaliseKey(parsed.private_key) };
  }

  const clientEmail = env.GOOGLE_CLIENT_EMAIL;
  const privateKey = env.GOOGLE_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    return { clientEmail, privateKey: normaliseKey(privateKey) };
  }
  return null;
}

/**
 * Hosting panels almost always turn the key's real newlines into a literal
 * backslash-n. Undo that, or every signature fails with a confusing error.
 */
function normaliseKey(key) {
  const text = String(key).trim();
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

export class DriveClient {
  /**
   * @param {object} options
   * @param {string} options.clientEmail  service account address
   * @param {string} options.privateKey   its PEM private key
   * @param {string} [options.tokenUrl]   overridden by the tests
   * @param {string} [options.apiBase]    overridden by the tests
   */
  constructor({ clientEmail, privateKey, tokenUrl = TOKEN_URL, apiBase = DRIVE_API, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!clientEmail || !privateKey) throw new Error('Drive needs a service account email and private key.');
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.tokenUrl = tokenUrl;
    this.apiBase = apiBase;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.inFlightToken = null;
  }

  /** The signed assertion Google trades for an access token. */
  #assertion() {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const claims = base64url({
      iss: this.clientEmail,
      scope: SCOPE,
      aud: this.tokenUrl,
      iat: now,
      exp: now + 3600,
    });
    const signingInput = `${header}.${claims}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  /**
   * Cached for the token's lifetime. Concurrent callers share one request, so
   * importing forty photos does not mint forty tokens.
   */
  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.inFlightToken) return this.inFlightToken;

    this.inFlightToken = (async () => {
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.#assertion(),
      });
      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw driveError(
          response.status,
          `Google refused the service account credentials (${response.status}).`,
          detail,
        );
      }
      const json = await response.json();
      if (!json.access_token) throw driveError(502, 'Google returned no access token.');
      this.token = json.access_token;
      const lifetime = Number(json.expires_in) || 3600;
      this.tokenExpiresAt = Date.now() + Math.max(30, lifetime - TOKEN_EARLY_REFRESH_SECONDS) * 1000;
      return this.token;
    })();

    try {
      return await this.inFlightToken;
    } finally {
      this.inFlightToken = null;
    }
  }

  async #get(path, { search = {}, raw = false, signal } = {}) {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const token = await this.accessToken();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: signal || AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw driveError(response.status, describeDriveFailure(response.status), detail);
    }
    return raw ? response : response.json();
  }

  /**
   * Lists the images directly inside a folder, newest Drive ordering aside —
   * name order is what a photographer expects, since exports are numbered.
   *
   * Sub-folders are returned separately rather than walked: the app already
   * has its own folder tree, and silently flattening someone's Drive
   * hierarchy into one tab would be a surprise.
   */
  async listFolder(folderId, { pageLimit = 10 } = {}) {
    const id = escapeQueryValue(folderId);
    const files = [];
    const subfolders = [];
    let pageToken = '';

    for (let page = 0; page < pageLimit; page += 1) {
      const json = await this.#get('/files', {
        search: {
          q: `'${id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, imageMediaMetadata(width,height), modifiedTime, thumbnailLink)',
          orderBy: 'name_natural',
          pageSize: 200,
          pageToken,
          // Lets the same code read a file in a Shared Drive, not just My Drive.
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        },
      });

      for (const file of json.files || []) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          subfolders.push({ id: file.id, name: file.name });
        } else if (IMPORTABLE.has(file.mimeType)) {
          files.push({
            id: file.id,
            name: file.name,
            mime: file.mimeType,
            size: Number(file.size) || 0,
            width: Number(file.imageMediaMetadata?.width) || 0,
            height: Number(file.imageMediaMetadata?.height) || 0,
            modifiedTime: file.modifiedTime || '',
          });
        }
      }

      pageToken = json.nextPageToken || '';
      if (!pageToken) break;
    }

    return { files, subfolders, truncated: Boolean(pageToken) };
  }

  /**
   * The folders the studio has shared with this service account.
   *
   * A service account owns its own, empty Drive — `'root' in parents` would
   * list *its* root, not the photographer's. Shared items are the only way in,
   * which is also what keeps the app confined to what it was given.
   */
  async listSharedRoots() {
    const json = await this.#get('/files', {
      search: {
        q: "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'files(id, name, modifiedTime)',
        orderBy: 'name_natural',
        pageSize: 200,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      },
    });
    return (json.files || []).map((f) => ({ id: f.id, name: f.name }));
  }

  /**
   * Whether a folder is readable by the public — the signal the whole delivery
   * flow hangs on.
   *
   * Returns `null`, not `false`, when the sharing state cannot be read. Those
   * are different facts, and reporting "not public" for "we could not tell"
   * would either hide a live download or promise one that does not work.
   */
  async publicState(folderId) {
    let meta;
    try {
      meta = await this.#get(`/files/${encodeURIComponent(folderId)}`, {
        search: {
          fields: 'id, name, permissions(id, type, role), webViewLink',
          supportsAllDrives: 'true',
        },
      });
    } catch (err) {
      // A folder we cannot even read is a setup problem worth surfacing.
      if (err.driveStatus === 404 || err.driveStatus === 403) throw err;
      return { isPublic: null, name: '', reason: err.message };
    }

    // Google omits `permissions` rather than erroring when the caller may not
    // read them, so an absent field is "unknown", never "nobody".
    if (!Array.isArray(meta.permissions)) {
      return {
        isPublic: null,
        name: meta.name || '',
        webViewLink: meta.webViewLink || '',
        reason: 'Google did not return the sharing settings for this folder.',
      };
    }

    const anyone = meta.permissions.find((p) => p.type === 'anyone');
    return {
      isPublic: Boolean(anyone),
      role: anyone ? anyone.role : '',
      name: meta.name || '',
      webViewLink: meta.webViewLink || '',
      reason: '',
    };
  }

  /** Metadata for one file — used to name zip entries and check the mime type. */
  async fileMeta(fileId) {
    return this.#get(`/files/${encodeURIComponent(fileId)}`, {
      search: {
        fields: 'id, name, mimeType, size',
        supportsAllDrives: 'true',
      },
    });
  }

  /**
   * The original bytes. Returns the undrained Response so a caller can either
   * pipe it (import proxy) or buffer it (zip), rather than this deciding.
   */
  async fileContent(fileId, { signal } = {}) {
    return this.#get(`/files/${encodeURIComponent(fileId)}`, {
      search: { alt: 'media', supportsAllDrives: 'true' },
      raw: true,
      signal,
    });
  }

  /** Buffered content, with a ceiling so one enormous file cannot exhaust memory. */
  async fileBuffer(fileId, maxBytes) {
    const response = await this.fileContent(fileId);
    // Trust content-length to reject early, but re-check after reading: a
    // wrong or absent header must not become a way past the ceiling.
    const declared = Number(response.headers.get('content-length')) || 0;
    if (maxBytes && declared > maxBytes) throw tooLarge(maxBytes);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) throw tooLarge(maxBytes);
    return buffer;
  }
}

/**
 * Our own ceiling, not Google's — so it stays a real 413 instead of being
 * remapped by driveError, which only interprets responses from Google.
 */
function tooLarge(maxBytes) {
  const mb = maxBytes / 1024 / 1024;
  const limit = mb >= 1 ? `${Math.round(mb)} MB` : `${maxBytes} bytes`;
  const error = new Error(`That Drive file is larger than the ${limit} limit.`);
  error.status = 413;
  return error;
}

/** Turns Google's status codes into something a photographer can act on. */
function describeDriveFailure(status) {
  if (status === 401) return 'Google rejected the credentials. Check the service account key.';
  if (status === 403) return 'Google denied access. Share the Drive folder with the service account email.';
  if (status === 404) return 'That Drive folder or file was not found, or is not shared with the service account.';
  if (status === 429) return 'Google is rate-limiting these requests. Try again in a minute.';
  return `Google Drive returned ${status}.`;
}

function driveError(status, message, detail = '') {
  const error = new Error(message);
  // 4xx from Google is usually the studio's setup; 5xx is Google's. Either
  // way the client should not see a raw Google payload, so detail is kept
  // for the server log only.
  error.status = status >= 500 || status === 429 ? 502 : 400;
  error.driveStatus = status;
  error.detail = String(detail).slice(0, 500);
  return error;
}

/**
 * Builds a client from the environment, or returns null when Drive has not
 * been set up. Null is a normal state — the app works fine without Drive.
 */
export function driveFromEnv(env = process.env) {
  const credentials = readCredentials(env);
  if (!credentials) return null;
  return new DriveClient({
    ...credentials,
    tokenUrl: env.GOOGLE_TOKEN_URL || TOKEN_URL,
    apiBase: env.GOOGLE_DRIVE_API || DRIVE_API,
  });
}

/** The address a client opens once the folder is public. */
export function folderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

export { IMPORTABLE as IMPORTABLE_MIME_TYPES };
