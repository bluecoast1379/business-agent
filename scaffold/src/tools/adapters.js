import { defineTool } from '../runtime/tool.js';
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedResponseText } from '../providers/http-body.js';

const MAX_CONFIGURED_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 32;
const DEFAULT_MAX_JSON_NODES = 100_000;

function assertBoundary(value, label, { min = 1, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function boundaryError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function jsonStringBytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += Buffer.byteLength(value[index]);
  }
  return bytes;
}

function assertBoundedJsonValue(value, {
  maxBytes,
  maxDepth,
  maxNodes,
  label,
}) {
  const seen = new Set();
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  const add = (amount) => {
    bytes += amount;
    if (bytes > maxBytes) throw boundaryError('TOOL_RESPONSE_TOO_LARGE', `[tools] ${label} exceeds ${maxBytes} bytes`);
  };
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) throw boundaryError('TOOL_RESPONSE_TOO_COMPLEX', `[tools] ${label} exceeds ${maxNodes} JSON nodes`);
    if (current.depth > maxDepth) throw boundaryError('TOOL_RESPONSE_TOO_DEEP', `[tools] ${label} exceeds JSON depth ${maxDepth}`);
    const item = current.value;
    if (item === null) { add(4); continue; }
    if (typeof item === 'string') { add(jsonStringBytes(item)); continue; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); continue; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains a non-finite number`);
      add(Buffer.byteLength(String(item)));
      continue;
    }
    if (!item || typeof item !== 'object') throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} is not JSON data`);
    if (seen.has(item)) throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains a cycle`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getOwnPropertySymbols(item).length > 0
          || Object.getOwnPropertyNames(item).length !== item.length + 1) {
        throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains a sparse or extended array`);
      }
      add(2 + Math.max(0, item.length - 1));
      for (let index = item.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(item, index)) throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains a sparse array`);
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains a non-plain object`);
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== 'string')) throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains symbol keys`);
    add(2 + Math.max(0, keys.length - 1));
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw boundaryError('TOOL_RESPONSE_MALFORMED', `[tools] ${label} contains accessor or hidden fields`);
      }
      add(jsonStringBytes(key) + 1);
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return value;
}

function adapterLimits({ maxBytes, maxDepth, maxNodes }, prefix) {
  assertBoundary(maxBytes, `[tools:${prefix}] max response bytes`, { max: MAX_CONFIGURED_RESPONSE_BYTES });
  assertBoundary(maxDepth, `[tools:${prefix}] max JSON depth`, { max: 64 });
  assertBoundary(maxNodes, `[tools:${prefix}] max JSON nodes`, { max: 1_000_000 });
  return { maxBytes, maxDepth, maxNodes };
}

function classifyCompletedResponseError(rawError, unknownOutcome) {
  const error = rawError instanceof Error ? rawError : boundaryError('TOOL_RESPONSE_MALFORMED', '[tools] remote response validation failed');
  error.code ??= 'TOOL_RESPONSE_MALFORMED';
  error.retryable = false;
  error.unknownOutcome = unknownOutcome;
  if (unknownOutcome) error.reconciliationRequired = true;
  return error;
}

export function createMcpTool({
  name,
  description,
  params,
  client,
  remoteName = name,
  maxResultBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxResultDepth = DEFAULT_MAX_JSON_DEPTH,
  maxResultNodes = DEFAULT_MAX_JSON_NODES,
}) {
  if (typeof client?.callTool !== 'function') throw new Error('[tools:mcp] client.callTool is required');
  const limits = adapterLimits({ maxBytes: maxResultBytes, maxDepth: maxResultDepth, maxNodes: maxResultNodes }, 'mcp');
  return defineTool({
    name,
    description,
    params,
    async handler(args, context = {}) {
      const result = await client.callTool(
        { name: remoteName, arguments: args },
        { signal: context.signal, idempotencyKey: context.idempotencyKey },
      );
      try {
        return assertBoundedJsonValue(result, { ...limits, label: 'MCP result' });
      } catch (error) {
        // The remote call completed before validation. Without an effect
        // contract at this adapter layer, conservatively require reconciliation.
        throw classifyCompletedResponseError(error, true);
      }
    },
  });
}

export function createOpenApiTool({
  name,
  description,
  params,
  method = 'GET',
  url,
  fetchImpl = globalThis.fetch,
  headers = {},
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxResponseDepth = DEFAULT_MAX_JSON_DEPTH,
  maxResponseNodes = DEFAULT_MAX_JSON_NODES,
}) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('[tools:openapi] unsupported method');
  if (!url || typeof fetchImpl !== 'function') throw new Error('[tools:openapi] url and fetch are required');
  const limits = adapterLimits({ maxBytes: maxResponseBytes, maxDepth: maxResponseDepth, maxNodes: maxResponseNodes }, 'openapi');
  return defineTool({
    name,
    description,
    params,
    async handler(args, context = {}) {
      const endpoint = new URL(url);
      // Headers is case-insensitive; set protected transport headers after all
      // caller configuration so mixed-case aliases cannot override them.
      const protectedHeaders = new Headers(headers);
      protectedHeaders.set('accept', 'application/json');
      const init = { method, headers: protectedHeaders, signal: context.signal };
      if (method === 'GET') for (const [key, value] of Object.entries(args)) endpoint.searchParams.set(key, String(value));
      else {
        protectedHeaders.set('content-type', 'application/json');
        if (context.idempotencyKey) protectedHeaders.set('idempotency-key', context.idempotencyKey);
        else protectedHeaders.delete('idempotency-key');
        init.body = JSON.stringify(args);
      }
      const response = await fetchImpl(endpoint, init);
      if (!response.ok) {
        await response.body?.cancel?.().catch?.(() => {});
        const knownRejection = [400, 401, 403, 404, 409, 412, 422, 425, 429].includes(response.status);
        throw Object.assign(new Error(`[tools:openapi] HTTP ${response.status}`), {
          status: response.status,
          retryable: response.status === 425 || response.status === 429,
          unknownOutcome: method === 'GET' ? false : !knownRejection,
        });
      }
      try {
        let value;
        if (typeof response.text === 'function'
            || typeof response.body?.getReader === 'function'
            || typeof response.headers?.get === 'function') {
          const text = await readBoundedResponseText(response, { maxBytes: limits.maxBytes, signal: context.signal });
          try { value = JSON.parse(text); }
          catch { throw boundaryError('TOOL_RESPONSE_MALFORMED', '[tools:openapi] response is not valid JSON'); }
        } else if (typeof response.json === 'function') {
          // Compatibility for minimal local test doubles. Real fetch responses
          // always use the byte-bounded body reader above.
          value = await response.json();
        } else throw boundaryError('TOOL_RESPONSE_MALFORMED', '[tools:openapi] response body is unavailable');
        return assertBoundedJsonValue(value, { ...limits, label: 'OpenAPI result' });
      } catch (error) {
        throw classifyCompletedResponseError(error, method !== 'GET');
      }
    },
  });
}

export function createReadOnlyDbTool({ name, description, params, query, sql, capabilities }) {
  if (typeof query !== 'function' || typeof sql !== 'string') throw new Error('[tools:db] query and static SQL are required');
  if (capabilities?.readOnlyTransactions !== true) {
    throw new Error('[tools:db] the database adapter must attest readOnlyTransactions=true');
  }
  const normalized = sql.trim().replace(/^\(+/, '').toLowerCase();
  if (!normalized.startsWith('select ') || /\b(insert|update|delete|alter|drop|create|grant|revoke|truncate|merge|call)\b/i.test(normalized)) {
    throw new Error('[tools:db] only one static read-only SELECT statement is allowed');
  }
  if (sql.includes(';')) throw new Error('[tools:db] multiple statements are forbidden');
  return defineTool({
    name,
    description,
    params,
    handler: (args, context = {}) => query(sql, args, {
      signal: context.signal,
      idempotencyKey: context.idempotencyKey,
      readOnly: true,
    }),
  });
}
