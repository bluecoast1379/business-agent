/**
 * LLM provider layer. A provider implements:
 *   complete({ model, system, messages, tools, maxTokens })
 *     -> { stopReason, text, toolCalls, usage }
 * where toolCalls = [{ id, name, args }] and usage = { input_tokens, output_tokens }.
 *
 * Two providers ship with the scaffold:
 *  - AnthropicProvider: real Messages API via global fetch (zero dependencies)
 *  - MockProvider: deterministic offline provider for demos and smoke tests
 */
import { assertProviderResult, assertProviderUsage } from '../providers/contract.js';
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedResponseText } from '../providers/http-body.js';
import { createOpenAICompatibleProvider } from '../providers/openai-compatible.js';

/** Default price table, USD per million tokens. Override via LLM_PRICE_TABLE_JSON. */
export const DEFAULT_PRICE_TABLE = {
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  default: { inputPerMTok: 3, outputPerMTok: 15 },
};

/** Convert one call's token usage into USD using the (overridable) price table.
 *  Field-level fallback to the default entry: a partial/garbled override must
 *  never produce NaN, or both budget guards would silently stop working
 *  (NaN comparisons are always false). */
export function computeCostUsd(model, usage, priceTable = {}) {
  const safeUsage = assertProviderUsage(usage);
  const table = { ...DEFAULT_PRICE_TABLE, ...priceTable };
  const fallback = table.default ?? DEFAULT_PRICE_TABLE.default;
  const entry = table[model] ?? fallback;
  const perMTok = (field) => {
    const n = Number(entry?.[field]);
    if (Number.isFinite(n) && n >= 0) return n;
    const d = Number(fallback?.[field]);
    return Number.isFinite(d) && d >= 0 ? d : Number(DEFAULT_PRICE_TABLE.default[field]);
  };
  const cost = (safeUsage.input_tokens * perMTok('inputPerMTok') + safeUsage.output_tokens * perMTok('outputPerMTok')) / 1e6;
  if (!Number.isFinite(cost) || cost < 0) throw new Error('[llm] computed cost must be finite and non-negative');
  return cost;
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? {
      type: 'object',
      properties: tool.params?.properties ?? {},
      required: tool.params?.required ?? [],
      additionalProperties: false,
    },
  };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const SAFE_TO_RETRY_STATUS = new Set([429]);

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function anthropicMalformed(message) {
  const error = new Error(`[llm] anthropic ${message}`);
  error.code = 'MALFORMED_RESPONSE';
  return error;
}

function anthropicUnknownCostError(error, { signal, timeout } = {}) {
  const code = timeout?.aborted ? 'TIMEOUT' : (signal?.aborted ? 'ABORTED' : (error?.code ?? 'NETWORK_ERROR'));
  const wrapped = new Error(error?.message || '[llm] anthropic response failed', { cause: error });
  wrapped.code = code;
  wrapped.retryable = false;
  wrapped.unknownOutcome = true;
  return wrapped;
}

function anthropicStopReason(value) {
  if (['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal'].includes(value)) return value;
  if (value === 'model_context_window_exceeded') return 'max_tokens';
  throw anthropicMalformed(`returned unsupported stop_reason ${String(value)}`);
}

function normalizeAnthropicResponse(data, maxResultBytes, maxOutputTokens) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw anthropicMalformed('response must be an object');
  if (!Array.isArray(data.content)) throw anthropicMalformed('content must be an array');
  const text = [];
  const toolCalls = [];
  for (const [index, block] of data.content.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.type !== 'string') {
      throw anthropicMalformed(`content[${index}] is malformed`);
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw anthropicMalformed(`content[${index}].text must be a string`);
      text.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
    // Thinking/redacted-thinking blocks are intentionally not copied into the
    // user-visible transcript. Unsupported server-side tool blocks cannot be
    // produced by the tool set this adapter sends and are ignored as metadata.
  }
  return assertProviderResult({
    stopReason: anthropicStopReason(data.stop_reason),
    text: text.join(''),
    toolCalls,
    usage: data.usage,
  }, { maxResultBytes, maxOutputTokens });
}

/** Real provider: Anthropic Messages API over global fetch (Node 22+).
 *  Bounded resilience: per-attempt timeout. Automatic retries are disabled by
 *  default; an explicit maxRetries applies only to a proven rate-limit
 *  rejection. Ambiguous network/server outcomes are never replayed. */
export function createAnthropicProvider({
  apiKey,
  baseUrl,
  timeoutMs = 60_000,
  maxRetries = 0,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl) throw new Error('[llm] anthropic baseUrl is required');
  if (typeof fetchImpl !== 'function') throw new Error('[llm] anthropic fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('[llm] anthropic timeoutMs must be a positive safe integer');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error('[llm] anthropic maxRetries must be an integer from 0 to 10');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('[llm] anthropic maxResponseBytes must be a positive safe integer');

  async function requestOnce(body, signal) {
    return fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  return {
    name: 'anthropic',
    async complete({ model, system, messages, tools, maxTokens = 1024, signal }) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('[llm] anthropic maxTokens must be a positive safe integer');
      const body = { model, max_tokens: maxTokens, messages };
      if (system) body.system = system;
      if (tools?.length) body.tools = tools.map(toAnthropicTool);

      let res;
      let responseSignal;
      let responseTimeout;
      for (let attempt = 0; ; attempt += 1) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          res = await requestOnce(body, combined);
        } catch (err) {
          throw anthropicUnknownCostError(err, { signal, timeout });
        }
        if (res.ok) {
          responseSignal = combined;
          responseTimeout = timeout;
          break;
        }
        if (SAFE_TO_RETRY_STATUS.has(res.status) && attempt < maxRetries) {
          const retryAfterSec = Number(res.headers?.get?.('retry-after'));
          const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 30_000)
            : 500 * 2 ** attempt;
          await res.body?.cancel?.().catch?.(() => {});
          await abortableDelay(delayMs, signal);
          continue;
        }
        await res.body?.cancel?.().catch?.(() => {});
        throw Object.assign(new Error(`[llm] anthropic API error ${res.status}`), {
          code: `HTTP_${res.status}`,
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
          unknownOutcome: !SAFE_TO_RETRY_STATUS.has(res.status),
        });
      }
      try {
        const text = await readBoundedResponseText(res, { maxBytes: maxResponseBytes, signal: responseSignal });
        let data;
        try { data = JSON.parse(text); } catch { throw anthropicMalformed('returned malformed JSON'); }
        return normalizeAnthropicResponse(data, maxResponseBytes, maxTokens);
      } catch (error) {
        throw anthropicUnknownCostError(error, { signal, timeout: responseTimeout });
      }
    },
  };
}

const MOCK_USAGE = { input_tokens: 100, output_tokens: 50 };

function lastToolResultContent(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return null;
  const block = message.content.find((b) => b.type === 'tool_result');
  return block ? String(block.content ?? '') : null;
}

function lastUserText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  }
  return '';
}

/**
 * Deterministic mock provider (contract-fixed behavior; smoke tests depend on it):
 *  - first turn: if tools include get_top_customers AND the message contains "top"
 *    -> returns a toolCall for get_top_customers;
 *  - after receiving a tool result -> returns "[mock] top customers: <first line of result>"
 *    with usage fixed at { input_tokens: 100, output_tokens: 50 };
 *  - anything else -> "[mock] echo: <message>".
 */
export function createMockProvider() {
  return {
    name: 'mock',
    async complete({ messages, tools }) {
      const last = messages[messages.length - 1];

      const toolResult = lastToolResultContent(last);
      if (toolResult !== null) {
        const firstLine = toolResult.split('\n')[0];
        return {
          stopReason: 'end_turn',
          text: `[mock] top customers: ${firstLine}`,
          toolCalls: [],
          usage: { ...MOCK_USAGE },
        };
      }

      const text = lastUserText(last);
      const hasTopTool = (tools ?? []).some((t) => t.name === 'get_top_customers');
      if (hasTopTool && text.toLowerCase().includes('top')) {
        return {
          stopReason: 'tool_use',
          text: '',
          toolCalls: [{ id: 'toolu_mock_1', name: 'get_top_customers', args: {} }],
          usage: { ...MOCK_USAGE },
        };
      }

      return {
        stopReason: 'end_turn',
        text: `[mock] echo: ${text}`,
        toolCalls: [],
        usage: { ...MOCK_USAGE },
      };
    },
  };
}

/** Provider factory keyed by config.provider. */
export function createProvider(config) {
  if (config.provider === 'mock') return createMockProvider();
  if (config.provider === 'openai-compatible') {
    return createOpenAICompatibleProvider({ apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl });
  }
  return createAnthropicProvider({ apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl });
}
