// Exercises the hand-rolled Google Drive client against a fake Google that
// verifies our RS256 assertion with a real public key. No network, no account.
//   node test/drive.mjs
import { DriveClient, parseFolderId, readCredentials } from '../lib/drive.js';
import { startFakeDrive } from './helpers/fakedrive.mjs';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------- link shapes
console.log('\n— pasting a Drive link —');

const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUv';
check('a folder URL', parseFolderId(`https://drive.google.com/drive/folders/${ID}`) === ID);
check('a folder URL with ?usp=sharing', parseFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`) === ID);
check('a /u/0/ account-scoped URL', parseFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`) === ID);
check('the older open?id= shape', parseFolderId(`https://drive.google.com/open?id=${ID}`) === ID);
check('a bare id', parseFolderId(ID) === ID);
check('surrounding whitespace', parseFolderId(`  ${ID}  `) === ID);
check('nonsense yields nothing', parseFolderId('lunch') === '');
check('empty yields nothing', parseFolderId('') === '');

// ------------------------------------------------------------- credentials
console.log('\n— reading the service account key —');

const PEM_STUB = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';

check(
  'not configured is a normal state, not an error',
  readCredentials({}) === null,
);
check(
  'the whole downloaded JSON key works',
  readCredentials({
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.com', private_key: PEM_STUB }),
  })?.clientEmail === 'a@b.com',
);
check(
  'a base64-wrapped key works, since panels mangle newlines',
  readCredentials({
    GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(
      JSON.stringify({ client_email: 'a@b.com', private_key: PEM_STUB }),
    ).toString('base64'),
  })?.clientEmail === 'a@b.com',
);
check(
  'literal \\n in the key becomes real newlines',
  readCredentials({
    GOOGLE_CLIENT_EMAIL: 'a@b.com',
    GOOGLE_PRIVATE_KEY: PEM_STUB.replace(/\n/g, '\\n'),
  })?.privateKey === PEM_STUB,
);
{
  const err = (() => { try { readCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: '{oops' }); return null; } catch (e) { return e; } })();
  check('a broken key says so plainly', /not valid JSON/.test(err?.message || ''), err?.message);
}
{
  const err = (() => {
    try { readCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.com' }) }); return null; }
    catch (e) { return e; }
  })();
  check('a key missing private_key says which field', /private_key/.test(err?.message || ''), err?.message);
}

// ----------------------------------------------------------- the real flow
console.log('\n— talking to Google (a fake that checks our signature) —');

const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const fake = await startFakeDrive({
  files: [
    { id: 'file-a', name: '_MG_1613.jpg', mimeType: 'image/jpeg', body: jpeg },
    { id: 'file-b', name: '_MG_1621.png', mimeType: 'image/png', body: png },
  ],
  folders: {
    shoot: [
      { id: 'file-a', name: '_MG_1613.jpg', mimeType: 'image/jpeg', size: String(jpeg.length), imageMediaMetadata: { width: 6000, height: 4000 } },
      { id: 'file-b', name: '_MG_1621.png', mimeType: 'image/png', size: String(png.length) },
      { id: 'sub-1', name: 'Retouched', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'doc-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: '999' },
      { id: 'sheet', name: 'shotlist', mimeType: 'application/vnd.google-apps.spreadsheet' },
    ],
    empty: [],
  },
});

const drive = new DriveClient({
  clientEmail: fake.clientEmail,
  privateKey: fake.privateKey,
  tokenUrl: fake.tokenUrl,
  apiBase: fake.apiBase,
});

// --- auth
const token = await drive.accessToken();
check('Google accepted our hand-rolled RS256 assertion', token === 'fake-token-1', token);
check('exactly one token was minted', fake.state.tokensIssued === 1);

const claims = JSON.parse(Buffer.from(fake.state.lastAssertion.split('.')[1], 'base64url').toString('utf8'));
check('the assertion asks only for read access', claims.scope.endsWith('drive.readonly'), claims.scope);
check('the assertion is addressed to the token endpoint', claims.aud === fake.tokenUrl);
check('the assertion identifies the service account', claims.iss === fake.clientEmail);

// --- token caching
await drive.accessToken();
await drive.accessToken();
check('a cached token is reused, not re-minted', fake.state.tokensIssued === 1);

await Promise.all([drive.listFolder('shoot'), drive.listFolder('shoot'), drive.listFolder('shoot')]);
check('concurrent calls share one token request', fake.state.tokensIssued === 1);

// --- listing
const listed = await drive.listFolder('shoot');
check('both photos were found', listed.files.length === 2, JSON.stringify(listed.files.map((f) => f.name)));
check('they come back in name order', listed.files[0].name === '_MG_1613.jpg' && listed.files[1].name === '_MG_1621.png');
check('the PDF was left out', !listed.files.some((f) => f.name.endsWith('.pdf')));
check('the Google Sheet was left out', !listed.files.some((f) => f.name === 'shotlist'));
check('the sub-folder is reported separately, not flattened', listed.subfolders.length === 1 && listed.subfolders[0].name === 'Retouched');
check('Drive dimensions are carried through', listed.files[0].width === 6000 && listed.files[0].height === 4000);
check('the query excludes trashed files', /trashed = false/.test(fake.state.lastQuery), fake.state.lastQuery);

const emptyFolder = await drive.listFolder('empty');
check('an empty folder is empty, not an error', emptyFolder.files.length === 0);

// --- a folder id can't break out of the query
// The fake has no such folder, so this 404s — the point is what the query
// looked like on the way out, which is recorded before the failure.
await rejects(() => drive.listFolder("x' or '1'='1"));
check(
  "a quote in the folder id is escaped, not injected",
  fake.state.lastQuery.includes("\\'"),
  fake.state.lastQuery,
);

// --- content
const body = await drive.fileBuffer('file-a', 10 * 1024 * 1024);
check('the original bytes come back intact', body.equals(jpeg), `${body.length} bytes`);

const meta = await drive.fileMeta('file-b');
check('metadata carries the real filename', meta.name === '_MG_1621.png');

const tooBig = await rejects(() => drive.fileBuffer('file-a', 4));
check('a file over the size ceiling is refused', tooBig?.status === 413, tooBig?.message);

// --- failures the studio will actually hit
const missing = await rejects(() => drive.listFolder('not-shared'));
check(
  'an unshared folder explains the fix',
  /not shared with the service account|not found/i.test(missing?.message || ''),
  missing?.message,
);

fake.state.failNextWith = 403;
const denied = await rejects(() => drive.fileMeta('file-a'));
check(
  'a 403 tells the studio to share the folder',
  /Share the Drive folder with the service account/i.test(denied?.message || ''),
  denied?.message,
);
check('a 403 surfaces as a 400, not a server error', denied?.status === 400);

fake.state.failNextWith = 500;
const broken = await rejects(() => drive.fileMeta('file-a'));
check("Google's own outage surfaces as a 502", broken?.status === 502, String(broken?.status));

fake.state.failNextWith = 429;
const limited = await rejects(() => drive.fileMeta('file-a'));
check('rate limiting is a 502 with a wait-and-retry message', limited?.status === 502 && /rate-limiting/i.test(limited.message));

// --- a wrong key is rejected by signature, not by luck
const wrongKey = new DriveClient({
  clientEmail: fake.clientEmail,
  privateKey: (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }),
  tokenUrl: fake.tokenUrl,
  apiBase: fake.apiBase,
});
const badSig = await rejects(() => wrongKey.accessToken());
check('a key that does not match is rejected', /refused the service account/i.test(badSig?.message || ''), badSig?.message);

// --- expiry
const shortLived = new DriveClient({
  clientEmail: fake.clientEmail,
  privateKey: fake.privateKey,
  tokenUrl: fake.tokenUrl,
  apiBase: fake.apiBase,
});
fake.state.tokenLifetime = 1; // floors to a 30s cache, so still cached
const before = fake.state.tokensIssued;
await shortLived.accessToken();
await shortLived.accessToken();
check('a short-lived token still caches rather than thrashing', fake.state.tokensIssued === before + 1);

await fake.stop();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
