#!/usr/bin/env node
'use strict';
// Release sanitization audit: scan every text file in the working tree with
// the shared banned-term / secret-shape patterns. Exits non-zero on any hit.
//
// Usage:
//   node bin/check-sanitized.cjs [--root <dir>] [--extra-banned <file>]
//
// --extra-banned points to a private denylist kept OUTSIDE the repository
// (one term or regex per line, '#' for comments). See docs/security-baseline.md.

const fs = require('fs');
const path = require('path');
const { scanText, compileExtraPatterns } = require('./sanitize-patterns.cjs');

const KIT_ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.idea', '.vscode']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tgz',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.jar'
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function parseArgs(argv) {
  const options = { root: KIT_ROOT, extraBanned: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') options.root = path.resolve(argv[++i] || '');
    else if (arg === '--extra-banned') options.extraBanned = path.resolve(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node bin/check-sanitized.cjs [--root <dir>] [--extra-banned <file>]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function isProbablyBinary(absPath) {
  if (BINARY_EXTENSIONS.has(path.extname(absPath).toLowerCase())) return true;
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch (err) {
    return true; // unreadable -> skip rather than crash
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function main() {
  const options = parseArgs(process.argv);
  if (!fs.existsSync(options.root)) {
    console.error(`扫描根目录不存在: ${options.root}`);
    process.exit(2);
  }

  let extraPatterns = [];
  if (options.extraBanned) {
    if (!fs.existsSync(options.extraBanned)) {
      console.error(`--extra-banned 文件不存在: ${options.extraBanned}`);
      process.exit(2);
    }
    const lines = fs.readFileSync(options.extraBanned, 'utf8').split(/\r?\n/);
    extraPatterns = compileExtraPatterns(lines);
    console.log(`已加载私有 denylist: ${extraPatterns.length} 条(${options.extraBanned})`);
  }

  const files = listFiles(options.root);
  let scanned = 0;
  const allHits = [];
  for (const absPath of files) {
    if (isProbablyBinary(absPath)) continue;
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    scanned++;
    const text = fs.readFileSync(absPath, 'utf8');
    const hits = scanText(text, extraPatterns);
    const rel = path.relative(options.root, absPath) || absPath;
    for (const hit of hits) {
      allHits.push(`${rel}:${hit.line} [${hit.name}] ${hit.masked}`);
    }
  }

  if (allHits.length > 0) {
    console.error(`check-sanitized: FAIL,发现 ${allHits.length} 处命中(已掩码,不回显全值):`);
    for (const line of allHits) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`check-sanitized: PASS(扫描 ${scanned} 个文本文件,零命中)`);
}

main();
