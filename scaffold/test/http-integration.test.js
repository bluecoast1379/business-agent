import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createHttpServer } from '../src/channels/http.js';
import { createTelemetry } from '../src/observability/index.js';
import { createIdempotencyStore } from '../src/runtime/execution/index.js';

const OPERATOR_CREDENTIAL = ['sample', 'operator', 'credential', '123'].join('-');
const PLATFORM_CREDENTIAL = ['sample', 'platform', 'credential', '123'].join('-');
const CALLER_A_CREDENTIAL = ['sample', 'caller', 'a', 'credential', '123'].join('-');
const CALLER_B_CREDENTIAL = ['sample', 'caller', 'b', 'credential', '123'].join('-');
const RECON_CREDENTIAL = ['sample', 'reconciliation', 'credential', '123'].join('-');
const TENANT_RECON_CREDENTIAL = ['sample', 'tenant', 'reconciliation', 'credential', '123'].join('-');

function request(port, { method = 'GET', path = '/', headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent }, (res) => {
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

async function withGateway(fn, { handleMessage, quotaManager, idempotency, audit, scheduler, telemetry } = {}) {
  const calls = [];
  const config = {
    provider: 'mock',
    runtimeProfile: 'development',
    gatewayAuthToken: null,
    authPrincipals: [
      { token: OPERATOR_CREDENTIAL, principal: { subjectId: 'operator-a', tenantId: 'tenant-a', roles: ['operator'], scopes: ['dashboard:view', 'status:read', 'jobs:run'] } },
      { token: PLATFORM_CREDENTIAL, principal: { subjectId: 'platform-operator', tenantId: null, roles: ['operator'], scopes: ['status:read', 'jobs:run'] } },
      { token: CALLER_A_CREDENTIAL, principal: { subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['chat:write'] } },
      { token: CALLER_B_CREDENTIAL, principal: { subjectId: 'caller-b', tenantId: 'tenant-b', roles: ['caller'], scopes: ['chat:write'] } },
      { token: RECON_CREDENTIAL, principal: { subjectId: 'platform-reconciler', tenantId: null, roles: ['operator'], scopes: ['idempotency:reconcile'] } },
      { token: TENANT_RECON_CREDENTIAL, principal: { subjectId: 'tenant-reconciler', tenantId: 'tenant-a', roles: ['operator'], scopes: ['idempotency:reconcile'] } },
    ],
    quota: { requestsPerMinute: 100, concurrency: 10 },
    budget: { monthlyUsd: 10, maxUsdPerRequest: 1 },
    state: { adapter: 'memory' },
  };
  const server = createHttpServer({
    config,
    handleMessage: handleMessage ?? (async (sessionId, message, context) => {
      calls.push({ sessionId, message, context });
      return { text: message, costUsd: 0 };
    }),
    scheduler: scheduler ?? { adapterName: 'local', capabilities: {}, listJobs: () => [], runNow: async () => null },
    costTracker: { getMonthlyCost: async () => 0, getReservedCost: async () => 0, isOverBudget: async () => false, summary: async () => ({}) },
    sessionStore: { size: async () => 0 },
    confirmations: { list: async () => [] },
    dashboardHandler(req, res, context) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ subjectId: context.principal.subjectId }));
      return true;
    },
    quotaManager,
    idempotency,
    audit,
    telemetry,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, calls, server); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('dashboard exchanges bearer for an HttpOnly cookie used only by read-only dashboard routes', async () => {
  await withGateway(async (port) => {
    assert.equal((await request(port, { path: '/dashboard/login' })).status, 200);

    const denied = await request(port, {
      method: 'POST',
      path: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: CALLER_A_CREDENTIAL }).toString(),
    });
    assert.equal(denied.status, 401);

    const login = await request(port, {
      method: 'POST',
      path: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: OPERATOR_CREDENTIAL }).toString(),
    });
    assert.equal(login.status, 303);
    assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    assert.doesNotMatch(login.headers.location, /credential|token/i);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    const page = await request(port, { path: '/dashboard', headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /operator-a/);
    assert.equal((await request(port, { path: '/status', headers: { cookie } })).status, 401, 'dashboard cookie must not authorize operational APIs');
  });
});

test('unauthenticated dashboard logout cannot consume audit capacity', async () => {
  const auditEvents = [];
  await withGateway(async (port) => {
    const response = await request(port, { method: 'POST', path: '/dashboard/logout' });
    assert.equal(response.status, 303);
    assert.equal(auditEvents.length, 0);
  }, {
    audit: {
      async start(event) { auditEvents.push(event); return { id: 'must-not-exist' }; },
      async append(event) { auditEvents.push(event); },
    },
  });
});

test('HTTP combines client cancellation with a durable quota lease signal', async () => {
  const leaseController = new AbortController();
  let entered;
  const handlerEntered = new Promise((resolve) => { entered = resolve; });
  let observedSignal;
  let releases = 0;
  const release = async () => { releases += 1; return false; };
  Object.defineProperty(release, 'signal', { value: leaseController.signal });

  await withGateway(async (port) => {
    const responsePromise = request(port, {
      method: 'POST',
      path: '/chat',
      headers: { authorization: `Bearer ${CALLER_A_CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'lease-loss', message: 'wait' }),
    });
    await handlerEntered;
    const lost = Object.assign(new Error('quota lease lost'), { code: 'QUOTA_LEASE_LOST', unknownOutcome: true });
    leaseController.abort(lost);
    const response = await responsePromise;
    assert.equal(response.status, 500);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason.code, 'QUOTA_LEASE_LOST');
    assert.equal(releases, 1);
  }, {
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
});

test('client correlation ids never enter execution context or cross-tenant idempotency keys', async () => {
  await withGateway(async (port, calls) => {
    for (const [credential, sessionId, message] of [
      [CALLER_A_CREDENTIAL, 'same', 'tenant-a-value'],
      [CALLER_B_CREDENTIAL, 'same', 'tenant-b-value'],
    ]) {
      const response = await request(port, {
        method: 'POST',
        path: '/chat',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-request-id': 'client-selected' },
        body: JSON.stringify({ sessionId, message }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
    assert.notEqual(calls[0].context.operationId, calls[1].context.operationId);
    assert.match(calls[0].context.requestId, /^[0-9a-f-]{36}$/);
    assert.match(calls[1].context.requestId, /^[0-9a-f-]{36}$/);
    assert.notEqual(calls[0].context.requestId, 'client-selected');
    assert.notEqual(calls[1].context.requestId, 'client-selected');
    assert.notEqual(calls[0].context.requestId, calls[1].context.requestId);
  });
});

test('HTTP observability templates unknown paths and discards caller-selected request ids', async () => {
  const events = [];
  const telemetry = createTelemetry({ enabled: true, sink: { export: async (event) => events.push(event) } });
  const pathCanary = 'ACME-PRIVATE-CUSTOMER-RECORD';
  const requestCanary = 'PRIVATE-CORRELATION-CANARY';
  await withGateway(async (port) => {
    const response = await request(port, {
      path: `/not-found/${pathCanary}`,
      headers: { authorization: `Bearer ${PLATFORM_CREDENTIAL}`, 'x-request-id': requestCanary },
    });
    assert.equal(response.status, 404);
    assert.notEqual(response.headers['x-request-id'], requestCanary);
    await telemetry.flush();
  }, { telemetry });
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, new RegExp(`${pathCanary}|${requestCanary}`));
  assert.match(serialized, /GET <unknown-route>/);
});

test('sensitive API and SSE responses are non-storable and nosniff', async () => {
  await withGateway(async (port) => {
    const status = await request(port, { path: '/status', headers: { authorization: `Bearer ${PLATFORM_CREDENTIAL}` } });
    assert.equal(status.status, 200);
    assert.match(status.headers['cache-control'], /private.*no-store/);
    assert.equal(status.headers['x-content-type-options'], 'nosniff');

    const stream = await request(port, {
      method: 'POST',
      path: '/chat/stream',
      headers: { authorization: `Bearer ${CALLER_A_CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cache-test', message: 'private reply' }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers['cache-control'], /private.*no-store/);
    assert.equal(stream.headers['x-content-type-options'], 'nosniff');
  });
});

test('unauthenticated slow request bodies are rejected and the socket is closed promptly', async () => {
  await withGateway(async (port, _calls, server) => {
    assert.equal(server.requestTimeout, 15_000);
    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.maxRequestsPerSocket, 0);
    const started = Date.now();
    const outcome = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let response = '';
      const guard = setTimeout(() => {
        socket.destroy();
        reject(new Error('unauthenticated slow-body socket stayed open'));
      }, 1_000);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write('POST /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000000\r\nConnection: keep-alive\r\n\r\n');
      });
      socket.on('data', (chunk) => { response += chunk; });
      socket.on('error', reject);
      socket.on('close', () => {
        clearTimeout(guard);
        resolve(response);
      });
    });
    assert.match(outcome, /HTTP\/1\.1 401/);
    assert.match(outcome, /Connection: close/i);
    assert.ok(Date.now() - started < 1_000);
  });
});

test('healthy keep-alive traffic does not receive a synthetic 503 after 100 requests', async () => {
  await withGateway(async (port, _calls, server) => {
    assert.equal(server.maxRequestsPerSocket, 0);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let index = 0; index < 130; index += 1) {
        const response = await request(port, { path: '/health', agent });
        assert.equal(response.status, 200, `request ${index + 1} must remain healthy`);
      }
    } finally {
      agent.destroy();
    }
  });
});

test('trusted Idempotency-Key binds principal, route and body while coalescing chat side effects', async () => {
  const idempotency = createIdempotencyStore();
  let sideEffects = 0;
  const operationIds = [];
  await withGateway(async (port) => {
    const headers = {
      authorization: `Bearer ${CALLER_A_CREDENTIAL}`,
      'content-type': 'application/json',
      'idempotency-key': 'chat-operation-1',
    };
    const body = JSON.stringify({ sessionId: 'same-session', message: 'same-message' });
    const [first, second] = await Promise.all([
      request(port, { method: 'POST', path: '/chat', headers, body }),
      request(port, { method: 'POST', path: '/chat', headers, body }),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(sideEffects, 1);
    assert.equal(operationIds.length, 1);
    assert.match(operationIds[0], /^http:[0-9a-f]{64}$/);
    assert.deepEqual(new Set([first.headers['idempotency-status'], second.headers['idempotency-status']]), new Set(['created', 'replayed']));
    assert.deepEqual(JSON.parse(first.text), JSON.parse(second.text));

    const conflict = await request(port, {
      method: 'POST',
      path: '/chat',
      headers,
      body: JSON.stringify({ sessionId: 'same-session', message: 'different-message' }),
    });
    assert.equal(conflict.status, 409);
    assert.match(conflict.text, /IDEMPOTENCY_REQUEST_CONFLICT/);
    assert.equal(sideEffects, 1);

    const otherPrincipal = await request(port, {
      method: 'POST',
      path: '/chat',
      headers: { ...headers, authorization: `Bearer ${CALLER_B_CREDENTIAL}` },
      body,
    });
    assert.equal(otherPrincipal.status, 200);
    assert.equal(sideEffects, 2, 'the same client key is independently scoped to the authenticated principal');
  }, {
    idempotency,
    handleMessage: async (_sessionId, message, context) => {
      sideEffects += 1;
      operationIds.push(context.operationId);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { text: `reply:${message}`, costUsd: 0.01 };
    },
  });
});

test('ambiguous idempotent chat failures become tombstones and are never replayed', async () => {
  const idempotency = createIdempotencyStore();
  let sideEffects = 0;
  await withGateway(async (port) => {
    const options = {
      method: 'POST',
      path: '/chat',
      headers: {
        authorization: `Bearer ${CALLER_A_CREDENTIAL}`,
        'content-type': 'application/json',
        'idempotency-key': 'chat-ambiguous-1',
      },
      body: JSON.stringify({ sessionId: 'ambiguous', message: 'submit' }),
    };
    const first = await request(port, options);
    const second = await request(port, options);
    assert.equal(first.status, 500);
    assert.equal(second.status, 409);
    assert.equal(sideEffects, 1);
    assert.equal((await idempotency.list()).items[0].status, 'unknown');
  }, {
    idempotency,
    handleMessage: async () => {
      sideEffects += 1;
      throw new Error('socket ended after provider accepted request');
    },
  });
});

test('manual jobs require Idempotency-Key and reuse a stable scheduler run id without duplicate effects', async () => {
  const idempotency = createIdempotencyStore();
  let effects = 0;
  const runIds = [];
  const scheduler = {
    adapterName: 'durable',
    capabilities: { durable: true },
    listJobs: () => [{ name: 'effectful' }, { name: 'other' }],
    async runNow(name, { runId } = {}) {
      effects += 1;
      runIds.push({ name, runId });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, result: { accepted: true } };
    },
  };
  await withGateway(async (port) => {
    const baseHeaders = { authorization: `Bearer ${PLATFORM_CREDENTIAL}` };
    assert.equal((await request(port, { method: 'POST', path: '/jobs/effectful/run', headers: baseHeaders })).status, 428);

    const headers = { ...baseHeaders, 'idempotency-key': 'manual-job-1' };
    const [first, second] = await Promise.all([
      request(port, { method: 'POST', path: '/jobs/effectful/run', headers }),
      request(port, { method: 'POST', path: '/jobs/effectful/run', headers }),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(effects, 1);
    assert.match(runIds[0].runId, /^manual:http:[0-9a-f]{64}$/);
    assert.deepEqual(new Set([first.headers['idempotency-status'], second.headers['idempotency-status']]), new Set(['created', 'replayed']));

    const conflict = await request(port, { method: 'POST', path: '/jobs/other/run', headers });
    assert.equal(conflict.status, 409);
    assert.equal(effects, 1);
  }, { idempotency, scheduler });
});

test('tenant operators cannot read or trigger gateway-wide operational state', async () => {
  await withGateway(async (port) => {
    const tenantHeaders = { authorization: `Bearer ${OPERATOR_CREDENTIAL}` };
    assert.equal((await request(port, { path: '/status', headers: tenantHeaders })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/jobs/patrol/run', headers: tenantHeaders })).status, 403);

    const platformHeaders = { authorization: `Bearer ${PLATFORM_CREDENTIAL}` };
    assert.equal((await request(port, { path: '/status', headers: platformHeaders })).status, 200);
    assert.equal((await request(port, { method: 'POST', path: '/jobs/patrol/run', headers: platformHeaders })).status, 404);
  });
});

test('execution reconciliation API is metadata-only, explicitly scoped and compare-and-swap protected', async () => {
  const idempotency = createIdempotencyStore({ maxRecords: 3 });
  const auditEvents = [];
  const privateResult = { receipt: 'CUSTOMER_RESULT_CANARY_RECON' };
  await idempotency.run('raw-private-operation-key', async () => privateResult);
  const expectedDigest = (await idempotency.get('raw-private-operation-key')).resultDigest;

  await withGateway(async (port) => {
    const noScope = await request(port, {
      path: '/idempotency/reconciliations',
      headers: { authorization: `Bearer ${PLATFORM_CREDENTIAL}` },
    });
    assert.equal(noScope.status, 403);
    const tenantScoped = await request(port, {
      path: '/idempotency/reconciliations',
      headers: { authorization: `Bearer ${TENANT_RECON_CREDENTIAL}` },
    });
    assert.equal(tenantScoped.status, 403);

    const headers = { authorization: `Bearer ${RECON_CREDENTIAL}` };
    const listing = await request(port, { path: '/idempotency/reconciliations?limit=10', headers });
    assert.equal(listing.status, 200);
    const listingBody = JSON.parse(listing.text);
    assert.equal(listingBody.items.length, 1);
    assert.match(listingBody.items[0].id, /^[0-9a-f]{64}$/);
    assert.equal(listingBody.items[0].status, 'committed');
    assert.equal(listingBody.items[0].resultDigest, expectedDigest);
    assert.deepEqual(listingBody.capacity, { used: 1, maxRecords: 3, available: 2 });
    assert.doesNotMatch(listing.text, /raw-private-operation-key|CUSTOMER_RESULT_CANARY_RECON|ownerId|"value"/);

    const id = listingBody.items[0].id;
    const conflict = await request(port, {
      method: 'POST',
      path: `/idempotency/reconciliations/${id}`,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        resolution: 'forget',
        expectedStatus: 'committed',
        expectedResultDigest: '0'.repeat(64),
        reason: 'synthetic conflict check',
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await idempotency.list()).items.length, 1);

    const reconciled = await request(port, {
      method: 'POST',
      path: `/idempotency/reconciliations/${id}`,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        resolution: 'forget',
        expectedStatus: 'committed',
        expectedResultDigest: expectedDigest,
        reason: 'synthetic operator decision',
      }),
    });
    assert.equal(reconciled.status, 200);
    assert.equal(JSON.parse(reconciled.text).changed, true);
    assert.equal((await idempotency.list()).items.length, 0);
    assert.equal(auditEvents.length, 3);
    assert.equal(auditEvents.filter((event) => event.outcome === 'started').length, 2);
    assert.doesNotMatch(JSON.stringify(auditEvents), /synthetic operator decision|CUSTOMER_RESULT_CANARY_RECON/);
  }, {
    idempotency,
    audit: { append: async (event) => { auditEvents.push(event); } },
  });
});

test('unknown execution can only be reopened with matching reconciliation evidence', async () => {
  const idempotency = createIdempotencyStore();
  const failure = Object.assign(new Error('private provider failure'), {
    code: 'TIMEOUT',
    unknownOutcome: true,
  });
  await assert.rejects(idempotency.run('unknown-operation-key', async () => { throw failure; }));
  const record = (await idempotency.list()).items[0];

  await withGateway(async (port) => {
    const headers = { authorization: `Bearer ${RECON_CREDENTIAL}`, 'content-type': 'application/json' };
    const response = await request(port, {
      method: 'POST',
      path: `/idempotency/reconciliations/${record.id}`,
      headers,
      body: JSON.stringify({
        resolution: 'retry',
        expectedStatus: 'unknown',
        expectedErrorCode: 'TIMEOUT',
        reason: 'external check proved no side effect',
      }),
    });
    assert.equal(response.status, 200);
  }, { idempotency });

  let calls = 0;
  const result = await idempotency.run('unknown-operation-key', async () => {
    calls += 1;
    return 'safe-after-reconciliation';
  });
  assert.equal(result.value, 'safe-after-reconciliation');
  assert.equal(calls, 1);
});
