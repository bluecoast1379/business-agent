import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfirmationCenter, wrapWriteTool } from '../src/guardrails/confirm-gate.js';
import { defineTool } from '../src/runtime/tool.js';
import { createMemoryStateStore } from '../src/stores/index.js';

test('persistent prune crosses every page and removes expired raw-argument canaries', async () => {
  const clock = Date.parse('2026-01-01T00:00:00Z');
  const store = createMemoryStateStore();
  const total = 1_105;
  await store.transaction(async (tx) => {
    for (let index = 0; index < total; index += 1) {
      const id = `expired-${String(index).padStart(4, '0')}`;
      tx.put('confirmation', id, {
        id,
        toolName: 'synthetic_write',
        args: { secret: `synthetic-canary-${index}` },
        summary: 'Synthetic expired confirmation',
        tenantId: null,
        requestedBy: null,
        approved: false,
        createdAt: clock - 2_000,
        expiresAt: clock - 1,
      });
    }
  });
  const center = createConfirmationCenter({ stateStore: store, now: () => clock, maxRecords: 2_000 });

  let cursor = null;
  let removed = 0;
  let pages = 0;
  do {
    const page = await center.prune({ cursor, limit: 137 });
    assert.ok(page.scanned <= 137, 'each prune call must stay within its caller-provided bound');
    removed += page.removed;
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.ok(pages > 8, 'the test must cross the old 1,000-record boundary');
  assert.equal(removed, total);
  assert.equal((await store.list('confirmation', { limit: 1_000 })).items.length, 0);
  assert.equal(JSON.stringify(await store.exportSnapshot()).includes('synthetic-canary-1104'), false);
});

test('capacity is atomic, durable metadata-only, and never evicts live pending or approved work', async () => {
  let clock = Date.parse('2026-01-01T01:00:00Z');
  const store = createMemoryStateStore();
  const center = createConfirmationCenter({
    stateStore: store,
    now: () => clock,
    ttlMs: 1_000,
    terminalRetentionMs: 100,
    maxRecords: 2,
  });
  const [one, two] = await Promise.all([
    center.request({ toolName: 'write_one', args: { private: 'canary-one' }, summary: 'Write one' }),
    center.request({ toolName: 'write_two', args: { private: 'canary-two' }, summary: 'Write two' }),
  ]);
  assert.equal((await center.approve(one.id)).ok, true);

  await assert.rejects(
    center.request({ toolName: 'write_three', args: {}, summary: 'Write three' }),
    (error) => error.code === 'CONFIRMATION_CAPACITY' && error.statusCode === 503 && error.retryable === false,
  );
  const capacity = await center.capacity();
  assert.deepEqual(capacity, {
    total: 2,
    maxRecords: 2,
    available: 0,
    statuses: { approved: 1, pending: 1 },
  });
  assert.equal((await store.get('confirmation', one.id)).value.status, 'approved');
  assert.equal((await store.get('confirmation', two.id)).value.status, 'pending');

  const restarted = createConfirmationCenter({
    stateStore: store,
    now: () => clock,
    ttlMs: 1_000,
    terminalRetentionMs: 100,
    maxRecords: 2,
  });
  await assert.rejects(
    restarted.request({ toolName: 'write_after_restart', args: {}, summary: 'Restarted' }),
    (error) => error.code === 'CONFIRMATION_CAPACITY',
  );

  const page = await center.listMetadata({ limit: 10 });
  assert.equal(page.items.length, 2);
  assert.equal(JSON.stringify(page).includes('canary-one'), false);
  assert.equal(JSON.stringify(page).includes('canary-two'), false);
  assert.equal(page.items.some((item) => Object.hasOwn(item, 'args')), false);

  // Explicit TTL expiry, not capacity pressure, is what releases active work.
  clock += 1_001;
  const replacement = await center.request({ toolName: 'write_replacement', args: {}, summary: 'Replacement' });
  assert.ok(replacement.id);
  assert.deepEqual(await center.capacity(), {
    total: 1,
    maxRecords: 2,
    available: 1,
    statuses: { pending: 1 },
  });
});

test('concurrent capacity and reconciliation are compare-and-swap protected', async () => {
  const clock = Date.parse('2026-01-01T02:00:00Z');
  const store = createMemoryStateStore();
  const center = createConfirmationCenter({ stateStore: store, now: () => clock, maxRecords: 1 });
  const attempts = await Promise.allSettled([
    center.request({ toolName: 'write_a', args: {}, summary: 'A' }),
    center.request({ toolName: 'write_b', args: {}, summary: 'B' }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'CONFIRMATION_CAPACITY').length, 1);

  const [metadata] = (await center.listMetadata()).items;
  const command = {
    expectedRevision: metadata.revision,
    expectedStatus: 'pending',
    resolution: 'rejected',
    evidenceDigest: 'a'.repeat(64),
  };
  const outcomes = await Promise.all([
    center.reconcile(metadata.id, command),
    center.reconcile(metadata.id, command),
  ]);
  assert.equal(outcomes.filter((item) => item.reconciled).length, 1);
  assert.equal(outcomes.filter((item) => item.reason === 'conflict').length, 1);
  const saved = await store.get('confirmation', metadata.id);
  assert.equal(saved.value.status, 'rejected');
  assert.equal(Object.hasOwn(saved.value, 'args'), false);
});

test('execution records discard raw args, protect unresolved effects, and honor terminal retention', async () => {
  let clock = Date.parse('2026-01-01T03:00:00Z');
  const store = createMemoryStateStore();
  const center = createConfirmationCenter({
    stateStore: store,
    now: () => clock,
    ttlMs: 1_000,
    terminalRetentionMs: 100,
    maxRecords: 10,
  });
  const privateCanary = 'synthetic-private-account-canary';
  const successful = wrapWriteTool(defineTool({
    name: 'successful_write',
    params: { properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async (args) => ({ accepted: args.value.length }),
  }), { center, summarize: (args) => `Set a value with length ${args.value.length}` });
  const pending = await successful.handler({ value: privateCanary });
  assert.equal(pending.summary, `Set a value with length ${privateCanary.length}`);
  assert.match(pending.argsDigest, /^[0-9a-f]{64}$/);
  assert.match(pending.reviewDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(await center.list()).includes(privateCanary), false, 'management list must not expose raw args');
  await center.approve(pending.confirmationId);
  assert.deepEqual(await successful.handler({ confirmationId: pending.confirmationId }), { accepted: privateCanary.length });
  let record = await store.get('confirmation', pending.confirmationId);
  assert.equal(record.value.status, 'completed');
  assert.equal(Object.hasOwn(record.value, 'args'), false);
  assert.equal(JSON.stringify(record.value).includes(privateCanary), false);

  clock += 99;
  assert.equal((await center.prune()).removed, 0, 'terminal evidence remains for its configured retention');
  clock += 2;
  assert.equal((await center.prune()).removed, 1);

  const failing = wrapWriteTool(defineTool({
    name: 'unknown_write',
    params: { properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async () => { throw new Error('upstream may have committed'); },
  }), { center, summarize: (args) => `Set a value with length ${args.value.length}` });
  const unknownPending = await failing.handler({ value: privateCanary });
  await center.approve(unknownPending.confirmationId);
  await assert.rejects(
    failing.handler({ confirmationId: unknownPending.confirmationId }),
    (error) => error.code === 'CONFIRMATION_EXECUTION_UNKNOWN' && error.reconciliationRequired === true,
  );
  record = await store.get('confirmation', unknownPending.confirmationId);
  assert.equal(record.value.status, 'reconciliation_required');
  assert.equal(Object.hasOwn(record.value, 'args'), false);
  assert.equal((await center.prune()).removed, 0);
  clock += 10_000;
  assert.equal((await center.prune()).removed, 0, 'unresolved side effects are never retention-pruned');

  const metadata = (await center.listMetadata()).items.find((item) => item.id === unknownPending.confirmationId);
  const reconciled = await center.reconcile(metadata.id, {
    expectedRevision: metadata.revision,
    expectedStatus: 'reconciliation_required',
    resolution: 'completed',
    evidenceDigest: 'b'.repeat(64),
  });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.record.status, 'completed');
  clock += 101;
  assert.equal((await center.prune()).removed, 1);
});

test('review summaries redact credential shapes before response, listing, or persistence', async () => {
  const store = createMemoryStateStore();
  const center = createConfirmationCenter({ stateStore: store });
  const privateCredential = ['private', 'credential', '12345'].join('');
  const tool = wrapWriteTool(defineTool({
    name: 'credential_summary_write',
    params: { properties: { reason: { type: 'string' } }, required: ['reason'] },
    handler: async () => ({ ok: true }),
  }), {
    center,
    summarize: (args) => `Approve ${args.reason}; Authorization: Bearer ${privateCredential}`,
  });
  const pending = await tool.handler({ reason: 'routine adjustment' });
  assert.match(pending.summary, /redacted bearer credential/i);
  assert.equal(pending.summary.includes(privateCredential), false);
  assert.equal(JSON.stringify(await center.list()).includes(privateCredential), false);
  assert.equal(JSON.stringify(await store.exportSnapshot()).includes(privateCredential), false);
  const record = (await store.get('confirmation', pending.confirmationId)).value;
  assert.equal(record.summary.includes(privateCredential), false);
  assert.match(record.reviewDigest, /^[0-9a-f]{64}$/);

  await assert.rejects(
    tool.handler({ reason: `Authorization: Bearer ${privateCredential}` }),
    (error) => error.code === 'CONFIRMATION_ARGUMENTS_SECRET' && error.statusCode === 400,
  );
  assert.equal(JSON.stringify(await store.exportSnapshot()).includes(privateCredential), false);
});
