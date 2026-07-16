import assert from 'node:assert/strict';
import test from 'node:test';
import { createPatrolJob } from '../src/agents/patrol.js';

function config(overrides = {}) {
  return {
    notifyWebhookUrl: undefined,
    patrol: { overdueDays: 7, minOnTimeRate: 0.9 },
    ...overrides,
  };
}

test('default patrol logging emits metadata only, not the business report', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const result = await createPatrolJob({ config: config() }).run();
    assert.ok(result.report.length > 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /digest=[0-9a-f]{64} bytes=\d+/);
    assert.equal(lines[0].includes(result.report), false);
    assert.doesNotMatch(lines[0], /invoice|supplier|delivery/i);
  } finally {
    console.log = original;
  }
});

test('ambiguous notification failures propagate without logging report or error detail', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  globalThis.fetch = async () => { throw new Error('PRIVATE-NETWORK-DETAIL'); };
  console.error = (line) => logs.push(String(line));
  try {
    const job = createPatrolJob({ config: config({ notifyWebhookUrl: 'https://notify.example/hook' }) });
    await assert.rejects(job.run(), (error) => error.code === 'PATROL_NOTIFY_UNKNOWN' && error.unknownOutcome === true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /reportDigest=[0-9a-f]{64}/);
    assert.doesNotMatch(logs[0], /PRIVATE-NETWORK-DETAIL|invoice|supplier|delivery/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('patrol forwards scheduler cancellation and a stable idempotency key to the webhook', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  let cancelled = 0;
  globalThis.fetch = async (_url, init) => {
    captured = init;
    return { ok: true, status: 202, body: { async cancel() { cancelled += 1; } } };
  };
  try {
    const controller = new AbortController();
    const job = createPatrolJob({ config: config({ notifyWebhookUrl: 'https://notify.example/hook' }) });
    assert.equal(job.idempotency, 'required');
    assert.equal(job.timeoutMs, 30_000);
    await job.run({ signal: controller.signal, idempotencyKey: 'scheduler:daily-patrol:stable-run' });
    assert.equal(captured.signal, controller.signal);
    assert.equal(captured.redirect, 'error');
    assert.equal(captured.headers.get('idempotency-key'), 'scheduler:daily-patrol:stable-run');
    assert.equal(captured.headers.get('content-type'), 'application/json');
    assert.equal(cancelled, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
