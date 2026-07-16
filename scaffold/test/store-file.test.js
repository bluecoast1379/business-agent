import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  STORE_NAMESPACES,
  StoreCorruptionError,
  UnsupportedSchemaVersionError,
  createEmptySnapshot,
  createFileStateStore,
  createMigrationRegistry,
  decodeFileSnapshot,
  encodeFileSnapshot,
} from '../src/stores/index.js';

async function withTemporaryStateFile(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'business-agent-file-store-'));
  const filePath = join(directory, 'state.json');
  try {
    return await callback({ directory, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function snapshotWithRun(schemaVersion = 1) {
  const snapshot = createEmptySnapshot(schemaVersion);
  snapshot.revision = 1;
  snapshot.namespaces.run.push({
    key: 'run-before-migration',
    revision: 1,
    value: { status: 'queued' },
  });
  return snapshot;
}

test('file adapter recovers every namespace across a clean restart', async () => {
  await withTemporaryStateFile(async ({ directory, filePath }) => {
    const first = await createFileStateStore({ filePath });
    for (const namespace of STORE_NAMESPACES.filter((name) => name !== 'audit')) {
      await first.put(namespace, `${namespace}-1`, { namespace, sequence: 1 });
    }
    await first.appendAudit({ action: 'restart-check' }, { key: 'audit-1' });
    const committedSnapshot = await first.exportSnapshot();
    await first.close();

    const namesAfterCommit = await readdir(directory);
    assert.deepEqual(namesAfterCommit, [basename(filePath)]);
    assert.deepEqual(decodeFileSnapshot(await readFile(filePath, 'utf8')), committedSnapshot);

    const restarted = await createFileStateStore({ filePath });
    try {
      for (const namespace of STORE_NAMESPACES.filter((name) => name !== 'audit')) {
        assert.deepEqual((await restarted.get(namespace, `${namespace}-1`)).value, {
          namespace,
          sequence: 1,
        });
      }
      assert.equal((await restarted.get('audit', 'audit-1')).value.action, 'restart-check');
      assert.deepEqual(await restarted.exportSnapshot(), committedSnapshot);
    } finally {
      await restarted.close();
    }
  });
});

test('file adapter serializes concurrent transactions across instances in one process', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const [first, second] = await Promise.all([
      createFileStateStore({ filePath }),
      createFileStateStore({ filePath }),
    ]);
    try {
      await first.put('cost', 'shared-total', { units: 0 });
      const increment = (store) => store.transaction(async (tx) => {
        const current = tx.get('cost', 'shared-total');
        await Promise.resolve();
        tx.put(
          'cost',
          'shared-total',
          { units: current.value.units + 1 },
          { ifRevision: current.revision },
        );
      });
      await Promise.all(Array.from({ length: 60 }, (_, index) => (
        increment(index % 2 === 0 ? first : second)
      )));
      assert.equal((await first.get('cost', 'shared-total')).value.units, 60);
      assert.equal((await second.get('cost', 'shared-total')).value.units, 60);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

test('file adapter safely reaps one abandoned lock under concurrent acquisition', async () => {
  await withTemporaryStateFile(async ({ directory, filePath }) => {
    await writeFile(`${filePath}.lock`, JSON.stringify({
      version: 1,
      token: '<synthetic-lock-id>',
      pid: 2_147_483_647,
      host: hostname(),
      createdAt: '2000-01-01T00:00:00.000Z',
    }), 'utf8');

    const stores = await Promise.all(Array.from(
      { length: 8 },
      () => createFileStateStore({ filePath, lockTimeoutMs: 5_000 }),
    ));
    try {
      await Promise.all(stores.map((store, index) => store.put('run', `writer-${index}`, { index })));
      const page = await stores[0].list('run', { limit: 100 });
      assert.equal(page.items.length, 8);
      assert.deepEqual(page.items.map((item) => item.value.index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual((await readdir(directory)).sort(), [basename(filePath)]);
    } finally {
      await Promise.all(stores.map((store) => store.close()));
    }
  });
});

test('file adapter ignores stale crash temp files and keeps the committed snapshot', async () => {
  await withTemporaryStateFile(async ({ directory, filePath }) => {
    const first = await createFileStateStore({ filePath });
    await first.put('job', 'committed-job', { status: 'ready' });
    await first.close();

    const staleTempPath = join(directory, `.${basename(filePath)}.tmp-crashed-writer`);
    await writeFile(staleTempPath, '{"partial":', 'utf8');
    const restarted = await createFileStateStore({ filePath });
    try {
      assert.equal((await restarted.get('job', 'committed-job')).value.status, 'ready');
      assert.deepEqual(await readdir(directory), [basename(filePath)]);
    } finally {
      await restarted.close();
    }
  });
});

test('file adapter fails closed on malformed JSON without rewriting evidence', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const corrupted = '{"format":"business-agent-state","schemaVersion":1';
    await writeFile(filePath, corrupted, 'utf8');
    await assert.rejects(createFileStateStore({ filePath }), StoreCorruptionError);
    assert.equal(await readFile(filePath, 'utf8'), corrupted);
  });
});

test('file adapter fails closed on a checksum mismatch without publishing partial state', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const store = await createFileStateStore({ filePath });
    await store.put('session', 'trusted', { status: 'active' });
    await store.close();

    const envelope = JSON.parse(await readFile(filePath, 'utf8'));
    envelope.namespaces.session[0].value.status = 'tampered';
    const tampered = `${JSON.stringify(envelope, null, 2)}\n`;
    await writeFile(filePath, tampered, 'utf8');
    await assert.rejects(createFileStateStore({ filePath }), StoreCorruptionError);
    assert.equal(await readFile(filePath, 'utf8'), tampered);
  });
});

test('snapshot validation rejects ambiguous extra fields and sparse namespace arrays', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const extraField = createEmptySnapshot();
    extraField.unrecognized = true;
    assert.throws(() => encodeFileSnapshot(extraField), StoreCorruptionError);

    const sparseNamespace = createEmptySnapshot();
    sparseNamespace.revision = 1;
    sparseNamespace.namespaces.run.length = 1;
    assert.throws(() => encodeFileSnapshot(sparseNamespace), StoreCorruptionError);

    const extraEntryField = snapshotWithRun();
    extraEntryField.namespaces.run[0].unrecognized = true;
    assert.throws(() => encodeFileSnapshot(extraEntryField), StoreCorruptionError);

    assert.equal(await readFile(filePath, 'utf8').catch((error) => error.code), 'ENOENT');
  });
});

test('file adapter persists an explicit migration once and restarts at the new schema', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    await writeFile(filePath, encodeFileSnapshot(snapshotWithRun()), 'utf8');
    let migrationCalls = 0;
    const migrations = createMigrationRegistry({ currentVersion: 2 });
    migrations.register(1, (snapshot) => {
      migrationCalls += 1;
      snapshot.namespaces.run[0].value.migrated = true;
    });

    const migrated = await createFileStateStore({ filePath, migrationRegistry: migrations });
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual((await migrated.get('run', 'run-before-migration')).value, {
      status: 'queued',
      migrated: true,
    });
    await migrated.close();
    assert.equal(decodeFileSnapshot(await readFile(filePath, 'utf8')).schemaVersion, 2);

    const restarted = await createFileStateStore({ filePath, migrationRegistry: migrations });
    try {
      assert.equal(restarted.schemaVersion, 2);
      assert.equal(migrationCalls, 1);
    } finally {
      await restarted.close();
    }
  });
});

test('file adapter rejects migration gaps and snapshots newer than the runtime', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const versionTwo = createMigrationRegistry({ currentVersion: 2 });
    const versionOneText = encodeFileSnapshot(snapshotWithRun(1));
    await writeFile(filePath, versionOneText, 'utf8');
    await assert.rejects(
      createFileStateStore({ filePath, migrationRegistry: versionTwo }),
      UnsupportedSchemaVersionError,
    );
    assert.equal(await readFile(filePath, 'utf8'), versionOneText);

    const versionThreeText = encodeFileSnapshot(createEmptySnapshot(3));
    await writeFile(filePath, versionThreeText, 'utf8');
    await assert.rejects(
      createFileStateStore({ filePath, migrationRegistry: versionTwo }),
      UnsupportedSchemaVersionError,
    );
    assert.equal(await readFile(filePath, 'utf8'), versionThreeText);
  });
});

test('file adapter detects corruption introduced while a process remains open', async () => {
  await withTemporaryStateFile(async ({ filePath }) => {
    const store = await createFileStateStore({ filePath });
    await store.put('session', 'known-good', { status: 'active' });
    const committed = await readFile(filePath, 'utf8');
    await writeFile(filePath, '{"broken":true}\n', 'utf8');
    await assert.rejects(store.put('run', 'must-not-commit', { status: 'queued' }), StoreCorruptionError);
    assert.equal(await readFile(filePath, 'utf8'), '{"broken":true}\n');

    await writeFile(filePath, committed, 'utf8');
    assert.equal((await store.get('session', 'known-good')).value.status, 'active');
    assert.equal(await store.get('run', 'must-not-commit'), null);
    await store.close();
  });
});
