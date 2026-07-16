import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BulkheadRejectedError,
  CircuitOpenError,
  DeadLetterCapacityError,
  ExecutionError,
  createBulkhead,
  createCircuitBreaker,
  createDeadLetterQueue,
  createExecutor,
  createIdempotencyStore,
  createRetryPolicy,
} from '../src/runtime/execution/index.js';
import { createMemoryStateStore } from '../src/stores/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('idempotent transient operations retry within the bounded policy', async () => {
  let calls = 0;
  const executor = createExecutor({
    retryPolicy: createRetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 }),
  });
  const result = await executor.execute({
    name: 'provider.test',
    idempotent: true,
    operation: async () => {
      calls += 1;
      if (calls < 3) throw new ExecutionError('temporary', { code: 'TEMP', retryable: true });
      return 'ok';
    },
  });
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('unsafe writes are never retried even when the failure is retryable', async () => {
  let calls = 0;
  const dlq = createDeadLetterQueue();
  const executor = createExecutor({
    deadLetters: dlq,
    retryPolicy: createRetryPolicy({ maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 }),
  });
  await assert.rejects(
    executor.execute({
      name: 'tool.write',
      idempotent: false,
      operation: async () => {
        calls += 1;
        throw new ExecutionError('temporary', { retryable: true });
      },
    }),
    /temporary/,
  );
  assert.equal(calls, 1);
  assert.equal((await dlq.list()).length, 1);
});

test('dead-letter persistence contains only bounded metadata and no synthetic private canary', async () => {
  const stateStore = createMemoryStateStore();
  const canary = 'PRIVATE-CANARY-9b1bfb98';
  const queue = createDeadLetterQueue({ stateStore });
  const error = new Error(`raw failure message ${canary}`);
  error.name = `PrivateError${canary}`;
  error.code = `PRIVATE_CODE_${canary}`;
  try {
    const entry = await queue.add({
      operation: `tool.private-operation.${canary}`,
      payloadRef: { body: `payload-${canary}` },
      context: { tenantId: `tenant-${canary}`, token: `token-${canary}` },
      error,
      attempts: 2,
    });
    assert.equal(entry.operation.class, 'tool');
    assert.match(entry.operation.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.error.code, 'OTHER');
    assert.equal(entry.error.class, 'other');
    assert.match(entry.error.codeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.error.messageDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(entry, 'payloadRef'), false);
    assert.equal(Object.hasOwn(entry, 'context'), false);
    assert.equal(Object.hasOwn(entry.error, 'message'), false);

    const snapshot = await stateStore.exportSnapshot();
    assert.equal(JSON.stringify(snapshot).includes(canary), false);
    assert.deepEqual(await queue.inspect(entry.id), entry);
    assert.deepEqual(await queue.list(), [entry], 'the no-argument list API remains backward compatible');
  } finally {
    await stateStore.close();
  }
});

test('dead-letter capacity is atomic under concurrent writers and fails closed', async () => {
  const stateStore = createMemoryStateStore();
  const queue = createDeadLetterQueue({ stateStore, maxRecords: 1 });
  try {
    const outcomes = await Promise.allSettled([
      queue.add({ operation: 'tool.first', error: new Error('first'), attempts: 1 }),
      queue.add({ operation: 'tool.second', error: new Error('second'), attempts: 1 }),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejection = outcomes.find(({ status }) => status === 'rejected');
    assert.ok(rejection.reason instanceof DeadLetterCapacityError);
    assert.equal(rejection.reason.code, 'DEAD_LETTER_CAPACITY');
    assert.equal((await queue.list()).length, 1);
  } finally {
    await stateStore.close();
  }
});

test('dead-letter pagination, inspect, explicit reconciliation, and pruning preserve terminal safety', async () => {
  let clock = 1_000;
  const stateStore = createMemoryStateStore();
  const queue = createDeadLetterQueue({ stateStore, maxRecords: 4, now: () => clock });
  try {
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await queue.add({
        operation: `workflow.step-${index}`,
        error: Object.assign(new Error(`failed ${index}`), { code: 'WORKFLOW_NODE_FAILED' }),
        attempts: index + 1,
      }));
    }

    const pagedIds = [];
    let cursor = null;
    do {
      const page = await queue.list({ cursor, limit: 1 });
      pagedIds.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(new Set(pagedIds), new Set(created.map(({ id }) => id)));
    assert.deepEqual(await queue.inspect(created[0].id), created[0]);

    await assert.rejects(
      queue.reconcile(created[0].id, { resolution: 'retry_authorized' }),
      (error) => error.code === 'DEAD_LETTER_REPLAY_ACKNOWLEDGEMENT_REQUIRED',
    );
    const reconciliationOutcomes = await Promise.allSettled([
      queue.reconcile(created[0].id, { resolution: 'resolved' }),
      queue.reconcile(created[0].id, { resolution: 'discarded' }),
    ]);
    assert.equal(reconciliationOutcomes.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(
      reconciliationOutcomes.find(({ status }) => status === 'rejected').reason.code,
      'DEAD_LETTER_STATE_CONFLICT',
    );
    const second = await queue.reconcile(created[1].id, {
      resolution: 'retry_authorized',
      acknowledgeReplayRisk: true,
    });
    assert.equal(second.status, 'reconciled');
    assert.equal(second.reconciliation.resolution, 'retry_authorized');

    clock += 365 * 24 * 60 * 60 * 1_000;
    const stillTerminal = await queue.inspect(created[1].id);
    assert.equal(stillTerminal.status, 'reconciled');
    assert.equal(stillTerminal.reconciliation.resolution, 'retry_authorized');
    await assert.rejects(
      queue.reconcile(created[1].id, { resolution: 'resolved' }),
      (error) => error.code === 'DEAD_LETTER_STATE_CONFLICT',
    );
    assert.equal((await queue.list({ limit: 4, status: 'reconciled' })).items.length, 2);

    await assert.rejects(
      queue.prune({ before: clock + 1 }),
      (error) => error.code === 'DEAD_LETTER_PRUNE_ACKNOWLEDGEMENT_REQUIRED',
    );
    const pruned = await queue.prune({
      before: clock + 1,
      limit: 4,
      acknowledgeDataLoss: true,
    });
    assert.equal(pruned.pruned, 2);
    assert.equal(pruned.retainedPending, 1);
    assert.equal(await queue.inspect(created[0].id), null);
    assert.equal(await queue.inspect(created[1].id), null);
    assert.equal((await queue.inspect(created[2].id)).status, 'pending');

    await Promise.all([0, 1, 2].map((index) => queue.add({
      operation: `provider.replacement-${index}`,
      error: new Error('replacement failed'),
      attempts: 1,
    })));
    assert.equal((await queue.list()).length, 4, 'explicit pruning releases capacity without evicting pending work');
  } finally {
    await stateStore.close();
  }
});

test('timeout aborts the operation and records an unknown outcome', async () => {
  const executor = createExecutor();
  await assert.rejects(
    executor.execute({
      name: 'slow.tool',
      timeoutMs: 10,
      operation: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }),
    (error) => error.code === 'TIMEOUT' && error.unknownOutcome === true,
  );
});

test('a timed-out operation that ignores abort retains its bulkhead slot until settlement', async () => {
  const late = deferred();
  const bulkhead = createBulkhead({ concurrency: 1, queueLimit: 0 });
  const executor = createExecutor({ bulkhead });

  await assert.rejects(
    executor.execute({
      name: 'ignores-abort',
      timeoutMs: 5,
      operation: () => late.promise,
    }),
    (error) => error.code === 'TIMEOUT' && error.unknownOutcome === true,
  );
  await assert.rejects(
    executor.execute({ name: 'different-operation', operation: async () => 'must-not-start' }),
    BulkheadRejectedError,
  );

  late.resolve('settled-after-timeout');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await executor.execute({ name: 'after-settlement', operation: async () => 'ok' })).value, 'ok');
});

test('bulkhead rejects beyond active and queue capacity', async () => {
  const gate = deferred();
  const bulkhead = createBulkhead({ concurrency: 1, queueLimit: 0 });
  const executor = createExecutor({ bulkhead });
  const first = executor.execute({ name: 'hold', operation: () => gate.promise });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    executor.execute({ name: 'hold', operation: async () => 'never' }),
    BulkheadRejectedError,
  );
  gate.resolve('done');
  assert.equal((await first).value, 'done');
});

test('circuit opens after threshold and allows one half-open probe', async () => {
  let now = 1_000;
  const circuitBreaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, now: () => now });
  const executor = createExecutor({ circuitBreaker });
  await assert.rejects(executor.execute({ name: 'fragile', operation: async () => { throw new Error('down'); } }));
  await assert.rejects(executor.execute({ name: 'fragile', operation: async () => 'no' }), CircuitOpenError);
  now += 51;
  assert.equal((await executor.execute({ name: 'fragile', operation: async () => 'recovered' })).value, 'recovered');
  assert.equal(circuitBreaker.snapshot('fragile').state, 'closed');
});

test('same idempotency key executes a committed side effect once', async () => {
  let calls = 0;
  const idempotency = createIdempotencyStore();
  const executor = createExecutor({ idempotency });
  const operation = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { receipt: 'r-1' };
  };
  const [a, b] = await Promise.all([
    executor.execute({ name: 'write.once', operation, idempotent: true, idempotencyKey: 'tenant-a:k-1' }),
    executor.execute({ name: 'write.once', operation, idempotent: true, idempotencyKey: 'tenant-a:k-1' }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a.value, { receipt: 'r-1' });
  assert.deepEqual(b.value, { receipt: 'r-1' });
  assert.equal([a.deduplicated, b.deduplicated].filter(Boolean).length, 1);
});

test('unclassified write failures become permanent unknown tombstones and never replay', async () => {
  const idempotency = createIdempotencyStore();
  const executor = createExecutor({ idempotency });
  let sideEffects = 0;
  const request = () => executor.execute({
    name: 'tool.ambiguous-write',
    operation: async () => {
      sideEffects += 1;
      throw new Error('connection ended after submit');
    },
    idempotent: true,
    idempotencyKey: 'tenant-a:ambiguous-write',
    unknownOnUnclassifiedError: true,
  });
  await assert.rejects(request(), (error) => error.unknownOutcome === true && error.reconciliationRequired === true);
  await assert.rejects(request(), (error) => error.code === 'IDEMPOTENCY_UNKNOWN');
  assert.equal(sideEffects, 1);
});

test('a full dead-letter queue cannot erase an ambiguous write tombstone', async () => {
  const idempotency = createIdempotencyStore();
  const deadLetters = createDeadLetterQueue({ maxRecords: 1 });
  await deadLetters.add({ operation: 'existing.failure', error: new Error('existing'), attempts: 1 });
  const executor = createExecutor({ idempotency, deadLetters });
  let sideEffects = 0;
  const request = () => executor.execute({
    name: 'tool.ambiguous-write-with-full-dlq',
    operation: async () => {
      sideEffects += 1;
      throw new Error('connection ended after submit');
    },
    idempotent: true,
    idempotencyKey: 'tenant-a:ambiguous-write-full-dlq',
    unknownOnUnclassifiedError: true,
  });
  await assert.rejects(
    request(),
    (error) => error.unknownOutcome === true
      && error.deadLetterRecordFailed === true
      && error.deadLetterErrorCode === 'DEAD_LETTER_CAPACITY',
  );
  await assert.rejects(request(), (error) => error.code === 'IDEMPOTENCY_UNKNOWN');
  assert.equal(sideEffects, 1);
  assert.equal((await idempotency.get('tenant-a:ambiguous-write-full-dlq')).status, 'unknown');
});

test('expired running and unknown idempotency records require reconciliation instead of replay', async () => {
  let now = 10_000;
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore, now: () => now });
  let calls = 0;
  try {
    const expiredKey = idempotency.storageKeyFor('expired-running');
    await stateStore.put('idempotency', expiredKey, {
      status: 'running',
      ownerId: 'crashed-owner',
      startedAt: 1,
      expiresAt: 9_999,
    });
    await assert.rejects(
      idempotency.run('expired-running', async () => { calls += 1; return 'unsafe'; }),
      (error) => error.code === 'IDEMPOTENCY_UNKNOWN' && error.unknownOutcome === true,
    );
    assert.equal(calls, 0);
    assert.equal((await stateStore.get('idempotency', expiredKey)).value.status, 'unknown');

    await stateStore.put('idempotency', idempotency.storageKeyFor('old-unknown'), {
      status: 'unknown',
      ownerId: 'old-owner',
      errorCode: 'TIMEOUT',
      failedAt: 1,
      expiresAt: 2,
    });
    now = 1_000_000;
    await assert.rejects(
      idempotency.run('old-unknown', async () => { calls += 1; return 'unsafe'; }),
      (error) => error.code === 'IDEMPOTENCY_UNKNOWN',
    );
    assert.equal(calls, 0);
  } finally {
    await stateStore.close();
  }
});

test('expired committed results are compacted without making the side effect replayable', async () => {
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore, now: () => 1_000_000 });
  let calls = 0;
  try {
    const key = idempotency.storageKeyFor('old-commit');
    await stateStore.put('idempotency', key, {
      status: 'committed',
      ownerId: 'old-owner',
      value: { receipt: 'existing' },
      valueExpiresAt: 2,
      resultDigest: 'a'.repeat(64),
      committedAt: 1,
    });
    await assert.rejects(
      idempotency.run('old-commit', async () => { calls += 1; return { receipt: 'duplicate' }; }),
      (error) => error.code === 'IDEMPOTENCY_COMMITTED' && error.unknownOutcome === true,
    );
    assert.equal(calls, 0);
    const stored = (await stateStore.get('idempotency', key)).value;
    assert.equal(stored.status, 'committed');
    assert.equal(Object.hasOwn(stored, 'value'), false);
    assert.equal(JSON.stringify(await stateStore.exportSnapshot()).includes('existing'), false);
  } finally {
    await stateStore.close();
  }
});

test('persistent idempotency defaults to a result digest instead of customer output', async () => {
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore });
  try {
    const secretResult = { receipt: 'CONFIDENTIAL-CUSTOMER-DATA' };
    assert.deepEqual((await idempotency.run('privacy-default', async () => secretResult)).value, secretResult);
    const snapshot = await stateStore.exportSnapshot();
    assert.equal(JSON.stringify(snapshot).includes('CONFIDENTIAL-CUSTOMER-DATA'), false);
    const record = await idempotency.get('privacy-default');
    assert.equal(record.status, 'committed');
    assert.match(record.resultDigest, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(record, 'value'), false);
    await assert.rejects(
      idempotency.run('privacy-default', async () => 'unsafe duplicate'),
      (error) => error.code === 'IDEMPOTENCY_COMMITTED',
    );
  } finally {
    await stateStore.close();
  }
});

test('opted-in crash evidence is short-lived and can be explicitly compacted', async () => {
  let now = 1_000;
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore, now: () => now, resultRetentionMs: 50 });
  try {
    await idempotency.run('workflow-evidence', async () => ({ state: 'sensitive' }), { persistResult: true });
    assert.deepEqual((await idempotency.get('workflow-evidence')).value, { state: 'sensitive' });
    const listing = await idempotency.list();
    assert.equal(listing.items.some((item) => Object.hasOwn(item, 'value') || Object.hasOwn(item, 'ownerId')), false);
    assert.equal(JSON.stringify(listing).includes('sensitive'), false);
    assert.equal(await idempotency.compact('workflow-evidence'), true);
    assert.equal(Object.hasOwn(await idempotency.get('workflow-evidence'), 'value'), false);

    await idempotency.run('expires', async () => ({ state: 'short-lived' }), { persistResult: true });
    now += 51;
    assert.equal(Object.hasOwn(await idempotency.get('expires'), 'value'), false);
    assert.equal(JSON.stringify(await stateStore.exportSnapshot()).includes('short-lived'), false);
  } finally {
    await stateStore.close();
  }
});

test('management sweeps remove expired one-shot response bodies without exact-key access', async () => {
  let now = 5_000;
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore, now: () => now, resultRetentionMs: 50 });
  try {
    const canary = 'SYNTHETIC-BUSINESS-REPLY-ONE-SHOT';
    await idempotency.run('never-read-again', async () => ({ reply: canary }), { persistResult: true });
    assert.match(JSON.stringify(await stateStore.exportSnapshot()), new RegExp(canary));
    now += 999_000;

    const listing = await idempotency.list();
    assert.equal(listing.items[0].status, 'committed');
    assert.equal((await idempotency.capacity()).used, 1);
    const snapshot = JSON.stringify(await stateStore.exportSnapshot());
    assert.doesNotMatch(snapshot, new RegExp(canary));
    assert.doesNotMatch(snapshot, /valueExpiresAt/);
    assert.match(snapshot, /resultDigest/);
  } finally {
    await stateStore.close();
  }
});

test('idempotency capacity fails closed until an operator reconciles a tombstone', async () => {
  const stateStore = createMemoryStateStore();
  const idempotency = createIdempotencyStore({ stateStore, maxRecords: 2 });
  try {
    await idempotency.run('one', async () => 'one');
    await idempotency.run('two', async () => 'two');
    let calls = 0;
    await assert.rejects(
      idempotency.run('three', async () => { calls += 1; return 'three'; }),
      (error) => error.code === 'IDEMPOTENCY_CAPACITY' && error.statusCode === 503,
    );
    assert.equal(calls, 0);
    assert.equal((await idempotency.list()).items.length, 2);
    const oneId = (await idempotency.list()).items.find((item) => item.resultDigest)?.id;
    assert.match(oneId, /^[0-9a-f]{64}$/);
    assert.equal(await idempotency.reconcileById(oneId, { resolution: 'forget' }), true);
    assert.equal((await idempotency.run('three', async () => { calls += 1; return 'three'; })).value, 'three');
    assert.equal(calls, 1);
  } finally {
    await stateStore.close();
  }
});
