#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEvalCases, runEvalSuite } from '../scaffold/src/evals/index.js';
import { validateJsonSchema } from '../scaffold/src/runtime/tool.js';
import { REQUIRED_TOOL_POLICY_FIELDS, validatePolicy } from '../scaffold/src/runtime/tool-policy.js';
import { compileBlueprint } from '../scaffold/src/workflows/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INDEX = path.join(ROOT, 'examples', 'templates', 'index.json');
const REQUIRED_PACK_FILES = Object.freeze([
  'README.md',
  'agent.json',
  'evals.jsonl',
  'thresholds.json',
  'tool-manifest.json',
  'workflow.json',
]);
const SEMVER = /^\d+\.\d+\.\d+$/;
const TEMPLATE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, context) {
  if (!isObject(value)) throw new Error(`${context} must be an object`);
  const expected = new Set(allowed);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) throw new Error(`${context} missing required field(s): ${missing.join(', ')}`);
  if (unknown.length) throw new Error(`${context} contains unknown field(s): ${unknown.join(', ')}`);
}

async function readJson(file, context) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`${context} cannot be read: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} is invalid JSON: ${error.message}`);
  }
}

function assertAgainstSchema(value, schema, context) {
  const errors = validateJsonSchema(value, schema, context);
  if (errors.length) throw new Error(`${context} schema validation failed: ${errors.join('; ')}`);
}

function assertSchemaObject(schema, context) {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) {
    throw new Error(`${context} must be an object JSON Schema with properties`);
  }
  if (schema.additionalProperties !== false) {
    throw new Error(`${context}.additionalProperties must be false`);
  }
  if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length) {
    throw new Error(`${context}.required must be a unique string array`);
  }
  for (const key of schema.required) {
    if (typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) {
      throw new Error(`${context}.required references unknown property ${String(key)}`);
    }
  }
}

function assertRate(value, context) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${context} must be between 0 and 1`);
  }
}

function validateThresholds(thresholds, cases, context) {
  assertExactKeys(thresholds, [
    'schemaVersion',
    'passRateMin',
    'safetyPassRateMin',
    'maxAverageCostUsd',
    'slicePassRateMin',
  ], context);
  if (thresholds.schemaVersion !== '1.0') throw new Error(`${context}.schemaVersion must be 1.0`);
  assertRate(thresholds.passRateMin, `${context}.passRateMin`);
  assertRate(thresholds.safetyPassRateMin, `${context}.safetyPassRateMin`);
  if (!Number.isFinite(thresholds.maxAverageCostUsd) || thresholds.maxAverageCostUsd < 0) {
    throw new Error(`${context}.maxAverageCostUsd must be >= 0`);
  }
  if (!isObject(thresholds.slicePassRateMin) || Object.keys(thresholds.slicePassRateMin).length === 0) {
    throw new Error(`${context}.slicePassRateMin must be a non-empty object`);
  }
  for (const [slice, minimum] of Object.entries(thresholds.slicePassRateMin)) {
    if (!slice) throw new Error(`${context}.slicePassRateMin contains an empty slice`);
    assertRate(minimum, `${context}.slicePassRateMin.${slice}`);
  }
  const caseSlices = new Set();
  for (const evalCase of cases) {
    if (typeof evalCase.slice !== 'string' || !evalCase.slice) throw new Error(`${context}: eval ${evalCase.id} must declare a slice`);
    if (typeof evalCase.mockOutput !== 'string' || !evalCase.mockOutput) throw new Error(`${context}: eval ${evalCase.id} must declare deterministic mockOutput`);
    caseSlices.add(evalCase.slice);
  }
  for (const slice of caseSlices) {
    if (!Object.hasOwn(thresholds.slicePassRateMin, slice)) {
      throw new Error(`${context}.slicePassRateMin is missing eval slice ${slice}`);
    }
  }
  for (const slice of Object.keys(thresholds.slicePassRateMin)) {
    if (!caseSlices.has(slice)) throw new Error(`${context}.slicePassRateMin references empty slice ${slice}`);
  }
  const hasSafetyCase = cases.some((evalCase) =>
    evalCase.expected?.safety === 'required' && (evalCase.expected?.notContains?.length ?? 0) > 0);
  if (!hasSafetyCase) throw new Error(`${context}: at least one required safety case with notContains is mandatory`);
}

function validateToolManifest(manifest, entry) {
  const context = `template ${entry.id} tool-manifest`;
  assertExactKeys(manifest, ['schemaVersion', 'id', 'version', 'tools'], context);
  if (manifest.schemaVersion !== '1.0') throw new Error(`${context}.schemaVersion must be 1.0`);
  if (manifest.id !== `${entry.id}-toolpack`) throw new Error(`${context}.id must be ${entry.id}-toolpack`);
  if (manifest.version !== entry.version) throw new Error(`${context}.version must match index version`);
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) throw new Error(`${context}.tools must be non-empty`);

  const names = new Set();
  for (const [index, tool] of manifest.tools.entries()) {
    const toolContext = `${context}.tools[${index}]`;
    assertExactKeys(tool, ['name', 'description', 'inputSchema', 'policy'], toolContext);
    if (!TOOL_NAME.test(String(tool.name ?? ''))) throw new Error(`${toolContext}.name is invalid`);
    if (names.has(tool.name)) throw new Error(`${context} contains duplicate tool ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error(`${toolContext}.description is required`);
    assertSchemaObject(tool.inputSchema, `${toolContext}.inputSchema`);
    assertExactKeys(tool.policy, REQUIRED_TOOL_POLICY_FIELDS, `${toolContext}.policy`);
    const policy = validatePolicy(tool.name, tool.policy);
    if (policy.version !== entry.version) throw new Error(`${toolContext}.policy.version must match template version`);
    assertSchemaObject(policy.outputSchema, `${toolContext}.policy.outputSchema`);
  }
  return [...names];
}

function validateIndex(index) {
  assertExactKeys(index, ['schemaVersion', 'kind', 'templates'], 'templates index');
  if (index.schemaVersion !== '1.0') throw new Error('templates index schemaVersion must be 1.0');
  if (index.kind !== 'business-agent-template-index') throw new Error('templates index kind is invalid');
  if (!Array.isArray(index.templates) || index.templates.length === 0) throw new Error('templates index must contain templates');
  const ids = new Set();
  const paths = new Set();
  for (const [position, entry] of index.templates.entries()) {
    const context = `templates index entry ${position}`;
    assertExactKeys(entry, ['id', 'industry', 'version', 'path'], context);
    if (!TEMPLATE_ID.test(String(entry.id ?? ''))) throw new Error(`${context}.id is invalid`);
    if (ids.has(entry.id)) throw new Error(`templates index contains duplicate id ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.industry !== 'string' || !entry.industry) throw new Error(`${context}.industry is required`);
    if (!SEMVER.test(String(entry.version ?? ''))) throw new Error(`${context}.version must be semver`);
    if (entry.path !== `${entry.id}/${entry.version}` || entry.path.includes('\\') || path.posix.normalize(entry.path) !== entry.path) {
      throw new Error(`${context}.path must be the canonical version directory ${entry.id}/${entry.version}`);
    }
    if (paths.has(entry.path)) throw new Error(`templates index contains duplicate path ${entry.path}`);
    paths.add(entry.path);
  }
  return index;
}

async function loadSchemas() {
  const schemaDir = path.join(ROOT, 'kit', 'core', 'schemas');
  const [agent, workflow, evalCase] = await Promise.all([
    readJson(path.join(schemaDir, 'agent.schema.json'), 'agent schema'),
    readJson(path.join(schemaDir, 'workflow.schema.json'), 'workflow schema'),
    readJson(path.join(schemaDir, 'eval-case.schema.json'), 'eval-case schema'),
  ]);
  return { agent, workflow, evalCase };
}

async function validatePackageFiles(packDir, entry, indexDir) {
  try {
    const [indexReal, idReal, packReal, idStat, packStat] = await Promise.all([
      realpath(indexDir),
      realpath(path.join(indexDir, entry.id)),
      realpath(packDir),
      lstat(path.join(indexDir, entry.id)),
      lstat(packDir),
    ]);
    if (idStat.isSymbolicLink() || packStat.isSymbolicLink() || !idStat.isDirectory() || !packStat.isDirectory()) {
      throw new Error('version path must use regular directories');
    }
    if (idReal !== path.join(indexReal, entry.id) || !packReal.startsWith(`${indexReal}${path.sep}`)) {
      throw new Error('resolved path escapes its index directory');
    }
  } catch (error) {
    throw new Error(`template ${entry.id} directory is invalid: ${error.code ?? error.message}`);
  }
  let entries;
  try {
    entries = await readdir(packDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`template ${entry.id} directory cannot be read: ${error.code ?? error.message}`);
  }
  const actual = entries.map((item) => item.name).sort();
  const unexpected = actual.filter((name) => !REQUIRED_PACK_FILES.includes(name));
  const missing = REQUIRED_PACK_FILES.filter((name) => !actual.includes(name));
  if (missing.length) throw new Error(`template ${entry.id} missing file(s): ${missing.join(', ')}`);
  if (unexpected.length) throw new Error(`template ${entry.id} contains unexpected file(s): ${unexpected.join(', ')}`);
  for (const item of entries) {
    if (!item.isFile()) throw new Error(`template ${entry.id}/${item.name} must be a regular file`);
  }
}

async function validateEntry({ entry, indexDir, schemas }) {
  const packDir = path.resolve(indexDir, entry.path);
  if (!packDir.startsWith(`${path.resolve(indexDir)}${path.sep}`)) throw new Error(`template ${entry.id} path escapes index directory`);
  await validatePackageFiles(packDir, entry, indexDir);
  const agentPath = path.join(packDir, 'agent.json');
  const workflowPath = path.join(packDir, 'workflow.json');
  const manifestPath = path.join(packDir, 'tool-manifest.json');
  const evalPath = path.join(packDir, 'evals.jsonl');
  const thresholdsPath = path.join(packDir, 'thresholds.json');
  const readmePath = path.join(packDir, 'README.md');
  const [agent, workflow, manifest, thresholds, cases, readme] = await Promise.all([
    readJson(agentPath, `template ${entry.id} agent`),
    readJson(workflowPath, `template ${entry.id} workflow`),
    readJson(manifestPath, `template ${entry.id} tool-manifest`),
    readJson(thresholdsPath, `template ${entry.id} thresholds`),
    loadEvalCases(evalPath),
    readFile(readmePath, 'utf8'),
  ]);

  assertAgainstSchema(agent, schemas.agent, `template ${entry.id} agent`);
  assertAgainstSchema(workflow, schemas.workflow, `template ${entry.id} workflow`);
  const lock = compileBlueprint({ agent, workflow });
  if (agent.version !== entry.version || workflow.version !== entry.version) {
    throw new Error(`template ${entry.id} blueprint versions must match index version ${entry.version}`);
  }
  const manifestTools = validateToolManifest(manifest, entry).sort();
  const agentTools = [...agent.tools].sort();
  if (JSON.stringify(manifestTools) !== JSON.stringify(agentTools)) {
    throw new Error(`template ${entry.id} agent tools must exactly match tool-manifest tools`);
  }
  for (const evalCase of cases) assertAgainstSchema(evalCase, schemas.evalCase, `template ${entry.id} eval ${evalCase.id}`);
  validateThresholds(thresholds, cases, `template ${entry.id} thresholds`);
  if (!/fictional/i.test(readme) || !readme.includes(entry.version)) {
    throw new Error(`template ${entry.id} README must declare its fictional status and version`);
  }

  return {
    report: {
      id: entry.id,
      industry: entry.industry,
      version: entry.version,
      path: entry.path,
      sourceDigest: lock.sourceDigest,
      toolCount: manifestTools.length,
      evalCaseCount: cases.length,
      slices: [...new Set(cases.map((evalCase) => evalCase.slice))].sort(),
    },
    cases,
    thresholds,
    evalPath,
    thresholdsPath,
  };
}

async function collectValidated({ indexPath = DEFAULT_INDEX, templateId } = {}) {
  const resolvedIndex = path.isAbsolute(indexPath) ? indexPath : path.resolve(ROOT, indexPath);
  const index = validateIndex(await readJson(resolvedIndex, 'templates index'));
  let entries = index.templates;
  if (templateId) {
    entries = entries.filter((entry) => entry.id === templateId);
    if (entries.length !== 1) throw new Error(`unknown template: ${templateId}`);
  }
  const schemas = await loadSchemas();
  const indexDir = path.dirname(resolvedIndex);
  const validated = [];
  for (const entry of entries) validated.push(await validateEntry({ entry, indexDir, schemas }));
  return { resolvedIndex, validated };
}

export async function validateTemplateMatrix(options = {}) {
  const { resolvedIndex, validated } = await collectValidated(options);
  return {
    schemaVersion: '1.0',
    kind: 'business-agent-template-matrix',
    mode: 'validate',
    passed: true,
    indexDigest: `sha256:${createHash('sha256').update(await readFile(resolvedIndex)).digest('hex')}`,
    summary: { total: validated.length, validated: validated.length, evalPassed: 0 },
    templates: validated.map((item) => item.report),
  };
}

export async function runTemplateMatrix(options = {}) {
  const { resolvedIndex, validated } = await collectValidated(options);
  const templates = [];
  for (const item of validated) {
    const evaluation = await runEvalSuite({
      cases: item.cases,
      thresholds: item.thresholds,
      versions: {
        provider: 'mock-v1',
        template: `${item.report.id}@${item.report.version}`,
        dataset: path.relative(ROOT, item.evalPath),
        thresholds: path.relative(ROOT, item.thresholdsPath),
      },
      execute: async (evalCase) => ({ text: evalCase.mockOutput, costUsd: 0 }),
    });
    templates.push({
      ...item.report,
      evaluation: {
        passed: evaluation.passed,
        summary: evaluation.summary,
        versions: evaluation.versions,
      },
    });
  }
  const evalPassed = templates.filter((item) => item.evaluation.passed).length;
  return {
    schemaVersion: '1.0',
    kind: 'business-agent-template-matrix',
    mode: 'run',
    passed: evalPassed === templates.length,
    indexDigest: `sha256:${createHash('sha256').update(await readFile(resolvedIndex)).digest('hex')}`,
    summary: { total: templates.length, validated: templates.length, evalPassed },
    templates,
  };
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!['validate', 'run'].includes(command)) {
    throw new Error('usage: run-template-matrix.mjs <validate|run> [--template <id>] [--index <path>] [--output <json>]');
  }
  const options = {};
  while (argv.length) {
    const flag = argv.shift();
    if (!['--template', '--index', '--output'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--template') options.templateId = value;
    if (flag === '--index') options.indexPath = value;
    if (flag === '--output') options.output = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const report = command === 'validate'
    ? await validateTemplateMatrix(options)
    : await runTemplateMatrix(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const output = path.isAbsolute(options.output) ? options.output : path.resolve(ROOT, options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[templates] ${error.message}`);
    process.exit(1);
  });
}
