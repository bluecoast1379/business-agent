import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportReviewedTraces, loadEvalCases, runEvalSuite, validateEvalThresholds } from '../src/evals/index.js';

test('eval runner enforces aggregate and critical-slice thresholds', async () => {
  const cases = [
    { schemaVersion: '1.0', id: 'case.safe', slice: 'safety', input: 'x', expected: { contains: ['safe'], notContains: ['SECRET'] } },
    { schemaVersion: '1.0', id: 'case.tool', slice: 'tool', input: 'y', expected: { exact: 'tool ok' } },
  ];
  const report = await runEvalSuite({ cases, thresholds: { passRateMin: 1, safetyPassRateMin: 1, slicePassRateMin: { safety: 1, tool: 1 } }, execute: async (item) => ({ text: item.id === 'case.safe' ? 'safe' : 'tool ok', costUsd: 0 }) });
  assert.equal(report.passed, true);
  const mutation = await runEvalSuite({ cases, thresholds: { passRateMin: 1, safetyPassRateMin: 1 }, execute: async () => ({ text: 'SECRET', costUsd: 0 }) });
  assert.equal(mutation.passed, false);
  assert.ok(mutation.summary.passRate < 1);
});

test('JSONL loader rejects duplicate IDs and malformed cases', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'business-agent-evals-'));
  const file = path.join(dir, 'cases.jsonl');
  const item = JSON.stringify({ schemaVersion: '1.0', id: 'case.one', input: 'hello', expected: { contains: ['ok'] } });
  await writeFile(file, `${item}\n${item}\n`);
  await assert.rejects(loadEvalCases(file), /duplicate case id/);

  await writeFile(file, `${JSON.stringify({ schemaVersion: '1.0', id: 'case.bad', input: 'hello', expected: {}, ignored: true })}\n`);
  await assert.rejects(loadEvalCases(file), /unknown field ignored|effective assertion/);
});

test('invalid thresholds and negative or non-finite reported costs fail closed', async () => {
  assert.throws(() => validateEvalThresholds({ passRateMin: -1 }), /between 0 and 1/);
  assert.throws(() => validateEvalThresholds({ maxAverageCostUsd: Number.POSITIVE_INFINITY }), /finite non-negative/);
  assert.throws(() => validateEvalThresholds({ unknownGate: 0 }), /unknown threshold field/);
  const cases = [{ schemaVersion: '1.0', id: 'case.cost', input: 'x', expected: { exact: 'ok', maxCostUsd: 1 } }];
  const report = await runEvalSuite({ cases, thresholds: { passRateMin: 1 }, execute: async () => ({ text: 'ok', costUsd: -10 }) });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].assertions.find((item) => item.name === 'costUsdValid').passed, false);
});

test('required safety cases and empty safety suites fail closed on execution errors', async () => {
  const required = [{
    schemaVersion: '1.0',
    id: 'case.required-safety',
    input: 'x',
    expected: { exact: 'ok', safety: 'required' },
  }];
  const failed = await runEvalSuite({
    cases: required,
    thresholds: { passRateMin: 0, safetyPassRateMin: 1 },
    execute: async () => { throw Object.assign(new Error('synthetic provider failure'), { code: 'PROVIDER_DOWN' }); },
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.summary.safetyTotal, 1);
  assert.equal(failed.summary.safetyPassRate, 0);
  assert.equal(failed.results[0].assertions[0].safety, true);

  const noSafetyCases = [{
    schemaVersion: '1.0',
    id: 'case.no-safety',
    input: 'x',
    expected: { exact: 'ok' },
  }];
  const skipped = await runEvalSuite({
    cases: noSafetyCases,
    thresholds: { passRateMin: 0, safetyPassRateMin: 1 },
    execute: async () => ({ text: 'ok', costUsd: 0 }),
  });
  assert.equal(skipped.passed, false);
  assert.equal(skipped.summary.safetyTotal, 0);
  assert.equal(skipped.summary.safetyPassRate, 0);
});

test('trace-to-dataset export requires human review and redacts metadata', () => {
  assert.throws(() => exportReviewedTraces([{ traceId: 't1' }]), /explicit reviewer/);
  const [item] = exportReviewedTraces([{ traceId: 't1', metadata: { prompt: 'CANARY', durationMs: 1 } }], { reviewed: true, reviewer: 'security-reviewer' });
  assert.equal(item.input, '[REDACTED_REVIEW_REQUIRED]');
  assert.doesNotMatch(JSON.stringify(item), /CANARY/);
});
