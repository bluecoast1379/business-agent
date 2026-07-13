#!/usr/bin/env node
'use strict';
// Aggregate runner for `npm run check`: run every gate in order, print a
// summary table, exit non-zero if any gate fails.

const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');

const STEPS = [
  { name: 'check:syntax', script: path.join('bin', 'check-syntax.cjs') },
  { name: 'check:sanitized', script: path.join('bin', 'check-sanitized.cjs') },
  { name: 'check:manifest', script: path.join('bin', 'check-command-manifest.cjs') },
  { name: 'check:scaffold', script: path.join('bin', 'check-scaffold.cjs') },
  { name: 'test:smoke', script: path.join('test', 'smoke.test.cjs') },
  { name: 'test:manifest', script: path.join('test', 'manifest.test.cjs') }
];

function main() {
  const results = [];
  for (const step of STEPS) {
    console.log(`\n===== ${step.name} (${step.script}) =====`);
    const result = spawnSync(process.execPath, [path.join(KIT_ROOT, step.script)], {
      cwd: KIT_ROOT,
      stdio: 'inherit'
    });
    const ok = result.status === 0;
    results.push({ name: step.name, ok, status: result.status });
    if (!ok) console.error(`>> ${step.name} 失败(exit=${result.status})`);
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
