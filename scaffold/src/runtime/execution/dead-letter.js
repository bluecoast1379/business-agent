import { createHash, randomUUID } from 'node:crypto';
import { createMemoryStateStore } from '../../stores/memory.js';

const STORAGE_PREFIX = 'dlq:v1:';
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_MAX_RECORDS = 100_000;
const PAGE_LIMIT = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_OPERATION_CLASSES = new Set([
  'provider',
  'tool',
  'workflow',
  'scheduler',
  'http',
  'webhook',
  'store',
  'other',
]);
const SAFE_ERROR_CODES = new Set([
  'EXECUTION_FAILED',
  'TIMEOUT',
  'ABORTED',
  'BULKHEAD_FULL',
  'CIRCUIT_OPEN',
  'HTTP_ERROR',
  'IDEMPOTENCY_ERROR',
  'WORKFLOW_ERROR',
  'WEBHOOK_ERROR',
  'TOOL_ERROR',
  'STORE_ERROR',
  'SCHEDULER_ERROR',
  'PROVIDER_ERROR',
  'OTHER',
]);
const SAFE_ERROR_CLASSES = new Set([
  'execution',
  'timeout',
  'abort',
  'capacity',
  'circuit',
  'programming',
  'other',
]);
const STATUSES = new Set(['pending', 'reconciled']);
const RESOLUTIONS = new Set(['resolved', 'discarded', 'retry_authorized']);

export class DeadLetterQueueError extends Error {
  constructor(message, { code = 'DEAD_LETTER_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DeadLetterQueueError';
    this.code = code;
    this.retryable = false;
  }
}

export class DeadLetterCapacityError extends DeadLetterQueueError {
  constructor(maxRecords) {
    super(`[dead-letter] queue capacity of ${maxRecords} records is exhausted; reconcile and prune explicitly`, {
      code: 'DEAD_LETTER_CAPACITY',
    });
    this.name = 'DeadLetterCapacityError';
  }
}

function queueError(code, message, options) {
  return new DeadLetterQueueError(`[dead-letter] ${message}`, { code, ...options });
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function safeProperty(value, key, fallback = '') {
  try {
    const selected = value?.[key];
    return typeof selected === 'string' ? selected : fallback;
  } catch {
    return fallback;
  }
}

function operationClass(operation) {
  const prefix = operation.split(/[.:/]/u, 1)[0].toLowerCase();
  return SAFE_OPERATION_CLASSES.has(prefix) ? prefix : 'other';
}

function errorCode(rawCode) {
  if (rawCode === 'EXECUTION_FAILED') return rawCode;
  if (rawCode === 'TIMEOUT') return rawCode;
  if (rawCode === 'ABORTED') return rawCode;
  if (rawCode === 'BULKHEAD_FULL') return rawCode;
  if (rawCode === 'CIRCUIT_OPEN') return rawCode;
  if (/^HTTP_[1-5][0-9]{2}$/.test(rawCode)) return 'HTTP_ERROR';
  for (const [prefix, classified] of [
    ['IDEMPOTENCY_', 'IDEMPOTENCY_ERROR'],
    ['WORKFLOW_', 'WORKFLOW_ERROR'],
    ['WEBHOOK_', 'WEBHOOK_ERROR'],
    ['TOOL_', 'TOOL_ERROR'],
    ['STORE_', 'STORE_ERROR'],
    ['SCHEDULER_', 'SCHEDULER_ERROR'],
    ['PROVIDER_', 'PROVIDER_ERROR'],
  ]) {
    if (rawCode.startsWith(prefix)) return classified;
  }
  return 'OTHER';
}

function errorClass(error, code) {
  const name = safeProperty(error, 'name');
  if (code === 'TIMEOUT' || name === 'ExecutionTimeoutError' || name === 'TimeoutError') return 'timeout';
  if (code === 'ABORTED' || name === 'AbortError') return 'abort';
  if (code === 'BULKHEAD_FULL' || name === 'BulkheadRejectedError') return 'capacity';
  if (code === 'CIRCUIT_OPEN' || name === 'CircuitOpenError') return 'circuit';
  if (name === 'ExecutionError') return 'execution';
  if (['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(name)) return 'programming';
  return 'other';
}

function timestamp(now) {
  const value = now();
  if (!Number.isFinite(value)) throw queueError('DEAD_LETTER_CLOCK_INVALID', 'now() must return epoch milliseconds');
  return new Date(value).toISOString();
}

function storageKey(id) {
  return `${STORAGE_PREFIX}${id}`;
}

function assertId(id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw queueError('DEAD_LETTER_ID_INVALID', 'id must be a UUID');
  }
  return id;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => typeof key !== 'string')
      || JSON.stringify([...keys].sort()) !== JSON.stringify([...expected].sort())) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', `${label} has unexpected fields`);
  }
}

function validateRecord(value, expectedId) {
  assertExactKeys(value, [
    'schemaVersion',
    'id',
    'operation',
    'error',
    'attempts',
    'createdAt',
    'status',
    'reconciliation',
  ], 'record');
  if (value.schemaVersion !== '1.0') throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'record schemaVersion is unsupported');
  assertId(value.id);
  if (expectedId !== undefined && value.id !== expectedId) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'record id does not match its storage key');
  }
  assertExactKeys(value.operation, ['class', 'digest'], 'record.operation');
  if (!SAFE_OPERATION_CLASSES.has(value.operation.class) || !DIGEST_PATTERN.test(value.operation.digest)) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'operation metadata is invalid');
  }
  assertExactKeys(value.error, ['code', 'codeDigest', 'class', 'messageDigest'], 'record.error');
  if (!SAFE_ERROR_CODES.has(value.error.code)
      || !SAFE_ERROR_CLASSES.has(value.error.class)
      || !DIGEST_PATTERN.test(value.error.codeDigest)
      || !DIGEST_PATTERN.test(value.error.messageDigest)) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'error metadata is invalid');
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > 1_000_000) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'attempts is invalid');
  }
  if (!Number.isFinite(Date.parse(value.createdAt)) || !STATUSES.has(value.status)) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'record lifecycle metadata is invalid');
  }
  if (value.status === 'pending' && value.reconciliation !== null) {
    throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'pending record must not have reconciliation metadata');
  }
  if (value.status === 'reconciled') {
    assertExactKeys(value.reconciliation, ['resolution', 'at'], 'record.reconciliation');
    if (!RESOLUTIONS.has(value.reconciliation.resolution)
        || !Number.isFinite(Date.parse(value.reconciliation.at))) {
      throw queueError('DEAD_LETTER_RECORD_CORRUPT', 'reconciliation metadata is invalid');
    }
  }
  return structuredClone(value);
}

function assertLimit(limit, { max = PAGE_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw queueError('DEAD_LETTER_LIMIT_INVALID', `limit must be an integer between 1 and ${max}`);
  }
}

function assertListOptions(options) {
  assertExactKeys(options, Object.keys(options), 'list options');
  const allowed = new Set(['cursor', 'limit', 'status']);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw queueError('DEAD_LETTER_OPTIONS_INVALID', 'list options contain unsupported fields');
  }
  const cursor = options.cursor ?? null;
  if (cursor !== null) assertId(cursor);
  const limit = options.limit ?? 100;
  assertLimit(limit);
  const status = options.status ?? null;
  if (status !== null && !STATUSES.has(status)) {
    throw queueError('DEAD_LETTER_STATUS_INVALID', 'status filter is invalid');
  }
  return { cursor, limit, status };
}

function scanRecords(tx, namespace, { cursor = null, limit, status = null }) {
  const selected = [];
  let scanCursor = cursor === null ? null : storageKey(cursor);
  let exhausted = false;
  while (!exhausted && selected.length <= limit) {
    const page = tx.list(namespace, { prefix: STORAGE_PREFIX, cursor: scanCursor, limit: PAGE_LIMIT });
    for (const record of page.items) {
      const id = record.key.slice(STORAGE_PREFIX.length);
      const value = validateRecord(record.value, id);
      if (status === null || value.status === status) selected.push(value);
      if (selected.length > limit) break;
    }
    exhausted = page.nextCursor === null;
    scanCursor = page.nextCursor;
  }
  const hasMore = selected.length > limit;
  if (hasMore) selected.pop();
  return {
    items: selected,
    nextCursor: hasMore ? selected.at(-1).id : null,
  };
}

function countRecords(tx, namespace, stopAfter) {
  let count = 0;
  let cursor = null;
  do {
    const page = tx.list(namespace, { prefix: STORAGE_PREFIX, cursor, limit: PAGE_LIMIT });
    for (const record of page.items) {
      const id = record.key.slice(STORAGE_PREFIX.length);
      validateRecord(record.value, id);
      count += 1;
      if (count >= stopAfter) return count;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return count;
}

export function createDeadLetterQueue({
  stateStore: suppliedStateStore,
  namespace = 'dead-letter',
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function') throw queueError('DEAD_LETTER_CLOCK_INVALID', 'now must be a function');
  if (typeof idFactory !== 'function') throw queueError('DEAD_LETTER_ID_FACTORY_INVALID', 'idFactory must be a function');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_MAX_RECORDS) {
    throw queueError('DEAD_LETTER_CAPACITY_INVALID', `maxRecords must be an integer between 1 and ${MAX_MAX_RECORDS}`);
  }
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) {
    throw queueError('DEAD_LETTER_NAMESPACE_INVALID', 'namespace must be a lower-case storage identifier');
  }
  const stateStore = suppliedStateStore ?? createMemoryStateStore();
  // The built-in transient store has the shared fixed namespace contract. A
  // custom namespace remains meaningful for supplied adapters, while the
  // no-store legacy API continues to work without exposing that implementation
  // detail.
  const storageNamespace = suppliedStateStore ? namespace : 'dead-letter';
  for (const method of ['get', 'put', 'delete', 'list', 'transaction']) {
    if (typeof stateStore?.[method] !== 'function') {
      throw queueError('DEAD_LETTER_STORE_INVALID', `stateStore is missing ${method}()`);
    }
  }

  async function add(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw queueError('DEAD_LETTER_INPUT_INVALID', 'add input must be an object');
    }
    const operation = input.operation;
    if (typeof operation !== 'string' || !operation || operation.length > 16_384) {
      throw queueError('DEAD_LETTER_OPERATION_INVALID', 'operation must be a non-empty string up to 16384 characters');
    }
    if (!Number.isInteger(input.attempts) || input.attempts < 1 || input.attempts > 1_000_000) {
      throw queueError('DEAD_LETTER_ATTEMPTS_INVALID', 'attempts must be an integer between 1 and 1000000');
    }
    const rawCode = safeProperty(input.error, 'code', 'EXECUTION_FAILED') || 'EXECUTION_FAILED';
    const rawMessage = safeProperty(input.error, 'message', 'execution failed') || 'execution failed';
    const entry = {
      schemaVersion: '1.0',
      id: assertId(idFactory()),
      operation: {
        class: operationClass(operation),
        digest: digest(operation),
      },
      error: {
        code: errorCode(rawCode),
        codeDigest: digest(rawCode),
        class: errorClass(input.error, rawCode),
        messageDigest: digest(rawMessage),
      },
      attempts: input.attempts,
      createdAt: timestamp(now),
      status: 'pending',
      reconciliation: null,
    };
    // payloadRef and context are deliberately not copied. They may contain
    // request bodies, credentials, tenant identifiers, or other private data.
    return stateStore.transaction((tx) => {
      if (countRecords(tx, storageNamespace, maxRecords) >= maxRecords) {
        throw new DeadLetterCapacityError(maxRecords);
      }
      const key = storageKey(entry.id);
      if (tx.get(storageNamespace, key)) {
        throw queueError('DEAD_LETTER_ID_COLLISION', 'generated id already exists');
      }
      tx.put(storageNamespace, key, entry, { ifRevision: null });
      return structuredClone(entry);
    });
  }

  async function list(options) {
    if (options === undefined) {
      return stateStore.transaction((tx) => scanRecords(tx, storageNamespace, {
        limit: maxRecords,
      }).items);
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw queueError('DEAD_LETTER_OPTIONS_INVALID', 'list options must be an object');
    }
    const normalized = assertListOptions(options);
    return stateStore.transaction((tx) => scanRecords(tx, storageNamespace, normalized));
  }

  async function inspect(id) {
    assertId(id);
    const record = await stateStore.get(storageNamespace, storageKey(id));
    return record ? validateRecord(record.value, id) : null;
  }

  async function reconcile(id, { resolution, acknowledgeReplayRisk = false } = {}) {
    assertId(id);
    if (!RESOLUTIONS.has(resolution)) {
      throw queueError('DEAD_LETTER_RESOLUTION_INVALID', 'resolution is invalid');
    }
    if (resolution === 'retry_authorized' && acknowledgeReplayRisk !== true) {
      throw queueError(
        'DEAD_LETTER_REPLAY_ACKNOWLEDGEMENT_REQUIRED',
        'retry_authorized requires acknowledgeReplayRisk=true',
      );
    }
    return stateStore.transaction((tx) => {
      const key = storageKey(id);
      const record = tx.get(storageNamespace, key);
      if (!record) throw queueError('DEAD_LETTER_NOT_FOUND', 'record was not found');
      const current = validateRecord(record.value, id);
      if (current.status !== 'pending') {
        throw queueError('DEAD_LETTER_STATE_CONFLICT', 'terminal records cannot be reconciled again');
      }
      const next = {
        ...current,
        status: 'reconciled',
        reconciliation: { resolution, at: timestamp(now) },
      };
      tx.put(storageNamespace, key, next, { ifRevision: record.revision });
      return structuredClone(next);
    });
  }

  async function prune({ before, limit = 100, acknowledgeDataLoss = false } = {}) {
    if (acknowledgeDataLoss !== true) {
      throw queueError('DEAD_LETTER_PRUNE_ACKNOWLEDGEMENT_REQUIRED', 'prune requires acknowledgeDataLoss=true');
    }
    assertLimit(limit);
    const beforeMs = typeof before === 'string' ? Date.parse(before) : before;
    if (!Number.isFinite(beforeMs)) {
      throw queueError('DEAD_LETTER_PRUNE_BEFORE_INVALID', 'before must be epoch milliseconds or an ISO timestamp');
    }
    return stateStore.transaction((tx) => {
      let cursor = null;
      let pruned = 0;
      let retainedPending = 0;
      do {
        const page = tx.list(storageNamespace, { prefix: STORAGE_PREFIX, cursor, limit: PAGE_LIMIT });
        for (const record of page.items) {
          const id = record.key.slice(STORAGE_PREFIX.length);
          const value = validateRecord(record.value, id);
          if (value.status === 'pending') {
            retainedPending += 1;
            continue;
          }
          const reconciledAt = Date.parse(value.reconciliation.at);
          if (reconciledAt >= beforeMs) continue;
          tx.delete(storageNamespace, record.key, { ifRevision: record.revision });
          pruned += 1;
          if (pruned >= limit) break;
        }
        if (pruned >= limit) break;
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { pruned, retainedPending };
    });
  }

  return Object.freeze({ add, list, inspect, reconcile, prune, maxRecords });
}
