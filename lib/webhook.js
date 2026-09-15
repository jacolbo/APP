import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;

export function isValidWebhookUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * POST the selection handoff to the studio's management software.
 *
 * The spec is literal about this: only HTTP 200 counts as delivered, so a 201
 * or a 302 is reported back to the client as a failure rather than a success.
 * There is no automatic retry — the client can press the button again, and a
 * silent retry risks the studio seeing the same selection twice.
 *
 * The target URL is set by the signed-in studio admin, never by the client,
 * so this is not an SSRF surface reachable from the gallery link.
 */
export async function sendWebhook({ url, payload, secret, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'PoseBoard-Webhook/1',
  };
  if (secret) {
    headers['x-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.status === 200,
      status: response.status,
      error: response.status === 200 ? null : `The photographer's system answered ${response.status}`,
    };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: timedOut
        ? "The photographer's system did not answer in time"
        : "Could not reach the photographer's system",
    };
  }
}
