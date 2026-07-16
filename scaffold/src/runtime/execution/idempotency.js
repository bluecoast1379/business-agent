import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_RESULT_RETENTION_MS = 5 * 60_000;
const STORAGE_PREFIX = 'execution:';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function digest(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = Object.prototype.toString.call(value);
  }
  return createHash('sha256').update(serialized ?? String(value)).digest('hex');
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 4_096) {
    throw new TypeError('[idempotency] key must be a 1-4096 character string');
  }
}

function assertTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new TypeError('[idempotency] ttlMs must be a positive finite number');
  }
}

function publicRecord(value) {
  if (!value) return null;
  return {
    status: value.status,
    ownerId: value.ownerId,
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
    ...(value.committedAt !== undefined ? { committedAt: value.committedAt } : {}),
    ...(value.failedAt !== undefined ? { failedAt: value.failedAt } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
    ...(value.resultDigest !== undefined ? { resultDigest: value.resultDigest } : {}),
    ...(value.value !== undefined ? { value: clone(value.value) } : {}),
    ...(value.valueExpiresAt !== undefined ? { valueExpiresAt: value.valueExpiresAt } : {}),
    ...(value.compactedAt !== undefined ? { compactedAt: value.compactedAt } : {}),
  };
}

function listRecord(value) {
  const record = publicRecord(value);
  if (!record) return null;
  // Reconciliation listings are metadata-only even while a workflow has opted
  // into short-lived crash evidence. Full results are available solely to the
  // internal exact-key recovery path.
  delete record.value;
  delete record.ownerId;
  return record;
}

function compactExpired(value, at) {
  if (value?.status !== 'committed' || !Object.hasOwn(value, 'value')) return { value, changed: false };
  if (!Number.isFinite(value.valueExpiresAt) || value.valueExpiresAt > at) return { value, changed: false };
  const { value: _discarded, valueExpiresAt: _expiredAt, ...safe } = value;
  return {
    value: { ...safe, compactedAt: at },
    changed: true,
  };
}

function compactExpiredMemory(memory, at) {
  let compacted = 0;
  for (const [key, value] of memory) {
    const next = compactExpired(value, at);
    if (!next.changed) continue;
    memory.set(key, next.value);
    compacted += 1;
  }
  return compacted;
}

function compactExpiredTransaction(tx, namespace, at) {
  let cursor = null;
  let compacted = 0;
  do {
    const page = tx.list(namespace, { prefix: STORAGE_PREFIX, cursor, limit: 1_000 });
    for (const record of page.items) {
      const next = compactExpired(record.value, at);
      if (!next.changed) continue;
      tx.put(namespace, record.key, next.value, { ifRevision: record.revision });
      compacted += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return compacted;
}

function classifyExisting(value, at) {
  if (!value) return { action: 'claim' };
  if (value.status === 'committed' || value.status === 'unknown') {
    // A committed or ambiguous side effect must never become replayable merely
    // because retained response data was compacted. Only an explicit operator
    // reconciliation can remove this tombstone.
    return { action: 'block', value };
  }
  if (value.status === 'running') {
    return value.expiresAt > at
      ? { action: 'block', value }
      : { action: 'expire-running', value };
  }
  const error = new Error('[idempotency] persistent state is invalid; refusing to replay');
  error.code = 'IDEMPOTENCY_STATE_INVALID';
  error.unknownOutcome = true;
  throw error;
}

function expiredRunning(value, at) {
  return {
    status: 'unknown',
    ownerId: value.ownerId,
    errorCode: 'IDEMPOTENCY_LEASE_EXPIRED',
    failedAt: at,
  };
}

function capacityError(maxRecords) {
  const error = new Error(`Idempotency evidence capacity (${maxRecords}) is exhausted; reconcile existing records before accepting new side effects`);
  error.code = 'IDEMPOTENCY_CAPACITY';
  error.statusCode = 503;
  return error;
}

function reconciliationConflict() {
  const error = new Error('Idempotency evidence changed since it was inspected');
  error.code = 'IDEMPOTENCY_RECONCILIATION_CONFLICT';
  error.statusCode = 409;
  return error;
}

function assertExpectedRecord(value, {
  expectedStatus,
  expectedResultDigest,
  expectedErrorCode,
} = {}) {
  if (expectedStatus !== undefined && value?.status !== expectedStatus) throw reconciliationConflict();
  if (expectedResultDigest !== undefined && value?.resultDigest !== expectedResultDigest) throw reconciliationConflict();
  if (expectedErrorCode !== undefined && value?.errorCode !== expectedErrorCode) throw reconciliationConflict();
}

function storageKeyFor(key) {
  assertKey(key);
  return `${STORAGE_PREFIX}${createHash('sha256').update(key).digest('hex')}`;
}

function storageKeyForId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
    throw new TypeError('[idempotency] record id must be a SHA-256 hex digest');
  }
  return `${STORAGE_PREFIX}${id}`;
}

function countRecords(tx, stopAt) {
  let cursor = null;
  let total = 0;
  do {
    const page = tx.list('idempotency', { prefix: STORAGE_PREFIX, cursor, limit: Math.min(1_000, stopAt - total || 1) });
    total += page.items.length;
    cursor = page.nextCursor;
  } while (cursor && total < stopAt);
  return total;
}

/**
 * Durable idempotency evidence with privacy-preserving defaults.
 *
 * The persistent record is a non-replayable tombstone by default. Callers that
 * require short crash-recovery evidence must opt in with persistResult=true;
 * even then the full result is compacted after resultRetentionMs (or sooner via
 * compact()). Unknown and committed tombstones are only removed by an explicit
 * reconciliation action, so privacy retention never silently enables replay.
 */
export function createIdempotencyStore({
  stateStore,
  namespace = 'idempotency',
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  resultRetentionMs = DEFAULT_RESULT_RETENTION_MS,
} = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('[idempotency] maxRecords must be a positive integer');
  if (!Number.isFinite(resultRetentionMs) || resultRetentionMs < 0) throw new TypeError('[idempotency] resultRetentionMs must be a non-negative finite number');
  const memory = new Map();
  const inFlight = new Map();

  async function get(key) {
    const storageKey = storageKeyFor(key);
    const at = now();
    if (!stateStore) {
      const compacted = compactExpired(memory.get(storageKey), at);
      if (compacted.changed) memory.set(storageKey, compacted.value);
      return publicRecord(compacted.value);
    }
    return stateStore.transaction(async (tx) => {
      const record = tx.get(namespace, storageKey);
      if (!record) return null;
      const compacted = compactExpired(record.value, at);
      if (compacted.changed) tx.put(namespace, storageKey, compacted.value, { ifRevision: record.revision });
      return publicRecord(compacted.value);
    });
  }

  async function claim(key, ttlMs, ownerId) {
    assertTtl(ttlMs);
    const storageKey = storageKeyFor(key);
    const startedAt = now();
    const running = { status: 'running', ownerId, startedAt, expiresAt: startedAt + ttlMs };
    if (!stateStore) {
      compactExpiredMemory(memory, startedAt);
      const compacted = compactExpired(memory.get(storageKey), startedAt);
      if (compacted.changed) memory.set(storageKey, compacted.value);
      const existing = compacted.value;
      const decision = classifyExisting(existing, startedAt);
      if (decision.action === 'block') return { claimed: false, existing: publicRecord(existing) };
      if (decision.action === 'expire-running') {
        const unknown = expiredRunning(existing, startedAt);
        memory.set(storageKey, unknown);
        return { claimed: false, existing: publicRecord(unknown) };
      }
      if (memory.size >= maxRecords) throw capacityError(maxRecords);
      memory.set(storageKey, clone(running));
      return { claimed: true };
    }
    return stateStore.transaction(async (tx) => {
      // Sweep every retained result, not just the key being claimed. One-shot
      // request keys are the common case and may never be read again.
      compactExpiredTransaction(tx, namespace, startedAt);
      let record = tx.get(namespace, storageKey);
      const compacted = compactExpired(record?.value, startedAt);
      if (record && compacted.changed) record = tx.put(namespace, storageKey, compacted.value, { ifRevision: record.revision });
      const decision = classifyExisting(compacted.value, startedAt);
      if (decision.action === 'block') return { claimed: false, existing: publicRecord(compacted.value) };
      if (decision.action === 'expire-running') {
        const unknown = expiredRunning(compacted.value, startedAt);
        tx.put(namespace, storageKey, unknown, { ifRevision: record.revision });
        return { claimed: false, existing: publicRecord(unknown) };
      }
      if (countRecords(tx, maxRecords) >= maxRecords) throw capacityError(maxRecords);
      tx.put(namespace, storageKey, running, record ? { ifRevision: record.revision } : { ifRevision: null });
      return { claimed: true };
    });
  }

  async function complete(key, ownerId, value, ttlMs, persistResult) {
    const at = now();
    const storageKey = storageKeyFor(key);
    const committed = {
      status: 'committed',
      ownerId,
      resultDigest: digest(value),
      committedAt: at,
      ...(persistResult && resultRetentionMs > 0
        ? { value: clone(value), valueExpiresAt: Math.min(at + ttlMs, at + resultRetentionMs) }
        : { compactedAt: at }),
    };
    if (!stateStore) {
      if (!['running', 'unknown'].includes(memory.get(storageKey)?.status) || memory.get(storageKey)?.ownerId !== ownerId) return false;
      memory.set(storageKey, committed);
      return true;
    }
    return stateStore.transaction(async (tx) => {
      const record = tx.get(namespace, storageKey);
      if (!['running', 'unknown'].includes(record?.value?.status) || record.value.ownerId !== ownerId) return false;
      tx.put(namespace, storageKey, committed, { ifRevision: record.revision });
      return true;
    });
  }

  async function fail(key, ownerId, error) {
    const storageKey = storageKeyFor(key);
    if (!stateStore) {
      if (memory.get(storageKey)?.ownerId !== ownerId) return;
      if (error?.unknownOutcome) memory.set(storageKey, { status: 'unknown', ownerId, errorCode: error.code || 'UNKNOWN', failedAt: now() });
      else memory.delete(storageKey);
      return;
    }
    await stateStore.transaction(async (tx) => {
      const record = tx.get(namespace, storageKey);
      if (record?.value?.ownerId !== ownerId) return;
      if (error?.unknownOutcome) {
        tx.put(namespace, storageKey, { status: 'unknown', ownerId, errorCode: error.code || 'UNKNOWN', failedAt: now() }, { ifRevision: record.revision });
      } else tx.delete(namespace, storageKey, { ifRevision: record.revision });
    });
  }

  async function compactStorageKey(storageKey, expected = {}) {
    const at = now();
    const redact = (value) => {
      if (value?.status !== 'committed' || !Object.hasOwn(value, 'value')) return { value, changed: false };
      const { value: _discarded, valueExpiresAt: _expiredAt, ...safe } = value;
      return { value: { ...safe, compactedAt: at }, changed: true };
    };
    if (!stateStore) {
      const existing = memory.get(storageKey);
      assertExpectedRecord(existing, expected);
      const next = redact(existing);
      if (next.changed) memory.set(storageKey, next.value);
      return next.changed;
    }
    return stateStore.transaction(async (tx) => {
      const record = tx.get(namespace, storageKey);
      assertExpectedRecord(record?.value, expected);
      const next = redact(record?.value);
      if (record && next.changed) tx.put(namespace, storageKey, next.value, { ifRevision: record.revision });
      return next.changed;
    });
  }


  async function compact(key) {
    return compactStorageKey(storageKeyFor(key));
  }

  async function compactById(id) {
    return compactStorageKey(storageKeyForId(id));
  }

  async function compactExpiredResults() {
    const at = now();
    if (!stateStore) return { compacted: compactExpiredMemory(memory, at) };
    return stateStore.transaction(async (tx) => ({
      compacted: compactExpiredTransaction(tx, namespace, at),
    }));
  }

  async function reconcileStorageKey(storageKey, {
    resolution,
    expectedStatus,
    expectedResultDigest,
    expectedErrorCode,
  } = {}) {
    if (!['retry', 'forget', 'compact'].includes(resolution)) {
      throw new TypeError('[idempotency] resolution must be retry, forget, or compact');
    }
    if (expectedStatus !== undefined && !['committed', 'unknown'].includes(expectedStatus)) {
      throw new TypeError('[idempotency] expectedStatus must be committed or unknown');
    }
    if (expectedResultDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedResultDigest)) {
      throw new TypeError('[idempotency] expectedResultDigest must be a SHA-256 hex digest');
    }
    if (expectedErrorCode !== undefined && (typeof expectedErrorCode !== 'string' || !/^[A-Z0-9_:-]{1,128}$/.test(expectedErrorCode))) {
      throw new TypeError('[idempotency] expectedErrorCode must be a stable error code');
    }
    const expected = { expectedStatus, expectedResultDigest, expectedErrorCode };
    if (resolution === 'compact') return compactStorageKey(storageKey, expected);
    const remove = (value) => {
      if (!value) return false;
      assertExpectedRecord(value, expected);
      if (value.status === 'running') {
        const error = new Error('A running idempotency claim cannot be reconciled');
        error.code = 'IDEMPOTENCY_IN_PROGRESS';
        error.statusCode = 409;
        throw error;
      }
      return true;
    };
    if (!stateStore) {
      if (!remove(memory.get(storageKey))) return false;
      memory.delete(storageKey);
      return true;
    }
    return stateStore.transaction(async (tx) => {
      const record = tx.get(namespace, storageKey);
      if (!remove(record?.value)) return false;
      tx.delete(namespace, storageKey, { ifRevision: record.revision });
      return true;
    });
  }

  async function reconcile(key, options) {
    return reconcileStorageKey(storageKeyFor(key), options);
  }

  async function reconcileById(id, options) {
    return reconcileStorageKey(storageKeyForId(id), options);
  }

  async function list({ cursor = null, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('[idempotency] limit must be 1-1000');
    const at = now();
    const listPage = stateStore
      ? await stateStore.transaction(async (tx) => {
          compactExpiredTransaction(tx, namespace, at);
          return tx.list(namespace, { prefix: STORAGE_PREFIX, cursor: cursor ? `${STORAGE_PREFIX}${cursor}` : null, limit });
        })
      : (() => {
          compactExpiredMemory(memory, at);
          const keys = [...memory.keys()].filter((key) => key.startsWith(STORAGE_PREFIX) && (!cursor || key > `${STORAGE_PREFIX}${cursor}`)).sort();
          const selected = keys.slice(0, limit);
          return { items: selected.map((key) => ({ key, value: memory.get(key) })), nextCursor: keys.length > selected.length ? selected.at(-1) : null };
        })();
    return {
      items: listPage.items.map((item) => ({ id: item.key.slice(STORAGE_PREFIX.length), ...listRecord(item.value) })),
      nextCursor: listPage.nextCursor?.slice(STORAGE_PREFIX.length) ?? null,
    };
  }

  async function capacity() {
    if (!stateStore) {
      compactExpiredMemory(memory, now());
      const used = memory.size;
      return { used, maxRecords, available: Math.max(0, maxRecords - used) };
    }
    const used = await stateStore.transaction(async (tx) => {
      compactExpiredTransaction(tx, namespace, now());
      return countRecords(tx, maxRecords);
    });
    return { used, maxRecords, available: Math.max(0, maxRecords - used) };
  }

  async function run(key, operation, { ttlMs = 24 * 60 * 60_000, persistResult = false } = {}) {
    if (!key) return operation();
    assertKey(key);
    assertTtl(ttlMs);
    const storageKey = storageKeyFor(key);
    if (inFlight.has(storageKey)) {
      const result = await inFlight.get(storageKey);
      return { value: clone(result.value), deduplicated: true };
    }
    const promise = (async () => {
      const ownerId = randomUUID();
      const ownership = await claim(key, ttlMs, ownerId);
      if (!ownership.claimed) {
        const existing = ownership.existing;
        if (existing?.status === 'committed' && Object.hasOwn(existing, 'value')) {
          return { value: clone(existing.value), deduplicated: true };
        }
        const committed = existing?.status === 'committed';
        const error = new Error(existing?.status === 'running'
          ? 'An execution with this idempotency key is already in progress'
          : committed
            ? 'This execution was already committed; its response was compacted and requires reconciliation'
            : 'Previous execution has an unknown outcome and requires reconciliation');
        error.code = existing?.status === 'running'
          ? 'IDEMPOTENCY_IN_PROGRESS'
          : committed
            ? 'IDEMPOTENCY_COMMITTED'
            : 'IDEMPOTENCY_UNKNOWN';
        error.statusCode = 409;
        error.unknownOutcome = existing?.status !== 'running';
        throw error;
      }

      let value;
      try {
        value = await operation();
      } catch (error) {
        await fail(key, ownerId, error);
        throw error;
      }

      try {
        if (!await complete(key, ownerId, value, ttlMs, persistResult)) {
          const error = new Error('Idempotency ownership was lost before commit');
          error.code = 'IDEMPOTENCY_OWNERSHIP_LOST';
          error.unknownOutcome = true;
          throw error;
        }
        return { value, deduplicated: false };
      } catch (error) {
        // The side effect completed, but commit evidence did not. Never delete
        // the claim or allow an automatic replay in this state.
        error.unknownOutcome = true;
        await fail(key, ownerId, error).catch(() => {});
        throw error;
      }
    })();
    inFlight.set(storageKey, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(storageKey) === promise) inFlight.delete(storageKey);
    }
  }

  return Object.freeze({
    get,
    run,
    compact,
    compactById,
    compactExpired: compactExpiredResults,
    reconcile,
    reconcileById,
    list,
    capacity,
    storageKeyFor,
  });
}
