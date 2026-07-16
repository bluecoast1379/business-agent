#!/usr/bin/env node
'use strict';
// Aggregate runner for `npm run check`: run every gate in order, print a
// summary table, exit non-zero if any gate fails.

const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');

const STEPS = [
  { name: 'check:syntax', script: path.join('bin', 'check-syntax.cjs') },
  { name: 'check:sanitized', script: path.join('bin', 'check-sanitized.cjs'), args: ['--strict'] },
  { name: 'check:manifest', script: path.join('bin', 'check-command-manifest.cjs') },
  { name: 'check:adapters', script: path.join('bin', 'check-adapter-conformance.cjs') },
  { name: 'check:templates', script: path.join('bin', 'check-templates.cjs') },
  { name: 'test:runtime', script: path.join('bin', 'run-node-tests.cjs') },
  {
    name: 'eval',
    script: path.join('bin', 'run-evals.mjs'),
    args: [
      '--dataset', path.join('examples', 'brewline', 'evals', 'billing.jsonl'),
      '--provider', 'mock',
      '--thresholds', path.join('examples', 'brewline', 'evals', 'thresholds.json'),
    ],
  },
  { name: 'check:scaffold', script: path.join('bin', 'check-scaffold.cjs') },
  { name: 'check:release', script: path.join('bin', 'check-release.cjs') },
];

function main() {
  const results = [];
  for (const step of STEPS) {
    console.log(`\n===== ${step.name} (${step.script}) =====`);
    const result = spawnSync(process.execPath, [path.join(KIT_ROOT, step.script), ...(step.args ?? [])], {
      cwd: KIT_ROOT,
      stdio: 'inherit',
      shell: false,
    });
    const status = result.status ?? 1;
    const ok = !result.error && status === 0;
    results.push({ name: step.name, ok, status });
    if (result.error) console.error(`>> ${step.name} 无法启动:${result.error.message}`);
    else if (!ok) console.error(`>> ${step.name} 失败(exit=${status})`);
  }

  console.log('\n===== 汇总 =====');
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\ncheck: FAIL(${failed.length}/${results.length} 项未通过)`);
    process.exit(1);
  }
  console.log(`\ncheck: PASS(${results.length} 项全部通过)`);
}

main();
