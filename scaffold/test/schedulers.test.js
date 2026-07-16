import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditLog } from '../src/observability/index.js';
import { createDurableScheduler, createLocalScheduler } from '../src/schedulers/index.js';
import { createMemoryStateStore } from '../src/stores/index.js';

async function waitFor(predicate, { timeoutMs = 2_000, message = 'condition was not reached' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

test('local adapter preserves existing hour-without-minute and runNow semantics', async () => {
  let calls = 0;
  const scheduler = createLocalScheduler();
  scheduler.registerJob({ name: 'daily', schedule: { hour: 8 }, run: async () => { calls += 1; return 'ok'; } });
  await scheduler.tick(new Date(2026, 0, 1, 8, 1));
  assert.equal(calls, 0);
  assert.equal((await scheduler.runNow('daily')).ok, true);
  assert.equal(calls, 1);
  assert.equal(scheduler.capabilities.durable, false);
});

test('durable adapter coalesces missed runs and persists completion across restart', async () => {
  let clock = Date.parse('2026-01-01T08:00:00Z');
  const store = createMemoryStateStore();
  let calls = 0;
  const first = createDurableScheduler({ stateStore: store, instanceId: 'one', now: () => clock });
  first.registerJob({ name: 'each-minute', schedule: {}, missedRunPolicy: 'coalesce', run: async () => { calls += 1; return `run-${calls}`; } });
  await first.tick(new Date(clock));
  assert.equal(calls, 1);
  clock += 3 * 60_000;
  const restarted = createDurableScheduler({ stateStore: store, instanceId: 'two', now: () => clock });
  restarted.registerJob({ name: 'each-minute', schedule: {}, missedRunPolicy: 'coalesce', run: async () => { calls += 1; return `run-${calls}`; } });
  await restarted.tick(new Date(clock));
  assert.equal(calls, 2, 'three missed minutes are coalesced into one run');
  const jobs = await store.list('job', { prefix: 'execution:each-minute:' });
  assert.equal(jobs.items.filter((item) => item.value.status === 'succeeded').length, 2);
});

test('two scheduler instances cannot own the same scheduled run concurrently', async () => {
  const clock = Date.parse('2026-01-01T08:00:00Z');
  const store = createMemoryStateStore();
  const audit = createAuditLog({ stateStore: store });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const definition = { name: 'singleton', schedule: {}, run: async () => { calls += 1; await gate; return 'done'; } };
  const a = createDurableScheduler({ stateStore: store, instanceId: 'a', now: () => clock, audit });
  const b = createDurableScheduler({ stateStore: store, instanceId: 'b', now: () => clock, audit });
  a.registerJob(definition);
  b.registerJob(definition);
  const first = a.tick(new Date(clock));
  await new Promise((resolve) => setImmediate(resolve));
  const second = b.tick(new Date(clock));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  const auditEntries = await audit.list();
  assert.deepEqual(auditEntries.map((entry) => entry.outcome), ['started', 'ok']);
});

test('lease heartbeat prevents short-lease takeover by a second instance', async () => {
  const scheduledMs = Math.floor(Date.now() / 60_000) * 60_000;
  const scheduledDate = new Date(scheduledMs);
  const store = createMemoryStateStore();
  let calls = 0;
  let release;
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const runGate = new Promise((resolve) => { release = resolve; });
  const definition = {
    name: 'heartbeat-singleton',
    schedule: {},
    run: async () => {
      calls += 1;
      entered();
      await runGate;
      return 'done';
    },
  };
  const a = createDurableScheduler({ stateStore: store, instanceId: 'heartbeat-a', leaseMs: 30, leaseHeartbeatMs: 5 });
  const b = createDurableScheduler({ stateStore: store, instanceId: 'heartbeat-b', leaseMs: 30, leaseHeartbeatMs: 5 });
  a.registerJob(definition);
  b.registerJob(definition);

  const first = a.tick(scheduledDate);
  await enteredGate;
  const initial = await waitFor(async () => (await store.list('job', { prefix: 'execution:heartbeat-singleton:' })).items[0]);
  const observedExpiry = initial.value.leaseExpiresAt;
  await waitFor(() => Date.now() > observedExpiry + 2, { message: 'original short lease did not elapse' });
  const renewed = await waitFor(async () => {
    const item = (await store.list('job', { prefix: 'execution:heartbeat-singleton:' })).items[0];
    return item?.value?.leaseExpiresAt > Date.now() ? item : null;
  }, { message: 'lease heartbeat did not renew ownership' });
  assert.equal(renewed.value.owner, 'heartbeat-a');

  const second = b.tick(scheduledDate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'second instance must not take over a live renewed lease');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('expired short lease requires reconciliation and never replays a possible external effect', async () => {
  let clock = Date.parse('2026-01-01T08:00:00Z');
  const scheduledDate = new Date(clock);
  const store = createMemoryStateStore();
  let calls = 0;
  let releaseFirst;
  let firstEntered;
  const firstEnteredGate = new Promise((resolve) => { firstEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const definition = {
    name: 'takeover-job',
    schedule: {},
    run: async ({ fencingToken }) => {
      calls += 1;
      if (fencingToken === 1) {
        firstEntered();
        await firstGate;
        return 'stale-result';
      }
      return 'must-not-replay';
    },
  };
  const a = createDurableScheduler({
    stateStore: store,
    instanceId: 'takeover-a',
    now: () => clock,
    leaseMs: 100,
    leaseHeartbeatMs: 90,
  });
  const b = createDurableScheduler({
    stateStore: store,
    instanceId: 'takeover-b',
    now: () => clock,
    leaseMs: 100,
    leaseHeartbeatMs: 90,
  });
  a.registerJob(definition);
  b.registerJob(definition);

  const staleTick = a.tick(scheduledDate);
  await firstEnteredGate;
  clock += 101;
  await b.tick(scheduledDate);
  assert.equal(calls, 1, 'lease expiry is not evidence that the prior external effect was rejected');
  releaseFirst();
  await staleTick;

  const [record] = (await store.list('job', { prefix: 'execution:takeover-job:' })).items;
  assert.equal(record.value.owner, 'takeover-a');
  assert.equal(record.value.fencingToken, 1);
  assert.equal(record.value.status, 'reconciliation_required');
  assert.equal(record.value.error.code, 'SCHEDULER_LEASE_EXPIRED');
  assert.equal(record.value.unknownOutcome, true);
  assert.equal(Object.hasOwn(record.value, 'result'), false);
  assert.equal(a.listJobs()[0].lastError, 'fenced_out');
  assert.equal(a.listJobs()[0].lastResult, null);
});

test('expired running evidence is a durable no-replay tombstone even for an idempotent job', async () => {
  const clock = Date.parse('2026-01-01T08:30:00Z');
  const store = createMemoryStateStore();
  const runId = 'manual:crash-after-effect';
  await store.put('job', `execution:external-write:${runId}`, {
    name: 'external-write',
    scheduledAt: new Date(clock - 1_000).toISOString(),
    trigger: 'manual',
    runId,
    status: 'running',
    owner: 'crashed-worker',
    fencingToken: 1,
    leaseExpiresAt: clock - 1,
    attempts: 1,
  });
  let externalEffects = 1;
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock });
  scheduler.registerJob({
    name: 'external-write',
    schedule: {},
    idempotency: 'required',
    run: async () => { externalEffects += 1; },
  });

  const result = await scheduler.runNow('external-write', { runId });
  assert.equal(result.skipped, 'reconciliation_required');
  assert.equal(result.unknownOutcome, true);
  assert.equal(externalEffects, 1);
  assert.equal((await store.get('job', `execution:external-write:${runId}`)).value.status, 'reconciliation_required');
});

test('lost fencing token returns fenced_out with unknown outcome and never records success', async () => {
  const clock = Date.parse('2026-01-01T08:00:00Z');
  const store = createMemoryStateStore();
  let release;
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const runGate = new Promise((resolve) => { release = resolve; });
  const scheduler = createDurableScheduler({
    stateStore: store,
    instanceId: 'fenced-owner',
    now: () => clock,
    leaseMs: 1_000,
    leaseHeartbeatMs: 100,
  });
  scheduler.registerJob({
    name: 'fenced-job',
    schedule: {},
    run: async () => {
      entered();
      await runGate;
      return 'side-effect-completed';
    },
  });

  const pending = scheduler.runNow('fenced-job');
  await enteredGate;
  const [claimed] = (await store.list('job', { prefix: 'execution:fenced-job:' })).items;
  await store.transaction(async (tx) => {
    const current = tx.get('job', claimed.key);
    tx.put('job', claimed.key, {
      ...current.value,
      owner: 'takeover-owner',
      fencingToken: current.value.fencingToken + 1,
      leaseExpiresAt: clock + 2_000,
    }, { ifRevision: current.revision });
  });
  release();
  const result = await pending;
  assert.deepEqual(result, {
    ok: false,
    skipped: 'fenced_out',
    unknownOutcome: true,
    error: 'scheduler lease ownership was lost before finalization',
  });
  const record = await store.get('job', claimed.key);
  assert.equal(record.value.owner, 'takeover-owner');
  assert.equal(record.value.status, 'running');
  assert.equal(scheduler.listJobs()[0].lastResult, null);
  assert.equal(scheduler.listJobs()[0].lastError, 'fenced_out');
});

test('same-instance ticks serialize instead of overlapping different scheduled minutes', async () => {
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, instanceId: 'serial' });
  let calls = 0;
  let release;
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const firstGate = new Promise((resolve) => { release = resolve; });
  scheduler.registerJob({
    name: 'serial-job',
    schedule: {},
    missedRunPolicy: 'coalesce',
    run: async () => {
      calls += 1;
      if (calls === 1) {
        entered();
        await firstGate;
      }
      return calls;
    },
  });

  const first = scheduler.tick(new Date('2026-01-01T08:00:00Z'));
  await enteredGate;
  const second = scheduler.tick(new Date('2026-01-01T08:01:00Z'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'second tick must wait behind the first tick');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('async stop waits for accepted work and rejects new durable work', async () => {
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, instanceId: 'stopping' });
  let calls = 0;
  let release;
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const runGate = new Promise((resolve) => { release = resolve; });
  scheduler.registerJob({
    name: 'stop-job',
    schedule: {},
    run: async () => {
      calls += 1;
      entered();
      await runGate;
      return 'done';
    },
  });

  const running = scheduler.runNow('stop-job');
  await enteredGate;
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  assert.equal(typeof stop.then, 'function');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'stop must wait for already accepted work');
  release();
  assert.equal((await running).ok, true);
  await stop;
  assert.equal(stopped, true);
  assert.deepEqual(await scheduler.runNow('stop-job'), { ok: false, skipped: 'scheduler-stopped' });
  assert.equal(calls, 1);
});

test('job timeout aborts its signal, records reconciliation and lets stop settle', async () => {
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, instanceId: 'bounded-stop' });
  let observedSignal;
  scheduler.registerJob({
    name: 'hung-job',
    schedule: {},
    timeoutMs: 20,
    run: async ({ signal }) => {
      observedSignal = signal;
      await new Promise(() => {});
    },
  });

  const running = scheduler.runNow('hung-job', { runId: 'manual:hung' });
  const stopping = scheduler.stop();
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('run did not respect timeout')), 500)),
  ]);
  await Promise.race([
    stopping,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop remained blocked')), 500)),
  ]);
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.skipped, 'reconciliation_required');
  assert.equal(result.unknownOutcome, true);
  const record = await store.get('job', 'execution:hung-job:manual:hung');
  assert.equal(record.value.status, 'reconciliation_required');
  assert.equal(record.value.error.code, 'SCHEDULER_JOB_TIMEOUT');
});

test('a timed-out job cannot serially block later scheduled jobs', async () => {
  const clock = Date.parse('2026-01-01T08:45:00Z');
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock, logger: { error() {} } });
  let laterCalls = 0;
  scheduler.registerJob({ name: 'hung-first', schedule: {}, timeoutMs: 15, run: async () => new Promise(() => {}) });
  scheduler.registerJob({ name: 'runs-second', schedule: {}, run: async () => { laterCalls += 1; return 'ok'; } });

  await Promise.race([
    scheduler.tick(new Date(clock)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('tick remained blocked')), 500)),
  ]);
  assert.equal(laterCalls, 1);
  const [timedOut] = (await store.list('job', { prefix: 'execution:hung-first:' })).items;
  assert.equal(timedOut.value.status, 'reconciliation_required');
});

test('durable job timeout must stay within the production safety bound', () => {
  const scheduler = createDurableScheduler({ stateStore: createMemoryStateStore() });
  assert.throws(
    () => scheduler.registerJob({ name: 'unbounded', schedule: {}, timeoutMs: 300_001, run: async () => {} }),
    /timeoutMs.*between 1 and 300000/i,
  );
});

test('durable adapter applies the monthly cost budget guard before claiming', async () => {
  const store = createMemoryStateStore();
  const audit = createAuditLog({ stateStore: store });
  let calls = 0;
  let budgetChecks = 0;
  const scheduler = createDurableScheduler({
    stateStore: store,
    costTracker: {
      async isOverBudget(limit) {
        budgetChecks += 1;
        assert.equal(limit, 25);
        return true;
      },
    },
    monthlyBudgetUsd: 25,
    audit,
    logger: { warn() {} },
  });
  scheduler.registerJob({ name: 'budgeted', schedule: {}, run: async () => { calls += 1; } });
  const result = await scheduler.runNow('budgeted');
  assert.deepEqual(result, { ok: false, skipped: 'monthly-budget-exhausted' });
  assert.equal(budgetChecks, 1);
  assert.equal(calls, 0);
  assert.equal((await audit.list()).length, 0, 'budget-denied jobs must not consume audit capacity');
  assert.equal((await store.list('job', { prefix: 'execution:budgeted:' })).items.length, 0);
});

test('a full audit ledger blocks scheduled and manual jobs before claim or handler effect', async () => {
  const store = createMemoryStateStore();
  const audit = createAuditLog({ stateStore: store, maxRecords: 1 });
  await audit.append({ action: 'seed', outcome: 'ok' });
  let effects = 0;
  const scheduler = createDurableScheduler({ stateStore: store, audit });
  scheduler.registerJob({ name: 'audited-job', schedule: {}, run: async () => { effects += 1; return 'must-not-run'; } });
  await assert.rejects(
    scheduler.tick(new Date('2026-07-16T08:00:00.000Z')),
    (error) => error.code === 'AUDIT_CAPACITY_EXHAUSTED',
  );
  await assert.rejects(
    scheduler.runNow('audited-job'),
    (error) => error.code === 'AUDIT_CAPACITY_EXHAUSTED',
  );
  assert.equal(effects, 0);
  assert.equal((await store.list('job', { prefix: 'execution:audited-job:' })).items.length, 0, 'pre-effect claims must be released after audit failure');
});

test('terminal scheduler failures retry within bounds and enter dead letter', async () => {
  const clock = Date.parse('2026-01-01T08:00:00Z');
  const store = createMemoryStateStore();
  let calls = 0;
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock, logger: { error() {} } });
  scheduler.registerJob({
    name: 'broken',
    schedule: {},
    maxAttempts: 2,
    idempotency: 'required',
    run: async () => {
      calls += 1;
      throw Object.assign(new Error('broken'), { retryable: true, unknownOutcome: false });
    },
  });
  const result = await scheduler.runNow('broken');
  assert.equal(result.deadLettered, true);
  assert.equal(calls, 2);
  assert.equal((await store.list('dead-letter')).items.length, 1);
});

test('durable scheduler never retries ambiguous or unclassified side-effect failures', async () => {
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, logger: { error() {} } });
  assert.throws(
    () => scheduler.registerJob({ name: 'unsafe-retry', schedule: {}, maxAttempts: 2, run: async () => {} }),
    /retries require idempotency/i,
  );

  let calls = 0;
  scheduler.registerJob({
    name: 'ambiguous',
    schedule: {},
    maxAttempts: 3,
    idempotency: 'required',
    run: async () => {
      calls += 1;
      throw new Error('side effect may already have committed');
    },
  });
  const result = await scheduler.runNow('ambiguous');
  assert.equal(result.skipped, 'reconciliation_required');
  assert.equal(result.unknownOutcome, true);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(calls, 1, 'generic errors are not explicit evidence that replay is safe');

  const replay = await scheduler.runNow('ambiguous', { runId: 'manual:http:stable-ambiguous' });
  assert.equal(replay.skipped, 'reconciliation_required');
  const duplicate = await scheduler.runNow('ambiguous', { runId: 'manual:http:stable-ambiguous' });
  assert.equal(duplicate.skipped, 'reconciliation_required');
  assert.equal(calls, 2, 'a stable manual run id executes once and then remains a reconciliation tombstone');
});

test('unknown outcomes are terminal reconciliation records and never replay after restart', async () => {
  const clock = Date.parse('2026-01-01T08:00:00Z');
  const baseStore = createMemoryStateStore();
  let failCursorOnce = true;
  const store = {
    ...baseStore,
    async transaction(callback) {
      return baseStore.transaction((tx) => callback({
        ...tx,
        put(namespace, key, value, options) {
          if (failCursorOnce && namespace === 'job' && key === '__scheduler__') {
            failCursorOnce = false;
            throw Object.assign(new Error('simulated cursor persistence outage'), { code: 'CURSOR_WRITE_FAILED' });
          }
          return tx.put(namespace, key, value, options);
        },
      }));
    },
  };
  let calls = 0;
  const definition = {
    name: 'ambiguous-write',
    schedule: {},
    maxAttempts: 3,
    idempotency: 'required',
    run: async () => {
      calls += 1;
      throw Object.assign(new Error('customer-token-must-not-persist'), {
        code: 'UPSTREAM_TIMEOUT',
        retryable: true,
        unknownOutcome: true,
      });
    },
  };
  const first = createDurableScheduler({ stateStore: store, instanceId: 'unknown-one', now: () => clock, logger: { error() {} } });
  first.registerJob(definition);
  await assert.rejects(first.tick(new Date(clock)), (error) => error.code === 'CURSOR_WRITE_FAILED');

  const [unknown] = (await baseStore.list('job', { prefix: 'execution:ambiguous-write:' })).items;
  assert.equal(unknown.value.status, 'reconciliation_required');
  assert.equal(unknown.value.reconciliationRequired, true);
  assert.equal(unknown.value.unknownOutcome, true);
  assert.equal(unknown.value.leaseExpiresAt, 0);
  assert.equal(JSON.stringify(unknown.value).includes('customer-token'), false, 'error details must be minimal evidence only');

  const restarted = createDurableScheduler({ stateStore: store, instanceId: 'unknown-two', now: () => clock, logger: { error() {} } });
  restarted.registerJob(definition);
  await restarted.tick(new Date(clock));
  assert.equal(calls, 1, 'an unknown terminal outcome must remain fail-closed after restart');
  assert.equal((await baseStore.get('job', unknown.key)).value.status, 'reconciliation_required');
});

test('a terminal success survives scheduler cursor failure without invoking the job twice', async () => {
  const clock = Date.parse('2026-01-01T09:00:00Z');
  const baseStore = createMemoryStateStore();
  let failCursorOnce = true;
  const store = {
    ...baseStore,
    async transaction(callback) {
      return baseStore.transaction((tx) => callback({
        ...tx,
        put(namespace, key, value, options) {
          if (failCursorOnce && namespace === 'job' && key === '__scheduler__') {
            failCursorOnce = false;
            throw new Error('cursor unavailable');
          }
          return tx.put(namespace, key, value, options);
        },
      }));
    },
  };
  let calls = 0;
  const definition = { name: 'cursor-safe', schedule: {}, run: async () => { calls += 1; return { private: 'not-in-ledger' }; } };
  const first = createDurableScheduler({ stateStore: store, instanceId: 'cursor-one', now: () => clock });
  first.registerJob(definition);
  await assert.rejects(first.tick(new Date(clock)), /cursor unavailable/);
  const [completed] = (await baseStore.list('job', { prefix: 'execution:cursor-safe:' })).items;
  assert.equal(completed.value.status, 'succeeded');

  const restarted = createDurableScheduler({ stateStore: store, instanceId: 'cursor-two', now: () => clock });
  restarted.registerJob(definition);
  await restarted.tick(new Date(clock));
  assert.equal(calls, 1);
  assert.equal((await baseStore.get('job', '__scheduler__')).value.lastTickMs, clock);
});

test('maxAttempts exhaustion writes a terminal job record before dead-lettering', async () => {
  const clock = Date.parse('2026-01-01T10:00:00Z');
  const store = createMemoryStateStore();
  let calls = 0;
  const definition = {
    name: 'bounded-failure',
    schedule: {},
    maxAttempts: 2,
    idempotency: 'required',
    run: async () => {
      calls += 1;
      throw Object.assign(new Error('known failure'), { code: 'KNOWN_FAILURE', retryable: true, unknownOutcome: false });
    },
  };
  const first = createDurableScheduler({ stateStore: store, now: () => clock, logger: { error() {} } });
  first.registerJob(definition);
  await first.tick(new Date(clock));
  const [terminal] = (await store.list('job', { prefix: 'execution:bounded-failure:' })).items;
  assert.equal(terminal.value.status, 'dead_lettered');
  assert.equal(terminal.value.attempts, 2);
  assert.equal(terminal.value.leaseExpiresAt, 0);
  assert.equal((await store.list('job', { prefix: 'execution:' })).items.some((item) => item.value.status === 'running'), false);

  await store.delete('job', '__scheduler__');
  const restarted = createDurableScheduler({ stateStore: store, now: () => clock, logger: { error() {} } });
  restarted.registerJob(definition);
  await restarted.tick(new Date(clock));
  assert.equal(calls, 2, 'a max-attempts terminal record must not be claimed again');
});

test('durable execution evidence redacts results by default and optionally compacts short-lived results', async () => {
  let clock = Date.parse('2026-01-01T11:00:00Z');
  const secret = 'customer@example.test bearer-private-value';

  const privateStore = createMemoryStateStore();
  const privateScheduler = createDurableScheduler({ stateStore: privateStore, now: () => clock });
  privateScheduler.registerJob({ name: 'private-result', schedule: {}, run: async () => ({ secret, nested: { account: 'acct-private' } }) });
  const response = await privateScheduler.runNow('private-result');
  assert.equal(response.result.secret, secret, 'the direct authorized caller still receives the job response');
  const [privateRecord] = (await privateStore.list('job', { prefix: 'execution:private-result:' })).items;
  assert.deepEqual(privateRecord.value.resultSummary, { type: 'object' });
  assert.equal(Object.hasOwn(privateRecord.value, 'result'), false);
  assert.equal(JSON.stringify(privateRecord.value).includes('customer@example.test'), false);
  assert.equal(JSON.stringify(privateScheduler.listJobs()).includes('customer@example.test'), false);

  const retainedStore = createMemoryStateStore();
  const retainedScheduler = createDurableScheduler({
    stateStore: retainedStore,
    now: () => clock,
    resultRetentionMs: 10,
    maxRetainedResultBytes: 1_024,
  });
  retainedScheduler.registerJob({ name: 'temporary-result', schedule: {}, run: async () => ({ secret }) });
  await retainedScheduler.runNow('temporary-result');
  assert.equal((await retainedScheduler.listExecutions({ jobName: 'temporary-result' })).items[0].value.result, undefined);
  assert.equal((await retainedScheduler.listExecutions({ jobName: 'temporary-result', includeResult: true })).items[0].value.result.secret, secret);
  clock += 11;
  assert.deepEqual(await retainedScheduler.compactExecutions(), { compacted: 1 });
  const [compacted] = (await retainedStore.list('job', { prefix: 'execution:temporary-result:' })).items;
  assert.equal(Object.hasOwn(compacted.value, 'result'), false);
  assert.equal(Object.hasOwn(compacted.value, 'resultExpiresAt'), false);

  const restarted = createDurableScheduler({ stateStore: retainedStore, now: () => clock, resultRetentionMs: 10 });
  assert.equal((await restarted.listExecutions({ includeResult: true })).items[0].value.result, undefined);
});

test('execution ledger capacity persists across restart and explicit prune frees only terminal records', async () => {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const store = createMemoryStateStore();
  let calls = 0;
  const definition = { name: 'capacity-job', schedule: {}, run: async () => { calls += 1; return calls; } };
  const first = createDurableScheduler({ stateStore: store, now: () => clock, maxExecutionRecords: 2 });
  first.registerJob(definition);
  assert.equal((await first.runNow('capacity-job')).ok, true);
  assert.equal((await first.runNow('capacity-job')).ok, true);
  assert.deepEqual(await first.runNow('capacity-job'), {
    ok: false,
    skipped: 'execution-ledger-capacity',
    reconciliationRequired: true,
  });
  assert.equal(calls, 2);

  const restarted = createDurableScheduler({ stateStore: store, now: () => clock, maxExecutionRecords: 2 });
  restarted.registerJob(definition);
  assert.equal((await restarted.runNow('capacity-job')).skipped, 'execution-ledger-capacity');
  assert.equal(calls, 2, 'capacity is durable and must fail closed after restart');
  await assert.rejects(restarted.pruneExecutions({ before: clock + 1 }), /acknowledgeReplayRisk/);
  assert.deepEqual(await restarted.pruneExecutions({ before: clock + 1, limit: 1, acknowledgeReplayRisk: true }), {
    pruned: 1,
    skippedRunning: 0,
    skippedReconciliation: 0,
  });
  assert.equal((await restarted.runNow('capacity-job')).ok, true);
  assert.equal(calls, 3);
});

test('programmatic prune never deletes running/unknown records and reconciliation stores digest-only evidence', async () => {
  const clock = Date.parse('2026-01-01T13:00:00Z');
  const store = createMemoryStateStore();
  let release;
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const runGate = new Promise((resolve) => { release = resolve; });
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock, logger: { error() {} } });
  scheduler.registerJob({
    name: 'running-job',
    schedule: {},
    run: async () => { entered(); await runGate; return 'done'; },
  });
  scheduler.registerJob({
    name: 'unknown-job',
    schedule: {},
    run: async () => { throw Object.assign(new Error('sensitive external detail'), { code: 'UNKNOWN_WRITE', unknownOutcome: true }); },
  });

  const pending = scheduler.runNow('running-job');
  await enteredGate;
  const [runningRecord] = (await store.list('job', { prefix: 'execution:running-job:' })).items;
  assert.deepEqual(await scheduler.reconcileExecution({
    jobName: 'running-job',
    runId: runningRecord.value.runId,
    resolution: 'succeeded',
    evidenceDigest: 'b'.repeat(64),
  }), { reconciled: false, reason: 'still_running', status: 'running' });
  const unknown = await scheduler.runNow('unknown-job');
  assert.equal(unknown.skipped, 'reconciliation_required');
  const prune = await scheduler.pruneExecutions({ before: clock + 1, acknowledgeReplayRisk: true });
  assert.equal(prune.pruned, 0);
  assert.equal(prune.skippedRunning, 1);
  assert.equal(prune.skippedReconciliation, 1);

  const evidenceDigest = 'a'.repeat(64);
  assert.deepEqual(await scheduler.reconcileExecution({
    jobName: 'unknown-job',
    runId: unknown.runId,
    resolution: 'succeeded',
    evidenceDigest,
  }), { reconciled: true, status: 'reconciled_succeeded' });
  const reconciled = await store.get('job', `execution:unknown-job:${unknown.runId}`);
  assert.equal(reconciled.value.reconciliationEvidenceDigest, evidenceDigest);
  assert.equal(JSON.stringify(reconciled.value).includes('sensitive external detail'), false);
  release();
  await pending;
});

test('expired running evidence can be reconciled but is never deleted as running', async () => {
  const clock = Date.parse('2026-01-01T14:00:00Z');
  const store = createMemoryStateStore();
  const runId = 'manual:orphaned-worker';
  await store.put('job', `execution:orphan:${runId}`, {
    name: 'orphan',
    scheduledAt: new Date(clock - 1_000).toISOString(),
    trigger: 'manual',
    runId,
    status: 'running',
    owner: 'crashed-instance',
    fencingToken: 1,
    leaseExpiresAt: clock - 1,
    attempts: 1,
  });
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock });
  assert.deepEqual(await scheduler.pruneExecutions({ before: clock + 1, acknowledgeReplayRisk: true }), {
    pruned: 0,
    skippedRunning: 1,
    skippedReconciliation: 0,
  });
  assert.deepEqual(await scheduler.reconcileExecution({
    jobName: 'orphan',
    runId,
    resolution: 'failed',
    evidenceDigest: 'c'.repeat(64),
  }), { reconciled: true, status: 'reconciled_failed' });
  assert.equal((await store.get('job', `execution:orphan:${runId}`)).value.status, 'reconciled_failed');
  assert.deepEqual(await scheduler.pruneExecutions({ before: clock + 1, acknowledgeReplayRisk: true }), {
    pruned: 1,
    skippedRunning: 0,
    skippedReconciliation: 0,
  });
});

test('scheduled capacity exhaustion fails the tick without advancing its cursor', async () => {
  const clock = Date.parse('2026-01-01T15:00:00Z');
  const store = createMemoryStateStore();
  const scheduler = createDurableScheduler({ stateStore: store, now: () => clock, maxExecutionRecords: 1 });
  scheduler.registerJob({ name: 'capacity-schedule', schedule: {}, run: async () => 'ok' });
  assert.equal((await scheduler.runNow('capacity-schedule')).ok, true);
  await assert.rejects(
    scheduler.tick(new Date(clock)),
    (error) => error.code === 'SCHEDULER_EXECUTION_CAPACITY' && error.retryable === false,
  );
  assert.equal(await store.get('job', '__scheduler__'), null);
  assert.equal((await store.list('job', { prefix: 'execution:' })).items.length, 1);
});
