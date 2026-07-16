import {
  StoreConflictError,
  StoreContractError,
  StoreCorruptionError,
  assertStateStore,
  cloneSnapshot,
  createEmptySnapshot,
  validateSnapshot,
} from './contracts.js';
import { defaultMigrationRegistry } from './migrations.js';
import { createSnapshotStore } from './snapshot-store.js';

function assertDriver(driver) {
  if (!driver || typeof driver !== 'object') {
    throw new StoreContractError('[state-store:driver] driver must be an object');
  }
  for (const method of ['loadSnapshot', 'saveSnapshot']) {
    if (typeof driver[method] !== 'function') {
      throw new StoreContractError(`[state-store:driver] driver is missing ${method}()`);
    }
  }
  if (driver.capabilities?.atomicCommit !== true) {
    throw new StoreContractError('[state-store:driver] driver must guarantee atomicCommit');
  }
  const multiProcess = driver.capabilities?.multiProcess === true;
  if (multiProcess
      && (driver.capabilities?.transactions !== true || driver.capabilities?.compareAndSwap !== true)) {
    throw new StoreContractError(
      '[state-store:driver] multiProcess requires transactions and compareAndSwap capabilities',
    );
  }
}

async function saveWithConflictMapping(driver, snapshot, expectedRevision) {
  try {
    await driver.saveSnapshot(cloneSnapshot(snapshot), { expectedRevision });
  } catch (error) {
    if (error?.code === 'REVISION_CONFLICT') {
      throw new StoreConflictError('[state-store:driver] backend revision conflict', { cause: error });
    }
    throw error;
  }
}

/**
 * Adapter for an injected durable client. The client owns storage and must
 * implement atomic snapshot commits; advertised multi-process support is
 * accepted only when the client also declares transactions + CAS.
 */
export async function createDriverStateStore({
  driver,
  migrationRegistry = defaultMigrationRegistry,
  idFactory,
} = {}) {
  assertDriver(driver);
  if (!migrationRegistry || !Number.isInteger(migrationRegistry.currentVersion)) {
    throw new StoreContractError('[state-store:driver] migrationRegistry is invalid');
  }

  let snapshot = await driver.loadSnapshot();
  if (snapshot === null || snapshot === undefined) {
    snapshot = createEmptySnapshot(migrationRegistry.currentVersion);
    await saveWithConflictMapping(driver, snapshot, null);
  } else {
    snapshot = validateSnapshot(snapshot);
    if (snapshot.schemaVersion !== migrationRegistry.currentVersion) {
      const previousRevision = snapshot.revision;
      snapshot = await migrationRegistry.migrate(snapshot);
      await saveWithConflictMapping(driver, snapshot, previousRevision);
    }
  }
  snapshot = validateSnapshot(snapshot, { expectedSchemaVersion: migrationRegistry.currentVersion });

  const multiProcess = driver.capabilities.multiProcess === true;
  const refresh = multiProcess
    ? async () => {
        const latest = await driver.loadSnapshot();
        if (!latest) throw new StoreCorruptionError('[state-store:driver] backend snapshot disappeared');
        return validateSnapshot(latest, { expectedSchemaVersion: migrationRegistry.currentVersion });
      }
    : undefined;

  return assertStateStore(createSnapshotStore({
    adapterName: driver.name ? `driver:${driver.name}` : 'driver',
    capabilities: {
      durable: driver.capabilities.durable !== false,
      restartRecovery: driver.capabilities.durable !== false,
      transactions: true,
      compareAndSwap: driver.capabilities.compareAndSwap === true,
      multiProcess,
      migrations: true,
      atomicCommit: true,
      conformance: driver.capabilities.conformance ?? 'contract-tested',
    },
    initialSnapshot: snapshot,
    persist: (nextSnapshot, previousSnapshot) => (
      saveWithConflictMapping(driver, nextSnapshot, previousSnapshot.revision)
    ),
    refresh,
    idFactory,
    onClose: typeof driver.close === 'function' ? () => driver.close() : undefined,
  }));
}
