/**
 * Agent runtime: the tool-call loop around a provider.
 *  - capped by maxTurns;
 *  - every turn's usage is reported to the cost tracker (wired, not decorative);
 *  - when the per-request budget (maxBudgetUsd) is exceeded, the loop stops and
 *    returns whatever content was produced so far, plus a notice.
 */
import { createHash } from 'node:crypto';
import { assertProviderResult } from '../providers/contract.js';
import { computeCostUsd } from './llm.js';
import { validateArgs } from './tool.js';

function stringifyResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function inputDigest(value) {
  return createHash('sha256').update(stable(value)).digest('hex').slice(0, 24);
}

function fullInputDigest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

const RECONCILIATION_CODES = new Set([
  'TIMEOUT',
  'ABORTED',
  'IDEMPOTENCY_UNKNOWN',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OWNERSHIP_LOST',
]);

// Serialized UTF-8 bytes are a conservative upper bound for ordinary provider
// tokenizer output. The fixed/per-item allowance covers provider wrappers,
// role markers, and tool-schema framing that are not present in our JSON value.
const PROVIDER_INPUT_BASE_OVERHEAD_TOKENS = 2_048;
const PROVIDER_INPUT_MESSAGE_OVERHEAD_TOKENS = 64;
const PROVIDER_INPUT_TOOL_OVERHEAD_TOKENS = 256;
const PROVIDER_RETRY_CACHE_TTL_MS = 5 * 60_000;
const PROVIDER_RETRY_CACHE_MAX = 1_000;
const PROVIDER_RETRY_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
const PROVIDER_RETRY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export function estimateProviderInputTokenCeiling({ model, system, messages, tools }) {
  let serialized;
  try {
    serialized = JSON.stringify({ model, system: system ?? '', messages, tools });
  } catch (error) {
    throw new TypeError(`[agent] provider request must be JSON serializable: ${error.message}`);
  }
  const bytes = Buffer.byteLength(serialized ?? '');
  const ceiling = bytes
    + PROVIDER_INPUT_BASE_OVERHEAD_TOKENS
    + (Array.isArray(messages) ? messages.length * PROVIDER_INPUT_MESSAGE_OVERHEAD_TOKENS : 0)
    + (Array.isArray(tools) ? tools.length * PROVIDER_INPUT_TOOL_OVERHEAD_TOKENS : 0);
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new Error('[agent] provider input token ceiling is invalid');
  return ceiling;
}

function needsReconciliation(error, signal) {
  return signal?.aborted || error?.unknownOutcome === true || RECONCILIATION_CODES.has(error?.code);
}

function unknownCostError(rawError) {
  const error = rawError instanceof Error ? rawError : new Error('[agent] provider cost accounting failed');
  try {
    error.code ??= 'COST_ACCOUNTING_UNKNOWN';
    error.unknownOutcome = true;
    error.reconciliationRequired = true;
    error.retryable = false;
    return error;
  } catch {
    return Object.assign(new Error('[agent] provider cost accounting could not be confirmed', { cause: error }), {
      code: 'COST_ACCOUNTING_UNKNOWN',
      unknownOutcome: true,
      reconciliationRequired: true,
      retryable: false,
    });
  }
}

function publicToolError(error) {
  const candidate = error?.code;
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_-]{0,63}$/.test(candidate)
    ? candidate
    : 'TOOL_EXECUTION_FAILED';
  // Driver messages routinely contain DSNs, SQL, filesystem paths or business
  // rows. Only a stable code crosses the provider transcript boundary.
  return `Error: tool execution failed (${code})`;
}

async function executeToolCall(toolAccess, availableTools, call, { executor, signal, requestId, operationId, principal, telemetry, telemetryContext } = {}) {
  const tool = availableTools.find((t) => t.name === call.name);
  if (!tool) return { content: `Error: unknown tool "${call.name}"`, isError: true };
  if (!toolAccess?.execute) {
    const { ok, errors } = validateArgs(tool, call.args);
    if (!ok) return { content: `Error: invalid arguments: ${errors.join('; ')}`, isError: true };
  }
  try {
    const span = telemetry?.startSpan?.('agent.tool', { ...(telemetryContext ?? {}), attributes: { requestId, tool: call.name, tenantId: principal?.tenantId } });
    let result;
    try {
      if (toolAccess?.execute) {
        result = await toolAccess.execute(call.name, call.args ?? {}, {
          principal,
          signal,
          idempotencyKey: tool.policy?.idempotency && tool.policy.idempotency !== 'none'
            ? `${operationId ?? 'agent'}:tool:${call.name}:${call.id}:${inputDigest(call.args ?? {})}`
            : undefined,
        });
      } else if (executor) {
        const operation = ({ signal: executionSignal } = {}) => tool.handler(call.args ?? {}, { signal: executionSignal ?? signal, principal });
        const idempotent = tool.policy?.idempotency && tool.policy.idempotency !== 'none';
        result = (await executor.execute({
          name: `tool.${call.name}`,
          operation,
          signal,
          timeoutMs: tool.policy?.timeoutMs ?? 30_000,
          idempotent,
          idempotencyKey: idempotent ? `${operationId ?? 'agent'}:tool:${call.name}:${call.id}:${inputDigest(call.args ?? {})}` : undefined,
          retry: idempotent,
          context: { requestId, tool: call.name, tenantId: principal?.tenantId },
        })).value;
      } else result = await tool.handler(call.args ?? {}, { signal, principal });
      span?.end?.({ outcome: 'ok' });
    } catch (error) {
      span?.end?.({ outcome: 'error', error });
      throw error;
    }
    return { content: stringifyResult(result), isError: false };
  } catch (err) {
    if (needsReconciliation(err, signal)) {
      err.unknownOutcome = true;
      err.reconciliationRequired = true;
      err.statusCode ??= err.code === 'TIMEOUT' ? 504 : 409;
      throw err;
    }
    return { content: publicToolError(err), isError: true };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.model
 * @param {string|(() => string)} opts.systemPrompt - a function is re-evaluated on
 *   every prompt() call (so dates / runtime-loaded knowledge stay fresh).
 * @param {Array} [opts.tools]
 * @param {number} [opts.maxBudgetUsd] - per-request budget cap
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxTokens]
 * @param {object} opts.provider
 * @param {object} opts.costTracker
 * @param {object} [opts.priceTable]
 * @returns {{ name: string, prompt: (text: string, opts?: {sessionMessages?: Array, reservationId?: string}) => Promise<{text, messages, costUsd, turns}> }}
 */
export function createAgent({
  name,
  model,
  systemPrompt,
  tools = [],
  maxBudgetUsd = 0.5,
  maxTurns = 8,
  maxTokens = 1024,
  provider,
  costTracker,
  priceTable = {},
  executor,
  telemetry,
}) {
  if (!provider) throw new Error('[agent] provider is required');
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw new Error('[agent] maxBudgetUsd must be finite and positive');
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('[agent] maxTurns must be a positive safe integer');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('[agent] maxTokens must be a positive safe integer');
  // Same-process retry evidence avoids paying for or regenerating a provider
  // turn when the following tool outcome is unknown. It is deliberately
  // memory-only, short-lived, and bounded: provider/customer content is never
  // written to the durable idempotency namespace.
  const providerRetryCache = new Map();
  let providerRetryCacheBytes = 0;

  function forgetProviderResult(key) {
    const entry = providerRetryCache.get(key);
    if (!entry) return;
    providerRetryCache.delete(key);
    providerRetryCacheBytes = Math.max(0, providerRetryCacheBytes - entry.bytes);
  }

  function cachedProviderResult(key, requestDigest) {
    if (!key) return null;
    const entry = providerRetryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      forgetProviderResult(key);
      return null;
    }
    if (entry.requestDigest !== requestDigest) {
      const error = new Error('The operation id was reused for a different provider request');
      error.code = 'PROVIDER_OPERATION_CONFLICT';
      error.statusCode = 409;
      throw error;
    }
    return structuredClone(entry.value);
  }

  function rememberProviderResult(key, requestDigest, value) {
    if (!key) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > PROVIDER_RETRY_CACHE_MAX_ENTRY_BYTES || bytes > PROVIDER_RETRY_CACHE_MAX_BYTES) return;
    const at = Date.now();
    for (const [candidate, entry] of providerRetryCache) {
      if (entry.expiresAt <= at) forgetProviderResult(candidate);
    }
    forgetProviderResult(key);
    while (providerRetryCache.size >= PROVIDER_RETRY_CACHE_MAX
        || providerRetryCacheBytes + bytes > PROVIDER_RETRY_CACHE_MAX_BYTES) {
      forgetProviderResult(providerRetryCache.keys().next().value);
    }
    providerRetryCache.set(key, { requestDigest, value: structuredClone(value), bytes, expiresAt: at + PROVIDER_RETRY_CACHE_TTL_MS });
    providerRetryCacheBytes += bytes;
  }

  async function prompt(text, { sessionMessages = [], reservationId, signal, principal, requestId, operationId, telemetryContext } = {}) {
    // System prompt is assembled per request, never at module load time.
    const system = typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt;
    const messages = [...sessionMessages, { role: 'user', content: text }];
    const partials = [];
    let spentUsd = 0;
    let turns = 0;
    const availableTools = typeof tools?.listForPrincipal === 'function'
      ? tools.listForPrincipal(principal)
      : tools;

    while (turns < maxTurns) {
      const providerRetryKey = operationId
        ? fullInputDigest([
            operationId,
            turns + 1,
            model,
            principal?.tenantId ?? null,
            principal?.subjectId ?? null,
          ])
        : null;
      const providerRequestDigest = providerRetryKey
        ? fullInputDigest({ system, messages, tools: availableTools, maxTokens })
        : null;
      const cachedResult = cachedProviderResult(providerRetryKey, providerRequestDigest);
      const maxInputTokens = estimateProviderInputTokenCeiling({ model, system, messages, tools: availableTools });
      const maximumCallCostUsd = computeCostUsd(model, {
        input_tokens: maxInputTokens,
        output_tokens: maxTokens,
      }, priceTable);
      const remainingBudgetUsd = Math.max(0, maxBudgetUsd - spentUsd);
      if (!cachedResult && maximumCallCostUsd > remainingBudgetUsd) {
        const notice = `[notice] The remaining request budget ($${remainingBudgetUsd.toFixed(4)}) cannot safely cover the next provider call (maximum $${maximumCallCostUsd.toFixed(4)}). No additional model call was made.`;
        const textOut = [...partials, notice].join('\n\n');
        messages.push({ role: 'assistant', content: textOut });
        return { text: textOut, messages, costUsd: spentUsd, turns };
      }
      turns += 1;
      const providerSpan = telemetry?.startSpan?.('agent.provider', { ...(telemetryContext ?? {}), attributes: { requestId, provider: provider.name, model, attempt: turns, tenantId: principal?.tenantId } });
      let res;
      let providerWasCached = false;
      let providerCompleted = false;
      try {
        if (cachedResult) {
          res = cachedResult;
          providerWasCached = true;
        } else {
          if (reservationId && typeof costTracker?.markStarted === 'function') {
            const started = await costTracker.markStarted(reservationId);
            if (started?.ok === false) {
              const error = new Error('The request budget reservation expired before provider entry');
              error.code = 'COST_RESERVATION_EXPIRED';
              error.statusCode = 503;
              error.retryable = false;
              error.unknownOutcome = false;
              throw error;
            }
          }
          const operation = async ({ signal: executionSignal } = {}) => assertProviderResult(
            await provider.complete({ model, system, messages, tools: availableTools, maxTokens, signal: executionSignal ?? signal }),
            { maxInputTokens, maxOutputTokens: maxTokens },
          );
          res = executor
            ? (await executor.execute({
                name: `provider.${provider.name}`,
                operation,
                signal,
                timeoutMs: 60_000,
                idempotent: false,
                retry: false, // provider adapters own their bounded HTTP-status retry policy
                context: { requestId, provider: provider.name, model, tenantId: principal?.tenantId },
              })).value
            : await operation({ signal });
          providerCompleted = true;
          rememberProviderResult(providerRetryKey, providerRequestDigest, res);
        }
        providerSpan?.end?.({ outcome: 'ok', attributes: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } });
      } catch (error) {
        providerSpan?.end?.({ outcome: 'error', error });
        throw providerCompleted && !providerWasCached ? unknownCostError(error) : error;
      }

      let costUsd;
      try {
        costUsd = providerWasCached ? 0 : computeCostUsd(model, res.usage, priceTable);
        spentUsd += costUsd;
        if (!providerWasCached) await costTracker?.trackUsage({ agent: name, model, usage: res.usage, costUsd, reservationId });
      } catch (error) {
        // A valid provider response means real spend may already exist. A
        // failed usage-ledger write must consume the reservation ceiling, not
        // be mistaken for a safe pre-provider failure and refunded.
        throw providerWasCached ? error : unknownCostError(error);
      }

      const wantsTools = res.stopReason === 'tool_use' && res.toolCalls?.length > 0;

      if (!wantsTools) {
        const finalText = res.text || '(no content)';
        messages.push({ role: 'assistant', content: finalText });
        return { text: finalText, messages, costUsd: spentUsd, turns };
      }

      if (res.text) partials.push(res.text);

      // Record the assistant tool_use turn, run every tool, feed results back.
      const assistantContent = [];
      if (res.text) assistantContent.push({ type: 'text', text: res.text });
      for (const call of res.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const results = [];
      for (const call of res.toolCalls) {
        const { content, isError } = await executeToolCall(tools, availableTools, call, { executor, signal, requestId, operationId, principal, telemetry, telemetryContext });
        const block = { type: 'tool_result', tool_use_id: call.id, content };
        if (isError) block.is_error = true;
        results.push(block);
      }
      messages.push({ role: 'user', content: results });

      if (spentUsd >= maxBudgetUsd) {
        const notice = `[notice] Request budget reached ($${spentUsd.toFixed(4)} of $${maxBudgetUsd}). Stopping here; partial results only.`;
        const textOut = [...partials, notice].join('\n\n');
        messages.push({ role: 'assistant', content: textOut });
        return { text: textOut, messages, costUsd: spentUsd, turns };
      }
    }

    const notice = `[notice] Reached max turns (${maxTurns}) before finishing. Partial results only.`;
    const textOut = [...partials, notice].join('\n\n');
    messages.push({ role: 'assistant', content: textOut });
    return { text: textOut, messages, costUsd: spentUsd, turns };
  }

  return { name, prompt };
}
