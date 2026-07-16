import { maskIdentifier } from './read-model.js';
import { pseudonymize } from '../observability/redaction.js';

function canReadAcrossTenants(principal) {
  const roles = new Set(principal?.roles ?? []);
  const scopes = new Set(principal?.scopes ?? []);
  return roles.has('admin') || roles.has('auditor') || scopes.has('*') || scopes.has('dashboard:cross-tenant');
}

function visibleTo(principal, value) {
  if (canReadAcrossTenants(principal)) return true;
  return principal?.tenantId != null && value?.tenantId === principal.tenantId;
}

async function listNamespace(stateStore, namespace, limit = 1_000) {
  const items = [];
  let cursor = null;
  do {
    const page = await stateStore.list(namespace, { cursor, limit: Math.min(1_000, limit - items.length) });
    items.push(...page.items.map((record) => ({ ...record.value, publicId: record.key })));
    cursor = items.length >= limit ? null : page.nextCursor;
  } while (cursor);
  return items;
}

/** Runtime-backed, read-only Dashboard sources. Every source returns raw state
 * only to the Dashboard projector, which applies the strict field allowlist. */
export function createRuntimeDashboardSources({
  config,
  stateStore,
  sessionStore,
  costTracker,
  confirmations,
  scheduler,
  audit,
  startedAt = Date.now(),
} = {}) {
  const runsFor = async (principal) => (await listNamespace(stateStore, 'run'))
    .filter((value) => visibleTo(principal, value));

  return Object.freeze({
    async overview(query) {
      const crossTenant = canReadAcrossTenants(query.principal);
      const [cost, pending, runs] = await Promise.all([
        crossTenant ? costTracker.summary() : null,
        confirmations.list({ principal: query.principal }),
        runsFor(query.principal),
      ]);
      return {
        environment: config.runtimeProfile,
        overallStatus: 'HEALTHY',
        activeSessions: crossTenant ? await sessionStore.size() : null,
        monthlyCostUsd: cost?.costUsd ?? null,
        budget: { usedUsd: cost?.costUsd ?? null, limitUsd: crossTenant ? config.budget.monthlyUsd : null },
        counts: {
          runs: runs.length,
          failedRuns: runs.filter((run) => String(run.status).toLowerCase() === 'failed').length,
          pendingApprovals: pending.length,
          evals: null,
        },
        sources: [
          { name: 'state-store', availability: 'available', freshness: 'current', status: 'HEALTHY' },
          { name: 'eval-history', availability: 'unavailable', freshness: 'unknown', status: 'NOT_RUN' },
        ],
        limitations: crossTenant ? ['Eval history is available after a versioned eval report is imported.'] : ['Global session and cost totals require dashboard:cross-tenant.'],
      };
    },
    async runs(query) {
      return runsFor(query.principal);
    },
    async run(query) {
      const values = await runsFor(query.principal);
      return values.find((value) => String(value.publicId) === query.id || maskIdentifier(value.publicId) === query.id) ?? null;
    },
    async costs(query) {
      if (!canReadAcrossTenants(query.principal)) {
        return { data: { summary: { scope: 'restricted' }, items: [] }, meta: { availability: 'partial', freshness: 'current', source: 'cost-tracker' } };
      }
      const summary = await costTracker.summary();
      return {
        summary: { ...summary, budgetUsd: config.budget.monthlyUsd, scope: 'gateway' },
        items: Object.entries(summary.byAgent ?? {}).map(([agent, value]) => ({ label: agent, ...value, period: summary.month })),
      };
    },
    async approvals(query) {
      return confirmations.list({ principal: query.principal });
    },
    async audit(query) {
      const entries = await audit.list();
      const tenantHash = query.principal?.tenantId ? pseudonymize(query.principal.tenantId) : null;
      const visible = canReadAcrossTenants(query.principal)
        ? entries
        : entries.filter((entry) => tenantHash && entry.tenant === tenantHash);
      const integrity = await audit.verify();
      return visible.map((entry) => ({
        ...entry,
        publicId: entry.id,
        category: 'runtime',
        actorId: entry.actor,
        tenantId: entry.tenant,
        // A self-consistent hash chain is useful evidence, but its head is kept
        // in the same trust domain. Only an independently anchored head may be
        // labelled VERIFIED; the built-in source therefore stays UNVERIFIED.
        integrity: integrity.valid ? 'UNVERIFIED' : 'INVALID',
        algorithm: 'sha256',
        anchor: integrity.headHash,
      }));
    },
    async system() {
      const auditCapacity = typeof audit?.capacity === 'function' ? await audit.capacity() : null;
      return {
        environment: config.runtimeProfile,
        appVersion: '0.3.0',
        runtimeVersion: process.version,
        provider: config.provider,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1_000)),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        retention: `sessions ${config.sessionTtlMinutes} minutes`,
        telemetry: config.telemetry.enabled ? 'on' : 'off',
        persistenceConfigured: stateStore.capabilities.durable === true,
        historyConfigured: stateStore.capabilities.durable === true,
        evalsConfigured: false,
        auditConfigured: true,
        sources: [
          { name: stateStore.adapterName, availability: 'available', freshness: 'current', status: 'HEALTHY' },
          { name: scheduler.adapterName, availability: 'available', freshness: 'current', status: 'HEALTHY' },
          ...(auditCapacity ? [{
            name: 'audit-ledger',
            availability: auditCapacity.full ? 'partial' : 'available',
            freshness: 'current',
            status: auditCapacity.full ? 'DEGRADED' : 'HEALTHY',
          }] : []),
        ],
      };
    },
  });
}
