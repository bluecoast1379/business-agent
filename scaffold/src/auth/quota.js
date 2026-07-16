import { createHash, randomUUID } from 'node:crypto';

const QUOTA_NAMESPACE = 'idempotency';
const QUOTA_KEY_PREFIX = 'quota:';
const DEFAULT_CONCURRENCY_LEASE_MS = 15 * 60_000;

export class QuotaExceededError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = code;
    this.statusCode = 429;
  }
}

function quotaIdentity(principal) {
  return principal?.tenantId
    ? `tenant:${principal.tenantId}`
    : `subject:${principal?.subjectId ?? 'anonymous'}`;
}

function persistentKey(principal) {
  return `${QUOTA_KEY_PREFIX}${createHash('sha256').update(quotaIdentity(principal)).digest('hex')}`;
}

function assertPositiveLimit(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`[quota] ${label} must be a finite positive number`);
}

function leaseError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    unknownOutcome: true,
  });
}

function exposeLeaseSignal(release, signal) {
  Object.defineProperty(release, 'signal', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: signal,
  });
  return release;
}

function currentTime(now) {
  const value = Number(now());
  if (!Number.isFinite(value) || value < 0) throw new Error('[quota] now() must return a finite non-negative timestamp');
  return value;
}

function parsePersistentBucket(record, selected, current) {
  if (!record) return { tokens: selected.requestsPerMinute, refilledAt: current, leases: [] };
  const value = record.value;
  const valid = value
    && value.version === 1
    && Number.isFinite(value.tokens)
    && value.tokens >= 0
    && Number.isFinite(value.refilledAt)
    && value.refilledAt >= 0
    && Array.isArray(value.leases)
    && value.leases.every((lease) => lease
      && typeof lease.id === 'string'
      && /^[0-9a-f-]{36}$/i.test(lease.id)
      && Number.isFinite(lease.expiresAt)
      && lease.expiresAt >= 0);
  if (!valid) throw new Error('[quota] persistent quota state is invalid; refusing to reset limits');
  return {
    tokens: Math.min(selected.requestsPerMinute, value.tokens),
    refilledAt: value.refilledAt,
    leases: value.leases.filter((lease) => lease.expiresAt > current),
  };
}

function refill(bucket, selected, current) {
  const elapsed = Math.max(0, current - bucket.refilledAt);
  return Math.min(
    selected.requestsPerMinute,
    bucket.tokens + elapsed * selected.requestsPerMinute / 60_000,
  );
}

/**
 * Per-tenant request and concurrency quotas. Without stateStore this preserves
 * the original synchronous in-memory API. With stateStore, enter/snapshot and
 * the returned release callback are async and use one atomic transaction, so
 * same-host file-store processes share one authoritative bucket.
 */
export function createQuotaManager({
  requestsPerMinute = 60,
  concurrency = 8,
  tenantOverrides = {},
  concurrencyLeaseMs = DEFAULT_CONCURRENCY_LEASE_MS,
  leaseHeartbeatMs = Math.max(1, Math.floor(concurrencyLeaseMs / 3)),
  stateStore,
  now = Date.now,
} = {}) {
  assertPositiveLimit(requestsPerMinute, 'requestsPerMinute');
  assertPositiveLimit(concurrency, 'concurrency');
  assertPositiveLimit(concurrencyLeaseMs, 'concurrencyLeaseMs');
  if (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 1 || leaseHeartbeatMs >= concurrencyLeaseMs) {
    throw new Error('[quota] leaseHeartbeatMs must be an integer between 1 and concurrencyLeaseMs - 1');
  }
  const buckets = new Map();

  function limits(tenantId) {
    const override = tenantOverrides[tenantId] ?? {};
    const selected = {
      requestsPerMinute: override.requestsPerMinute ?? requestsPerMinute,
      concurrency: override.concurrency ?? concurrency,
    };
    assertPositiveLimit(selected.requestsPerMinute, `requestsPerMinute for ${tenantId}`);
    assertPositiveLimit(selected.concurrency, `concurrency for ${tenantId}`);
    return selected;
  }

  if (!stateStore) {
    function enter(principal) {
      const tenantId = principal?.tenantId ?? `subject:${principal?.subjectId ?? 'anonymous'}`;
      const selected = limits(tenantId);
      const current = currentTime(now);
      let bucket = buckets.get(tenantId);
      if (!bucket) bucket = { tokens: selected.requestsPerMinute, refilledAt: current, active: 0 };
      bucket.tokens = refill({ ...bucket, leases: [] }, selected, current);
      bucket.refilledAt = current;
      if (bucket.active >= selected.concurrency) throw new QuotaExceededError('Tenant concurrency limit reached', 'CONCURRENCY_LIMIT');
      if (bucket.tokens < 1) throw new QuotaExceededError('Tenant request rate exceeded', 'RATE_LIMIT');
      bucket.tokens -= 1;
      bucket.active += 1;
      buckets.set(tenantId, bucket);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        bucket.active = Math.max(0, bucket.active - 1);
      };
      return exposeLeaseSignal(release, new AbortController().signal);
    }

    return {
      enter,
      snapshot: (tenantId) => ({
        ...(buckets.get(tenantId) ?? { tokens: limits(tenantId).requestsPerMinute, active: 0 }),
        limits: limits(tenantId),
      }),
    };
  }

  async function enter(principal) {
    const tenantId = principal?.tenantId ?? `subject:${principal?.subjectId ?? 'anonymous'}`;
    const selected = limits(tenantId);
    const current = currentTime(now);
    const key = persistentKey(principal);
    const leaseId = randomUUID();

    await stateStore.transaction(async (tx) => {
      const record = tx.get(QUOTA_NAMESPACE, key);
      const bucket = parsePersistentBucket(record, selected, current);
      const tokens = refill(bucket, selected, current);
      if (bucket.leases.length >= selected.concurrency) {
        throw new QuotaExceededError('Tenant concurrency limit reached', 'CONCURRENCY_LIMIT');
      }
      if (tokens < 1) throw new QuotaExceededError('Tenant request rate exceeded', 'RATE_LIMIT');
      tx.put(QUOTA_NAMESPACE, key, {
        version: 1,
        tokens: tokens - 1,
        refilledAt: current,
        leases: [...bucket.leases, { id: leaseId, expiresAt: current + concurrencyLeaseMs }],
      }, record ? { ifRevision: record.revision } : { ifRevision: null });
    });

    const leaseController = new AbortController();
    let released = false;
    let stopped = false;
    let heartbeatTimer;

    function abortLease(error) {
      if (!leaseController.signal.aborted) leaseController.abort(error);
    }

    function scheduleHeartbeat() {
      if (stopped || leaseController.signal.aborted) return;
      heartbeatTimer = setTimeout(() => void renewLease(), leaseHeartbeatMs);
      heartbeatTimer.unref?.();
    }

    async function renewLease() {
      if (stopped || leaseController.signal.aborted) return;
      try {
        const owned = await stateStore.transaction(async (tx) => {
          const record = tx.get(QUOTA_NAMESPACE, key);
          if (!record) return false;
          const renewalTime = currentTime(now);
          const bucket = parsePersistentBucket(record, selected, renewalTime);
          const index = bucket.leases.findIndex((lease) => lease.id === leaseId);
          if (index < 0) return false;
          const leases = bucket.leases.map((lease, leaseIndex) => (
            leaseIndex === index ? { id: lease.id, expiresAt: renewalTime + concurrencyLeaseMs } : lease
          ));
          tx.put(QUOTA_NAMESPACE, key, {
            version: 1,
            tokens: bucket.tokens,
            refilledAt: bucket.refilledAt,
            leases,
          }, { ifRevision: record.revision });
          return true;
        });
        if (stopped) return;
        if (!owned) {
          abortLease(leaseError('QUOTA_LEASE_LOST', 'Tenant quota lease ownership was lost'));
          return;
        }
      } catch (error) {
        if (stopped) return;
        abortLease(leaseError('QUOTA_LEASE_RENEW_FAILED', 'Tenant quota lease heartbeat failed', error));
        return;
      }
      scheduleHeartbeat();
    }

    scheduleHeartbeat();
    const release = async () => {
      if (released) return false;
      released = true;
      stopped = true;
      clearTimeout(heartbeatTimer);
      try {
        const removed = await stateStore.transaction(async (tx) => {
          const record = tx.get(QUOTA_NAMESPACE, key);
          if (!record) return false;
          const currentReleaseTime = currentTime(now);
          const bucket = parsePersistentBucket(record, selected, currentReleaseTime);
          const leases = bucket.leases.filter((lease) => lease.id !== leaseId);
          if (leases.length === bucket.leases.length) return false;
          tx.put(QUOTA_NAMESPACE, key, {
            version: 1,
            tokens: bucket.tokens,
            refilledAt: bucket.refilledAt,
            leases,
          }, { ifRevision: record.revision });
          return true;
        });
        if (!removed) abortLease(leaseError('QUOTA_LEASE_LOST', 'Tenant quota lease ownership was lost before release'));
        return removed;
      } catch (error) {
        abortLease(leaseError('QUOTA_LEASE_RELEASE_FAILED', 'Tenant quota lease release failed', error));
        throw error;
      }
    };
    return exposeLeaseSignal(release, leaseController.signal);
  }

  async function snapshot(tenantId) {
    const principal = tenantId
      ? { tenantId }
      : { tenantId: null, subjectId: 'anonymous' };
    const selected = limits(tenantId ?? 'subject:anonymous');
    const current = currentTime(now);
    const record = await stateStore.get(QUOTA_NAMESPACE, persistentKey(principal));
    const bucket = parsePersistentBucket(record, selected, current);
    return {
      tokens: refill(bucket, selected, current),
      active: bucket.leases.length,
      limits: selected,
    };
  }

  return Object.freeze({ enter, snapshot });
}
