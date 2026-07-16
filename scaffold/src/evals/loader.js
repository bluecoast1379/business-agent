import { readFile, stat } from 'node:fs/promises';

const MAX_DATASET_BYTES = 5 * 1024 * 1024;
const CASE_FIELDS = new Set(['schemaVersion', 'id', 'slice', 'input', 'mockOutput', 'expected']);
const EXPECTED_FIELDS = new Set(['contains', 'notContains', 'exact', 'maxCostUsd', 'safety']);

export function validateEvalCase(value, line = '?') {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('must be an object');
  for (const key of Object.keys(value ?? {})) if (!CASE_FIELDS.has(key)) errors.push(`unknown field ${key}`);
  if (value?.schemaVersion !== '1.0') errors.push('schemaVersion must be 1.0');
  if (!/^[a-z][a-z0-9._-]{2,127}$/.test(String(value?.id ?? ''))) errors.push('id is invalid');
  if (typeof value?.input !== 'string' || !value.input.trim()) errors.push('input is required');
  if (value?.slice !== undefined && !/^[a-z][a-z0-9._-]{0,63}$/.test(value.slice)) errors.push('slice is invalid');
  if (value?.mockOutput !== undefined && typeof value.mockOutput !== 'string') errors.push('mockOutput must be a string');
  if (!value?.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)) errors.push('expected is required');
  for (const key of Object.keys(value?.expected ?? {})) if (!EXPECTED_FIELDS.has(key)) errors.push(`unknown expected field ${key}`);
  for (const field of ['contains', 'notContains']) {
    if (value?.expected?.[field] !== undefined && (!Array.isArray(value.expected[field]) || value.expected[field].some((item) => typeof item !== 'string' || item.length === 0))) {
      errors.push(`expected.${field} must be a non-empty-string array`);
    }
  }
  if (value?.expected?.exact !== undefined && typeof value.expected.exact !== 'string') errors.push('expected.exact must be a string');
  if (value?.expected?.safety !== undefined && !['required', 'informational'].includes(value.expected.safety)) errors.push('expected.safety is invalid');
  if (value?.expected?.maxCostUsd !== undefined && (!Number.isFinite(value.expected.maxCostUsd) || value.expected.maxCostUsd < 0)) {
    errors.push('expected.maxCostUsd must be >= 0');
  }
  const hasAssertion = value?.expected && (
    Object.hasOwn(value.expected, 'exact')
    || Object.hasOwn(value.expected, 'maxCostUsd')
    || (value.expected.contains?.length ?? 0) > 0
    || (value.expected.notContains?.length ?? 0) > 0
  );
  if (!hasAssertion) errors.push('expected must contain at least one effective assertion');
  if (errors.length) throw new Error(`[evals] invalid case at line ${line}: ${errors.join('; ')}`);
  return value;
}

export async function loadEvalCases(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_DATASET_BYTES) throw new Error(`[evals] dataset must be a regular file no larger than ${MAX_DATASET_BYTES} bytes`);
  const text = await readFile(file, 'utf8');
  const cases = [];
  const ids = new Set();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`[evals] invalid JSON at line ${index + 1}: ${error.message}`); }
    const item = validateEvalCase(parsed, index + 1);
    if (ids.has(item.id)) throw new Error(`[evals] duplicate case id: ${item.id}`);
    ids.add(item.id);
    cases.push(item);
  }
  if (!cases.length) throw new Error('[evals] dataset is empty');
  return cases;
}
