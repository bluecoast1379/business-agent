import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  DASHBOARD_MAX_PAGE_SIZE,
  createDashboardReadModelProvider,
  handleDashboardRequest,
} from '../src/dashboard/index.js';

const ALL_CAPABILITIES = [
  'dashboard:view',
  'runs:view',
  'costs:view',
  'evals:view',
  'approvals:view',
  'audit:view',
  'system:view',
];

const OPERATOR = Object.freeze({ role: 'operator', capabilities: ALL_CAPABILITIES });

function fakeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
}

async function request(path, {
  method = 'GET',
  principal = OPERATOR,
  provider,
  ...context
} = {}) {
  const req = { method, url: path, headers: {} };
  const res = fakeResponse();
  const handled = await handleDashboardRequest(req, res, {
    principal,
    readModelProvider: provider,
    environment: 'test',
    telemetryEnabled: false,
    now: () => Date.parse('2026-07-15T00:00:00.000Z'),
    correlationId: 'dashboard-test-correlation',
    ...context,
  });
  return { handled, req, res };
}

function json(result) {
  return JSON.parse(result.res.body);
}

function rawProvider(read) {
  return { read };
}

test('integration hook ignores non-dashboard routes', async () => {
  const result = await request('/health');
  assert.equal(result.handled, false);
  assert.equal(result.res.statusCode, null);
});

test('all HTML routes expose semantic, read-only landmarks without embedding detail ids', async () => {
  const pages = [
    ['/dashboard', 'Overview'],
    ['/dashboard/runs', 'Runs'],
    ['/dashboard/runs/public-run-123', 'Run Detail'],
    ['/dashboard/costs', 'Costs'],
    ['/dashboard/evals', 'Evals'],
    ['/dashboard/evals/public-eval-123', 'Eval Detail'],
    ['/dashboard/approvals', 'Approvals'],
    ['/dashboard/audit', 'Audit'],
    ['/dashboard/system', 'System'],
  ];

  for (const [path, title] of pages) {
    const { res } = await request(path);
    assert.equal(res.statusCode, 200, path);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(res.body, /<header class="topbar">/);
    assert.match(res.body, /<nav class="side-nav" aria-label="Dashboard navigation">/);
    assert.match(res.body, /<main id="main-content" tabindex="-1">/);
    assert.match(res.body, new RegExp(`<h1>${title}</h1>`));
    assert.match(res.body, /class="skip-link"/);
    assert.match(res.body, /READ ONLY/);
    assert.match(res.body, /Telemetry OFF/);
    assert.match(res.body, /data-state="loading"/);
    assert.match(res.body, /aria-live="polite"/);
    assert.doesNotMatch(res.body, /https?:\/\//);
  }

  const detail = await request('/dashboard/runs/public-run-123');
  assert.doesNotMatch(detail.res.body, /public-run-123/);
  assert.match(detail.res.body, /data-resource="run"/);
});

test('server RBAC and capabilities allow only operator, admin and auditor', async () => {
  for (const role of ['operator', 'admin', 'auditor']) {
    const { res } = await request('/dashboard', { principal: { role, capabilities: ['dashboard:view'] } });
    assert.equal(res.statusCode, 200, role);
  }

  const caller = await request('/dashboard', {
    principal: { role: 'caller', capabilities: ['*'] },
  });
  assert.equal(caller.res.statusCode, 403);
  assert.doesNotMatch(caller.res.body, /Runs|Costs|Approvals/);

  const missingRole = await request('/dashboard', {
    principal: { capabilities: ['dashboard:view'] },
  });
  assert.equal(missingRole.res.statusCode, 403);

  const unauthenticated = await request('/dashboard', { principal: null });
  assert.equal(unauthenticated.res.statusCode, 401);

  const missingCapability = await request('/dashboard/runs', {
    principal: { role: 'operator', capabilities: ['dashboard:view'] },
  });
  assert.equal(missingCapability.res.statusCode, 403);

  const wildcard = await request('/dashboard/audit', {
    principal: { role: 'auditor', capabilities: ['dashboard:*'] },
  });
  assert.equal(wildcard.res.statusCode, 200);

  const authPrincipalShape = await request('/dashboard/runs', {
    principal: {
      subjectId: 'operator-a',
      tenantId: 'tenant-a',
      roles: ['operator'],
      scopes: ['dashboard:read', 'runs:read'],
    },
  });
  assert.equal(authPrincipalShape.res.statusCode, 200);
  assert.match(authPrincipalShape.res.body, /href="\/dashboard\/runs" aria-current="page"/);
});

test('authorization happens before provider reads and an additional policy can only deny', async () => {
  let calls = 0;
  const provider = rawProvider(async () => {
    calls += 1;
    return { items: [] };
  });
  const denied = await request('/api/dashboard/runs', {
    principal: { role: 'caller', capabilities: ['*'] },
    provider,
  });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(calls, 0);

  const policyDenied = await request('/api/dashboard/runs', {
    provider,
    authorizeDashboard: async () => false,
  });
  assert.equal(policyDenied.res.statusCode, 403);
  assert.equal(calls, 0);
});

test('Dashboard namespace has no mutation route and never invokes its provider for writes', async () => {
  let calls = 0;
  const provider = rawProvider(async () => {
    calls += 1;
    return { items: [] };
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/dashboard', '/api/dashboard/runs', '/api/dashboard/approvals/approve']) {
      const { res } = await request(path, { method, provider });
      assert.equal(res.statusCode, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, 'GET, HEAD');
      assert.match(res.body, /DASHBOARD_READ_ONLY/);
    }
  }
  assert.equal(calls, 0);
});

test('HEAD follows the read route but returns no response body', async () => {
  const html = await request('/dashboard', { method: 'HEAD' });
  assert.equal(html.res.statusCode, 200);
  assert.equal(html.res.body, '');
  assert.ok(Number(html.res.headers['content-length']) > 0);

  const api = await request('/api/dashboard/runs', {
    method: 'HEAD',
    provider: rawProvider(async () => [{ id: 'run-1', name: 'Safe run', status: 'SUCCEEDED' }]),
  });
  assert.equal(api.res.statusCode, 200);
  assert.equal(api.res.body, '');
  assert.ok(Number(api.res.headers['content-length']) > 0);
});

test('cursor pagination clamps page size, binds cursors to resources and rejects unsafe queries', async () => {
  const provider = rawProvider(async ({ resource, pagination }) => {
    assert.equal(resource, 'runs');
    assert.ok(pagination.limit <= DASHBOARD_MAX_PAGE_SIZE);
    return {
      data: {
        items: Array.from({ length: 1_000 }, (_, index) => ({
          id: `run-${String(index).padStart(4, '0')}`,
          name: `Synthetic run ${index}`,
          status: index % 2 ? 'SUCCEEDED' : 'FAILED',
        })),
      },
      meta: {
        source: 'synthetic-runs',
        availability: 'available',
        freshness: 'current',
        asOf: '2026-07-15T00:00:00.000Z',
      },
    };
  });

  const first = await request('/api/dashboard/runs?limit=500', { provider });
  assert.equal(first.res.statusCode, 200);
  const firstBody = json(first);
  assert.equal(firstBody.data.items.length, 100);
  assert.equal(firstBody.meta.page.limit, 100);
  assert.equal(firstBody.meta.page.total, 1_000);
  assert.equal(firstBody.meta.page.hasMore, true);
  assert.ok(firstBody.meta.page.nextCursor);

  const next = await request(`/api/dashboard/runs?limit=100&cursor=${firstBody.meta.page.nextCursor}`, { provider });
  const nextBody = json(next);
  assert.equal(nextBody.data.items.length, 100);
  assert.notEqual(nextBody.data.items[0].id, firstBody.data.items[0].id);
  assert.equal(nextBody.meta.page.hasPrevious, true);
  assert.ok(nextBody.meta.page.previousCursor);

  for (const path of [
    '/api/dashboard/runs?limit=0',
    '/api/dashboard/runs?limit=abc',
    '/api/dashboard/runs?limit=2&limit=3',
    '/api/dashboard/runs?cursor=not-a-valid-payload',
    '/api/dashboard/runs?prompt=private',
    `/api/dashboard/costs?cursor=${firstBody.meta.page.nextCursor}`,
  ]) {
    const result = await request(path, { provider });
    assert.equal(result.res.statusCode, 400, path);
  }

  const unsafeHtmlQuery = await request('/dashboard/runs?prompt=private');
  assert.equal(unsafeHtmlQuery.res.statusCode, 400);
});

test('strict server projection excludes prompt, secrets, messages, tool arguments and results', async () => {
  const canaries = {
    prompt: 'PROMPT_CANARY_7YQ9Z',
    secret: ['SECRET', 'CANARY', '2K8WX'].join('_'),
    message: 'MESSAGE_CANARY_4J3LM',
    args: 'TOOL_ARGS_CANARY_6P1NV',
    result: 'TOOL_RESULT_CANARY_9R5BC',
    bearer: 'Bearer synthetic-super-secret-token',
  };
  const provider = rawProvider(async ({ resource }) => {
    const meta = {
      source: 'synthetic-canary-source',
      availability: 'available',
      freshness: 'current',
      asOf: '2026-07-15T00:00:00.000Z',
    };
    const common = {
      id: 'public-run-123',
      name: `Safe name ${canaries.prompt}`,
      status: 'FAILED',
      prompt: canaries.prompt,
      message: canaries.message,
      secret: canaries.secret,
      authorization: canaries.bearer,
      args: { customer: canaries.args },
      result: { value: canaries.result },
      stack: `Error: ${canaries.secret}`,
    };
    if (resource === 'runs') return { data: { items: [common] }, meta };
    if (resource === 'run') return {
      data: {
        ...common,
        nodes: [{ ...common, id: 'node-public', type: 'tool', toolName: 'safe_tool' }],
        timeline: [{ ...common, id: 'event-public', type: 'tool', redactedSummary: 'Details redacted' }],
      },
      meta,
    };
    if (resource === 'costs') return { data: { summary: { costUsd: 1.25 }, items: [{ label: 'safe', costUsd: 1.25, payload: canaries.result }] }, meta };
    if (resource === 'evals') return { data: { items: [{ ...common, id: 'eval-public', suite: 'safe suite', automaticStatus: 'NOT_RUN' }] }, meta };
    if (resource === 'eval') return { data: { ...common, id: 'eval-public', suite: 'safe suite', criteria: [{ ...common, id: 'criterion-public', automaticStatus: 'STALE' }] }, meta };
    if (resource === 'approvals') return { data: { items: [{ ...common, id: 'approval-private-id', toolName: 'safe_tool', summary: canaries.args, redactedSummary: 'Details redacted' }] }, meta };
    if (resource === 'audit') return { data: { items: [{ ...common, id: 'audit-private-id', actor: 'operator-private', tenant: 'tenant-private', metadata: canaries.result, integrity: 'UNVERIFIED' }] }, meta };
    if (resource === 'system') return { data: { environment: 'test', providerLabel: 'safe provider', apiKey: canaries.secret, telemetry: 'off' }, meta };
    return { data: { overallStatus: 'UNKNOWN', limitations: [canaries.prompt] }, meta };
  });

  const paths = [
    '/api/dashboard/overview',
    '/api/dashboard/runs',
    '/api/dashboard/runs/public-run-123',
    '/api/dashboard/costs',
    '/api/dashboard/evals',
    '/api/dashboard/evals/eval-public',
    '/api/dashboard/approvals',
    '/api/dashboard/audit',
    '/api/dashboard/system',
  ];
  for (const path of paths) {
    const result = await request(path, { provider });
    assert.equal(result.res.statusCode, 200, path);
    for (const value of Object.values(canaries)) {
      assert.equal(result.res.body.includes(value), false, `${path} leaked ${value}`);
    }
    assert.doesNotMatch(result.res.body, /"(?:prompt|message|secret|authorization|args|result|stack)"\s*:/i);
  }

  const approvals = json(await request('/api/dashboard/approvals', { provider }));
  assert.match(approvals.data.items[0].id, /^••••••/);
  assert.equal(approvals.data.items[0].summary, 'Details redacted');
  assert.deepEqual(approvals.data.items[0].redaction, {
    redacted: true,
    reason: 'tool_arguments_not_returned',
  });
});

test('provider failures return a safe recoverable envelope without stack or error canary', async () => {
  const provider = rawProvider(async () => {
    throw new Error('SECRET_CANARY_PROVIDER_FAILURE at /private/unsafe/path');
  });
  const result = await request('/api/dashboard/runs', { provider });
  assert.equal(result.res.statusCode, 503);
  assert.match(result.res.body, /DASHBOARD_SOURCE_UNAVAILABLE/);
  assert.match(result.res.body, /"recoverable":true/);
  assert.doesNotMatch(result.res.body, /SECRET_CANARY|private\/unsafe|Error:/);
});

test('read model expresses telemetry off, empty, stale and partial states explicitly', async () => {
  const offProvider = createDashboardReadModelProvider({
    telemetryEnabled: false,
    environment: 'test',
    now: () => Date.parse('2026-07-15T00:00:00.000Z'),
  });
  const off = await request('/api/dashboard/runs', { provider: offProvider });
  assert.equal(off.res.statusCode, 200);
  assert.equal(json(off).meta.telemetry, 'off');
  assert.equal(json(off).meta.availability, 'disabled');
  assert.deepEqual(json(off).data.items, []);

  const staleProvider = rawProvider(async () => ({
    data: { items: [] },
    meta: {
      availability: 'partial',
      freshness: 'current',
      asOf: '2026-07-14T23:00:00.000Z',
      telemetry: 'on',
      source: 'synthetic-stale',
    },
  }));
  const stale = await request('/api/dashboard/runs', {
    provider: staleProvider,
    telemetryEnabled: true,
    staleAfterMs: 60_000,
  });
  assert.equal(json(stale).meta.availability, 'partial');
  assert.equal(json(stale).meta.freshness, 'stale');
  assert.equal(json(stale).meta.telemetry, 'on');

  const forcedOff = await request('/api/dashboard/runs', {
    provider: rawProvider(async () => ({
      data: { items: [] },
      meta: { availability: 'available', freshness: 'current', telemetry: 'on' },
    })),
    telemetryEnabled: false,
  });
  assert.equal(json(forcedOff).meta.telemetry, 'off', 'provider metadata cannot override the effective off policy');
});

test('unknown numerics remain N/A and audit VERIFIED requires algorithm plus anchor', async () => {
  const costs = await request('/api/dashboard/costs', {
    provider: rawProvider(async () => ({
      data: {
        summary: { costUsd: null, budgetUsd: '', calls: null, inputTokens: '', outputTokens: undefined },
        items: [{ label: 'Unknown bucket', costUsd: null, calls: '', inputTokens: null, outputTokens: '' }],
      },
      meta: { availability: 'available', freshness: 'unknown' },
    })),
  });
  const costBody = json(costs);
  assert.equal(costBody.data.summary.costUsd, null);
  assert.equal(costBody.data.summary.budgetUsd, null);
  assert.equal(costBody.data.summary.calls, null);
  assert.equal(costBody.data.summary.inputTokens, null);
  assert.equal(costBody.data.items[0].costUsd, null);
  assert.equal(costBody.data.items[0].calls, null);

  const audit = await request('/api/dashboard/audit', {
    provider: rawProvider(async () => ({
      data: {
        items: [
          { id: 'audit-1', action: 'first', integrity: 'VERIFIED' },
          { id: 'audit-2', action: 'second', integrity: 'VERIFIED', algorithm: 'sha256-chain', anchor: 'anchor-private-123456' },
        ],
      },
      meta: { availability: 'available', freshness: 'current' },
    })),
  });
  const auditItems = json(audit).data.items;
  assert.equal(auditItems[0].integrity, 'UNVERIFIED');
  assert.equal(auditItems[0].algorithm, 'N/A');
  assert.equal(auditItems[0].anchor, 'N/A');
  assert.equal(auditItems[1].integrity, 'VERIFIED');
  assert.equal(auditItems[1].algorithm, 'sha256-chain');
  assert.match(auditItems[1].anchor, /^••••••/);
  assert.doesNotMatch(JSON.stringify(auditItems[1]), /anchor-private/);
});

test('provider integration supports source adapters and returns a redacted model directly', async () => {
  const provider = createDashboardReadModelProvider({
    sources: {
      runs: {
        async list() {
          return [{ id: 'run-private-001', name: 'Safe run', status: 'SUCCEEDED', prompt: 'PROMPT_CANARY_DIRECT' }];
        },
        async get(id) {
          if (id === 'missing-public-id') return null;
          return { id, name: 'Safe detail', status: 'SUCCEEDED', args: { hidden: 'TOOL_ARGS_CANARY_DIRECT' } };
        },
      },
    },
    telemetryEnabled: true,
    now: () => Date.parse('2026-07-15T00:00:00.000Z'),
  });
  const envelope = await provider.read({ resource: 'runs', pagination: { limit: 25, offset: 0 } });
  const text = JSON.stringify(envelope);
  assert.equal(envelope.data.items.length, 1);
  assert.match(envelope.data.items[0].id, /^••••••/);
  assert.doesNotMatch(text, /PROMPT_CANARY_DIRECT|"prompt"/);

  const missing = await request('/api/dashboard/runs/missing-public-id', { provider });
  assert.equal(missing.res.statusCode, 404);
  assert.equal(json(missing).data, null);
});

test('static assets implement progressive read-only UI, responsive layout and accessible states', async () => {
  const css = await request('/dashboard/assets/dashboard.css');
  assert.equal(css.res.statusCode, 200);
  assert.match(css.res.headers['content-type'], /^text\/css/);
  assert.match(css.res.body, /:focus-visible/);
  assert.match(css.res.body, /@media \(max-width: 639px\)/);
  assert.match(css.res.body, /@media \(forced-colors: active\)/);
  assert.match(css.res.body, /prefers-reduced-motion/);
  assert.match(css.res.body, /min-width: 320px/);
  assert.match(css.res.body, /td::before/);

  const script = await request('/dashboard/assets/dashboard.js');
  assert.equal(script.res.statusCode, 200);
  assert.match(script.res.headers['content-type'], /^text\/javascript/);
  assert.match(script.res.body, /method: 'GET'/);
  assert.match(script.res.body, /credentials: 'same-origin'/);
  assert.match(script.res.body, /textContent/);
  assert.match(script.res.body, /replaceChildren/);
  assert.match(script.res.body, /Telemetry OFF/);
  assert.match(script.res.body, /No run records/);
  assert.match(script.res.body, /Source error/);
  assert.match(script.res.body, /STALE data/);
  assert.match(script.res.body, /Schema mismatch/);
  assert.match(script.res.body, /data-dag-alternative/);
  assert.doesNotMatch(script.res.body, /localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(script.res.body, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(script.res.body, /https?:\/\//);
});

test('1,000-summary dashboard projection stays below the 250ms p95 budget', async () => {
  const items = Array.from({ length: 1_000 }, (_, index) => ({
    id: `private-run-${index}`,
    name: `Synthetic run ${index}`,
    status: index % 3 === 0 ? 'FAILED' : 'SUCCEEDED',
    durationMs: index,
    costUsd: index / 10_000,
  }));
  const provider = rawProvider(async () => ({
    data: { items },
    meta: {
      source: 'synthetic-performance-fixture',
      availability: 'available',
      freshness: 'current',
      asOf: '2026-07-15T00:00:00.000Z',
    },
  }));

  // Warm projection and JSON serialization before measuring. The route still
  // processes all 1,000 source summaries, then returns the bounded first page.
  for (let index = 0; index < 20; index += 1) {
    const warm = await request('/api/dashboard/runs?limit=100', { provider });
    assert.equal(warm.res.statusCode, 200);
  }
  const samples = [];
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    const result = await request('/api/dashboard/runs?limit=100', { provider });
    samples.push(performance.now() - startedAt);
    assert.equal(result.res.statusCode, 200);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.ok(p95Ms < 250, `dashboard projection p95 must be <250ms; observed ${p95Ms.toFixed(3)}ms`);
});
