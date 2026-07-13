/**
 * Agent registry: assembles the interactive assistant (session-reusing) and
 * the patrol job (batch), and exposes the unified heartbeat handleMessage()
 * that every channel (HTTP, SSE, webhook, REPL) routes through.
 */
import { buildDemoTools } from '../toolpacks/demo/index.js';
import { createAssistant } from './assistant.js';
import { createPatrolJob } from './patrol.js';

export function buildRegistry({ config, provider, costTracker, sessionStore, confirmations }) {
  const tools = buildDemoTools({ confirmations });
  const assistant = createAssistant({ config, provider, costTracker, tools });
  const patrolJob = createPatrolJob({ config });

  /** sessionId -> tail of that session's promise chain (serialization queues). */
  const sessionQueues = new Map();

  async function processMessage(sessionId, message) {
    if (costTracker.isOverBudget(config.budget.monthlyUsd)) {
      return {
        text: `[notice] Monthly LLM budget ($${config.budget.monthlyUsd}) is exhausted; new requests are paused. Raise BUDGET_MONTHLY_USD or wait for next month.`,
        costUsd: 0,
      };
    }
    const session = sessionStore.getOrCreate(sessionId);
    const result = await assistant.prompt(message, { sessionMessages: session.messages });
    sessionStore.setMessages(sessionId, result.messages);
    return { text: result.text, costUsd: result.costUsd };
  }

  /**
   * Unified heartbeat: one entry point for all channels.
   * Requests for the SAME session are serialized through a per-session promise
   * chain -- concurrent read-modify-write would otherwise drop history turns.
   * Different sessions still run fully in parallel.
   */
  function handleMessage(sessionId, message) {
    const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => processMessage(sessionId, message));
    // Keep the chain alive after failures, and drop it once idle.
    const tail = run.catch(() => {});
    sessionQueues.set(sessionId, tail);
    tail.then(() => {
      if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
    });
    return run;
  }

  return {
    handleMessage,
    assistant,
    tools,
    jobs: [patrolJob], // register these with the scheduler at boot
  };
}
