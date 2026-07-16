import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { buildRegistry } from '../src/agents/registry.js';
import { createHttpServer, deriveTrustedSessionId } from '../src/channels/http.js';
import { createWebhookHandler } from '../src/channels/webhook.js';
import { createConfirmationCenter } from '../src/guardrails/confirm-gate.js';
import { createCostTracker } from '../src/runtime/cost-tracker.js';
import { createSessionStore } from '../src/runtime/session-store.js';
import { defineTool } from '../src/runtime/tool.js';
import { createMemoryStateStore } from '../src/stores/index.js';
import { buildDemoTools } from '../src/toolpacks/demo/index.js';

const AUTH_TOKEN = 'sample-security-regression-token';

test('trusted HTTP sessions isolate subjects inside the same tenant', () => {
  const alice = { subjectId: 'alice', tenantId: 'tenant-a' };
  const bob = { subjectId: 'bob', tenantId: 'tenant-a' };
  assert.notEqual(
    deriveTrustedSessionId(alice, 'default'),
    deriveTrustedSessionId(bob, 'default'),
    'a guessable client session id must not merge two same-tenant users',
  );
  assert.equal(deriveTrustedSessionId(alice, 'default'), deriveTrustedSessionId(alice, 'default'));
});

function request({ port, method, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(handleMessage, fn) {
  const server = createHttpServer({
    config: {
      provider: 'mock',
      gatewayAuthToken: AUTH_TOKEN,
      budget: { monthlyUsd: 10, maxUsdPerRequest: 1 },
    },
    handleMessage,
    scheduler: { listJobs: () => [], runNow: async () => null },
    costTracker: createCostTracker(),
    sessionStore: { size: () => 0 },
    webhookHandler: null,
    confirmations: createConfirmationCenter(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function signedHeaders(secret, body, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    'x-timestamp': timestamp,
    'x-signature-256': `sha256=${signature}`,
  };
}

test('BA-SEC-001: streaming accepts a JSON POST and rejects legacy query transport', async () => {
  const calls = [];
  await withServer(async (sessionId, message) => {
    calls.push({ sessionId, message });
    return { text: `reply:${message}`, costUsd: 0.01 };
  }, async (port) => {
    const auth = { authorization: `Bearer ${AUTH_TOKEN}` };
    const legacy = await request({
      port,
      method: 'GET',
      path: '/chat/stream?sessionId=tenant-a&message=private%20forecast',
      headers: auth,
    });
    assert.equal(legacy.status, 405);
    assert.equal(calls.length, 0, 'legacy query route must not reach the agent');

    const variant = await request({
      port,
      method: 'GET',
      path: '/chat/stream?message=second-secret&sessionId=tenant-b&message=duplicate',
      headers: auth,
    });
    assert.equal(variant.status, 405);
    assert.equal(calls.length, 0, 'legacy query variants must remain disabled');

    const longVariant = await request({
      port,
      method: 'GET',
      path: `/chat/stream?sessionId=${'s'.repeat(256)}&message=${'x'.repeat(4096)}`,
      headers: auth,
    });
    assert.equal(longVariant.status, 405);
    assert.equal(calls.length, 0, 'long query values must not re-enable legacy transport');

    const body = JSON.stringify({ sessionId: 'tenant-a', message: 'private forecast' });
    const streamed = await request({
      port,
      method: 'POST',
      path: '/chat/stream',
      body,
      headers: { ...auth, 'content-type': 'application/json' },
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers['content-type'], /^text\/event-stream/);
    assert.match(streamed.text, /reply:private forecast/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sessionId, /^http:[0-9a-f]{64}$/);
    assert.notEqual(calls[0].sessionId, 'tenant-a', 'caller-controlled session ids must be server-namespaced');
    assert.equal(calls[0].message, 'private forecast');

    const chat = await request({
      port,
      method: 'POST',
      path: '/chat',
      body: JSON.stringify({ sessionId: 'chat-positive', message: 'hello' }),
      headers: { ...auth, 'content-type': 'application/json' },
    });
    assert.equal(chat.status, 200, 'POST /chat compatibility must remain intact');
  });
});

test('BA-SEC-002: webhook requires signed sender and conversation identity', async () => {
  const secret = 'sample-webhook-secret';
  const calls = [];
  const handler = createWebhookHandler({
    secret,
    handleMessage: async (sessionId, message) => {
      calls.push({ sessionId, message });
      return { text: 'ok' };
    },
  });

  for (const payload of [
    { message: 'missing both' },
    { eventId: 'evt-1', message: 'missing sender', conversationId: 'conv-1' },
    { eventId: 'evt-2', message: 'missing conversation', senderId: 'sender-1' },
    { message: 'missing event', senderId: 'sender-1', conversationId: 'conv-1' },
  ]) {
    const body = JSON.stringify(payload);
    const result = await handler(body, signedHeaders(secret, body));
    assert.equal(result.status, 400);
  }
  assert.equal(calls.length, 0, 'identity-less events must not reach session state');

  const replayBody = JSON.stringify({ eventId: 'evt-stale', senderId: 'sender-1', conversationId: 'conv-1', message: 'stale' });
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
  const stale = await handler(replayBody, signedHeaders(secret, replayBody, staleTimestamp));
  assert.equal(stale.status, 401, 'replay-window validation must remain active');
  assert.equal(calls.length, 0, 'stale signed events must not reach session state');

  let eventSequence = 0;
  async function send(senderId, conversationId, message, eventId = `evt-${++eventSequence}`) {
    const body = JSON.stringify({ eventId, senderId, conversationId, message });
    return handler(body, signedHeaders(secret, body));
  }

  const first = await send('sender-1', 'conv-1', 'one');
  const same = await send('sender-1', 'conv-1', 'two');
  const otherSender = await send('sender-2', 'conv-1', 'three');
  const otherConversation = await send('sender-1', 'conv-2', 'four');

  assert.equal(first.status, 200);
  assert.equal(first.body.sessionId, same.body.sessionId, 'same trusted identity must be stable');
  assert.notEqual(first.body.sessionId, otherSender.body.sessionId);
  assert.notEqual(first.body.sessionId, otherConversation.body.sessionId);
  assert.match(first.body.sessionId, /^webhook:[0-9a-f]{64}$/);

  const duplicate = await send('sender-1', 'conv-1', 'duplicate', 'evt-duplicate');
  assert.equal(duplicate.status, 200);
  const callsAfterCommit = calls.length;
  const replayed = await send('sender-1', 'conv-1', 'duplicate', 'evt-duplicate');
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed, duplicate, 'same signed event id must return its committed response');
  const conflict = await send('sender-1', 'conv-1', 'duplicate again', 'evt-duplicate');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'WEBHOOK_EVENT_CONFLICT');
  assert.equal(calls.length, callsAfterCommit, 'same signed event id must not execute twice inside the HMAC window');
});

test('BA-SEC-003..007: customer tool policy is fail-closed and excludes global reads', async () => {
  const confirmations = createConfirmationCenter();
  const scoped = buildDemoTools({ confirmations, scope: { customerId: 'cus-001' } });
  const scopedNames = scoped.map((tool) => tool.name);
  const forbidden = [
    'query_raw_data',
    'get_top_customers',
    'get_delivery_status',
    'get_order_summary',
    'get_supplier_performance',
  ];
  for (const name of forbidden) {
    assert.equal(scopedNames.includes(name), false, `${name} must not enter customer mode`);
  }

  const profile = scoped.find((tool) => tool.name === 'get_customer_profile');
  assert.ok(profile, 'customer-safe positive control must remain available');
  const profileResult = await profile.handler({ customerId: 'cus-005', mode: 'raw' });
  assert.equal(profileResult.customer.id, 'cus-001', 'trusted scope must override caller input');

  const unscopedNames = buildDemoTools({ confirmations: createConfirmationCenter() })
    .map((tool) => tool.name);
  for (const name of forbidden) {
    assert.equal(unscopedNames.includes(name), true, `${name} must remain available to operators`);
  }

  const { applyToolPolicies } = await import('../src/runtime/tool-policy.js');
  const probe = defineTool({ name: 'unclassified_probe', handler: () => 'ok' });
  assert.throws(
    () => applyToolPolicies([probe], {}, {}),
    /missing mandatory policy/i,
    'a tool omitted from the manifest must fail registration',
  );
  assert.throws(
    () => applyToolPolicies([probe], {
      unclassified_probe: {
        audiences: ['operator'],
        tenantScope: 'global',
        dataClass: 'internal-test',
        effect: 'read',
      },
    }, {}),
    /missing mandatory policy field/i,
    'a partially classified tool must also fail registration',
  );
});

test('BA-SEC-008: atomic reservation blocks concurrent sessions before provider entry', async () => {
  let providerCalls = 0;
  let releaseFirst;
  let signalFirstEntered;
  const firstEntered = new Promise((resolve) => { signalFirstEntered = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const provider = {
    name: 'barrier',
    async complete({ messages }) {
      providerCalls += 1;
      if (providerCalls === 1) {
        signalFirstEntered();
        await firstRelease;
      }
      return {
        stopReason: 'end_turn',
        text: `ok:${messages.at(-1).content}`,
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const config = {
    llmModel: 'test-model',
    maxTurns: 1,
    maxTokens: 16,
    priceTable: { 'test-model': { inputPerMTok: 1, outputPerMTok: 1 } },
    budget: { maxUsdPerRequest: 1, monthlyUsd: 1 },
    patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
    notifyWebhookUrl: null,
  };
  const costTracker = createCostTracker();
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  const registry = buildRegistry({
    config,
    provider,
    costTracker,
    sessionStore,
    confirmations: createConfirmationCenter(),
  });

  try {
    const first = registry.handleMessage('session-a', 'first');
    await firstEntered;
    const second = await registry.handleMessage('session-b', 'second');
    assert.equal(providerCalls, 1, 'second session must be stopped before provider entry');
    assert.equal(second.costUsd, 0);
    assert.match(second.text, /budget/i);
    assert.equal(costTracker.getReservedCost(), 1);

    releaseFirst();
    const firstResult = await first;
    assert.match(firstResult.text, /^ok:first$/);
    assert.equal(costTracker.getReservedCost(), 0, 'reservation must commit/release');
    const summary = costTracker.summary();
    assert.equal(summary.calls, 1, 'committed ledger must match the one provider call');
    assert.ok(Math.abs(summary.costUsd - 0.000002) < 1e-12);
  } finally {
    releaseFirst?.();
    sessionStore.close();
  }
});

test('BA-SEC-008: reservation size is never clamped below the request ceiling', async () => {
  let providerCalls = 0;
  const auditEvents = [];
  const provider = {
    name: 'must-not-run',
    async complete() {
      providerCalls += 1;
      return {
        stopReason: 'end_turn',
        text: 'unexpected',
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const config = {
    llmModel: 'test-model',
    maxTurns: 1,
    maxTokens: 16,
    priceTable: {},
    budget: { maxUsdPerRequest: 2, monthlyUsd: 1 },
    patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
    notifyWebhookUrl: null,
  };
  const costTracker = createCostTracker();
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  const registry = buildRegistry({
    config,
    provider,
    costTracker,
    sessionStore,
    confirmations: createConfirmationCenter(),
    audit: {
      async start(event) { auditEvents.push(event); return { id: 'unexpected' }; },
      async append(event) { auditEvents.push(event); },
    },
  });

  try {
    const blocked = await registry.handleMessage('session-a', 'must remain blocked');
    assert.equal(blocked.costUsd, 0);
    assert.match(blocked.text, /budget/i);
    assert.equal(providerCalls, 0, 'an under-reserved request must never reach the provider');
    assert.equal(costTracker.getReservedCost(), 0);
    assert.equal(auditEvents.length, 0, 'budget-denied traffic must not consume audit capacity');
  } finally {
    sessionStore.close();
  }
});

test('webhook monthly-budget denial does not consume audit capacity', async () => {
  let providerCalls = 0;
  const auditEvents = [];
  const provider = {
    name: 'must-not-run',
    async complete() {
      providerCalls += 1;
      return { stopReason: 'end_turn', text: 'unexpected', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const config = {
    llmModel: 'test-model',
    maxTurns: 1,
    maxTokens: 16,
    priceTable: {},
    budget: { maxUsdPerRequest: 2, monthlyUsd: 1 },
    patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
    notifyWebhookUrl: null,
  };
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  const registry = buildRegistry({
    config,
    provider,
    costTracker: createCostTracker(),
    sessionStore,
    confirmations: createConfirmationCenter(),
    audit: {
      async start(event) { auditEvents.push(event); return { id: 'unexpected' }; },
      async append(event) { auditEvents.push(event); },
    },
  });
  const secret = 'sample-budget-webhook-secret';
  const handler = createWebhookHandler({ secret, handleMessage: registry.handleMessage, audit: {
    async start(event) { auditEvents.push(event); return { id: 'unexpected-webhook' }; },
    async append(event) { auditEvents.push(event); },
  } });
  const body = JSON.stringify({ eventId: 'budget-denied', senderId: 'sender', conversationId: 'conversation', message: 'hello' });
  try {
    const response = await handler(body, signedHeaders(secret, body));
    assert.equal(response.status, 200);
    assert.match(response.body.reply, /budget/i);
    assert.equal(providerCalls, 0);
    assert.equal(auditEvents.length, 0);
  } finally {
    sessionStore.close();
  }
});

test('BA-SEC-008: failed provider calls refund reservations', async () => {
  let calls = 0;
  const provider = {
    name: 'failure-then-success',
    async complete() {
      calls += 1;
      if (calls === 1) throw new Error('synthetic provider failure');
      return {
        stopReason: 'end_turn',
        text: 'recovered',
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const config = {
    llmModel: 'test-model',
    maxTurns: 1,
    maxTokens: 16,
    priceTable: {},
    budget: { maxUsdPerRequest: 1, monthlyUsd: 1 },
    patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
    notifyWebhookUrl: null,
  };
  const costTracker = createCostTracker();
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  const registry = buildRegistry({
    config,
    provider,
    costTracker,
    sessionStore,
    confirmations: createConfirmationCenter(),
  });

  try {
    await assert.rejects(registry.handleMessage('failed', 'first'), /synthetic provider failure/);
    assert.equal(costTracker.getReservedCost(), 0);
    const recovered = await registry.handleMessage('recovered', 'second');
    assert.equal(recovered.text, 'recovered');
    assert.equal(calls, 2, 'refunded budget must admit a later request');
  } finally {
    sessionStore.close();
  }
});

test('post-provider usage-ledger failure conservatively consumes the reservation', async () => {
  const baseStore = createMemoryStateStore();
  let transactions = 0;
  const stateStore = {
    ...baseStore,
    async transaction(callback) {
      transactions += 1;
      if (transactions === 3) {
        throw Object.assign(new Error('synthetic one-shot ledger outage'), { code: 'STATE_WRITE_FAILED' });
      }
      return baseStore.transaction(callback);
    },
  };
  const costTracker = createCostTracker({ stateStore });
  const sessionStore = createSessionStore({ ttlMs: 60_000 });
  let providerCalls = 0;
  const registry = buildRegistry({
    config: {
      llmModel: 'test-model',
      maxTurns: 1,
      maxTokens: 16,
      priceTable: { 'test-model': { inputPerMTok: 1, outputPerMTok: 1 } },
      budget: { maxUsdPerRequest: 1, monthlyUsd: 1 },
      patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
      notifyWebhookUrl: null,
    },
    provider: {
      name: 'billable-success',
      async complete() {
        providerCalls += 1;
        return {
          stopReason: 'end_turn',
          text: 'provider already completed',
          toolCalls: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    costTracker,
    sessionStore,
    confirmations: createConfirmationCenter(),
  });

  try {
    await assert.rejects(
      registry.handleMessage('ledger-fault', 'charge once'),
      (error) => error.code === 'STATE_WRITE_FAILED' && error.unknownOutcome === true,
    );
    assert.equal(providerCalls, 1);
    assert.equal(await costTracker.getReservedCost(), 0);
    assert.equal(await costTracker.getMonthlyCost(), 1, 'real provider spend must never disappear after a ledger fault');
  } finally {
    sessionStore.close();
  }
});
