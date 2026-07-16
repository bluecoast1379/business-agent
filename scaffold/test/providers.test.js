import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProviderResult, createAnthropicProvider, createFallbackProvider, createOpenAICompatibleProvider } from '../src/providers/index.js';
import { createAgent } from '../src/runtime/agent.js';
import { createCostTracker } from '../src/runtime/cost-tracker.js';
import { createExecutor, createIdempotencyStore } from '../src/runtime/execution/index.js';
import { computeCostUsd } from '../src/runtime/llm.js';
import { defineTool } from '../src/runtime/tool.js';
import { createMemoryStateStore } from '../src/stores/index.js';

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() { if (typeof payload === 'string') throw new Error('invalid json'); return payload; },
    async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload); },
  };
}

function streamedResponse(chunks, { status = 200, headers = {}, hang = false } = {}) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      if (!hang) controller.close();
    },
    cancel() { cancelled += 1; },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body,
    get cancelled() { return cancelled; },
  };
}

test('OpenAI-compatible adapter normalizes chat, tools and usage without leaking provider fields', async () => {
  const calls = [];
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://gateway.example', apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        choices: [{ finish_reason: 'tool_calls', message: { content: 'checking', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":"1"}' } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
        provider_internal: 'must-not-propagate',
      });
    },
  });
  const result = await provider.complete({ model: 'model-a', system: 'safe', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', description: 'Lookup', params: { properties: {}, required: [] } }] });
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'lookup', args: { id: '1' } }]);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
  assert.equal(result.provider_internal, undefined);
  assert.equal(calls[0].url, 'https://gateway.example/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).messages[0].role, 'system');
});

test('OpenAI-compatible protected headers cannot be replaced with alternate casing', async () => {
  let headers;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://gateway.example',
    apiKey: 'configured-synthetic-key',
    extraHeaders: {
      Authorization: 'Bearer attacker-controlled',
      'Content-Type': 'text/plain',
      'x-routing-hint': 'safe-extra',
    },
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return response(200, {
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  await provider.complete({ model: 'm', messages: [] });
  assert.equal(headers.get('authorization'), 'Bearer configured-synthetic-key');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-routing-hint'), 'safe-extra');
});

test('streaming chunks normalize content, tool calls and usage', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":"{\\"id\\":"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"\\"1\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
    'data: [DONE]',
  ].join('\n\n');
  const provider = createOpenAICompatibleProvider({ baseUrl: 'http://local', fetchImpl: async () => response(200, sse) });
  const result = await provider.complete({ model: 'm', messages: [], stream: true });
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'lookup', args: { id: '1' } }]);
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
});

test('proven rate-limit rejections are bounded and auth failures never fall back', async () => {
  let attempts = 0;
  const provider = createOpenAICompatibleProvider({ baseUrl: 'http://local', maxRetries: 2, fetchImpl: async () => { attempts += 1; return response(429, {}); } });
  await assert.rejects(provider.complete({ model: 'm', messages: [] }), (error) => error.status === 429 && error.retryable === true && error.unknownOutcome === false);
  assert.equal(attempts, 3);

  let fallbackCalls = 0;
  const fallback = createFallbackProvider([
    { name: 'primary', complete: async () => { const error = new Error('unauthorized'); error.retryable = false; throw error; } },
    { name: 'secondary', complete: async () => { fallbackCalls += 1; return {}; } },
  ]);
  await assert.rejects(fallback.complete({}), /unauthorized/);
  assert.equal(fallbackCalls, 0);
});

test('retryable primary can fall back to a normalized secondary result', async () => {
  const fallback = createFallbackProvider([
    { name: 'primary', complete: async () => { const error = new Error('rate limited'); error.retryable = true; error.unknownOutcome = false; error.code = 'HTTP_429'; throw error; } },
    { name: 'secondary', complete: async () => ({ stopReason: 'end_turn', text: 'ok', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } }) },
  ]);
  assert.equal((await fallback.complete({})).text, 'ok');
});

test('fallback never replays an ambiguous provider outcome on a secondary', async () => {
  let secondaryCalls = 0;
  const fallback = createFallbackProvider([
    { name: 'primary', complete: async () => { const error = new Error('ambiguous'); error.retryable = true; error.unknownOutcome = true; throw error; } },
    { name: 'secondary', complete: async () => { secondaryCalls += 1; return {}; } },
  ]);
  await assert.rejects(fallback.complete({}), /ambiguous/);
  assert.equal(secondaryCalls, 0);
});

test('read-tool driver errors expose only a stable code to the provider transcript and caller', async () => {
  const secret = 'postgres://service:SYNTHETIC_PRIVATE_VALUE@internal.example/database';
  let providerSawSecret = false;
  let turn = 0;
  const provider = {
    name: 'transcript-probe',
    async complete({ messages }) {
      turn += 1;
      if (turn === 1) {
        return {
          stopReason: 'tool_use',
          text: '',
          toolCalls: [{ id: 'call-1', name: 'read_backend', args: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      const transcript = JSON.stringify(messages);
      providerSawSecret = transcript.includes(secret);
      return {
        stopReason: 'end_turn',
        text: transcript.includes(secret) ? secret : 'sanitized',
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const agent = createAgent({
    name: 'error-boundary',
    model: 'model-a',
    systemPrompt: 'test',
    maxTurns: 2,
    provider,
    costTracker: createCostTracker(),
    tools: [defineTool({
      name: 'read_backend',
      handler: async () => { throw Object.assign(new Error(secret), { code: 'BACKEND_READ_FAILED' }); },
    })],
  });

  const result = await agent.prompt('read once');
  assert.equal(providerSawSecret, false);
  assert.equal(result.text, 'sanitized');
  assert.doesNotMatch(JSON.stringify(result.messages), /SYNTHETIC_PRIVATE_VALUE|internal\.example/);
  assert.match(JSON.stringify(result.messages), /BACKEND_READ_FAILED/);
});

test('provider and executor retry layers do not multiply proven rejection attempts', async () => {
  let fetchCalls = 0;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://local',
    maxRetries: 2,
    fetchImpl: async () => { fetchCalls += 1; return response(429, {}); },
  });
  const agent = createAgent({
    name: 'retry-boundary',
    model: 'model-a',
    systemPrompt: 'test',
    provider,
    costTracker: createCostTracker(),
    executor: createExecutor(),
  });
  await assert.rejects(agent.prompt('hello', { operationId: 'operation-a' }), /HTTP 429/);
  assert.equal(fetchCalls, 3, 'one provider policy of three attempts must not become nine outer attempts');
});

test('server failures make one attempt by default and never trigger a billable fallback', async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const primary = createOpenAICompatibleProvider({
    baseUrl: 'http://local',
    fetchImpl: async () => { primaryCalls += 1; return response(503, {}); },
  });
  const fallback = createFallbackProvider([
    primary,
    { name: 'secondary', complete: async () => { secondaryCalls += 1; return {}; } },
  ]);
  await assert.rejects(
    fallback.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'HTTP_503' && error.unknownOutcome === true,
  );
  assert.equal(primaryCalls, 1);
  assert.equal(secondaryCalls, 0);
});

test('the request budget is checked against a conservative provider-call ceiling before entry', async () => {
  let calls = 0;
  const provider = {
    name: 'must-not-run-over-budget',
    async complete() {
      calls += 1;
      return { stopReason: 'end_turn', text: 'unsafe', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const tracker = createCostTracker();
  const agent = createAgent({
    name: 'preflight-budget',
    model: 'expensive',
    systemPrompt: 'test',
    maxTokens: 1,
    maxBudgetUsd: 0.01,
    priceTable: { expensive: { inputPerMTok: 10_000, outputPerMTok: 10_000 } },
    provider,
    costTracker: tracker,
  });
  const result = await agent.prompt('hello');
  assert.equal(calls, 0);
  assert.equal(result.costUsd, 0);
  assert.equal(result.turns, 0);
  assert.match(result.text, /cannot safely cover the next provider call/i);
  assert.equal(tracker.summary().calls, 0);
});

test('provider results are never persisted in the durable idempotency namespace', async () => {
  const stateStore = createMemoryStateStore();
  const provider = {
    name: 'privacy-fixture',
    async complete() {
      return {
        stopReason: 'end_turn',
        text: 'CONFIDENTIAL-CUSTOMER-DATA',
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  try {
    const agent = createAgent({
      name: 'provider-privacy',
      model: 'model-a',
      systemPrompt: 'test',
      provider,
      costTracker: createCostTracker(),
      executor: createExecutor({ idempotency: createIdempotencyStore({ stateStore }) }),
    });
    assert.equal((await agent.prompt('hello', { operationId: 'same-process-retry' })).text, 'CONFIDENTIAL-CUSTOMER-DATA');
    const idempotency = await stateStore.list('idempotency', { limit: 1_000 });
    assert.equal(idempotency.items.length, 0);
    assert.equal(JSON.stringify(await stateStore.exportSnapshot()).includes('CONFIDENTIAL-CUSTOMER-DATA'), false);
  } finally {
    await stateStore.close();
  }
});

test('same-process provider retry cache binds operation ids to request and principal', async () => {
  let calls = 0;
  const provider = {
    name: 'retry-cache-binding',
    async complete({ messages }) {
      calls += 1;
      return {
        stopReason: 'end_turn',
        text: `reply:${messages.at(-1).content}`,
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const agent = createAgent({ name: 'retry-cache', model: 'model-a', systemPrompt: 'test', provider, costTracker: createCostTracker() });
  const principalA = { tenantId: 'tenant-a', subjectId: 'subject-a' };
  const principalB = { tenantId: 'tenant-b', subjectId: 'subject-b' };

  assert.equal((await agent.prompt('alpha', { operationId: 'operation-1', principal: principalA })).text, 'reply:alpha');
  await assert.rejects(
    agent.prompt('beta', { operationId: 'operation-1', principal: principalA }),
    (error) => error.code === 'PROVIDER_OPERATION_CONFLICT' && error.statusCode === 409,
  );
  assert.equal((await agent.prompt('beta', { operationId: 'operation-1', principal: principalB })).text, 'reply:beta');
  assert.equal(calls, 2, 'different requests must never receive a cached response from another principal');
});

test('same-process provider retry cache enforces per-entry and total byte budgets', async () => {
  let calls = 0;
  const large = 'x'.repeat(1_100_000);
  const provider = {
    name: 'retry-cache-size',
    async complete() {
      calls += 1;
      return { stopReason: 'end_turn', text: large, toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const agent = createAgent({ name: 'retry-cache-size', model: 'model-a', systemPrompt: 'test', provider, costTracker: createCostTracker() });
  assert.equal((await agent.prompt('same', { operationId: 'large-operation' })).text.length, large.length);
  assert.equal((await agent.prompt('same', { operationId: 'large-operation' })).text.length, large.length);
  assert.equal(calls, 2, 'oversized responses must not be retained in the retry cache');

  let boundedCalls = 0;
  const boundedProvider = {
    name: 'retry-cache-total',
    async complete() {
      boundedCalls += 1;
      return { stopReason: 'end_turn', text: 'y'.repeat(900_000), toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const bounded = createAgent({ name: 'retry-cache-total', model: 'model-a', systemPrompt: 'test', provider: boundedProvider, costTracker: createCostTracker() });
  for (let index = 0; index < 20; index += 1) await bounded.prompt('same', { operationId: `bounded-${index}` });
  await bounded.prompt('same', { operationId: 'bounded-0' });
  assert.equal(boundedCalls, 21, 'the oldest result must be evicted when the global byte budget is reached');
});

test('ambiguous network failures are not automatically replayed', async () => {
  let fetchCalls = 0;
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'http://local',
    maxRetries: 5,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('socket ended'); },
  });
  await assert.rejects(provider.complete({ model: 'm', messages: [] }), (error) => error.unknownOutcome === true && error.retryable === false);
  assert.equal(fetchCalls, 1);
});

test('provider usage is a required non-negative safe-integer contract at the agent boundary', async () => {
  for (const usage of [
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: '1', output_tokens: 1 },
    { input_tokens: 1 },
    { input_tokens: 1, output_tokens: 2 },
    { input_tokens: 0, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 0 },
  ]) {
    const tracker = createCostTracker();
    const provider = {
      name: 'untrusted-provider',
      async complete() {
        return { stopReason: 'end_turn', text: 'must-not-accept', toolCalls: [], usage };
      },
    };
    const agent = createAgent({ name: 'usage-boundary', model: 'model-a', systemPrompt: 'test', maxTokens: 1, provider, costTracker: tracker });
    await assert.rejects(
      agent.prompt('hello'),
      (error) => error.code === 'MALFORMED_PROVIDER_RESULT' && error.unknownOutcome === true,
    );
    assert.equal(tracker.summary().calls, 0);
    assert.equal(tracker.summary().costUsd, 0, 'invalid usage must never lower the budget ledger');
  }

  assert.equal(computeCostUsd('model-a', { input_tokens: 0, output_tokens: 0 }), 0);
  assert.throws(() => computeCostUsd('model-a', { input_tokens: -1, output_tokens: 0 }), /input_tokens/);
  assert.throws(() => assertProviderResult({
    stopReason: 'end_turn', text: 'bounded', toolCalls: [], usage: { input_tokens: 101, output_tokens: 1 },
  }, { maxInputTokens: 100, maxOutputTokens: 1 }), /request envelope/);
});

test('malformed stop reasons and tool calls fail closed before tool execution', async () => {
  const malformed = [
    { stopReason: 'made_up', text: '', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } },
    { stopReason: 'tool_use', text: '', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } },
    { stopReason: 'end_turn', text: '', toolCalls: [{ id: 'c1', name: 'lookup', args: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'c1', name: 'lookup', args: [] }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'same', name: 'lookup', args: {} }, { id: 'same', name: 'lookup', args: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  let toolExecutions = 0;
  const tools = [{ name: 'lookup', params: {}, handler: () => { toolExecutions += 1; return 'unsafe'; } }];
  for (const result of malformed) {
    const provider = { name: 'malformed-provider', complete: async () => result };
    const agent = createAgent({ name: 'contract-boundary', model: 'model-a', systemPrompt: 'test', tools, provider, costTracker: createCostTracker() });
    await assert.rejects(agent.prompt('hello'), (error) => error.code === 'MALFORMED_PROVIDER_RESULT');
  }
  assert.equal(toolExecutions, 0);
});

test('OpenAI-compatible adapter rejects missing or invalid usage as an unknown-cost outcome', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 2 }]) {
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'http://local',
      fetchImpl: async () => response(200, {
        choices: [{ finish_reason: 'stop', message: { content: 'unsafe' } }],
        ...(usage === undefined ? {} : { usage }),
      }),
    });
    await assert.rejects(
      provider.complete({ model: 'm', messages: [], maxTokens: 1 }),
      (error) => error.code === 'MALFORMED_PROVIDER_RESULT' && error.unknownOutcome === true,
    );
  }
});

test('provider adapters reject malformed tool arguments and terminal reasons', async () => {
  const openAiPayloads = [
    {
      choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '[]' } }] } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    },
    {
      choices: [{ finish_reason: 'invented_reason', message: { content: '', tool_calls: [] } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    },
  ];
  for (const payload of openAiPayloads) {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://local', fetchImpl: async () => response(200, payload) });
    await assert.rejects(provider.complete({ model: 'm', messages: [] }), (error) => error.unknownOutcome === true && /^MALFORMED_/.test(error.code));
  }

  const anthropicPayloads = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: [] }], usage: { input_tokens: 2, output_tokens: 1 } },
    { stop_reason: 'invented_reason', content: [], usage: { input_tokens: 2, output_tokens: 1 } },
  ];
  for (const payload of anthropicPayloads) {
    const provider = createAnthropicProvider({
      apiKey: 'synthetic-key', baseUrl: 'https://anthropic.example', fetchImpl: async () => response(200, payload),
    });
    await assert.rejects(provider.complete({ model: 'm', messages: [] }), (error) => error.unknownOutcome === true && /^MALFORMED_/.test(error.code));
  }
});

test('OpenAI-compatible adapter bounds declared and chunked bodies and cancels unread data', async () => {
  const declared = streamedResponse([], { headers: { 'content-length': '4096' }, hang: true });
  const declaredProvider = createOpenAICompatibleProvider({ baseUrl: 'http://local', maxResponseBytes: 64, fetchImpl: async () => declared });
  await assert.rejects(
    declaredProvider.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'RESPONSE_TOO_LARGE' && error.unknownOutcome === true,
  );
  assert.equal(declared.cancelled, 1);

  const chunked = streamedResponse(['x'.repeat(40), 'y'.repeat(40)], { hang: true });
  const chunkedProvider = createOpenAICompatibleProvider({ baseUrl: 'http://local', maxResponseBytes: 64, fetchImpl: async () => chunked });
  await assert.rejects(
    chunkedProvider.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'RESPONSE_TOO_LARGE' && error.unknownOutcome === true,
  );
  assert.equal(chunked.cancelled, 1);
});

test('provider response body reads obey timeout and cancel a hanging stream', async () => {
  const hanging = streamedResponse([], { hang: true });
  const provider = createOpenAICompatibleProvider({ baseUrl: 'http://local', timeoutMs: 10, fetchImpl: async () => hanging });
  await assert.rejects(
    provider.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'TIMEOUT' && error.unknownOutcome === true && error.retryable === false,
  );
  assert.equal(hanging.cancelled, 1);
});

test('Anthropic adapter enforces the same result and response-size boundary', async () => {
  const validPayload = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 2, output_tokens: 1 },
  };
  const valid = createAnthropicProvider({
    apiKey: 'synthetic-key', baseUrl: 'https://anthropic.example',
    fetchImpl: async () => response(200, validPayload),
  });
  assert.deepEqual(await valid.complete({ model: 'm', messages: [] }), {
    stopReason: 'end_turn', text: 'ok', toolCalls: [], usage: { input_tokens: 2, output_tokens: 1 },
  });

  const invalid = createAnthropicProvider({
    apiKey: 'synthetic-key', baseUrl: 'https://anthropic.example',
    fetchImpl: async () => response(200, { ...validPayload, usage: { input_tokens: -2, output_tokens: 1 } }),
  });
  await assert.rejects(
    invalid.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'MALFORMED_PROVIDER_RESULT' && error.unknownOutcome === true,
  );

  const oversized = streamedResponse([], { headers: { 'content-length': '1024' }, hang: true });
  const bounded = createAnthropicProvider({
    apiKey: 'synthetic-key', baseUrl: 'https://anthropic.example', maxResponseBytes: 64,
    fetchImpl: async () => oversized,
  });
  await assert.rejects(
    bounded.complete({ model: 'm', messages: [] }),
    (error) => error.code === 'RESPONSE_TOO_LARGE' && error.unknownOutcome === true,
  );
  assert.equal(oversized.cancelled, 1);
});
