import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runTemplateMatrix, validateTemplateMatrix } from '../bin/run-template-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'run-template-matrix.mjs');
const BUILTIN_TEMPLATES = path.join(ROOT, 'examples', 'templates');

async function cloneTemplates(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'business-agent-templates-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'templates');
  await cp(BUILTIN_TEMPLATES, target, { recursive: true });
  return { target, indexPath: path.join(target, 'index.json') };
}

test('built-in index validates exactly three deterministic versioned packs', async () => {
  const first = await validateTemplateMatrix();
  const second = await validateTemplateMatrix();
  assert.equal(first.passed, true);
  assert.equal(first.summary.total, 3);
  assert.deepEqual(first.templates.map((item) => item.id), ['customer-support', 'finance-ops', 'retail']);
  assert.deepEqual(first.templates.map((item) => item.sourceDigest), second.templates.map((item) => item.sourceDigest));
  for (const item of first.templates) {
    assert.equal(item.version, '1.0.0');
    assert.equal(item.toolCount, 3);
    assert.equal(item.evalCaseCount, 3);
    assert.deepEqual(item.slices, ['normal', 'safety', 'tool']);
  }
});

test('run matrix reuses deterministic eval runner and passes every exact threshold', async () => {
  const report = await runTemplateMatrix();
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { total: 3, validated: 3, evalPassed: 3 });
  for (const item of report.templates) {
    assert.equal(item.evaluation.passed, true);
    assert.equal(item.evaluation.summary.total, 3);
    assert.equal(item.evaluation.summary.passRate, 1);
    assert.equal(item.evaluation.summary.safetyPassRate, 1);
    assert.equal(item.evaluation.summary.averageCostUsd, 0);
  }
});

test('CLI supports validate and run selection without runtime integration', () => {
  const validate = spawnSync(process.execPath, [CLI, 'validate', '--template', 'retail'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(validate.status, 0, validate.stderr);
  const validationReport = JSON.parse(validate.stdout);
  assert.equal(validationReport.mode, 'validate');
  assert.deepEqual(validationReport.templates.map((item) => item.id), ['retail']);

  const run = spawnSync(process.execPath, [CLI, 'run', '--template', 'finance-ops'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const runReport = JSON.parse(run.stdout);
  assert.equal(runReport.mode, 'run');
  assert.equal(runReport.summary.evalPassed, 1);

  const unknown = spawnSync(process.execPath, [CLI, 'validate', '--template', 'missing-template'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown template/i);
});

test('matrix fails closed on path traversal and incomplete tool policy', async (t) => {
  const { target, indexPath } = await cloneTemplates(t);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.templates[0].path = '../customer-support/1.0.0';
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  await assert.rejects(validateTemplateMatrix({ indexPath }), /canonical version directory|escapes/i);

  index.templates[0].path = 'customer-support/1.0.0';
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const manifestPath = path.join(target, 'retail', '1.0.0', 'tool-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.tools[0].policy.approval;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(validateTemplateMatrix({ indexPath }), /approval/i);
});

test('matrix fails closed on unexpected files and eval threshold regressions', async (t) => {
  const { target, indexPath } = await cloneTemplates(t);
  const extra = path.join(target, 'finance-ops', '1.0.0', 'unreviewed.txt');
  await writeFile(extra, 'not part of the template contract\n');
  await assert.rejects(validateTemplateMatrix({ indexPath }), /unexpected file/i);
  await rm(extra);

  const evalPath = path.join(target, 'customer-support', '1.0.0', 'evals.jsonl');
  const lines = (await readFile(evalPath, 'utf8')).trim().split(/\r?\n/);
  const first = JSON.parse(lines[0]);
  first.mockOutput = 'mutated regression';
  lines[0] = JSON.stringify(first);
  await writeFile(evalPath, `${lines.join('\n')}\n`);
  const report = await runTemplateMatrix({ indexPath, templateId: 'customer-support' });
  assert.equal(report.passed, false);
  assert.equal(report.summary.evalPassed, 0);
  assert.ok(report.templates[0].evaluation.summary.passRate < 1);
});
