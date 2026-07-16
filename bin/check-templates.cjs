#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STEPS = [
  {
    name: 'templates:validate',
    args: [path.join(ROOT, 'bin', 'run-template-matrix.mjs'), 'validate'],
  },
  {
    name: 'templates:run',
    args: [path.join(ROOT, 'bin', 'run-template-matrix.mjs'), 'run'],
  },
  {
    name: 'test:templates',
    args: ['--test', path.join(ROOT, 'test', 'templates.test.mjs')],
  },
];

for (const step of STEPS) {
  console.log(`\n===== ${step.name} =====`);
  const result = spawnSync(process.execPath, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`template-check: FAIL(${step.name}: ${result.error.message})`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`template-check: FAIL(${step.name}: exit=${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\ntemplate-check: PASS(${STEPS.length} gates)`);
