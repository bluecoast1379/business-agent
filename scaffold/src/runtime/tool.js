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

/**
 * Validate args against the tool's params schema.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateArgs(tool, args = {}) {
  const errors = [];
  const { properties = {}, required = [] } = tool.params ?? {};

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) errors.push(`missing required param "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (!schema || value === undefined || value === null) continue;
    const check = CHECKS[schema.type];
    if (check && !check(value)) errors.push(`param "${key}" should be ${schema.type}`);
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`param "${key}" must be one of: ${schema.enum.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
