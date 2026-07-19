#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./check-command-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_DESCRIPTOR_STATUS = new Set(['generated', 'instructions', 'via-AGENTS.md']);
const PUBLIC_CERTIFICATION_STATUS = 'native_not_yet_manually_certified';
const SELF_REPORTED_STATUS = 'self-reported-manual-check';
const MAX_SELF_REPORT_VALIDITY_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function validateAdapter(adapter, source = '<adapter>') {
  const errors = [];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return [`${source}: descriptor must be an object`];
  if (!/^[a-z][a-z0-9-]*$/.test(String(adapter.tool || ''))) errors.push(`${source}: tool is invalid`);
  for (const key of ['display_name', 'status', 'output_dir', 'file_pattern', 'discovery', 'notes']) {
    if (typeof adapter[key] !== 'string') errors.push(`${source}: ${key} must be a string`);
  }
  if (typeof adapter.frontmatter !== 'boolean') errors.push(`${source}: frontmatter must be boolean`);
  if (!ALLOWED_DESCRIPTOR_STATUS.has(adapter.status)) errors.push(`${source}: status must be generated, instructions or via-AGENTS.md; structural files cannot claim certification`);
  if (adapter.status === 'generated' && (!adapter.output_dir || !adapter.file_pattern.includes('{id}'))) errors.push(`${source}: generated adapters need output_dir and {id} file_pattern`);
  if (adapter.status === 'instructions' && (!adapter.output_dir || !adapter.file_pattern || adapter.file_pattern.includes('{id}'))) errors.push(`${source}: instructions adapters need output_dir and a single-file pattern without {id}`);
  if (adapter.status === 'via-AGENTS.md' && (adapter.output_dir || adapter.file_pattern)) errors.push(`${source}: via-AGENTS.md must not generate an entry path`);
  return errors;
}

function canonicalDate(value) {
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  return new Date(parsed).toISOString() === value ? parsed : NaN;
}

function exactObject(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

/**
 * Validate a repository-local observation record. Passing this validation is
 * deliberately NOT a certification: the same repository controls both the
 * claim and this checker. Trusted certification would require an external
 * trust policy, allowlisted issuer key, detached signature, and a verified
 * adapter/source digest. No such trust root exists in this repository.
 */
function validateSelfReportedRecord(evidence, source = '<self-report>', now = Date.now()) {
  const errors = [];
  const exact = ['schemaVersion', 'tool', 'status', 'clientVersion', 'os', 'verifiedAt', 'expiresAt', 'checks'];
  if (!exactObject(evidence, exact)) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [`${source}: self-reported record must be an object`];
    for (const key of Object.keys(evidence)) if (!exact.includes(key)) errors.push(`${source}: unknown field ${key}`);
    for (const key of exact) if (!Object.hasOwn(evidence, key)) errors.push(`${source}: missing field ${key}`);
  }
  if (evidence?.schemaVersion !== '1.0' || evidence?.status !== SELF_REPORTED_STATUS) {
    errors.push(`${source}: status must be ${SELF_REPORTED_STATUS}; repository JSON cannot claim manual-certified`);
  }
  if (!Number.isFinite(now)) errors.push(`${source}: verifier clock is invalid`);
  if (!/^[a-z][a-z0-9-]*$/.test(String(evidence?.tool || ''))) errors.push(`${source}: tool is invalid`);
  for (const key of ['clientVersion', 'os']) {
    const value = evidence?.[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
      errors.push(`${source}: ${key} must be a printable string up to 128 characters`);
    }
  }
  const verified = canonicalDate(evidence?.verifiedAt);
  const expires = canonicalDate(evidence?.expiresAt);
  if (!Number.isFinite(verified) || !Number.isFinite(expires) || expires <= verified) {
    errors.push(`${source}: self-reported dates must be canonical ISO timestamps with expiresAt after verifiedAt`);
  }
  if (Number.isFinite(verified) && verified > now + MAX_CLOCK_SKEW_MS) {
    errors.push(`${source}: verifiedAt is in the future`);
  }
  if (Number.isFinite(verified)
      && Number.isFinite(expires)
      && expires - verified > MAX_SELF_REPORT_VALIDITY_MS) {
    errors.push(`${source}: self-reported validity must not exceed 90 days`);
  }
  if (Number.isFinite(expires) && expires <= now) errors.push(`${source}: self-reported record is expired`);
  const checks = evidence?.checks;
  if (!exactObject(checks, ['entryVisible', 'thinEntryReadsCore', 'artifactPathCorrect'])) {
    errors.push(`${source}: checks must contain exactly entryVisible, thinEntryReadsCore, artifactPathCorrect`);
  }
  for (const key of ['entryVisible', 'thinEntryReadsCore', 'artifactPathCorrect']) {
    if (checks?.[key] !== true) errors.push(`${source}: check ${key} must be true`);
  }
  return [...new Set(errors)];
}

// Kept as an explicit fail-closed compatibility export. Callers cannot turn a
// repository-controlled JSON object into trusted certification by invoking an
// old function name.
function validateCertification(_evidence, source = '<certification>') {
  return [
    `${source}: trusted certification verification is unavailable; repository evidence is self-reported only`,
  ];
}

function matrixRow(matrix, tool) {
  return matrix.split(/\r?\n/).find((line) => line.trim().startsWith('|') && line.includes(`\`${tool}\``));
}

function run({ root = ROOT, now = Date.now() } = {}) {
  const adapterDir = path.join(root, 'kit', 'adapters');
  const errors = [];
  const tools = [];
  for (const name of fs.readdirSync(adapterDir).filter((file) => file.endsWith('.yaml')).sort()) {
    const file = path.join(adapterDir, name);
    const descriptor = parseYaml(fs.readFileSync(file, 'utf8'), file);
    errors.push(...validateAdapter(descriptor, name));
    tools.push(descriptor.tool);
  }

  const matrix = fs.readFileSync(path.join(root, 'docs', 'support-matrix.md'), 'utf8');
  for (const tool of tools) {
    const row = matrixRow(matrix, tool);
    if (!row) errors.push(`support-matrix.md: missing ${tool}`);
    else if (!row.includes(PUBLIC_CERTIFICATION_STATUS)) {
      errors.push(`support-matrix.md: ${tool} must remain ${PUBLIC_CERTIFICATION_STATUS}`);
    }
  }
  if (!/不等于.{0,20}人工认证|does not equal.{0,20}certification/i.test(matrix)) {
    errors.push('support-matrix.md must distinguish generated from manual certification');
  }

  let selfReportedRecords = 0;
  const certRoot = path.join(root, 'docs', 'adapter-certifications');
  if (fs.existsSync(certRoot)) {
    for (const tool of fs.readdirSync(certRoot).sort()) {
      const dir = path.join(certRoot, tool);
      const dirStat = fs.lstatSync(dir);
      if (dirStat.isSymbolicLink()) {
        errors.push(`${path.relative(root, dir)}: certification record directories must not be symlinks`);
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
        const file = path.join(dir, name);
        const fileStat = fs.lstatSync(file);
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          errors.push(`${path.relative(root, file)}: record must be a regular non-symlink file`);
          continue;
        }
        let evidence;
        try {
          evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          errors.push(`${path.relative(root, file)}: record must be valid JSON`);
          continue;
        }
        const source = path.relative(root, file);
        const recordErrors = validateSelfReportedRecord(evidence, source, now);
        errors.push(...recordErrors);
        if (evidence.tool !== tool) errors.push(`${source}: tool must match directory`);
        if (!tools.includes(evidence.tool)) errors.push(`${source}: tool has no shipped adapter descriptor`);
        if (recordErrors.length === 0 && evidence.tool === tool && tools.includes(evidence.tool)) selfReportedRecords += 1;
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    tools,
    structuralAdapters: tools.length,
    selfReportedRecords,
    trustedCertifications: 0,
    publicCertificationStatus: PUBLIC_CERTIFICATION_STATUS,
  };
}

if (require.main === module) {
  try {
    const result = run();
    console.log(
      `adapter-conformance: PASS(${result.structuralAdapters} structural adapters; `
      + `${result.selfReportedRecords} repository self-reported records; `
      + `${result.trustedCertifications} trusted certifications; `
      + `public status=${result.publicCertificationStatus})`,
    );
  } catch (error) {
    console.error(`adapter-conformance: FAIL\n${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  PUBLIC_CERTIFICATION_STATUS,
  SELF_REPORTED_STATUS,
  MAX_SELF_REPORT_VALIDITY_MS,
  validateAdapter,
  validateSelfReportedRecord,
  validateCertification,
  run,
};
