/**
 * Minute-tick scheduler for patrol-style batch jobs.
 * schedule = { minute, hour, dayOfWeek?, dayOfMonth? } (all local time, NOT a
 * cron clone). Semantics:
 *  - a field left undefined matches everything, EXCEPT: when hour is set and
 *    minute is not, minute defaults to 0 (otherwise "hour: 8" would fire 60
 *    times, once per minute of that hour);
 *  - when both dayOfWeek and dayOfMonth are set, BOTH must match (cron uses OR
 *    here -- if you want cron's OR, register two jobs);
 *  - ticks are not persisted: minutes missed while the process is down are
 *    skipped, not replayed. Patrol jobs should tolerate a missed run.
 * Every job runs through safeRun: monthly budget check + try/catch + run log,
 * so one bad job never kills the process.
 */

function matches(schedule, date) {
  if (schedule.minute !== undefined && schedule.minute !== date.getMinutes()) return false;
  if (schedule.hour !== undefined && schedule.hour !== date.getHours()) return false;
  if (schedule.dayOfWeek !== undefined && schedule.dayOfWeek !== date.getDay()) return false;
  if (schedule.dayOfMonth !== undefined && schedule.dayOfMonth !== date.getDate()) return false;
  return true;
}

export function createScheduler({ costTracker, monthlyBudgetUsd, audit, logger = console } = {}) {
  /** name -> { name, schedule, run, runs, lastRunAt, lastResult, lastError } */
  const jobs = new Map();
  let timer = null;
  let starter = null;

  async function safeRun(job, trigger) {
    if (costTracker && monthlyBudgetUsd !== undefined && await costTracker.isOverBudget(monthlyBudgetUsd)) {
      logger.warn(`[scheduler] skip "${job.name}" (${trigger}): monthly budget $${monthlyBudgetUsd} exhausted`);
      return { ok: false, skipped: 'monthly-budget-exhausted' };
    }
    const event = { action: 'job.execute', resource: job.name, metadata: { trigger } };
    const auditStart = typeof audit?.start === 'function'
      ? await audit.start(event)
      : typeof audit?.append === 'function'
        ? await audit.append({ ...event, outcome: 'started', metadata: { trigger, auditPhase: 'pre-effect' } })
        : null;
    job.runs += 1;
    job.lastRunAt = new Date().toISOString();
    try {
      const result = await job.run();
      job.lastResult = result;
      job.lastError = null;
      try { await audit?.append?.({ ...event, outcome: 'ok', metadata: { trigger, auditStartId: auditStart?.id } }); }
      catch (error) { logger.error?.(`[audit] scheduler completion append failed code=${error.code ?? error.name ?? 'ERROR'}`); }
      logger.log(`[scheduler] job "${job.name}" (${trigger}) done`);
      return { ok: true, result };
    } catch (err) {
      const unknown = err?.unknownOutcome !== false;
      job.lastError = unknown ? 'reconciliation_required' : (err.code ?? err.name ?? 'JOB_FAILED');
      try { await audit?.append?.({ ...event, outcome: unknown ? 'unknown' : 'failed', metadata: { trigger, auditStartId: auditStart?.id } }); }
      catch (error) { logger.error?.(`[audit] scheduler completion append failed code=${error.code ?? error.name ?? 'ERROR'}`); }
      logger.error(`[scheduler] job "${job.name}" (${trigger}) failed code=${err.code ?? err.name ?? 'ERROR'}`);
      return unknown
        ? { ok: false, skipped: 'reconciliation_required', unknownOutcome: true, reconciliationRequired: true, error: 'job outcome requires reconciliation' }
        : { ok: false, error: 'job failed', code: err.code ?? err.name ?? 'JOB_FAILED' };
    }
  }

  async function tick(date = new Date()) {
    for (const job of jobs.values()) {
      if (matches(job.schedule, date)) await safeRun(job, 'schedule');
    }
  }

  return {
    registerJob({ name, schedule, run }) {
      if (!name || typeof run !== 'function') throw new Error('[scheduler] job needs a name and a run()');
      const s = { ...(schedule ?? {}) };
      // "hour without minute" almost always means "at HH:00", not 60 runs.
      if (s.hour !== undefined && s.minute === undefined) s.minute = 0;
      jobs.set(name, { name, schedule: s, run, runs: 0, lastRunAt: null, lastResult: null, lastError: null });
    },
    /** Manually trigger a job (POST /jobs/:name/run). Returns null for unknown jobs. */
    async runNow(name) {
      const job = jobs.get(name);
      if (!job) return null;
      return safeRun(job, 'manual');
    },
    listJobs() {
      return [...jobs.values()].map(({ run, ...meta }) => meta);
    },
    tick, // exposed for tests: a single tick fires matching jobs
    start() {
      if (timer || starter) return;
      // Align the first tick to the next minute boundary, then tick every 60s.
      const delay = 60_000 - (Date.now() % 60_000);
      starter = setTimeout(() => {
        void tick().catch((error) => logger.error?.(`[scheduler] tick failed: ${error.message}`));
        timer = setInterval(() => void tick().catch((error) => logger.error?.(`[scheduler] tick failed: ${error.message}`)), 60_000);
        timer.unref?.();
      }, delay);
      starter.unref?.();
    },
    stop() {
      if (starter) clearTimeout(starter);
      if (timer) clearInterval(timer);
      starter = null;
      timer = null;
    },
  };
}
