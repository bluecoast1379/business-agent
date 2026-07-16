import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/runtime/agent.js';
import { createCostTracker } from '../src/runtime/cost-tracker.js';
import { createExecutor } from '../src/runtime/execution/index.js';
import { defineTool } from '../src/runtime/tool.js';

test('an ignored-abort write timeout stops the agent and requires reconciliation', async () => {
  let providerCalls = 0;
  let sideEffects = 0;
  const provider = {
    name: 'reconciliation-fixture',
    async complete() {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          stopReason: 'tool_use',
          text: '',
          toolCalls: [{ id: 'write-1', name: 'slow_write', args: { value: 'synthetic' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return { stopReason: 'end_turn', text: 'must-not-continue', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const tool = defineTool({
    name: 'slow_write',
    params: { properties: { value: { type: 'string' } }, required: ['value'] },
    async handler() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      sideEffects += 1;
      return { ok: true };
    },
  });
  tool.policy = { idempotency: 'required', timeoutMs: 5 };
  const agent = createAgent({
    name: 'reconciliation-agent',
    model: 'fixture',
    systemPrompt: 'fixture',
    tools: [tool],
    provider,
    costTracker: createCostTracker(),
    executor: createExecutor(),
  });

  await assert.rejects(
    agent.prompt('write', { operationId: 'stable-operation' }),
    (error) => error.code === 'TIMEOUT' && error.reconciliationRequired === true,
  );
  assert.equal(providerCalls, 1, 'the model must not continue after an unknown tool outcome');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sideEffects, 1);

  await assert.rejects(
    agent.prompt('write', { operationId: 'stable-operation' }),
    (error) => error.code === 'IDEMPOTENCY_UNKNOWN' && error.reconciliationRequired === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sideEffects, 1, 'same operation id must not replay an unknown write');
});
