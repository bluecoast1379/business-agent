import { DEFAULT_MAX_RESPONSE_BYTES } from './http-body.js';

const STOP_REASONS = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'content_filter',
  'pause_turn',
  'refusal',
]);
const MAX_TOOL_CALLS = 32;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;

function malformed(message) {
  const error = new Error(`[provider] ${message}`);
  error.code = 'MALFORMED_PROVIDER_RESULT';
  // A provider request already completed but its metering cannot be trusted.
  // The registry must consume the reservation rather than refunding it.
  error.unknownOutcome = true;
  error.retryable = false;
  return error;
}

export function assertProviderUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw malformed('usage must be an object');
  }
  const normalized = {};
  for (const field of ['input_tokens', 'output_tokens']) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw malformed(`usage.${field} must be a non-negative safe integer`);
    }
    normalized[field] = value;
  }
  return normalized;
}

function assertJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(`${label} must be a JSON object`);
  }
  const rootPrototype = Object.getPrototypeOf(value);
  if (rootPrototype !== Object.prototype && rootPrototype !== null) {
    throw malformed(`${label} must be a plain JSON object`);
  }

  const seen = new Set();
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw malformed(`${label} is too complex`);
    if (current.depth > MAX_JSON_DEPTH) throw malformed(`${label} exceeds maximum JSON depth`);
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw malformed(`${label} contains a non-finite number`);
      continue;
    }
    if (!item || typeof item !== 'object') throw malformed(`${label} contains a non-JSON value`);
    if (seen.has(item)) throw malformed(`${label} contains a cycle`);
    seen.add(item);
    if (!Array.isArray(item)) {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw malformed(`${label} contains a non-plain object`);
    }
    for (const child of Object.values(item)) stack.push({ value: child, depth: current.depth + 1 });
  }

  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw malformed(`${label} is not JSON serializable`); }
  return { value: JSON.parse(serialized), bytes: Buffer.byteLength(serialized) };
}

export function assertProviderResult(result, {
  maxResultBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxInputTokens,
  maxOutputTokens,
} = {}) {
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1) throw new Error('[provider] maxResultBytes must be a positive safe integer');
  if (maxInputTokens !== undefined && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1)) {
    throw new Error('[provider] maxInputTokens must be a positive safe integer');
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new Error('[provider] maxOutputTokens must be a positive safe integer');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw malformed('result must be an object');
  if (!STOP_REASONS.has(result.stopReason)) throw malformed('result.stopReason is unsupported');
  if (typeof result.text !== 'string') throw malformed('result.text must be a string');
  if (!Array.isArray(result.toolCalls)) throw malformed('result.toolCalls must be an array');
  if (result.toolCalls.length > MAX_TOOL_CALLS) throw malformed(`result.toolCalls exceeds ${MAX_TOOL_CALLS}`);
  if (result.stopReason === 'tool_use' && result.toolCalls.length === 0) throw malformed('tool_use requires at least one tool call');
  if (result.stopReason !== 'tool_use' && result.toolCalls.length > 0) throw malformed('tool calls require stopReason=tool_use');

  let resultBytes = Buffer.byteLength(result.text);
  const ids = new Set();
  const toolCalls = result.toolCalls.map((call, index) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw malformed(`toolCalls[${index}] must be an object`);
    if (typeof call.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(call.id)) throw malformed(`toolCalls[${index}].id is invalid`);
    if (ids.has(call.id)) throw malformed(`duplicate tool call id ${call.id}`);
    ids.add(call.id);
    if (typeof call.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.name)) throw malformed(`toolCalls[${index}].name is invalid`);
    const args = assertJsonObject(call.args, `toolCalls[${index}].args`);
    resultBytes += Buffer.byteLength(call.id) + Buffer.byteLength(call.name) + args.bytes;
    if (resultBytes > maxResultBytes) throw malformed(`result exceeds ${maxResultBytes} bytes`);
    return { id: call.id, name: call.name, args: args.value };
  });
  if (resultBytes > maxResultBytes) throw malformed(`result exceeds ${maxResultBytes} bytes`);

  const usage = assertProviderUsage(result.usage);
  if (usage.input_tokens === 0) {
    throw malformed('usage.input_tokens must account for the completed request');
  }
  if ((result.text.length > 0 || toolCalls.length > 0) && usage.output_tokens === 0) {
    throw malformed('usage.output_tokens must account for returned content or tool calls');
  }
  if (maxInputTokens !== undefined && usage.input_tokens > maxInputTokens) {
    throw malformed(`usage.input_tokens exceeds the request envelope (${maxInputTokens})`);
  }
  if (maxOutputTokens !== undefined && usage.output_tokens > maxOutputTokens) {
    throw malformed(`usage.output_tokens exceeds the requested maxOutputTokens (${maxOutputTokens})`);
  }
  return {
    stopReason: result.stopReason,
    text: result.text,
    toolCalls,
    usage,
  };
}

export function normalizeProviderError(error, provider) {
  const wrapped = new Error(`[provider:${provider}] ${error?.message || String(error)}`);
  wrapped.code = error?.code || 'PROVIDER_ERROR';
  wrapped.retryable = error?.retryable === true;
  wrapped.status = error?.status;
  wrapped.unknownOutcome = error?.unknownOutcome === true;
  return wrapped;
}
