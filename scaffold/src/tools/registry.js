import { applyToolPolicies } from '../runtime/tool-policy.js';
import { validateArgs, validateJsonSchema } from '../runtime/tool.js';
import { hasScope } from '../auth/principal.js';

function audienceFor(principal) {
  const roles = new Set(principal?.roles ?? []);
  if (roles.has('admin') || roles.has('operator') || roles.has('service')) return 'operator';
  return 'customer';
}

function isElevated(principal) {
  return principal?.roles?.includes('admin') || hasScope(principal, 'tools:cross-tenant');
}

function canUseGlobalTool(principal) {
  // A tenant-scoped operator is not implicitly a platform operator. Global
  // business-data tools require an admin/explicit scope, or a deliberately
  // tenantless operator/service principal configured by the server.
  return isElevated(principal)
    || (principal?.tenantId == null && principal?.roles?.some((role) => ['operator', 'service'].includes(role)));
}

function unknownWriteError(rawError) {
  if (rawError?.unknownOutcome === false) return rawError;
  const error = rawError instanceof Error
    ? rawError
    : new Error('[tools] write handler failed with a non-Error value');
  error.code ??= 'TOOL_WRITE_OUTCOME_UNKNOWN';
  error.retryable = false;
  error.unknownOutcome = true;
  error.reconciliationRequired = true;
  return error;
}

export function createToolRegistry({ tools, manifest, executor, audit } = {}) {
  const classified = applyToolPolicies(tools ?? [], manifest, {});
  const byName = new Map(classified.map((tool) => [tool.name, tool]));

  function listForPrincipal(principal) {
    const audience = audienceFor(principal);
    return classified.filter((tool) => {
      if (!tool.policy.audiences.includes(audience)) return false;
      if (tool.policy.tenantScope === 'global' && !canUseGlobalTool(principal)) return false;
      // Customer-scoped tools require a server-authenticated tenant unless the
      // principal is explicitly allowed to operate across tenants. This keeps
      // the model from learning about tools it could never safely execute.
      if (tool.policy.tenantScope === 'customer' && !principal?.tenantId && !isElevated(principal)) return false;
      return true;
    }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      params: tool.params,
      outputSchema: tool.outputSchema,
      policy: tool.policy,
    }));
  }

  async function execute(name, args = {}, { principal, signal, idempotencyKey } = {}) {
    const tool = byName.get(name);
    if (!tool) throw Object.assign(new Error(`[tools] unknown tool ${name}`), { code: 'TOOL_NOT_FOUND' });
    const audience = audienceFor(principal);
    if (!tool.policy.audiences.includes(audience)) throw Object.assign(new Error('[tools] forbidden'), { code: 'TOOL_FORBIDDEN' });
    if (tool.policy.tenantScope === 'global' && !canUseGlobalTool(principal)) {
      throw Object.assign(new Error('[tools] global scope requires a platform principal'), { code: 'TOOL_CROSS_TENANT_FORBIDDEN' });
    }
    let scopedArgs = args;
    if (tool.policy.tenantScope === 'customer') {
      const declaresCustomerId = Object.hasOwn(tool.params?.properties ?? {}, 'customerId');
      // Tenant identity is injected only when it is part of the declared tool
      // contract. Otherwise it remains trusted execution context and must not
      // be smuggled into a strict argument object (including confirmation-only
      // phase-two calls).
      if (principal?.tenantId) {
        if (declaresCustomerId) scopedArgs = { ...args, customerId: principal.tenantId };
      } else if (!isElevated(principal)) {
        throw Object.assign(new Error('[tools] trusted tenant is required'), { code: 'TENANT_REQUIRED' });
      }
    }
    const input = validateArgs(tool, scopedArgs);
    if (!input.ok) throw Object.assign(new Error(`[tools] invalid input: ${input.errors.join('; ')}`), { code: 'TOOL_INPUT_INVALID' });
    if (tool.policy.idempotency === 'required' && !idempotencyKey) throw Object.assign(new Error('[tools] idempotency key required'), { code: 'IDEMPOTENCY_REQUIRED' });
    // The pre-effect record is itself the atomic capacity reservation. Never
    // replace this with `capacity()` followed by a later append: that would
    // allow concurrent executions to race for the last ledger slot. When the
    // configured ledger is unavailable/full, the tool must fail closed before
    // either a read or write handler is invoked.
    const auditStart = typeof audit?.start === 'function'
      ? await audit.start({
          actor: principal?.subjectId,
          tenant: principal?.tenantId,
          action: 'tool.execute',
          resource: name,
          idempotencyKey,
          metadata: { policyDecision: 'allow', effect: tool.policy.effect },
        })
      : typeof audit?.append === 'function'
        ? await audit.append({
            actor: principal?.subjectId,
            tenant: principal?.tenantId,
            action: 'tool.execute',
            resource: name,
            outcome: 'started',
            idempotencyKey,
            metadata: { policyDecision: 'allow', effect: tool.policy.effect, auditPhase: 'pre-effect' },
          })
        : null;
    const operation = async ({ signal: executionSignal } = {}) => tool.handler(scopedArgs, { principal, signal: executionSignal ?? signal, idempotencyKey });
    let result;
    if (executor) {
      result = (await executor.execute({
        name: `tool.${name}`,
        operation,
        signal,
        timeoutMs: tool.policy.timeoutMs,
        idempotencyKey,
        idempotent: tool.policy.idempotency !== 'none',
        retry: tool.policy.idempotency !== 'none',
        unknownOnUnclassifiedError: tool.policy.effect === 'write',
        context: { tenantId: principal?.tenantId, subjectId: principal?.subjectId, tool: name },
      })).value;
    } else {
      try {
        result = await operation({ signal });
      } catch (error) {
        throw tool.policy.effect === 'write' ? unknownWriteError(error) : error;
      }
    }
    const outputErrors = validateJsonSchema(result, tool.outputSchema, 'result');
    if (outputErrors.length) throw Object.assign(new Error(`[tools] invalid output: ${outputErrors.join('; ')}`), {
      code: 'TOOL_OUTPUT_INVALID',
      unknownOutcome: tool.policy.effect === 'write',
      statusCode: tool.policy.effect === 'write' ? 409 : 500,
    });
    try {
      await audit?.append?.({
        actor: principal?.subjectId,
        tenant: principal?.tenantId,
        action: 'tool.execute',
        resource: name,
        outcome: 'ok',
        idempotencyKey,
        metadata: { policyDecision: 'allow', auditStartId: auditStart?.id },
      });
    } catch (error) {
      // The side effect/result is already committed behind the idempotency
      // boundary. Never turn an audit transport failure into a retry signal.
      console.error(`[audit] tool event append failed code=${error.code ?? error.name ?? 'ERROR'}`);
    }
    return result;
  }

  return Object.freeze({ listForPrincipal, execute, get: (name) => byName.get(name) });
}
