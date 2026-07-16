import { randomUUID } from 'node:crypto';
import { assertScheduler, matchesSchedule, normalizeSchedule } from './contract.js';

const EXECUTION_PREFIX = 'execution:';
const EXECUTION_LEDGER_META_KEY = '__scheduler_execution_ledger__';
const MAX_JOB_TIMEOUT_MS = 300_000;
const TERMINAL_STATUSES = new Set([
  'succeeded',
  'dead_lettered',
  'failed', // fail closed for records written by older scaffold versions
  'reconciliation_required',
  'reconciled_succeeded',
  'reconciled_failed',
]);

function assertPositiveInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`[scheduler] ${label} must be an integer between 1 and ${max}`);
  }
}

function resultType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeErrorCode(error) {
  try {
    const candidate = error?.code || error?.name;
    return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(candidate)
      ? candidate
      : 'ERROR';
  } catch {
    return 'ERROR';
  }
}

function retainedResult(value, maxBytes) {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function redactExecution(record, includeResult) {
  const value = structuredClone(record);
  if (!includeResult) {
    delete value.value.result;
    delete value.value.resultExpiresAt;
  }
  return value;
}

function minuteFloor(timestamp) {
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  return date.getTime();
}

function dueMinutes(previousMs, currentMs, maxCatchupMinutes) {
  const current = minuteFloor(currentMs);
  if (!Number.isFinite(previousMs)) return [current];
  const start = Math.max(minuteFloor(previousMs) + 60_000, current - maxCatchupMinutes * 60_000);
  const values = [];
  for (let time = start; time <= current; time += 60_000) values.push(time);
  return values;
}

export function createDurableScheduler({
  stateStore,
  instanceId = randomUUID(),
  now = Date.now,
  leaseMs = 60_000,
  leaseHeartbeatMs = Math.max(1, Math.floor(leaseMs / 3)),
  maxCatchupMinutes = 1_440,
  maxExecutionRecords = 10_000,
  resultRetentionMs = 0,
  maxRetainedResultBytes = 64 * 1_024,
  defaultJobTimeoutMs = 60_000,
  costTracker,
  monthlyBudgetUsd,
  audit,
  logger = console,
} = {}) {
  if (!stateStore?.capabilities?.transactions) throw new Error('[scheduler] durable adapter requires a transactional stateStore');
  if (!Number.isInteger(leaseMs) || leaseMs < 2) throw new Error('[scheduler] leaseMs must be an integer >= 2');
  if (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 1 || leaseHeartbeatMs >= leaseMs) {
    throw new Error('[scheduler] leaseHeartbeatMs must be an integer between 1 and leaseMs - 1');
  }
  assertPositiveInteger(maxExecutionRecords, 'maxExecutionRecords', { max: 1_000_000 });
  if (!Number.isInteger(resultRetentionMs) || resultRetentionMs < 0 || resultRetentionMs > 86_400_000) {
    throw new Error('[scheduler] resultRetentionMs must be an integer between 0 and 86400000');
  }
  assertPositiveInteger(maxRetainedResultBytes, 'maxRetainedResultBytes', { max: 1_048_576 });
  assertPositiveInteger(defaultJobTimeoutMs, 'defaultJobTimeoutMs', { max: MAX_JOB_TIMEOUT_MS });
  const definitions = new Map();
  const view = new Map();
  let timer = null;
  let starter = null;
  let stopping = false;
  let stopPromise = null;
  let tickTail = Promise.resolve();
  let ledgerCountVerified = false;
  const activeOperations = new Set();

  function track(operation) {
    const promise = Promise.resolve(operation);
    activeOperations.add(promise);
    promise.then(
      () => activeOperations.delete(promise),
      () => activeOperations.delete(promise),
    );
    return promise;
  }

  function stoppedResult() {
    return { ok: false, skipped: 'scheduler-stopped' };
  }

  function registerJob({
    name,
    schedule,
    run,
    missedRunPolicy = 'coalesce',
    maxAttempts = 1,
    idempotency = 'none',
    timeoutMs = defaultJobTimeoutMs,
  }) {
    if (!name || typeof run !== 'function') throw new Error('[scheduler] job needs a name and run()');
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || name.includes(':') || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('[scheduler] job name must be non-empty, at most 128 characters, and contain no colon or control character');
    }
    if (!['skip', 'coalesce', 'catch-up'].includes(missedRunPolicy)) throw new Error('[scheduler] invalid missedRunPolicy');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('[scheduler] maxAttempts must be >= 1');
    if (!['none', 'required'].includes(idempotency)) throw new Error('[scheduler] idempotency must be none or required');
    assertPositiveInteger(timeoutMs, `timeoutMs for "${name}"`, { max: MAX_JOB_TIMEOUT_MS });
    if (maxAttempts > 1 && idempotency !== 'required') {
      throw new Error('[scheduler] retries require idempotency=required and consumption of the provided idempotencyKey');
    }
    const definition = { name, schedule: normalizeSchedule(schedule), run, missedRunPolicy, maxAttempts, idempotency, timeoutMs };
    definitions.set(name, definition);
    view.set(name, {
      name,
      schedule: definition.schedule,
      missedRunPolicy,
      timeoutMs,
      runs: 0,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
    });
  }

  function forEachExecution(tx, callback, { limit = Number.MAX_SAFE_INTEGER } = {}) {
    let cursor = null;
    let visited = 0;
    do {
      const page = tx.list('job', { prefix: EXECUTION_PREFIX, cursor, limit: 1_000 });
      for (const item of page.items) {
        callback(item);
        visited += 1;
        if (visited >= limit) return visited;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return visited;
  }

  function compactExpiredResults(tx, time, { limit = Number.MAX_SAFE_INTEGER } = {}) {
    let compacted = 0;
    forEachExecution(tx, (item) => {
      if (compacted >= limit) return;
      if (item.value.resultExpiresAt > time && Object.hasOwn(item.value, 'result')) return;
      if (!Object.hasOwn(item.value, 'result') && !Object.hasOwn(item.value, 'resultExpiresAt')) return;
      const value = { ...item.value };
      delete value.result;
      delete value.resultExpiresAt;
      tx.put('job', item.key, value, { ifRevision: item.revision });
      compacted += 1;
    });
    return compacted;
  }

  function countExecutionRecords(tx) {
    let count = 0;
    forEachExecution(tx, () => { count += 1; });
    return count;
  }

  function executionLedgerMeta(tx, { verify = false } = {}) {
    const existing = tx.get('job', EXECUTION_LEDGER_META_KEY);
    if (existing && (!Number.isInteger(existing.value?.count) || existing.value.count < 0)) {
      throw Object.assign(new Error('[scheduler] execution ledger metadata is corrupt'), {
        code: 'SCHEDULER_EXECUTION_LEDGER_CORRUPT',
        retryable: false,
      });
    }
    if (existing && !verify) return { entry: existing, count: existing.value.count };
    const count = countExecutionRecords(tx);
    const value = { count, updatedAt: new Date(now()).toISOString() };
    const entry = tx.put('job', EXECUTION_LEDGER_META_KEY, value, existing ? { ifRevision: existing.revision } : { ifRevision: null });
    return { entry, count };
  }

  function updateExecutionLedgerCount(tx, ledger, count) {
    if (!Number.isInteger(count) || count < 0) {
      throw Object.assign(new Error('[scheduler] execution ledger count would become invalid'), {
        code: 'SCHEDULER_EXECUTION_LEDGER_CORRUPT',
        retryable: false,
      });
    }
    return tx.put('job', EXECUTION_LEDGER_META_KEY, {
      count,
      updatedAt: new Date(now()).toISOString(),
    }, { ifRevision: ledger.entry.revision });
  }

  function terminalReason(status) {
    if (status === 'succeeded') return 'deduplicated';
    if (status === 'reconciliation_required') return 'reconciliation_required';
    if (status === 'reconciled_succeeded' || status === 'reconciled_failed') return 'reconciled';
    return 'dead_lettered';
  }

  async function claim(definition, scheduledAt, trigger, runId) {
    const key = `execution:${definition.name}:${runId}`;
    let ledgerChecked = false;
    const outcome = await stateStore.transaction(async (tx) => {
      const time = now();
      const existingEntry = tx.get('job', key);
      const existing = existingEntry?.value;
      if (existing && TERMINAL_STATUSES.has(existing.status)) {
        return { owned: false, reason: terminalReason(existing.status), record: existing };
      }
      if (existing?.status === 'running') {
        if (Number.isFinite(existing.leaseExpiresAt) && existing.leaseExpiresAt > time) {
          return { owned: false, reason: 'leased', record: existing };
        }
        // An expired lease proves only that the prior worker stopped renewing;
        // it does not prove that its external effect was rejected. Fencing can
        // protect this ledger, but cannot undo a webhook or database write.
        // Preserve a reconciliation tombstone instead of replaying the job.
        const record = {
          ...existing,
          status: 'reconciliation_required',
          leaseExpiresAt: 0,
          completedAt: new Date(time).toISOString(),
          error: { code: 'SCHEDULER_LEASE_EXPIRED' },
          unknownOutcome: true,
          reconciliationRequired: true,
        };
        tx.put('job', key, record, { ifRevision: existingEntry.revision });
        return { owned: false, reason: 'reconciliation_required', record };
      }
      if (existing && existing.status !== 'retry_wait') {
        const record = {
          ...existing,
          status: 'reconciliation_required',
          leaseExpiresAt: 0,
          completedAt: new Date(time).toISOString(),
          error: { code: 'SCHEDULER_STATE_UNCERTAIN' },
          unknownOutcome: true,
          reconciliationRequired: true,
        };
        tx.put('job', key, record, { ifRevision: existingEntry.revision });
        return { owned: false, reason: 'reconciliation_required', record };
      }
      let ledger;
      if (!existing) {
        ledger = executionLedgerMeta(tx, { verify: !ledgerCountVerified });
        ledgerChecked = true;
        if (ledger.count >= maxExecutionRecords) {
          return { owned: false, reason: 'execution-ledger-capacity', record: null };
        }
      }
      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      const record = {
        name: definition.name,
        scheduledAt,
        trigger,
        runId,
        status: 'running',
        owner: instanceId,
        fencingToken,
        leaseExpiresAt: time + leaseMs,
        attempts: existing?.attempts ?? 0,
      };
      tx.put('job', key, record, existingEntry ? { ifRevision: existingEntry.revision } : { ifRevision: null });
      if (!existing) updateExecutionLedgerCount(tx, ledger, ledger.count + 1);
      return { owned: true, key, fencingToken, record };
    });
    if (ledgerChecked) ledgerCountVerified = true;
    return outcome;
  }

  async function renewLease(key, fencingToken) {
    return stateStore.transaction(async (tx) => {
      const existing = tx.get('job', key);
      if (!existing
          || existing.value.status !== 'running'
          || existing.value.fencingToken !== fencingToken
          || existing.value.owner !== instanceId) return false;
      tx.put('job', key, {
        ...existing.value,
        leaseExpiresAt: now() + leaseMs,
      }, { ifRevision: existing.revision });
      return true;
    });
  }

  async function finalize(key, fencingToken, patch) {
    return stateStore.transaction(async (tx) => {
      const existing = tx.get('job', key);
      if (!existing
          || existing.value.status !== 'running'
          || existing.value.fencingToken !== fencingToken
          || existing.value.owner !== instanceId) return false;
      tx.put('job', key, { ...existing.value, ...patch, leaseExpiresAt: 0 }, { ifRevision: existing.revision });
      return true;
    });
  }

  async function releasePreEffectClaim(key, fencingToken) {
    let ledgerChecked = false;
    const released = await stateStore.transaction(async (tx) => {
      const existing = tx.get('job', key);
      if (!existing
          || existing.value.status !== 'running'
          || existing.value.fencingToken !== fencingToken
          || existing.value.owner !== instanceId) return false;
      const ledger = executionLedgerMeta(tx, { verify: !ledgerCountVerified });
      ledgerChecked = true;
      tx.delete('job', key, { ifRevision: existing.revision });
      updateExecutionLedgerCount(tx, ledger, ledger.count - 1);
      return true;
    });
    if (ledgerChecked) ledgerCountVerified = true;
    return released;
  }

  function leaseError(code, message) {
    return Object.assign(new Error(message), {
      code,
      retryable: false,
      unknownOutcome: true,
    });
  }

  function startLeaseHeartbeat(ownership) {
    const controller = new AbortController();
    let timerId = null;
    let renewalInFlight = null;
    let closed = false;

    function abort(error) {
      if (!controller.signal.aborted) controller.abort(error);
    }

    async function renew() {
      try {
        const renewed = await renewLease(ownership.key, ownership.fencingToken);
        if (!renewed) {
          abort(leaseError('SCHEDULER_FENCED_OUT', 'scheduler lease ownership was lost'));
          closed = true;
          clearInterval(timerId);
        }
      } catch (error) {
        logger.warn?.(`[scheduler] lease heartbeat failed code=${error.code ?? error.name ?? 'ERROR'}`);
        abort(leaseError('SCHEDULER_LEASE_UNCERTAIN', 'scheduler lease renewal could not be confirmed'));
        closed = true;
        clearInterval(timerId);
      }
    }

    timerId = setInterval(() => {
      if (closed || renewalInFlight) return;
      renewalInFlight = renew().finally(() => { renewalInFlight = null; });
    }, leaseHeartbeatMs);
    timerId.unref?.();

    return {
      signal: controller.signal,
      async stop() {
        closed = true;
        clearInterval(timerId);
        await renewalInFlight;
      },
    };
  }

  function jobTimeoutError(timeoutMs) {
    return Object.assign(new Error(`[scheduler] job timed out after ${timeoutMs}ms`), {
      code: 'SCHEDULER_JOB_TIMEOUT',
      retryable: false,
      unknownOutcome: true,
      reconciliationRequired: true,
    });
  }

  async function executeBounded(definition, context, leaseSignal) {
    const timeoutController = new AbortController();
    const timeoutError = jobTimeoutError(definition.timeoutMs);
    const timeoutId = setTimeout(() => timeoutController.abort(timeoutError), definition.timeoutMs);
    timeoutId.unref?.();
    const signal = AbortSignal.any([leaseSignal, timeoutController.signal]);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(signal.reason instanceof Error
        ? signal.reason
        : leaseError('SCHEDULER_EXECUTION_ABORTED', 'scheduler job execution was aborted'));
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    });
    // Promise.race is deliberate: AbortSignal propagation is advisory and a
    // handler may ignore it. The durable reconciliation tombstone prevents a
    // replay even if such a detached handler settles after the caller returns.
    const operation = Promise.resolve().then(() => definition.run({ ...context, signal }));
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abortListener);
    }
  }

  function fencedOutcome(meta, scheduledAt) {
    meta.runs += 1;
    meta.lastRunAt = scheduledAt;
    meta.lastResult = null;
    meta.lastError = 'fenced_out';
    return {
      ok: false,
      skipped: 'fenced_out',
      unknownOutcome: true,
      error: 'scheduler lease ownership was lost before finalization',
    };
  }

  function finalizationUnknown(meta, scheduledAt, error) {
    meta.runs += 1;
    meta.lastRunAt = scheduledAt;
    meta.lastResult = null;
    meta.lastError = 'finalization_unknown';
    logger.error?.(`[scheduler] finalization unknown code=${error.code ?? error.name ?? 'ERROR'}`);
    return {
      ok: false,
      skipped: 'finalization_unknown',
      unknownOutcome: true,
      error: 'scheduler finalization could not be confirmed',
    };
  }

  function retainedResultPatch(result, completedAtMs) {
    const patch = {
      resultSummary: { type: resultType(result) },
    };
    if (resultRetentionMs > 0) {
      const retained = retainedResult(result, maxRetainedResultBytes);
      if (retained !== null) {
        patch.result = retained;
        patch.resultExpiresAt = completedAtMs + resultRetentionMs;
      }
    }
    return patch;
  }

  async function budgetExceeded(definition, trigger) {
    if (!costTracker || monthlyBudgetUsd === undefined) return false;
    if (!await costTracker.isOverBudget(monthlyBudgetUsd)) return false;
    logger.warn?.(`[scheduler] skip "${definition.name}" (${trigger}): monthly budget $${monthlyBudgetUsd} exhausted`);
    return true;
  }

  async function startAudit(definition, trigger, runId) {
    const event = {
      action: 'job.execute',
      resource: definition.name,
      idempotencyKey: `scheduler:${definition.name}:${runId}`,
      metadata: { trigger },
    };
    if (typeof audit?.start === 'function') return audit.start(event);
    if (typeof audit?.append === 'function') {
      return audit.append({ ...event, outcome: 'started', metadata: { ...event.metadata, auditPhase: 'pre-effect' } });
    }
    return null;
  }

  async function completeAudit(definition, trigger, runId, auditStart, outcome, errorCode) {
    try {
      await audit?.append?.({
        action: 'job.execute',
        resource: definition.name,
        outcome,
        idempotencyKey: `scheduler:${definition.name}:${runId}`,
        metadata: { trigger, auditStartId: auditStart?.id, ...(errorCode ? { errorCode } : {}) },
      });
    } catch (error) {
      logger.error?.(`[audit] scheduler completion append failed code=${error.code ?? error.name ?? 'ERROR'}`);
    }
  }

  async function runClaimed(definition, scheduledAt, trigger, runId) {
    if (stopping) return stoppedResult();
    if (await budgetExceeded(definition, trigger)) return { ok: false, skipped: 'monthly-budget-exhausted' };
    const ownership = await claim(definition, scheduledAt, trigger, runId);
    if (!ownership.owned) {
      const reconciliationRequired = ownership.reason === 'reconciliation_required'
        || ownership.reason === 'execution-ledger-capacity';
      return {
        ok: ownership.reason === 'deduplicated',
        skipped: ownership.reason,
        ...(reconciliationRequired ? { reconciliationRequired: true } : {}),
        ...(ownership.reason === 'reconciliation_required' ? { unknownOutcome: true, runId } : {}),
      };
    }
    // Claim first so only the lease owner can consume an audit slot. The
    // append itself is the atomic audit-capacity reservation; if it fails,
    // release the still-pre-effect scheduler claim before propagating the
    // error. This prevents both duplicate `started` records under contention
    // and durable `running` records for handlers that never began.
    let auditStart;
    try {
      auditStart = await startAudit(definition, trigger, runId);
    } catch (rawError) {
      let released = false;
      try { released = await releasePreEffectClaim(ownership.key, ownership.fencingToken); }
      catch (releaseError) {
        throw Object.assign(new Error('[scheduler] audit guard failed and pre-effect claim cleanup could not be confirmed'), {
          code: 'SCHEDULER_AUDIT_GUARD_CLEANUP_FAILED',
          statusCode: 503,
          retryable: false,
          unknownOutcome: false,
          preEffect: true,
          reconciliationRequired: true,
          cause: releaseError,
        });
      }
      if (!released) {
        throw Object.assign(new Error('[scheduler] audit guard failed after scheduler ownership was lost'), {
          code: 'SCHEDULER_AUDIT_GUARD_FENCED',
          statusCode: 503,
          retryable: false,
          unknownOutcome: false,
          preEffect: true,
          reconciliationRequired: true,
        });
      }
      const error = rawError instanceof Error ? rawError : new Error('[scheduler] audit guard failed');
      error.unknownOutcome = false;
      error.preEffect = true;
      error.effectStarted = false;
      throw error;
    }
    const meta = view.get(definition.name);
    let lastError;
    let attemptsMade = ownership.record.attempts;
    for (let attempt = ownership.record.attempts + 1; attempt <= definition.maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      const heartbeat = startLeaseHeartbeat(ownership);
      let result;
      let runError;
      try {
        result = await executeBounded(definition, {
          scheduledAt,
          trigger,
          fencingToken: ownership.fencingToken,
          idempotencyKey: `scheduler:${definition.name}:${runId}`,
          attempt,
        }, heartbeat.signal);
      } catch (rawError) {
        runError = rawError instanceof Error ? rawError : new Error('job failed with a non-Error value');
        // Once a job handler has started, a generic exception is not proof of
        // rejection. Only a handler that can prove a pre-effect failure may
        // opt into retry/dead-letter with unknownOutcome:false.
        if (rawError?.unknownOutcome !== false) {
          runError.unknownOutcome = true;
          runError.reconciliationRequired = true;
          runError.retryable = false;
        }
      } finally {
        await heartbeat.stop();
      }

      if (!runError) {
        let finalized;
        try {
          const completedAtMs = now();
          finalized = await finalize(ownership.key, ownership.fencingToken, {
            status: 'succeeded',
            attempts: attempt,
            ...retainedResultPatch(result, completedAtMs),
            completedAt: new Date(completedAtMs).toISOString(),
            error: null,
          });
        } catch (error) {
          return finalizationUnknown(meta, scheduledAt, error);
        }
        if (!finalized) return fencedOutcome(meta, scheduledAt);
        meta.runs += 1;
        meta.lastRunAt = scheduledAt;
        // Status/list APIs expose this view. Keep it evidence-only so a job
        // result cannot accidentally become an operations-data disclosure.
        meta.lastResult = { type: resultType(result) };
        meta.lastError = null;
        await completeAudit(definition, trigger, runId, auditStart, 'ok');
        return { ok: true, result };
      }

      lastError = runError;
      const canRetry = attempt < definition.maxAttempts
        && definition.idempotency === 'required'
        && runError?.unknownOutcome !== true
        && runError?.retryable === true;
      let finalized;
      try {
        const reconciliationRequired = runError?.unknownOutcome === true;
        finalized = await finalize(ownership.key, ownership.fencingToken, {
          status: canRetry ? 'retry_wait' : reconciliationRequired ? 'reconciliation_required' : 'dead_lettered',
          attempts: attempt,
          error: { code: safeErrorCode(runError) },
          ...(!canRetry ? { completedAt: new Date(now()).toISOString() } : {}),
          ...(reconciliationRequired ? { unknownOutcome: true, reconciliationRequired: true } : {}),
        });
      } catch (error) {
        return finalizationUnknown(meta, scheduledAt, error);
      }
      if (!finalized) return fencedOutcome(meta, scheduledAt);
      if (canRetry) {
        const renewed = await claim(definition, scheduledAt, trigger, runId);
        if (!renewed.owned) return { ok: false, skipped: renewed.reason };
        ownership.key = renewed.key;
        ownership.fencingToken = renewed.fencingToken;
        ownership.record = renewed.record;
      } else {
        if (runError?.unknownOutcome === true) {
          meta.runs += 1;
          meta.lastRunAt = scheduledAt;
          meta.lastResult = null;
          meta.lastError = 'reconciliation_required';
          logger.error?.(`[scheduler] job "${definition.name}" has an unknown outcome and requires reconciliation`);
          await completeAudit(definition, trigger, runId, auditStart, 'unknown', safeErrorCode(runError));
          return {
            ok: false,
            skipped: 'reconciliation_required',
            unknownOutcome: true,
            reconciliationRequired: true,
            runId,
            error: 'job outcome requires reconciliation',
          };
        }
        break;
      }
    }
    meta.runs += 1;
    meta.lastRunAt = scheduledAt;
    meta.lastResult = null;
    meta.lastError = safeErrorCode(lastError);
    await stateStore.put('dead-letter', `scheduler:${definition.name}:${runId}`, {
      operation: definition.name,
      scheduledAt,
      error: { code: safeErrorCode(lastError), message: 'job failed' },
      attempts: attemptsMade,
      createdAt: new Date(now()).toISOString(),
    });
    await completeAudit(definition, trigger, runId, auditStart, 'failed', safeErrorCode(lastError));
    logger.error?.(`[scheduler] job "${definition.name}" failed after ${attemptsMade} attempts`);
    return { ok: false, error: 'job failed', code: safeErrorCode(lastError), deadLettered: true };
  }

  async function tickOnce(date) {
    const currentMs = date.getTime();
    const metaRecord = await stateStore.get('job', '__scheduler__');
    const minutes = dueMinutes(metaRecord?.value?.lastTickMs, currentMs, maxCatchupMinutes);
    for (const definition of definitions.values()) {
      const matches = minutes.filter((time) => matchesSchedule(definition.schedule, new Date(time)));
      let selected = matches;
      if (definition.missedRunPolicy === 'skip') selected = matches.filter((time) => time === minuteFloor(currentMs));
      if (definition.missedRunPolicy === 'coalesce' && matches.length) selected = [matches.at(-1)];
      for (const scheduledMs of selected) {
        const scheduledAt = new Date(scheduledMs).toISOString();
        const outcome = await runClaimed(definition, scheduledAt, scheduledMs === minuteFloor(currentMs) ? 'schedule' : 'missed', scheduledAt);
        if (outcome.skipped === 'execution-ledger-capacity') {
          throw Object.assign(new Error('[scheduler] execution ledger capacity exhausted; explicit pruning is required'), {
            code: 'SCHEDULER_EXECUTION_CAPACITY',
            retryable: false,
          });
        }
      }
    }
    await stateStore.transaction(async (tx) => {
      const latest = tx.get('job', '__scheduler__');
      const lastTickMs = Math.max(latest?.value?.lastTickMs ?? 0, minuteFloor(currentMs));
      tx.put('job', '__scheduler__', { lastTickMs, instanceId }, latest ? { ifRevision: latest.revision } : { ifRevision: null });
    });
  }

  function tick(date = new Date(now())) {
    if (stopping) return Promise.resolve(stoppedResult());
    const acceptedDate = new Date(date.getTime());
    const operation = tickTail.then(() => tickOnce(acceptedDate));
    tickTail = operation.catch(() => {});
    return track(operation);
  }

  function runNow(name, { runId } = {}) {
    const definition = definitions.get(name);
    if (!definition) return Promise.resolve(null);
    if (stopping) return Promise.resolve(stoppedResult());
    if (runId !== undefined && (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(runId))) {
      return Promise.reject(Object.assign(new Error('[scheduler] manual runId must contain 1-256 safe identifier characters'), {
        code: 'SCHEDULER_RUN_ID_INVALID',
        unknownOutcome: false,
      }));
    }
    const scheduledAt = new Date(now()).toISOString();
    return track(runClaimed(definition, scheduledAt, 'manual', runId ?? `manual:${randomUUID()}`));
  }

  async function listExecutions({ jobName, cursor = null, limit = 100, includeResult = false } = {}) {
    if (jobName !== undefined && (typeof jobName !== 'string' || !jobName)) {
      throw new Error('[scheduler] jobName must be a non-empty string');
    }
    if (typeof includeResult !== 'boolean') throw new Error('[scheduler] includeResult must be boolean');
    const prefix = jobName ? `${EXECUTION_PREFIX}${jobName}:` : EXECUTION_PREFIX;
    return stateStore.transaction(async (tx) => {
      compactExpiredResults(tx, now());
      const page = tx.list('job', { prefix, cursor, limit });
      return {
        items: page.items.map((item) => redactExecution(item, includeResult)),
        nextCursor: page.nextCursor,
      };
    });
  }

  async function compactExecutions({ limit = 1_000 } = {}) {
    assertPositiveInteger(limit, 'compact limit', { max: 1_000 });
    return stateStore.transaction(async (tx) => ({
      compacted: compactExpiredResults(tx, now(), { limit }),
    }));
  }

  async function reconcileExecution({ jobName, runId, resolution, evidenceDigest } = {}) {
    if (typeof jobName !== 'string' || !jobName || typeof runId !== 'string' || !runId) {
      throw new Error('[scheduler] reconciliation requires non-empty jobName and runId');
    }
    if (!['succeeded', 'failed'].includes(resolution)) {
      throw new Error('[scheduler] reconciliation resolution must be succeeded or failed');
    }
    if (typeof evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(evidenceDigest)) {
      throw new Error('[scheduler] reconciliation evidenceDigest must be a 64-character hex SHA-256 digest');
    }
    const key = `${EXECUTION_PREFIX}${jobName}:${runId}`;
    return stateStore.transaction(async (tx) => {
      const existing = tx.get('job', key);
      if (!existing) return { reconciled: false, reason: 'not_found' };
      const expiredRunning = existing.value.status === 'running'
        && Number.isFinite(existing.value.leaseExpiresAt)
        && existing.value.leaseExpiresAt <= now();
      if (existing.value.status === 'running' && !expiredRunning) {
        return { reconciled: false, reason: 'still_running', status: existing.value.status };
      }
      if (existing.value.status !== 'reconciliation_required' && !expiredRunning) {
        return { reconciled: false, reason: 'not_reconciliation_required', status: existing.value.status };
      }
      const value = {
        ...existing.value,
        status: resolution === 'succeeded' ? 'reconciled_succeeded' : 'reconciled_failed',
        reconciledAt: new Date(now()).toISOString(),
        reconciliationEvidenceDigest: evidenceDigest.toLowerCase(),
        reconciliationRequired: false,
      };
      delete value.result;
      delete value.resultExpiresAt;
      tx.put('job', key, value, { ifRevision: existing.revision });
      return { reconciled: true, status: value.status };
    });
  }

  async function pruneExecutions({ before, limit = 1_000, acknowledgeReplayRisk = false } = {}) {
    if (acknowledgeReplayRisk !== true) {
      throw new Error('[scheduler] prune requires acknowledgeReplayRisk=true');
    }
    const beforeMs = typeof before === 'string' ? Date.parse(before) : before;
    if (!Number.isFinite(beforeMs)) throw new Error('[scheduler] prune before must be an epoch millisecond or ISO timestamp');
    assertPositiveInteger(limit, 'prune limit', { max: 1_000 });
    const outcome = await stateStore.transaction(async (tx) => {
      const ledger = executionLedgerMeta(tx, { verify: !ledgerCountVerified });
      let pruned = 0;
      let skippedRunning = 0;
      let skippedReconciliation = 0;
      forEachExecution(tx, (item) => {
        if (pruned >= limit) return;
        const status = item.value.status;
        if (status === 'running' || status === 'retry_wait') {
          skippedRunning += 1;
          return;
        }
        if (status === 'reconciliation_required') {
          skippedReconciliation += 1;
          return;
        }
        const terminalMs = Date.parse(item.value.completedAt ?? item.value.reconciledAt ?? '');
        if (!Number.isFinite(terminalMs) || terminalMs >= beforeMs) return;
        tx.delete('job', item.key, { ifRevision: item.revision });
        const deadLetter = tx.get('dead-letter', `scheduler:${item.value.name}:${item.value.runId}`);
        if (deadLetter) tx.delete('dead-letter', deadLetter.key, { ifRevision: deadLetter.revision });
        pruned += 1;
      });
      if (pruned > 0) updateExecutionLedgerCount(tx, ledger, ledger.count - pruned);
      return { pruned, skippedRunning, skippedReconciliation };
    });
    ledgerCountVerified = true;
    return outcome;
  }

  function start() {
    if (stopping) throw new Error('[scheduler] cannot start after stop');
    if (timer || starter) return;
    const delay = 60_000 - (now() % 60_000);
    starter = setTimeout(() => {
      starter = null;
      if (stopping) return;
      void tick().catch((error) => logger.error?.(`[scheduler] tick failed: ${error.message}`));
      timer = setInterval(() => void tick().catch((error) => logger.error?.(`[scheduler] tick failed: ${error.message}`)), 60_000);
      timer.unref?.();
    }, delay);
    starter.unref?.();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (starter) clearTimeout(starter);
    if (timer) clearInterval(timer);
    starter = null;
    timer = null;
    stopPromise = (async () => {
      while (activeOperations.size > 0) {
        await Promise.allSettled([...activeOperations]);
      }
      await tickTail;
    })();
    return stopPromise;
  }

  return assertScheduler({
    adapterName: 'durable',
    capabilities: Object.freeze({
      durable: true,
      missedRuns: 'configurable',
      multiInstance: stateStore.capabilities.multiProcess === true,
      fencing: true,
      executionLedger: 'bounded-summary-default',
      reconciliation: true,
      conformance: 'contract-tested',
    }),
    registerJob,
    runNow,
    listJobs: () => [...view.values()].map((item) => structuredClone(item)),
    tick,
    start,
    stop,
    listExecutions,
    compactExecutions,
    reconcileExecution,
    pruneExecutions,
  });
}
