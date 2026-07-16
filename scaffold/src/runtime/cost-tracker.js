/**
 * In-memory monthly cost tracker. agent.js reports every LLM call here, so
 * /status and the scheduler budget guard read real numbers, not placeholders.
 * Swap for a persistent store if you need cost history across restarts.
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 60_000;

function monthKeyOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function reservationMonthKey(id, fallback) {
  return /^\d{4}-\d{2}:/.test(String(id)) ? String(id).slice(0, 7) : fallback;
}

function nonNegativeFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`[cost-tracker] ${label} must be a non-negative finite number`);
  }
  return value;
}

function tokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[cost-tracker] ${label} must be a non-negative safe integer`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new Error(`[cost-tracker] ${label} must be a 1-128 character string`);
  }
  return value;
}

function normalizeEvent({ agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0 } = {}) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('[cost-tracker] usage must be an object');
  }
  return {
    agent: identifier(agent, 'agent'),
    model: identifier(model, 'model'),
    usage: {
      input_tokens: tokenCount(usage.input_tokens ?? 0, 'usage.input_tokens'),
      output_tokens: tokenCount(usage.output_tokens ?? 0, 'usage.output_tokens'),
    },
    costUsd: nonNegativeFinite(costUsd, 'costUsd'),
  };
}

function reservationRemaining(reservation) {
  const used = reservation.events.reduce((sum, event) => sum + normalizeEvent(event).costUsd, 0);
  return reservation.amountUsd - used;
}

function assertReservationCapacity(reservation, event) {
  const normalized = normalizeEvent(event);
  const remaining = Math.max(0, reservationRemaining(reservation));
  if (normalized.costUsd > remaining + 1e-12) {
    const error = new Error('[cost-tracker] usage exceeds the amount reserved before provider entry');
    error.code = 'COST_RESERVATION_EXCEEDED';
    error.unknownOutcome = true;
    throw error;
  }
  return normalized;
}

function validateBucket(bucket) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('[cost-tracker] ledger bucket is corrupt');
  nonNegativeFinite(bucket.costUsd, 'ledger.costUsd');
  nonNegativeFinite(bucket.reservedUsd, 'ledger.reservedUsd');
  tokenCount(bucket.calls, 'ledger.calls');
  tokenCount(bucket.inputTokens, 'ledger.inputTokens');
  tokenCount(bucket.outputTokens, 'ledger.outputTokens');
  if (!bucket.byAgent || typeof bucket.byAgent !== 'object' || Array.isArray(bucket.byAgent)) throw new Error('[cost-tracker] ledger.byAgent is corrupt');
  if (!bucket.reservations || typeof bucket.reservations !== 'object' || Array.isArray(bucket.reservations)) throw new Error('[cost-tracker] ledger.reservations is corrupt');
  let reserved = 0;
  for (const reservation of Object.values(bucket.reservations)) {
    if (!reservation || typeof reservation !== 'object' || !Array.isArray(reservation.events)) throw new Error('[cost-tracker] ledger reservation is corrupt');
    if (!(reservation.amountUsd > 0) || !Number.isFinite(reservation.amountUsd)) throw new Error('[cost-tracker] ledger reservation amount is corrupt');
    if (reservation.createdAt !== undefined && (!Number.isFinite(reservation.createdAt) || reservation.createdAt < 0)) {
      throw new Error('[cost-tracker] ledger reservation createdAt is corrupt');
    }
    if (reservation.expiresAt !== undefined && (!Number.isFinite(reservation.expiresAt) || reservation.expiresAt < 0)) {
      throw new Error('[cost-tracker] ledger reservation expiresAt is corrupt');
    }
    if (reservation.effectStarted !== undefined && typeof reservation.effectStarted !== 'boolean') {
      throw new Error('[cost-tracker] ledger reservation effectStarted is corrupt');
    }
    if (reservation.startedAt !== undefined && (!Number.isFinite(reservation.startedAt) || reservation.startedAt < 0)) {
      throw new Error('[cost-tracker] ledger reservation startedAt is corrupt');
    }
    for (const event of reservation.events) normalizeEvent(event);
    if (reservationRemaining(reservation) < -1e-12) throw new Error('[cost-tracker] ledger reservation is overrun');
    reserved += reservation.amountUsd;
  }
  if (Math.abs(reserved - bucket.reservedUsd) > 1e-9) throw new Error('[cost-tracker] ledger reserved total is inconsistent');
  return bucket;
}

export function createCostTracker({
  stateStore,
  now = Date.now,
  reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
} = {}) {
  if (!Number.isInteger(reservationTtlMs) || reservationTtlMs < 1 || reservationTtlMs > 86_400_000) {
    throw new Error('[cost-tracker] reservationTtlMs must be an integer between 1 and 86400000');
  }
  if (stateStore) return createPersistentCostTracker({ stateStore, now, reservationTtlMs });
  /** monthKey -> { costUsd, reservedUsd, calls, inputTokens, outputTokens, byAgent } */
  const months = new Map();
  /** reservationId -> { id, monthKey, amountUsd, events } */
  const reservations = new Map();
  const month = () => monthKeyOf(new Date(now()));

  function bucket(monthKey) {
    let b = months.get(monthKey);
    if (!b) {
      b = { costUsd: 0, reservedUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byAgent: {} };
      months.set(monthKey, b);
    }
    return b;
  }

  function recordUsage(b, { agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0 }) {
    ({ agent, model, usage, costUsd } = normalizeEvent({ agent, model, usage, costUsd }));
    b.costUsd += costUsd;
    b.calls += 1;
    b.inputTokens += usage.input_tokens ?? 0;
    b.outputTokens += usage.output_tokens ?? 0;
    const byAgent = (b.byAgent[agent] ??= { costUsd: 0, calls: 0, models: {} });
    byAgent.costUsd += costUsd;
    byAgent.calls += 1;
    byAgent.models[model] = (byAgent.models[model] ?? 0) + 1;
  }

  function finalizeReservation(id, outcome) {
    const reservation = reservations.get(id);
    if (!reservation) return { ok: false, error: 'unknown_reservation' };
    reservations.delete(id);
    const b = bucket(reservation.monthKey);
    b.reservedUsd = Math.max(0, b.reservedUsd - reservation.amountUsd);
    for (const event of reservation.events) recordUsage(b, event);
    const actualCostUsd = reservation.events.reduce((sum, event) => sum + event.costUsd, 0);
    const conservative = outcome === 'unknown' || outcome === 'expired_unknown';
    if (conservative && actualCostUsd < reservation.amountUsd) {
      recordUsage(b, { agent: reservation.agent, model: 'unknown-outcome', usage: { input_tokens: 0, output_tokens: 0 }, costUsd: reservation.amountUsd - actualCostUsd });
    }
    return {
      ok: true,
      outcome,
      reservedUsd: reservation.amountUsd,
      actualCostUsd,
      refundedUsd: conservative ? 0 : Math.max(0, reservation.amountUsd - actualCostUsd),
      overrunUsd: Math.max(0, actualCostUsd - reservation.amountUsd),
      conservativeCostUsd: conservative ? Math.max(actualCostUsd, reservation.amountUsd) : actualCostUsd,
    };
  }

  function reapExpired(monthKey = month()) {
    const at = now();
    let reaped = 0;
    for (const reservation of [...reservations.values()]) {
      if (reservation.monthKey !== monthKey) continue;
      // Records from older scaffold versions had no lease. Treat them as
      // expired and charge the full reservation conservatively instead of
      // leaving budget locked forever or silently refunding unknown spend.
      if (reservation.expiresAt !== undefined && reservation.expiresAt > at) continue;
      const legacyOrStarted = reservation.effectStarted !== false || reservation.events.length > 0;
      finalizeReservation(reservation.id, legacyOrStarted ? 'expired_unknown' : 'expired');
      reaped += 1;
    }
    return reaped;
  }

  return {
    /** Atomically reserve budget before any provider call begins. */
    reserve({ amountUsd, limitUsd, agent = 'unknown', ttlMs = reservationTtlMs }) {
      const amount = Number(amountUsd);
      const limit = Number(limitUsd);
      if (!(amount > 0) || !Number.isFinite(amount) || !(limit > 0) || !Number.isFinite(limit)) {
        throw new Error('[cost-tracker] reserve requires finite positive amountUsd and limitUsd');
      }
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
        throw new Error('[cost-tracker] reservation ttlMs must be an integer between 1 and 86400000');
      }
      agent = identifier(agent, 'agent');
      const monthKey = month();
      reapExpired(monthKey);
      const b = bucket(monthKey);
      if (b.costUsd + b.reservedUsd + amount > limit) {
        return {
          ok: false,
          reason: 'monthly-budget-exhausted',
          committedUsd: b.costUsd,
          reservedUsd: b.reservedUsd,
          limitUsd: limit,
        };
      }
      const id = randomUUID();
      const createdAt = now();
      b.reservedUsd += amount;
      reservations.set(id, {
        id,
        monthKey,
        amountUsd: amount,
        agent,
        events: [],
        createdAt,
        expiresAt: createdAt + ttlMs,
        effectStarted: false,
      });
      return { ok: true, id, month: monthKey, amountUsd: amount, expiresAt: createdAt + ttlMs };
    },
    /** Finalize recorded usage and release the unused portion. */
    commit(id) {
      return finalizeReservation(id, 'committed');
    },
    /** Release a failed/cancelled request while retaining already-incurred usage. */
    refund(id) {
      return finalizeReservation(id, 'refunded');
    },
    /** Unknown provider/tool outcome: conservatively consume the reservation. */
    settleUnknown(id) {
      return finalizeReservation(id, 'unknown');
    },
    /** Atomically mark that provider/effect execution is about to begin. */
    markStarted(id) {
      const reservation = reservations.get(id);
      if (!reservation) return { ok: false, error: 'unknown_reservation' };
      if (reservation.expiresAt === undefined || reservation.expiresAt <= now()) {
        reapExpired(reservation.monthKey);
        return { ok: false, error: 'expired_reservation' };
      }
      reservation.effectStarted = true;
      reservation.startedAt ??= now();
      return { ok: true, startedAt: reservation.startedAt };
    },
    /** Record one LLM call. Called by agent.js on every turn. */
    trackUsage({ agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0, reservationId } = {}) {
      const event = normalizeEvent({ agent, model, usage, costUsd });
      if (reservationId) {
        const existing = reservations.get(reservationId);
        if (existing && (existing.expiresAt === undefined || existing.expiresAt <= now())) {
          reapExpired(existing.monthKey);
        }
        const reservation = reservations.get(reservationId);
        if (!reservation) throw new Error('[cost-tracker] unknown reservation for usage');
        reservation.events.push(assertReservationCapacity(reservation, event));
        return;
      }
      recordUsage(bucket(month()), event);
    },
    reapExpired,
    getMonthlyCost(monthKey = month()) {
      reapExpired(monthKey);
      return months.get(monthKey)?.costUsd ?? 0;
    },
    getReservedCost(monthKey = month()) {
      reapExpired(monthKey);
      return months.get(monthKey)?.reservedUsd ?? 0;
    },
    isOverBudget(monthlyBudgetUsd) {
      return this.getMonthlyCost() + this.getReservedCost() >= monthlyBudgetUsd;
    },
    summary(monthKey = month()) {
      reapExpired(monthKey);
      const b = months.get(monthKey);
      return {
        month: monthKey,
        costUsd: b?.costUsd ?? 0,
        reservedUsd: b?.reservedUsd ?? 0,
        calls: b?.calls ?? 0,
        inputTokens: b?.inputTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        byAgent: b?.byAgent ?? {},
      };
    },
  };
}

function emptyBucket() {
  return { costUsd: 0, reservedUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byAgent: {}, reservations: {} };
}

function persistentRecordUsage(bucket, { agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0 }) {
  ({ agent, model, usage, costUsd } = normalizeEvent({ agent, model, usage, costUsd }));
  bucket.costUsd += costUsd;
  bucket.calls += 1;
  bucket.inputTokens += usage.input_tokens ?? 0;
  bucket.outputTokens += usage.output_tokens ?? 0;
  const byAgent = (bucket.byAgent[agent] ??= { costUsd: 0, calls: 0, models: {} });
  byAgent.costUsd += costUsd;
  byAgent.calls += 1;
  byAgent.models[model] = (byAgent.models[model] ?? 0) + 1;
}

function createPersistentCostTracker({ stateStore, now, reservationTtlMs }) {
  const month = () => monthKeyOf(new Date(now()));

  async function readBucket(monthKey = month()) {
    return stateStore.transaction(async (tx) => {
      const record = tx.get('cost', monthKey);
      const bucket = validateBucket(record?.value ?? emptyBucket());
      const reaped = reapBucket(bucket, now());
      if (reaped > 0) tx.put('cost', monthKey, bucket, record ? { ifRevision: record.revision } : undefined);
      return bucket;
    });
  }

  function reapBucket(bucket, at) {
    let reaped = 0;
    for (const [id, reservation] of Object.entries(bucket.reservations)) {
      if (reservation.expiresAt !== undefined && reservation.expiresAt > at) continue;
      delete bucket.reservations[id];
      bucket.reservedUsd = Math.max(0, bucket.reservedUsd - reservation.amountUsd);
      for (const event of reservation.events) persistentRecordUsage(bucket, event);
      const actualCostUsd = reservation.events.reduce((sum, event) => sum + normalizeEvent(event).costUsd, 0);
      const conservative = reservation.effectStarted !== false || reservation.events.length > 0;
      if (conservative && actualCostUsd < reservation.amountUsd) {
        persistentRecordUsage(bucket, {
          agent: reservation.agent,
          model: 'unknown-outcome',
          usage: { input_tokens: 0, output_tokens: 0 },
          costUsd: reservation.amountUsd - actualCostUsd,
        });
      }
      reaped += 1;
    }
    return reaped;
  }

  async function finalize(id, outcome) {
    return stateStore.transaction(async (tx) => {
      const monthKey = reservationMonthKey(id, month());
      const record = tx.get('cost', monthKey);
      const bucket = validateBucket(record?.value ?? emptyBucket());
      reapBucket(bucket, now());
      const reservation = bucket.reservations[id];
      if (!reservation) {
        if (record) tx.put('cost', monthKey, bucket, { ifRevision: record.revision });
        return { ok: false, error: 'unknown_reservation' };
      }
      delete bucket.reservations[id];
      bucket.reservedUsd = Math.max(0, bucket.reservedUsd - reservation.amountUsd);
      for (const event of reservation.events) persistentRecordUsage(bucket, event);
      const actualCostUsd = reservation.events.reduce((sum, event) => sum + event.costUsd, 0);
      if (outcome === 'unknown' && actualCostUsd < reservation.amountUsd) {
        persistentRecordUsage(bucket, { agent: reservation.agent, model: 'unknown-outcome', usage: { input_tokens: 0, output_tokens: 0 }, costUsd: reservation.amountUsd - actualCostUsd });
      }
      tx.put('cost', monthKey, bucket, record ? { ifRevision: record.revision } : undefined);
      return { ok: true, outcome, reservedUsd: reservation.amountUsd, actualCostUsd, conservativeCostUsd: outcome === 'unknown' ? Math.max(actualCostUsd, reservation.amountUsd) : actualCostUsd, refundedUsd: outcome === 'unknown' ? 0 : Math.max(0, reservation.amountUsd - actualCostUsd), overrunUsd: Math.max(0, actualCostUsd - reservation.amountUsd) };
    });
  }

  return {
    async reserve({ amountUsd, limitUsd, agent = 'unknown', ttlMs = reservationTtlMs }) {
      const amount = Number(amountUsd);
      const limit = Number(limitUsd);
      if (!(amount > 0) || !Number.isFinite(amount) || !(limit > 0) || !Number.isFinite(limit)) throw new Error('[cost-tracker] reserve requires finite positive amountUsd and limitUsd');
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new Error('[cost-tracker] reservation ttlMs must be an integer between 1 and 86400000');
      agent = identifier(agent, 'agent');
      return stateStore.transaction(async (tx) => {
        const monthKey = month();
        const record = tx.get('cost', monthKey);
        const bucket = validateBucket(record?.value ?? emptyBucket());
        const reaped = reapBucket(bucket, now());
        if (bucket.costUsd + bucket.reservedUsd + amount > limit) {
          if (reaped > 0 && record) tx.put('cost', monthKey, bucket, { ifRevision: record.revision });
          return { ok: false, reason: 'monthly-budget-exhausted', committedUsd: bucket.costUsd, reservedUsd: bucket.reservedUsd, limitUsd: limit };
        }
        const id = `${monthKey}:${randomUUID()}`;
        const createdAt = now();
        bucket.reservedUsd += amount;
        bucket.reservations[id] = {
          id,
          monthKey,
          amountUsd: amount,
          agent,
          events: [],
          createdAt,
          expiresAt: createdAt + ttlMs,
          effectStarted: false,
        };
        tx.put('cost', monthKey, bucket, record ? { ifRevision: record.revision } : undefined);
        return { ok: true, id, month: monthKey, amountUsd: amount, expiresAt: createdAt + ttlMs };
      });
    },
    commit(id) { return finalize(id, 'committed'); },
    refund(id) { return finalize(id, 'refunded'); },
    settleUnknown(id) { return finalize(id, 'unknown'); },
    async markStarted(id) {
      return stateStore.transaction(async (tx) => {
        const monthKey = reservationMonthKey(id, month());
        const record = tx.get('cost', monthKey);
        const bucket = validateBucket(record?.value ?? emptyBucket());
        const reaped = reapBucket(bucket, now());
        const reservation = bucket.reservations[id];
        if (!reservation) {
          if (reaped > 0 && record) tx.put('cost', monthKey, bucket, { ifRevision: record.revision });
          return { ok: false, error: reaped > 0 ? 'expired_reservation' : 'unknown_reservation' };
        }
        reservation.effectStarted = true;
        reservation.startedAt ??= now();
        tx.put('cost', monthKey, bucket, record ? { ifRevision: record.revision } : undefined);
        return { ok: true, startedAt: reservation.startedAt };
      });
    },
    async trackUsage({ agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0, reservationId } = {}) {
      const outcome = await stateStore.transaction(async (tx) => {
        const monthKey = reservationId ? reservationMonthKey(reservationId, month()) : month();
        const record = tx.get('cost', monthKey);
        const bucket = validateBucket(record?.value ?? emptyBucket());
        const reaped = reapBucket(bucket, now());
        const event = normalizeEvent({ agent, model, usage, costUsd });
        if (reservationId) {
          const reservation = bucket.reservations[reservationId];
          if (!reservation) {
            if (reaped > 0 && record) tx.put('cost', monthKey, bucket, { ifRevision: record.revision });
            return { error: 'unknown_reservation' };
          }
          reservation.events.push(assertReservationCapacity(reservation, event));
        } else persistentRecordUsage(bucket, event);
        tx.put('cost', monthKey, bucket, record ? { ifRevision: record.revision } : undefined);
        return { ok: true };
      });
      if (!outcome.ok) throw new Error('[cost-tracker] unknown reservation for usage');
    },
    async reapExpired(monthKey = month()) {
      return stateStore.transaction(async (tx) => {
        const record = tx.get('cost', monthKey);
        if (!record) return 0;
        const bucket = validateBucket(record.value);
        const reaped = reapBucket(bucket, now());
        if (reaped > 0) tx.put('cost', monthKey, bucket, { ifRevision: record.revision });
        return reaped;
      });
    },
    async getMonthlyCost(monthKey = month()) { return (await readBucket(monthKey)).costUsd; },
    async getReservedCost(monthKey = month()) { return (await readBucket(monthKey)).reservedUsd; },
    async isOverBudget(limit, monthKey = month()) {
      const bucket = await readBucket(monthKey);
      return bucket.costUsd + bucket.reservedUsd >= limit;
    },
    async summary(monthKey = month()) {
      const bucket = await readBucket(monthKey);
      const { reservations, ...publicBucket } = bucket;
      return { month: monthKey, ...publicBucket };
    },
  };
}
