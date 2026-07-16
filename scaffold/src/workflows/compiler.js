import { createHash } from 'node:crypto';
import { validateAgentBlueprint, validateWorkflow } from './validator.js';

function compilerInputError(message) {
  return Object.assign(new Error(`[blueprint] ${message}`), { code: 'BLUEPRINT_INPUT_INVALID' });
}

function canonical(value, path = 'source', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw compilerInputError(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') {
    throw compilerInputError(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw compilerInputError(`${path} contains a circular reference`);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) {
      throw compilerInputError(`${path} must be a dense data array`);
    }
    result = `[${Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw compilerInputError(`${path} must be a dense data array`);
      }
      return canonical(descriptor.value, `${path}[${index}]`, ancestors);
    }).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw compilerInputError(`${path} must be a plain data object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw compilerInputError(`${path} contains symbol properties`);
    const pairs = keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw compilerInputError(`${path}.${key} must be an enumerable data property`);
      }
      return `${JSON.stringify(key)}:${canonical(descriptor.value, `${path}.${key}`, ancestors)}`;
    });
    result = `{${pairs.join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

export function digestWorkflow(workflow) {
  validateWorkflow(workflow);
  return `sha256:${createHash('sha256').update(canonical(workflow, 'workflow')).digest('hex')}`;
}

export function compileBlueprint({ agent, workflow }) {
  validateAgentBlueprint(agent);
  validateWorkflow(workflow);
  const source = { agent, workflow };
  const canonicalSource = canonical(source);
  // Parsing the validated canonical representation guarantees a detached lock.
  const cloned = JSON.parse(canonicalSource);
  return {
    schemaVersion: '1.0',
    kind: 'business-agent-lock',
    sourceDigest: `sha256:${createHash('sha256').update(canonicalSource).digest('hex')}`,
    agent: cloned.agent,
    workflow: cloned.workflow,
  };
}
