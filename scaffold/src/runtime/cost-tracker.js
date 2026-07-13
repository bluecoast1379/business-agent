/**
 * In-memory monthly cost tracker. agent.js reports every LLM call here, so
 * /status and the scheduler budget guard read real numbers, not placeholders.
 * Swap for a persistent store if you need cost history across restarts.
 */

function monthKeyOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function createCostTracker() {
  /** monthKey -> { costUsd, calls, inputTokens, outputTokens, byAgent } */
  const months = new Map();

  function bucket(monthKey) {
    let b = months.get(monthKey);
    if (!b) {
      b = { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byAgent: {} };
      months.set(monthKey, b);
    }
    return b;
  }

  return {
    /** Record one LLM call. Called by agent.js on every turn. */
    trackUsage({ agent = 'unknown', model = 'unknown', usage = {}, costUsd = 0 }) {
      const b = bucket(monthKeyOf());
      b.costUsd += costUsd;
      b.calls += 1;
      b.inputTokens += usage.input_tokens ?? 0;
      b.outputTokens += usage.output_tokens ?? 0;
      const byAgent = (b.byAgent[agent] ??= { costUsd: 0, calls: 0, models: {} });
      byAgent.costUsd += costUsd;
      byAgent.calls += 1;
      byAgent.models[model] = (byAgent.models[model] ?? 0) + 1;
    },
    getMonthlyCost(monthKey = monthKeyOf()) {
      return months.get(monthKey)?.costUsd ?? 0;
    },
    isOverBudget(monthlyBudgetUsd) {
      return this.getMonthlyCost() >= monthlyBudgetUsd;
    },
    summary(monthKey = monthKeyOf()) {
      const b = months.get(monthKey);
      return {
        month: monthKey,
        costUsd: b?.costUsd ?? 0,
        calls: b?.calls ?? 0,
        inputTokens: b?.inputTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        byAgent: b?.byAgent ?? {},
      };
    },
  };
}
