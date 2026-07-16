/**
 * Tool definition + hand-written argument validation (JSON-schema subset:
 * type / required / enum). Zero dependencies by design.
 */

const CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function validateJsonSchema(value, schema = {}, path = 'value') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path} schema must be an object`];
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length && !types.some((type) => type === 'null' ? value === null : CHECKS[type]?.(value))) {
    errors.push(`${path} should be ${types.join('|')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (value[key] === undefined || value[key] === null) errors.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) errors.push(`${path}.${key} is not allowed`);
      else if (Object.hasOwn(properties, key)) errors.push(...validateJsonSchema(item, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

/**
 * Define a tool.
 * @param {object} spec
 * @param {string} spec.name - snake_case tool name exposed to the LLM
 * @param {string} spec.description - LLM-facing description (include what the result contains)
 * @param {{properties?: object, required?: string[]}} [spec.params] - JSON-schema subset
 * @param {(args: object) => Promise<any>|any} spec.handler
 */
export function defineTool({ name, description, params = { properties: {}, required: [] }, handler }) {
  if (!name || typeof handler !== 'function') {
    throw new Error('[tool] defineTool requires a name and a handler function');
  }
  return { name, description: description ?? '', params, handler };
}

function strictSchema(schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const normalized = { ...schema };
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const properties = Object.create(null);
    for (const [key, value] of Object.entries(schema.properties)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) throw new Error(`[tool] schema property "${key}" is forbidden`);
      properties[key] = strictSchema(value);
    }
    normalized.properties = properties;
  }
  if (schema.items) normalized.items = strictSchema(schema.items);
  if (schema.type === 'object' || schema.properties) normalized.additionalProperties = false;
  return normalized;
}

/** Build the exact model/runtime input contract. Undeclared fields are denied
 * recursively so hidden downstream flags cannot bypass the manifest. */
export function buildToolInputSchema(params = {}) {
  return strictSchema({
    ...params,
    type: 'object',
    properties: params?.properties ?? {},
    required: params?.required ?? [],
    additionalProperties: false,
  });
}

/**
 * Validate args against the tool's params schema.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateArgs(tool, args = {}) {
  const errors = validateJsonSchema(args, buildToolInputSchema(tool.params), 'args')
    .map((message) => message.replace(/^args\.([^ ]+) is required$/, 'missing required param "$1"'));
  return { ok: errors.length === 0, errors };
}
