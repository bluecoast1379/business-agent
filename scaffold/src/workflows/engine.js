import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { digestWorkflow } from './compiler.js';
import { validateWorkflow } from './validator.js';

const CHECKPOINT_STATUSES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'reconciliation_required',
]);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'reconciliation_required']);
const legacyStoreLocks = new WeakMap();

function workflowError(code, message, { statusCode, unknownOutcome = false, cause } = {}) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    ...(statusCode ? { statusCode } : {}),
    ...(unknownOutcome ? { unknownOutcome: true, reconciliationRequired: true } : {}),
  });
}

function asError(value, fallbackCode = 'WORKFLOW_HANDLER_FAILED') {
  if (value instanceof Error) return value;
  return workflowError(fallbackCode, '[workflow] handler failed with a non-Error value');
}

function assertJsonValue(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') {
    throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must contain JSON-compatible values only`);
  }
  if (ancestors.has(value)) throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must not be circular`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) {
      throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must be a dense data array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must be a dense data array`);
      }
      assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must be a plain data object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw workflowError('WORKFLOW_STATE_INVALID', `[workflow] ${path} must use enumerable data properties only`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function jsonClone(value, path = 'value') {
  assertJsonValue(value, path);
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeCheckpoint(saved) {
  const checkpoint = jsonClone(saved, 'checkpoint');
  checkpoint.waitingAt ??= null;
  checkpoint.lease ??= null;
  checkpoint.activeNode ??= null;
  checkpoint.pendingResume ??= null;
  checkpoint.reconciliationRequired ??= false;
  checkpoint.nodeOutputs ??= isPlainObject(checkpoint.state?.outputs)
    ? jsonClone(checkpoint.state.outputs, 'checkpoint.state.outputs')
    : {};
  return checkpoint;
}

function branchTarget(node, output) {
  const key = String(output);
  return Object.hasOwn(node.branches, key) ? node.branches[key] : node.default;
}

function validateCheckpoint(saved, { runId, workflow, workflowDigest, nodes }) {
  let checkpoint;
  try {
    checkpoint = normalizeCheckpoint(saved);
  } catch (error) {
    throw workflowError(
      'WORKFLOW_CHECKPOINT_CORRUPT',
      '[workflow] checkpoint contains invalid or non-JSON data',
      { unknownOutcome: true, cause: error },
    );
  }
  const corrupt = (message) => {
    throw workflowError('WORKFLOW_CHECKPOINT_CORRUPT', `[workflow] checkpoint ${message}`, { unknownOutcome: true });
  };
  if (!isPlainObject(checkpoint)) corrupt('must be a plain object');
  if (checkpoint.schemaVersion !== '1.0') corrupt('schemaVersion is unsupported');
  if (checkpoint.runId !== runId) corrupt('runId does not match its storage key');
  if (checkpoint.workflowId !== workflow.id) {
    throw workflowError('WORKFLOW_CHECKPOINT_MISMATCH', '[workflow] runId belongs to a different workflow', { unknownOutcome: true });
  }
  if (checkpoint.workflowVersion !== workflow.version) {
    throw workflowError('WORKFLOW_CHECKPOINT_MIGRATION_REQUIRED', '[workflow] checkpoint version requires migration');
  }
  if (checkpoint.workflowDigest !== workflowDigest) {
    throw workflowError('WORKFLOW_CHECKPOINT_MISMATCH', '[workflow] checkpoint definition digest does not match this workflow', { unknownOutcome: true });
  }
  if (!CHECKPOINT_STATUSES.has(checkpoint.status)) corrupt('status is invalid');
  if (checkpoint.cursor !== null && (typeof checkpoint.cursor !== 'string' || !nodes.has(checkpoint.cursor))) {
    corrupt('cursor is invalid');
  }
  if (!isPlainObject(checkpoint.state)) corrupt('state must be an object');
  if (!isPlainObject(checkpoint.nodeOutputs)) corrupt('nodeOutputs must be an object');
  if (!Array.isArray(checkpoint.completed)
      || checkpoint.completed.some((id) => typeof id !== 'string' || !nodes.has(id))
      || new Set(checkpoint.completed).size !== checkpoint.completed.length) {
    corrupt('completed nodes are invalid');
  }
  if (!isoTime(checkpoint.startedAt) || !isoTime(checkpoint.updatedAt)) corrupt('timestamps are invalid');
  if (checkpoint.waitingAt !== null
      && (typeof checkpoint.waitingAt !== 'string' || nodes.get(checkpoint.waitingAt)?.type !== 'interrupt')) {
    corrupt('waitingAt is invalid');
  }
  if (checkpoint.status === 'waiting_approval'
      && (checkpoint.waitingAt === null || checkpoint.cursor !== checkpoint.waitingAt)) {
    corrupt('waiting state is inconsistent');
  }
  if (checkpoint.status !== 'waiting_approval' && checkpoint.waitingAt !== null) {
    corrupt('waitingAt is only valid while waiting for approval');
  }
  if (checkpoint.status === 'succeeded' && checkpoint.cursor !== null) corrupt('succeeded state must not have a cursor');
  if (checkpoint.status === 'succeeded'
      && !checkpoint.completed.some((id) => nodes.get(id)?.type === 'end')) {
    corrupt('succeeded state has no completed end node');
  }
  if (!TERMINAL_STATUSES.has(checkpoint.status) && checkpoint.cursor === null) corrupt('non-terminal state requires a cursor');
  if (checkpoint.cursor && checkpoint.completed.includes(checkpoint.cursor)) corrupt('cursor points to a completed node');

  let expectedCursor = workflow.initial;
  const outputNodes = new Set();
  for (const completedId of checkpoint.completed) {
    if (completedId !== expectedCursor) corrupt('completed path is inconsistent with the graph');
    const completedNode = nodes.get(completedId);
    if (['task', 'branch', 'handoff'].includes(completedNode.type)) {
      if (!Object.hasOwn(checkpoint.nodeOutputs, completedId)) corrupt(`output evidence is missing for ${completedId}`);
      outputNodes.add(completedId);
    }
    if (completedNode.type === 'end') expectedCursor = null;
    else if (completedNode.type === 'branch') expectedCursor = branchTarget(completedNode, checkpoint.nodeOutputs[completedId]);
    else expectedCursor = completedNode.next;
  }
  if (checkpoint.cursor !== expectedCursor) corrupt('cursor does not match the committed path');
  if (Object.keys(checkpoint.nodeOutputs).some((id) => !outputNodes.has(id))) {
    corrupt('nodeOutputs contains uncommitted output evidence');
  }
  if (!isDeepStrictEqual(checkpoint.state.outputs ?? {}, checkpoint.nodeOutputs)) {
    corrupt('public outputs diverge from committed output evidence');
  }

  if (checkpoint.lease !== null) {
    const lease = checkpoint.lease;
    if (!isPlainObject(lease)
        || typeof lease.ownerId !== 'string'
        || !lease.ownerId
        || !Number.isInteger(lease.fencingToken)
        || lease.fencingToken < 1
        || !Number.isFinite(lease.expiresAt)) {
      corrupt('lease is invalid');
    }
    if (checkpoint.status !== 'running') corrupt('lease is only valid while running');
  }
  if (checkpoint.activeNode !== null) {
    const active = checkpoint.activeNode;
    if (!isPlainObject(active)
        || active.nodeId !== checkpoint.cursor
        || !['executing', 'compensating'].includes(active.phase)
        || !isoTime(active.startedAt)
        || !Number.isInteger(active.fencingToken)
        || active.fencingToken < 1) {
      corrupt('active node evidence is invalid');
    }
    if (!['running', 'reconciliation_required'].includes(checkpoint.status)) {
      corrupt('active node is inconsistent with status');
    }
  }
  if (['succeeded', 'failed', 'cancelled'].includes(checkpoint.status) && checkpoint.activeNode !== null) {
    corrupt('terminal state retains an active node');
  }
  if (checkpoint.pendingResume !== null) {
    const pending = checkpoint.pendingResume;
    if (!isPlainObject(pending)
        || typeof pending.nodeId !== 'string'
        || !nodes.has(pending.nodeId)
        || pending.nodeId !== checkpoint.cursor
        || !Object.hasOwn(pending, 'input')) {
      corrupt('pending resume input is invalid');
    }
  }
  if (checkpoint.status === 'reconciliation_required' && checkpoint.reconciliationRequired !== true) {
    corrupt('reconciliation marker is missing');
  }
  return checkpoint;
}

function createLocalCheckpointStore() {
  const records = new Map();
  let revision = 0;
  let tail = Promise.resolve();
  const operations = () => ({
    get(namespace, key) {
      const record = records.get(`${namespace}:${key}`);
      return record ? structuredClone(record) : null;
    },
    put(namespace, key, value, { ifRevision } = {}) {
      const storageKey = `${namespace}:${key}`;
      const existing = records.get(storageKey);
      if (ifRevision !== undefined && (existing?.revision ?? null) !== ifRevision) {
        throw workflowError('WORKFLOW_CHECKPOINT_CONFLICT', '[workflow] checkpoint revision conflict', { unknownOutcome: true });
      }
      revision += 1;
      const record = { key, revision, value: jsonClone(value) };
      records.set(storageKey, record);
      return structuredClone(record);
    },
  });
  return {
    capabilities: { transactions: true, multiProcess: false },
    async get(namespace, key) { return operations().get(namespace, key); },
    async put(namespace, key, value, options) { return operations().put(namespace, key, value, options); },
    async transaction(callback) {
      const run = tail.then(() => callback(operations()), () => callback(operations()));
      tail = run.catch(() => {});
      return run;
    },
  };
}

function rawCheckpoint(record) {
  return record && isPlainObject(record) && Object.hasOwn(record, 'value') ? record.value : record;
}

async function withLegacyLock(store, key, operation) {
  let locks = legacyStoreLocks.get(store);
  if (!locks) {
    locks = new Map();
    legacyStoreLocks.set(store, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function withTimeout(operation, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutError = workflowError(
    'WORKFLOW_NODE_TIMEOUT',
    `[workflow] node timeout after ${timeoutMs}ms`,
    { unknownOutcome: true },
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  // This timer may be the only active handle while a node is pending. Keep it
  // referenced so Node 22 cannot exit before the timeout enforces the boundary.
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const promise = Promise.resolve().then(() => operation(combined));
  try {
    return await awaitWithSignal(promise, combined);
  } finally {
    clearTimeout(timer);
  }
}

export function createWorkflowEngine({
  workflow,
  handlers,
  checkpointStore: suppliedCheckpointStore,
  executor,
  now = Date.now,
  instanceId = randomUUID(),
  leaseMs = 30_000,
  leaseHeartbeatMs = Math.max(1, Math.floor(leaseMs / 3)),
} = {}) {
  validateWorkflow(workflow);
  if (!handlers || typeof handlers !== 'object') throw new Error('[workflow] handlers are required');
  if (!Number.isInteger(leaseMs) || leaseMs < 2) throw new Error('[workflow] leaseMs must be an integer >= 2');
  if (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 1 || leaseHeartbeatMs >= leaseMs) {
    throw new Error('[workflow] leaseHeartbeatMs must be an integer between 1 and leaseMs - 1');
  }
  if (typeof instanceId !== 'string' || !instanceId) throw new Error('[workflow] instanceId is required');

  const checkpointStore = suppliedCheckpointStore ?? createLocalCheckpointStore();
  const transactional = typeof checkpointStore.transaction === 'function';
  if (!transactional && checkpointStore.capabilities?.multiProcess === true) {
    throw new Error('[workflow] multi-process checkpoint stores require transaction()');
  }
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const workflowDigest = digestWorkflow(workflow);

  function newCheckpoint(runId, initialState) {
    const time = new Date(now()).toISOString();
    const clonedState = jsonClone(initialState ?? {}, 'initial state');
    if (Object.hasOwn(clonedState, 'outputs')) {
      throw workflowError('WORKFLOW_STATE_INVALID', '[workflow] initial state.outputs is reserved for committed node output');
    }
    clonedState.outputs = {};
    return {
      schemaVersion: '1.0',
      runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      workflowDigest,
      status: 'queued',
      cursor: workflow.initial,
      state: clonedState,
      nodeOutputs: {},
      completed: [],
      waitingAt: null,
      activeNode: null,
      pendingResume: null,
      reconciliationRequired: false,
      lease: null,
      startedAt: time,
      updatedAt: time,
    };
  }

  function validateRunId(runId) {
    if (typeof runId !== 'string' || runId.length < 1 || runId.length > 256 || /[\u0000-\u001f\u007f]/.test(runId)) {
      throw workflowError('WORKFLOW_RUN_ID_INVALID', '[workflow] runId must be a non-empty printable string up to 256 characters');
    }
  }

  function applyResume(checkpoint, resumeInput) {
    if (checkpoint.status !== 'waiting_approval') {
      throw workflowError('WORKFLOW_NOT_WAITING', '[workflow] resumeInput is only accepted at an interrupt boundary', { statusCode: 409 });
    }
    const waitingNode = nodes.get(checkpoint.waitingAt);
    const input = jsonClone(resumeInput, 'resumeInput');
    checkpoint.state.resumeInput = input;
    checkpoint.completed.push(waitingNode.id);
    checkpoint.cursor = waitingNode.next;
    checkpoint.waitingAt = null;
    checkpoint.pendingResume = { nodeId: waitingNode.next, input };
    checkpoint.status = 'running';
  }

  function inProgressError() {
    return workflowError(
      'WORKFLOW_RUN_IN_PROGRESS',
      '[workflow] another instance owns this run',
      { statusCode: 409 },
    );
  }

  function markAbandonedActiveNode(checkpoint) {
    checkpoint.status = 'reconciliation_required';
    checkpoint.reconciliationRequired = true;
    checkpoint.error = {
      code: 'WORKFLOW_ABANDONED_NODE',
      nodeId: checkpoint.activeNode.nodeId,
      phase: checkpoint.activeNode.phase,
    };
    checkpoint.lease = null;
    checkpoint.updatedAt = new Date(now()).toISOString();
    return checkpoint;
  }

  async function acquireTransactional(runId, initialState, hasResume, resumeInput) {
    return checkpointStore.transaction(async (tx) => {
      const record = tx.get('run', runId);
      let checkpoint = record
        ? validateCheckpoint(rawCheckpoint(record), { runId, workflow, workflowDigest, nodes })
        : newCheckpoint(runId, initialState);

      if (hasResume && checkpoint.status !== 'waiting_approval') {
        throw workflowError('WORKFLOW_NOT_WAITING', '[workflow] resumeInput is only accepted at an interrupt boundary', { statusCode: 409 });
      }
      if (!hasResume && (TERMINAL_STATUSES.has(checkpoint.status) || checkpoint.status === 'waiting_approval')) {
        return { acquired: false, checkpoint };
      }
      if (hasResume) applyResume(checkpoint, resumeInput);
      if (TERMINAL_STATUSES.has(checkpoint.status)) return { acquired: false, checkpoint };

      if (checkpoint.lease?.expiresAt > now()) throw inProgressError();
      if (checkpoint.activeNode) return { acquired: false, recovery: true, checkpoint };
      const fencingToken = (checkpoint.lease?.fencingToken ?? 0) + 1;
      checkpoint.lease = { ownerId: instanceId, fencingToken, expiresAt: now() + leaseMs };
      checkpoint.status = 'running';
      checkpoint.updatedAt = new Date(now()).toISOString();
      tx.put('run', runId, checkpoint, record ? { ifRevision: record.revision } : { ifRevision: null });
      return { acquired: true, checkpoint };
    });
  }

  async function acquireLegacy(runId, initialState, hasResume, resumeInput) {
    const record = await checkpointStore.get?.('run', runId);
    let checkpoint = record
      ? validateCheckpoint(rawCheckpoint(record), { runId, workflow, workflowDigest, nodes })
      : newCheckpoint(runId, initialState);
    if (!hasResume && (TERMINAL_STATUSES.has(checkpoint.status) || checkpoint.status === 'waiting_approval')) {
      return { acquired: false, checkpoint };
    }
    if (hasResume && checkpoint.status !== 'waiting_approval') {
      throw workflowError('WORKFLOW_NOT_WAITING', '[workflow] resumeInput is only accepted at an interrupt boundary', { statusCode: 409 });
    }
    if (hasResume) applyResume(checkpoint, resumeInput);
    if (checkpoint.activeNode) {
      return { acquired: false, recovery: true, checkpoint };
    }
    checkpoint.status = 'running';
    checkpoint.updatedAt = new Date(now()).toISOString();
    await checkpointStore.put?.('run', runId, checkpoint);
    return { acquired: true, checkpoint };
  }

  async function saveOwned(checkpoint, { release = false } = {}) {
    checkpoint.updatedAt = new Date(now()).toISOString();
    if (!transactional) {
      checkpoint.lease = null;
      validateCheckpoint(checkpoint, { runId: checkpoint.runId, workflow, workflowDigest, nodes });
      await checkpointStore.put?.('run', checkpoint.runId, checkpoint);
      return;
    }
    await checkpointStore.transaction(async (tx) => {
      const record = tx.get('run', checkpoint.runId);
      const persisted = record
        ? validateCheckpoint(rawCheckpoint(record), { runId: checkpoint.runId, workflow, workflowDigest, nodes })
        : null;
      const expected = checkpoint.lease;
      if (!persisted?.lease
          || persisted.lease.ownerId !== instanceId
          || persisted.lease.fencingToken !== expected?.fencingToken) {
        throw workflowError(
          'WORKFLOW_LEASE_LOST',
          '[workflow] lease ownership was lost before checkpoint commit',
          { unknownOutcome: persisted?.activeNode !== null || checkpoint.activeNode !== null },
        );
      }
      checkpoint.lease = release
        ? null
        : { ...persisted.lease, expiresAt: now() + leaseMs };
      validateCheckpoint(checkpoint, { runId: checkpoint.runId, workflow, workflowDigest, nodes });
      tx.put('run', checkpoint.runId, checkpoint, { ifRevision: record.revision });
    });
  }

  async function renewLease(checkpoint) {
    if (!transactional) return true;
    return checkpointStore.transaction(async (tx) => {
      const record = tx.get('run', checkpoint.runId);
      const persisted = record
        ? validateCheckpoint(rawCheckpoint(record), { runId: checkpoint.runId, workflow, workflowDigest, nodes })
        : null;
      if (!persisted?.lease
          || persisted.lease.ownerId !== instanceId
          || persisted.lease.fencingToken !== checkpoint.lease?.fencingToken) return false;
      persisted.lease.expiresAt = now() + leaseMs;
      persisted.updatedAt = new Date(now()).toISOString();
      tx.put('run', checkpoint.runId, persisted, { ifRevision: record.revision });
      return true;
    });
  }

  function startHeartbeat(checkpoint) {
    const controller = new AbortController();
    let timer = null;
    let inFlight = null;
    let stopped = false;
    const fail = (error) => {
      if (!controller.signal.aborted) controller.abort(error);
    };
    async function beat() {
      try {
        if (!await renewLease(checkpoint)) {
          fail(workflowError('WORKFLOW_LEASE_LOST', '[workflow] lease ownership was lost', { unknownOutcome: true }));
          stopped = true;
        }
      } catch (error) {
        fail(workflowError('WORKFLOW_LEASE_UNCERTAIN', '[workflow] lease renewal could not be confirmed', { unknownOutcome: true, cause: error }));
        stopped = true;
      }
      if (!stopped) schedule();
    }
    function schedule() {
      timer = setTimeout(() => {
        inFlight = beat().finally(() => { inFlight = null; });
      }, leaseHeartbeatMs);
      timer.unref?.();
    }
    if (transactional) schedule();
    return {
      signal: controller.signal,
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await inFlight;
      },
    };
  }

  function invocationKey(checkpoint, node, phase) {
    return JSON.stringify(['workflow-node-v1', workflow.id, workflow.version, checkpoint.runId, node.id, phase]);
  }

  function normalizeEvidence(envelope) {
    if (!isPlainObject(envelope)
        || envelope.schemaVersion !== '1.0'
        || !Object.hasOwn(envelope, 'output')
        || !isPlainObject(envelope.state)) {
      throw workflowError(
        'WORKFLOW_EXECUTION_EVIDENCE_INVALID',
        '[workflow] executor returned invalid workflow state evidence',
        { unknownOutcome: true },
      );
    }
    return jsonClone(envelope, 'execution evidence');
  }

  async function invokeHandler({ handlerName, node, checkpoint, signal, resumeInput, phase, error }) {
    const handler = Object.hasOwn(handlers, handlerName) ? handlers[handlerName] : undefined;
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`[workflow] missing handler ${handlerName}`), { unknownOutcome: false });
    }
    const operation = async (executionSignal) => {
      const workingState = jsonClone(checkpoint.state, 'checkpoint.state');
      const output = await handler({
        state: workingState,
        runId: checkpoint.runId,
        node,
        signal: executionSignal,
        resumeInput: resumeInput === undefined ? undefined : jsonClone(resumeInput, 'resumeInput'),
        ...(error ? { error } : {}),
      });
      return {
        schemaVersion: '1.0',
        output: output === undefined ? null : jsonClone(output, 'handler output'),
        state: jsonClone(workingState, 'handler state'),
      };
    };
    let envelope;
    try {
      if (executor) {
        const result = await executor.execute({
          name: `workflow.${workflow.id}.${node.id}.${phase}`,
          operation: ({ signal: executionSignal }) => operation(executionSignal),
          signal,
          timeoutMs: node.timeoutMs ?? 60_000,
          idempotent: true,
          unknownOnUnclassifiedError: true,
          // Workflow handlers may mutate checkpoint state. Persist the complete
          // execution envelope only until the corresponding checkpoint CAS is
          // durable, then compact it to a non-replayable tombstone below.
          persistIdempotencyResult: true,
          idempotencyKey: invocationKey(checkpoint, node, phase),
          context: { runId: checkpoint.runId, nodeId: node.id, phase },
        });
        envelope = result.value;
      } else {
        envelope = await withTimeout(operation, node.timeoutMs ?? 60_000, signal);
      }
    } catch (rawError) {
      const executionError = asError(rawError);
      if (rawError?.unknownOutcome !== false) {
        executionError.unknownOutcome = true;
        executionError.reconciliationRequired = true;
      }
      throw executionError;
    }
    return normalizeEvidence(envelope);
  }

  async function compactExecutionEvidence(checkpoint, node, phase) {
    if (typeof executor?.idempotency?.compact !== 'function') return;
    try {
      await executor.idempotency.compact(invocationKey(checkpoint, node, phase));
    } catch (error) {
      throw workflowError(
        'WORKFLOW_EVIDENCE_COMPACTION_UNKNOWN',
        '[workflow] committed execution evidence could not be compacted',
        { cause: error },
      );
    }
  }

  function sameActiveNode(left, right) {
    return left?.nodeId === right?.nodeId
      && left?.phase === right?.phase
      && left?.startedAt === right?.startedAt
      && left?.fencingToken === right?.fencingToken;
  }

  async function markAbandonedForReconciliation(checkpoint) {
    if (!transactional) {
      const marked = markAbandonedActiveNode(checkpoint);
      await checkpointStore.put?.('run', checkpoint.runId, marked);
      return marked;
    }
    return checkpointStore.transaction(async (tx) => {
      const record = tx.get('run', checkpoint.runId);
      if (!record) {
        throw workflowError('WORKFLOW_CHECKPOINT_CORRUPT', '[workflow] checkpoint disappeared during recovery', { unknownOutcome: true });
      }
      let current = validateCheckpoint(rawCheckpoint(record), { runId: checkpoint.runId, workflow, workflowDigest, nodes });
      if (!sameActiveNode(current.activeNode, checkpoint.activeNode)) return current;
      if (current.lease?.expiresAt > now()) throw inProgressError();
      current = markAbandonedActiveNode(current);
      tx.put('run', current.runId, current, { ifRevision: record.revision });
      return current;
    });
  }

  async function reacquireAbandoned(checkpoint) {
    if (!transactional) return { changed: false, checkpoint };
    return checkpointStore.transaction(async (tx) => {
      const record = tx.get('run', checkpoint.runId);
      if (!record) {
        throw workflowError('WORKFLOW_CHECKPOINT_CORRUPT', '[workflow] checkpoint disappeared during recovery', { unknownOutcome: true });
      }
      const current = validateCheckpoint(rawCheckpoint(record), { runId: checkpoint.runId, workflow, workflowDigest, nodes });
      if (!sameActiveNode(current.activeNode, checkpoint.activeNode)) return { changed: true, checkpoint: current };
      if (current.lease?.expiresAt > now()) throw inProgressError();
      const fencingToken = Math.max(
        current.lease?.fencingToken ?? 0,
        current.activeNode.fencingToken,
      ) + 1;
      current.lease = { ownerId: instanceId, fencingToken, expiresAt: now() + leaseMs };
      current.activeNode.fencingToken = fencingToken;
      current.updatedAt = new Date(now()).toISOString();
      tx.put('run', current.runId, current, { ifRevision: record.revision });
      return { changed: false, checkpoint: current };
    });
  }

  async function committedExecutionEvidence(checkpoint, node) {
    if (checkpoint.activeNode?.phase !== 'executing' || typeof executor?.idempotency?.get !== 'function') return null;
    let record;
    try {
      record = await executor.idempotency.get(invocationKey(checkpoint, node, 'execute'));
    } catch {
      return null;
    }
    if (record?.status !== 'committed') return null;
    if (!Object.hasOwn(record, 'value')) return null;
    if (!/^[0-9a-f]{64}$/.test(String(record.resultDigest ?? ''))) return null;
    const actualDigest = createHash('sha256').update(JSON.stringify(record.value)).digest('hex');
    if (actualDigest !== record.resultDigest) return null;
    const candidate = record.value?.value?.schemaVersion === '1.0'
      ? record.value.value
      : record.value;
    try {
      return normalizeEvidence(candidate);
    } catch {
      return null;
    }
  }

  async function recoverAbandoned(checkpoint) {
    const node = nodes.get(checkpoint.activeNode?.nodeId);
    const evidence = node ? await committedExecutionEvidence(checkpoint, node) : null;
    if (!evidence) {
      return { acquired: false, checkpoint: await markAbandonedForReconciliation(checkpoint) };
    }
    const ownership = await reacquireAbandoned(checkpoint);
    if (ownership.changed) return { acquired: false, checkpoint: ownership.checkpoint };
    const recovered = ownership.checkpoint;
    recovered.state = evidence.state;
    recovered.nodeOutputs[node.id] = evidence.output;
    recovered.state.outputs = jsonClone(recovered.nodeOutputs, 'node outputs');
    if (!recovered.completed.includes(node.id)) recovered.completed.push(node.id);
    if (recovered.pendingResume?.nodeId === node.id) recovered.pendingResume = null;
    recovered.cursor = node.type === 'branch' ? branchTarget(node, evidence.output) : node.next;
    recovered.activeNode = null;
    recovered.status = 'running';
    await saveOwned(recovered);
    try {
      await compactExecutionEvidence(recovered, node, 'execute');
    } catch (error) {
      error.reconciliationRequired = true;
      await persistReconciliation(recovered, node, error);
      throw error;
    }
    return { acquired: true, checkpoint: recovered };
  }

  async function persistReconciliation(checkpoint, node, error) {
    checkpoint.status = 'reconciliation_required';
    checkpoint.reconciliationRequired = true;
    checkpoint.error = {
      code: error?.code || error?.name || 'WORKFLOW_NODE_OUTCOME_UNKNOWN',
      nodeId: node.id,
      phase: checkpoint.activeNode?.phase ?? 'executing',
    };
    try {
      await saveOwned(checkpoint, { release: true });
    } catch (saveError) {
      throw workflowError(
        'WORKFLOW_RECONCILIATION_PERSIST_UNKNOWN',
        '[workflow] unknown node outcome and reconciliation checkpoint could not be committed',
        { unknownOutcome: true, cause: saveError },
      );
    }
  }

  async function executeOwned(checkpoint, signal) {
    while (checkpoint.cursor) {
      if (signal?.aborted) {
        checkpoint.status = 'cancelled';
        checkpoint.activeNode = null;
        await saveOwned(checkpoint, { release: true });
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const node = nodes.get(checkpoint.cursor);
      if (!node) throw workflowError('WORKFLOW_CHECKPOINT_CORRUPT', `[workflow] missing node ${checkpoint.cursor}`, { unknownOutcome: true });
      if (node.type === 'end') {
        checkpoint.completed.push(node.id);
        checkpoint.cursor = null;
        checkpoint.status = 'succeeded';
        checkpoint.activeNode = null;
        checkpoint.pendingResume = null;
        await saveOwned(checkpoint, { release: true });
        return checkpoint;
      }
      if (node.type === 'interrupt') {
        checkpoint.status = 'waiting_approval';
        checkpoint.waitingAt = node.id;
        checkpoint.activeNode = null;
        checkpoint.pendingResume = null;
        await saveOwned(checkpoint, { release: true });
        return checkpoint;
      }

      checkpoint.activeNode = {
        nodeId: node.id,
        phase: 'executing',
        fencingToken: checkpoint.lease?.fencingToken ?? 1,
        startedAt: new Date(now()).toISOString(),
      };
      await saveOwned(checkpoint);
      const beforeExecutionCommit = jsonClone(checkpoint, 'checkpoint');
      const heartbeat = startHeartbeat(checkpoint);
      const executionSignal = signal ? AbortSignal.any([signal, heartbeat.signal]) : heartbeat.signal;
      const nodeResumeInput = checkpoint.pendingResume?.nodeId === node.id
        ? checkpoint.pendingResume.input
        : undefined;
      let nodeCheckpointCommitted = false;
      try {
        const evidence = await invokeHandler({
          handlerName: node.handler,
          node,
          checkpoint,
          signal: executionSignal,
          resumeInput: nodeResumeInput,
          phase: 'execute',
        });
        await heartbeat.stop();
        checkpoint.state = evidence.state;
        checkpoint.nodeOutputs[node.id] = evidence.output;
        checkpoint.state.outputs = jsonClone(checkpoint.nodeOutputs, 'node outputs');
        checkpoint.completed.push(node.id);
        if (checkpoint.pendingResume?.nodeId === node.id) checkpoint.pendingResume = null;
        if (node.type === 'branch') {
          checkpoint.cursor = branchTarget(node, evidence.output);
        } else {
          checkpoint.cursor = node.next;
        }
        checkpoint.activeNode = null;
        try {
          await saveOwned(checkpoint);
          nodeCheckpointCommitted = true;
          await compactExecutionEvidence(checkpoint, node, 'execute');
        } catch (rawCommitError) {
          if (!nodeCheckpointCommitted) checkpoint = beforeExecutionCommit;
          const commitError = asError(rawCommitError, 'WORKFLOW_CHECKPOINT_COMMIT_UNKNOWN');
          if (!nodeCheckpointCommitted) commitError.unknownOutcome = true;
          commitError.reconciliationRequired = true;
          throw commitError;
        }
      } catch (rawError) {
        await heartbeat.stop();
        const error = asError(rawError);
        if (nodeCheckpointCommitted) {
          await persistReconciliation(checkpoint, node, error);
          throw error;
        }
        const unknown = error?.unknownOutcome === true || executionSignal.aborted;
        if (unknown) {
          error.unknownOutcome = true;
          error.reconciliationRequired = true;
          await persistReconciliation(checkpoint, node, error);
          throw error;
        }

        if (node.compensation) {
          checkpoint.activeNode.phase = 'compensating';
          checkpoint.activeNode.startedAt = new Date(now()).toISOString();
          await saveOwned(checkpoint);
          let persistedCompensationCheckpoint = jsonClone(checkpoint, 'checkpoint');
          const compensationHeartbeat = startHeartbeat(checkpoint);
          const compensationSignal = signal
            ? AbortSignal.any([signal, compensationHeartbeat.signal])
            : compensationHeartbeat.signal;
          try {
            const evidence = await invokeHandler({
              handlerName: node.compensation,
              node,
              checkpoint,
              signal: compensationSignal,
              resumeInput: undefined,
              phase: 'compensate',
              error,
            });
            await compensationHeartbeat.stop();
            checkpoint.state = evidence.state;
            checkpoint.state.outputs = jsonClone(checkpoint.nodeOutputs, 'node outputs');
            checkpoint.state.compensated ??= [];
            checkpoint.state.compensated.push(node.id);
            // Persist the compensation state while retaining ownership before
            // deleting its full idempotency evidence.
            await saveOwned(checkpoint);
            // Keep the exact checkpoint image that is now durable. A later
            // failure while releasing the lease must reconcile from this
            // image, not from the pre-compensation marker, or the persisted
            // undo receipt can be overwritten and the compensation repeated.
            persistedCompensationCheckpoint = jsonClone(checkpoint, 'checkpoint');
            await compactExecutionEvidence(checkpoint, node, 'compensate');
          } catch (rawCompensationError) {
            await compensationHeartbeat.stop();
            const compensationError = asError(rawCompensationError, 'WORKFLOW_COMPENSATION_FAILED');
            compensationError.unknownOutcome = true;
            compensationError.reconciliationRequired = true;
            await persistReconciliation(checkpoint, node, compensationError);
            throw compensationError;
          }
          checkpoint.activeNode = null;
          checkpoint.status = 'failed';
          checkpoint.error = { code: error.code || error.name || 'WORKFLOW_NODE_FAILED', nodeId: node.id };
          try {
            await saveOwned(checkpoint, { release: true });
          } catch (rawCommitError) {
            checkpoint = persistedCompensationCheckpoint;
            const commitError = asError(rawCommitError, 'WORKFLOW_COMPENSATION_COMMIT_UNKNOWN');
            commitError.unknownOutcome = true;
            commitError.reconciliationRequired = true;
            await persistReconciliation(checkpoint, node, commitError);
            throw commitError;
          }
          throw error;
        }
        const beforeFailureCommit = jsonClone(checkpoint, 'checkpoint');
        checkpoint.activeNode = null;
        checkpoint.status = 'failed';
        checkpoint.error = { code: error.code || error.name || 'WORKFLOW_NODE_FAILED', nodeId: node.id };
        try {
          await saveOwned(checkpoint, { release: true });
        } catch (rawCommitError) {
          checkpoint = beforeFailureCommit;
          const commitError = asError(rawCommitError, 'WORKFLOW_FAILURE_COMMIT_UNKNOWN');
          commitError.unknownOutcome = true;
          commitError.reconciliationRequired = true;
          await persistReconciliation(checkpoint, node, commitError);
          throw commitError;
        }
        throw error;
      }
    }
    throw workflowError('WORKFLOW_CHECKPOINT_CORRUPT', '[workflow] execution ended without an end node', { unknownOutcome: true });
  }

  async function runInternal({ runId, state, signal, hasResume, resumeInput }) {
    let ownership = transactional
      ? await acquireTransactional(runId, state, hasResume, resumeInput)
      : await acquireLegacy(runId, state, hasResume, resumeInput);
    if (ownership.recovery) ownership = await recoverAbandoned(ownership.checkpoint);
    if (!ownership.acquired) return ownership.checkpoint;
    return executeOwned(ownership.checkpoint, signal);
  }

  async function run(options = {}) {
    const runId = options.runId ?? randomUUID();
    validateRunId(runId);
    const hasResume = Object.hasOwn(options, 'resumeInput') && options.resumeInput !== undefined;
    const input = {
      runId,
      state: options.state ?? {},
      signal: options.signal,
      hasResume,
      resumeInput: options.resumeInput,
    };
    if (transactional) return runInternal(input);
    return withLegacyLock(checkpointStore, runId, () => runInternal(input));
  }

  return { run };
}
