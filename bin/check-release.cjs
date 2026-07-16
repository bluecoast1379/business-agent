#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanText: scanSanitizedText } = require('./sanitize-patterns.cjs');

const ROOT = path.resolve(__dirname, '..');
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function scanText(relative, buffer) {
  const findings = [];
  // Packaged source/config files are detected by content, not suffix. Files
  // such as `.env.example` and extensionless scripts must not evade prepack
  // scanning. This zero-dependency package intentionally ships no binaries.
  if (buffer.length > MAX_TEXT_BYTES) return [{ path: relative, rule: 'oversized-packed-file', detail: `packed file exceeds ${MAX_TEXT_BYTES} bytes` }];
  if (buffer.includes(0)) return [{ path: relative, rule: 'binary-packed-entry', detail: 'binary/NUL content is not allowed in this source-only package' }];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return [{ path: relative, rule: 'invalid-utf8-packed-entry', detail: 'packed source must be readable UTF-8' }];
  }
  for (const hit of scanSanitizedText(text)) {
    findings.push({ path: relative, rule: hit.name, detail: `secret-shaped value found at line ${hit.line}` });
  }
  return findings;
}

function assertPackEntry(root, relative) {
  const absolute = path.resolve(root, relative);
  const within = path.relative(root, absolute);
  if (within.startsWith('..') || path.isAbsolute(within)) return [{ path: relative, rule: 'path-traversal', detail: 'packed path leaves root' }];
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return [{ path: relative, rule: 'symlink', detail: 'packed symlinks are forbidden' }];
  if (!stat.isFile()) return [{ path: relative, rule: 'non-file', detail: 'packed entry is not a regular file' }];
  return scanText(relative, fs.readFileSync(absolute));
}

function packEntries(root = ROOT) {
  const cache = path.join(os.tmpdir(), 'business-agent-npm-cache');
  fs.mkdirSync(cache, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
  });
  if (result.error) throw new Error(`npm pack --dry-run could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed: ${(result.stderr || result.stdout).trim()}`);
  const payload = JSON.parse(result.stdout);
  return payload[0].files.map((entry) => entry.path).sort();
}

function verifySbom(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sbom = JSON.parse(fs.readFileSync(path.join(root, 'sbom.cdx.json'), 'utf8'));
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') throw new Error('SBOM must be CycloneDX 1.5');
  if (sbom.metadata?.component?.name !== pkg.name || sbom.metadata?.component?.version !== pkg.version) throw new Error('SBOM component does not match package.json');
  if ((sbom.components ?? []).length !== 0) throw new Error('zero-dependency package SBOM must have zero dependency components');
}

function verifyWorkflowActionPins(root = ROOT) {
  const workflowRoot = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(workflowRoot)) return;
  const findings = [];
  for (const name of fs.readdirSync(workflowRoot).filter((file) => /\.ya?ml$/i.test(file)).sort()) {
    const text = fs.readFileSync(path.join(workflowRoot, name), 'utf8');
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/);
      if (!match) continue;
      const reference = match[1];
      if (reference.startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/i.test(reference)) findings.push(`${name}:${index + 1}: ${reference}`);
    }
  }
  if (findings.length) throw new Error(`remote GitHub Actions must be pinned to full commit SHAs:\n${findings.join('\n')}`);
}

function verifyReleaseContext(root = ROOT, env = process.env, resolveRevision = (revision) => {
  const result = spawnSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(`cannot resolve release revision ${revision}`);
  return result.stdout.trim();
}) {
  if (env.GITHUB_EVENT_NAME !== 'release') return { checked: false };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const expectedTag = `v${pkg.version}`;
  const actualTag = env.GITHUB_REF_NAME || String(env.GITHUB_REF ?? '').replace(/^refs\/tags\//, '');
  if (env.GITHUB_REF_TYPE !== 'tag' || actualTag !== expectedTag) {
    throw new Error(`release tag ${JSON.stringify(actualTag)} must exactly match package version tag ${expectedTag}`);
  }
  const head = resolveRevision('HEAD');
  const eventCommit = String(env.GITHUB_SHA ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(eventCommit) || head !== eventCommit) {
    throw new Error('checked-out HEAD must exactly match the GitHub Release target commit');
  }
  return { checked: true, tag: expectedTag, commit: head };
}

function run({ root = ROOT, entries } = {}) {
  verifyReleaseContext(root);
  verifyWorkflowActionPins(root);
  const files = entries ?? packEntries(root);
  const findings = [];
  for (const relative of files) findings.push(...assertPackEntry(root, relative));
  verifySbom(root);
  if (findings.length) throw new Error(findings.map((item) => `${item.path}: ${item.rule} (${item.detail})`).join('\n'));
  return { files: files.length, findings: 0 };
}

if (require.main === module) {
  try {
    const result = run();
    console.log(`release-check: PASS(${result.files} packed files; secrets/content/SBOM verified)`);
  } catch (error) {
    console.error(`release-check: FAIL\n${error.message}`);
    process.exit(1);
  }
}

module.exports = { MAX_TEXT_BYTES, scanText, assertPackEntry, packEntries, verifySbom, verifyWorkflowActionPins, verifyReleaseContext, run };
