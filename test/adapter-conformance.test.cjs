'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  PUBLIC_CERTIFICATION_STATUS,
  SELF_REPORTED_STATUS,
  run,
  validateAdapter,
  validateCertification,
  validateSelfReportedRecord,
} = require('../bin/check-adapter-conformance.cjs');

function selfReport(patch = {}) {
  return {
    schemaVersion: '1.0',
    tool: 'cursor',
    status: SELF_REPORTED_STATUS,
    clientVersion: '1.2.3',
    os: 'SyntheticOS 1',
    verifiedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    checks: { entryVisible: true, thinEntryReadsCore: true, artifactPathCorrect: true },
    ...patch,
  };
}

test('all shipped adapters pass structural conformance without trusted certification', () => {
  const result = run();
  assert.deepStrictEqual(result.tools.sort(), ['claude', 'codebuddy', 'codex', 'copilot', 'cursor', 'trae']);
  assert.equal(result.selfReportedRecords, 0);
  assert.equal(result.trustedCertifications, 0);
  assert.equal(result.publicCertificationStatus, 'native_not_yet_manually_certified');
});

test('instructions adapters need output_dir and a single-file pattern', () => {
  const base = {
    tool: 'trae', display_name: 'Trae', status: 'instructions', output_dir: '.trae',
    file_pattern: 'instructions.md', frontmatter: false, discovery: 'x', notes: 'x',
  };
  assert.deepStrictEqual(validateAdapter(base), []);
  assert(validateAdapter({ ...base, output_dir: '' })
    .some((error) => error.includes('single-file pattern')));
  assert(validateAdapter({ ...base, file_pattern: '{id}.md' })
    .some((error) => error.includes('single-file pattern')));
  assert(validateAdapter({ ...base, file_pattern: '' })
    .some((error) => error.includes('single-file pattern')));
});

test('descriptor cannot self-assert certification', () => {
  const errors = validateAdapter({
    tool: 'bad', display_name: 'Bad', status: 'certified', output_dir: '.bad', file_pattern: '{id}.md', frontmatter: false, discovery: 'x', notes: 'x',
  });
  assert(errors.some((error) => error.includes('cannot claim certification')));
});

test('repository records are self-reported, fresh, bounded, and never certification', () => {
  const now = Date.parse('2026-06-02T00:00:00.000Z');
  assert.deepStrictEqual(validateSelfReportedRecord(selfReport(), 'fixture', now), []);
  assert(validateSelfReportedRecord(
    selfReport({ verifiedAt: '2026-06-03T00:00:00.000Z' }),
    'fixture',
    now,
  ).some((error) => error.includes('future')));
  assert(validateSelfReportedRecord(
    selfReport({ expiresAt: '2027-06-01T00:00:00.000Z' }),
    'fixture',
    now,
  ).some((error) => error.includes('90 days')));
  assert(validateSelfReportedRecord(
    selfReport({ status: 'manual-certified' }),
    'fixture',
    now,
  ).some((error) => error.includes('cannot claim manual-certified')));
  assert(validateSelfReportedRecord(
    { ...selfReport(), issuer: 'self-appointed', signature: 'not-trusted' },
    'fixture',
    now,
  ).some((error) => error.includes('unknown field')));
  assert(validateCertification(selfReport(), 'fixture').some((error) => error.includes('unavailable')));
});

test('arbitrary repository JSON is counted only as self-reported and cannot promote the matrix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-agent-adapter-trust-'));
  try {
    fs.mkdirSync(path.join(root, 'kit', 'adapters'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', 'adapter-certifications', 'cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kit', 'adapters', 'cursor.yaml'), [
      'tool: cursor',
      'display_name: "Cursor"',
      'status: generated',
      'output_dir: ".cursor/commands"',
      'file_pattern: "{id}.md"',
      'frontmatter: false',
      'discovery: "commands"',
      'notes: "structural only"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'docs', 'support-matrix.md'), [
      '| Tool | id | structural | certification |',
      '| --- | --- | --- | --- |',
      `| Cursor | \`cursor\` | generated | ${PUBLIC_CERTIFICATION_STATUS} |`,
      '',
      'generated 不等于人工认证。',
    ].join('\n'));
    const recordPath = path.join(root, 'docs', 'adapter-certifications', 'cursor', '1.2.3.json');
    fs.writeFileSync(recordPath, JSON.stringify(selfReport()));

    const result = run({ root, now: Date.parse('2026-06-02T00:00:00.000Z') });
    assert.equal(result.selfReportedRecords, 1);
    assert.equal(result.trustedCertifications, 0);
    assert.equal(result.publicCertificationStatus, PUBLIC_CERTIFICATION_STATUS);

    fs.writeFileSync(recordPath, JSON.stringify(selfReport({ status: 'manual-certified' })));
    assert.throws(
      () => run({ root, now: Date.parse('2026-06-02T00:00:00.000Z') }),
      /repository JSON cannot claim manual-certified/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI text reports zero trust and never claims signed evidence', () => {
  const script = path.resolve(__dirname, '..', 'bin', 'check-adapter-conformance.cjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 trusted certifications/);
  assert.match(result.stdout, /public status=native_not_yet_manually_certified/);
  assert.doesNotMatch(result.stdout, /signed evidence/i);
});
