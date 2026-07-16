import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SessionCapacityError,
  createSessionStore,
} from '../src/runtime/session-store.js';
import { createMemoryStateStore } from '../src/stores/index.js';

test('durable TTL sweep crosses every page and removes tail-sorted private sessions', async () => {
  const canary = 'EXPIRED-SESSION-CANARY-7c3d68d1';
  const stateStore = createMemoryStateStore();
  const clock = 10_000;
  await stateStore.transaction((tx) => {
    for (let index = 0; index < 1_000; index += 1) {
      const id = `a-active-${String(index).padStart(4, '0')}`;
      tx.put('session', `chat-session:${id}`, {
        id,
        messages: [{ role: 'user', content: 'active' }],
        createdAt: 9_000,
        lastActiveAt: 9_500,
      }, { ifRevision: null });
    }
    for (let index = 0; index < 5; index += 1) {
      const id = `z-${canary}-${index}`;
      tx.put('session', `chat-session:${id}`, {
        id,
        messages: [{ role: 'user', content: `${canary}-message-${index}` }],
        createdAt: 0,
        lastActiveAt: 0,
      }, { ifRevision: null });
    }
  });
  const sessions = createSessionStore({
    stateStore,
    now: () => clock,
    ttlMs: 1_000,
    sweepIntervalMs: 1_000_000,
    maxRecords: 2_000,
  });
  try {
    assert.equal(await sessions.sweep(), 5);
    assert.equal(await sessions.size(), 1_000);
    const remaining = await stateStore.list('session', { prefix: 'chat-session:', limit: 1_000 });
    assert.equal(remaining.items.length, 1_000);
    assert.equal(remaining.nextCursor, null);
    assert.equal(JSON.stringify(await stateStore.exportSnapshot()).includes(canary), false);
  } finally {
    sessions.close();
    await stateStore.close();
  }
});

test('durable session capacity is atomic and management pages never expose ids or messages', async () => {
  const canary = 'ACTIVE-SESSION-CANARY-f17c44ab';
  let clock = 1_000;
  const stateStore = createMemoryStateStore();
  const sessions = createSessionStore({
    stateStore,
    now: () => clock,
    ttlMs: 10_000,
    sweepIntervalMs: 1_000_000,
    maxRecords: 2,
  });
  try {
    const privateId = `tenant:${canary}`;
    await sessions.setMessages(privateId, [{ role: 'user', content: `message:${canary}` }]);
    await sessions.setMessages('second-session', [{ role: 'user', content: 'second' }]);

    const firstPage = await sessions.listMetadata({ limit: 1 });
    const secondPage = await sessions.listMetadata({ cursor: firstPage.nextCursor, limit: 1 });
    const view = { firstPage, secondPage, capacity: await sessions.capacitySnapshot() };
    assert.equal(JSON.stringify(view).includes(canary), false);
    assert.equal(JSON.stringify(view).includes(privateId), false);
    assert.equal(JSON.stringify(view).includes('message:'), false);
    assert.equal(firstPage.items.length, 1);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.nextCursor, null);
    for (const item of [...firstPage.items, ...secondPage.items]) {
      assert.match(item.idDigest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(Object.hasOwn(item, 'id'), false);
      assert.equal(Object.hasOwn(item, 'messages'), false);
    }
    assert.deepEqual(view.capacity, {
      maxRecords: 2,
      records: 2,
      active: 2,
      expired: 0,
      leased: 0,
      available: 0,
      availableAfterExpiryPrune: 0,
    });

    // Simulate a legacy store created under a larger historical limit. An
    // expired record cannot be renewed into a third active session merely
    // because it already occupies a physical key.
    await stateStore.put('session', 'chat-session:legacy-expired', {
      id: 'legacy-expired',
      messages: [{ role: 'user', content: 'old' }],
      createdAt: -20_000,
      lastActiveAt: -20_000,
    });
    await assert.rejects(
      sessions.getOrCreate('legacy-expired'),
      (error) => error.code === 'SESSION_CAPACITY',
    );

    const attempts = await Promise.allSettled([
      sessions.getOrCreate('third-session'),
      sessions.setMessages('fourth-session', [{ role: 'user', content: 'fourth' }]),
      sessions.withSessionLock('fifth-session', async () => 'must not run'),
    ]);
    assert.equal(attempts.every(({ status }) => status === 'rejected'), true);
    for (const outcome of attempts) {
      assert.ok(outcome.reason instanceof SessionCapacityError);
      assert.equal(outcome.reason.code, 'SESSION_CAPACITY');
    }
    assert.equal((await sessions.getOrCreate(privateId)).messages[0].content, `message:${canary}`);
    const afterCapacityFailure = await sessions.capacitySnapshot();
    assert.equal(afterCapacityFailure.active, 2, 'capacity failure must not evict an active session');
    assert.equal(afterCapacityFailure.records, 3, 'legacy expired data remains until a successful reclaim transaction');
    assert.ok(await stateStore.get('session', 'chat-session:legacy-expired'), 'failed capacity transactions must roll back expiry cleanup');

    clock += 20_000;
    await sessions.getOrCreate('replacement-session');
    assert.equal((await sessions.capacitySnapshot()).records, 1, 'expired records may be reclaimed transactionally');
    assert.equal(JSON.stringify(await stateStore.exportSnapshot()).includes(canary), false);
  } finally {
    sessions.close();
    await stateStore.close();
  }
});

test('session reconciliation uses revision CAS and prune never deletes live leases', async () => {
  const canary = 'SESSION-RECONCILE-CANARY-b7a38c02';
  let clock = 10_000;
  const stateStore = createMemoryStateStore();
  const sessions = createSessionStore({
    stateStore,
    now: () => clock,
    ttlMs: 1_000,
    sweepIntervalMs: 1_000_000,
    maxRecords: 10,
  });
  try {
    const leaseId = `lease:${canary}`;
    await sessions.getOrCreate(leaseId);
    await stateStore.transaction((tx) => {
      const key = `chat-session:${leaseId}`;
      const record = tx.get('session', key);
      tx.put('session', key, {
        ...record.value,
        lease: { ownerId: `owner:${canary}`, expiresAt: clock - 1 },
      }, { ifRevision: record.revision });
    });
    const leaseMetadata = (await sessions.listMetadata({ limit: 10 })).items
      .find(({ idDigest }) => idDigest === firstDigestFor(leaseId));
    assert.ok(leaseMetadata);
    assert.equal(JSON.stringify(leaseMetadata).includes(canary), false);

    const reconciliations = await Promise.allSettled([
      sessions.reconcile(leaseMetadata.idDigest, {
        action: 'release_expired_lease',
        expectedRevision: leaseMetadata.revision,
      }),
      sessions.reconcile(leaseMetadata.idDigest, {
        action: 'release_expired_lease',
        expectedRevision: leaseMetadata.revision,
      }),
    ]);
    assert.equal(reconciliations.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(
      reconciliations.find(({ status }) => status === 'rejected').reason.code,
      'SESSION_RECONCILIATION_CONFLICT',
    );

    const expiredId = `expired:${canary}`;
    const leasedOldId = `leased-old:${canary}`;
    await sessions.getOrCreate(expiredId);
    await sessions.getOrCreate(leasedOldId);
    clock += 2_000;
    await stateStore.transaction((tx) => {
      const key = `chat-session:${leasedOldId}`;
      const record = tx.get('session', key);
      tx.put('session', key, {
        ...record.value,
        lease: { ownerId: `live-owner:${canary}`, expiresAt: clock + 10_000 },
      }, { ifRevision: record.revision });
    });

    await assert.rejects(
      sessions.prune({ before: clock + 1 }),
      (error) => error.code === 'SESSION_PRUNE_ACKNOWLEDGEMENT_REQUIRED',
    );
    const pruned = await sessions.prune({
      before: clock + 1,
      limit: 10,
      acknowledgeDataLoss: true,
    });
    assert.equal(pruned.pruned, 2, 'the expired lease session and ordinary expired session are removable');
    assert.equal(pruned.skippedLeased, 1);
    assert.equal((await sessions.capacitySnapshot()).leased, 1);
    assert.equal(await sessions.sweep(), 0, 'TTL sweep must retain a live leased session even when lastActiveAt is old');

    const leasedView = (await sessions.listMetadata({ status: 'leased', limit: 10 })).items;
    assert.equal(leasedView.length, 1);
    assert.equal(JSON.stringify(leasedView).includes(canary), false);
  } finally {
    sessions.close();
    await stateStore.close();
  }
});

function firstDigestFor(id) {
  // The management contract intentionally exposes only this one-way form.
  return `sha256:${createHash('sha256').update(id).digest('hex')}`;
}
