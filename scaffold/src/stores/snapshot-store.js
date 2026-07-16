import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  ImmutableNamespaceError,
  StoreConflictError,
  StoreContractError,
  assertKey,
  assertNamespace,
  cloneJsonValue,
  cloneSnapshot,
  validateSnapshot,
} from './contracts.js';

function findEntry(snapshot, namespace, key) {
  return snapshot.namespaces[namespace].find((entry) => entry.key === key) ?? null;
}

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

function createOperations(snapshot, { idFactory }) {
  function get(namespace, key) {
    assertNamespace(namespace);
    assertKey(key);
    return cloneRecord(findEntry(snapshot, namespace, key));
  }

  function put(namespace, key, value, { ifRevision } = {}) {
    assertNamespace(namespace);
    assertKey(key);
    if (namespace === 'audit') {
      throw new ImmutableNamespaceError('[state-store] audit is append-only; use appendAudit()');
    }
    const entries = snapshot.namespaces[namespace];
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    const existing = existingIndex >= 0 ? entries[existingIndex] : null;
    assertRevision(existing, ifRevision, namespace, key);
    snapshot.revision += 1;
    const next = { key, revision: snapshot.revision, value: cloneJsonValue(value) };
    if (existingIndex >= 0) entries[existingIndex] = next;
    else entries.push(next);
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return cloneRecord(next);
  }

  function remove(namespace, key, { ifRevision } = {}) {
    assertNamespace(namespace);
    assertKey(key);
    if (namespace === 'audit') {
      throw new ImmutableNamespaceError('[state-store] audit records cannot be deleted');
    }
    const entries = snapshot.namespaces[namespace];
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    const existing = existingIndex >= 0 ? entries[existingIndex] : null;
    assertRevision(existing, ifRevision, namespace, key);
    if (existingIndex < 0) return false;
    entries.splice(existingIndex, 1);
    snapshot.revision += 1;
    return true;
  }

  function list(namespace, { prefix = '', cursor = null, limit = 100 } = {}) {
    assertNamespace(namespace);
    if (typeof prefix !== 'string') throw new StoreContractError('[state-store] list prefix must be a string');
    if (cursor !== null && typeof cursor !== 'string') {
      throw new StoreContractError('[state-store] list cursor must be null or a string');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StoreContractError('[state-store] list limit must be an integer between 1 and 1000');
    }
    const matching = snapshot.namespaces[namespace]
      .filter((entry) => entry.key.startsWith(prefix) && (cursor === null || entry.key > cursor));
    const selected = matching.slice(0, limit);
    return {
      items: selected.map(cloneRecord),
      nextCursor: matching.length > selected.length ? selected.at(-1).key : null,
    };
  }

  function appendAudit(value, { key = idFactory() } = {}) {
    assertKey(key);
    const entries = snapshot.namespaces.audit;
    if (findEntry(snapshot, 'audit', key)) {
      throw new StoreConflictError(`[state-store] audit record ${JSON.stringify(key)} already exists`);
    }
    snapshot.revision += 1;
    const next = { key, revision: snapshot.revision, value: cloneJsonValue(value) };
    entries.push(next);
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return cloneRecord(next);
  }

  return Object.freeze({ get, put, delete: remove, list, appendAudit });
}

/**
 * Build an adapter around a validated snapshot and an atomic persist callback.
 * Every public operation is serialized. Transactions modify a private snapshot
 * and publish it only after the callback and persistence both succeed.
 */
export function createSnapshotStore({
  adapterName,
  capabilities,
  initialSnapshot,
  persist,
  refresh,
  serialize = (operation) => operation(),
  onClose,
  idFactory = randomUUID,
}) {
  if (typeof persist !== 'function') throw new StoreContractError('[state-store] persist callback is required');
  if (typeof serialize !== 'function') throw new StoreContractError('[state-store] serialize callback must be a function');
  if (typeof idFactory !== 'function') throw new StoreContractError('[state-store] idFactory must be a function');

  let state = validateSnapshot(initialSnapshot, { expectedSchemaVersion: initialSnapshot.schemaVersion });
  let tail = Promise.resolve();
  let closed = false;
  let closePromise = null;
  const transactionContext = new AsyncLocalStorage();
  const storeToken = Object.freeze({ adapterName });

  function ensureOpen() {
    if (closed || closePromise) {
      throw new StoreContractError(`[state-store] ${adapterName} adapter is closed`);
    }
    if (transactionContext.getStore() === storeToken) {
      throw new StoreContractError('[state-store] use the supplied transaction object inside transaction()');
    }
  }

  function enqueue(operation) {
    ensureOpen();
    const run = tail.then(
      () => serialize(operation),
      () => serialize(operation),
    );
    tail = run.catch(() => {});
    return run;
  }

  async function refreshState() {
    if (!refresh) return;
    const latest = await refresh();
    state = validateSnapshot(latest, { expectedSchemaVersion: state.schemaVersion });
  }

  async function read(operation) {
    return enqueue(async () => {
      await refreshState();
      return operation(createOperations(state, { idFactory }));
    });
  }

  async function mutate(operation) {
    return enqueue(async () => {
      await refreshState();
      const previous = state;
      const draft = cloneSnapshot(previous);
      const result = await operation(createOperations(draft, { idFactory }));
      if (draft.revision !== previous.revision) {
        await persist(cloneSnapshot(draft), cloneSnapshot(previous));
        state = draft;
      }
      return result;
    });
  }

  const store = {
    adapterName,
    schemaVersion: state.schemaVersion,
    capabilities: Object.freeze({ ...capabilities }),
    async get(namespace, key) {
      return read((operations) => operations.get(namespace, key));
    },
    async put(namespace, key, value, options) {
      return mutate((operations) => operations.put(namespace, key, value, options));
    },
    async delete(namespace, key, options) {
      return mutate((operations) => operations.delete(namespace, key, options));
    },
    async list(namespace, options) {
      return read((operations) => operations.list(namespace, options));
    },
    async appendAudit(value, options) {
      return mutate((operations) => operations.appendAudit(value, options));
    },
    async transaction(callback) {
      if (typeof callback !== 'function') {
        throw new StoreContractError('[state-store] transaction callback must be a function');
      }
      return mutate((operations) => transactionContext.run(storeToken, () => callback(operations)));
    },
    async exportSnapshot() {
      return enqueue(async () => {
        await refreshState();
        return cloneSnapshot(state);
      });
    },
    async close() {
      if (closed) return;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await tail;
        try {
          if (onClose) await onClose();
        } finally {
          closed = true;
        }
      })();
      return closePromise;
    },
  };
  return Object.freeze(store);
}
