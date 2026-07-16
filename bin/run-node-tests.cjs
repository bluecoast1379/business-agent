#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return collect(absolute);
    if (entry.isFile() && /\.test\.(?:js|cjs|mjs)$/.test(entry.name)) return [path.relative(ROOT, absolute)];
    return [];
  });
}

const files = [...collect(path.join(ROOT, 'scaffold', 'test')), ...collect(path.join(ROOT, 'test'))];
if (!files.length) {
  console.error('test:runtime: no test files found');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
