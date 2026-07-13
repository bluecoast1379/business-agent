/**
 * Generic inbound webhook channel sample (works with any notification platform
 * that can POST JSON and sign the body):
 *   verify timestamped HMAC-SHA256 signature (secret from env) -> extract text
 *   -> route through the same handleMessage heartbeat -> format + truncate reply.
 * Mounted by http.js at POST /webhook only when WEBHOOK_SECRET is configured.
 *
 * Signature contract (replay-resistant):
 *   x-timestamp: <unix seconds>
 *   x-signature-256: sha256=HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 * Requests older/newer than toleranceSeconds (default 300) are rejected, so a
 * captured request cannot be replayed later. Senders must sign timestamp+body.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Constant-time, timestamped HMAC-SHA256 check. Accepts an optional "sha256=" prefix. */
export function verifySignature({ payload, signature, timestamp, secret, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() }) {
  if (!signature || !secret || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return false; // replay window
  const presented = String(signature).replace(/^sha256=/, '');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Channel formatter interface: shape + truncate an agent reply for one channel.
 * Replace with per-channel markdown/plain-text rules as needed.
 */
export function createFormatter({ maxLength = 1500, suffix = '\n…(truncated)' } = {}) {
  return (text) => {
    const s = String(text ?? '');
    return s.length <= maxLength ? s : s.slice(0, maxLength - suffix.length) + suffix;
  };
}

/**
 * @param {object} opts
 * @param {string} opts.secret - HMAC secret (from env; never hardcode)
 * @param {(sessionId: string, message: string) => Promise<{text: string}>} opts.handleMessage
 * @param {(text: string) => string} [opts.formatter]
 * @returns {(rawBody: string, headers: object) => Promise<{status: number, body: object}>}
 */
export function createWebhookHandler({ secret, handleMessage, formatter = createFormatter() }) {
  return async function handleInbound(rawBody, headers = {}) {
    const signature = headers['x-signature-256'] ?? headers['x-signature'];
    const timestamp = headers['x-timestamp'];
    if (!verifySignature({ payload: rawBody, signature, timestamp, secret })) {
      return { status: 401, body: { error: 'invalid or expired signature', hint: 'sign HMAC-SHA256(secret, `${x-timestamp}.${body}`) with x-timestamp within 300s of now' } };
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'body must be JSON' } };
    }

    const message = payload.message ?? payload.text;
    if (!message || typeof message !== 'string') {
      return { status: 400, body: { error: 'missing "message" (or "text") field' } };
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'webhook-default';

    const result = await handleMessage(sessionId, message);
    return { status: 200, body: { sessionId, reply: formatter(result.text) } };
  };
}
