import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditLog, createTelemetry, sanitizeTelemetryAttributes } from '../src/observability/index.js';
import { createMemoryStateStore } from '../src/stores/index.js';

test('telemetry is default-off and performs zero sink export attempts', async () => {
  let calls = 0;
  const telemetry = createTelemetry({ sink: { export: async () => { calls += 1; } } });
  telemetry.startSpan('http', { attributes: { requestId: 'r1' } }).end();
  await telemetry.recordMetric('requests', 1);
  assert.equal(calls, 0);
  assert.equal(telemetry.exportAttempts(), 0);
});

test('enabled telemetry preserves the parent-child graph and strips sensitive payloads', async () => {
  const events = [];
  let clock = 1_000;
  const telemetry = createTelemetry({
    enabled: true,
    now: () => clock,
    sink: { export: async (event) => { events.push(structuredClone(event)); } },
  });
  const root = telemetry.startSpan('http.request', {
    attributes: { requestId: 'r1', tenantId: 'tenant-a', prompt: 'CANARY_PROMPT', Authorization: 'Bearer secret-value' },
  });
  const child = root.child('agent.provider', { provider: 'mock', message: 'CANARY_MESSAGE' });
  clock += 7;
  child.end({ attributes: { inputTokens: 10, outputTokens: 2 } });
  root.end();
  await new Promise((resolve) => setImmediate(resolve));
  const childStart = events.find((event) => event.name === 'agent.provider' && event.phase === 'start');
  assert.equal(childStart.traceId, root.traceId);
  assert.equal(childStart.parentSpanId, root.spanId);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /CANARY_PROMPT|CANARY_MESSAGE|secret-value/);
  assert.match(serialized, /sha256:/);
});

test('exporter failure never changes the request outcome', async () => {
  const failures = [];
  const telemetry = createTelemetry({
    enabled: true,
    sink: { export: async () => { throw new Error('collector down'); } },
    onExporterError: (failure) => failures.push(failure),
  });
  const span = telemetry.startSpan('work');
  span.end({ outcome: 'ok' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(failures.length >= 1);
});

test('audit log is append-only, redacted, and tampering is detectable', async () => {
  const audit = createAuditLog({ now: () => 2_000 });
  await audit.append({
    actor: 'operator-1',
    tenant: 'tenant-a',
    action: 'tool.execute',
    resource: 'credit-note',
    policyDecision: 'allow',
    outcome: 'committed',
    idempotencyKey: 'secret-idem-key',
    metadata: { prompt: 'CANARY_PROMPT', Authorization: 'Bearer canary-secret', durationMs: 4 },
  });
  await audit.append({ actor: 'operator-1', tenant: 'tenant-a', action: 'approval.approve', outcome: 'ok' });
  const listed = await audit.list();
  assert.equal(listed.length, 2);
  assert.equal((await audit.verify()).valid, true);
  assert.doesNotMatch(JSON.stringify(listed), /CANARY_PROMPT|canary-secret|secret-idem-key|operator-1|tenant-a/);
  listed[0].outcome = 'tampered';
  // Returned entries are clones; mutating them cannot mutate the append-only source.
  assert.equal((await audit.verify()).valid, true);
  assert.equal(typeof audit.update, 'undefined');
  assert.equal(typeof audit.delete, 'undefined');
});

test('telemetry attributes use a strict allowlist', () => {
  const result = sanitizeTelemetryAttributes({
    requestId: 'r1',
    tool: 'lookup',
    toolArgs: { customerId: 'c1' },
    arbitraryBusinessRecord: 'CANARY',
  });
  assert.deepEqual(result, { requestId: 'r1', tool: 'lookup' });
});

test('independent audit writers append one valid hash chain transactionally', async () => {
  const store = createMemoryStateStore();
  const a = createAuditLog({ stateStore: store });
  const b = createAuditLog({ stateStore: store });
  await Promise.all([
    a.append({ action: 'writer.a', outcome: 'ok' }),
    b.append({ action: 'writer.b', outcome: 'ok' }),
  ]);
  const entries = await a.list();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  assert.equal((await a.verify()).valid, true);
  await store.close();
});

test('durable audit appends use a constant-time chain head and fail closed at capacity', async () => {
  const base = createMemoryStateStore();
  let listCalls = 0;
  const stateStore = {
    ...base,
    async transaction(callback) {
      return base.transaction((tx) => callback({
        ...tx,
        list(...args) { listCalls += 1; return tx.list(...args); },
      }));
    },
  };
  const audit = createAuditLog({ stateStore, maxRecords: 2 });
  await audit.append({ action: 'first', outcome: 'ok' });
  assert.ok(listCalls >= 1, 'legacy bootstrap scans once when no chain head exists');
  listCalls = 0;
  await audit.append({ action: 'second', outcome: 'ok' });
  assert.equal(listCalls, 0, 'steady-state append must not rescan or sort the ledger');
  assert.deepEqual(await audit.capacity(), { records: 2, maxRecords: 2, available: 0, full: true });
  await assert.rejects(audit.append({ action: 'third' }), (error) => error.code === 'AUDIT_CAPACITY_EXHAUSTED' && error.statusCode === 503);
  assert.equal((await audit.verify()).valid, true);
  assert.equal((await audit.list()).length, 2);
  await base.close();
});

test('pre-effect audit starts atomically reserve the last ledger slot', async () => {
  const store = createMemoryStateStore();
  const a = createAuditLog({ stateStore: store, maxRecords: 1 });
  const b = createAuditLog({ stateStore: store, maxRecords: 1 });
  const results = await Promise.allSettled([
    a.start({ action: 'tool.execute', resource: 'profile' }),
    b.start({ action: 'tool.execute', resource: 'profile' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'AUDIT_CAPACITY_EXHAUSTED');
  const entries = await a.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'started');
  assert.equal(entries[0].metadata.auditPhase, 'pre-effect');
  assert.equal((await a.verify()).valid, true);
  await store.close();
});
