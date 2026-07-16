'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { MAX_TEXT_BYTES, assertPackEntry, run, scanText, verifyReleaseContext, verifyWorkflowActionPins } = require('../bin/check-release.cjs');

test('release scanner catches secret shapes even when a placeholder word is embedded', () => {
  const shaped = ['sk', 'live', `placeholder${'A'.repeat(20)}`].join('_');
  const findings = scanText('fixture.js', Buffer.from(`const value = "${shaped}";`));
  assert(findings.some((item) => item.rule === 'provider-key'));
  assert(scanText('.env.example', Buffer.from(`TOKEN=${shaped}`)).some((item) => item.rule === 'provider-key'));
});

test('release scanner catches unquoted env credentials and common provider token families', () => {
  for (const assignment of [
    'API_KEY=abcdefghijklmnopQRSTUV',
    'TOKEN=abcdefghijklmnopQRSTUV',
    'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopQRSTUV1234567890',
    'export SERVICE_PASSWORD=abcdefghijklmnopQRSTUV',
  ]) {
    assert(
      scanText('.env.example', Buffer.from(assignment))
        .some((item) => item.rule === 'credential-assignment-unquoted'),
      assignment,
    );
  }
  const shapes = [
    ['github-token', `ghp_${'A'.repeat(36)}`],
    ['aws-access-key-id', `AKIA${'A1'.repeat(8)}`],
    ['provider-token', `sk-proj-${'A'.repeat(24)}`],
  ];
  for (const [rule, value] of shapes) {
    assert(scanText('fixture.txt', Buffer.from(value)).some((item) => item.rule === rule), rule);
  }
  for (const placeholder of [
    'API_KEY=<generated>',
    'TOKEN=\${TOKEN}',
    'PASSWORD=example-value',
    'AWS_SECRET_ACCESS_KEY=synthetic_fixture_value',
  ]) {
    assert.equal(scanText('.env.example', Buffer.from(placeholder)).length, 0, placeholder);
  }
});

test('release scanner fails closed for oversized text and packed symlinks', () => {
  assert(scanText('large.unknown', Buffer.alloc(MAX_TEXT_BYTES + 1, 65)).some((item) => item.rule === 'oversized-packed-file'));
  assert(scanText('binary.bin', Buffer.from([0, 1, 2])).some((item) => item.rule === 'binary-packed-entry'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-agent-release-'));
  fs.writeFileSync(path.join(dir, 'real.md'), 'safe');
  fs.symlinkSync('real.md', path.join(dir, 'link.md'));
  assert(assertPackEntry(dir, 'link.md').some((item) => item.rule === 'symlink'));
});

test('actual packed artifact list passes allowlisted content and SBOM verification', () => {
  const result = run();
  assert(result.files > 0);
  assert.strictEqual(result.findings, 0);
});

test('release publication fails closed when tag, package version, or checkout commit diverges', () => {
  const commit = 'a'.repeat(40);
  assert.throws(
    () => verifyReleaseContext(undefined, {
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v9.9.9',
      GITHUB_SHA: commit,
    }, () => commit),
    /must exactly match package version tag/,
  );
  assert.throws(
    () => verifyReleaseContext(undefined, {
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.3.0',
      GITHUB_SHA: 'b'.repeat(40),
    }, () => commit),
    /must exactly match the GitHub Release target commit/,
  );
  assert.deepStrictEqual(
    verifyReleaseContext(undefined, {
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.3.0',
      GITHUB_SHA: commit,
    }, () => commit),
    { checked: true, tag: 'v0.3.0', commit },
  );
});

test('CI workflows reject movable third-party action tags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-agent-workflow-pin-'));
  try {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'check.yml'), 'steps:\n  - uses: actions/checkout@v4\n');
    assert.throws(() => verifyWorkflowActionPins(root), /full commit SHAs/);
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'check.yml'), 'steps:\n  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4\n');
    assert.doesNotThrow(() => verifyWorkflowActionPins(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release workflow reads package identity explicitly and keeps recovery verify-only', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /\$\{npm_package_(?:name|version)\}/);
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+tag:/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'release' && github\.event\.release\.tag_name \|\| inputs\.tag \}\}/);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(workflow, /node -p "require\('\.\/package\.json'\)\.name"/);
  assert.match(workflow, /node -p "require\('\.\/package\.json'\)\.version"/);
  assert.match(workflow, /npm view "\$\{package_name\}@\$\{package_version\}"/);
  assert.match(workflow, /grep -Eq 'E404\|404 Not Found'/);
  assert.match(workflow, /refusing to infer that the version is unpublished/);
  assert.match(workflow, /Recovery mode verifies existing releases and will not publish a missing version/);
  assert.match(workflow, /if: github\.event_name == 'release' && steps\.registry\.outputs\.published != 'true'/);
});
