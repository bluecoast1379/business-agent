#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadEvalCases, runEvalSuite, validateEvalThresholds } from '../scaffold/src/evals/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { provider: 'mock' };
  const allowed = new Set(['dataset', 'thresholds', 'provider', 'output', 'mutate']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`[evals] unexpected argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!allowed.has(key)) throw new Error(`[evals] unsupported option --${rawKey}`);
    if (key === 'mutate') out.mutate = inline ?? 'output';
    else {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`[evals] --${rawKey} requires a value`);
      out[key] = value;
    }
  }
  return out;
}

function resolveInsideRoot(value, label) {
  const absolute = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[evals] ${label} must stay inside the repository`);
  }
  return absolute;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset || !args.thresholds) throw new Error('usage: run-evals.mjs --dataset <jsonl> --thresholds <json> [--provider mock] [--output <json>] [--mutate]');
  if (args.provider !== 'mock') throw new Error('[evals] CLI gate only permits deterministic provider=mock');
  const dataset = resolveInsideRoot(args.dataset, 'dataset');
  const thresholdsPath = resolveInsideRoot(args.thresholds, 'thresholds');
  const cases = await loadEvalCases(dataset);
  const thresholds = validateEvalThresholds(JSON.parse(await readFile(thresholdsPath, 'utf8')));
  if (thresholds.schemaVersion !== '1.0') throw new Error('[evals] CLI thresholds require schemaVersion 1.0');
  const report = await runEvalSuite({
    cases,
    thresholds,
    versions: { provider: 'mock-v1', dataset: path.relative(ROOT, dataset), thresholds: path.relative(ROOT, thresholdsPath) },
    execute: async (evalCase) => ({ text: args.mutate && evalCase === cases[0] ? '[mutated unsafe regression]' : (evalCase.mockOutput ?? `[mock] echo: ${evalCase.input}`), costUsd: 0 }),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const output = resolveInsideRoot(args.output, 'output');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
