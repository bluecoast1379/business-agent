/**
 * Session storage with bounded retention, durable leases, and metadata-only
 * operator views. Conversation messages remain private to getOrCreate() and
 * setMessages(); management APIs never return a raw session id or message.
 */
import { createHash, randomUUID } from 'node:crypto';

const CHAT_SESSION_KEY_PREFIX = 'chat-session:';
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_RECORDS_LIMIT = 100_000;
const PAGE_LIMIT = 1_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const METADATA_STATUSES = new Set(['active', 'expired', 'leased']);
const RECONCILIATION_ACTIONS = new Set(['delete_expired', 'release_expired_lease']);

export class SessionStoreError extends Error {
  constructor(message, { code = 'SESSION_STORE_ERROR', statusCode, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SessionStoreError';
    this.code = code;
    this.retryable = false;
    if (statusCode) this.statusCode = statusCode;
  }
}

export class SessionCapacityError extends SessionStoreError {
  constructor(maxRecords) {
    super(`[session-store] capacity of ${maxRecords} sessions is exhausted; prune expired sessions before retrying`, {
      code: 'SESSION_CAPACITY',
      statusCode: 503,
    });
    this.name = 'SessionCapacityError';
  }
}

function sessionError(code, message, options) {
  return new SessionStoreError(`[session-store] ${message}`, { code, ...options });
}

function digestId(id) {
  return `sha256:${createHash('sha256').update(id, 'utf8').digest('hex')}`;
}

function assertSessionId(id) {
  if (typeof id !== 'string'
      || id.length < 1
      || id.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw sessionError('SESSION_ID_INVALID', 'id must be a non-empty printable string up to 1024 characters');
  }
  return id;
}

function persistentKey(id) {
  return `${CHAT_SESSION_KEY_PREFIX}${assertSessionId(id)}`;
}

function clockValue(now) {
  const value = now();
  if (!Number.isFinite(value)) throw sessionError('SESSION_CLOCK_INVALID', 'now() must return epoch milliseconds');
  return value;
}

function assertEpoch(value, label) {
  if (!Number.isFinite(value)) throw sessionError('SESSION_RECORD_CORRUPT', `${label} is invalid`);
}

function liveLease(session, at) {
  return session.lease !== null && session.lease.expiresAt > at;
}

function expiredSession(session, at, ttlMs) {
  return at - session.lastActiveAt > ttlMs && !liveLease(session, at);
}

function newSession(id, at) {
  return { id, messages: [], createdAt: at, lastActiveAt: at, lease: null };
}

function normalizeSession(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw sessionError('SESSION_RECORD_CORRUPT', 'session record must be an object');
  }
  const allowed = new Set(['id', 'messages', 'createdAt', 'lastActiveAt', 'lease']);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw sessionError('SESSION_RECORD_CORRUPT', 'session record has unexpected fields');
  }
  if (value.id !== expectedId || !Array.isArray(value.messages)) {
    throw sessionError('SESSION_RECORD_CORRUPT', 'session identity or messages are invalid');
  }
  assertEpoch(value.createdAt, 'createdAt');
  assertEpoch(value.lastActiveAt, 'lastActiveAt');
  const lease = value.lease ?? null;
  if (lease !== null
      && (!lease || typeof lease !== 'object' || Array.isArray(lease)
        || typeof lease.ownerId !== 'string' || !lease.ownerId
        || !Number.isFinite(lease.expiresAt))) {
    throw sessionError('SESSION_RECORD_CORRUPT', 'session lease is invalid');
  }
  return { ...structuredClone(value), lease: lease === null ? null : { ...lease } };
}

function normalizeStoredRecord(record) {
  if (!record?.key?.startsWith(CHAT_SESSION_KEY_PREFIX)
      || !Number.isInteger(record.revision)
      || record.revision < 1) {
    throw sessionError('SESSION_RECORD_CORRUPT', 'stored session metadata is invalid');
  }
  const id = record.key.slice(CHAT_SESSION_KEY_PREFIX.length);
  assertSessionId(id);
  return { ...record, value: normalizeSession(record.value, id) };
}

function abortableWait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Trim history to at most maxMessages, cutting only at a clean user-text turn
 *  so tool_use/tool_result pairs are never orphaned. */
function trimMessages(messages, maxMessages) {
  if (!Array.isArray(messages)) throw sessionError('SESSION_MESSAGES_INVALID', 'messages must be an array');
  if (messages.length <= maxMessages) return messages;
  for (let i = messages.length - maxMessages; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'user' && typeof message.content === 'string') return messages.slice(i);
  }
  return []; // no clean boundary found: start fresh rather than send a broken transcript
}

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw sessionError('SESSION_LIMIT_INVALID', `limit must be an integer between 1 and ${PAGE_LIMIT}`);
  }
}

function parseBefore(before) {
  const value = typeof before === 'string' ? Date.parse(before) : before;
  if (!Number.isFinite(value)) throw sessionError('SESSION_PRUNE_BEFORE_INVALID', 'before must be epoch milliseconds or an ISO timestamp');
  return value;
}

function sessionStatus(session, at, ttlMs) {
  if (liveLease(session, at)) return 'leased';
  if (expiredSession(session, at, ttlMs)) return 'expired';
  return 'active';
}

function metadata(record, session, at, ttlMs) {
  return {
    idDigest: digestId(session.id),
    revision: record.revision,
    status: sessionStatus(session, at, ttlMs),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.lastActiveAt + ttlMs,
    messageCount: session.messages.length,
    leaseActive: liveLease(session, at),
    leaseExpiresAt: session.lease?.expiresAt ?? null,
  };
}

function validateMetadataOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw sessionError('SESSION_METADATA_OPTIONS_INVALID', 'metadata options must be an object');
  }
  const allowed = new Set(['cursor', 'limit', 'status']);
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw sessionError('SESSION_METADATA_OPTIONS_INVALID', 'metadata options contain unsupported fields');
  }
  const cursor = options.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || !DIGEST_PATTERN.test(cursor))) {
    throw sessionError('SESSION_METADATA_CURSOR_INVALID', 'cursor must be a session digest');
  }
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const status = options.status ?? null;
  if (status !== null && !METADATA_STATUSES.has(status)) {
    throw sessionError('SESSION_METADATA_STATUS_INVALID', 'metadata status filter is invalid');
  }
  return { cursor, limit, status };
}

function listMetadataFromRecords(records, { cursor, limit, status }, at, ttlMs) {
  let afterCursor = cursor === null;
  let cursorFound = cursor === null;
  const selected = [];
  for (const record of records) {
    const item = metadata(record, record.value, at, ttlMs);
    if (!afterCursor) {
      if (item.idDigest === cursor) {
        afterCursor = true;
        cursorFound = true;
      }
      continue;
    }
    if (status === null || item.status === status) selected.push(item);
    if (selected.length > limit) break;
  }
  if (!cursorFound) throw sessionError('SESSION_METADATA_CURSOR_STALE', 'metadata cursor no longer exists');
  const hasMore = selected.length > limit;
  if (hasMore) selected.pop();
  return { items: selected, nextCursor: hasMore ? selected.at(-1).idDigest : null };
}

function validateConfiguration({ ttlMs, sweepIntervalMs, maxMessages, maxRecords, now }) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw sessionError('SESSION_TTL_INVALID', 'ttlMs must be a positive integer');
  if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw sessionError('SESSION_SWEEP_INTERVAL_INVALID', 'sweepIntervalMs must be a positive integer');
  }
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10_000) {
    throw sessionError('SESSION_MAX_MESSAGES_INVALID', 'maxMessages must be an integer between 1 and 10000');
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS_LIMIT) {
    throw sessionError('SESSION_MAX_RECORDS_INVALID', `maxRecords must be an integer between 1 and ${MAX_RECORDS_LIMIT}`);
  }
  if (typeof now !== 'function') throw sessionError('SESSION_CLOCK_INVALID', 'now must be a function');
}

export function createSessionStore({
  ttlMs = 30 * 60_000,
  sweepIntervalMs = 60_000,
  maxMessages = 40,
  maxRecords = DEFAULT_MAX_RECORDS,
  stateStore,
  now = Date.now,
} = {}) {
  validateConfiguration({ ttlMs, sweepIntervalMs, maxMessages, maxRecords, now });
  if (stateStore) {
    return createPersistentSessionStore({ ttlMs, sweepIntervalMs, maxMessages, maxRecords, stateStore, now });
  }

  const sessions = new Map();
  const revisions = new Map();
  const sessionLocks = new Map();
  let revision = 0;

  function bump(id) {
    revision += 1;
    revisions.set(id, revision);
    return revision;
  }

  function sweep(at = clockValue(now)) {
    assertEpoch(at, 'sweep timestamp');
    let removed = 0;
    for (const [id, session] of sessions) {
      if (!expiredSession(session, at, ttlMs)) continue;
      sessions.delete(id);
      revisions.delete(id);
      removed += 1;
    }
    return removed;
  }

  function ensureCapacity(at) {
    sweep(at);
    if (sessions.size >= maxRecords) throw new SessionCapacityError(maxRecords);
  }

  function getOrCreate(id) {
    assertSessionId(id);
    const at = clockValue(now);
    let session = sessions.get(id);
    if (!session || expiredSession(session, at, ttlMs)) {
      if (session) {
        sessions.delete(id);
        revisions.delete(id);
      }
      ensureCapacity(at);
      session = newSession(id, at);
      sessions.set(id, session);
    }
    session.lastActiveAt = at;
    bump(id);
    return session;
  }

  function setMessages(id, messages) {
    const session = getOrCreate(id);
    session.messages = trimMessages(messages, maxMessages);
    bump(id);
  }

  function records() {
    return [...sessions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => ({ key: persistentKey(id), revision: revisions.get(id), value }));
  }

  function listMetadata(options = {}) {
    const normalized = validateMetadataOptions(options);
    return listMetadataFromRecords(records(), normalized, clockValue(now), ttlMs);
  }

  function capacitySnapshot() {
    const at = clockValue(now);
    const counts = { active: 0, expired: 0, leased: 0 };
    for (const session of sessions.values()) counts[sessionStatus(session, at, ttlMs)] += 1;
    return {
      maxRecords,
      records: sessions.size,
      ...counts,
      available: Math.max(0, maxRecords - sessions.size),
      availableAfterExpiryPrune: Math.max(0, maxRecords - counts.active - counts.leased),
    };
  }

  function reconcile(idDigest, {
    action,
    expectedRevision,
    acknowledgeDataLoss = false,
    at = clockValue(now),
  } = {}) {
    if (typeof idDigest !== 'string' || !DIGEST_PATTERN.test(idDigest)) {
      throw sessionError('SESSION_RECONCILIATION_ID_INVALID', 'idDigest is invalid');
    }
    if (!RECONCILIATION_ACTIONS.has(action)) throw sessionError('SESSION_RECONCILIATION_ACTION_INVALID', 'action is invalid');
    const found = [...sessions.entries()].find(([id]) => digestId(id) === idDigest);
    if (!found) throw sessionError('SESSION_RECONCILIATION_NOT_FOUND', 'session was not found');
    const [id, session] = found;
    if (revisions.get(id) !== expectedRevision) throw sessionError('SESSION_RECONCILIATION_CONFLICT', 'session revision changed');
    if (action === 'release_expired_lease') {
      throw sessionError('SESSION_RECONCILIATION_STATE_INVALID', 'in-memory sessions do not use durable leases');
    }
    if (acknowledgeDataLoss !== true) {
      throw sessionError('SESSION_PRUNE_ACKNOWLEDGEMENT_REQUIRED', 'delete_expired requires acknowledgeDataLoss=true');
    }
    if (!expiredSession(session, at, ttlMs)) throw sessionError('SESSION_RECONCILIATION_STATE_INVALID', 'session is active');
    sessions.delete(id);
    revisions.delete(id);
    return { idDigest, deleted: true };
  }

  function prune({ before, limit = 100, acknowledgeDataLoss = false, at = clockValue(now) } = {}) {
    if (acknowledgeDataLoss !== true) throw sessionError('SESSION_PRUNE_ACKNOWLEDGEMENT_REQUIRED', 'prune requires acknowledgeDataLoss=true');
    assertLimit(limit);
    const beforeMs = parseBefore(before);
    let pruned = 0;
    for (const [id, session] of sessions) {
      if (pruned >= limit) break;
      if (!expiredSession(session, at, ttlMs) || session.lastActiveAt >= beforeMs) continue;
      sessions.delete(id);
      revisions.delete(id);
      pruned += 1;
    }
    return { pruned };
  }

  const timer = setInterval(() => sweep(), sweepIntervalMs);
  timer.unref?.();

  return {
    getOrCreate,
    setMessages,
    size: () => sessions.size,
    async withSessionLock(id, operation, { signal } = {}) {
      assertSessionId(id);
      const previous = sessionLocks.get(id) ?? Promise.resolve();
      const run = previous.then(() => {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        return operation({ signal, ownerId: `memory:${randomUUID()}` });
      });
      const tail = run.catch(() => {});
      sessionLocks.set(id, tail);
      try { return await run; }
      finally { if (sessionLocks.get(id) === tail) sessionLocks.delete(id); }
    },
    sweep,
    listMetadata,
    capacitySnapshot,
    reconcile,
    prune,
    close() {
      clearInterval(timer);
      sessions.clear();
      revisions.clear();
    },
  };
}

function createPersistentSessionStore({ ttlMs, sweepIntervalMs, maxMessages, maxRecords, stateStore, now }) {
  for (const method of ['get', 'put', 'delete', 'list', 'transaction']) {
    if (typeof stateStore?.[method] !== 'function') throw sessionError('SESSION_STORE_INVALID', `stateStore is missing ${method}()`);
  }

  function visit(tx, visitor) {
    let cursor = null;
    do {
      const page = tx.list('session', { prefix: CHAT_SESSION_KEY_PREFIX, cursor, limit: PAGE_LIMIT });
      for (const rawRecord of page.items) {
        const record = normalizeStoredRecord(rawRecord);
        if (visitor(record) === false) return;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  function ensureCapacity(tx, at, { preserveKey = null } = {}) {
    let retained = 0;
    visit(tx, (record) => {
      if (expiredSession(record.value, at, ttlMs)) {
        // An expired record being renewed can reuse its own physical slot, but
        // it must not bypass the limit when maxRecords active sessions already
        // exist. Keep that key until the caller's CAS replacement below.
        if (record.key !== preserveKey) {
          tx.delete('session', record.key, { ifRevision: record.revision });
        }
      } else {
        retained += 1;
      }
    });
    if (retained >= maxRecords) throw new SessionCapacityError(maxRecords);
  }

  async function getOrCreate(id) {
    assertSessionId(id);
    return stateStore.transaction((tx) => {
      const at = clockValue(now);
      const key = persistentKey(id);
      const record = tx.get('session', key);
      let session;
      if (!record) {
        ensureCapacity(tx, at);
        session = newSession(id, at);
      } else {
        const current = normalizeStoredRecord(record).value;
        if (expiredSession(current, at, ttlMs)) {
          ensureCapacity(tx, at, { preserveKey: key });
          session = newSession(id, at);
        } else {
          session = { ...current, lastActiveAt: at };
        }
      }
      tx.put('session', key, session, record ? { ifRevision: record.revision } : { ifRevision: null });
      return structuredClone(session);
    });
  }

  async function setMessages(id, messages) {
    assertSessionId(id);
    return stateStore.transaction((tx) => {
      const at = clockValue(now);
      const key = persistentKey(id);
      const record = tx.get('session', key);
      let session;
      if (!record) {
        ensureCapacity(tx, at);
        session = newSession(id, at);
      } else {
        const current = normalizeStoredRecord(record).value;
        if (expiredSession(current, at, ttlMs)) {
          ensureCapacity(tx, at, { preserveKey: key });
          session = newSession(id, at);
        } else {
          session = current;
        }
      }
      const next = { ...session, messages: trimMessages(messages, maxMessages), lastActiveAt: at };
      tx.put('session', key, next, record ? { ifRevision: record.revision } : { ifRevision: null });
      return structuredClone(next);
    });
  }

  async function sweep(at = clockValue(now)) {
    assertEpoch(at, 'sweep timestamp');
    return stateStore.transaction((tx) => {
      let removed = 0;
      visit(tx, (record) => {
        if (!expiredSession(record.value, at, ttlMs)) return;
        tx.delete('session', record.key, { ifRevision: record.revision });
        removed += 1;
      });
      return removed;
    });
  }

  async function size() {
    const at = clockValue(now);
    return stateStore.transaction((tx) => {
      let count = 0;
      visit(tx, (record) => { if (!expiredSession(record.value, at, ttlMs)) count += 1; });
      return count;
    });
  }

  async function listMetadata(options = {}) {
    const normalized = validateMetadataOptions(options);
    const at = clockValue(now);
    return stateStore.transaction((tx) => {
      const records = [];
      visit(tx, (record) => { records.push(record); });
      return listMetadataFromRecords(records, normalized, at, ttlMs);
    });
  }

  async function capacitySnapshot() {
    const at = clockValue(now);
    return stateStore.transaction((tx) => {
      const counts = { active: 0, expired: 0, leased: 0 };
      let records = 0;
      visit(tx, (record) => {
        records += 1;
        counts[sessionStatus(record.value, at, ttlMs)] += 1;
      });
      return {
        maxRecords,
        records,
        ...counts,
        available: Math.max(0, maxRecords - records),
        availableAfterExpiryPrune: Math.max(0, maxRecords - counts.active - counts.leased),
      };
    });
  }

  function findByDigest(tx, idDigest) {
    let found = null;
    visit(tx, (record) => {
      if (digestId(record.value.id) !== idDigest) return;
      if (found) throw sessionError('SESSION_RECONCILIATION_COLLISION', 'session digest is not unique');
      found = record;
    });
    return found;
  }

  async function reconcile(idDigest, {
    action,
    expectedRevision,
    acknowledgeDataLoss = false,
    at = clockValue(now),
  } = {}) {
    if (typeof idDigest !== 'string' || !DIGEST_PATTERN.test(idDigest)) {
      throw sessionError('SESSION_RECONCILIATION_ID_INVALID', 'idDigest is invalid');
    }
    if (!RECONCILIATION_ACTIONS.has(action)) throw sessionError('SESSION_RECONCILIATION_ACTION_INVALID', 'action is invalid');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw sessionError('SESSION_RECONCILIATION_REVISION_REQUIRED', 'expectedRevision must be a positive integer');
    }
    assertEpoch(at, 'reconciliation timestamp');
    return stateStore.transaction((tx) => {
      const record = findByDigest(tx, idDigest);
      if (!record) throw sessionError('SESSION_RECONCILIATION_NOT_FOUND', 'session was not found');
      if (record.revision !== expectedRevision) throw sessionError('SESSION_RECONCILIATION_CONFLICT', 'session revision changed');
      const session = record.value;
      if (action === 'release_expired_lease') {
        if (session.lease === null || session.lease.expiresAt > at) {
          throw sessionError('SESSION_RECONCILIATION_STATE_INVALID', 'session has no expired lease');
        }
        const written = tx.put('session', record.key, { ...session, lease: null }, { ifRevision: record.revision });
        return metadata(written, written.value, at, ttlMs);
      }
      if (acknowledgeDataLoss !== true) {
        throw sessionError('SESSION_PRUNE_ACKNOWLEDGEMENT_REQUIRED', 'delete_expired requires acknowledgeDataLoss=true');
      }
      if (!expiredSession(session, at, ttlMs)) throw sessionError('SESSION_RECONCILIATION_STATE_INVALID', 'session is active or leased');
      tx.delete('session', record.key, { ifRevision: record.revision });
      return { idDigest, deleted: true };
    });
  }

  async function prune({ before, limit = 100, acknowledgeDataLoss = false, at = clockValue(now) } = {}) {
    if (acknowledgeDataLoss !== true) throw sessionError('SESSION_PRUNE_ACKNOWLEDGEMENT_REQUIRED', 'prune requires acknowledgeDataLoss=true');
    assertLimit(limit);
    const beforeMs = parseBefore(before);
    assertEpoch(at, 'prune timestamp');
    return stateStore.transaction((tx) => {
      let pruned = 0;
      let skippedLeased = 0;
      visit(tx, (record) => {
        if (pruned >= limit) return false;
        if (liveLease(record.value, at)) {
          if (record.value.lastActiveAt < beforeMs) skippedLeased += 1;
          return;
        }
        if (!expiredSession(record.value, at, ttlMs) || record.value.lastActiveAt >= beforeMs) return;
        tx.delete('session', record.key, { ifRevision: record.revision });
        pruned += 1;
      });
      return { pruned, skippedLeased };
    });
  }

  async function withSessionLock(id, operation, {
    signal,
    leaseMs = 30_000,
    waitTimeoutMs = 60_000,
    retryMs = 25,
  } = {}) {
    assertSessionId(id);
    if (typeof operation !== 'function') throw sessionError('SESSION_OPERATION_INVALID', 'operation must be a function');
    if (!Number.isInteger(leaseMs) || leaseMs < 2
        || !Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1
        || !Number.isInteger(retryMs) || retryMs < 1) {
      throw sessionError('SESSION_LEASE_OPTIONS_INVALID', 'lease timing options are invalid');
    }
    const ownerId = randomUUID();
    const waitDeadline = Date.now() + waitTimeoutMs;

    async function claim() {
      return stateStore.transaction((tx) => {
        const at = clockValue(now);
        const key = persistentKey(id);
        const record = tx.get('session', key);
        let session;
        if (!record) {
          ensureCapacity(tx, at);
          session = newSession(id, at);
        } else {
          const current = normalizeStoredRecord(record).value;
          if (current.lease?.expiresAt > at && current.lease.ownerId !== ownerId) return false;
          if (expiredSession(current, at, ttlMs)) {
            ensureCapacity(tx, at, { preserveKey: key });
            session = newSession(id, at);
          } else {
            session = current;
          }
        }
        tx.put('session', key, {
          ...session,
          lastActiveAt: at,
          lease: { ownerId, expiresAt: at + leaseMs },
        }, record ? { ifRevision: record.revision } : { ifRevision: null });
        return true;
      });
    }

    while (!await claim()) {
      if (Date.now() >= waitDeadline) {
        const error = sessionError('SESSION_BUSY', 'timed out waiting for the session lease', { statusCode: 409 });
        error.retryable = true;
        throw error;
      }
      await abortableWait(retryMs, signal);
    }

    const leaseController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, leaseController.signal]) : leaseController.signal;
    let stopped = false;
    let heartbeatTimer;
    const heartbeatMs = Math.max(10, Math.floor(leaseMs / 3));

    async function renew() {
      if (stopped) return;
      try {
        const owned = await stateStore.transaction((tx) => {
          const at = clockValue(now);
          const key = persistentKey(id);
          const record = tx.get('session', key);
          if (record?.value?.lease?.ownerId !== ownerId) return false;
          const current = normalizeStoredRecord(record).value;
          tx.put('session', key, { ...current, lease: { ownerId, expiresAt: at + leaseMs } }, { ifRevision: record.revision });
          return true;
        });
        if (!owned) {
          const error = sessionError('SESSION_LEASE_LOST', 'session lease ownership lost');
          error.unknownOutcome = true;
          leaseController.abort(error);
          return;
        }
      } catch (error) {
        error.code ??= 'SESSION_LEASE_RENEW_FAILED';
        error.unknownOutcome = true;
        leaseController.abort(error);
        return;
      }
      heartbeatTimer = setTimeout(() => void renew(), heartbeatMs);
      heartbeatTimer.unref?.();
    }
    heartbeatTimer = setTimeout(() => void renew(), heartbeatMs);
    heartbeatTimer.unref?.();

    try {
      const result = await operation({ signal: combined, ownerId });
      if (leaseController.signal.aborted) throw leaseController.signal.reason;
      return result;
    } finally {
      stopped = true;
      clearTimeout(heartbeatTimer);
      await stateStore.transaction((tx) => {
        const key = persistentKey(id);
        const record = tx.get('session', key);
        if (record?.value?.lease?.ownerId !== ownerId) return;
        const current = normalizeStoredRecord(record).value;
        tx.put('session', key, { ...current, lease: null }, { ifRevision: record.revision });
      }).catch(() => {});
    }
  }

  const timer = setInterval(() => void sweep().catch(() => {}), sweepIntervalMs);
  timer.unref?.();
  return {
    getOrCreate,
    setMessages,
    size,
    sweep,
    withSessionLock,
    listMetadata,
    capacitySnapshot,
    reconcile,
    prune,
    close() { clearInterval(timer); },
  };
}
