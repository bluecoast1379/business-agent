/**
 * Agent registry: assembles the interactive assistant (session-reusing) and
 * the patrol job (batch), and exposes the unified heartbeat handleMessage()
 * that every channel (HTTP, SSE, webhook, REPL) routes through.
 */
import { buildDemoTools } from '../toolpacks/demo/index.js';
import { randomUUID } from 'node:crypto';
import { DEMO_TOOL_MANIFEST } from '../toolpacks/demo/manifest.js';
import { createToolRegistry } from '../tools/registry.js';
import { createAssistant } from './assistant.js';
import { createPatrolJob } from './patrol.js';

export function buildRegistry({ config, provider, costTracker, sessionStore, confirmations, executor, telemetry, audit }) {
  for (const method of ['reserve', 'commit', 'refund', 'settleUnknown']) {
    if (typeof costTracker?.[method] !== 'function') {
      throw new Error(`[registry] costTracker.${method}() is required for atomic budget enforcement`);
    }
  }
  const classifiedTools = buildDemoTools({ confirmations });
  const tools = createToolRegistry({ tools: classifiedTools, manifest: DEMO_TOOL_MANIFEST, executor, audit });
  const assistant = createAssistant({ config, provider, costTracker, tools, executor, telemetry });
  const patrolJob = createPatrolJob({ config });

  /** sessionId -> tail of that session's promise chain (serialization queues). */
  const sessionQueues = new Map();

  async function recordAudit(event) {
    try { await audit?.append?.(event); }
    catch (error) {
      console.error(`[audit] append failed code=${error.code ?? error.name ?? 'ERROR'}`);
      await telemetry?.recordMetric?.('audit.failure', 1, { operation: event.action, errorClass: error.code ?? error.name });
    }
  }

  async function startAudit(event) {
    try {
      if (typeof audit?.start === 'function') return await audit.start(event);
      if (typeof audit?.append === 'function') {
        return await audit.append({ ...event, outcome: 'started', metadata: { ...(event.metadata ?? {}), auditPhase: 'pre-effect' } });
      }
      return null;
    } catch (error) {
      await telemetry?.recordMetric?.('audit.failure', 1, { operation: event.action, errorClass: error.code ?? error.name });
      throw error;
    }
  }

  async function processMessage(sessionId, message, context = {}) {
    const agentSpan = telemetry?.startSpan?.('agent.run', {
      ...(context.telemetryContext ?? {}),
      attributes: { requestId: context.requestId, sessionId, tenantId: context.principal?.tenantId, agent: 'assistant' },
    });
    let reservation;
    try {
      reservation = await costTracker.reserve({
        amountUsd: config.budget.maxUsdPerRequest,
        limitUsd: config.budget.monthlyUsd,
        agent: 'assistant',
      });
    } catch (error) {
      agentSpan?.end?.({ outcome: 'error', error });
      throw error;
    }
    if (!reservation.ok) {
      agentSpan?.end?.({ outcome: 'denied' });
      return {
        text: `[notice] Monthly LLM budget ($${config.budget.monthlyUsd}) is exhausted; new requests are paused. Raise BUDGET_MONTHLY_USD or wait for next month.`,
        costUsd: 0,
        admitted: false,
        denialCode: 'MONTHLY_BUDGET_EXHAUSTED',
      };
    }
    let auditStart;
    try {
      const auditEvent = {
        actor: context.principal?.subjectId,
        tenant: context.principal?.tenantId,
        action: 'agent.execute',
        resource: 'assistant',
        metadata: { requestId: context.requestId },
      };
      // Channels that need their own correlation/resource event can provide a
      // trusted hook. It is invoked only after the atomic budget reservation
      // succeeds and before session/provider/tool work begins.
      auditStart = typeof context.beforeEffectAudit === 'function'
        ? await context.beforeEffectAudit(auditEvent)
        : await startAudit(auditEvent);
    } catch (error) {
      await Promise.resolve(costTracker.refund(reservation.id)).catch(() => {});
      agentSpan?.end?.({ outcome: 'error', error });
      throw error;
    }
    try {
      const session = await sessionStore.getOrCreate(sessionId);
      const result = await assistant.prompt(message, {
        sessionMessages: session.messages,
        reservationId: reservation.id,
        signal: context.signal,
        principal: context.principal,
        requestId: context.requestId,
        operationId: context.operationId,
        telemetryContext: agentSpan ? { traceId: agentSpan.traceId, parentSpanId: agentSpan.spanId } : context.telemetryContext,
      });
      await sessionStore.setMessages(sessionId, result.messages);
      const settlement = await costTracker.commit(reservation.id);
      if (!settlement?.ok) throw Object.assign(new Error('[cost-tracker] reservation commit failed'), { code: 'COST_SETTLEMENT_FAILED', unknownOutcome: true });
      await recordAudit({
        actor: context.principal?.subjectId,
        tenant: context.principal?.tenantId,
        action: 'agent.complete',
        resource: 'assistant',
        outcome: 'ok',
        metadata: { requestId: context.requestId, costUsd: result.costUsd, auditStartId: auditStart?.id },
      });
      agentSpan?.end?.({ outcome: 'ok', attributes: { costUsd: result.costUsd } });
      return { text: result.text, costUsd: result.costUsd, admitted: true };
    } catch (err) {
      // Cost trackers intentionally support both synchronous in-memory and
      // asynchronous durable adapters. Normalize either result before applying
      // best-effort cleanup so a synchronous adapter cannot turn the original
      // request failure into `TypeError: .catch is not a function`.
      if (err?.unknownOutcome) await Promise.resolve(costTracker.settleUnknown(reservation.id)).catch(() => {});
      else await Promise.resolve(costTracker.refund(reservation.id)).catch(() => {});
      agentSpan?.end?.({ outcome: 'error', error: err });
      throw err;
    }
  }

  /**
   * Unified heartbeat: one entry point for all channels.
   * Requests for the SAME session are serialized through a per-session promise
   * chain -- concurrent read-modify-write would otherwise drop history turns.
   * Different sessions still run fully in parallel.
   */
  function handleMessage(sessionId, message, context = {}) {
    const safeContext = { ...context, operationId: context.operationId ?? randomUUID() };
    const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => sessionStore.withSessionLock
      ? sessionStore.withSessionLock(
          sessionId,
          ({ signal }) => processMessage(sessionId, message, { ...safeContext, signal }),
          { signal: safeContext.signal },
        )
      : processMessage(sessionId, message, safeContext));
    // Keep the chain alive after failures, and drop it once idle.
    const tail = run.catch(() => {});
    sessionQueues.set(sessionId, tail);
    tail.then(() => {
      if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
    });
    return run;
  }

  Object.defineProperty(handleMessage, 'supportsPreEffectAudit', { value: true });

  return {
    handleMessage,
    assistant,
    tools,
    jobs: [patrolJob], // register these with the scheduler at boot
  };
}
