#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compileBlueprint } from '../scaffold/src/workflows/index.js';

const require = createRequire(import.meta.url);
const { parseYaml } = require('./check-command-manifest.cjs');

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[argv[index]?.replace(/^--/, '')] = argv[index + 1];
  if (!out.agent || !out.workflow || !out.output) throw new Error('usage: compile-blueprint.mjs --agent <agent.yaml> --workflow <workflow.yaml> --output <lock.json>');
  return out;
}

async function load(file) {
  const text = await readFile(file, 'utf8');
  try { return JSON.parse(text); } catch { return parseYaml(text, file); }
}

async function main() {
  const options = args(process.argv.slice(2));
  const lock = compileBlueprint({ agent: await load(options.agent), workflow: await load(options.workflow) });
  await writeFile(options.output, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  console.log(`compiled ${path.basename(options.agent)} + ${path.basename(options.workflow)} -> ${options.output} (${lock.sourceDigest})`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
