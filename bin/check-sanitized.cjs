#!/usr/bin/env node
'use strict';
// Release sanitization audit. Strict mode fails closed when any candidate file
// cannot be inspected. Intentional binary/oversized files require an exact,
// reason-bound manifest entry; unreadable files and filesystem errors can
// never be waived.

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { scanText, compileExtraPatterns } = require('./sanitize-patterns.cjs');

const KIT_ROOT = path.resolve(__dirname, '..');
const CONTROLLED_SKIP_DIRS = new Map([
  ['.git', 'version-control metadata and history are outside the working-tree source audit'],
  ['node_modules', 'third-party dependencies are governed by the lockfile and SBOM'],
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tgz',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.jar',
]);
const MANIFEST_REASONS = new Set(['binary-extension', 'binary-content', 'invalid-utf8', 'oversized']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function usage() {
  return [
    '用法: node bin/check-sanitized.cjs [--strict] [--root <dir>]',
    '       [--extra-banned <file>] [--skip-manifest <json>]',
    '',
    '--strict 在 unreadable/stat/read/binary/oversized/invalid UTF-8 等跳过项未获精确批准时失败。',
  ].join('\n');
}

function parseArgs(argv, env = process.env) {
  const options = {
    root: KIT_ROOT,
    extraBanned: null,
    skipManifest: null,
    strict: env.CI === 'true' || env.GITHUB_ACTIONS === 'true',
    help: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--extra-banned') options.extraBanned = path.resolve(argv[++index] || '');
    else if (arg === '--skip-manifest') options.skipManifest = path.resolve(argv[++index] || '');
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--no-strict') options.strict = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Object.assign(new Error(`未知参数: ${arg}`), { code: 'SANITIZER_ARGUMENT_INVALID' });
  }
  return options;
}

function relativePath(root, absolute) {
  const relative = path.relative(root, absolute) || '.';
  return relative.split(path.sep).join('/');
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function loadSkipManifest(filePath, root, fsImpl = fs) {
  if (!filePath) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error('skip manifest must be readable JSON'), {
      code: 'SANITIZER_MANIFEST_INVALID',
      cause: error,
    });
  }
  if (!exactKeys(parsed, ['schemaVersion', 'skips'])
      || parsed.schemaVersion !== '1.0'
      || !Array.isArray(parsed.skips)) {
    throw Object.assign(new Error('skip manifest must contain exactly schemaVersion=1.0 and skips[]'), {
      code: 'SANITIZER_MANIFEST_INVALID',
    });
  }
  const entries = new Map();
  for (const item of parsed.skips) {
    if (!exactKeys(item, ['path', 'reason', 'justification'])
        || typeof item.path !== 'string'
        || !item.path
        || path.isAbsolute(item.path)
        || item.path.includes('\\')
        || !MANIFEST_REASONS.has(item.reason)
        || typeof item.justification !== 'string'
        || item.justification.trim().length < 12
        || item.justification.length > 500) {
      throw Object.assign(new Error('each skip must have an exact relative path, allowlisted reason, and 12-500 character justification'), {
        code: 'SANITIZER_MANIFEST_INVALID',
      });
    }
    const normalized = path.posix.normalize(item.path);
    const absolute = path.resolve(root, ...normalized.split('/'));
    const within = path.relative(root, absolute);
    if (normalized === '.' || normalized.startsWith('../') || within.startsWith('..') || path.isAbsolute(within)) {
      throw Object.assign(new Error('skip manifest path must stay inside the scan root'), { code: 'SANITIZER_MANIFEST_INVALID' });
    }
    const key = `${normalized}\u0000${item.reason}`;
    if (entries.has(key)) {
      throw Object.assign(new Error('skip manifest contains a duplicate path/reason'), { code: 'SANITIZER_MANIFEST_INVALID' });
    }
    entries.set(key, { path: normalized, reason: item.reason, justification: item.justification.trim() });
  }
  return entries;
}

function discoverFiles(root, fsImpl) {
  const files = [];
  const skipped = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(directory, { withFileTypes: true });
    } catch {
      skipped.push({ path: relativePath(root, directory), reason: 'directory-unreadable', approved: false });
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      if (entry.isDirectory()) {
        if (CONTROLLED_SKIP_DIRS.has(entry.name)) {
          skipped.push({
            path: `${relative}/`,
            reason: 'controlled-directory',
            approved: true,
            approval: 'builtin',
          });
        } else {
          stack.push(absolute);
        }
      } else if (entry.isFile()) {
        files.push(absolute);
      } else if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'symlink', approved: false });
      } else {
        skipped.push({ path: relative, reason: 'non-regular', approved: false });
      }
    }
  }
  return { files: files.sort(), skipped };
}

function auditTree({
  root,
  extraPatterns = [],
  skipManifest = new Map(),
  fsImpl = fs,
} = {}) {
  const discovered = discoverFiles(root, fsImpl);
  const skipped = [...discovered.skipped];
  const hits = [];
  let scanned = 0;

  function skip(absolute, reason) {
    skipped.push({ path: relativePath(root, absolute), reason, approved: false });
  }

  for (const absolute of discovered.files) {
    let stat;
    try {
      stat = fsImpl.lstatSync(absolute);
    } catch {
      skip(absolute, 'stat-failed');
      continue;
    }
    if (!stat.isFile()) {
      skip(absolute, stat.isSymbolicLink() ? 'symlink' : 'non-regular');
      continue;
    }
    if (BINARY_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      skip(absolute, 'binary-extension');
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skip(absolute, 'oversized');
      continue;
    }
    let buffer;
    try {
      buffer = fsImpl.readFileSync(absolute);
    } catch {
      skip(absolute, 'read-failed');
      continue;
    }
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length > MAX_FILE_BYTES) {
      skip(absolute, 'oversized');
      continue;
    }
    if (buffer.includes(0)) {
      skip(absolute, 'binary-content');
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      skip(absolute, 'invalid-utf8');
      continue;
    }
    scanned += 1;
    for (const hit of scanText(text, extraPatterns)) {
      hits.push({ path: relativePath(root, absolute), ...hit });
    }
  }

  const usedManifestEntries = new Set();
  for (const item of skipped) {
    if (item.approved) continue;
    const key = `${item.path}\u0000${item.reason}`;
    if (!skipManifest.has(key)) continue;
    item.approved = true;
    item.approval = 'manifest';
    usedManifestEntries.add(key);
  }
  const manifestIssues = [];
  for (const [key, item] of skipManifest) {
    if (!usedManifestEntries.has(key)) {
      manifestIssues.push({ path: item.path, reason: item.reason, issue: 'unused-or-reason-mismatch' });
    }
  }
  return {
    scanned,
    hits,
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason)),
    manifestIssues,
  };
}

function main(argv = process.argv, env = process.env, fsImpl = fs) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    if (!fsImpl.existsSync(options.root) || !fsImpl.statSync(options.root).isDirectory()) {
      console.error(`扫描根目录不存在或不是目录: ${options.root}`);
      return 2;
    }

    let extraPatterns = [];
    if (options.extraBanned) {
      const lines = fsImpl.readFileSync(options.extraBanned, 'utf8').split(/\r?\n/);
      extraPatterns = compileExtraPatterns(lines);
      console.log(`已加载私有 denylist: ${extraPatterns.length} 条(${options.extraBanned})`);
    }
    const manifest = loadSkipManifest(options.skipManifest, options.root, fsImpl);
    const result = auditTree({ root: options.root, extraPatterns, skipManifest: manifest, fsImpl });

    console.log(`check-sanitized: SKIPPED ${result.skipped.length} 项:`);
    for (const item of result.skipped) {
      const disposition = item.approved ? `approved:${item.approval}` : 'UNAPPROVED';
      console.log(`  ${item.path} [${item.reason}] ${disposition}`);
    }
    if (result.manifestIssues.length > 0) {
      console.error(`check-sanitized: skip manifest 有 ${result.manifestIssues.length} 个未使用或原因不匹配条目:`);
      for (const item of result.manifestIssues) console.error(`  ${item.path} [${item.reason}] ${item.issue}`);
    }
    if (result.hits.length > 0) {
      console.error(`check-sanitized: 发现 ${result.hits.length} 处命中(已掩码,不回显全值):`);
      for (const hit of result.hits) console.error(`  ${hit.path}:${hit.line} [${hit.name}] ${hit.masked}`);
    }
    const unapproved = result.skipped.filter((item) => !item.approved);
    const failed = result.hits.length > 0
      || result.manifestIssues.length > 0
      || (options.strict && unapproved.length > 0);
    if (failed) {
      console.error(`check-sanitized: FAIL(扫描 ${result.scanned} 个文本文件,strict=${options.strict},未批准跳过=${unapproved.length})`);
      return 1;
    }
    console.log(`check-sanitized: PASS(扫描 ${result.scanned} 个文本文件,零命中,strict=${options.strict})`);
    return 0;
  } catch (error) {
    console.error(`check-sanitized: FAIL(${error.message})`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MAX_FILE_BYTES,
  MANIFEST_REASONS,
  parseArgs,
  loadSkipManifest,
  auditTree,
  main,
};
