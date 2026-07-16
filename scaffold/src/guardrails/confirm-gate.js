/**
 * Human confirmation gate for write tools -- out-of-band approval.
 *
 * Design goal: the MODEL must never be able to approve its own write. So the
 * approval signal travels outside the agent loop:
 *
 *   1) first tool call (original args, no confirmationId) does NOT execute.
 *      It validates args, stores them, and returns
 *      { pendingConfirmation, confirmationId, summary } -- no secret token,
 *      knowing the id grants nothing by itself;
 *   2) a HUMAN operator reviews and approves via the authenticated HTTP API
 *      (POST /confirmations/:id/approve, Bearer GATEWAY_AUTH_TOKEN) or, in the
 *      REPL, with the /approve <id> command typed by the human;
 *   3) only then does a second tool call with { confirmationId } execute the
 *      ORIGINAL stored args (re-sent args are ignored, so nothing can be
 *      tampered with in between). Ids are single-use and expire after ttlMs.
 *
 * An unapproved second call returns a "not_yet_approved" error and keeps the
 * entry pending -- the model can wait or ask the user, but cannot bypass it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { validateArgs } from '../runtime/tool.js';

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_RECORDS = 10_000;
const ACTIVE_STATUSES = new Set(['pending', 'approved']);
const PROTECTED_STATUSES = new Set(['executing', 'reconciliation_required']);
const TERMINAL_STATUSES = new Set(['rejected', 'completed', 'failed']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function argsDigest(args) {
  return sha256(JSON.stringify(args));
}

function redactReviewSecrets(value) {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, '[redacted bearer credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted jwt]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted aws key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted google key]')
    .replace(/\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted provider credential]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^\s,;"']{4,}["']?/gi, '[redacted credential]');
}

function normalizeReviewSummary(summary) {
  if (typeof summary !== 'string') throw new Error('[confirm-gate] review summary must be a string');
  const normalized = redactReviewSecrets(summary)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 500) {
    throw new Error('[confirm-gate] review summary must contain 1-500 visible characters');
  }
  return normalized;
}

function assertNoCredentialArgs(args) {
  const serialized = JSON.stringify(args);
  if (redactReviewSecrets(serialized) !== serialized) {
    const error = new Error('[confirm-gate] write arguments contain credential-shaped data and cannot be persisted for approval');
    error.code = 'CONFIRMATION_ARGUMENTS_SECRET';
    error.statusCode = 400;
    error.unknownOutcome = false;
    throw error;
  }
}

function confirmationStatus(entry) {
  if (typeof entry?.status === 'string') return entry.status;
  return entry?.approved === true ? 'approved' : 'pending';
}

function assertCenterOptions({ ttlMs, terminalRetentionMs, maxRecords }) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error('[confirm-gate] ttlMs must be a positive integer');
  if (!Number.isInteger(terminalRetentionMs) || terminalRetentionMs < 1) {
    throw new Error('[confirm-gate] terminalRetentionMs must be a positive integer');
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
    throw new Error('[confirm-gate] maxRecords must be an integer between 1 and 1000000');
  }
}

function assertPage({ cursor, limit }) {
  if (cursor !== null && typeof cursor !== 'string') throw new Error('[confirm-gate] cursor must be null or a string');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('[confirm-gate] limit must be an integer between 1 and 1000');
  }
}

function capacityError(maxRecords) {
  return Object.assign(new Error(`[confirm-gate] confirmation capacity ${maxRecords} is exhausted; reconcile or prune eligible records`), {
    code: 'CONFIRMATION_CAPACITY',
    statusCode: 503,
    retryable: false,
  });
}

function digestIsValid(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function publicMetadata(entry, revision) {
  const status = confirmationStatus(entry);
  return {
    id: entry.id,
    revision,
    toolName: entry.toolName,
    summary: entry.summary,
    argsDigest: entry.argsDigest,
    reviewDigest: entry.reviewDigest,
    tenantId: entry.tenantId ?? null,
    requestedBy: entry.requestedBy ?? null,
    status,
    approved: status === 'approved',
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    ...(entry.terminalAt !== undefined ? { terminalAt: entry.terminalAt } : {}),
    ...(entry.purgeAfter !== undefined ? { purgeAfter: entry.purgeAfter } : {}),
    ...(entry.reconciliationEvidenceDigest ? { reconciliationEvidenceDigest: entry.reconciliationEvidenceDigest } : {}),
  };
}

function shouldPrune(entry, current) {
  const status = confirmationStatus(entry);
  if (ACTIVE_STATUSES.has(status)) return Number.isFinite(entry.expiresAt) && entry.expiresAt <= current;
  if (TERMINAL_STATUSES.has(status)) return Number.isFinite(entry.purgeAfter) && entry.purgeAfter <= current;
  // executing and reconciliation_required may correspond to a side effect and
  // are never deleted by retention or capacity pressure.
  return false;
}

function terminalEntry(entry, status, current, terminalRetentionMs, evidenceDigest) {
  const next = {
    ...entry,
    status,
    approved: false,
    reconciliationRequired: false,
    terminalAt: current,
    purgeAfter: current + terminalRetentionMs,
    ...(evidenceDigest ? { reconciliationEvidenceDigest: evidenceDigest.toLowerCase() } : {}),
  };
  delete next.args;
  return next;
}

function reconcileTransition(status, resolution) {
  if (ACTIVE_STATUSES.has(status) && resolution === 'rejected') return 'rejected';
  if (PROTECTED_STATUSES.has(status) && resolution === 'completed') return 'completed';
  if (PROTECTED_STATUSES.has(status) && resolution === 'failed') return 'failed';
  return null;
}

function canAccess(entry, principal) {
  if (!principal) return entry.tenantId == null;
  if (principal.roles?.includes('admin') || principal.scopes?.includes('*') || principal.scopes?.includes('confirmations:cross-tenant')) return true;
  return entry.tenantId != null && principal.tenantId === entry.tenantId;
}

/** Central registry of pending write confirmations (share one per gateway). */
export function createConfirmationCenter({
  ttlMs = DEFAULT_TTL_MS,
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  maxRecords = DEFAULT_MAX_RECORDS,
  stateStore,
  now = Date.now,
} = {}) {
  assertCenterOptions({ ttlMs, terminalRetentionMs, maxRecords });
  if (stateStore) return createPersistentConfirmationCenter({ ttlMs, terminalRetentionMs, maxRecords, stateStore, now });
  /** id -> { id, toolName, args, summary, approved, createdAt, expiresAt } */
  const entries = new Map();
  let revision = 0;

  function prunePage({ cursor = null, limit = 1_000, current = now() } = {}) {
    assertPage({ cursor, limit });
    const keys = [...entries.keys()].sort((a, b) => a.localeCompare(b)).filter((key) => cursor === null || key > cursor);
    const page = keys.slice(0, limit);
    let removed = 0;
    for (const id of page) {
      const entry = entries.get(id);
      if (entry && shouldPrune(entry, current)) {
        entries.delete(id);
        removed += 1;
      }
    }
    return { scanned: page.length, removed, nextCursor: keys.length > limit ? page.at(-1) : null };
  }

  function pruneAll(current = now()) {
    let cursor = null;
    let removed = 0;
    do {
      const page = prunePage({ cursor, current });
      removed += page.removed;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return removed;
  }

  function find(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (shouldPrune(entry, now())) {
      entries.delete(id);
      return null;
    }
    return entry;
  }

  function save(entry) {
    revision += 1;
    const value = { ...entry, revision };
    entries.set(entry.id, value);
    return value;
  }

  return {
    ttlMs,
    terminalRetentionMs,
    maxRecords,
    request({ toolName, args, summary, principal }) {
      pruneAll();
      if (entries.size >= maxRecords) throw capacityError(maxRecords);
      assertNoCredentialArgs(args);
      const id = randomUUID();
      const current = now();
      const reviewSummary = normalizeReviewSummary(summary);
      const entry = save({
        id,
        toolName,
        args: structuredClone(args),
        summary: reviewSummary,
        argsDigest: argsDigest(args),
        reviewDigest: sha256(reviewSummary),
        tenantId: principal?.tenantId ?? null,
        requestedBy: principal?.subjectId ?? null,
        status: 'pending',
        approved: false,
        createdAt: current,
        expiresAt: current + ttlMs,
      });
      return structuredClone(entry);
    },
    /** Human-only paths (HTTP endpoint / REPL command), never called by tools. */
    approve(id, { principal } = {}) {
      const e = find(id);
      if (!e) return { ok: false, error: 'unknown_or_expired' };
      if (!canAccess(e, principal)) return { ok: false, error: 'forbidden', statusCode: 403 };
      if (confirmationStatus(e) !== 'pending') return { ok: false, error: 'unknown_or_expired' };
      const approved = save({ ...e, status: 'approved', approved: true });
      return { ok: true, id, toolName: approved.toolName, summary: approved.summary };
    },
    reject(id, { principal } = {}) {
      const e = find(id);
      if (!e) return { ok: false, error: 'unknown_or_expired' };
      if (!canAccess(e, principal)) return { ok: false, error: 'forbidden', statusCode: 403 };
      if (!ACTIVE_STATUSES.has(confirmationStatus(e))) return { ok: false, error: 'unknown_or_expired' };
      save(terminalEntry(e, 'rejected', now(), terminalRetentionMs));
      return { ok: true };
    },
    /** Consume an APPROVED entry (single-use). Called by the wrapped tool. */
    take(id, { principal, toolName } = {}) {
      const e = find(id);
      if (!e) return { error: 'unknown_or_expired' };
      if (!canAccess(e, principal)) return { error: 'forbidden' };
      if (toolName && e.toolName !== toolName) return { error: 'tool_mismatch' };
      if (confirmationStatus(e) === 'pending') return { error: 'not_yet_approved' };
      if (confirmationStatus(e) !== 'approved') return { error: 'unknown_or_expired' };
      if (!digestIsValid(e.argsDigest)
          || !digestIsValid(e.reviewDigest)
          || argsDigest(e.args) !== e.argsDigest
          || sha256(e.summary) !== e.reviewDigest) {
        return { error: 'integrity_error' };
      }
      const returned = structuredClone(e);
      const executing = { ...e, status: 'executing', approved: false, executionStartedAt: now() };
      delete executing.args;
      save(executing);
      return { entry: returned };
    },
    settle(id, { outcome } = {}) {
      if (!['completed', 'unknown'].includes(outcome)) throw new Error('[confirm-gate] settle outcome must be completed or unknown');
      const entry = entries.get(id);
      if (!entry || confirmationStatus(entry) !== 'executing') return { settled: false, reason: 'not_executing' };
      if (outcome === 'unknown') {
        const saved = save({ ...entry, status: 'reconciliation_required', reconciliationRequired: true });
        return { settled: true, status: saved.status };
      }
      const saved = save(terminalEntry(entry, 'completed', now(), terminalRetentionMs));
      return { settled: true, status: saved.status };
    },
    list({ principal } = {}) {
      pruneAll();
      return [...entries.values()]
        .filter((entry) => ACTIVE_STATUSES.has(confirmationStatus(entry)) && canAccess(entry, principal))
        .map((entry) => publicMetadata(entry, entry.revision));
    },
    listMetadata({ principal, cursor = null, limit = 100 } = {}) {
      assertPage({ cursor, limit });
      pruneAll();
      const selected = [...entries.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((entry) => (cursor === null || entry.id > cursor) && canAccess(entry, principal));
      const page = selected.slice(0, limit);
      return {
        items: page.map((entry) => publicMetadata(entry, entry.revision)),
        nextCursor: selected.length > limit ? page.at(-1).id : null,
      };
    },
    capacity() {
      pruneAll();
      const counts = {};
      for (const entry of entries.values()) counts[confirmationStatus(entry)] = (counts[confirmationStatus(entry)] ?? 0) + 1;
      return { total: entries.size, maxRecords, available: Math.max(0, maxRecords - entries.size), statuses: counts };
    },
    reconcile(id, { principal, expectedRevision, expectedStatus, resolution, evidenceDigest } = {}) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || typeof expectedStatus !== 'string') {
        throw new Error('[confirm-gate] reconciliation requires expectedRevision and expectedStatus');
      }
      if (!digestIsValid(evidenceDigest)) throw new Error('[confirm-gate] reconciliation requires a SHA-256 evidenceDigest');
      const entry = entries.get(id);
      if (!entry) return { reconciled: false, reason: 'not_found' };
      if (!canAccess(entry, principal)) return { reconciled: false, reason: 'forbidden' };
      const status = confirmationStatus(entry);
      if (entry.revision !== expectedRevision || status !== expectedStatus) {
        return { reconciled: false, reason: 'conflict', status, revision: entry.revision };
      }
      const nextStatus = reconcileTransition(status, resolution);
      if (!nextStatus) return { reconciled: false, reason: 'invalid_transition', status, revision: entry.revision };
      const saved = save(terminalEntry(entry, nextStatus, now(), terminalRetentionMs, evidenceDigest));
      return { reconciled: true, record: publicMetadata(saved, saved.revision) };
    },
    prune(options = {}) {
      return prunePage(options);
    },
  };
}

function createPersistentConfirmationCenter({ ttlMs, terminalRetentionMs, maxRecords, stateStore, now }) {
  function prunePage(tx, { cursor = null, limit = 1_000, current = now() } = {}) {
    assertPage({ cursor, limit });
    const page = tx.list('confirmation', { cursor, limit });
    let removed = 0;
    for (const record of page.items) {
      if (shouldPrune(record.value, current)) {
        tx.delete('confirmation', record.key, { ifRevision: record.revision });
        removed += 1;
      }
    }
    return { scanned: page.items.length, removed, nextCursor: page.nextCursor };
  }

  function pruneAll(tx, current = now()) {
    let cursor = null;
    let removed = 0;
    do {
      const page = prunePage(tx, { cursor, current });
      removed += page.removed;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return removed;
  }

  function countAll(tx) {
    let cursor = null;
    let total = 0;
    const statuses = {};
    do {
      const page = tx.list('confirmation', { cursor, limit: 1_000 });
      for (const record of page.items) {
        const status = confirmationStatus(record.value);
        statuses[status] = (statuses[status] ?? 0) + 1;
        total += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { total, statuses };
  }

  function getLive(tx, id, current = now()) {
    const record = tx.get('confirmation', id);
    if (!record) return null;
    if (shouldPrune(record.value, current)) {
      tx.delete('confirmation', id, { ifRevision: record.revision });
      return null;
    }
    return record;
  }

  return {
    ttlMs,
    terminalRetentionMs,
    maxRecords,
    async request({ toolName, args, summary, principal }) {
      return stateStore.transaction(async (tx) => {
        const current = now();
        pruneAll(tx, current);
        if (countAll(tx).total >= maxRecords) throw capacityError(maxRecords);
        assertNoCredentialArgs(args);
        const id = randomUUID();
        const reviewSummary = normalizeReviewSummary(summary);
        const entry = {
          id,
          toolName,
          args,
          summary: reviewSummary,
          argsDigest: argsDigest(args),
          reviewDigest: sha256(reviewSummary),
          tenantId: principal?.tenantId ?? null,
          requestedBy: principal?.subjectId ?? null,
          status: 'pending',
          approved: false,
          createdAt: current,
          expiresAt: current + ttlMs,
        };
        tx.put('confirmation', id, entry, { ifRevision: null });
        return structuredClone(entry);
      });
    },
    async approve(id, { principal } = {}) {
      return stateStore.transaction(async (tx) => {
        const record = getLive(tx, id);
        if (!record) return { ok: false, error: 'unknown_or_expired' };
        if (!canAccess(record.value, principal)) return { ok: false, error: 'forbidden', statusCode: 403 };
        if (confirmationStatus(record.value) !== 'pending') return { ok: false, error: 'unknown_or_expired' };
        const entry = { ...record.value, status: 'approved', approved: true };
        tx.put('confirmation', id, entry, { ifRevision: record.revision });
        return { ok: true, id, toolName: entry.toolName, summary: entry.summary };
      });
    },
    async reject(id, { principal } = {}) {
      return stateStore.transaction(async (tx) => {
        const record = getLive(tx, id);
        if (!record) return { ok: false };
        if (!canAccess(record.value, principal)) return { ok: false, error: 'forbidden', statusCode: 403 };
        if (!ACTIVE_STATUSES.has(confirmationStatus(record.value))) return { ok: false, error: 'unknown_or_expired' };
        tx.put('confirmation', id, terminalEntry(record.value, 'rejected', now(), terminalRetentionMs), { ifRevision: record.revision });
        return { ok: true };
      });
    },
    async take(id, { principal, toolName } = {}) {
      return stateStore.transaction(async (tx) => {
        const record = getLive(tx, id);
        if (!record) return { error: 'unknown_or_expired' };
        if (!canAccess(record.value, principal)) return { error: 'forbidden' };
        if (toolName && record.value.toolName !== toolName) return { error: 'tool_mismatch' };
        const status = confirmationStatus(record.value);
        if (status === 'pending') return { error: 'not_yet_approved' };
        if (status !== 'approved') return { error: 'unknown_or_expired' };
        if (!digestIsValid(record.value.argsDigest)
            || !digestIsValid(record.value.reviewDigest)
            || argsDigest(record.value.args) !== record.value.argsDigest
            || sha256(record.value.summary) !== record.value.reviewDigest) {
          return { error: 'integrity_error' };
        }
        const returned = structuredClone(record.value);
        const executing = { ...record.value, status: 'executing', approved: false, executionStartedAt: now() };
        delete executing.args;
        tx.put('confirmation', id, executing, { ifRevision: record.revision });
        return { entry: returned };
      });
    },
    async settle(id, { outcome } = {}) {
      if (!['completed', 'unknown'].includes(outcome)) throw new Error('[confirm-gate] settle outcome must be completed or unknown');
      return stateStore.transaction(async (tx) => {
        const record = tx.get('confirmation', id);
        if (!record || confirmationStatus(record.value) !== 'executing') return { settled: false, reason: 'not_executing' };
        const entry = outcome === 'unknown'
          ? { ...record.value, status: 'reconciliation_required', reconciliationRequired: true }
          : terminalEntry(record.value, 'completed', now(), terminalRetentionMs);
        tx.put('confirmation', id, entry, { ifRevision: record.revision });
        return { settled: true, status: entry.status };
      });
    },
    async list({ principal } = {}) {
      return stateStore.transaction(async (tx) => {
        pruneAll(tx);
        const items = [];
        let cursor = null;
        do {
          const page = tx.list('confirmation', { cursor, limit: 1_000 });
          for (const record of page.items) {
            if (items.length >= 1_000) break;
            if (ACTIVE_STATUSES.has(confirmationStatus(record.value)) && canAccess(record.value, principal)) {
              items.push(publicMetadata(record.value, record.revision));
            }
          }
          cursor = items.length >= 1_000 ? null : page.nextCursor;
        } while (cursor !== null);
        return items;
      });
    },
    async listMetadata({ principal, cursor = null, limit = 100, statuses } = {}) {
      assertPage({ cursor, limit });
      if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some((status) => typeof status !== 'string'))) {
        throw new Error('[confirm-gate] statuses must be an array of strings');
      }
      const allowedStatuses = statuses ? new Set(statuses) : null;
      return stateStore.transaction(async (tx) => {
        const page = tx.list('confirmation', { cursor, limit });
        const current = now();
        const live = [];
        for (const record of page.items) {
          if (shouldPrune(record.value, current)) {
            tx.delete('confirmation', record.key, { ifRevision: record.revision });
          } else {
            live.push(record);
          }
        }
        return {
          items: live
            .filter((record) => canAccess(record.value, principal))
            .filter((record) => !allowedStatuses || allowedStatuses.has(confirmationStatus(record.value)))
            .map((record) => publicMetadata(record.value, record.revision)),
          nextCursor: page.nextCursor,
        };
      });
    },
    async capacity() {
      return stateStore.transaction(async (tx) => {
        pruneAll(tx);
        const { total, statuses } = countAll(tx);
        return { total, maxRecords, available: Math.max(0, maxRecords - total), statuses };
      });
    },
    async reconcile(id, { principal, expectedRevision, expectedStatus, resolution, evidenceDigest } = {}) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || typeof expectedStatus !== 'string') {
        throw new Error('[confirm-gate] reconciliation requires expectedRevision and expectedStatus');
      }
      if (!digestIsValid(evidenceDigest)) throw new Error('[confirm-gate] reconciliation requires a SHA-256 evidenceDigest');
      return stateStore.transaction(async (tx) => {
        const record = tx.get('confirmation', id);
        if (!record) return { reconciled: false, reason: 'not_found' };
        if (!canAccess(record.value, principal)) return { reconciled: false, reason: 'forbidden' };
        const status = confirmationStatus(record.value);
        if (record.revision !== expectedRevision || status !== expectedStatus) {
          return { reconciled: false, reason: 'conflict', status, revision: record.revision };
        }
        const nextStatus = reconcileTransition(status, resolution);
        if (!nextStatus) return { reconciled: false, reason: 'invalid_transition', status, revision: record.revision };
        const entry = terminalEntry(record.value, nextStatus, now(), terminalRetentionMs, evidenceDigest);
        const saved = tx.put('confirmation', id, entry, { ifRevision: record.revision });
        return { reconciled: true, record: publicMetadata(saved.value, saved.revision) };
      });
    },
    async prune({ cursor = null, limit = 1_000 } = {}) {
      assertPage({ cursor, limit });
      return stateStore.transaction(async (tx) => prunePage(tx, { cursor, limit }));
    },
  };
}

/**
 * Wrap a write tool so it can only execute through the confirmation center.
 * @param {object} tool - a defineTool() result whose handler performs the write
 * @param {{ center: object, summarize?: (args: object) => string }} opts
 */
export function wrapWriteTool(tool, { center, summarize } = {}) {
  if (!center) throw new Error(`[confirm-gate] wrapWriteTool(${tool?.name}) requires a confirmation center`);
  const reviewableProperties = Object.keys(tool?.params?.properties ?? {});
  if (reviewableProperties.length > 0 && typeof summarize !== 'function') {
    throw new Error(`[confirm-gate] wrapWriteTool(${tool?.name}) requires an explicit redacted review summary`);
  }

  const properties = {
    ...(tool.params?.properties ?? {}),
    confirmationId: {
      type: 'string',
      description:
        'Leave empty on the first call (send the real write params instead). After a human operator approves the returned confirmationId, call again with ONLY this id to execute.',
    },
  };

  return {
    ...tool,
    humanApprovalRequired: true,
    description:
      `${tool.description} WRITE OPERATION - requires HUMAN approval out of band: ` +
      'first call returns a confirmationId; a human operator must approve it ' +
      '(POST /confirmations/:id/approve or REPL /approve) before a second call with the id executes.',
    // required is intentionally empty: the second phase sends confirmationId only.
    // First-phase calls are validated against the ORIGINAL schema inside the handler.
    params: { properties, required: [] },
    async handler(args = {}, context = {}) {
      const { confirmationId, ...rest } = args;

      if (confirmationId) {
        const { entry, error } = await center.take(confirmationId, { principal: context.principal, toolName: tool.name });
        if (error === 'not_yet_approved') {
          return {
            error,
            hint: 'A human operator has not approved this action yet. Ask the operator to review GET /confirmations and approve, then retry with the same confirmationId.',
          };
        }
        if (error) {
          return {
            error,
            hint: `Confirmation ids are single-use and expire after ${Math.round(center.ttlMs / 1000)}s. Call ${tool.name} again with the write params to request a new one.`,
          };
        }
        let result;
        try {
          result = await tool.handler(entry.args, context);
        } catch {
          try {
            await center.settle?.(confirmationId, { outcome: 'unknown' });
          } catch {
            // The durable `executing` record remains protected from pruning;
            // the caller must still treat the side effect as unknown.
          }
          throw Object.assign(new Error('[confirm-gate] write outcome requires reconciliation'), {
            code: 'CONFIRMATION_EXECUTION_UNKNOWN',
            retryable: false,
            unknownOutcome: true,
            reconciliationRequired: true,
          });
        }
        try {
          const settled = await center.settle?.(confirmationId, { outcome: 'completed' });
          if (settled && settled.settled === false) {
            throw new Error('confirmation execution state changed before settlement');
          }
        } catch {
          throw Object.assign(new Error('[confirm-gate] write committed but confirmation settlement is unknown'), {
            code: 'CONFIRMATION_SETTLEMENT_UNKNOWN',
            retryable: false,
            unknownOutcome: true,
            reconciliationRequired: true,
          });
        }
        return result;
      }

      // First phase: enforce the original schema here (the wrapped schema's
      // required list is empty so that phase-2 id-only calls pass validation).
      const { ok, errors } = validateArgs(tool, rest);
      if (!ok) return { error: 'invalid_arguments', detail: errors.join('; ') };

      const entry = await center.request({
        toolName: tool.name,
        args: rest,
        // Parameterized writes require an explicit allowlisted projection so
        // an operator never approves a blind action and raw args remain out of
        // management listings. Digests bind the projection to stored args.
        summary: summarize ? summarize(rest) : `Execute ${tool.name} (no arguments)`,
        principal: context.principal,
      });
      return {
        pendingConfirmation: true,
        confirmationId: entry.id,
        summary: entry.summary,
        argsDigest: entry.argsDigest,
        reviewDigest: entry.reviewDigest,
        humanApproval: 'required',
        expiresInSeconds: Math.round(center.ttlMs / 1000),
        hint: 'Tell the user this action is pending human approval. A human operator must approve it out of band before it can execute.',
      };
    },
  };
}
