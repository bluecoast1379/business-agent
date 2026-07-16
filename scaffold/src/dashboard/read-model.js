import { createHash, randomUUID } from 'node:crypto';

export const DASHBOARD_SCHEMA_VERSION = 'dashboard.v1';
export const DASHBOARD_REDACTION_POLICY_VERSION = 'dashboard-redaction.v1';
export const DASHBOARD_DEFAULT_PAGE_SIZE = 25;
export const DASHBOARD_MAX_PAGE_SIZE = 100;

const AVAILABILITY = new Set(['available', 'disabled', 'unavailable', 'partial']);
const FRESHNESS = new Set(['current', 'stale', 'unknown']);
const TELEMETRY = new Set(['on', 'off', 'not_applicable', 'unknown']);
const STATUS = new Set([
  'OK', 'HEALTHY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'WAITING',
  'PENDING', 'EXPIRED', 'CANCELLED', 'SKIPPED', 'PASS', 'FAIL', 'BLOCKED',
  'NOT_RUN', 'STALE', 'WAIVED', 'PENDING_HUMAN', 'VERIFIED', 'UNVERIFIED',
  'INVALID', 'UNKNOWN', 'OFF', 'UNAVAILABLE',
]);

const HISTORY_RESOURCES = new Set(['runs', 'run', 'evals', 'eval', 'approvals', 'audit']);
const PAGINATED_RESOURCES = new Set(['runs', 'costs', 'evals', 'approvals', 'audit']);
const CANARY_TEXT = /\b[A-Z0-9:_-]*CANARY[A-Z0-9:_-]*\b/gi;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~+/-]{6,}|(?:sk|api|tok|secret|password)[_-][a-z0-9_-]{6,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;
const SENSITIVE_LABEL = /(?:prompt|message|authorization|cookie|token|secret|password|signature|api[_-]?key|tool[_-]?(?:arg|result)|payload|request[_-]?body|response[_-]?body)/gi;
const PRIVATE_PATH = /(?:\/(?:Users|home|private|var|etc|tmp)\/[A-Za-z0-9._~!$&'()+,;=:@%/-]+|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+)/gi;
const URL_WITH_AUTHORITY = /\bhttps?:\/\/[^\s]+/gi;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finite(value);
  return Number.isInteger(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeText(value, fallback = 'N/A', maxLength = 240) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(CANARY_TEXT, '<redacted>')
    .replace(SECRET_TEXT, '<redacted>')
    .replace(SENSITIVE_LABEL, '<redacted>')
    .replace(PRIVATE_PATH, '<redacted-path>')
    .replace(URL_WITH_AUTHORITY, '<redacted-url>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength) || fallback;
}

function safeEnum(value, allowed, fallback) {
  const normalized = safeText(value, fallback, 64).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function safeStatus(value, fallback = 'UNKNOWN') {
  const normalized = safeText(value, fallback, 64).toUpperCase().replace(/[ -]+/g, '_');
  return STATUS.has(normalized) ? normalized : fallback;
}

function safeIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clockValue(now) {
  const value = typeof now === 'function' ? now() : now;
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function hashIdentifier(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function maskIdentifier(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const text = safeText(value, '', 256);
  if (!text || text === '<redacted>') return '••••••';
  if (text.startsWith('••••••')) return text.slice(0, 24);
  // A raw suffix is both guessable and collision-prone. Use a stable digest so
  // detail links remain deterministic without disclosing any identifier bytes.
  return `••••••${hashIdentifier(text)}`;
}

function pseudonymousIdentifier(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  return `ref:${hashIdentifier(value)}`;
}

function safeCorrelationId(value) {
  if (value === null || value === undefined || value === '') return randomUUID();
  return pseudonymousIdentifier(value);
}

function redaction(reason = 'sensitive_payload_not_collected') {
  return Object.freeze({ redacted: true, reason });
}

function safeSource(value, fallback = 'dashboard-read-model') {
  return safeText(value, fallback, 80).replace(/[^a-zA-Z0-9._:/ -]/g, '');
}

function pageItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.records)) return value.records;
  return [];
}

function publicId(item) {
  return item?.publicId ?? item?.maskedId ?? item?.runId ?? item?.evalRunId ?? item?.id;
}

function projectSourceStatus(item = {}) {
  return {
    name: safeText(item.displayName ?? item.name, 'Unknown source', 80),
    availability: safeEnum(item.availability, AVAILABILITY, 'unavailable'),
    freshness: safeEnum(item.freshness, FRESHNESS, 'unknown'),
    asOf: safeIso(item.asOf),
    status: safeStatus(item.status),
  };
}

function projectOverview(value = {}) {
  const budget = value?.budget ?? {};
  const counts = value?.counts ?? {};
  return {
    environment: safeText(value?.environment, 'unknown', 48),
    overallStatus: safeStatus(value?.overallStatus ?? value?.status),
    activeSessions: integer(value?.activeSessions),
    monthlyCostUsd: finite(value?.monthlyCostUsd ?? value?.costUsd),
    budget: {
      usedUsd: finite(budget.usedUsd ?? value?.monthlyCostUsd ?? value?.costUsd),
      limitUsd: finite(budget.limitUsd ?? budget.monthlyBudgetUsd),
      utilizationPct: finite(budget.utilizationPct),
      status: safeStatus(budget.status),
    },
    counts: {
      runs: integer(counts.runs),
      failedRuns: integer(counts.failedRuns),
      pendingApprovals: integer(counts.pendingApprovals),
      evals: integer(counts.evals),
    },
    sources: Array.isArray(value?.sources) ? value.sources.slice(0, 24).map(projectSourceStatus) : [],
    limitations: Array.isArray(value?.limitations)
      ? value.limitations.slice(0, 12).map((item) => safeText(item, 'Data unavailable', 160))
      : [],
  };
}

function projectTimelineEvent(item = {}) {
  return {
    id: maskIdentifier(publicId(item)),
    occurredAt: safeIso(item.occurredAt ?? item.at),
    type: safeText(item.type, 'event', 48),
    status: safeStatus(item.status),
    durationMs: finite(item.durationMs),
    summary: safeText(item.redactedSummary, 'Details redacted', 160),
    redaction: redaction(),
  };
}

function projectRunNode(item = {}) {
  return {
    id: maskIdentifier(publicId(item)),
    name: safeText(item.displayName ?? item.name, 'Unnamed node', 96),
    type: safeText(item.type, 'unknown', 48),
    status: safeStatus(item.status),
    startedAt: safeIso(item.startedAt),
    endedAt: safeIso(item.endedAt),
    durationMs: finite(item.durationMs),
    model: safeText(item.modelLabel ?? item.model, 'N/A', 80),
    tool: safeText(item.toolName ?? item.tool, 'N/A', 80),
    costUsd: finite(item.costUsd),
    inputTokens: integer(item.inputTokens),
    outputTokens: integer(item.outputTokens),
    errorClass: safeText(item.errorClass, 'N/A', 80),
    correlationId: safeCorrelationId(item.correlationId),
    redaction: redaction(),
  };
}

function projectRun(item = {}, detail = false) {
  const base = {
    id: maskIdentifier(publicId(item)),
    name: safeText(item.displayName ?? item.name ?? item.agentName, 'Unnamed run', 96),
    agent: safeText(item.agentLabel ?? item.agent, 'N/A', 80),
    status: safeStatus(item.status),
    trigger: safeText(item.trigger, 'unknown', 48),
    startedAt: safeIso(item.startedAt),
    endedAt: safeIso(item.endedAt),
    durationMs: finite(item.durationMs),
    costUsd: finite(item.costUsd),
    inputTokens: integer(item.inputTokens ?? item.tokens?.input),
    outputTokens: integer(item.outputTokens ?? item.tokens?.output),
    evalStatus: safeStatus(item.evalStatus),
    approvalStatus: safeStatus(item.approvalStatus),
    freshness: safeEnum(item.freshness, FRESHNESS, 'unknown'),
    correlationId: safeCorrelationId(item.correlationId),
    redaction: redaction(),
  };
  if (!detail) return base;
  return {
    ...base,
    nodes: Array.isArray(item.nodes) ? item.nodes.slice(0, 1_000).map(projectRunNode) : [],
    timeline: Array.isArray(item.timeline) ? item.timeline.slice(0, 1_000).map(projectTimelineEvent) : [],
    evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 100).map((entry) => ({
      kind: safeText(entry.kind, 'evidence', 48),
      status: safeStatus(entry.status),
      fingerprint: maskIdentifier(entry.fingerprint ?? entry.id),
      asOf: safeIso(entry.asOf),
    })) : [],
  };
}

function projectCostItem(item = {}) {
  return {
    period: safeText(item.period ?? item.month, 'N/A', 32),
    label: safeText(item.displayLabel ?? item.label ?? item.agent, 'Unattributed', 80),
    costUsd: finite(item.costUsd),
    calls: integer(item.calls),
    inputTokens: integer(item.inputTokens),
    outputTokens: integer(item.outputTokens),
    priceStatus: safeStatus(item.priceStatus),
    freshness: safeEnum(item.freshness, FRESHNESS, 'unknown'),
  };
}

function projectCosts(value = {}) {
  const summary = value?.summary ?? value ?? {};
  return {
    summary: {
      period: safeText(summary.period ?? summary.month, 'N/A', 32),
      costUsd: finite(summary.costUsd),
      budgetUsd: finite(summary.budgetUsd ?? summary.monthlyBudgetUsd),
      calls: integer(summary.calls),
      inputTokens: integer(summary.inputTokens),
      outputTokens: integer(summary.outputTokens),
      utilizationPct: finite(summary.utilizationPct),
      priceStatus: safeStatus(summary.priceStatus),
      scope: safeText(summary.scope, 'current_process', 64),
    },
    items: pageItems(value).map(projectCostItem),
  };
}

function projectCriterion(item = {}) {
  return {
    id: maskIdentifier(publicId(item)),
    name: safeText(item.displayName ?? item.name, 'Unnamed criterion', 120),
    automaticStatus: safeStatus(item.automaticStatus ?? item.status),
    humanGateStatus: safeStatus(item.humanGateStatus, 'NOT_RUN'),
    score: finite(item.score),
    threshold: finite(item.threshold),
    evidenceFreshness: safeEnum(item.evidenceFreshness ?? item.freshness, FRESHNESS, 'unknown'),
    redaction: redaction(),
  };
}

function projectEval(item = {}, detail = false) {
  const base = {
    id: maskIdentifier(publicId(item)),
    suite: safeText(item.suiteLabel ?? item.suite, 'Unnamed suite', 96),
    status: safeStatus(item.status),
    automaticStatus: safeStatus(item.automaticStatus ?? item.status),
    humanGateStatus: safeStatus(item.humanGateStatus, 'NOT_RUN'),
    score: finite(item.score),
    threshold: finite(item.threshold),
    startedAt: safeIso(item.startedAt),
    endedAt: safeIso(item.endedAt),
    evidenceFreshness: safeEnum(item.evidenceFreshness ?? item.freshness, FRESHNESS, 'unknown'),
    datasetFingerprint: maskIdentifier(item.datasetFingerprint),
    redaction: redaction(),
  };
  if (!detail) return base;
  return {
    ...base,
    criteria: Array.isArray(item.criteria) ? item.criteria.slice(0, 500).map(projectCriterion) : [],
    limitations: Array.isArray(item.limitations)
      ? item.limitations.slice(0, 20).map((entry) => safeText(entry, 'Data unavailable', 160))
      : [],
  };
}

function projectApproval(item = {}) {
  return {
    id: maskIdentifier(publicId(item)),
    status: safeStatus(item.status ?? (item.approved === true ? 'VERIFIED' : 'PENDING')),
    toolName: safeText(item.toolName, 'Unknown tool', 80),
    summary: safeText(item.redactedSummary, 'Details redacted', 160),
    createdAt: safeIso(item.createdAt),
    expiresAt: safeIso(item.expiresAt),
    actorRole: safeText(item.actorRole, 'N/A', 48),
    correlationId: safeCorrelationId(item.correlationId),
    redaction: redaction('tool_arguments_not_returned'),
  };
}

function projectAudit(item = {}) {
  const algorithm = safeText(item.algorithm, 'N/A', 48);
  const anchor = maskIdentifier(item.anchor ?? item.headHash);
  const requestedIntegrity = safeStatus(item.integrity);
  const integrity = requestedIntegrity === 'VERIFIED' && (algorithm === 'N/A' || anchor === 'N/A')
    ? 'UNVERIFIED'
    : requestedIntegrity;
  return {
    id: maskIdentifier(publicId(item)),
    occurredAt: safeIso(item.occurredAt),
    category: safeText(item.category, 'system', 48),
    action: safeText(item.action, 'unknown', 80),
    resourceType: safeText(item.resourceType ?? item.resource, 'N/A', 80),
    outcome: safeStatus(item.outcome),
    policyDecision: safeText(item.policyDecision, 'N/A', 64),
    actorRole: safeText(item.actorRole, 'N/A', 48),
    actorId: pseudonymousIdentifier(item.actorId ?? item.actor),
    tenantId: pseudonymousIdentifier(item.tenantId ?? item.tenant),
    integrity,
    algorithm,
    anchor,
    correlationId: safeCorrelationId(item.correlationId),
    redaction: redaction('audit_payload_not_returned'),
  };
}

function projectSystem(value = {}) {
  return {
    environment: safeText(value?.environment, 'unknown', 48),
    appVersion: safeText(value?.appVersion ?? value?.version, 'unknown', 48),
    runtimeVersion: safeText(value?.runtimeVersion, 'unknown', 48),
    providerLabel: safeText(value?.providerLabel ?? value?.provider, 'unknown', 80),
    uptimeSeconds: finite(value?.uptimeSeconds),
    timezone: safeText(value?.timezone, 'UTC', 64),
    retention: safeText(value?.retentionLabel ?? value?.retention, 'unknown', 120),
    telemetry: safeEnum(value?.telemetry, TELEMETRY, 'unknown'),
    redactionPolicyVersion: safeText(
      value?.redactionPolicyVersion,
      DASHBOARD_REDACTION_POLICY_VERSION,
      80,
    ),
    sources: Array.isArray(value?.sources) ? value.sources.slice(0, 32).map(projectSourceStatus) : [],
    flags: {
      persistenceConfigured: booleanOrNull(value?.persistenceConfigured),
      historyConfigured: booleanOrNull(value?.historyConfigured),
      evalsConfigured: booleanOrNull(value?.evalsConfigured),
      auditConfigured: booleanOrNull(value?.auditConfigured),
    },
  };
}

function projectResource(resource, value) {
  switch (resource) {
    case 'overview': return projectOverview(value ?? {});
    case 'runs': return { items: pageItems(value).map((item) => projectRun(item, false)) };
    case 'run': return value ? projectRun(value, true) : null;
    case 'costs': return projectCosts(value ?? {});
    case 'evals': return { items: pageItems(value).map((item) => projectEval(item, false)) };
    case 'eval': return value ? projectEval(value, true) : null;
    case 'approvals': return { items: pageItems(value).map(projectApproval) };
    case 'audit': return { items: pageItems(value).map(projectAudit) };
    case 'system': return projectSystem(value ?? {});
    default: return null;
  }
}

function unwrapRaw(raw) {
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'data') && raw.meta) {
    return { value: raw.data, meta: raw.meta };
  }
  return { value: raw, meta: raw && typeof raw === 'object' ? raw.meta ?? {} : {} };
}

function sliceProjected(resource, projected, rawMeta, pagination) {
  if (!PAGINATED_RESOURCES.has(resource)) return { data: projected, page: null };
  const items = Array.isArray(projected?.items) ? projected.items : [];
  const applied = rawMeta?.page?.applied === true || rawMeta?.schemaVersion === DASHBOARD_SCHEMA_VERSION;
  const offset = pagination?.offset ?? 0;
  const limit = pagination?.limit ?? DASHBOARD_DEFAULT_PAGE_SIZE;
  const selected = (applied ? items : items.slice(offset, offset + limit)).slice(0, limit);
  const declaredTotal = integer(rawMeta?.page?.total ?? rawMeta?.total);
  const total = declaredTotal ?? (applied ? null : items.length);
  const hasMore = typeof rawMeta?.page?.hasMore === 'boolean'
    ? rawMeta.page.hasMore
    : total !== null
      ? offset + selected.length < total
      : selected.length === limit;
  const hasPrevious = offset > 0;
  const data = { ...projected, items: selected };
  return {
    data,
    page: {
      limit,
      count: selected.length,
      total,
      hasMore,
      hasPrevious,
      offset,
    },
  };
}

export function encodeDashboardCursor(resource, offset) {
  const payload = JSON.stringify({ v: 1, r: resource, o: offset });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeDashboardCursor(resource, cursor) {
  if (!cursor) return 0;
  if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new TypeError('invalid dashboard cursor');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed?.r !== resource || !Number.isSafeInteger(parsed?.o) || parsed.o < 0) {
      throw new TypeError('invalid dashboard cursor');
    }
    return parsed.o;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'invalid dashboard cursor') throw error;
    throw new TypeError('invalid dashboard cursor');
  }
}

export function sanitizeDashboardEnvelope(resource, raw, {
  pagination,
  telemetryEnabled = false,
  environment = 'unknown',
  now = Date.now,
  staleAfterMs = 5 * 60_000,
  correlationId,
} = {}) {
  const { value, meta: rawMeta } = unwrapRaw(raw);
  const currentTime = clockValue(now);
  const asOf = safeIso(rawMeta?.asOf ?? raw?.asOf) ?? new Date(currentTime).toISOString();
  let availability = safeEnum(rawMeta?.availability ?? raw?.availability, AVAILABILITY, value === null || value === undefined ? 'unavailable' : 'available');
  if (availability === 'unavailable' && !telemetryEnabled && HISTORY_RESOURCES.has(resource)) availability = 'disabled';

  let freshness = safeEnum(rawMeta?.freshness ?? raw?.freshness, FRESHNESS, 'unknown');
  const age = currentTime - new Date(asOf).getTime();
  if (freshness === 'current' && Number.isFinite(staleAfterMs) && staleAfterMs >= 0 && age > staleAfterMs) {
    freshness = 'stale';
  }

  const projected = projectResource(resource, value);
  const { data, page } = sliceProjected(resource, projected, rawMeta, pagination);
  const meta = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    asOf,
    source: safeSource(rawMeta?.source ?? raw?.source),
    availability,
    freshness,
    telemetry: telemetryEnabled
      ? safeEnum(rawMeta?.telemetry ?? raw?.telemetry, TELEMETRY, 'on')
      : 'off',
    redactionPolicyVersion: DASHBOARD_REDACTION_POLICY_VERSION,
    correlationId: safeCorrelationId(correlationId ?? rawMeta?.correlationId),
  };
  if (page) {
    meta.page = {
      limit: page.limit,
      count: page.count,
      total: page.total,
      hasMore: page.hasMore,
      hasPrevious: page.hasPrevious,
      nextCursor: page.hasMore ? encodeDashboardCursor(resource, page.offset + page.count) : null,
      previousCursor: page.hasPrevious
        ? encodeDashboardCursor(resource, Math.max(0, page.offset - page.limit))
        : null,
    };
  }
  return Object.freeze({ data, meta: Object.freeze(meta) });
}

function missingSource(resource, { telemetryEnabled, environment, now }) {
  const asOf = new Date(clockValue(now)).toISOString();
  if (resource === 'overview') {
    return {
      data: { environment, overallStatus: 'UNKNOWN', sources: [], limitations: ['No dashboard source is configured.'] },
      meta: { availability: 'partial', freshness: 'unknown', telemetry: telemetryEnabled ? 'on' : 'off', asOf, source: 'dashboard-bootstrap' },
    };
  }
  if (resource === 'system') {
    return {
      data: { environment, telemetry: telemetryEnabled ? 'on' : 'off', sources: [] },
      meta: { availability: 'partial', freshness: 'unknown', telemetry: telemetryEnabled ? 'on' : 'off', asOf, source: 'dashboard-bootstrap' },
    };
  }
  return {
    data: resource === 'run' || resource === 'eval' ? null : { items: [] },
    meta: {
      availability: !telemetryEnabled && HISTORY_RESOURCES.has(resource) ? 'disabled' : 'unavailable',
      freshness: 'unknown',
      telemetry: telemetryEnabled ? 'on' : 'off',
      asOf,
      source: 'not-configured',
    },
  };
}

async function invokeSource(source, query) {
  if (typeof source === 'function') return source(query);
  if (Array.isArray(source)) {
    if (query.id === undefined) return source;
    return source.find((item) => {
      const id = item?.publicId ?? item?.id ?? item?.runId ?? item?.evalRunId;
      return String(id) === query.id || maskIdentifier(id) === query.id;
    }) ?? null;
  }
  if (!source || typeof source !== 'object') return source;
  if (query.id !== undefined && typeof source.get === 'function') return source.get(query.id, query);
  if (query.id === undefined && typeof source.list === 'function') return source.list(query);
  if (typeof source.snapshot === 'function') return source.snapshot(query);
  return source;
}

function sourceFor(sources, resource) {
  if (resource === 'run') return sources.run ?? sources.runs;
  if (resource === 'eval') return sources.eval ?? sources.evals;
  return sources[resource];
}

export function createDashboardReadModelProvider({
  sources = {},
  telemetryEnabled = false,
  environment = 'unknown',
  now = Date.now,
  staleAfterMs = 5 * 60_000,
} = {}) {
  async function readRaw(query) {
    const source = sourceFor(sources, query.resource);
    if (source === undefined || source === null) {
      return missingSource(query.resource, { telemetryEnabled, environment, now });
    }
    const value = await invokeSource(source, query);
    if (value === null && query.id !== undefined) {
      return {
        data: null,
        meta: {
          availability: 'available',
          freshness: 'unknown',
          telemetry: telemetryEnabled ? 'on' : 'off',
          asOf: new Date(clockValue(now)).toISOString(),
          source: 'configured-source',
        },
      };
    }
    return value === undefined
      ? missingSource(query.resource, { telemetryEnabled, environment, now })
      : value;
  }

  async function read(query) {
    const raw = await readRaw(query);
    return sanitizeDashboardEnvelope(query.resource, raw, {
      pagination: query.pagination,
      telemetryEnabled,
      environment,
      now,
      staleAfterMs,
      correlationId: query.correlationId,
    });
  }

  return Object.freeze({ read, readRaw });
}
