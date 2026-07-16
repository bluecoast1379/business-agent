import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StoreConflictError,
  StoreContractError,
  StoreCorruptionError,
  createDriverStateStore,
  createEmptySnapshot,
  createMigrationRegistry,
} from '../src/stores/index.js';

function createSharedBackend({
  initialSnapshot = null,
  multiProcess = true,
} = {}) {
  let snapshot = initialSnapshot === null ? null : structuredClone(initialSnapshot);
  let injectConflict = false;
  let closeCalls = 0;

  return {
    injectConflictOnNextSave() {
      injectConflict = true;
    },
    peek() {
      return snapshot === null ? null : structuredClone(snapshot);
    },
    get closeCalls() {
      return closeCalls;
    },
    createDriver() {
      return {
        name: 'shared-fixture',
        capabilities: {
          atomicCommit: true,
          durable: true,
          transactions: true,
          compareAndSwap: true,
          multiProcess,
          conformance: 'test-fixture',
        },
        async loadSnapshot() {
          return snapshot === null ? null : structuredClone(snapshot);
        },
        async saveSnapshot(next, { expectedRevision }) {
          if (injectConflict) {
            injectConflict = false;
            const external = structuredClone(snapshot);
            external.revision += 1;
            external.namespaces.audit.push({
              key: `external-${external.revision}`,
              revision: external.revision,
              value: { action: 'external-commit' },
            });
            snapshot = external;
          }
          const actualRevision = snapshot?.revision ?? null;
          if (actualRevision !== expectedRevision) {
            const error = new Error(`expected ${expectedRevision}, found ${actualRevision}`);
            error.code = 'REVISION_CONFLICT';
            throw error;
          }
          snapshot = structuredClone(next);
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  };
}

test('driver adapter delegates durable restart recovery to an injected backend', async () => {
  const backend = createSharedBackend();
  const first = await createDriverStateStore({ driver: backend.createDriver() });
  await first.put('idempotency', 'request-1', { response: 'accepted' });
  await first.appendAudit({ action: 'accepted' }, { key: 'audit-1' });
  await first.close();

  const restarted = await createDriverStateStore({ driver: backend.createDriver() });
  try {
    assert.deepEqual((await restarted.get('idempotency', 'request-1')).value, {
      response: 'accepted',
    });
    assert.equal((await restarted.get('audit', 'audit-1')).value.action, 'accepted');
    assert.equal(restarted.capabilities.durable, true);
    assert.equal(restarted.capabilities.multiProcess, true);
    assert.equal(restarted.capabilities.compareAndSwap, true);
  } finally {
    await restarted.close();
  }
  assert.equal(backend.closeCalls, 2);
});

test('driver adapter maps backend CAS conflicts and leaves the attempted transaction unpublished', async () => {
  const backend = createSharedBackend();
  const store = await createDriverStateStore({ driver: backend.createDriver() });
  await store.put('run', 'existing', { status: 'running' });
  backend.injectConflictOnNextSave();

  await assert.rejects(
    store.transaction((tx) => {
      tx.put('run', 'attempted', { status: 'queued' });
      tx.appendAudit({ action: 'attempted' }, { key: 'attempted-audit' });
    }),
    StoreConflictError,
  );
  assert.equal(await store.get('run', 'attempted'), null);
  assert.equal(await store.get('audit', 'attempted-audit'), null);
  assert.equal((await store.get('run', 'existing')).value.status, 'running');
  assert.equal((await store.list('audit')).items[0].value.action, 'external-commit');
  await store.close();
});

test('driver adapter enforces honest atomic and multi-process capabilities', async () => {
  const baseDriver = {
    async loadSnapshot() {
      return null;
    },
    async saveSnapshot() {},
  };

  await assert.rejects(
    createDriverStateStore({
      driver: { ...baseDriver, capabilities: { atomicCommit: false } },
    }),
    StoreContractError,
  );
  await assert.rejects(
    createDriverStateStore({
      driver: {
        ...baseDriver,
        capabilities: {
          atomicCommit: true,
          multiProcess: true,
          transactions: true,
          compareAndSwap: false,
        },
      },
    }),
    StoreContractError,
  );
  await assert.rejects(
    createDriverStateStore({
      driver: {
        ...baseDriver,
        capabilities: {
          atomicCommit: true,
          multiProcess: true,
          transactions: false,
          compareAndSwap: true,
        },
      },
    }),
    StoreContractError,
  );
});

test('driver adapter fails closed when an injected backend returns corrupt state', async () => {
  const backend = createSharedBackend({ initialSnapshot: createEmptySnapshot() });
  const corrupt = backend.peek();
  corrupt.namespaces.session = 'not-an-array';
  const driver = backend.createDriver();
  driver.loadSnapshot = async () => corrupt;
  await assert.rejects(createDriverStateStore({ driver }), StoreCorruptionError);
});

test('driver adapter migrates an injected durable snapshot before serving traffic', async () => {
  const versionOne = createEmptySnapshot(1);
  versionOne.revision = 1;
  versionOne.namespaces.job.push({
    key: 'job-1',
    revision: 1,
    value: { status: 'queued' },
  });
  const backend = createSharedBackend({ initialSnapshot: versionOne, multiProcess: false });
  const migrations = createMigrationRegistry({ currentVersion: 2 });
  migrations.register(1, (snapshot) => {
    snapshot.namespaces.job[0].value.priority = 'normal';
  });

  const store = await createDriverStateStore({
    driver: backend.createDriver(),
    migrationRegistry: migrations,
  });
  try {
    assert.equal(store.schemaVersion, 2);
    assert.deepEqual((await store.get('job', 'job-1')).value, {
      status: 'queued',
      priority: 'normal',
    });
    assert.equal(backend.peek().schemaVersion, 2);
  } finally {
    await store.close();
  }
});
