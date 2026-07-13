/**
 * Demo patrol job (batch-style agent): scans the Brewline dataset for anomalies
 * and pushes a report. Thresholds come from env (PATROL_OVERDUE_DAYS,
 * PATROL_MIN_ONTIME_RATE) so ops can tune them without code changes.
 * Rule-based on purpose: patrols should be cheap and deterministic; add an LLM
 * summarization step only if the raw findings need narrative.
 */
import { suppliers, invoices, deliveries, daysSince } from '../toolpacks/demo/data.js';

function buildNotifier(config) {
  if (config.notifyWebhookUrl) {
    // Generic outbound notification channel: any endpoint accepting JSON POST.
    return async (text) => {
      try {
        await fetch(config.notifyWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'agent-gateway-patrol', text }),
        });
      } catch (err) {
        console.error(`[patrol] notify failed (${err.message}); falling back to console:\n${text}`);
      }
    };
  }
  return async (text) => console.log(`[patrol]\n${text}`);
}

/**
 * Create the daily patrol job descriptor for the scheduler.
 * @returns {{ name: string, schedule: object, run: () => Promise<object> }}
 */
export function createPatrolJob({ config, notify }) {
  const send = notify ?? buildNotifier(config);
  const { overdueDays, minOnTimeRate } = config.patrol;

  async function runDailyPatrol() {
    const findings = [];

    const overdue = invoices
      .filter((inv) => inv.status === 'unpaid' && daysSince(inv.dueDate) >= overdueDays)
      .sort((a, b) => daysSince(b.dueDate) - daysSince(a.dueDate));
    if (overdue.length > 0) {
      const total = overdue.reduce((s, i) => s + i.amountUsd, 0);
      findings.push(
        `Overdue invoices (>=${overdueDays}d): ${overdue.length}, total $${total.toFixed(2)}. Worst: ${overdue[0].id} (${daysSince(overdue[0].dueDate)}d overdue).`,
      );
    }

    const laggards = suppliers.filter((s) => s.onTimeRate < minOnTimeRate);
    for (const s of laggards) {
      findings.push(`Supplier below on-time threshold (${minOnTimeRate}): ${s.name} (${s.id}) at ${(s.onTimeRate * 100).toFixed(0)}%.`);
    }

    const delayed = deliveries.filter((d) => d.status === 'delayed');
    if (delayed.length > 0) {
      findings.push(`Delayed deliveries: ${delayed.length} (${delayed.map((d) => d.id).join(', ')}).`);
    }

    const report = findings.length
      ? `Daily patrol report (${new Date().toISOString().slice(0, 10)}):\n- ${findings.join('\n- ')}`
      : `Daily patrol report (${new Date().toISOString().slice(0, 10)}): no anomalies found.`;

    await send(report);
    return { findings: findings.length, report };
  }

  return {
    name: 'daily-patrol',
    schedule: { minute: 0, hour: 8 }, // every day 08:00 local time
    run: runDailyPatrol,
  };
}
