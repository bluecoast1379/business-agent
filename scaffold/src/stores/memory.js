import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  CURRENT_STORE_SCHEMA_VERSION,
  STORE_NAMESPACES,
  ImmutableNamespaceError,
  StoreConflictError,
  StoreContractError,
  assertKey,
  assertNamespace,
  assertStateStore,
  cloneJsonValue,
  createEmptySnapshot,
  validateSnapshot,
} from './contracts.js';

function cloneRecord(entry) {
  return entry ? { key: entry.key, revision: entry.revision, value: cloneJsonValue(entry.value) } : null;
}

function assertRevision(existing, ifRevision, namespace, key) {
  if (ifRevision === undefined) return;
  if (ifRevision !== null && (!Number.isInteger(ifRevision) || ifRevision < 1)) {
    throw new StoreContractError('[state-store] ifRevision must be null or a positive integer');
  }
  const actual = existing?.revision ?? null;
  if (actual !== ifRevision) {
    throw new StoreConflictError(
      `[state-store] revision conflict for ${namespace}/${key}: expected ${ifRevision}, found ${actual}`,
    );
  }
}

/**
 * Default zero-dependency adapter. State exists only for this process.
 *
 * Durable snapshot adapters intentionally clone the complete snapshot before a
 * transaction because persistence needs both the previous and next images.
 * The memory adapter has no persistence boundary, so it uses private maps and
 * a small undo journal instead. A write therefore scales with the records it
 * actually changes (plus the changed JSON value), not with all resident state.
 */
export function createMemoryStateStore({
  schemaVersion = CURRENT_STORE_SCHEMA_VERSION,
  initialSnapshot,
  idFactory = randomUUID,
} = {}) {
  if (typeof idFactory !== 'function') {
    throw new StoreContractError('[state-store] idFactory must be a function');
  }

  const snapshot = initialSnapshot
    ? validateSnapshot(initialSnapshot, { expectedSchemaVersion: schemaVersion })
    : createEmptySnapshot(schemaVersion);
  const records = Object.fromEntries(STORE_NAMESPACES.map((namespace) => [
    namespace,
    new Map(snapshot.namespaces[namespace].map((entry) => [entry.key, entry])),
  ]));
  const sortedKeyCache = Object.fromEntries(STORE_NAMESPACES.map((namespace) => [
    namespace,
    snapshot.namespaces[namespace].map((entry) => entry.key),
  ]));

  let revision = snapshot.revision;
  let tail = Promise.resolve();
  let closed = false;
  let closePromise = null;
  const transactionContext = new AsyncLocalStorage();
  const storeToken = Object.freeze({ adapterName: 'memory' });

  function ensureOpen() {
    if (closed || closePromise) {
      throw new StoreContractError('[state-store] memory adapter is closed');
    }
    if (transactionContext.getStore() === storeToken) {
      throw new StoreContractError('[state-store] use the supplied transaction object inside transaction()');
    }
  }

  function enqueue(operation) {
    ensureOpen();
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  function sortedKeys(namespace) {
    let keys = sortedKeyCache[namespace];
    if (!keys) {
      keys = [...records[namespace].keys()].sort((a, b) => a.localeCompare(b));
      sortedKeyCache[namespace] = keys;
    }
    return keys;
  }

  function createOperations(journal, lifecycle) {
    function ensureActive() {
      if (!lifecycle.active) {
        throw new StoreContractError('[state-store] transaction object is no longer active');
      }
    }

    function get(namespace, key) {
      ensureActive();
      assertNamespace(namespace);
      assertKey(key);
      return cloneRecord(records[namespace].get(key) ?? null);
    }

    function put(namespace, key, value, { ifRevision } = {}) {
      ensureActive();
      assertNamespace(namespace);
      assertKey(key);
      if (namespace === 'audit') {
        throw new ImmutableNamespaceError('[state-store] audit is append-only; use appendAudit()');
      }
      const namespaceRecords = records[namespace];
      const existing = namespaceRecords.get(key) ?? null;
      assertRevision(existing, ifRevision, namespace, key);
      const clonedValue = cloneJsonValue(value);
      journal.push({ namespace, key, previous: existing });
      revision += 1;
      const next = { key, revision, value: clonedValue };
      namespaceRecords.set(key, next);
      if (!existing) sortedKeyCache[namespace] = null;
      return cloneRecord(next);
    }

    function remove(namespace, key, { ifRevision } = {}) {
      ensureActive();
      assertNamespace(namespace);
      assertKey(key);
      if (namespace === 'audit') {
        throw new ImmutableNamespaceError('[state-store] audit records cannot be deleted');
      }
      const namespaceRecords = records[namespace];
      const existing = namespaceRecords.get(key) ?? null;
      assertRevision(existing, ifRevision, namespace, key);
      if (!existing) return false;
      journal.push({ namespace, key, previous: existing });
      namespaceRecords.delete(key);
      sortedKeyCache[namespace] = null;
      revision += 1;
      return true;
    }

    function list(namespace, { prefix = '', cursor = null, limit = 100 } = {}) {
      ensureActive();
      assertNamespace(namespace);
      if (typeof prefix !== 'string') throw new StoreContractError('[state-store] list prefix must be a string');
      if (cursor !== null && typeof cursor !== 'string') {
        throw new StoreContractError('[state-store] list cursor must be null or a string');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new StoreContractError('[state-store] list limit must be an integer between 1 and 1000');
      }

      const selected = [];
      for (const key of sortedKeys(namespace)) {
        if (!key.startsWith(prefix) || (cursor !== null && key <= cursor)) continue;
        selected.push(records[namespace].get(key));
        if (selected.length > limit) break;
      }
      const hasMore = selected.length > limit;
      if (hasMore) selected.pop();
      return {
        items: selected.map(cloneRecord),
        nextCursor: hasMore ? selected.at(-1).key : null,
      };
    }

    function appendAudit(value, { key = idFactory() } = {}) {
      ensureActive();
      assertKey(key);
      const namespaceRecords = records.audit;
      if (namespaceRecords.has(key)) {
        throw new StoreConflictError(`[state-store] audit record ${JSON.stringify(key)} already exists`);
      }
      const clonedValue = cloneJsonValue(value);
      journal.push({ namespace: 'audit', key, previous: null });
      revision += 1;
      const next = { key, revision, value: clonedValue };
      namespaceRecords.set(key, next);
      sortedKeyCache.audit = null;
      return cloneRecord(next);
    }

    return Object.freeze({ get, put, delete: remove, list, appendAudit });
  }

  function rollback(journal, previousRevision) {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const { namespace, key, previous } = journal[index];
      if (previous) records[namespace].set(key, previous);
      else records[namespace].delete(key);
      sortedKeyCache[namespace] = null;
    }
    revision = previousRevision;
  }

  async function access(operation, { transactional = false } = {}) {
    return enqueue(async () => {
      const previousRevision = revision;
      const journal = [];
      const lifecycle = { active: true };
      const operations = createOperations(journal, lifecycle);
      try {
        if (transactional) {
          return await transactionContext.run(storeToken, () => operation(operations));
        }
        return await operation(operations);
      } catch (error) {
        rollback(journal, previousRevision);
        throw error;
      } finally {
        lifecycle.active = false;
      }
    });
  }

  const store = {
    adapterName: 'memory',
    schemaVersion,
    capabilities: Object.freeze({
      durable: false,
      restartRecovery: false,
      transactions: true,
      compareAndSwap: true,
      multiProcess: false,
      migrations: false,
      conformance: 'built-in',
    }),
    async get(namespace, key) {
      return access((operations) => operations.get(namespace, key));
    },
    async put(namespace, key, value, options) {
      return access((operations) => operations.put(namespace, key, value, options));
    },
    async delete(namespace, key, options) {
      return access((operations) => operations.delete(namespace, key, options));
    },
    async list(namespace, options) {
      return access((operations) => operations.list(namespace, options));
    },
    async appendAudit(value, options) {
      return access((operations) => operations.appendAudit(value, options));
    },
    async transaction(callback) {
      if (typeof callback !== 'function') {
        throw new StoreContractError('[state-store] transaction callback must be a function');
      }
      return access(callback, { transactional: true });
    },
    async exportSnapshot() {
      return enqueue(async () => {
        const exported = createEmptySnapshot(schemaVersion);
        exported.revision = revision;
        for (const namespace of STORE_NAMESPACES) {
          exported.namespaces[namespace] = sortedKeys(namespace)
            .map((key) => cloneRecord(records[namespace].get(key)));
        }
        return exported;
      });
    },
    async close() {
      if (closed) return;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await tail;
        closed = true;
      })();
      return closePromise;
    },
  };

  return assertStateStore(Object.freeze(store));
}
