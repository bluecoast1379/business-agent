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
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_REPLAY_RECORDS = 10_000;
const REPLAY_KEY_PREFIX = 'webhook:';
const RECONCILIATION_ACKNOWLEDGEMENTS = Object.freeze({
  retry: 'I_VERIFIED_RETRY_IS_SAFE',
  forget: 'I_ACCEPT_DUPLICATE_DELIVERY_RISK',
  'mark-committed': 'I_VERIFIED_SIDE_EFFECT_COMMITTED',
});

function combineAbortSignals(primary, secondary) {
  if (!secondary) return primary;
  if (!primary) return secondary;
  return AbortSignal.any([primary, secondary]);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}

function waitForSettlement(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function createWebhookReplayStore({
  stateStore,
  now = Date.now,
  maxRecords = DEFAULT_MAX_REPLAY_RECORDS,
} = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
    throw new TypeError('[webhook] maxRecords must be an integer between 1 and 1000000');
  }
  const memory = new Map();
  // Full business responses are deliberately process-local. Durable replay
  // evidence contains only digests, so a state snapshot, backup, or support
  // export cannot disclose the agent reply. A duplicate can receive the exact
  // response only while this process still owns the ephemeral cache.
  const responseCache = new Map();
  const inFlight = new Map();
  const claimLocks = new Map();

  function keyFor(integrationId, eventId) {
    return `${REPLAY_KEY_PREFIX}${createHash('sha256').update(JSON.stringify([integrationId, eventId])).digest('hex')}`;
  }

  function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  function responseDigest(response) {
    return createHash('sha256').update(JSON.stringify(response)).digest('hex');
  }

  function registerInFlight(key, payloadHash, expiresAt) {
    const existing = inFlight.get(key);
    if (existing?.payloadHash === payloadHash) return existing.promise;
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const timeoutMs = Math.max(1, Math.min(2_147_483_647, expiresAt - now()));
    const timer = setTimeout(() => {
      const current = inFlight.get(key);
      if (current?.promise !== promise) return;
      inFlight.delete(key);
      settle({ status: 'unknown' });
    }, timeoutMs);
    timer.unref?.();
    inFlight.set(key, { payloadHash, promise, settle, timer });
    return promise;
  }

  function settleInFlight(key, payloadHash, outcome) {
    const pending = inFlight.get(key);
    if (!pending || pending.payloadHash !== payloadHash) return;
    clearTimeout(pending.timer);
    inFlight.delete(key);
    pending.settle(clone(outcome));
  }

  async function withClaimLock(key, operation) {
    const previous = claimLocks.get(key) ?? Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    claimLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (claimLocks.get(key) === current) claimLocks.delete(key);
    }
  }

  function describe(value, key) {
    if (!value || !['running', 'committed', 'failed', 'unknown'].includes(value.status)) {
      return { claimed: false, status: 'unknown' };
    }
    if (value.status === 'committed') {
      const cached = responseCache.get(key);
      const cacheMatches = cached
        && cached.payloadHash === value.payloadHash
        && cached.responseDigest === value.responseDigest;
      return {
        claimed: false,
        status: 'committed',
        ...(cacheMatches
          ? { response: clone(cached.response) }
          : { reconciliationRequired: true }),
      };
    }
    if (value.status === 'running') {
      const pending = inFlight.get(key);
      return {
        claimed: false,
        status: 'running',
        ...(pending?.payloadHash === value.payloadHash ? { waitForResponse: pending.promise } : {}),
      };
    }
    return {
      claimed: false,
      status: value.status,
    };
  }

  function decideClaim(existing, payloadHash, claimedAt, key) {
    if (!existing) return { action: 'claim' };
    if (typeof existing.payloadHash !== 'string') {
      return { action: 'return', result: { claimed: false, status: 'unknown' } };
    }
    if (existing.payloadHash !== payloadHash) {
      return { action: 'return', result: { claimed: false, status: 'conflict' } };
    }
    if (existing.status === 'failed') return { action: 'claim' };
    if (existing.status === 'running' && (!Number.isFinite(existing.expiresAt) || existing.expiresAt <= claimedAt)) {
      return {
        action: 'expire-running',
        value: {
          status: 'unknown',
          payloadHash,
          errorCode: 'WEBHOOK_RUNNING_EXPIRED',
          failedAt: claimedAt,
        },
      };
    }
    return { action: 'return', result: describe(existing, key) };
  }

  function publicRecord(value) {
    if (!value || !['running', 'committed', 'failed', 'unknown'].includes(value.status)) return null;
    return {
      status: value.status,
      payloadHash: value.payloadHash,
      ...(Number.isFinite(value.claimedAt) ? { claimedAt: value.claimedAt } : {}),
      ...(Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
      ...(Number.isFinite(value.committedAt) ? { committedAt: value.committedAt } : {}),
      ...(Number.isFinite(value.failedAt) ? { failedAt: value.failedAt } : {}),
      ...(Number.isFinite(value.reconciledAt) ? { reconciledAt: value.reconciledAt } : {}),
      ...(Number.isInteger(value.attempts) ? { attempts: value.attempts } : {}),
      ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
      ...(typeof value.responseDigest === 'string' ? { responseDigest: value.responseDigest } : {}),
      ...(Number.isInteger(value.responseStatus) ? { responseStatus: value.responseStatus } : {}),
      ...(typeof value.reconciliationDigest === 'string'
        ? { reconciliationDigest: value.reconciliationDigest }
        : {}),
    };
  }

  function countTransactionRecords(tx) {
    let cursor = null;
    let count = 0;
    do {
      const page = tx.list('idempotency', { prefix: REPLAY_KEY_PREFIX, cursor, limit: 1_000 });
      count += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return count;
  }

  async function transition({ integrationId, eventId, ownerId, payloadHash, value }) {
    const key = keyFor(integrationId, eventId);
    if (!stateStore) {
      const current = memory.get(key);
      if (current?.status !== 'running' || current.ownerId !== ownerId || current.payloadHash !== payloadHash) return false;
      memory.set(key, { ...clone(value), ...(Number.isInteger(current.attempts) ? { attempts: current.attempts } : {}) });
      return true;
    }
    return stateStore.transaction(async (tx) => {
      const current = tx.get('idempotency', key);
      if (current?.value?.status !== 'running' || current.value.ownerId !== ownerId || current.value.payloadHash !== payloadHash) return false;
      tx.put('idempotency', key, {
        ...value,
        ...(Number.isInteger(current.value.attempts) ? { attempts: current.value.attempts } : {}),
      }, { ifRevision: current.revision });
      return true;
    });
  }

  return Object.freeze({
    async claim({ integrationId, eventId, payloadHash, ttlMs }) {
      if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new TypeError('[webhook] payloadHash must be a SHA-256 hex digest');
      const key = keyFor(integrationId, eventId);
      return withClaimLock(key, async () => {
        const claimedAt = now();
        const ownerId = randomUUID();
        if (!stateStore) {
          const existing = memory.get(key);
          const decision = decideClaim(existing, payloadHash, claimedAt, key);
          if (decision.action === 'return') return decision.result;
          if (decision.action === 'expire-running') {
            memory.set(key, decision.value);
            settleInFlight(key, payloadHash, { status: 'unknown' });
            return { claimed: false, status: 'unknown' };
          }
          if (!existing && memory.size >= maxRecords) {
            return { claimed: false, status: 'capacity', reconciliationRequired: true };
          }
          const running = {
            status: 'running',
            ownerId,
            payloadHash,
            claimedAt,
            expiresAt: claimedAt + ttlMs,
            attempts: (existing?.attempts ?? 0) + 1,
          };
          memory.set(key, running);
          registerInFlight(key, payloadHash, running.expiresAt);
          return { claimed: true, status: 'running', ownerId };
        }
        const outcome = await stateStore.transaction(async (tx) => {
          const existing = tx.get('idempotency', key);
          const decision = decideClaim(existing?.value, payloadHash, claimedAt, key);
          if (decision.action === 'return') return decision.result;
          if (decision.action === 'expire-running') {
            tx.put('idempotency', key, decision.value, { ifRevision: existing.revision });
            return { claimed: false, status: 'unknown' };
          }
          if (!existing && countTransactionRecords(tx) >= maxRecords) {
            return { claimed: false, status: 'capacity', reconciliationRequired: true };
          }
          const running = {
            status: 'running',
            ownerId,
            payloadHash,
            claimedAt,
            expiresAt: claimedAt + ttlMs,
            attempts: (existing?.value?.attempts ?? 0) + 1,
          };
          tx.put('idempotency', key, running, existing ? { ifRevision: existing.revision } : { ifRevision: null });
          return { claimed: true, status: 'running', ownerId, expiresAt: running.expiresAt };
        });
        if (outcome.claimed) {
          registerInFlight(key, payloadHash, outcome.expiresAt);
          return { claimed: true, status: 'running', ownerId: outcome.ownerId };
        }
        if (outcome.status === 'unknown') settleInFlight(key, payloadHash, { status: 'unknown' });
        return outcome;
      });
    },

    async commit({ integrationId, eventId, ownerId, payloadHash, response }) {
      const committedAt = now();
      const digest = responseDigest(response);
      const committed = await transition({
        integrationId,
        eventId,
        ownerId,
        payloadHash,
        value: {
          status: 'committed',
          payloadHash,
          responseDigest: digest,
          responseStatus: response?.status,
          committedAt,
        },
      });
      if (committed) {
        responseCache.set(keyFor(integrationId, eventId), {
          payloadHash,
          responseDigest: digest,
          response: clone(response),
        });
        settleInFlight(keyFor(integrationId, eventId), payloadHash, { status: 'committed', response });
      } else {
        settleInFlight(keyFor(integrationId, eventId), payloadHash, { status: 'unknown' });
      }
      return committed;
    },

    async fail({ integrationId, eventId, ownerId, payloadHash, ttlMs, errorCode = 'WEBHOOK_FAILED', unknownOutcome = false }) {
      const failedAt = now();
      const failed = await transition({
        integrationId,
        eventId,
        ownerId,
        payloadHash,
        value: {
          status: unknownOutcome ? 'unknown' : 'failed',
          payloadHash,
          errorCode,
          failedAt,
          ...(unknownOutcome ? {} : { expiresAt: failedAt + ttlMs }),
        },
      });
      settleInFlight(
        keyFor(integrationId, eventId),
        payloadHash,
        { status: failed ? (unknownOutcome ? 'unknown' : 'failed') : 'unknown' },
      );
      return failed;
    },

    async get({ integrationId, eventId }) {
      const key = keyFor(integrationId, eventId);
      const value = stateStore
        ? (await stateStore.get('idempotency', key))?.value
        : memory.get(key);
      return clone(publicRecord(value));
    },

    async inspect({ integrationId, eventId }) {
      const key = keyFor(integrationId, eventId);
      const value = stateStore
        ? (await stateStore.get('idempotency', key))?.value
        : memory.get(key);
      return clone(publicRecord(value));
    },

    async reconcile({
      integrationId,
      eventId,
      action,
      expectedPayloadHash,
      expectedStatus,
      acknowledgement,
      evidenceDigest,
      retryTtlMs = 600_000,
    }) {
      if (!Object.hasOwn(RECONCILIATION_ACKNOWLEDGEMENTS, action)) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_ACTION_INVALID' };
      }
      if (!/^[0-9a-f]{64}$/.test(expectedPayloadHash ?? '')) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_PAYLOAD_HASH_REQUIRED' };
      }
      if (!['committed', 'unknown', 'failed'].includes(expectedStatus)) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_EXPECTED_STATUS_REQUIRED' };
      }
      if (acknowledgement !== RECONCILIATION_ACKNOWLEDGEMENTS[action]) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_ACKNOWLEDGEMENT_REQUIRED' };
      }
      if (action === 'mark-committed' && !/^[0-9a-f]{64}$/.test(evidenceDigest ?? '')) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_EVIDENCE_REQUIRED' };
      }
      if (!Number.isInteger(retryTtlMs) || retryTtlMs < 1 || retryTtlMs > 86_400_000) {
        return { ok: false, statusCode: 400, code: 'WEBHOOK_RECONCILIATION_RETRY_TTL_INVALID' };
      }
      const key = keyFor(integrationId, eventId);
      const reconciledAt = now();

      function mutate(current, revision, operations) {
        if (!current) return { ok: false, statusCode: 404, code: 'WEBHOOK_RECONCILIATION_NOT_FOUND' };
        if (current.payloadHash !== expectedPayloadHash) {
          return { ok: false, statusCode: 409, code: 'WEBHOOK_RECONCILIATION_EVIDENCE_MISMATCH' };
        }
        if (current.status !== expectedStatus) {
          return { ok: false, statusCode: 409, code: 'WEBHOOK_RECONCILIATION_STATE_CONFLICT' };
        }
        if (action === 'retry') {
          if (current.status !== 'unknown') {
            return { ok: false, statusCode: 409, code: 'WEBHOOK_RECONCILIATION_STATE_CONFLICT' };
          }
          const next = {
            status: 'failed',
            payloadHash: current.payloadHash,
            errorCode: 'WEBHOOK_OPERATOR_RETRY_APPROVED',
            failedAt: reconciledAt,
            reconciledAt,
            expiresAt: reconciledAt + retryTtlMs,
            ...(Number.isInteger(current.attempts) ? { attempts: current.attempts } : {}),
          };
          operations.put(next, revision);
          return { ok: true, action, record: publicRecord(next) };
        }
        if (action === 'mark-committed') {
          if (current.status !== 'unknown') {
            return { ok: false, statusCode: 409, code: 'WEBHOOK_RECONCILIATION_STATE_CONFLICT' };
          }
          const next = {
            status: 'committed',
            payloadHash: current.payloadHash,
            reconciliationDigest: evidenceDigest,
            committedAt: reconciledAt,
            reconciledAt,
            ...(Number.isInteger(current.attempts) ? { attempts: current.attempts } : {}),
          };
          operations.put(next, revision);
          return { ok: true, action, record: publicRecord(next) };
        }
        if (!['committed', 'unknown', 'failed'].includes(current.status)) {
          return { ok: false, statusCode: 409, code: 'WEBHOOK_RECONCILIATION_STATE_CONFLICT' };
        }
        operations.remove(revision);
        responseCache.delete(key);
        return { ok: true, action, removed: true };
      }

      if (!stateStore) {
        const current = memory.get(key);
        return mutate(current, null, {
          put(value) { memory.set(key, clone(value)); },
          remove() { memory.delete(key); },
        });
      }
      return stateStore.transaction(async (tx) => {
        const existing = tx.get('idempotency', key);
        return mutate(existing?.value, existing?.revision ?? null, {
          put(value, revision) { tx.put('idempotency', key, value, { ifRevision: revision }); },
          remove(revision) { tx.delete('idempotency', key, { ifRevision: revision }); },
        });
      });
    },

    async compact({ limit = 1_000 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError('[webhook] compact limit must be an integer between 1 and 1000');
      }
      const compactedAt = now();
      function eligible(value) {
        return value?.status === 'failed'
          && Number.isFinite(value.expiresAt)
          && value.expiresAt <= compactedAt;
      }
      if (!stateStore) {
        let scanned = 0;
        let removed = 0;
        for (const [key, value] of memory) {
          scanned += 1;
          if (removed < limit && eligible(value)) {
            memory.delete(key);
            responseCache.delete(key);
            removed += 1;
          }
        }
        return { scanned, removed };
      }
      return stateStore.transaction(async (tx) => {
        let cursor = null;
        let scanned = 0;
        const candidates = [];
        do {
          const page = tx.list('idempotency', { prefix: REPLAY_KEY_PREFIX, cursor, limit: 1_000 });
          for (const item of page.items) {
            scanned += 1;
            if (candidates.length < limit && eligible(item.value)) candidates.push(item);
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        for (const item of candidates) tx.delete('idempotency', item.key, { ifRevision: item.revision });
        return { scanned, removed: candidates.length };
      });
    },

    async capacity() {
      if (!stateStore) return { records: memory.size, maxRecords, full: memory.size >= maxRecords };
      const records = await stateStore.transaction(async (tx) => countTransactionRecords(tx));
      return { records, maxRecords, full: records >= maxRecords };
    },
  });
}

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

function safeErrorCode(error, fallback = 'WEBHOOK_ERROR') {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : typeof error?.name === 'string'
      ? error.name
      : '';
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate) ? candidate : fallback;
}

function retryableBeforeEffect(error, effectStarted) {
  return !effectStarted
    || error?.preEffect === true
    || error?.effectStarted === false
    || error?.sideEffectStarted === false
    || error?.outcome === 'pre-effect';
}

function responseStatus(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : null;
}

function isCachedResponse(value) {
  return value
    && Number.isInteger(value.status)
    && value.status >= 200
    && value.status <= 599
    && value.body
    && typeof value.body === 'object'
    && !Array.isArray(value.body);
}

/**
 * @param {object} opts
 * @param {string} opts.secret - HMAC secret (from env; never hardcode)
 * @param {(sessionId: string, message: string) => Promise<{text: string}>} opts.handleMessage
 * @param {(text: string) => string} [opts.formatter]
 * @returns {(rawBody: string, headers: object, context?: object) => Promise<{status: number, body: object}>}
 */
export function createWebhookHandler({
  secret,
  handleMessage,
  formatter = createFormatter(),
  integrationId = 'default',
  principal,
  replayStore = createWebhookReplayStore(),
  replayTtlSeconds = 600,
  quotaManager,
  audit,
  logger = console,
}) {
  const ttlMs = replayTtlSeconds * 1_000;
  const integrationResource = `webhook:${createHash('sha256').update(String(integrationId)).digest('hex').slice(0, 16)}`;
  const delegatesPreEffectAudit = handleMessage?.supportsPreEffectAudit === true;

  function logCode(message, error) {
    try { logger?.error?.(`[webhook] ${message} code=${safeErrorCode(error)}`); } catch {}
  }

  async function appendAudit(event) {
    try { await audit?.append?.(event); }
    catch (error) { logCode('audit append failed', error); }
  }

  async function startAudit(event) {
    if (typeof audit?.start === 'function') return audit.start(event);
    if (typeof audit?.append === 'function') {
      return audit.append({ ...event, outcome: 'started', metadata: { ...(event.metadata ?? {}), auditPhase: 'pre-effect' } });
    }
    return null;
  }

  return async function handleInbound(rawBody, headers = {}, context = {}) {
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
    const senderId = typeof payload.senderId === 'string' ? payload.senderId.trim() : '';
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    if (!senderId || !conversationId || !eventId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(eventId)) {
      return {
        status: 400,
        body: {
          error: 'signed body fields "eventId", "senderId" and "conversationId" are required',
          hint: 'derive all identifiers in the trusted webhook integration; eventId must be unique and 1-128 safe characters',
        },
      };
    }
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const eventIdHash = createHash('sha256').update(eventId).digest('hex');
    const claim = await replayStore.claim({ integrationId, eventId, payloadHash, ttlMs });
    if (!claim.claimed) {
      if (claim.status === 'running' && claim.waitForResponse) {
        const settlement = await waitForSettlement(claim.waitForResponse, context.signal);
        if (settlement.status === 'committed' && isCachedResponse(settlement.response)) {
          await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'coalesced', metadata: { eventIdHash } });
          return settlement.response;
        }
        if (settlement.status === 'failed') {
          await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'retry-required', metadata: { eventIdHash } });
          return {
            status: 409,
            body: {
              error: 'the in-flight webhook attempt failed before its effect; submit the signed event again',
              code: 'WEBHOOK_RETRY_REQUIRED',
            },
          };
        }
        await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'denied', metadata: { eventIdHash, replayState: 'unknown' } });
        return {
          status: 409,
          body: {
            error: 'webhook event outcome is unknown',
            code: 'WEBHOOK_OUTCOME_UNKNOWN',
            reconciliationRequired: true,
          },
        };
      }
      if (claim.status === 'committed' && isCachedResponse(claim.response)) {
        await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'cached', metadata: { eventIdHash } });
        return claim.response;
      }
      if (claim.status === 'capacity') {
        await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'denied', metadata: { eventIdHash, replayState: 'capacity' } });
        return {
          status: 503,
          body: {
            error: 'webhook replay ledger is at capacity; operator reconciliation is required',
            code: 'WEBHOOK_REPLAY_CAPACITY',
            reconciliationRequired: true,
          },
        };
      }
      if (claim.status === 'conflict') {
        await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'denied', metadata: { eventIdHash, replayState: 'conflict' } });
        return { status: 409, body: { error: 'webhook event id was reused with a different payload', code: 'WEBHOOK_EVENT_CONFLICT' } };
      }
      const inProgress = claim.status === 'running';
      const committedWithoutCache = claim.status === 'committed';
      await appendAudit({ actor: principal?.subjectId, tenant: principal?.tenantId, action: 'webhook.replay', resource: integrationResource, outcome: 'denied', metadata: { eventIdHash, replayState: inProgress ? 'running' : committedWithoutCache ? 'committed' : 'unknown' } });
      return inProgress
        ? { status: 409, body: { error: 'webhook event is already in progress', code: 'WEBHOOK_IN_PROGRESS' } }
        : committedWithoutCache
          ? {
              status: 409,
              body: {
                error: 'webhook event was committed but its private response is no longer in process memory',
                code: 'WEBHOOK_COMMITTED_RECONCILIATION_REQUIRED',
                reconciliationRequired: true,
              },
            }
          : { status: 409, body: { error: 'webhook event outcome is unknown', code: 'WEBHOOK_OUTCOME_UNKNOWN', reconciliationRequired: true } };
    }
    // Keep raw integration identifiers out of session keys while preserving a
    // deterministic namespace for one sender in one conversation.
    const identityDigest = createHash('sha256')
      .update(JSON.stringify([integrationId, senderId, conversationId]))
      .digest('hex');
    const sessionId = `webhook:${identityDigest}`;

    let release;
    let executionSignal = context.signal;
    let effectStarted = false;
    let auditStart;
    try {
      release = await quotaManager?.enter?.(principal);
      executionSignal = combineAbortSignals(context.signal, release?.signal);
      throwIfAborted(executionSignal);
      const beginWebhookEffect = async () => {
        auditStart = await startAudit({
          actor: principal?.subjectId,
          tenant: principal?.tenantId,
          action: 'webhook.receive',
          resource: integrationResource,
          metadata: { eventIdHash },
        });
        effectStarted = true;
        return auditStart;
      };
      // The production registry invokes this hook only after its atomic
      // monthly-budget reservation succeeds. Standalone/custom handlers do
      // not have that contract, so retain the conservative pre-call guard.
      if (!delegatesPreEffectAudit) await beginWebhookEffect();
      const result = await handleMessage(sessionId, message, {
        principal,
        signal: executionSignal,
        requestId: context.requestId ?? `webhook:${eventIdHash}`,
        operationId: context.operationId ?? randomUUID(),
        telemetryContext: context.telemetryContext,
        ...(delegatesPreEffectAudit ? { beforeEffectAudit: beginWebhookEffect } : {}),
      });
      if (result?.admitted === false) {
        // The registry rejected the request before provider/tool entry. Its
        // beforeEffectAudit hook was not invoked, so no audit slot is spent.
        effectStarted = false;
      }
      throwIfAborted(executionSignal);
      await release?.();
      release = null;
      throwIfAborted(executionSignal);
      const response = { status: 200, body: { sessionId, reply: formatter(result.text) } };
      let committed = false;
      try {
        committed = await replayStore.commit({ integrationId, eventId, ownerId: claim.ownerId, payloadHash, ttlMs, response });
      } catch (error) {
        logCode('replay commit failed', error);
      }
      if (!committed) {
        const error = Object.assign(new Error('Webhook completed but replay evidence could not be committed'), {
          code: 'WEBHOOK_REPLAY_OWNERSHIP_LOST',
          unknownOutcome: true,
        });
        try {
          await replayStore.fail({ integrationId, eventId, ownerId: claim.ownerId, payloadHash, ttlMs, errorCode: error.code, unknownOutcome: true });
        } catch (transitionError) {
          logCode('replay transition failed', transitionError);
        }
        throw error;
      }
      if (effectStarted) {
        await appendAudit({
          actor: principal?.subjectId,
          tenant: principal?.tenantId,
          action: 'webhook.complete',
          resource: integrationResource,
          outcome: 'ok',
          metadata: { auditStartId: auditStart?.id },
        });
      }
      return response;
    } catch (error) {
      const retryable = retryableBeforeEffect(error, effectStarted) && error?.unknownOutcome !== true;
      try {
        await replayStore.fail({
          integrationId,
          eventId,
          ownerId: claim.ownerId,
          payloadHash,
          ttlMs,
          errorCode: safeErrorCode(error),
          unknownOutcome: !retryable,
        });
      } catch (transitionError) {
        logCode('replay transition failed', transitionError);
      }
      if (effectStarted) {
        await appendAudit({
          actor: principal?.subjectId,
          tenant: principal?.tenantId,
          action: 'webhook.complete',
          resource: integrationResource,
          outcome: retryable ? 'failed' : 'unknown',
          metadata: { errorCode: safeErrorCode(error), auditStartId: auditStart?.id },
        });
      }
      const statusCode = responseStatus(error);
      if (statusCode) return { status: statusCode, body: { error: safeErrorCode(error, 'WEBHOOK_REQUEST_REJECTED') } };
      throw error;
    } finally {
      try { await release?.(); }
      catch (error) { logCode('quota release failed', error); }
    }
  };
}
