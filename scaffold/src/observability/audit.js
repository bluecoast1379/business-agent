import { createHash, randomUUID } from 'node:crypto';
import { pseudonymize, redactValue } from './redaction.js';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

const AUDIT_HEAD_KEY = '__audit_chain_head_v1__';

function capacityError(maxRecords) {
  return Object.assign(new Error(`[audit] capacity (${maxRecords}) is exhausted; archive and rotate the durable ledger before accepting more evidence`), {
    code: 'AUDIT_CAPACITY_EXHAUSTED',
    statusCode: 503,
    retryable: false,
    unknownOutcome: false,
    preEffect: true,
    effectStarted: false,
  });
}

function verifyEntries(current) {
  let previousHash = 'GENESIS';
  for (let index = 0; index < current.length; index += 1) {
    const event = current[index];
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) return { valid: false, index, reason: 'CHAIN_LINK_MISMATCH' };
    const { hash, ...body } = event;
    if (digest(body) !== hash) return { valid: false, index, reason: 'EVENT_HASH_MISMATCH' };
    previousHash = hash;
  }
  return { valid: true, count: current.length, headHash: previousHash };
}

export function createAuditLog({ stateStore, namespace = 'audit', now = Date.now, maxRecords = 10_000 } = {}) {
  if (namespace !== 'audit') throw new Error('[audit] the state-store append-only namespace must be audit');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
    throw new Error('[audit] maxRecords must be an integer between 1 and 1000000');
  }
  const memory = [];
  let queue = Promise.resolve();

  function transactionEntries(tx) {
    const values = [];
    let cursor = null;
    do {
      const page = tx.list(namespace, { cursor, limit: 1_000 });
      values.push(...page.items.map((record) => record.value));
      cursor = page.nextCursor;
    } while (cursor);
    return values.sort((a, b) => a.sequence - b.sequence);
  }

  function checkedHead(value) {
    if (!value || value.version !== 1 || !Number.isInteger(value.sequence) || value.sequence < 0
        || typeof value.hash !== 'string'
        || (value.sequence === 0 ? value.hash !== 'GENESIS' : !/^[0-9a-f]{64}$/.test(value.hash))) {
      throw Object.assign(new Error('[audit] durable chain head is corrupt'), {
        code: 'AUDIT_HEAD_CORRUPT',
        retryable: false,
      });
    }
    return value;
  }

  function loadHead(tx) {
    const entry = tx.get('job', AUDIT_HEAD_KEY);
    if (entry) return { entry, value: checkedHead(entry.value) };
    const current = transactionEntries(tx);
    const integrity = verifyEntries(current);
    if (!integrity.valid) {
      throw Object.assign(new Error('[audit] existing chain failed verification'), {
        code: 'AUDIT_CHAIN_INVALID',
        retryable: false,
      });
    }
    return {
      entry: null,
      value: { version: 1, sequence: integrity.count, hash: integrity.headHash },
    };
  }

  async function entries() {
    if (stateStore) {
      const values = [];
      let cursor = null;
      do {
        const page = await stateStore.list(namespace, { cursor, limit: 1_000 });
        values.push(...page.items.map((record) => record.value));
        cursor = page.nextCursor;
      } while (cursor);
      return values.sort((a, b) => a.sequence - b.sequence);
    }
    return memory.map((value) => structuredClone(value));
  }

  async function append(input) {
    const task = queue.then(async () => {
      const build = (sequence, previousHash) => {
        const event = {
          id: randomUUID(),
          sequence,
          occurredAt: new Date(now()).toISOString(),
          actor: input.actor ? pseudonymize(input.actor) : 'system',
          tenant: input.tenant ? pseudonymize(input.tenant) : null,
          action: input.action,
          resource: input.resource ?? null,
          policyDecision: input.policyDecision ?? null,
          outcome: input.outcome ?? null,
          idempotencyKeyHash: input.idempotencyKey ? pseudonymize(input.idempotencyKey) : null,
          metadata: redactValue(input.metadata ?? {}),
          previousHash,
        };
        event.hash = digest(event);
        return event;
      };
      if (stateStore) {
        return stateStore.transaction(async (tx) => {
          const head = loadHead(tx);
          if (head.value.sequence >= maxRecords) throw capacityError(maxRecords);
          const event = build(head.value.sequence + 1, head.value.hash);
          tx.appendAudit(event, { key: String(event.sequence).padStart(16, '0') });
          tx.put('job', AUDIT_HEAD_KEY, {
            version: 1,
            sequence: event.sequence,
            hash: event.hash,
            updatedAt: event.occurredAt,
          }, head.entry ? { ifRevision: head.entry.revision } : { ifRevision: null });
          return event;
        });
      }
      if (memory.length >= maxRecords) throw capacityError(maxRecords);
      const event = build(memory.length + 1, memory.at(-1)?.hash ?? 'GENESIS');
      memory.push(structuredClone(event));
      return event;
    });
    queue = task.catch(() => {});
    return task;
  }

  /**
   * Atomically occupy audit capacity before an audited effect begins.
   *
   * This is deliberately an append, not a separate capacity check: the
   * durable `started` record is the reservation. Concurrent callers therefore
   * cannot both observe the last free slot and proceed without evidence. If a
   * process crashes after this call, the incomplete start remains visible for
   * reconciliation instead of silently releasing the slot.
   */
  async function start(input) {
    return append({
      ...input,
      outcome: 'started',
      metadata: { ...(input.metadata ?? {}), auditPhase: 'pre-effect' },
    });
  }

  async function verify() {
    const current = await entries();
    const integrity = verifyEntries(current);
    if (!integrity.valid || !stateStore) return integrity;
    const durableHead = await stateStore.get('job', AUDIT_HEAD_KEY);
    if (durableHead) {
      let head;
      try { head = checkedHead(durableHead.value); }
      catch { return { valid: false, index: current.length, reason: 'HEAD_INVALID' }; }
      if (head.sequence !== integrity.count || head.hash !== integrity.headHash) {
        return { valid: false, index: current.length, reason: 'HEAD_MISMATCH' };
      }
    }
    return integrity;
  }

  async function capacity() {
    if (!stateStore) {
      return { records: memory.length, maxRecords, available: Math.max(0, maxRecords - memory.length), full: memory.length >= maxRecords };
    }
    const records = await stateStore.transaction(async (tx) => loadHead(tx).value.sequence);
    return { records, maxRecords, available: Math.max(0, maxRecords - records), full: records >= maxRecords };
  }

  return Object.freeze({ append, start, list: entries, verify, capacity, flush: () => queue });
}
