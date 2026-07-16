'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  MAX_FILE_BYTES,
  auditTree,
  loadSkipManifest,
} = require('../bin/check-sanitized.cjs');
const { scanText: scanSharedText } = require('../bin/sanitize-patterns.cjs');
const { scanText: scanReleaseText } = require('../bin/check-release.cjs');

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'business-agent-sanitized-'));
}

test('strict sanitizer reports unreadable/stat failures instead of silently skipping them', () => {
  const root = temporaryRoot();
  try {
    fs.writeFileSync(path.join(root, 'safe.txt'), 'safe');
    fs.writeFileSync(path.join(root, 'unreadable.txt'), 'private');
    fs.writeFileSync(path.join(root, 'stat-failure.txt'), 'private');
    const faultFs = Object.create(fs);
    faultFs.lstatSync = (file) => {
      if (path.basename(file) === 'stat-failure.txt') throw new Error('injected stat failure');
      return fs.lstatSync(file);
    };
    faultFs.readFileSync = (file, ...args) => {
      if (path.basename(file) === 'unreadable.txt' && args.length === 0) throw new Error('injected read failure');
      return fs.readFileSync(file, ...args);
    };
    const result = auditTree({ root, fsImpl: faultFs });
    assert(result.skipped.some((item) => item.path === 'unreadable.txt' && item.reason === 'read-failed' && !item.approved));
    assert(result.skipped.some((item) => item.path === 'stat-failure.txt' && item.reason === 'stat-failed' && !item.approved));
    assert.equal(result.scanned, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict CLI prints and rejects oversized skips unless an exact reason manifest approves them', () => {
  const root = temporaryRoot();
  const manifestPath = path.join(path.dirname(root), `${path.basename(root)}-skips.json`);
  try {
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
    const script = path.resolve(__dirname, '..', 'bin', 'check-sanitized.cjs');
    const rejected = spawnSync(process.execPath, [script, '--strict', '--root', root], { encoding: 'utf8' });
    const rejectedOutput = `${rejected.stdout}\n${rejected.stderr}`;
    assert.equal(rejected.status, 1);
    assert.match(rejectedOutput, /large\.txt \[oversized\] UNAPPROVED/);
    assert.match(rejectedOutput, /check-sanitized: FAIL/);

    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: '1.0',
      skips: [{
        path: 'large.txt',
        reason: 'oversized',
        justification: 'Generated fixture is inspected by its dedicated deterministic producer.',
      }],
    }));
    const manifest = loadSkipManifest(manifestPath, root);
    const audited = auditTree({ root, skipManifest: manifest });
    assert.equal(audited.skipped[0].approved, true);
    assert.equal(audited.skipped[0].approval, 'manifest');
    assert.deepEqual(audited.manifestIssues, []);

    const approved = spawnSync(process.execPath, [
      script,
      '--strict',
      '--root', root,
      '--skip-manifest', manifestPath,
    ], { encoding: 'utf8' });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /large\.txt \[oversized\] approved:manifest/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(manifestPath, { force: true });
  }
});

test('working-tree and packed-release gates share provider, GitHub, Slack, and assignment rules', () => {
  const opaque = ['AbCdEfGhIjKl', 'MnOpQrStUvWx'].join('');
  const shapes = [
    ['provider-token', ['sk', 'proj', opaque].join('-')],
    ['github-token', ['ghp_', 'A'.repeat(36)].join('')],
    ['provider-token', ['xox', 'b-', 'B'.repeat(24)].join('')],
    ['credential-assignment-unquoted', `SERVICE_TOKEN=${opaque}`],
    ['credential-assignment', `api_key = "${opaque}"`],
  ];
  for (const [rule, value] of shapes) {
    assert(scanSharedText(value).some((item) => item.name === rule), `worktree:${rule}`);
    assert(scanReleaseText('fixture.txt', Buffer.from(value)).some((item) => item.rule === rule), `release:${rule}`);
  }
  for (const placeholder of [
    'SERVICE_TOKEN=${SERVICE_TOKEN}',
    'api_key = "synthetic_fixture_value"',
  ]) {
    assert.equal(scanSharedText(placeholder).length, 0, placeholder);
    assert.equal(scanReleaseText('fixture.txt', Buffer.from(placeholder)).length, 0, placeholder);
  }
});
