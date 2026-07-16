import {
  CURRENT_STORE_SCHEMA_VERSION,
  StoreContractError,
  UnsupportedSchemaVersionError,
  cloneSnapshot,
  validateSnapshot,
} from './contracts.js';

/** Ordered, explicit snapshot migrations. Downgrades and missing steps fail closed. */
export function createMigrationRegistry({ currentVersion = CURRENT_STORE_SCHEMA_VERSION } = {}) {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new StoreContractError('[state-store] migration currentVersion must be a positive integer');
  }
  const steps = new Map();

  return Object.freeze({
    currentVersion,
    register(fromVersion, migrate) {
      if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion >= currentVersion) {
        throw new StoreContractError(
          `[state-store] migration source must be between 1 and ${currentVersion - 1}`,
        );
      }
      if (typeof migrate !== 'function') {
        throw new StoreContractError('[state-store] migration must be a function');
      }
      if (steps.has(fromVersion)) {
        throw new StoreContractError(`[state-store] migration ${fromVersion}->${fromVersion + 1} already exists`);
      }
      steps.set(fromVersion, migrate);
      return this;
    },
    async migrate(snapshot) {
      let current = validateSnapshot(snapshot);
      if (current.schemaVersion > currentVersion) {
        throw new UnsupportedSchemaVersionError(
          `[state-store] snapshot schemaVersion ${current.schemaVersion} is newer than supported ${currentVersion}`,
        );
      }
      while (current.schemaVersion < currentVersion) {
        const fromVersion = current.schemaVersion;
        const migrate = steps.get(fromVersion);
        if (!migrate) {
          throw new UnsupportedSchemaVersionError(
            `[state-store] no migration registered for ${fromVersion}->${fromVersion + 1}`,
          );
        }
        const draft = cloneSnapshot(current);
        const returned = await migrate(draft);
        current = returned === undefined ? draft : returned;
        if (!current || typeof current !== 'object') {
          throw new StoreContractError(`[state-store] migration ${fromVersion}->${fromVersion + 1} returned invalid state`);
        }
        current.schemaVersion = fromVersion + 1;
        current = validateSnapshot(current, { expectedSchemaVersion: fromVersion + 1 });
      }
      return current;
    },
    has(fromVersion) {
      return steps.has(fromVersion);
    },
  });
}

export const defaultMigrationRegistry = createMigrationRegistry();
