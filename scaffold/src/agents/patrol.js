/**
 * Demo patrol job (batch-style agent): scans the Brewline dataset for anomalies
 * and pushes a report. Thresholds come from env (PATROL_OVERDUE_DAYS,
 * PATROL_MIN_ONTIME_RATE) so ops can tune them without code changes.
 * Rule-based on purpose: patrols should be cheap and deterministic; add an LLM
 * summarization step only if the raw findings need narrative.
 */
import { createHash } from 'node:crypto';
import { suppliers, invoices, deliveries, daysSince } from '../toolpacks/demo/data.js';

function reportDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function buildNotifier(config) {
  if (config.notifyWebhookUrl) {
    // Generic outbound notification channel: any endpoint accepting JSON POST.
    return async (text, { signal, idempotencyKey } = {}) => {
      try {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
        const response = await fetch(config.notifyWebhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ source: 'agent-gateway-patrol', text }),
          redirect: 'error',
          signal,
        });
        await response.body?.cancel?.().catch?.(() => {});
        if (!response.ok) {
          throw Object.assign(new Error('[patrol] notification endpoint rejected the report'), {
            code: `PATROL_NOTIFY_HTTP_${response.status}`,
            unknownOutcome: response.status >= 500 || response.status === 408,
          });
        }
      } catch (rawError) {
        const error = rawError instanceof Error ? rawError : new Error('[patrol] notification failed');
        error.code ??= 'PATROL_NOTIFY_UNKNOWN';
        if (rawError?.unknownOutcome !== false) error.unknownOutcome = true;
        console.error(`[patrol] notify failed code=${error.code} reportDigest=${reportDigest(text)}`);
        throw error;
      }
    };
  }
  // Console is an operations sink, not a business-data delivery channel.
  return async (text) => console.log(`[patrol] report generated digest=${reportDigest(text)} bytes=${Buffer.byteLength(text)}`);
}

/**
 * Create the daily patrol job descriptor for the scheduler.
 * @returns {{ name: string, schedule: object, run: () => Promise<object> }}
 */
export function createPatrolJob({ config, notify }) {
  const send = notify ?? buildNotifier(config);
  const { overdueDays, minOnTimeRate } = config.patrol;

  async function runDailyPatrol({ signal, idempotencyKey } = {}) {
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

    await send(report, { signal, idempotencyKey });
    return { findings: findings.length, report };
  }

  return {
    name: 'daily-patrol',
    schedule: { minute: 0, hour: 8 }, // every day 08:00 local time
    timeoutMs: 30_000,
    idempotency: 'required',
    run: runDailyPatrol,
  };
}
