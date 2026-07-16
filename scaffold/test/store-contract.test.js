import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ImmutableNamespaceError,
  STORE_NAMESPACES,
  StoreConflictError,
  StoreContractError,
  createDriverStateStore,
  createFileStateStore,
  createMemoryStateStore,
} from '../src/stores/index.js';

function createDriverBackend() {
  let snapshot = null;
  return {
    createDriver() {
      return {
        name: 'contract-fixture',
        capabilities: {
          atomicCommit: true,
          durable: true,
          transactions: true,
          compareAndSwap: true,
          multiProcess: false,
          conformance: 'test-fixture',
        },
        async loadSnapshot() {
          return snapshot === null ? null : structuredClone(snapshot);
        },
        async saveSnapshot(next, { expectedRevision }) {
          const actualRevision = snapshot?.revision ?? null;
          if (actualRevision !== expectedRevision) {
            const error = new Error(`expected ${expectedRevision}, found ${actualRevision}`);
            error.code = 'REVISION_CONFLICT';
            throw error;
          }
          snapshot = structuredClone(next);
        },
      };
    },
  };
}

const adapterFactories = {
  memory: async () => ({
    store: createMemoryStateStore(),
    cleanup: async () => {},
  }),
  file: async () => {
    const directory = await mkdtemp(join(tmpdir(), 'business-agent-store-contract-'));
    const store = await createFileStateStore({ filePath: join(directory, 'state.json') });
    return {
      store,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  },
  driver: async () => {
    const backend = createDriverBackend();
    return {
      store: await createDriverStateStore({ driver: backend.createDriver() }),
      cleanup: async () => {},
    };
  },
};

async function withStore(factory, callback) {
  const resource = await factory();
  try {
    return await callback(resource.store);
  } finally {
    await resource.store.close();
    await resource.cleanup();
  }
}

function installContractSuite(adapterName, factory) {
  test(`${adapterName}: covers every state namespace with one async contract`, async () => {
    await withStore(factory, async (store) => {
      assert.equal(store.capabilities.transactions, true);
      assert.equal(typeof store.schemaVersion, 'number');
      const promiseCheck = store.get('session', 'promise-check');
      assert.ok(promiseCheck instanceof Promise);
      assert.equal(await promiseCheck, null);

      for (const namespace of STORE_NAMESPACES.filter((name) => name !== 'audit')) {
        const value = { namespace, nested: { active: true }, values: [1, null, 'ok'] };
        const written = await store.put(namespace, 'record', value, { ifRevision: null });
        assert.equal(written.key, 'record');
        assert.deepEqual((await store.get(namespace, 'record')).value, value);
      }

      const audit = await store.appendAudit({ action: 'contract-check' }, { key: 'audit-1' });
      assert.equal(audit.key, 'audit-1');
      assert.deepEqual((await store.get('audit', 'audit-1')).value, { action: 'contract-check' });
      await assert.rejects(
        store.appendAudit({ action: 'duplicate' }, { key: 'audit-1' }),
        StoreConflictError,
      );
      await assert.rejects(
        store.put('audit', 'audit-2', { action: 'invalid' }),
        ImmutableNamespaceError,
      );
      await assert.rejects(store.delete('audit', 'audit-1'), ImmutableNamespaceError);

      for (const namespace of STORE_NAMESPACES.filter((name) => name !== 'audit')) {
        assert.equal(await store.delete(namespace, 'record'), true);
        assert.equal(await store.get(namespace, 'record'), null);
      }
    });
  });

  test(`${adapterName}: clones JSON values at every API boundary`, async () => {
    await withStore(factory, async (store) => {
      const input = { nested: { count: 1 }, list: [{ enabled: true }] };
      const written = await store.put('session', 'clone', input);
      input.nested.count = 99;
      written.value.list[0].enabled = false;

      const firstRead = await store.get('session', 'clone');
      assert.deepEqual(firstRead.value, {
        nested: { count: 1 },
        list: [{ enabled: true }],
      });
      firstRead.value.nested.count = 88;
      assert.equal((await store.get('session', 'clone')).value.nested.count, 1);

      const snapshot = await store.exportSnapshot();
      snapshot.namespaces.session[0].value.nested.count = 77;
      assert.equal((await store.get('session', 'clone')).value.nested.count, 1);
    });
  });

  test(`${adapterName}: supports record CAS and deterministic pagination`, async () => {
    await withStore(factory, async (store) => {
      const created = await store.put('run', 'job/02', { step: 1 }, { ifRevision: null });
      await assert.rejects(
        store.put('run', 'job/02', { step: 2 }, { ifRevision: null }),
        StoreConflictError,
      );
      const updated = await store.put(
        'run',
        'job/02',
        { step: 2 },
        { ifRevision: created.revision },
      );
      await assert.rejects(
        store.put('run', 'job/02', { step: 3 }, { ifRevision: created.revision }),
        StoreConflictError,
      );

      await store.put('run', 'job/01', { step: 1 });
      await store.put('run', 'job/03', { step: 3 });
      await store.put('run', 'other/01', { step: 4 });
      const firstPage = await store.list('run', { prefix: 'job/', limit: 2 });
      assert.deepEqual(firstPage.items.map((item) => item.key), ['job/01', 'job/02']);
      assert.equal(firstPage.nextCursor, 'job/02');
      const secondPage = await store.list('run', {
        prefix: 'job/',
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      assert.deepEqual(secondPage.items.map((item) => item.key), ['job/03']);
      assert.equal(secondPage.nextCursor, null);

      assert.equal(await store.delete('run', 'job/02', { ifRevision: updated.revision }), true);
      await assert.rejects(
        store.delete('run', 'job/01', { ifRevision: updated.revision }),
        StoreConflictError,
      );
    });
  });

  test(`${adapterName}: commits and rolls back multi-namespace transactions atomically`, async () => {
    await withStore(factory, async (store) => {
      const result = await store.transaction(async (tx) => {
        tx.put('session', 's-1', { status: 'active' }, { ifRevision: null });
        await Promise.resolve();
        tx.put('run', 'r-1', { status: 'running' }, { ifRevision: null });
        tx.put('confirmation', 'c-1', { status: 'pending' });
        tx.appendAudit({ action: 'started' }, { key: 'a-1' });
        return 'committed';
      });
      assert.equal(result, 'committed');
      assert.equal((await store.get('run', 'r-1')).value.status, 'running');
      assert.equal((await store.get('audit', 'a-1')).value.action, 'started');

      const before = await store.exportSnapshot();
      await assert.rejects(
        store.transaction((tx) => {
          tx.put('cost', 'cost-rollback', { cents: 10 });
          tx.appendAudit({ action: 'must-not-commit' }, { key: 'a-rollback' });
          throw new Error('rollback');
        }),
        /rollback/,
      );
      assert.deepEqual(await store.exportSnapshot(), before);
      assert.equal(await store.get('cost', 'cost-rollback'), null);
      assert.equal(await store.get('audit', 'a-rollback'), null);

      await assert.rejects(
        store.transaction(async (tx) => {
          tx.put('job', 'outer', { status: 'pending' });
          await store.put('job', 'nested-public-call', { status: 'invalid' });
        }),
        /supplied transaction object/,
      );
      assert.equal(await store.get('job', 'outer'), null);
      assert.equal(await store.get('job', 'nested-public-call'), null);
    });
  });

  test(`${adapterName}: serializes concurrent transactions without lost updates`, async () => {
    await withStore(factory, async (store) => {
      await store.put('cost', 'daily-total', { units: 0 });
      await Promise.all(Array.from({ length: 50 }, () => store.transaction(async (tx) => {
        const current = tx.get('cost', 'daily-total');
        await Promise.resolve();
        tx.put(
          'cost',
          'daily-total',
          { units: current.value.units + 1 },
          { ifRevision: current.revision },
        );
      })));
      assert.equal((await store.get('cost', 'daily-total')).value.units, 50);
    });
  });

  test(`${adapterName}: rejects invalid namespaces, keys, revisions, and non-JSON state`, async () => {
    await withStore(factory, async (store) => {
      await assert.rejects(store.get('unknown', 'key'), StoreContractError);
      await assert.rejects(store.get('session', ''), StoreContractError);
      await assert.rejects(store.put('session', 'undefined', undefined), StoreContractError);
      await assert.rejects(store.put('session', 'nan', Number.NaN), StoreContractError);
      await assert.rejects(store.put('session', 'date', new Date()), StoreContractError);
      await assert.rejects(
        store.put('session', 'bad-revision', {}, { ifRevision: 0 }),
        StoreContractError,
      );
      await assert.rejects(store.list('session', { limit: 0 }), StoreContractError);

      const circular = {};
      circular.self = circular;
      await assert.rejects(store.put('session', 'circular', circular), StoreContractError);

      const sparse = [];
      sparse.length = 1;
      await assert.rejects(store.put('session', 'sparse', sparse), StoreContractError);
      const symbolProperty = { safe: true };
      symbolProperty[Symbol('hidden')] = true;
      await assert.rejects(store.put('session', 'symbol-key', symbolProperty), StoreContractError);
      const hiddenProperty = { safe: true };
      Object.defineProperty(hiddenProperty, 'hidden', { value: true });
      await assert.rejects(store.put('session', 'hidden-key', hiddenProperty), StoreContractError);

      await store.put('session', 'negative-zero', { amount: -0 });
      assert.equal(Object.is((await store.get('session', 'negative-zero')).value.amount, -0), false);
    });
  });
}

for (const [adapterName, factory] of Object.entries(adapterFactories)) {
  installContractSuite(adapterName, factory);
}

test('adapter capability declarations distinguish built-in durability guarantees', async () => {
  const memory = createMemoryStateStore();
  assert.equal(memory.capabilities.durable, false);
  assert.equal(memory.capabilities.restartRecovery, false);
  await memory.close();

  const directory = await mkdtemp(join(tmpdir(), 'business-agent-store-capability-'));
  try {
    const file = await createFileStateStore({ filePath: join(directory, 'state.json') });
    assert.equal(file.capabilities.durable, true);
    assert.equal(file.capabilities.atomicRename, true);
    assert.equal(file.capabilities.multiProcess, true);
    assert.equal(file.capabilities.multiHost, false);
    await file.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('closed adapters reject new work asynchronously and close idempotently', async () => {
  const store = createMemoryStateStore();
  await store.close();
  const rejected = store.get('session', 'after-close');
  assert.ok(rejected instanceof Promise);
  await assert.rejects(rejected, StoreContractError);
  await store.close();
});
