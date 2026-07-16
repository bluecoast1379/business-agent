import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfirmationCenter } from '../src/guardrails/confirm-gate.js';
import { createCostTracker } from '../src/runtime/cost-tracker.js';
import { createSessionStore } from '../src/runtime/session-store.js';
import { createFileStateStore, createMemoryStateStore } from '../src/stores/index.js';

const WORKER = new URL('./fixtures/file-store-reserve-worker.mjs', import.meta.url);

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type && message?.type !== 'error') return;
      cleanup();
      if (message.type === 'error') reject(Object.assign(new Error('worker failed'), { code: message.code }));
      else resolve(message);
    };
    const onExit = (code) => { cleanup(); reject(new Error(`worker exited before ${type}: ${code}`)); };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function stateFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'business-agent-persistent-runtime-'));
  return path.join(dir, 'state.json');
}

test('session, approval and cost survive a durable adapter restart', async () => {
  const filePath = await stateFile();
  let store = await createFileStateStore({ filePath });
  let sessions = createSessionStore({ stateStore: store, ttlMs: 60_000 });
  let confirmations = createConfirmationCenter({ stateStore: store, ttlMs: 60_000 });
  let costs = createCostTracker({ stateStore: store });

  await sessions.setMessages('tenant-a:s1', [{ role: 'user', content: 'hello' }]);
  const pending = await confirmations.request({ toolName: 'write_note', args: { id: '1' }, summary: 'Write note' });
  const reservation = await costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'assistant' });
  await costs.trackUsage({ agent: 'assistant', model: 'mock', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.25, reservationId: reservation.id });
  sessions.close();
  await store.close();

  store = await createFileStateStore({ filePath });
  sessions = createSessionStore({ stateStore: store, ttlMs: 60_000 });
  confirmations = createConfirmationCenter({ stateStore: store, ttlMs: 60_000 });
  costs = createCostTracker({ stateStore: store });
  assert.equal((await sessions.getOrCreate('tenant-a:s1')).messages[0].content, 'hello');
  assert.equal((await confirmations.approve(pending.id)).ok, true);
  assert.equal((await confirmations.take(pending.id)).entry.args.id, '1');
  assert.equal((await confirmations.take(pending.id)).error, 'unknown_or_expired');
  assert.equal((await costs.commit(reservation.id)).actualCostUsd, 0.25);
  assert.equal((await costs.summary()).costUsd, 0.25);
  sessions.close();
  await store.close();
});

test('two adapters sharing a durable file cannot oversubscribe one budget', async () => {
  const filePath = await stateFile();
  const storeA = await createFileStateStore({ filePath });
  const storeB = await createFileStateStore({ filePath });
  const a = createCostTracker({ stateStore: storeA });
  const b = createCostTracker({ stateStore: storeB });
  const [one, two] = await Promise.all([
    a.reserve({ amountUsd: 1, limitUsd: 1, agent: 'a' }),
    b.reserve({ amountUsd: 1, limitUsd: 1, agent: 'b' }),
  ]);
  assert.equal([one, two].filter((item) => item.ok).length, 1);
  assert.equal([one, two].filter((item) => !item.ok).length, 1);
  await storeA.close();
  await storeB.close();
});

test('two OS processes sharing a durable file cannot oversubscribe one budget', async () => {
  const filePath = await stateFile();
  const children = ['process-a', 'process-b'].map((agent) => fork(WORKER, [filePath, agent], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  }));
  try {
    await Promise.all(children.map((child) => waitFor(child, 'ready')));
    const results = children.map((child) => waitFor(child, 'result'));
    for (const child of children) child.send({ type: 'reserve' });
    const messages = await Promise.all(results);
    assert.equal(messages.filter(({ result }) => result.ok).length, 1);
    assert.equal(messages.filter(({ result }) => !result.ok).length, 1);

    const verify = await createFileStateStore({ filePath });
    assert.equal((await createCostTracker({ stateStore: verify }).getReservedCost()), 1);
    await verify.close();
  } finally {
    for (const child of children) if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  }
});

test('a reservation remains chargeable across a local calendar month boundary', async () => {
  let clock = new Date(2026, 6, 31, 23, 59).getTime();
  const store = createMemoryStateStore();
  const costs = createCostTracker({ stateStore: store, now: () => clock });
  const reservation = await costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'boundary' });
  clock = new Date(2026, 7, 1, 0, 1).getTime();
  await costs.trackUsage({ reservationId: reservation.id, agent: 'boundary', model: 'mock', usage: {}, costUsd: 0.25 });
  assert.equal((await costs.commit(reservation.id)).actualCostUsd, 0.25);
  assert.equal((await costs.summary(reservation.month)).costUsd, 0.25);
  await store.close();
});

test('unknown outcomes conservatively consume the full reservation', async () => {
  const store = createMemoryStateStore();
  const costs = createCostTracker({ stateStore: store });
  const reservation = await costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'unknown' });
  const result = await costs.settleUnknown(reservation.id);
  assert.equal(result.conservativeCostUsd, 1);
  assert.equal(result.refundedUsd, 0);
  assert.equal((await costs.getMonthlyCost()), 1);
  await store.close();
});

test('expired in-memory reservations release the lease and conservatively charge the ceiling', () => {
  let clock = new Date(2026, 0, 15).getTime();
  const costs = createCostTracker({ now: () => clock, reservationTtlMs: 10 });
  const reservation = costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'crash-fixture' });
  costs.trackUsage({
    reservationId: reservation.id,
    agent: 'crash-fixture',
    model: 'mock',
    usage: { input_tokens: 1, output_tokens: 1 },
    costUsd: 0.25,
  });
  clock += 11;
  assert.equal(costs.getReservedCost(), 0);
  assert.equal(costs.getMonthlyCost(), 1);
  assert.equal(costs.commit(reservation.id).error, 'unknown_reservation');
  assert.equal(costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'next-request' }).ok, true);
});

test('a crashed persistent reservation is reaped after restart without undercounting spend', async () => {
  let clock = new Date(2026, 0, 15).getTime();
  const store = createMemoryStateStore();
  let costs = createCostTracker({ stateStore: store, now: () => clock, reservationTtlMs: 10 });
  const reservation = await costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'crashed-provider' });
  assert.equal((await costs.markStarted(reservation.id)).ok, true);

  // Simulate a process restart by discarding the tracker while retaining the
  // durable state adapter. No commit/refund call is made.
  clock += 11;
  costs = createCostTracker({ stateStore: store, now: () => clock, reservationTtlMs: 10 });
  assert.equal(await costs.getReservedCost(reservation.month), 0);
  assert.equal(await costs.getMonthlyCost(reservation.month), 1);
  assert.equal((await costs.summary(reservation.month)).calls, 1);
  const snapshot = await store.exportSnapshot();
  assert.equal(JSON.stringify(snapshot).includes(reservation.id), false);
  assert.equal((await costs.reserve({ amountUsd: 1, limitUsd: 2, agent: 'next-request' })).ok, true);
  await store.close();
});

test('a reservation that expires before provider entry is refunded', async () => {
  let clock = new Date(2026, 0, 15).getTime();
  const store = createMemoryStateStore();
  let costs = createCostTracker({ stateStore: store, now: () => clock, reservationTtlMs: 10 });
  const reservation = await costs.reserve({ amountUsd: 1, limitUsd: 1, agent: 'preflight-only' });
  clock += 11;
  costs = createCostTracker({ stateStore: store, now: () => clock, reservationTtlMs: 10 });
  assert.equal(await costs.getReservedCost(reservation.month), 0);
  assert.equal(await costs.getMonthlyCost(reservation.month), 0);
  assert.equal((await costs.reserve({ amountUsd: 1, limitUsd: 1, agent: 'replacement' })).ok, true);
  await store.close();
});

test('legacy reservations without expiry are conservatively migrated on first read', async () => {
  const clock = new Date(2026, 0, 15).getTime();
  const store = createMemoryStateStore();
  await store.put('cost', '2026-01', {
    costUsd: 0,
    reservedUsd: 1,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    byAgent: {},
    reservations: {
      '2026-01:legacy': {
        id: '2026-01:legacy',
        monthKey: '2026-01',
        amountUsd: 1,
        agent: 'legacy-agent',
        events: [],
      },
    },
  });
  const costs = createCostTracker({ stateStore: store, now: () => clock });
  assert.equal(await costs.getReservedCost('2026-01'), 0);
  assert.equal(await costs.getMonthlyCost('2026-01'), 1);
  assert.equal(JSON.stringify(await store.exportSnapshot()).includes('2026-01:legacy'), false);
  await store.close();
});

test('cost ledgers reject negative usage, reservation overruns, and corrupt persisted totals', async () => {
  const memoryCosts = createCostTracker();
  assert.throws(
    () => memoryCosts.trackUsage({ usage: { input_tokens: -1, output_tokens: 0 }, costUsd: -5 }),
    /non-negative/,
  );
  assert.equal(memoryCosts.getMonthlyCost(), 0);
  const memoryReservation = memoryCosts.reserve({ amountUsd: 1, limitUsd: 1, agent: 'bounded' });
  assert.throws(
    () => memoryCosts.trackUsage({ reservationId: memoryReservation.id, agent: 'bounded', model: 'mock', usage: {}, costUsd: 1.01 }),
    (error) => error.code === 'COST_RESERVATION_EXCEEDED' && error.unknownOutcome === true,
  );
  assert.equal(memoryCosts.getMonthlyCost(), 0);
  assert.equal(memoryCosts.getReservedCost(), 1);

  const now = new Date(2026, 0, 15).getTime();
  const store = createMemoryStateStore();
  const persistent = createCostTracker({ stateStore: store, now: () => now });
  try {
    const reservation = await persistent.reserve({ amountUsd: 1, limitUsd: 1, agent: 'bounded' });
    await assert.rejects(
      persistent.trackUsage({ reservationId: reservation.id, agent: 'bounded', model: 'mock', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 1.01 }),
      (error) => error.code === 'COST_RESERVATION_EXCEEDED',
    );
    await store.put('cost', '2026-01', {
      costUsd: -5,
      reservedUsd: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      byAgent: {},
      reservations: {},
    });
    await assert.rejects(persistent.getMonthlyCost(), /ledger\.costUsd/);
  } finally {
    await store.close();
  }
});

test('a durable session lease serializes a full read-modify-write turn across adapters', async () => {
  const filePath = await stateFile();
  const storeA = await createFileStateStore({ filePath });
  const storeB = await createFileStateStore({ filePath });
  const a = createSessionStore({ stateStore: storeA, ttlMs: 60_000 });
  const b = createSessionStore({ stateStore: storeB, ttlMs: 60_000 });
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });

  const first = a.withSessionLock('shared', async () => {
    const session = await a.getOrCreate('shared');
    firstEntered();
    await gate;
    await a.setMessages('shared', [...session.messages, { role: 'user', content: 'A' }]);
  });
  await entered;
  let secondEntered = false;
  const second = b.withSessionLock('shared', async () => {
    secondEntered = true;
    const session = await b.getOrCreate('shared');
    await b.setMessages('shared', [...session.messages, { role: 'user', content: 'B' }]);
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondEntered, false, 'second adapter must wait for the whole first turn');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual((await a.getOrCreate('shared')).messages.map((message) => message.content), ['A', 'B']);
  a.close();
  b.close();
  await storeA.close();
  await storeB.close();
});
