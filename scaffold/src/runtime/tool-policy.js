import { withScope } from '../guardrails/scoped-tool.js';
import { buildToolInputSchema } from './tool.js';

export const REQUIRED_TOOL_POLICY_FIELDS = Object.freeze([
  'version',
  'audiences',
  'tenantScope',
  'dataClass',
  'effect',
  'approval',
  'idempotency',
  'timeoutMs',
  'audit',
  'outputSchema',
]);
const VALID_AUDIENCES = new Set(['operator', 'customer']);
const VALID_TENANT_SCOPES = new Set(['global', 'customer']);
const VALID_EFFECTS = new Set(['read', 'write']);
const VALID_APPROVALS = new Set(['none', 'human']);
const VALID_IDEMPOTENCY = new Set(['none', 'supported', 'required']);
const VALID_AUDIT = new Set(['metadata']);

export function validatePolicy(toolName, policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`[tool-policy] missing mandatory policy for "${toolName}"`);
  }
  const missing = REQUIRED_TOOL_POLICY_FIELDS.filter((field) => !Object.hasOwn(policy, field));
  if (missing.length > 0) {
    throw new Error(`[tool-policy] missing mandatory policy field(s) for "${toolName}": ${missing.join(', ')}`);
  }
  if (!Array.isArray(policy.audiences) || policy.audiences.length === 0 ||
      policy.audiences.some((audience) => !VALID_AUDIENCES.has(audience))) {
    throw new Error(`[tool-policy] invalid audiences for "${toolName}"`);
  }
  if (!VALID_TENANT_SCOPES.has(policy.tenantScope)) {
    throw new Error(`[tool-policy] invalid tenantScope for "${toolName}"`);
  }
  if (typeof policy.dataClass !== 'string' || !policy.dataClass) {
    throw new Error(`[tool-policy] invalid dataClass for "${toolName}"`);
  }
  if (!VALID_EFFECTS.has(policy.effect) || !VALID_APPROVALS.has(policy.approval)) {
    throw new Error(`[tool-policy] invalid effect/approval for "${toolName}"`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(policy.version))) {
    throw new Error(`[tool-policy] invalid version for "${toolName}"`);
  }
  if (!VALID_IDEMPOTENCY.has(policy.idempotency)) {
    throw new Error(`[tool-policy] invalid idempotency for "${toolName}"`);
  }
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > 300_000) {
    throw new Error(`[tool-policy] invalid timeoutMs for "${toolName}"`);
  }
  if (!VALID_AUDIT.has(policy.audit)) {
    throw new Error(`[tool-policy] audit must be metadata for "${toolName}"`);
  }
  if (!policy.outputSchema || typeof policy.outputSchema !== 'object' || Array.isArray(policy.outputSchema)) {
    throw new Error(`[tool-policy] outputSchema must be a JSON Schema object for "${toolName}"`);
  }
  if (policy.effect === 'write' && policy.approval !== 'human') {
    throw new Error(`[tool-policy] write tool "${toolName}" must require human approval`);
  }
  if (policy.effect === 'write' && policy.idempotency !== 'required') {
    throw new Error(`[tool-policy] write tool "${toolName}" must require idempotency`);
  }
  if (policy.audiences.includes('customer') && policy.tenantScope !== 'customer') {
    throw new Error(`[tool-policy] customer tool "${toolName}" must declare customer tenantScope`);
  }
  return Object.freeze({ ...policy, audiences: Object.freeze([...policy.audiences]), outputSchema: Object.freeze({ ...policy.outputSchema }) });
}

/**
 * Validate a complete manifest and return only tools allowed for the selected
 * runtime audience. Manifest omission is fatal; customer-ineligible tools are
 * excluded rather than accidentally returned unwrapped.
 */
export function applyToolPolicies(tools, manifest, { scope } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('[tool-policy] a mandatory tool policy manifest is required');
  }

  const toolNames = new Set();
  for (const tool of tools) {
    if (toolNames.has(tool.name)) throw new Error(`[tool-policy] duplicate tool "${tool.name}"`);
    toolNames.add(tool.name);
  }
  for (const manifestName of Object.keys(manifest)) {
    if (!toolNames.has(manifestName)) {
      throw new Error(`[tool-policy] manifest contains unknown tool "${manifestName}"`);
    }
  }

  const customerMode = Boolean(scope?.customerId);
  const registered = [];
  for (const tool of tools) {
    const policy = validatePolicy(tool.name, manifest[tool.name]);
    if (policy.effect === 'write' && tool.humanApprovalRequired !== true) {
      throw new Error(`[tool-policy] write tool "${tool.name}" must be wrapped by the human confirmation gate`);
    }
    const classified = {
      ...tool,
      policy,
      inputSchema: Object.freeze(buildToolInputSchema(tool.params)),
      outputSchema: policy.outputSchema,
    };
    if (!customerMode) {
      registered.push(classified);
      continue;
    }
    if (!policy.audiences.includes('customer')) continue;
    registered.push(withScope(classified, { customerId: scope.customerId }));
  }
  return registered;
}
