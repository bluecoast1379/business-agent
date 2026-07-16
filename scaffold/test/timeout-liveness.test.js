import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const SCAFFOLD_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function moduleUrl(relativePath) {
  return pathToFileURL(join(SCAFFOLD_ROOT, relativePath)).href;
}

function runIsolated(name, source, expectedOutput) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: SCAFFOLD_ROOT,
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  });
  const diagnostics = [
    `${name} did not settle in an isolated Node process`,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    `stdout=${result.stdout ?? ''}`,
    `stderr=${result.stderr ?? ''}`,
    result.error ? `error=${result.error.message}` : '',
  ].filter(Boolean).join('\n');
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  assert.match(result.stdout, expectedOutput, diagnostics);
}

test('provider request deadlines settle when injected fetch ignores abort', () => {
  runIsolated('provider request deadlines', `
    const { createOpenAICompatibleProvider } = await import(${JSON.stringify(moduleUrl('src/providers/openai-compatible.js'))});
    const { createAnthropicProvider } = await import(${JSON.stringify(moduleUrl('src/runtime/llm.js'))});
    const never = () => new Promise(() => {});
    const providers = [
      createOpenAICompatibleProvider({ baseUrl: 'http://local', timeoutMs: 15, fetchImpl: never }),
      createAnthropicProvider({ baseUrl: 'http://local', timeoutMs: 15, fetchImpl: never }),
    ];
    for (const provider of providers) {
      try {
        await provider.complete({ model: 'fixture-model', messages: [] });
        throw new Error('provider unexpectedly completed');
      } catch (error) {
        if (error.code !== 'TIMEOUT') throw error;
      }
    }
    console.log('provider-timeouts-settled');
  `, /provider-timeouts-settled/);
});

test('Anthropic response-body deadline settles on a hanging stream', () => {
  runIsolated('Anthropic body deadline', `
    const { createAnthropicProvider } = await import(${JSON.stringify(moduleUrl('src/runtime/llm.js'))});
    const provider = createAnthropicProvider({
      baseUrl: 'http://local',
      timeoutMs: 15,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
    });
    try {
      await provider.complete({ model: 'fixture-model', messages: [] });
      throw new Error('provider unexpectedly completed');
    } catch (error) {
      if (error.code !== 'TIMEOUT') throw error;
    }
    console.log('anthropic-body-timeout-settled');
  `, /anthropic-body-timeout-settled/);
});

test('OTLP export deadline settles when injected fetch ignores abort', () => {
  runIsolated('OTLP export deadline', `
    const { createOtlpHttpJsonSink } = await import(${JSON.stringify(moduleUrl('src/observability/telemetry.js'))});
    const sink = createOtlpHttpJsonSink({
      endpoint: 'http://collector.local',
      timeoutMs: 15,
      fetchImpl: () => new Promise(() => {}),
    });
    try {
      await sink.export({
        kind: 'metric',
        name: 'liveness',
        value: 1,
        observedAt: new Date(0).toISOString(),
        attributes: {},
      });
      throw new Error('export unexpectedly completed');
    } catch (error) {
      if (error.code !== 'OTLP_TIMEOUT') throw error;
    }
    console.log('otlp-timeout-settled');
  `, /otlp-timeout-settled/);
});

test('successful provider and telemetry calls clear long deadline timers', () => {
  runIsolated('successful deadline cleanup', `
    const { createOpenAICompatibleProvider } = await import(${JSON.stringify(moduleUrl('src/providers/openai-compatible.js'))});
    const { createAnthropicProvider } = await import(${JSON.stringify(moduleUrl('src/runtime/llm.js'))});
    const { createOtlpHttpJsonSink } = await import(${JSON.stringify(moduleUrl('src/observability/telemetry.js'))});
    const openai = createOpenAICompatibleProvider({
      baseUrl: 'http://local',
      timeoutMs: 60_000,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'ok', tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    });
    const anthropic = createAnthropicProvider({
      baseUrl: 'http://local',
      timeoutMs: 60_000,
      fetchImpl: async () => new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    });
    const telemetry = createOtlpHttpJsonSink({
      endpoint: 'http://collector.local',
      timeoutMs: 60_000,
      fetchImpl: async () => ({ ok: true }),
    });
    await openai.complete({ model: 'fixture-model', messages: [] });
    await anthropic.complete({ model: 'fixture-model', messages: [] });
    await telemetry.export({
      kind: 'metric',
      name: 'cleanup',
      value: 1,
      observedAt: new Date(0).toISOString(),
      attributes: {},
    });
    console.log('deadline-timers-cleared');
  `, /deadline-timers-cleared/);
});

test('retry delay remains live until it settles', () => {
  runIsolated('retry delay', `
    const { abortableDelay } = await import(${JSON.stringify(moduleUrl('src/runtime/execution/retry-policy.js'))});
    await abortableDelay(15);
    console.log('retry-delay-settled');
  `, /retry-delay-settled/);
});

test('workflow and durable scheduler deadlines settle hanging work', () => {
  runIsolated('workflow and scheduler deadlines', `
    const { createWorkflowEngine } = await import(${JSON.stringify(moduleUrl('src/workflows/index.js'))});
    const { createDurableScheduler } = await import(${JSON.stringify(moduleUrl('src/schedulers/index.js'))});
    const { createMemoryStateStore } = await import(${JSON.stringify(moduleUrl('src/stores/index.js'))});
    const checkpoints = new Map();
    const checkpointStore = {
      async get(namespace, key) {
        return structuredClone(checkpoints.get(namespace + ':' + key));
      },
      async put(namespace, key, value) {
        checkpoints.set(namespace + ':' + key, structuredClone(value));
      },
    };
    const workflow = {
      schemaVersion: '1.0',
      id: 'timeout-liveness',
      version: '1.0.0',
      initial: 'slow',
      nodes: [
        { id: 'slow', type: 'task', handler: 'slow', timeoutMs: 15, next: 'done' },
        { id: 'done', type: 'end' },
      ],
    };
    const engine = createWorkflowEngine({
      workflow,
      checkpointStore,
      handlers: { slow: () => new Promise(() => {}) },
    });
    try {
      await engine.run({ runId: 'isolated-timeout' });
      throw new Error('workflow unexpectedly completed');
    } catch (error) {
      if (error.code !== 'WORKFLOW_NODE_TIMEOUT') throw error;
    }

    const stateStore = createMemoryStateStore();
    const scheduler = createDurableScheduler({ stateStore, instanceId: 'timeout-liveness' });
    scheduler.registerJob({
      name: 'hung-job',
      schedule: {},
      timeoutMs: 15,
      run: async () => new Promise(() => {}),
    });
    const result = await scheduler.runNow('hung-job', { runId: 'manual:timeout-liveness' });
    if (result.skipped !== 'reconciliation_required') {
      throw new Error('scheduler did not persist reconciliation');
    }
    await scheduler.stop();
    await stateStore.close();
    console.log('workflow-scheduler-timeouts-settled');
  `, /workflow-scheduler-timeouts-settled/);
});

test('webhook in-flight TTL settles a waiting duplicate', () => {
  runIsolated('webhook in-flight TTL', `
    const { createWebhookReplayStore } = await import(${JSON.stringify(moduleUrl('src/channels/webhook.js'))});
    const replayStore = createWebhookReplayStore();
    const input = {
      integrationId: 'fixture-integration',
      eventId: 'fixture-event',
      payloadHash: 'a'.repeat(64),
      ttlMs: 15,
    };
    const first = await replayStore.claim(input);
    if (!first.claimed) throw new Error('first claim was not accepted');
    const duplicate = await replayStore.claim(input);
    if (duplicate.status !== 'running' || !duplicate.waitForResponse) {
      throw new Error('duplicate did not receive settlement promise');
    }
    const settlement = await duplicate.waitForResponse;
    if (settlement.status !== 'unknown') throw new Error('expired in-flight claim was not unknown');
    console.log('webhook-ttl-settled');
  `, /webhook-ttl-settled/);
});
