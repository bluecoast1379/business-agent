import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { createEmptySnapshot, createMemoryStateStore } from '../src/stores/index.js';

function populatedSnapshot(recordCount) {
  const snapshot = createEmptySnapshot();
  snapshot.revision = recordCount;
  snapshot.namespaces.session = Array.from({ length: recordCount }, (_, index) => ({
    key: `chat-session:${String(index).padStart(5, '0')}`,
    revision: index + 1,
    value: {
      id: index,
      messages: [],
      lastActiveAt: 1_700_000_000_000 + index,
      padding: 'x'.repeat(256),
    },
  }));
  return snapshot;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

test('memory transactions retain a reasonable p95 with 10,000 unrelated records', async () => {
  const recordCount = 10_000;
  const targetKey = 'chat-session:05000';
  const store = createMemoryStateStore({ initialSnapshot: populatedSnapshot(recordCount) });
  const update = async () => store.transaction((tx) => {
    const current = tx.get('session', targetKey);
    tx.put('session', targetKey, {
      ...current.value,
      lastActiveAt: current.value.lastActiveAt + 1,
    }, { ifRevision: current.revision });
  });

  try {
    // Warm the module/JIT before sampling. The 20ms ceiling is deliberately
    // coarse: it detects a return to full-snapshot cloning (tens of ms at this
    // size) without asserting fragile nanosecond-level timing.
    for (let index = 0; index < 20; index += 1) await update();
    const samples = [];
    for (let index = 0; index < 120; index += 1) {
      const startedAt = performance.now();
      await update();
      samples.push(performance.now() - startedAt);
    }

    const p95Ms = percentile(samples, 0.95);
    assert.ok(
      p95Ms < 20,
      `expected memory transaction p95 < 20ms with ${recordCount} records; observed ${p95Ms.toFixed(3)}ms`,
    );

    const snapshot = await store.exportSnapshot();
    assert.equal(snapshot.namespaces.session.length, recordCount);
    assert.equal(snapshot.namespaces.session[5_000].key, targetKey);
    assert.equal(snapshot.namespaces.session[5_000].value.lastActiveAt, 1_700_000_005_140);
  } finally {
    await store.close();
  }
});

