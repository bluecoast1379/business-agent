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
  const table = { ...DEFAULT_PRICE_TABLE, ...priceTable };
  const fallback = table.default ?? DEFAULT_PRICE_TABLE.default;
  const entry = table[model] ?? fallback;
  const perMTok = (field) => {
    const n = Number(entry?.[field]);
    if (Number.isFinite(n)) return n;
    const d = Number(fallback?.[field]);
    return Number.isFinite(d) ? d : Number(DEFAULT_PRICE_TABLE.default[field]);
  };
  const inputTokens = Number(usage?.input_tokens) || 0;
  const outputTokens = Number(usage?.output_tokens) || 0;
  return (inputTokens * perMTok('inputPerMTok') + outputTokens * perMTok('outputPerMTok')) / 1e6;
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: tool.params?.properties ?? {},
      required: tool.params?.required ?? [],
    },
  };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/** Real provider: Anthropic Messages API over global fetch (Node 18+).
 *  Bounded resilience: per-attempt timeout + up to `maxRetries` retries with
 *  exponential backoff (honoring retry-after when present) on 429/5xx/network
 *  errors. Non-retryable statuses (4xx auth/validation) fail immediately. */
export function createAnthropicProvider({ apiKey, baseUrl, timeoutMs = 60_000, maxRetries = 2 }) {
  async function requestOnce(body) {
    return fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    name: 'anthropic',
    async complete({ model, system, messages, tools, maxTokens = 1024 }) {
      const body = { model, max_tokens: maxTokens, messages };
      if (system) body.system = system;
      if (tools?.length) body.tools = tools.map(toAnthropicTool);

      let res;
      for (let attempt = 0; ; attempt += 1) {
        try {
          res = await requestOnce(body);
        } catch (err) {
          // Network error or timeout: retry within budget, then surface.
          if (attempt >= maxRetries) throw new Error(`[llm] anthropic request failed after ${attempt + 1} attempts: ${err.message}`);
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        if (res.ok) break;
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          const retryAfterSec = Number(res.headers.get('retry-after'));
          const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 30_000)
            : 500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`[llm] anthropic API error ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const content = Array.isArray(data.content) ? data.content : [];
      return {
        stopReason: data.stop_reason,
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        toolCalls: content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
        usage: data.usage ?? { input_tokens: 0, output_tokens: 0 },
      };
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
  return createAnthropicProvider({ apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl });
}
