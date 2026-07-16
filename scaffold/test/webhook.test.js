import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHttpServer } from '../src/channels/http.js';
import { createWebhookHandler, createWebhookReplayStore } from '../src/channels/webhook.js';
import { createFileStateStore, createMemoryStateStore } from '../src/stores/index.js';

const SECRET = '<sample-webhook-fixture>';
const INTEGRATION_ID = 'integration-state-machine';

function signedCall(handler, payload, context) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return handler(body, {
    'x-timestamp': timestamp,
    'x-signature-256': `sha256=${signature}`,
  }, context);
}

function event(eventId, message = 'hello') {
  return {
    eventId,
    senderId: 'sender-1',
    conversationId: 'conversation-1',
    message,
  };
}

async function withReplayStore(run, options = {}) {
  const stateStore = createMemoryStateStore();
  const replayStore = createWebhookReplayStore({ stateStore, ...options });
  try {
    await run(replayStore);
  } finally {
    await stateStore.close();
  }
}

function jsonRequest(port, { credential, body }) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/webhook/reconciliation',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

test('429 before execution leaves a failed claim and the same event can retry', async () => {
  await withReplayStore(async (replayStore) => {
    let quotaEntries = 0;
    let releases = 0;
    let executions = 0;
    const auditEvents = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      audit: {
        async start(event) { auditEvents.push(event); return { id: 'quota-retry-start' }; },
        async append(event) { auditEvents.push(event); },
      },
      quotaManager: {
        async enter() {
          quotaEntries += 1;
          if (quotaEntries === 1) {
            throw Object.assign(new Error('quota rejected before execution'), {
              statusCode: 429,
              code: 'QUOTA_CONCURRENT_LIMIT',
            });
          }
          return async () => { releases += 1; };
        },
      },
      handleMessage: async () => {
        executions += 1;
        return { text: 'accepted' };
      },
    });

    const first = await signedCall(handler, event('evt-quota-retry'));
    assert.equal(first.status, 429);
    assert.equal(auditEvents.length, 0, 'quota rejection must not consume audit capacity');
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-quota-retry' })).status, 'failed');

    const retry = await signedCall(handler, event('evt-quota-retry'));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.reply, 'accepted');
    assert.equal(executions, 1, 'quota rejection must happen before business execution');
    assert.equal(auditEvents.length, 2, 'the admitted retry has one start and one completion record');
    assert.equal(releases, 1, 'an acquired asynchronous quota lease must be released');
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-quota-retry' })).status, 'committed');
  });
});

test('an explicit pre-effect handler failure can retry the same event', async () => {
  await withReplayStore(async (replayStore) => {
    let executions = 0;
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      handleMessage: async () => {
        executions += 1;
        if (executions === 1) {
          throw Object.assign(new Error('upstream unavailable before effect'), {
            statusCode: 503,
            code: 'UPSTREAM_PRE_EFFECT',
            preEffect: true,
          });
        }
        return { text: 'retried safely' };
      },
    });

    const first = await signedCall(handler, event('evt-pre-effect'));
    assert.equal(first.status, 503);
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-pre-effect' })).status, 'failed');

    const retry = await signedCall(handler, event('evt-pre-effect'));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.reply, 'retried safely');
    assert.equal(executions, 2);
  });
});

test('a 429 after business execution starts becomes unknown and cannot replay', async () => {
  await withReplayStore(async (replayStore) => {
    let executions = 0;
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      handleMessage: async () => {
        executions += 1;
        throw Object.assign(new Error('later turn was rate limited'), {
          statusCode: 429,
          code: 'PROVIDER_RATE_LIMIT',
        });
      },
    });

    const first = await signedCall(handler, event('evt-post-effect-429'));
    assert.equal(first.status, 429);
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-post-effect-429' })).status, 'unknown');

    const duplicate = await signedCall(handler, event('evt-post-effect-429'));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'WEBHOOK_OUTCOME_UNKNOWN');
    assert.equal(executions, 1);
  });
});

test('a committed duplicate stays cached after TTL, rejects payload conflicts, and survives post-effect audit failure', async () => {
  let clock = 1_000;
  await withReplayStore(async (replayStore) => {
    let executions = 0;
    const logs = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      replayTtlSeconds: 1,
      handleMessage: async (_sessionId, message) => {
        executions += 1;
        return { text: `reply:${message}` };
      },
      audit: {
        async start() { return { id: 'durable-pre-effect-record' }; },
        async append() {
          throw Object.assign(new Error('sensitive audit backend detail'), { code: 'AUDIT_DOWN' });
        },
      },
      logger: { error: (line) => logs.push(line) },
    });

    const first = await signedCall(handler, event('evt-committed', 'original'));
    assert.equal(first.status, 200);
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-committed' })).status, 'committed');

    clock += 10_000;
    const duplicate = await signedCall(handler, event('evt-committed', 'original'));
    assert.deepEqual(duplicate, first, 'duplicates must return the exact committed response');
    const conflict = await signedCall(handler, event('evt-committed', 'changed payload'));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'WEBHOOK_EVENT_CONFLICT');
    assert.equal(executions, 1, 'a committed event must never execute again');
    assert.equal(logs.length, 3);
    assert.ok(logs.every((line) => line.includes('code=AUDIT_DOWN')));
    assert.ok(logs.every((line) => !line.includes('sensitive audit backend detail')));
  }, { now: () => clock });
});

test('webhook audit failure returns 503 and blocks business execution', async () => {
  let executions = 0;
  const handler = createWebhookHandler({
    secret: SECRET,
    integrationId: INTEGRATION_ID,
    handleMessage: async () => { executions += 1; return { text: 'must-not-run' }; },
    audit: {
      async append() {
        throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_CAPACITY_EXHAUSTED', statusCode: 503 });
      },
    },
  });
  const response = await signedCall(handler, event('evt-audit-full'));
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AUDIT_CAPACITY_EXHAUSTED');
  assert.equal(executions, 0);
});

test('same-process concurrent duplicates coalesce and receive the full committed response once', async () => {
  await withReplayStore(async (replayStore) => {
    let executions = 0;
    let entered;
    let releaseExecution;
    const started = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { releaseExecution = resolve; });
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      handleMessage: async () => {
        executions += 1;
        entered();
        await barrier;
        return { text: 'one private full response' };
      },
    });

    const first = signedCall(handler, event('evt-concurrent'));
    await started;
    const duplicate = signedCall(handler, event('evt-concurrent'));
    releaseExecution();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.deepEqual(duplicateResult, firstResult);
    assert.equal(firstResult.body.reply, 'one private full response');
    assert.equal(executions, 1);
  });
});

test('durable committed evidence omits the full reply and restart duplicates fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'business-agent-webhook-restart-'));
  const filePath = join(directory, 'state.json');
  let stateStore = await createFileStateStore({ filePath });
  try {
    let executions = 0;
    const firstStore = createWebhookReplayStore({ stateStore });
    const firstHandler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore: firstStore,
      handleMessage: async () => {
        executions += 1;
        return { text: 'private-customer-and-business-result' };
      },
    });
    const first = await signedCall(firstHandler, event('evt-private-commit'));
    assert.equal(first.status, 200);
    assert.equal(first.body.reply, 'private-customer-and-business-result');

    const snapshotText = JSON.stringify(await stateStore.exportSnapshot());
    assert.doesNotMatch(snapshotText, /private-customer-and-business-result/);
    assert.doesNotMatch(snapshotText, /\"response\"/);
    assert.match(snapshotText, /\"responseDigest\"/);

    await stateStore.close();
    stateStore = await createFileStateStore({ filePath });
    const restartedStore = createWebhookReplayStore({ stateStore });
    const restartedHandler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore: restartedStore,
      handleMessage: async () => {
        executions += 1;
        return { text: 'must-not-run' };
      },
    });
    const duplicate = await signedCall(restartedHandler, event('evt-private-commit'));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'WEBHOOK_COMMITTED_RECONCILIATION_REQUIRED');
    assert.equal(duplicate.body.reconciliationRequired, true);
    assert.equal(executions, 1);
  } finally {
    await stateStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('webhook execution and audit metadata use digests instead of raw integration or event ids', async () => {
  const auditEvents = [];
  let executionContext;
  const privateIntegrationId = 'customer-acquisition-production';
  const privateEventId = 'evt-private-customer-123';
  const handler = createWebhookHandler({
    secret: SECRET,
    integrationId: privateIntegrationId,
    audit: { append: async (entry) => { auditEvents.push(entry); } },
    handleMessage: async (_sessionId, _message, context) => {
      executionContext = context;
      return { text: 'ok' };
    },
  });
  const result = await signedCall(handler, event(privateEventId));
  assert.equal(result.status, 200);
  assert.match(executionContext.requestId, /^webhook:[0-9a-f]{64}$/);
  assert.doesNotMatch(executionContext.requestId, new RegExp(privateEventId));
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0].outcome, 'started');
  assert.match(auditEvents[0].resource, /^webhook:[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(`${privateIntegrationId}|${privateEventId}`));
});

test('an unknown business outcome blocks the same event from replay', async () => {
  await withReplayStore(async (replayStore) => {
    let executions = 0;
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      handleMessage: async () => {
        executions += 1;
        throw Object.assign(new Error('provider timed out after dispatch'), {
          statusCode: 504,
          code: 'PROVIDER_OUTCOME_UNKNOWN',
          unknownOutcome: true,
        });
      },
    });

    const first = await signedCall(handler, event('evt-unknown'));
    assert.equal(first.status, 504);
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-unknown' })).status, 'unknown');

    const duplicate = await signedCall(handler, event('evt-unknown'));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'WEBHOOK_OUTCOME_UNKNOWN');
    assert.equal(executions, 1, 'unknown events require reconciliation instead of automatic replay');
  });
});

test('an expired running claim atomically becomes permanent unknown', async () => {
  let clock = 10_000;
  await withReplayStore(async (replayStore) => {
    const payloadHash = createHash('sha256').update('same signed payload').digest('hex');
    const first = await replayStore.claim({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-expired-running',
      payloadHash,
      ttlMs: 100,
    });
    assert.equal(first.claimed, true);
    assert.equal(first.status, 'running');

    clock += 101;
    const expired = await replayStore.claim({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-expired-running',
      payloadHash,
      ttlMs: 100,
    });
    assert.deepEqual(expired, { claimed: false, status: 'unknown' });
    const record = await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-expired-running' });
    assert.equal(record.status, 'unknown');
    assert.equal(Object.hasOwn(record, 'expiresAt'), false, 'unknown outcomes must not automatically expire into replayability');

    clock += 1_000_000;
    const later = await replayStore.claim({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-expired-running',
      payloadHash,
      ttlMs: 100,
    });
    assert.deepEqual(later, { claimed: false, status: 'unknown' });
  }, { now: () => clock });
});

test('replay ledger capacity is bounded and fails closed until explicit reconciliation', async () => {
  await withReplayStore(async (replayStore) => {
    const payloadHash = createHash('sha256').update('payload-one').digest('hex');
    const first = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-cap-1', payloadHash, ttlMs: 100 });
    await replayStore.fail({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-cap-1',
      ownerId: first.ownerId,
      payloadHash,
      ttlMs: 100,
      unknownOutcome: true,
    });
    const full = await replayStore.claim({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-cap-2',
      payloadHash: createHash('sha256').update('payload-two').digest('hex'),
      ttlMs: 100,
    });
    assert.deepEqual(full, { claimed: false, status: 'capacity', reconciliationRequired: true });
    assert.deepEqual(await replayStore.capacity(), { records: 1, maxRecords: 1, full: true });

    const forgotten = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-cap-1',
      action: 'forget',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'unknown',
      acknowledgement: 'I_ACCEPT_DUPLICATE_DELIVERY_RISK',
    });
    assert.equal(forgotten.ok, true);
    const after = await replayStore.claim({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-cap-2',
      payloadHash: createHash('sha256').update('payload-two').digest('hex'),
      ttlMs: 100,
    });
    assert.equal(after.claimed, true);
  }, { maxRecords: 1 });
});

test('webhook handler returns 503 without execution when replay capacity is exhausted', async () => {
  await withReplayStore(async (replayStore) => {
    const existingHash = createHash('sha256').update('existing').digest('hex');
    await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-existing', payloadHash: existingHash, ttlMs: 100 });
    let executions = 0;
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      handleMessage: async () => {
        executions += 1;
        return { text: 'must-not-run' };
      },
    });
    const result = await signedCall(handler, event('evt-over-capacity'));
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'WEBHOOK_REPLAY_CAPACITY');
    assert.equal(result.body.reconciliationRequired, true);
    assert.equal(executions, 0);
  }, { maxRecords: 1 });
});

test('unknown reconciliation requires matching evidence and explicit risk acknowledgement', async () => {
  await withReplayStore(async (replayStore) => {
    const payloadHash = createHash('sha256').update('reconcile-payload').digest('hex');
    const claim = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-reconcile', payloadHash, ttlMs: 100 });
    await replayStore.fail({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      ownerId: claim.ownerId,
      payloadHash,
      ttlMs: 100,
      unknownOutcome: true,
    });
    const inspected = await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-reconcile' });
    assert.equal(inspected.status, 'unknown');
    assert.equal(Object.hasOwn(inspected, 'response'), false);
    assert.equal(Object.hasOwn(inspected, 'ownerId'), false);

    const noAck = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'retry',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'unknown',
      acknowledgement: 'yes',
    });
    assert.equal(noAck.code, 'WEBHOOK_RECONCILIATION_ACKNOWLEDGEMENT_REQUIRED');
    const mismatch = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'retry',
      expectedPayloadHash: '0'.repeat(64),
      expectedStatus: 'unknown',
      acknowledgement: 'I_VERIFIED_RETRY_IS_SAFE',
    });
    assert.equal(mismatch.code, 'WEBHOOK_RECONCILIATION_EVIDENCE_MISMATCH');

    const retried = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'retry',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'unknown',
      acknowledgement: 'I_VERIFIED_RETRY_IS_SAFE',
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.record.status, 'failed');
    const reclaimed = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-reconcile', payloadHash, ttlMs: 100 });
    assert.equal(reclaimed.claimed, true);
    await replayStore.fail({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      ownerId: reclaimed.ownerId,
      payloadHash,
      ttlMs: 100,
      unknownOutcome: true,
    });
    const evidenceDigest = createHash('sha256').update('external-ledger-evidence').digest('hex');
    const marked = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'mark-committed',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'unknown',
      acknowledgement: 'I_VERIFIED_SIDE_EFFECT_COMMITTED',
      evidenceDigest,
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.record.status, 'committed');
    assert.equal(marked.record.reconciliationDigest, evidenceDigest);
    const duplicate = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-reconcile', payloadHash, ttlMs: 100 });
    assert.deepEqual(duplicate, { claimed: false, status: 'committed', reconciliationRequired: true });
    const staleForget = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'forget',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'unknown',
      acknowledgement: 'I_ACCEPT_DUPLICATE_DELIVERY_RISK',
    });
    assert.equal(staleForget.code, 'WEBHOOK_RECONCILIATION_STATE_CONFLICT');
    const forgotten = await replayStore.reconcile({
      integrationId: INTEGRATION_ID,
      eventId: 'evt-reconcile',
      action: 'forget',
      expectedPayloadHash: payloadHash,
      expectedStatus: 'committed',
      acknowledgement: 'I_ACCEPT_DUPLICATE_DELIVERY_RISK',
    });
    assert.equal(forgotten.ok, true);
    assert.equal(await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-reconcile' }), null);
  });
});

test('compact removes only expired retryable failures and preserves committed/unknown evidence', async () => {
  let clock = 1_000;
  await withReplayStore(async (replayStore) => {
    const expiredHash = createHash('sha256').update('expired').digest('hex');
    const expired = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-expired-failed', payloadHash: expiredHash, ttlMs: 10 });
    await replayStore.fail({ integrationId: INTEGRATION_ID, eventId: 'evt-expired-failed', ownerId: expired.ownerId, payloadHash: expiredHash, ttlMs: 10 });

    const unknownHash = createHash('sha256').update('unknown').digest('hex');
    const unknown = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-unknown', payloadHash: unknownHash, ttlMs: 10 });
    await replayStore.fail({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-unknown', ownerId: unknown.ownerId, payloadHash: unknownHash, ttlMs: 10, unknownOutcome: true });

    const committedHash = createHash('sha256').update('committed').digest('hex');
    const committed = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-committed', payloadHash: committedHash, ttlMs: 10 });
    await replayStore.commit({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-committed', ownerId: committed.ownerId, payloadHash: committedHash, response: { status: 200, body: { reply: 'private' } } });

    clock += 11;
    const outcome = await replayStore.compact();
    assert.equal(outcome.removed, 1);
    assert.equal(await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-expired-failed' }), null);
    assert.equal((await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-unknown' })).status, 'unknown');
    assert.equal((await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-preserve-committed' })).status, 'committed');
  }, { now: () => clock });
});

test('reconciliation HTTP API requires operator scope and rejects tenant-scoped access', async () => {
  const stateStore = createMemoryStateStore();
  const replayStore = createWebhookReplayStore({ stateStore });
  const payloadHash = createHash('sha256').update('api-payload').digest('hex');
  const claim = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api', payloadHash, ttlMs: 100 });
  await replayStore.fail({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api', ownerId: claim.ownerId, payloadHash, ttlMs: 100, unknownOutcome: true });
  const scopedTenant = 'sample-tenant-reconciler';
  const platformNoScope = 'sample-platform-no-scope';
  const adminNoScope = 'sample-admin-no-reconcile-scope';
  const platformReconciler = 'sample-platform-reconciler';
  const server = createHttpServer({
    config: {
      provider: 'mock',
      budget: { monthlyUsd: 10, maxUsdPerRequest: 1 },
      authPrincipals: [
        { token: scopedTenant, principal: { subjectId: 'tenant-op', tenantId: 'tenant-a', roles: ['operator'], scopes: ['webhooks:reconcile'] } },
        { token: platformNoScope, principal: { subjectId: 'platform-observer', tenantId: null, roles: ['operator'], scopes: ['status:read'] } },
        { token: adminNoScope, principal: { subjectId: 'platform-admin', tenantId: null, roles: ['admin'], scopes: [] } },
        { token: platformReconciler, principal: { subjectId: 'platform-op', tenantId: null, roles: ['operator'], scopes: ['webhooks:reconcile'] } },
      ],
    },
    handleMessage: async () => ({ text: 'unused' }),
    scheduler: { listJobs: () => [], runNow: async () => null },
    costTracker: {},
    sessionStore: {},
    webhookReplayStore: replayStore,
    webhookIntegrationId: INTEGRATION_ID,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const command = { action: 'inspect', eventId: 'evt-private-api' };
    assert.equal((await jsonRequest(port, { body: command })).status, 401);
    assert.equal((await jsonRequest(port, { credential: platformNoScope, body: command })).status, 403);
    assert.equal((await jsonRequest(port, { credential: adminNoScope, body: command })).status, 403);
    assert.equal((await jsonRequest(port, { credential: scopedTenant, body: command })).status, 403);

    const inspected = await jsonRequest(port, { credential: platformReconciler, body: command });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.record.status, 'unknown');
    assert.doesNotMatch(inspected.text, /evt-private-api/);
    assert.equal(Object.hasOwn(inspected.body.record, 'response'), false);

    const retry = await jsonRequest(port, {
      credential: platformReconciler,
      body: {
        action: 'retry',
        eventId: 'evt-private-api',
        expectedPayloadHash: payloadHash,
        expectedStatus: 'unknown',
        acknowledgement: 'I_VERIFIED_RETRY_IS_SAFE',
      },
    });
    assert.equal(retry.status, 200);
    assert.doesNotMatch(retry.text, /evt-private-api/);
    assert.equal((await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api' })).status, 'failed');

    const reclaimed = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api', payloadHash, ttlMs: 100 });
    await replayStore.fail({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api', ownerId: reclaimed.ownerId, payloadHash, ttlMs: 100, unknownOutcome: true });
    const evidenceDigest = createHash('sha256').update('operator-external-evidence').digest('hex');
    const marked = await jsonRequest(port, {
      credential: platformReconciler,
      body: {
        action: 'mark-committed',
        eventId: 'evt-private-api',
        expectedPayloadHash: payloadHash,
        expectedStatus: 'unknown',
        evidenceDigest,
        acknowledgement: 'I_VERIFIED_SIDE_EFFECT_COMMITTED',
      },
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.record.status, 'committed');

    const forgot = await jsonRequest(port, {
      credential: platformReconciler,
      body: {
        action: 'forget',
        eventId: 'evt-private-api',
        expectedPayloadHash: payloadHash,
        expectedStatus: 'committed',
        acknowledgement: 'I_ACCEPT_DUPLICATE_DELIVERY_RISK',
      },
    });
    assert.equal(forgot.status, 200);
    assert.equal(await replayStore.inspect({ integrationId: INTEGRATION_ID, eventId: 'evt-private-api' }), null);

    const expiredHash = createHash('sha256').update('api-expired').digest('hex');
    const expired = await replayStore.claim({ integrationId: INTEGRATION_ID, eventId: 'evt-api-expired', payloadHash: expiredHash, ttlMs: 100 });
    await replayStore.fail({ integrationId: INTEGRATION_ID, eventId: 'evt-api-expired', ownerId: expired.ownerId, payloadHash: expiredHash, ttlMs: -1 });
    const compacted = await jsonRequest(port, {
      credential: platformReconciler,
      body: { action: 'compact', limit: 10 },
    });
    assert.equal(compacted.status, 200);
    assert.equal(compacted.body.removed, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await stateStore.close();
  }
});

test('HTTP passes request, tracing, and abort context to the webhook handler', async () => {
  let captured;
  const server = createHttpServer({
    config: { provider: 'mock', budget: { monthlyUsd: 10, maxUsdPerRequest: 1 } },
    handleMessage: async () => ({ text: 'unused' }),
    scheduler: { listJobs: () => [], runNow: async () => null },
    costTracker: {},
    sessionStore: {},
    confirmations: null,
    webhookHandler: async (rawBody, headers, context) => {
      captured = { rawBody, headers, context };
      return { status: 200, body: { ok: true } };
    },
    telemetry: {
      startSpan: () => ({ traceId: 'trace-1', spanId: 'span-1', end() {} }),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/webhook',
        headers: { 'x-request-id': 'webhook-context-request' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      });
      req.on('error', reject);
      req.end('{"message":"context"}');
    });
    assert.equal(response.statusCode, 200);
    assert.equal(captured.rawBody, '{"message":"context"}');
    assert.match(captured.context.requestId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(captured.context.requestId, 'webhook-context-request');
    assert.match(captured.context.operationId, /^[0-9a-f-]{36}$/i);
    assert.equal(captured.context.signal instanceof AbortSignal, true);
    assert.equal(captured.context.signal.aborted, false);
    assert.deepEqual(captured.context.telemetryContext, { traceId: 'trace-1', parentSpanId: 'span-1' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('webhook execution combines request cancellation with quota lease loss', async () => {
  await withReplayStore(async (replayStore) => {
    const leaseController = new AbortController();
    const requestController = new AbortController();
    let entered;
    const handlerEntered = new Promise((resolve) => { entered = resolve; });
    let observedSignal;
    let releases = 0;
    const release = async () => { releases += 1; return false; };
    Object.defineProperty(release, 'signal', { value: leaseController.signal });
    const handler = createWebhookHandler({
      secret: SECRET,
      integrationId: INTEGRATION_ID,
      replayStore,
      quotaManager: { enter: async () => release },
      handleMessage: async (_sessionId, _message, context) => {
        observedSignal = context.signal;
        entered();
        if (context.signal.aborted) throw context.signal.reason;
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
        return { text: 'unreachable' };
      },
    });

    const pending = signedCall(handler, event('evt-quota-lease-loss'), { signal: requestController.signal });
    await handlerEntered;
    const lost = Object.assign(new Error('quota lease lost'), { code: 'QUOTA_LEASE_LOST', unknownOutcome: true });
    leaseController.abort(lost);
    await assert.rejects(pending, (error) => error.code === 'QUOTA_LEASE_LOST');
    assert.equal(requestController.signal.aborted, false);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason.code, 'QUOTA_LEASE_LOST');
    assert.equal(releases, 1);
    assert.equal((await replayStore.get({ integrationId: INTEGRATION_ID, eventId: 'evt-quota-lease-loss' })).status, 'unknown');
  });
});
