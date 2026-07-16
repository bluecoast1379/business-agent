import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutor } from '../src/runtime/execution/executor.js';
import { createIdempotencyStore } from '../src/runtime/execution/idempotency.js';
import { createMemoryStateStore } from '../src/stores/memory.js';
import {
  compileBlueprint,
  createWorkflowEngine,
  digestWorkflow,
  migrateWorkflow,
  validateWorkflow,
} from '../src/workflows/index.js';

function memoryCheckpoints() {
  const values = new Map();
  return {
    async get(namespace, key) { return structuredClone(values.get(`${namespace}:${key}`)); },
    async put(namespace, key, value) { values.set(`${namespace}:${key}`, structuredClone(value)); },
  };
}

function checkpoint(workflow, runId, patch = {}) {
  const timestamp = new Date(0).toISOString();
  return {
    schemaVersion: '1.0',
    runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowDigest: digestWorkflow(workflow),
    status: 'running',
    cursor: workflow.initial,
    state: {},
    completed: [],
    waitingAt: null,
    activeNode: null,
    pendingResume: null,
    reconciliationRequired: false,
    lease: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

function taskWorkflow(id = 'task-flow') {
  return {
    schemaVersion: '1.0', id, version: '1.0.0', initial: 'work',
    nodes: [
      { id: 'work', type: 'task', handler: 'work', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
}

const agent = { schemaVersion: '1.0', id: 'billing-agent', version: '1.0.0', model: 'mock', tools: ['lookup'] };

test('compiler rejects malformed, cyclic, and non-terminating graphs and is deterministic', () => {
  assert.throws(() => validateWorkflow({
    schemaVersion: '1.0', id: 'bad-flow', version: '1.0.0', initial: 'a',
    nodes: [{ id: 'a', type: 'task', handler: 'x', next: 'missing' }],
  }), /unknown node/);
  assert.throws(() => validateWorkflow({
    schemaVersion: '1.0', id: 'bad-flow', version: '1.0.0', initial: 'a',
    nodes: [{ id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
  }), /unreachable/);
  assert.throws(() => validateWorkflow({
    schemaVersion: '1.0', id: 'cycle-flow', version: '1.0.0', initial: 'a',
    nodes: [
      { id: 'a', type: 'task', handler: 'x', next: 'b' },
      { id: 'b', type: 'task', handler: 'x', next: 'a' },
    ],
  }), /cycle|end node/);
  assert.throws(() => validateWorkflow({
    schemaVersion: '1.0', id: 'branch-flow', version: '1.0.0', initial: 'route',
    nodes: [
      { id: 'route', type: 'branch', handler: 'route', branches: { yes: 'done' } },
      { id: 'done', type: 'end' },
    ],
  }), /requires default/);
  assert.throws(() => validateWorkflow({
    schemaVersion: '1.0', id: 'end-flow', version: '1.0.0', initial: 'done',
    nodes: [{ id: 'done', type: 'end', next: 'done' }],
  }), /must not have outgoing edges/);
  const workflow = { schemaVersion: '1.0', id: 'ok-flow', version: '1.0.0', initial: 'done', nodes: [{ id: 'done', type: 'end' }] };
  const firstLock = compileBlueprint({ agent, workflow });
  assert.equal(firstLock.sourceDigest, compileBlueprint({ agent, workflow }).sourceDigest);
  workflow.nodes[0].label = 'changed-after-compile';
  assert.equal(firstLock.workflow.nodes[0].label, undefined, 'compiled locks must be detached from mutable input');

  let getterCalls = 0;
  const accessorWorkflow = { ...workflow, nodes: [{ id: 'done', type: 'end' }] };
  Object.defineProperty(accessorWorkflow, 'metadata', {
    enumerable: true,
    get() { getterCalls += 1; return {}; },
  });
  assert.throws(() => compileBlueprint({ agent, workflow: accessorWorkflow }), /plain data object|data property/);
  assert.equal(getterCalls, 0, 'compiler must reject rather than invoke untrusted accessors');

  const circularWorkflow = { ...workflow, nodes: [{ id: 'done', type: 'end' }], metadata: {} };
  circularWorkflow.metadata.self = circularWorkflow.metadata;
  assert.throws(() => compileBlueprint({ agent, workflow: circularWorkflow }), /circular/);
  assert.throws(() => compileBlueprint({ agent: { ...agent, temperature: Number.POSITIVE_INFINITY }, workflow }), /non-finite/);
});

test('workflow executes branch, handoff, interrupt/resume and does not repeat committed nodes', async () => {
  const checkpointStore = memoryCheckpoints();
  let taskCalls = 0;
  let handoffs = 0;
  const workflow = {
    schemaVersion: '1.0', id: 'approval-flow', version: '1.0.0', initial: 'prepare',
    nodes: [
      { id: 'prepare', type: 'task', handler: 'prepare', next: 'route' },
      { id: 'route', type: 'branch', handler: 'route', branches: { approve: 'wait' }, default: 'done' },
      { id: 'wait', type: 'interrupt', next: 'handoff' },
      { id: 'handoff', type: 'handoff', handler: 'handoff', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const engine = createWorkflowEngine({ workflow, checkpointStore, handlers: {
    prepare: async ({ state }) => { taskCalls += 1; state.prepared = true; return 'prepared'; },
    route: async () => 'approve',
    handoff: async ({ resumeInput }) => { handoffs += 1; return resumeInput; },
  } });
  const waiting = await engine.run({ runId: 'run-1', state: { amount: 10 } });
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal((await engine.run({ runId: 'run-1' })).status, 'waiting_approval');
  const finished = await engine.run({ runId: 'run-1', resumeInput: { approved: true } });
  assert.equal(finished.status, 'succeeded');
  assert.equal(taskCalls, 1);
  assert.equal(handoffs, 1);
  assert.deepEqual(finished.state.outputs.handoff, { approved: true });
  assert.equal((await engine.run({ runId: 'run-1' })).status, 'succeeded');
  assert.equal(taskCalls, 1);
  await assert.rejects(
    engine.run({ runId: 'run-1', resumeInput: { approved: true } }),
    (error) => error.code === 'WORKFLOW_NOT_WAITING',
  );
});

test('branch routing and handler lookup ignore inherited object properties', async () => {
  const workflow = {
    schemaVersion: '1.0', id: 'prototype-flow', version: '1.0.0', initial: 'route',
    nodes: [
      { id: 'route', type: 'branch', handler: 'route', branches: { yes: 'alternate' }, default: 'done' },
      { id: 'alternate', type: 'end' },
      { id: 'done', type: 'end' },
    ],
  };
  const engine = createWorkflowEngine({ workflow, handlers: { route: async () => 'constructor' } });
  const result = await engine.run({ runId: 'prototype-branch' });
  assert.deepEqual(result.completed, ['route', 'done']);

  const inheritedHandlerWorkflow = {
    ...taskWorkflow('inherited-handler-flow'),
    nodes: [{ id: 'work', type: 'task', handler: 'toString', next: 'done' }, { id: 'done', type: 'end' }],
  };
  const inheritedHandlerEngine = createWorkflowEngine({ workflow: inheritedHandlerWorkflow, handlers: {} });
  await assert.rejects(
    inheritedHandlerEngine.run({ runId: 'inherited-handler' }),
    /missing handler toString/,
  );
});

test('resumeInput is accepted only at an interrupt and is delivered to one downstream node', async () => {
  const store = createMemoryStateStore();
  const seen = [];
  const workflow = {
    schemaVersion: '1.0', id: 'resume-flow', version: '1.0.0', initial: 'wait',
    nodes: [
      { id: 'wait', type: 'interrupt', next: 'first' },
      { id: 'first', type: 'task', handler: 'first', next: 'second' },
      { id: 'second', type: 'task', handler: 'second', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const engine = createWorkflowEngine({ workflow, checkpointStore: store, handlers: {
    first: async ({ resumeInput }) => { seen.push(resumeInput); return 'first'; },
    second: async ({ resumeInput }) => { seen.push(resumeInput); return 'second'; },
  } });
  await assert.rejects(
    engine.run({ runId: 'resume-new', resumeInput: { approved: true } }),
    (error) => error.code === 'WORKFLOW_NOT_WAITING',
  );
  assert.equal((await engine.run({ runId: 'resume-new' })).status, 'waiting_approval');
  await assert.rejects(
    engine.run({ runId: 'resume-new', resumeInput: { invalid: () => true } }),
    (error) => error.code === 'WORKFLOW_STATE_INVALID',
  );
  assert.equal((await engine.run({ runId: 'resume-new' })).status, 'waiting_approval');
  const result = await engine.run({ runId: 'resume-new', resumeInput: { approved: true } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(seen, [{ approved: true }, undefined]);
});

test('timeout has an unknown outcome, suppresses compensation, and persists reconciliation state', async () => {
  const checkpointStore = memoryCheckpoints();
  let compensated = 0;
  const workflow = {
    schemaVersion: '1.0', id: 'timeout-flow', version: '1.0.0', initial: 'slow',
    nodes: [{ id: 'slow', type: 'task', handler: 'slow', timeoutMs: 5, compensation: 'undo', next: 'done' }, { id: 'done', type: 'end' }],
  };
  const engine = createWorkflowEngine({ workflow, checkpointStore, handlers: {
    slow: () => new Promise(() => {}),
    undo: async () => { compensated += 1; },
  } });
  await assert.rejects(
    engine.run({ runId: 'run-timeout' }),
    (error) => error.code === 'WORKFLOW_NODE_TIMEOUT'
      && error.unknownOutcome === true
      && error.reconciliationRequired === true,
  );
  assert.equal(compensated, 0, 'an ambiguous node must never be blindly compensated');
  const saved = await checkpointStore.get('run', 'run-timeout');
  assert.equal(saved.status, 'reconciliation_required');
  assert.equal(saved.activeNode.phase, 'executing');
});

test('a known failure can run configured compensation exactly once', async () => {
  const store = createMemoryStateStore();
  let compensated = 0;
  const workflow = {
    ...taskWorkflow('compensate-flow'),
    nodes: [
      { id: 'work', type: 'task', handler: 'work', compensation: 'undo', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const failure = Object.assign(new Error('known rejection'), { code: 'KNOWN_REJECTION', unknownOutcome: false });
  const engine = createWorkflowEngine({ workflow, checkpointStore: store, handlers: {
    work: async () => { throw failure; },
    undo: async ({ error }) => { assert.equal(error.code, 'KNOWN_REJECTION'); compensated += 1; return 'undone'; },
  } });
  await assert.rejects(engine.run({ runId: 'known-failure' }), (error) => error.code === 'KNOWN_REJECTION');
  assert.equal(compensated, 1);
  const saved = (await store.get('run', 'known-failure')).value;
  assert.equal(saved.status, 'failed');
  assert.deepEqual(saved.state.compensated, ['work']);
  assert.equal((await engine.run({ runId: 'known-failure' })).status, 'failed');
  assert.equal(compensated, 1);
});

test('a generic handler failure after an external effect defaults to reconciliation and suppresses compensation', async () => {
  const store = createMemoryStateStore();
  let sideEffects = 0;
  let compensated = 0;
  const workflow = {
    ...taskWorkflow('ambiguous-generic-failure-flow'),
    nodes: [
      { id: 'work', type: 'task', handler: 'work', compensation: 'undo', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const engine = createWorkflowEngine({ workflow, checkpointStore: store, handlers: {
    work: async () => { sideEffects += 1; throw new Error('socket closed after submit'); },
    undo: async () => { compensated += 1; },
  } });
  await assert.rejects(
    engine.run({ runId: 'ambiguous-generic-failure' }),
    (error) => error.unknownOutcome === true && error.reconciliationRequired === true,
  );
  assert.equal(sideEffects, 1);
  assert.equal(compensated, 0);
  assert.equal((await store.get('run', 'ambiguous-generic-failure')).value.status, 'reconciliation_required');
  assert.equal((await engine.run({ runId: 'ambiguous-generic-failure' })).status, 'reconciliation_required');
  assert.equal(sideEffects, 1);
});

test('a failed terminal compensation save reconciles from durable undo evidence without replay', async () => {
  const durableStore = createMemoryStateStore();
  let terminalSaveFailures = 0;
  const checkpointStore = {
    ...durableStore,
    async transaction(callback) {
      return durableStore.transaction((tx) => callback({
        ...tx,
        put(namespace, key, value, options) {
          const isCompensatedTerminalSave = namespace === 'run'
            && value.status === 'failed'
            && value.activeNode === null
            && value.state?.undoReceipt === 'undo-receipt-1'
            && value.state?.compensated?.includes('work');
          if (isCompensatedTerminalSave && terminalSaveFailures === 0) {
            terminalSaveFailures += 1;
            throw Object.assign(new Error('injected terminal checkpoint failure'), {
              code: 'CHECKPOINT_FINALIZE_FAILPOINT',
            });
          }
          return tx.put(namespace, key, value, options);
        },
      }));
    },
  };
  const workflow = {
    ...taskWorkflow('compensation-finalize-failure-flow'),
    nodes: [
      { id: 'work', type: 'task', handler: 'work', compensation: 'undo', next: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
  const knownFailure = Object.assign(new Error('known rejection'), {
    code: 'KNOWN_REJECTION',
    unknownOutcome: false,
  });
  let workCalls = 0;
  let compensationCalls = 0;
  const handlers = {
    work: async () => { workCalls += 1; throw knownFailure; },
    undo: async ({ state }) => {
      compensationCalls += 1;
      state.undoReceipt = 'undo-receipt-1';
      return 'undone';
    },
  };
  const firstEngine = createWorkflowEngine({ workflow, checkpointStore, handlers, instanceId: 'first-engine' });

  await assert.rejects(
    firstEngine.run({ runId: 'compensation-finalize-failure' }),
    (error) => error.code === 'CHECKPOINT_FINALIZE_FAILPOINT'
      && error.unknownOutcome === true
      && error.reconciliationRequired === true,
  );
  assert.equal(terminalSaveFailures, 1);
  assert.equal(workCalls, 1);
  assert.equal(compensationCalls, 1);

  const persisted = (await durableStore.get('run', 'compensation-finalize-failure')).value;
  assert.equal(persisted.status, 'reconciliation_required');
  assert.equal(persisted.activeNode.phase, 'compensating');
  assert.equal(persisted.error.phase, 'compensating');
  assert.equal(persisted.state.undoReceipt, 'undo-receipt-1');
  assert.deepEqual(persisted.state.compensated, ['work']);

  const restarted = createWorkflowEngine({ workflow, checkpointStore, handlers, instanceId: 'restarted-engine' });
  const recovered = await restarted.run({ runId: 'compensation-finalize-failure' });
  assert.equal(recovered.status, 'reconciliation_required');
  assert.equal(recovered.state.undoReceipt, 'undo-receipt-1');
  assert.deepEqual(recovered.state.compensated, ['work']);
  assert.equal(workCalls, 1, 'restart must not replay the failed workflow node');
  assert.equal(compensationCalls, 1, 'restart must not replay a durably evidenced compensation');
});

test('transactional lease and heartbeat exclude concurrent engines for the same runId', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('leased-flow');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const handlers = {
    work: async () => { calls += 1; started(); await gate; return 'ok'; },
  };
  const first = createWorkflowEngine({
    workflow, handlers, checkpointStore: store, instanceId: 'engine-a', leaseMs: 30, leaseHeartbeatMs: 5,
  });
  const second = createWorkflowEngine({
    workflow, handlers, checkpointStore: store, instanceId: 'engine-b', leaseMs: 30, leaseHeartbeatMs: 5,
  });
  const pending = first.run({ runId: 'shared-run' });
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 70));
  await assert.rejects(
    second.run({ runId: 'shared-run' }),
    (error) => error.code === 'WORKFLOW_RUN_IN_PROGRESS' && error.unknownOutcome !== true,
  );
  release();
  assert.equal((await pending).status, 'succeeded');
  assert.equal(calls, 1);
});

test('expired active node without committed executor evidence is fenced into reconciliation', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('abandoned-flow');
  let calls = 0;
  await store.put('run', 'abandoned', checkpoint(workflow, 'abandoned', {
    activeNode: { nodeId: 'work', phase: 'executing', fencingToken: 4, startedAt: new Date(0).toISOString() },
    lease: { ownerId: 'dead-instance', fencingToken: 4, expiresAt: 999 },
  }));
  const engine = createWorkflowEngine({
    workflow,
    handlers: { work: async () => { calls += 1; return 'unsafe replay'; } },
    checkpointStore: store,
    now: () => 1_000,
    instanceId: 'recovery-instance',
  });
  const result = await engine.run({ runId: 'abandoned' });
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(result.error.code, 'WORKFLOW_ABANDONED_NODE');
  assert.equal(calls, 0);
});

test('committed executor evidence restores handler state without replay after checkpoint loss', async () => {
  const store = createMemoryStateStore();
  // Use the same durable store for executor evidence and workflow checkpoints.
  const durableExecutor = createExecutor({
    idempotency: createIdempotencyStore({ stateStore: store, now: () => 1_000 }),
  });
  const workflow = taskWorkflow('evidence-flow');
  const runId = 'lost-checkpoint';
  const key = JSON.stringify(['workflow-node-v1', workflow.id, workflow.version, runId, 'work', 'execute']);
  await durableExecutor.execute({
    name: 'seed.workflow.evidence',
    idempotent: true,
    persistIdempotencyResult: true,
    idempotencyKey: key,
    operation: async () => ({
      schemaVersion: '1.0',
      output: { ok: true },
      state: { before: true, mutationSurvived: true },
    }),
  });
  await store.put('run', runId, checkpoint(workflow, runId, {
    state: { before: true },
    activeNode: { nodeId: 'work', phase: 'executing', fencingToken: 2, startedAt: new Date(0).toISOString() },
    lease: { ownerId: 'crashed-instance', fencingToken: 2, expiresAt: 999 },
  }));
  let handlerCalls = 0;
  const engine = createWorkflowEngine({
    workflow,
    handlers: { work: async () => { handlerCalls += 1; throw new Error('must not replay'); } },
    checkpointStore: store,
    executor: durableExecutor,
    now: () => 1_000,
    instanceId: 'recovery-instance',
  });
  const result = await engine.run({ runId });
  assert.equal(result.status, 'succeeded');
  assert.equal(handlerCalls, 0);
  assert.equal(result.state.mutationSurvived, true);
  assert.deepEqual(result.state.outputs.work, { ok: true });
  const compacted = await durableExecutor.idempotency.get(key);
  assert.equal(compacted.status, 'committed');
  assert.equal(Object.hasOwn(compacted, 'value'), false);
});

test('expired or compacted executor evidence cannot authorize workflow replay', async () => {
  const store = createMemoryStateStore();
  let clock = 1_000;
  const idempotency = createIdempotencyStore({
    stateStore: store,
    now: () => clock,
    resultRetentionMs: 1,
  });
  const executor = createExecutor({ idempotency });
  const workflow = taskWorkflow('expired-evidence-flow');
  const runId = 'expired-evidence';
  const key = JSON.stringify(['workflow-node-v1', workflow.id, workflow.version, runId, 'work', 'execute']);
  await executor.execute({
    name: 'seed.expiring.evidence',
    idempotent: true,
    persistIdempotencyResult: true,
    idempotencyKey: key,
    operation: async () => ({ schemaVersion: '1.0', output: 'ok', state: { mutation: true } }),
  });
  await store.put('run', runId, checkpoint(workflow, runId, {
    state: { outputs: {} },
    nodeOutputs: {},
    activeNode: { nodeId: 'work', phase: 'executing', fencingToken: 2, startedAt: new Date(0).toISOString() },
    lease: { ownerId: 'crashed-instance', fencingToken: 2, expiresAt: clock },
  }));
  clock += 2;
  let calls = 0;
  const engine = createWorkflowEngine({
    workflow,
    handlers: { work: async () => { calls += 1; return 'unsafe replay'; } },
    checkpointStore: store,
    executor,
    now: () => clock,
  });
  const result = await engine.run({ runId });
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(await idempotency.get(key), 'value'), false);
});

test('workflow opts into temporary idempotency evidence and compacts it only after checkpoint CAS', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('compact-flow');
  const executionOptions = [];
  const compacted = [];
  const executor = {
    async execute(options) {
      executionOptions.push(options);
      return { value: await options.operation({ signal: options.signal ?? new AbortController().signal }) };
    },
    idempotency: {
      async get() { return null; },
      async compact(key) {
        const saved = (await store.get('run', 'compact-run')).value;
        assert.deepEqual(saved.completed, ['work']);
        assert.equal(saved.activeNode, null);
        compacted.push(key);
      },
    },
  };
  const engine = createWorkflowEngine({
    workflow,
    checkpointStore: store,
    executor,
    handlers: { work: async ({ state }) => { state.saved = true; return 'ok'; } },
  });
  const result = await engine.run({ runId: 'compact-run' });
  assert.equal(result.status, 'succeeded');
  assert.equal(executionOptions[0].persistIdempotencyResult, true);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0], executionOptions[0].idempotencyKey);
});

test('idempotency evidence compaction failure blocks downstream work without compensation or replay', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('compact-failure-flow');
  let calls = 0;
  let compensations = 0;
  const executor = {
    async execute(options) {
      return { value: await options.operation({ signal: new AbortController().signal }) };
    },
    idempotency: {
      async get() { return null; },
      async compact() { throw new Error('storage unavailable'); },
    },
  };
  workflow.nodes[0].compensation = 'undo';
  const engine = createWorkflowEngine({
    workflow,
    checkpointStore: store,
    executor,
    handlers: {
      work: async () => { calls += 1; return 'committed'; },
      undo: async () => { compensations += 1; return 'unsafe'; },
    },
  });
  await assert.rejects(
    engine.run({ runId: 'compact-failure' }),
    (error) => error.code === 'WORKFLOW_EVIDENCE_COMPACTION_UNKNOWN'
      && error.reconciliationRequired === true,
  );
  assert.equal(calls, 1);
  assert.equal(compensations, 0);
  const saved = (await store.get('run', 'compact-failure')).value;
  assert.equal(saved.status, 'reconciliation_required');
  assert.deepEqual(saved.completed, ['work']);
});

test('stale fencing token cannot commit a completed node', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('fenced-flow');
  let clock = 1_000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const first = createWorkflowEngine({
    workflow,
    handlers: { work: async () => { calls += 1; entered(); await gate; return 'side-effect-complete'; } },
    checkpointStore: store,
    now: () => clock,
    instanceId: 'owner-a',
    leaseMs: 1_000,
    leaseHeartbeatMs: 900,
  });
  const pending = first.run({ runId: 'fenced-run' });
  await started;
  await store.transaction(async (tx) => {
    const record = tx.get('run', 'fenced-run');
    tx.put('run', 'fenced-run', {
      ...record.value,
      lease: { ownerId: 'owner-b', fencingToken: record.value.lease.fencingToken + 1, expiresAt: clock + 1_000 },
    }, { ifRevision: record.revision });
  });
  release();
  await assert.rejects(pending, (error) => error.unknownOutcome === true && error.reconciliationRequired === true);
  assert.equal((await store.get('run', 'fenced-run')).value.status, 'running');
  clock += 2_000;
  const second = createWorkflowEngine({
    workflow,
    handlers: { work: async () => { calls += 1; return 'unsafe replay'; } },
    checkpointStore: store,
    now: () => clock,
    instanceId: 'owner-c',
  });
  const result = await second.run({ runId: 'fenced-run' });
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(calls, 1);
});

test('checkpoint workflow/version/cursor corruption fails closed before handlers run', async () => {
  const workflow = taskWorkflow('integrity-flow');
  for (const [runId, corrupt, code] of [
    ['wrong-workflow', { workflowId: 'other-flow' }, 'WORKFLOW_CHECKPOINT_MISMATCH'],
    ['wrong-version', { workflowVersion: '2.0.0' }, 'WORKFLOW_CHECKPOINT_MIGRATION_REQUIRED'],
    ['wrong-cursor', { cursor: 'missing' }, 'WORKFLOW_CHECKPOINT_CORRUPT'],
    ['forged-path', { completed: ['work'], cursor: 'done' }, 'WORKFLOW_CHECKPOINT_CORRUPT'],
  ]) {
    const store = createMemoryStateStore();
    await store.put('run', runId, checkpoint(workflow, runId, corrupt));
    let calls = 0;
    const engine = createWorkflowEngine({
      workflow,
      checkpointStore: store,
      handlers: { work: async () => { calls += 1; return 'unsafe'; } },
    });
    await assert.rejects(engine.run({ runId }), (error) => error.code === code);
    assert.equal(calls, 0);
  }
});

test('initial workflow state cannot pre-seed the reserved committed outputs channel', async () => {
  const engine = createWorkflowEngine({
    workflow: taskWorkflow('reserved-state-flow'),
    handlers: { work: async () => 'safe' },
  });
  await assert.rejects(
    engine.run({ runId: 'reserved-state', state: { outputs: { work: 'forged' } } }),
    (error) => error.code === 'WORKFLOW_STATE_INVALID',
  );
});

test('pre-execution cancellation commits cancelled state without invoking the node', async () => {
  const store = createMemoryStateStore();
  const workflow = taskWorkflow('cancel-flow');
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  const engine = createWorkflowEngine({
    workflow,
    checkpointStore: store,
    handlers: { work: async () => { calls += 1; return 'unsafe'; } },
  });
  await assert.rejects(engine.run({ runId: 'cancelled', signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
  assert.equal((await store.get('run', 'cancelled')).value.status, 'cancelled');
});

test('v0.9 workflow migration is deterministic and unsupported versions fail', () => {
  const old = { schemaVersion: '0.9', id: 'old-flow', version: '1.0.0', start: 'done', nodes: { done: { type: 'end' } } };
  assert.deepEqual(migrateWorkflow(old), migrateWorkflow(old));
  assert.equal(migrateWorkflow(old).initial, 'done');
  assert.throws(() => migrateWorkflow({ schemaVersion: '99' }), /unsupported/);
});
