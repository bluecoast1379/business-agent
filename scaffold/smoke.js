/**
 * Internal smoke test - runs entirely in-process, opens NO port.
 * Checks (all against the deterministic mock provider):
 *   1. handleMessage one round returns text containing "[mock]"
 *      (tool loop: "top customers" triggers get_top_customers first);
 *   2. confirm-gate: unapproved calls never execute, human approval via the
 *      confirmation center does, ids are single-use and expire;
 *   3. same-session concurrency is serialized (no history loss);
 *   4. webhook signature: valid timestamped HMAC passes, stale/bad ones fail;
 *   5. scheduler fires a matching job on a single tick (+ hour defaults minute 0);
 *   6. cost tracker reports monthly cost > 0 (wired via agent loop).
 * Exit code 0 on success; non-zero with the failing step name otherwise.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.LLM_PROVIDER = 'mock';
process.env.GATEWAY_AUTH_TOKEN ??= 'smoke-local-token';

const { loadConfig } = await import('./src/config.js');
const { createProvider } = await import('./src/runtime/llm.js');
const { createCostTracker } = await import('./src/runtime/cost-tracker.js');
const { createSessionStore } = await import('./src/runtime/session-store.js');
const { createScheduler } = await import('./src/runtime/scheduler.js');
const { buildRegistry } = await import('./src/agents/registry.js');
const { createPrincipal } = await import('./src/auth/principal.js');
const { wrapWriteTool, createConfirmationCenter } = await import('./src/guardrails/confirm-gate.js');
const { withScope } = await import('./src/guardrails/scoped-tool.js');
const { defineTool, validateArgs } = await import('./src/runtime/tool.js');
const { verifySignature } = await import('./src/channels/webhook.js');
const { invoices, creditNotes } = await import('./src/toolpacks/demo/data.js');

const config = loadConfig();
const provider = createProvider(config);
const costTracker = createCostTracker();
const sessionStore = createSessionStore({ ttlMs: 60_000 });
const confirmations = createConfirmationCenter();
const registry = buildRegistry({ config, provider, costTracker, sessionStore, confirmations });
// The top-customer demo tool is intentionally platform-scoped. Exercise the
// tool loop under an explicit trusted operator identity instead of weakening
// the production authorization policy for a smoke test.
const platformOperator = createPrincipal({
  subjectId: 'smoke-platform-operator',
  tenantId: null,
  roles: ['operator'],
  scopes: ['tools:execute'],
  authType: 'internal-test',
});

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

step('mock handleMessage round-trip (tool loop + [mock] marker)', async () => {
  const r1 = await registry.handleMessage('smoke-1', 'show me the top customers', { principal: platformOperator });
  assert.ok(r1.text.includes('[mock] top customers:'), `expected "[mock] top customers:" in: ${r1.text}`);
  assert.ok(r1.text.includes('Top'), `expected tool summary first line in: ${r1.text}`);
  const r2 = await registry.handleMessage('smoke-2', 'hello there', { principal: platformOperator });
  assert.ok(r2.text.includes('[mock] echo: hello there'), `expected echo in: ${r2.text}`);
});

step('confirm-gate: model cannot self-approve; human approval executes; single-use', async () => {
  const tool = registry.tools.get('create_credit_note');
  assert.ok(tool, 'create_credit_note tool missing');
  const invoice = invoices[0];
  const args = { customerId: invoice.customerId, invoiceId: invoice.id, amountUsd: 1.5, reason: 'smoke test claim' };

  const first = await tool.handler(args);
  assert.equal(first.pendingConfirmation, true, 'first call must not execute');
  assert.ok(first.confirmationId, 'first call must return a confirmationId');
  assert.equal(first.humanApproval, 'required', 'first call must demand human approval');
  assert.ok(first.summary.includes(invoice.id), 'summary should mention the invoice');
  assert.equal(creditNotes.length, 0, 'no credit note may exist before confirmation');

  // Phase-2 id-only calls must pass the wrapped schema (agent-loop path).
  assert.equal(validateArgs(tool, { confirmationId: first.confirmationId }).ok, true, 'id-only phase-2 args must validate');

  // The model retrying with the id but WITHOUT human approval must be refused.
  const unapproved = await tool.handler({ confirmationId: first.confirmationId });
  assert.equal(unapproved.error, 'not_yet_approved', 'model must not be able to self-approve');
  assert.equal(creditNotes.length, 0, 'unapproved retry must not execute');

  // Out-of-band human approval (HTTP endpoint / REPL command call this).
  const approval = confirmations.approve(first.confirmationId);
  assert.equal(approval.ok, true, 'human approval must succeed');

  const second = await tool.handler({ confirmationId: first.confirmationId });
  assert.equal(second.ok, true, 'approved call must execute');
  assert.equal(creditNotes.length, 1, 'credit note must be created after approval');

  const replay = await tool.handler({ confirmationId: first.confirmationId });
  assert.equal(replay.error, 'unknown_or_expired', 'confirmation ids must be single-use');

  // First-phase schema enforcement lives in the handler (wrapped required=[]).
  const badArgs = await tool.handler({ customerId: invoice.customerId });
  assert.equal(badArgs.error, 'invalid_arguments', 'first phase must enforce the original schema');
});

step('confirm-gate entry expiry', async () => {
  let executed = 0;
  const center = createConfirmationCenter({ ttlMs: 10 });
  const gated = wrapWriteTool(
    defineTool({
      name: 'noop_write',
      description: 'test',
      params: { properties: { a: { type: 'number' } }, required: ['a'] },
      handler: () => { executed += 1; return { ok: true }; },
    }),
    { center, summarize: ({ a }) => `Set smoke value to ${a}` },
  );
  const pendingResult = await gated.handler({ a: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(center.approve(pendingResult.confirmationId).ok, false, 'expired entries cannot be approved');
  const expired = await gated.handler({ confirmationId: pendingResult.confirmationId });
  assert.equal(expired.error, 'unknown_or_expired', 'expired id must be rejected');
  assert.equal(executed, 0, 'handler must never run on an expired id');
});

step('same-session concurrent requests are serialized (no history loss)', async () => {
  const [a, b] = await Promise.all([
    registry.handleMessage('smoke-concurrent', 'hello one', { principal: platformOperator }),
    registry.handleMessage('smoke-concurrent', 'hello two', { principal: platformOperator }),
  ]);
  assert.ok(a.text.includes('[mock]') && b.text.includes('[mock]'), 'both replies must arrive');
  const session = sessionStore.getOrCreate('smoke-concurrent');
  const userTurns = session.messages.filter((m) => m.role === 'user').length;
  assert.equal(userTurns, 2, `history must keep BOTH user turns, got ${userTurns}`);
});

step('webhook signature: timestamped HMAC passes; stale/bad ones fail', async () => {
  const secret = 'smoke-sample-secret'; // "sample" keeps the sanitizer's placeholder allowlist happy
  const body = JSON.stringify({ message: 'ping' });
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  assert.equal(verifySignature({ payload: body, signature: sig, timestamp: ts, secret, now }), true, 'fresh signed request must pass');
  assert.equal(verifySignature({ payload: body, signature: sig, timestamp: ts, secret: 'other' }), false, 'wrong secret must fail');
  const staleTs = String(Math.floor(now / 1000) - 3600);
  const staleSig = `sha256=${createHmac('sha256', secret).update(`${staleTs}.${body}`).digest('hex')}`;
  assert.equal(verifySignature({ payload: body, signature: staleSig, timestamp: staleTs, secret, now }), false, 'stale timestamp must fail (replay window)');
  assert.equal(verifySignature({ payload: body, signature: sig, secret, now }), false, 'missing timestamp must fail');
});

step('scoped tool forces scope over caller args', async () => {
  const probe = defineTool({
    name: 'probe',
    description: 'test',
    params: { properties: { customerId: { type: 'string' } }, required: ['customerId'] },
    handler: (args) => args.customerId,
  });
  const bound = withScope(probe, { customerId: 'cus-001' });
  assert.equal(await bound.handler({ customerId: 'cus-999' }), 'cus-001', 'scope must override caller args');
  assert.ok(!('customerId' in bound.params.properties), 'scoped key must be hidden from the schema');
});

step('scheduler single tick fires a matching job', async () => {
  const scheduler = createScheduler({ logger: { log() {}, warn() {}, error() {} } });
  let ran = 0;
  const now = new Date();
  scheduler.registerJob({
    name: 'tick-test',
    schedule: { minute: now.getMinutes(), hour: now.getHours() },
    run: async () => { ran += 1; return 'ok'; },
  });
  await scheduler.tick(now);
  assert.equal(ran, 1, 'job matching the tick time must run exactly once');
  const manual = await scheduler.runNow('tick-test');
  assert.equal(manual.ok, true, 'runNow must work');
  assert.equal(await scheduler.runNow('nope'), null, 'unknown job must return null');

  // "hour without minute" must default to minute 0, not fire every minute.
  let hourly = 0;
  scheduler.registerJob({ name: 'hour-default', schedule: { hour: 8 }, run: async () => { hourly += 1; } });
  await scheduler.tick(new Date(2026, 0, 1, 8, 30));
  assert.equal(hourly, 0, 'hour-only schedule must NOT fire at 08:30');
  await scheduler.tick(new Date(2026, 0, 1, 8, 0));
  assert.equal(hourly, 1, 'hour-only schedule must fire at 08:00');
});

step('cost tracker wired: monthly cost > 0', async () => {
  const cost = costTracker.getMonthlyCost();
  assert.ok(cost > 0, `expected monthly cost > 0, got ${cost}`);
  const summary = costTracker.summary();
  assert.ok(summary.calls >= 3, `expected >=3 tracked calls, got ${summary.calls}`);
});

let failed = false;
for (const { name, fn } of steps) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    break;
  }
}

sessionStore.close();
if (failed) process.exit(1);
console.log('smoke: all checks passed');
process.exit(0);
