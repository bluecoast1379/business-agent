import { assertProviderResult } from './contract.js';
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedResponseText } from './http-body.js';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_TO_RETRY = new Set([425, 429]);

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryDelay(response, attempt) {
  const raw = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw * 1_000, 30_000) : Math.min(250 * 2 ** attempt, 5_000);
}

function toolSpec(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: 'object',
        properties: tool.params?.properties ?? {},
        required: tool.params?.required ?? [],
        additionalProperties: false,
      },
    },
  };
}

function malformed(message, code = 'MALFORMED_RESPONSE') {
  const error = new Error(`[provider:openai-compatible] ${message}`);
  error.code = code;
  return error;
}

function unknownCostError(error, { signal, timeout } = {}) {
  const timedOut = timeout?.aborted;
  const aborted = signal?.aborted;
  const code = timedOut ? 'TIMEOUT' : (aborted ? 'ABORTED' : (error?.code ?? 'NETWORK_ERROR'));
  const wrapped = new Error(error?.message || '[provider:openai-compatible] response failed', { cause: error });
  wrapped.code = code;
  wrapped.retryable = false;
  wrapped.unknownOutcome = true;
  return wrapped;
}

function parseArgs(value, name) {
  if (value === '' || value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') throw malformed(`malformed arguments for tool ${name}`, 'MALFORMED_TOOL_CALL');
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw malformed(`malformed arguments for tool ${name}`, 'MALFORMED_TOOL_CALL');
  }
}

function stopReason(value) {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'stop') return 'end_turn';
  if (value === 'length') return 'max_tokens';
  if (value === 'content_filter') return 'content_filter';
  throw malformed(`unsupported finish_reason ${String(value)}`);
}

function normalizeChoice(choice, usage, maxResultBytes, maxOutputTokens) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw malformed('choice must be an object');
  const message = choice.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw malformed('choice.message must be an object');
  if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw malformed('message.content must be a string or null');
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw malformed('message.tool_calls must be an array');
  const toolCalls = rawCalls.map((call) => ({
    id: call?.id,
    name: call?.function?.name,
    args: parseArgs(call?.function?.arguments, call?.function?.name),
  }));
  return assertProviderResult({
    stopReason: stopReason(choice.finish_reason),
    text: message.content ?? '',
    toolCalls,
    usage: { input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens },
  }, { maxResultBytes, maxOutputTokens });
}

function parseStream(text, maxResultBytes, maxOutputTokens) {
  let content = '';
  let finishReason = null;
  let usage;
  const calls = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let event;
    try { event = JSON.parse(raw); } catch { throw malformed('malformed SSE chunk', 'MALFORMED_STREAM'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw malformed('malformed SSE event', 'MALFORMED_STREAM');
    if (event.usage !== undefined) usage = event.usage;
    const choices = event.choices ?? [];
    if (!Array.isArray(choices)) throw malformed('malformed SSE choices', 'MALFORMED_STREAM');
    const choice = choices[0];
    if (!choice) continue;
    if (typeof choice !== 'object' || Array.isArray(choice)) throw malformed('malformed SSE choice', 'MALFORMED_STREAM');
    const delta = choice.delta ?? {};
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw malformed('malformed SSE delta', 'MALFORMED_STREAM');
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw malformed('malformed SSE content', 'MALFORMED_STREAM');
      content += delta.content;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
    const fragments = delta.tool_calls ?? [];
    if (!Array.isArray(fragments)) throw malformed('malformed SSE tool calls', 'MALFORMED_STREAM');
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) throw malformed('malformed SSE tool fragment', 'MALFORMED_STREAM');
      const key = fragment.index ?? 0;
      if (!Number.isSafeInteger(key) || key < 0 || key >= 32) throw malformed('invalid SSE tool index', 'MALFORMED_STREAM');
      const current = calls.get(key) ?? { id: '', name: '', arguments: '' };
      if (fragment.id !== undefined) {
        if (typeof fragment.id !== 'string') throw malformed('invalid SSE tool id', 'MALFORMED_STREAM');
        current.id += fragment.id;
      }
      if (fragment.function?.name !== undefined) {
        if (typeof fragment.function.name !== 'string') throw malformed('invalid SSE tool name', 'MALFORMED_STREAM');
        current.name += fragment.function.name;
      }
      if (fragment.function?.arguments !== undefined) {
        if (typeof fragment.function.arguments !== 'string') throw malformed('invalid SSE tool arguments', 'MALFORMED_STREAM');
        current.arguments += fragment.function.arguments;
      }
      calls.set(key, current);
    }
  }
  return assertProviderResult({
    stopReason: stopReason(finishReason),
    text: content,
    toolCalls: [...calls.values()].map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.arguments, call.name) })),
    usage: { input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens },
  }, { maxResultBytes, maxOutputTokens });
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw malformed('malformed JSON response'); }
}

export function createOpenAICompatibleProvider({
  apiKey,
  baseUrl,
  timeoutMs = 60_000,
  maxRetries = 0,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  extraHeaders = {},
} = {}) {
  if (!baseUrl) throw new Error('[provider:openai-compatible] baseUrl is required');
  if (typeof fetchImpl !== 'function') throw new Error('[provider:openai-compatible] fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('[provider:openai-compatible] timeoutMs must be a positive safe integer');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error('[provider:openai-compatible] maxRetries must be an integer from 0 to 10');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('[provider:openai-compatible] maxResponseBytes must be a positive safe integer');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const requestHeaders = new Headers(extraHeaders);
  // Caller-supplied headers cannot override protocol or configured credentials,
  // including through alternate casing such as `Authorization`.
  requestHeaders.set('content-type', 'application/json');
  if (apiKey) requestHeaders.set('authorization', `Bearer ${apiKey}`);

  return {
    name: 'openai-compatible',
    async complete({ model, system, messages, tools, maxTokens = 1024, stream = false, signal }) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('[provider:openai-compatible] maxTokens must be a positive safe integer');
      const body = {
        model,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        max_tokens: maxTokens,
        stream,
      };
      if (stream) body.stream_options = { include_usage: true };
      if (tools?.length) body.tools = tools.map(toolSpec);
      let response;
      let responseSignal;
      let responseTimeout;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(body),
            signal: combined,
          });
        } catch (error) {
          throw unknownCostError(error, { signal, timeout });
        }
        if (response.ok) {
          responseSignal = combined;
          responseTimeout = timeout;
          break;
        }
        if (SAFE_TO_RETRY.has(response.status) && attempt < maxRetries) {
          await response.body?.cancel?.().catch?.(() => {});
          await abortableDelay(retryDelay(response, attempt), signal);
          continue;
        }
        await response.body?.cancel?.().catch?.(() => {});
        const error = new Error(`[provider:openai-compatible] HTTP ${response.status}`);
        error.status = response.status;
        error.code = `HTTP_${response.status}`;
        error.retryable = RETRYABLE.has(response.status);
        error.unknownOutcome = !SAFE_TO_RETRY.has(response.status);
        throw error;
      }

      try {
        const text = await readBoundedResponseText(response, { maxBytes: maxResponseBytes, signal: responseSignal });
        if (stream) return parseStream(text, maxResponseBytes, maxTokens);
        const payload = parseJson(text);
        if (!Array.isArray(payload?.choices) || !payload.choices[0]) throw malformed('response has no choices');
        return normalizeChoice(payload.choices[0], payload.usage, maxResponseBytes, maxTokens);
      } catch (error) {
        throw unknownCostError(error, { signal, timeout: responseTimeout });
      }
    },
  };
}

export function createFallbackProvider(providers) {
  if (!Array.isArray(providers) || !providers.length) throw new Error('[provider] fallback requires providers');
  return {
    name: `fallback(${providers.map((provider) => provider.name).join(',')})`,
    async complete(input) {
      const failures = [];
      for (const provider of providers) {
        try { return await provider.complete(input); }
        catch (error) {
          failures.push({ provider: provider.name, code: error.code || error.name });
          // A fallback is another billable execution. Only an explicit proof
          // that the first request had a known non-effect outcome permits it.
          if (error.retryable !== true || error.unknownOutcome !== false) throw error;
        }
      }
      const error = new Error('[provider] all fallback providers failed');
      error.code = 'PROVIDER_FALLBACK_EXHAUSTED';
      error.failures = failures;
      throw error;
    },
  };
}
