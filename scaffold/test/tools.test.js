import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrincipal } from '../src/auth/index.js';
import { createConfirmationCenter, wrapWriteTool } from '../src/guardrails/confirm-gate.js';
import { createExecutor } from '../src/runtime/execution/index.js';
import { buildToolInputSchema, defineTool, validateArgs } from '../src/runtime/tool.js';
import { createAuditLog } from '../src/observability/index.js';
import { REQUIRED_TOOL_POLICY_FIELDS, applyToolPolicies, createMcpTool, createOpenApiTool, createReadOnlyDbTool, createToolRegistry, runToolContract } from '../src/tools/index.js';

function policy(overrides = {}) {
  return {
    version: '1.0.0',
    audiences: ['operator', 'customer'],
    tenantScope: 'customer',
    dataClass: 'customer-profile',
    effect: 'read',
    approval: 'none',
    idempotency: 'none',
    timeoutMs: 1_000,
    audit: 'metadata',
    outputSchema: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string' } }, additionalProperties: false },
    ...overrides,
  };
}

test('every mandatory policy field fails closed when omitted', () => {
  const tool = defineTool({ name: 'profile', params: { properties: {}, required: [] }, handler: () => ({ customerId: 'x' }) });
  for (const field of REQUIRED_TOOL_POLICY_FIELDS) {
    const invalid = policy();
    delete invalid[field];
    assert.throws(() => applyToolPolicies([tool], { profile: invalid }), new RegExp(field, 'i'), field);
  }
  assert.throws(() => applyToolPolicies([tool], {}), /missing mandatory policy/);
  assert.throws(() => applyToolPolicies([tool], { profile: policy(), ghost: policy() }), /unknown tool/);
});

test('tool registry derives customer scope from principal and validates output', async () => {
  const tool = defineTool({
    name: 'profile', description: 'Profile',
    params: { properties: { customerId: { type: 'string' } }, required: [] },
    handler: ({ customerId }) => ({ customerId }),
  });
  const registry = createToolRegistry({ tools: [tool], manifest: { profile: policy() } });
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  assert.deepEqual(await registry.execute('profile', { customerId: 'tenant-b' }, { principal }), { customerId: 'tenant-a' });
  assert.equal(registry.listForPrincipal(principal).length, 1);

  const invalid = defineTool({ name: 'bad_output', handler: () => ({ wrong: true }) });
  const badRegistry = createToolRegistry({ tools: [invalid], manifest: { bad_output: policy() } });
  await assert.rejects(badRegistry.execute('bad_output', {}, { principal }), (error) => error.code === 'TOOL_OUTPUT_INVALID');
});

test('a full audit ledger blocks tool execution before any handler effect', async () => {
  let effects = 0;
  const tool = defineTool({
    name: 'profile',
    params: { properties: { customerId: { type: 'string' } }, required: [] },
    handler: ({ customerId }) => { effects += 1; return { customerId }; },
  });
  const audit = createAuditLog({ maxRecords: 1 });
  await audit.append({ action: 'seed', outcome: 'ok' });
  const registry = createToolRegistry({ tools: [tool], manifest: { profile: policy() }, audit });
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  await assert.rejects(
    registry.execute('profile', {}, { principal }),
    (error) => error.code === 'AUDIT_CAPACITY_EXHAUSTED' && error.statusCode === 503,
  );
  assert.equal(effects, 0);
  assert.equal((await audit.list()).length, 1);
});

test('tenant-scoped operators cannot discover or execute global tools without explicit elevation', async () => {
  const globalTool = defineTool({ name: 'global_read', handler: () => ({ scope: 'all-tenants' }) });
  const registry = createToolRegistry({
    tools: [globalTool],
    manifest: { global_read: policy({ audiences: ['operator'], tenantScope: 'global', outputSchema: {} }) },
  });
  const tenantOperator = createPrincipal({ subjectId: 'operator-a', tenantId: 'tenant-a', roles: ['operator'], scopes: ['tools:execute'] });
  assert.deepEqual(registry.listForPrincipal(tenantOperator), []);
  await assert.rejects(
    registry.execute('global_read', {}, { principal: tenantOperator }),
    (error) => error.code === 'TOOL_CROSS_TENANT_FORBIDDEN',
  );

  const platformOperator = createPrincipal({ subjectId: 'platform', tenantId: null, roles: ['operator'], scopes: ['tools:execute'] });
  assert.equal(registry.listForPrincipal(platformOperator).length, 1);
  assert.deepEqual(await registry.execute('global_read', {}, { principal: platformOperator }), { scope: 'all-tenants' });
});

test('write tools require human confirmation and idempotency', async () => {
  const raw = defineTool({ name: 'write_note', handler: async () => ({ customerId: 'tenant-a' }) });
  const writePolicy = policy({ effect: 'write', approval: 'human', idempotency: 'required', outputSchema: {} });
  assert.throws(() => applyToolPolicies([raw], { write_note: writePolicy }), /human confirmation gate/);
  const wrapped = wrapWriteTool(raw, { center: createConfirmationCenter() });
  const registry = createToolRegistry({ tools: [wrapped], manifest: { write_note: writePolicy }, executor: createExecutor() });
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  await assert.rejects(registry.execute('write_note', {}, { principal }), (error) => error.code === 'IDEMPOTENCY_REQUIRED');
  const pending = await registry.execute('write_note', {}, { principal, idempotencyKey: 'tenant-a:note-1' });
  assert.equal(pending.pendingConfirmation, true);
});

test('an approved confirmation can only be consumed by the tool that requested it', async () => {
  const center = createConfirmationCenter();
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  const valueParams = { properties: { value: { type: 'string' } }, required: ['value'] };
  const summarize = (args) => `Write a value with length ${args.value.length}`;
  const toolA = wrapWriteTool(defineTool({ name: 'write_a', params: valueParams, handler: async (args) => ({ tool: 'a', args }) }), { center, summarize });
  const toolB = wrapWriteTool(defineTool({ name: 'write_b', params: valueParams, handler: async (args) => ({ tool: 'b', args }) }), { center, summarize });
  const pending = await toolA.handler({ value: 'only-a' }, { principal });
  assert.equal((await center.approve(pending.confirmationId, { principal })).ok, true);

  const confused = await toolB.handler({ confirmationId: pending.confirmationId }, { principal });
  assert.equal(confused.error, 'tool_mismatch');
  const legitimate = await toolA.handler({ confirmationId: pending.confirmationId }, { principal });
  assert.deepEqual(legitimate, { tool: 'a', args: { value: 'only-a' } });
});

test('tool contract vectors validate inputs and outputs', async () => {
  const tool = applyToolPolicies([
    defineTool({ name: 'lookup', params: { properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] }, handler: () => ({ customerId: 'x' }) }),
  ], { lookup: policy() })[0];
  const report = await runToolContract({ tool, validInputs: [{ id: '1' }], invalidInputs: [{}], outputExamples: [{ customerId: 'tenant-a' }] });
  assert.equal(report.passed, true);
});

test('MCP, OpenAPI and read-only DB adapters propagate execution context to local fakes', async () => {
  const controller = new AbortController();
  const seen = {};
  const mcp = createMcpTool({ name: 'mcp_lookup', description: 'x', client: { callTool: async ({ arguments: args }, options) => { seen.mcp = options; return { customerId: args.customerId }; } } });
  assert.deepEqual(await mcp.handler({ customerId: 'a' }, { signal: controller.signal, idempotencyKey: 'idem-mcp' }), { customerId: 'a' });
  assert.equal(seen.mcp.signal, controller.signal);
  assert.equal(seen.mcp.idempotencyKey, 'idem-mcp');

  const openapi = createOpenApiTool({
    name: 'api_lookup', description: 'x', method: 'GET', url: 'https://api.example/lookup',
    fetchImpl: async (url, init) => { seen.openapi = init; return { ok: true, headers: { get: () => null }, async text() { return JSON.stringify({ customerId: url.searchParams.get('customerId') }); } }; },
  });
  assert.deepEqual(await openapi.handler({ customerId: 'b' }, { signal: controller.signal }), { customerId: 'b' });
  assert.equal(seen.openapi.signal, controller.signal);

  const db = createReadOnlyDbTool({ name: 'db_lookup', description: 'x', sql: 'SELECT id FROM customers WHERE id = :customerId', capabilities: { readOnlyTransactions: true }, query: async (sql, args, options) => { seen.db = options; return { sql, customerId: args.customerId }; } });
  assert.equal((await db.handler({ customerId: 'c' }, { signal: controller.signal })).customerId, 'c');
  assert.equal(seen.db.signal, controller.signal);
  assert.equal(seen.db.readOnly, true);
  assert.throws(() => createReadOnlyDbTool({ name: 'unsafe', sql: 'SELECT side_effect()', query: async () => [] }), /readOnlyTransactions/);
  assert.throws(() => createReadOnlyDbTool({ name: 'bad', sql: 'DELETE FROM customers', capabilities: { readOnlyTransactions: true }, query: async () => [] }), /read-only SELECT/);
});

test('OpenAPI write adapters propagate the idempotency key as a protected header', async () => {
  let init;
  const tool = createOpenApiTool({
    name: 'api_write',
    method: 'POST',
    url: 'https://api.example/write',
    headers: { 'Idempotency-Key': 'must-be-overridden', 'Content-Type': 'text/plain' },
    fetchImpl: async (_url, value) => { init = value; return { ok: true, headers: { get: () => null }, async text() { return '{"ok":true}'; } }; },
  });
  await tool.handler({ value: 1 }, { idempotencyKey: 'trusted-operation-key' });
  assert.equal(init.headers.get('idempotency-key'), 'trusted-operation-key');
  assert.equal(init.headers.get('content-type'), 'application/json');
});

test('OpenAPI adapters reject declared and chunked oversized JSON with effect-aware outcomes', async () => {
  let cancelled = 0;
  const declared = createOpenApiTool({
    name: 'declared_read',
    method: 'GET',
    url: 'https://api.example/read',
    maxResponseBytes: 64,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024) : null },
      body: { async cancel() { cancelled += 1; } },
    }),
  });
  await assert.rejects(
    declared.handler({}),
    (error) => error.code === 'RESPONSE_TOO_LARGE' && error.unknownOutcome === false,
  );
  assert.equal(cancelled, 1);

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"value":"'));
      controller.enqueue(Buffer.from('x'.repeat(100)));
      controller.enqueue(Buffer.from('"}'));
      controller.close();
    },
  });
  const write = createOpenApiTool({
    name: 'chunked_write',
    method: 'POST',
    url: 'https://api.example/write',
    maxResponseBytes: 64,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, body }),
  });
  await assert.rejects(
    write.handler({}, { idempotencyKey: 'stable-write' }),
    (error) => error.code === 'RESPONSE_TOO_LARGE'
      && error.unknownOutcome === true
      && error.reconciliationRequired === true,
  );
});

test('MCP result validation bounds bytes, depth and JSON shape before transcript use', async () => {
  const huge = createMcpTool({
    name: 'bounded_mcp',
    maxResultBytes: 64,
    client: { callTool: async () => ({ value: 'x'.repeat(128) }) },
  });
  await assert.rejects(
    huge.handler({}),
    (error) => error.code === 'TOOL_RESPONSE_TOO_LARGE'
      && error.unknownOutcome === true
      && error.reconciliationRequired === true,
  );

  const deep = createMcpTool({
    name: 'deep_mcp',
    maxResultDepth: 2,
    client: { callTool: async () => ({ a: { b: { c: true } } }) },
  });
  await assert.rejects(deep.handler({}), (error) => error.code === 'TOOL_RESPONSE_TOO_DEEP');
});

test('strict tool schemas reject undeclared fields before adapters run while trusted tenant scope is injected only when declared', async () => {
  let calls = 0;
  const strict = defineTool({
    name: 'strict_lookup',
    params: { properties: { id: { type: 'string' } }, required: ['id'] },
    handler: (args, context) => { calls += 1; return { id: args.id, tenant: context.principal.tenantId }; },
  });
  const registry = createToolRegistry({
    tools: [strict],
    manifest: { strict_lookup: policy({ outputSchema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } }, required: ['id', 'tenant'], additionalProperties: false } }) },
  });
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  await assert.rejects(
    registry.execute('strict_lookup', { id: '1', includeSecrets: true, admin: true }, { principal }),
    (error) => error.code === 'TOOL_INPUT_INVALID',
  );
  assert.equal(calls, 0);
  assert.deepEqual(await registry.execute('strict_lookup', { id: '1' }, { principal }), { id: '1', tenant: 'tenant-a' });
  assert.equal(calls, 1);
});

test('strict schemas reject prototype-pollution keys at every object depth', () => {
  const tool = defineTool({
    name: 'nested',
    params: {
      properties: {
        id: { type: 'string' },
        nested: { type: 'object', properties: { safe: { type: 'string' } } },
        rows: { type: 'array', items: { type: 'object', properties: { safe: { type: 'string' } } } },
      },
      required: ['id'],
    },
    handler: () => ({}),
  });
  for (const payload of [
    JSON.parse('{"id":"1","__proto__":{"admin":true}}'),
    JSON.parse('{"id":"1","constructor":{"prototype":{"admin":true}}}'),
    JSON.parse('{"id":"1","prototype":{"admin":true}}'),
    JSON.parse('{"id":"1","nested":{"safe":"x","__proto__":{"admin":true}}}'),
    JSON.parse('{"id":"1","rows":[{"safe":"x","constructor":{"admin":true}}]}'),
  ]) {
    const outcome = validateArgs(tool, payload);
    assert.equal(outcome.ok, false);
    assert.match(outcome.errors.join('; '), /__proto__|constructor|prototype/);
  }
  assert.throws(
    () => buildToolInputSchema({ properties: JSON.parse('{"__proto__":{"type":"string"}}') }),
    /schema property "__proto__" is forbidden/,
  );
});

test('tool registry treats an unclassified confirmed write failure as unknown and never replays it', async () => {
  const center = createConfirmationCenter();
  let sideEffects = 0;
  const raw = defineTool({
    name: 'ambiguous_write',
    params: { properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async () => { sideEffects += 1; throw new Error('socket closed after submit'); },
  });
  const wrapped = wrapWriteTool(raw, { center, summarize: (args) => `Write value length ${args.value.length}` });
  const registry = createToolRegistry({
    tools: [wrapped],
    manifest: { ambiguous_write: policy({ effect: 'write', approval: 'human', idempotency: 'required', outputSchema: {} }) },
    executor: createExecutor(),
  });
  const principal = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['tools:execute'] });
  const pending = await registry.execute('ambiguous_write', { value: 'synthetic' }, { principal, idempotencyKey: 'request-phase' });
  assert.equal((await center.approve(pending.confirmationId, { principal })).ok, true);
  const execute = () => registry.execute('ambiguous_write', { confirmationId: pending.confirmationId }, { principal, idempotencyKey: 'execute-phase' });
  await assert.rejects(execute(), (error) => error.unknownOutcome === true && error.reconciliationRequired === true);
  await assert.rejects(execute(), (error) => error.code === 'IDEMPOTENCY_UNKNOWN');
  assert.equal(sideEffects, 1);
});
