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
import { randomUUID } from 'node:crypto';
import { validateArgs } from '../runtime/tool.js';

const DEFAULT_TTL_MS = 15 * 60_000;

/** Central registry of pending write confirmations (share one per gateway). */
export function createConfirmationCenter({ ttlMs = DEFAULT_TTL_MS } = {}) {
  /** id -> { id, toolName, args, summary, approved, createdAt, expiresAt } */
  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [id, e] of entries) {
      if (e.expiresAt <= now) entries.delete(id);
    }
  }

  return {
    ttlMs,
    request({ toolName, args, summary }) {
      prune();
      const id = randomUUID();
      const entry = {
        id,
        toolName,
        args,
        summary,
        approved: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      entries.set(id, entry);
      return entry;
    },
    /** Human-only paths (HTTP endpoint / REPL command), never called by tools. */
    approve(id) {
      prune();
      const e = entries.get(id);
      if (!e) return { ok: false, error: 'unknown_or_expired' };
      e.approved = true;
      return { ok: true, id, toolName: e.toolName, summary: e.summary };
    },
    reject(id) {
      prune();
      return { ok: entries.delete(id) };
    },
    /** Consume an APPROVED entry (single-use). Called by the wrapped tool. */
    take(id) {
      prune();
      const e = entries.get(id);
      if (!e) return { error: 'unknown_or_expired' };
      if (!e.approved) return { error: 'not_yet_approved' };
      entries.delete(id);
      return { entry: e };
    },
    list() {
      prune();
      return [...entries.values()].map(({ args, ...pub }) => ({
        ...pub,
        args, // operators need to see exactly what would be executed
      }));
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
    description:
      `${tool.description} WRITE OPERATION - requires HUMAN approval out of band: ` +
      'first call returns a confirmationId; a human operator must approve it ' +
      '(POST /confirmations/:id/approve or REPL /approve) before a second call with the id executes.',
    // required is intentionally empty: the second phase sends confirmationId only.
    // First-phase calls are validated against the ORIGINAL schema inside the handler.
    params: { properties, required: [] },
    async handler(args = {}) {
      const { confirmationId, ...rest } = args;

      if (confirmationId) {
        const { entry, error } = center.take(confirmationId);
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
        return tool.handler(entry.args);
      }

      // First phase: enforce the original schema here (the wrapped schema's
      // required list is empty so that phase-2 id-only calls pass validation).
      const { ok, errors } = validateArgs(tool, rest);
      if (!ok) return { error: 'invalid_arguments', detail: errors.join('; ') };

      const entry = center.request({
        toolName: tool.name,
        args: rest,
        summary: summarize ? summarize(rest) : `Execute ${tool.name} with ${JSON.stringify(rest)}`,
      });
      return {
        pendingConfirmation: true,
        confirmationId: entry.id,
        summary: entry.summary,
        humanApproval: 'required',
        expiresInSeconds: Math.round(center.ttlMs / 1000),
        hint: 'Tell the user this action is pending human approval. A human operator must approve it out of band before it can execute.',
      };
    },
  };
}
