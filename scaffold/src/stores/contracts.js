/**
 * Shared state-store contract primitives.
 *
 * All adapters expose the same asynchronous record API. Values are restricted
 * to JSON so a value accepted by the memory adapter can always be persisted by
 * the zero-dependency file adapter without lossy coercion.
 */

export const STORE_FORMAT = 'business-agent-state';
export const CURRENT_STORE_SCHEMA_VERSION = 1;

export const STORE_NAMESPACES = Object.freeze([
  'session',
  'run',
  'confirmation',
  'cost',
  'job',
  'audit',
  'idempotency',
  'dead-letter',
]);

const NAMESPACE_SET = new Set(STORE_NAMESPACES);

function assertExactDataObject(value, expectedKeys, label) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StoreCorruptionError(`[state-store] ${label} must be a plain object`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== 'string')
      || JSON.stringify([...actualKeys].sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new StoreCorruptionError(
      `[state-store] ${label} fields must be exactly: ${expectedKeys.join(', ')}`,
    );
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new StoreCorruptionError(`[state-store] ${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertDenseDataArray(value, label) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new StoreCorruptionError(`[state-store] ${label} must not contain symbol properties`);
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  if (propertyNames.length !== value.length + 1) {
    throw new StoreCorruptionError(`[state-store] ${label} must be a dense array without custom properties`);
  }
  for (const propertyName of propertyNames) {
    if (propertyName === 'length') continue;
    const index = Number(propertyName);
    const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
    if (!Number.isInteger(index)
        || index < 0
        || index >= value.length
        || String(index) !== propertyName
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw new StoreCorruptionError(`[state-store] ${label} must be a dense data array`);
    }
  }
}

export class StateStoreError extends Error {
  constructor(message, { code = 'STATE_STORE_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class StoreContractError extends StateStoreError {
  constructor(message, options = {}) {
    super(message, { code: 'STORE_CONTRACT_ERROR', ...options });
  }
}

export class StoreConflictError extends StateStoreError {
  constructor(message, options = {}) {
    super(message, { code: 'STORE_CONFLICT', ...options });
  }
}

export class StoreCorruptionError extends StateStoreError {
  constructor(message, options = {}) {
    super(message, { code: 'STORE_CORRUPTION', ...options });
  }
}

export class UnsupportedSchemaVersionError extends StateStoreError {
  constructor(message, options = {}) {
    super(message, { code: 'UNSUPPORTED_SCHEMA_VERSION', ...options });
  }
}

export class ImmutableNamespaceError extends StateStoreError {
  constructor(message, options = {}) {
    super(message, { code: 'IMMUTABLE_NAMESPACE', ...options });
  }
}

export function assertNamespace(namespace) {
  if (!NAMESPACE_SET.has(namespace)) {
    throw new StoreContractError(
      `[state-store] unknown namespace ${JSON.stringify(namespace)}; expected one of: ${STORE_NAMESPACES.join(', ')}`,
    );
  }
  return namespace;
}

export function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StoreContractError('[state-store] key must be a non-empty string');
  }
  return key;
}

function assertJsonNode(value, path, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StoreContractError(`[state-store] ${path} must not contain a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new StoreContractError(`[state-store] ${path} must contain JSON-compatible values only`);
  }
  if (ancestors.has(value)) {
    throw new StoreContractError(`[state-store] ${path} must not contain a circular reference`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new StoreContractError(`[state-store] ${path} must not contain symbol properties`);
    }
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== value.length + 1) {
      throw new StoreContractError(`[state-store] ${path} must be a dense array without custom properties`);
    }
    for (const propertyName of propertyNames) {
      if (propertyName === 'length') continue;
      const index = Number(propertyName);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== propertyName) {
        throw new StoreContractError(`[state-store] ${path} must be a dense array without custom properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new StoreContractError(`[state-store] ${path}[${index}] must be an enumerable data property`);
      }
      assertJsonNode(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StoreContractError(`[state-store] ${path} must be a plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new StoreContractError(`[state-store] ${path} must not contain symbol properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new StoreContractError(`[state-store] ${path}.${key} must be an enumerable data property`);
      }
      assertJsonNode(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function cloneJsonValue(value, path = 'value') {
  if (value === undefined) {
    throw new StoreContractError(`[state-store] ${path} must not be undefined`);
  }
  assertJsonNode(value, path, new Set());
  // JSON round-tripping also normalizes edge cases such as -0 and null
  // prototypes, keeping memory and durable adapters byte-for-byte equivalent.
  return JSON.parse(JSON.stringify(value));
}

export function createEmptySnapshot(schemaVersion = CURRENT_STORE_SCHEMA_VERSION) {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new StoreContractError('[state-store] schemaVersion must be a positive integer');
  }
  return {
    format: STORE_FORMAT,
    schemaVersion,
    revision: 0,
    namespaces: Object.fromEntries(STORE_NAMESPACES.map((namespace) => [namespace, []])),
  };
}

/** Validate and clone a serialized snapshot, rejecting partial or ambiguous state. */
export function validateSnapshot(snapshot, { expectedSchemaVersion } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new StoreCorruptionError('[state-store] snapshot must be an object');
  }
  assertExactDataObject(
    snapshot,
    ['format', 'schemaVersion', 'revision', 'namespaces'],
    'snapshot',
  );
  if (snapshot.format !== STORE_FORMAT) {
    throw new StoreCorruptionError(`[state-store] unsupported snapshot format ${JSON.stringify(snapshot.format)}`);
  }
  if (!Number.isInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1) {
    throw new StoreCorruptionError('[state-store] snapshot schemaVersion must be a positive integer');
  }
  if (expectedSchemaVersion !== undefined && snapshot.schemaVersion !== expectedSchemaVersion) {
    throw new UnsupportedSchemaVersionError(
      `[state-store] expected schemaVersion ${expectedSchemaVersion}, found ${snapshot.schemaVersion}`,
    );
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new StoreCorruptionError('[state-store] snapshot revision must be a non-negative integer');
  }
  if (!snapshot.namespaces || typeof snapshot.namespaces !== 'object' || Array.isArray(snapshot.namespaces)) {
    throw new StoreCorruptionError('[state-store] snapshot namespaces must be an object');
  }
  assertExactDataObject(snapshot.namespaces, STORE_NAMESPACES, 'snapshot namespaces');

  const cloned = createEmptySnapshot(snapshot.schemaVersion);
  cloned.revision = snapshot.revision;
  for (const namespace of STORE_NAMESPACES) {
    const entries = snapshot.namespaces[namespace];
    if (!Array.isArray(entries)) {
      throw new StoreCorruptionError(`[state-store] namespace ${namespace} must be an array`);
    }
    assertDenseDataArray(entries, `namespace ${namespace}`);
    const keys = new Set();
    cloned.namespaces[namespace] = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new StoreCorruptionError(`[state-store] ${namespace}[${index}] must be an object`);
      }
      assertExactDataObject(entry, ['key', 'revision', 'value'], `${namespace}[${index}]`);
      try {
        assertKey(entry.key);
      } catch (error) {
        throw new StoreCorruptionError(`[state-store] invalid key in ${namespace}[${index}]`, { cause: error });
      }
      if (keys.has(entry.key)) {
        throw new StoreCorruptionError(`[state-store] duplicate key ${JSON.stringify(entry.key)} in ${namespace}`);
      }
      keys.add(entry.key);
      if (!Number.isInteger(entry.revision) || entry.revision < 1 || entry.revision > snapshot.revision) {
        throw new StoreCorruptionError(`[state-store] invalid revision for ${namespace}/${entry.key}`);
      }
      let value;
      try {
        value = cloneJsonValue(entry.value, `${namespace}/${entry.key}`);
      } catch (error) {
        throw new StoreCorruptionError(`[state-store] invalid value for ${namespace}/${entry.key}`, { cause: error });
      }
      return { key: entry.key, revision: entry.revision, value };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }
  return cloned;
}

export function cloneSnapshot(snapshot) {
  return validateSnapshot(snapshot, { expectedSchemaVersion: snapshot.schemaVersion });
}

export function assertStateStore(store) {
  if (!store || typeof store !== 'object') {
    throw new StoreContractError('[state-store] adapter must be an object');
  }
  for (const method of ['get', 'put', 'delete', 'list', 'appendAudit', 'transaction', 'exportSnapshot', 'close']) {
    if (typeof store[method] !== 'function') {
      throw new StoreContractError(`[state-store] adapter is missing async method ${method}()`);
    }
  }
  if (!Number.isInteger(store.schemaVersion) || store.schemaVersion < 1) {
    throw new StoreContractError('[state-store] adapter schemaVersion must be a positive integer');
  }
  if (!store.capabilities || store.capabilities.transactions !== true) {
    throw new StoreContractError('[state-store] adapter must declare transactional capability');
  }
  return store;
}
