#!/usr/bin/env node
'use strict';
// Syntax gate: run `node --check` over every .cjs/.js/.mjs file under
// bin/, test/ and scaffold/. Exits non-zero if any file fails to parse.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['bin', 'test', 'scaffold'];
const EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function collect(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(abs, out);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(abs);
    }
  }
}

function main() {
  const files = [];
  for (const dirName of TARGET_DIRS) {
    const abs = path.join(KIT_ROOT, dirName);
    if (!fs.existsSync(abs)) {
      console.log(`check-syntax: 跳过不存在的目录 ${dirName}/(可能尚未由对应构建步骤产出)`);
      continue;
    }
    collect(abs, files);
  }

  if (files.length === 0) {
    console.error('check-syntax: FAIL,未找到任何可检查的 .cjs/.js/.mjs 文件');
    process.exit(1);
  }

  const failures = [];
  for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push({ file: path.relative(KIT_ROOT, file), stderr: (result.stderr || '').trim() });
    }
  }

  if (failures.length > 0) {
    console.error(`check-syntax: FAIL(${failures.length}/${files.length} 个文件语法错误)`);
    for (const failure of failures) {
      console.error(`  ${failure.file}`);
      if (failure.stderr) console.error(`    ${failure.stderr.split('\n').join('\n    ')}`);
    }
    process.exit(1);
  }
  console.log(`check-syntax: PASS(${files.length} 个文件全部通过 node --check)`);
}

main();
