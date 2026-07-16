/**
 * HTTP channel on node:http (zero dependencies).
 * Endpoints:
 *   GET  /health          - liveness, NO auth
 *   POST /chat            - {sessionId, message} -> {sessionId, reply, costUsd}
 *   POST /chat/stream     - SSE variant; JSON body {sessionId, message}
 *   GET  /status          - sessions / monthly cost / budget (real cost-tracker data)
 *   GET  /confirmations   - pending write confirmations awaiting a human
 *   POST /confirmations/:id/approve | /reject - human out-of-band approval
 *   POST /webhook/reconciliation - inspect/reconcile replay evidence (operator)
 *   GET|POST /idempotency/reconciliations - inspect/reconcile execution evidence
 *   POST /jobs/:name/run  - manually trigger a registered patrol job
 *   POST /webhook         - inbound webhook (only when WEBHOOK_SECRET is set;
 *                           authenticated by HMAC signature instead of Bearer)
 * Everything except /health and /webhook requires Authorization: Bearer <GATEWAY_AUTH_TOKEN>.
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthenticator, createDashboardSessionManager, createQuotaManager, createRouteAuthorizer, hasScope } from '../auth/index.js';

const MAX_BODY_BYTES = 1_000_000;
const API_RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store, max-age=0',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
});

function telemetryRoute(method, pathname) {
  const exact = new Set([
    '/health', '/chat', '/chat/stream', '/status', '/confirmations', '/webhook',
    '/webhook/reconciliation', '/idempotency/reconciliations', '/dashboard/login',
    '/dashboard/logout', '/dashboard',
  ]);
  if (exact.has(pathname)) return `${method} ${pathname}`;
  if (/^\/confirmations\/[^/]+\/(approve|reject)$/.test(pathname)) return `${method} /confirmations/:id/:action`;
  if (/^\/jobs\/[^/]+\/run$/.test(pathname)) return `${method} /jobs/:name/run`;
  if (/^\/idempotency\/reconciliations\/[0-9a-f]{64}$/.test(pathname)) return `${method} /idempotency/reconciliations/:id`;
  if (pathname.startsWith('/dashboard/') || pathname.startsWith('/api/dashboard/')) return `${method} /dashboard/:resource`;
  return `${method} <unknown-route>`;
}

function requestIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    const error = new Error('Idempotency-Key must contain 1-128 safe identifier characters');
    error.code = 'IDEMPOTENCY_KEY_INVALID';
    error.statusCode = 400;
    error.unknownOutcome = false;
    throw error;
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function deriveTrustedSessionId(principal, sessionId) {
  // A tenant is an authorization boundary, not a conversation identity. Two
  // users in the same tenant must not collide on a guessable client session id.
  const scope = ['tenant', principal?.tenantId ?? null, 'subject', principal?.subjectId ?? 'anonymous'];
  const digest = createHash('sha256').update(JSON.stringify([...scope, String(sessionId)])).digest('hex');
  return `http:${digest}`;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...API_RESPONSE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

const DASHBOARD_LOGIN_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function sendDashboardLogin(res, status = 200, message = '') {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard sign in</title></head><body><main><h1>Business Agent Dashboard</h1><p>Use an operator, admin, or auditor credential. The credential is exchanged for a short-lived HttpOnly session and is never placed in the URL.</p>${message ? `<p role="alert">${message}</p>` : ''}<form method="post" action="/dashboard/login"><label>Bearer credential <input name="credential" type="password" required maxlength="512" autocomplete="current-password"></label><button type="submit">Sign in</button></form></main></body></html>`;
  res.writeHead(status, { ...DASHBOARD_LOGIN_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function redirectDashboard(res, location, cookie) {
  res.writeHead(303, { ...DASHBOARD_LOGIN_HEADERS, location, ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
}

function dashboardPrincipalAllowed(principal) {
  const roleAllowed = principal?.roles?.some((role) => ['operator', 'admin', 'auditor'].includes(role));
  return roleAllowed && (hasScope(principal, 'dashboard:view') || hasScope(principal, 'dashboard:read'));
}

function isDashboardNamespace(pathname) {
  return pathname === '/dashboard' || pathname.startsWith('/dashboard/') || pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/');
}

function combineAbortSignals(primary, secondary) {
  if (!secondary) return primary;
  if (!primary) return secondary;
  return AbortSignal.any([primary, secondary]);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}

function requireGlobalAccess(principal, scope) {
  if (principal?.tenantId == null || hasScope(principal, scope)) return;
  const error = new Error('This operation exposes gateway-wide state and requires a platform principal');
  error.code = 'CROSS_TENANT_OPERATION_FORBIDDEN';
  error.statusCode = 403;
  throw error;
}

function requireExplicitScope(principal, scope) {
  if (principal?.scopes?.includes(scope) || principal?.scopes?.includes('*')) return;
  const error = new Error(`Explicit scope is required: ${scope}`);
  error.code = 'FORBIDDEN';
  error.statusCode = 403;
  throw error;
}

function webhookEventId(value) {
  const eventId = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(eventId) ? eventId : null;
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Reject with 413 but keep the socket usable: stop buffering, drain the
        // rest, and let the route handler answer with a proper JSON error
        // (destroying the socket here would surface as a TCP reset client-side).
        const err = new Error(`body too large (max ${MAX_BODY_BYTES} bytes)`);
        err.statusCode = 413;
        reject(err);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!res.headersSent) res.removeHeader('connection');
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Push a reply through SSE in small chunks, then a done event.
 *  (Pseudo-streaming: the reply is computed first. To stream true model deltas,
 *  extend the provider with the Messages API `stream: true` mode.) */
function writeSse(res, reply, costUsd) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'private, no-store, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  const words = String(reply).split(/(\s+)/);
  const chunkSize = 8;
  for (let i = 0; i < words.length; i += chunkSize) {
    const delta = words.slice(i, i + chunkSize).join('');
    if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
  }
  res.write(`event: done\ndata: ${JSON.stringify({ costUsd })}\n\n`);
  res.end();
}

export function createHttpServer({
  config,
  handleMessage,
  scheduler,
  costTracker,
  sessionStore,
  webhookHandler,
  webhookReplayStore,
  webhookIntegrationId,
  idempotency,
  confirmations,
  authenticator,
  routeAuthorizer,
  quotaManager,
  telemetry,
  audit,
  dashboardHandler,
  dashboardSessions,
  stateStore,
}) {
  const startedAt = Date.now();
  const activeAuthenticator = authenticator ?? createAuthenticator({
    principals: config.authPrincipals ?? [],
    legacyAdminToken: config.gatewayAuthToken,
  });
  const activeAuthorizer = routeAuthorizer ?? createRouteAuthorizer({
    'POST /chat': { roles: ['caller', 'operator', 'admin'], scopes: ['chat:write'] },
    'POST /chat/stream': { roles: ['caller', 'operator', 'admin'], scopes: ['chat:write'] },
    'GET /status': { roles: ['operator', 'admin', 'auditor'], scopes: ['status:read'] },
    'GET /confirmations': { roles: ['operator', 'admin'], scopes: ['confirmations:read'] },
    'POST /confirmations': { roles: ['operator', 'admin'], scopes: ['confirmations:write'] },
    'POST /jobs/run': { roles: ['operator', 'admin'], scopes: ['jobs:run'] },
    'POST /webhook/reconciliation': { roles: ['operator', 'admin'], scopes: ['webhooks:reconcile'] },
    'GET /idempotency/reconciliations': { roles: ['operator', 'admin'], scopes: ['idempotency:reconcile'] },
    'POST /idempotency/reconciliations': { roles: ['operator', 'admin'], scopes: ['idempotency:reconcile'] },
  });
  const activeQuota = quotaManager ?? createQuotaManager({ ...config.quota, stateStore });
  const activeDashboardSessions = dashboardSessions ?? createDashboardSessionManager({ stateStore });
  const secureDashboardCookie = config.runtimeProfile === 'production';
  async function recordAudit(event) {
    try { await audit?.append?.(event); }
    catch (error) {
      console.error(`[audit] http event append failed code=${error.code ?? error.name ?? 'ERROR'}`);
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

  async function runChat({ route, principal, sessionId, message, signal, requestId, operationId, traceContext, idempotencyKey }) {
    const trustedSessionId = deriveTrustedSessionId(principal, sessionId);
    const invoke = async (effectiveOperationId) => {
      const release = await activeQuota.enter(principal);
      const executionSignal = combineAbortSignals(signal, release.signal);
      try {
        throwIfAborted(executionSignal);
        const result = await handleMessage(trustedSessionId, message, {
          principal,
          signal: executionSignal,
          requestId,
          operationId: effectiveOperationId,
          telemetryContext: traceContext,
        });
        throwIfAborted(executionSignal);
        return { sessionId, reply: result.text, costUsd: result.costUsd ?? 0 };
      } catch (rawError) {
        // Once the agent/provider/tool loop has started, a generic transport
        // failure cannot prove that spend or a write did not happen.
        if (rawError?.unknownOutcome !== false) {
          const error = rawError instanceof Error ? rawError : new Error('chat execution failed');
          error.code ??= 'CHAT_OUTCOME_UNKNOWN';
          error.unknownOutcome = true;
          error.reconciliationRequired = true;
          throw error;
        }
        throw rawError;
      } finally {
        try {
          await release();
        } catch (rawReleaseError) {
          const releaseError = rawReleaseError instanceof Error
            ? rawReleaseError
            : new Error('chat quota release failed');
          releaseError.code ??= 'CHAT_QUOTA_RELEASE_UNKNOWN';
          releaseError.unknownOutcome = true;
          releaseError.reconciliationRequired = true;
          throw releaseError;
        }
      }
    };

    if (!idempotencyKey) return { response: await invoke(operationId), deduplicated: false, idempotencyApplied: false };
    if (!idempotency) {
      const error = new Error('HTTP idempotency is unavailable');
      error.code = 'IDEMPOTENCY_UNAVAILABLE';
      error.statusCode = 503;
      error.unknownOutcome = false;
      throw error;
    }
    const binding = ['http-chat-v1', route, principal?.tenantId ?? null, principal?.subjectId ?? null, idempotencyKey];
    const key = JSON.stringify(binding);
    const requestDigest = sha256Json({ sessionId, message });
    const stableOperationId = `http:${sha256Json(binding)}`;
    const outcome = await idempotency.run(key, async () => ({
      requestDigest,
      response: await invoke(stableOperationId),
    }), {
      // Full response data is retained only for the store's bounded response
      // window (five minutes by default), after which a permanent metadata
      // tombstone blocks replay and requires reconciliation.
      persistResult: true,
    });
    if (outcome.value?.requestDigest !== requestDigest) {
      const error = new Error('Idempotency-Key was already bound to a different chat request');
      error.code = 'IDEMPOTENCY_REQUEST_CONFLICT';
      error.statusCode = 409;
      error.unknownOutcome = false;
      throw error;
    }
    return { response: outcome.value.response, deduplicated: outcome.deduplicated, idempotencyApplied: true };
  }

  async function runManualJob({ principal, name, idempotencyKey }) {
    if (!idempotencyKey) {
      const error = new Error('Idempotency-Key is required for manual job execution');
      error.code = 'IDEMPOTENCY_KEY_REQUIRED';
      error.statusCode = 428;
      error.unknownOutcome = false;
      throw error;
    }
    if (!idempotency) {
      const error = new Error('HTTP idempotency is unavailable');
      error.code = 'IDEMPOTENCY_UNAVAILABLE';
      error.statusCode = 503;
      error.unknownOutcome = false;
      throw error;
    }
    // The operation key deliberately excludes the job name. Reusing one
    // client key for a different manual action is therefore a 409 conflict,
    // not a new side effect.
    const binding = ['http-job-v1', principal?.tenantId ?? null, principal?.subjectId ?? null, idempotencyKey];
    const key = JSON.stringify(binding);
    const requestDigest = sha256Json({ name });
    const stableRunId = `manual:http:${sha256Json(binding)}`;
    const outcome = await idempotency.run(key, async () => {
      let result;
      try {
        result = await scheduler.runNow(name, { runId: stableRunId });
      } catch (rawError) {
        const error = rawError instanceof Error ? rawError : new Error('manual job execution failed');
        if (rawError?.unknownOutcome !== false) {
          error.code ??= 'JOB_OUTCOME_UNKNOWN';
          error.unknownOutcome = true;
          error.reconciliationRequired = true;
        }
        throw error;
      }
      if (result === null) {
        const error = new Error(`unknown job "${name}"`);
        error.code = 'JOB_NOT_FOUND';
        error.statusCode = 404;
        error.unknownOutcome = false;
        throw error;
      }
      return { requestDigest, response: { job: name, ...result } };
    }, { persistResult: true });
    if (outcome.value?.requestDigest !== requestDigest) {
      const error = new Error('Idempotency-Key was already bound to a different manual job request');
      error.code = 'IDEMPOTENCY_REQUEST_CONFLICT';
      error.statusCode = 409;
      error.unknownOutcome = false;
      throw error;
    }
    return { response: outcome.value.response, deduplicated: outcome.deduplicated };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const safeRoute = telemetryRoute(req.method, url.pathname);
    // A caller-supplied correlation value can itself contain business data.
    // Generate the identifier that enters telemetry/audit and return it to the
    // caller instead of trusting x-request-id as an observability attribute.
    const requestId = randomUUID();
    const operationId = randomUUID();
    res.setHeader('x-request-id', requestId);
    const declaredBody = req.headers['transfer-encoding'] !== undefined
      || (Number(req.headers['content-length']) || 0) > 0;
    if (declaredBody) {
      res.setHeader('connection', 'close');
      res.once('finish', () => {
        if (!req.readableEnded) req.destroy();
      });
    }
    const abortController = new AbortController();
    req.once('aborted', () => abortController.abort(new DOMException('Client aborted request', 'AbortError')));
    res.once('close', () => {
      if (!res.writableEnded) abortController.abort(new DOMException('Client disconnected', 'AbortError'));
    });
    const span = telemetry?.startSpan?.('http.request', { attributes: { requestId, operation: safeRoute } });
    res.once('finish', () => span?.end?.({ outcome: res.statusCode >= 500 ? 'error' : 'ok', attributes: { statusCode: res.statusCode } }));

    try {
      if (route === 'GET /dashboard/login') {
        if (!dashboardHandler) return sendJson(res, 404, { error: 'dashboard disabled' });
        if (await activeDashboardSessions.authenticateCookie(req.headers.cookie)) return redirectDashboard(res, '/dashboard');
        return sendDashboardLogin(res);
      }

      if (route === 'POST /dashboard/login') {
        if (!dashboardHandler) return sendJson(res, 404, { error: 'dashboard disabled' });
        const attemptKey = req.socket.remoteAddress ?? 'unknown';
        if (!await activeDashboardSessions.allowLoginAttempt(attemptKey)) return sendDashboardLogin(res, 429, 'Too many sign-in attempts. Try again later.');
        let raw;
        try { raw = await readBody(req, res); } catch (error) { return sendDashboardLogin(res, error.statusCode ?? 400, 'Sign-in request rejected.'); }
        const form = new URLSearchParams(raw);
        const credential = form.get('credential');
        const loginPrincipal = typeof credential === 'string' && credential.length <= 512
          ? activeAuthenticator.authenticateHeader(`Bearer ${credential}`)
          : null;
        if (!loginPrincipal || !dashboardPrincipalAllowed(loginPrincipal)) {
          await recordAudit({ action: 'dashboard.login', resource: 'dashboard', outcome: 'denied' });
          return sendDashboardLogin(res, 401, 'Sign-in failed.');
        }
        await startAudit({ actor: loginPrincipal.subjectId, tenant: loginPrincipal.tenantId, action: 'dashboard.login', resource: 'dashboard' });
        const session = await activeDashboardSessions.create(loginPrincipal);
        await recordAudit({ actor: loginPrincipal.subjectId, tenant: loginPrincipal.tenantId, action: 'dashboard.login', resource: 'dashboard', outcome: 'ok' });
        return redirectDashboard(res, '/dashboard', activeDashboardSessions.setCookie(session, { secure: secureDashboardCookie }));
      }

      if (route === 'POST /dashboard/logout') {
        const logoutPrincipal = await activeDashboardSessions.authenticateCookie(req.headers.cookie);
        if (logoutPrincipal) {
          await startAudit({
            actor: logoutPrincipal.subjectId,
            tenant: logoutPrincipal.tenantId,
            action: 'dashboard.logout',
            resource: 'dashboard',
          });
          await activeDashboardSessions.revokeCookie(req.headers.cookie);
        }
        return redirectDashboard(res, '/dashboard/login', activeDashboardSessions.clearCookie({ secure: secureDashboardCookie }));
      }

      if (route === 'GET /health') {
        return sendJson(res, 200, {
          status: 'ok',
          provider: config.provider,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      }

      // Inbound webhook authenticates via HMAC body signature, not Bearer.
      if (route === 'POST /webhook') {
        if (!webhookHandler) return sendJson(res, 404, { error: 'webhook channel not enabled (set WEBHOOK_SECRET)' });
        let raw;
        try {
          raw = await readBody(req, res);
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { error: err.statusCode ? 'request rejected' : 'internal error' });
        }
        const { status, body } = await webhookHandler(raw, req.headers, {
          signal: abortController.signal,
          requestId,
          operationId,
          telemetryContext: span ? { traceId: span.traceId, parentSpanId: span.spanId } : undefined,
        });
        return sendJson(res, status, body);
      }

      const bearerPrincipal = activeAuthenticator.authenticateHeader(req.headers.authorization);
      const principal = bearerPrincipal
        ?? (isDashboardNamespace(url.pathname) ? await activeDashboardSessions.authenticateCookie(req.headers.cookie) : null);
      if (!principal) {
        return sendJson(res, 401, { error: 'unauthorized', hint: 'send a configured Bearer credential' });
      }

      if (route === 'POST /webhook/reconciliation') {
        activeAuthorizer.authorize(principal, route);
        // This recovery surface can reopen a side effect. Even an admin role
        // must carry the explicit scope (or an explicit wildcard credential).
        requireExplicitScope(principal, 'webhooks:reconcile');
        requireGlobalAccess(principal, 'webhooks:cross-tenant');
        if (!webhookReplayStore || !webhookIntegrationId) {
          return sendJson(res, 404, { error: 'webhook replay reconciliation is not enabled' });
        }
        let raw;
        try {
          raw = await readBody(req, res);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? 'request rejected' : 'internal error' });
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'body must be a JSON reconciliation command' });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return sendJson(res, 400, { error: 'reconciliation command must be a JSON object' });
        }
        const action = payload.action;
        if (action === 'compact') {
          const limit = payload.limit ?? 1_000;
          if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
            return sendJson(res, 400, { error: 'limit must be an integer between 1 and 1000' });
          }
          await startAudit({
            actor: principal.subjectId,
            tenant: principal.tenantId,
            action: 'webhook.reconciliation.compact',
            resource: 'webhook-replay-ledger',
          });
          const outcome = await webhookReplayStore.compact({ limit });
          const capacity = await webhookReplayStore.capacity();
          await recordAudit({
            actor: principal.subjectId,
            tenant: principal.tenantId,
            action: 'webhook.reconciliation.compact',
            resource: 'webhook-replay-ledger',
            outcome: 'ok',
            metadata: { removed: outcome.removed },
          });
          return sendJson(res, 200, { action, ...outcome, capacity });
        }

        const eventId = webhookEventId(payload.eventId);
        if (!eventId) {
          return sendJson(res, 400, { error: 'eventId must be a 1-128 character trusted event identifier' });
        }
        const eventIdHash = createHash('sha256').update(eventId).digest('hex');
        if (action === 'inspect') {
          const record = await webhookReplayStore.inspect({ integrationId: webhookIntegrationId, eventId });
          await recordAudit({
            actor: principal.subjectId,
            tenant: principal.tenantId,
            action: 'webhook.reconciliation.inspect',
            resource: 'webhook-replay-ledger',
            outcome: record ? 'ok' : 'not-found',
            metadata: { eventIdHash },
          });
          if (!record) return sendJson(res, 404, { error: 'webhook replay record not found' });
          // Do not echo the raw event id or expose any full webhook response.
          return sendJson(res, 200, { eventIdHash, record });
        }
        if (!['retry', 'forget', 'mark-committed'].includes(action)) {
          return sendJson(res, 400, { error: 'action must be inspect, retry, forget, mark-committed, or compact' });
        }
        if (!isSha256(payload.expectedPayloadHash)) {
          return sendJson(res, 400, { error: 'expectedPayloadHash must be a lowercase SHA-256 digest' });
        }
        if (!['committed', 'unknown', 'failed'].includes(payload.expectedStatus)) {
          return sendJson(res, 400, { error: 'expectedStatus must be committed, unknown, or failed' });
        }
        if (action === 'mark-committed' && !isSha256(payload.evidenceDigest)) {
          return sendJson(res, 400, { error: 'evidenceDigest must be a lowercase SHA-256 digest' });
        }
        await startAudit({
          actor: principal.subjectId,
          tenant: principal.tenantId,
          action: `webhook.reconciliation.${action}`,
          resource: 'webhook-replay-ledger',
          metadata: { eventIdHash },
        });
        const outcome = await webhookReplayStore.reconcile({
          integrationId: webhookIntegrationId,
          eventId,
          action,
          expectedPayloadHash: payload.expectedPayloadHash,
          expectedStatus: payload.expectedStatus,
          acknowledgement: payload.acknowledgement,
          ...(payload.evidenceDigest ? { evidenceDigest: payload.evidenceDigest } : {}),
        });
        await recordAudit({
          actor: principal.subjectId,
          tenant: principal.tenantId,
          action: `webhook.reconciliation.${action}`,
          resource: 'webhook-replay-ledger',
          outcome: outcome.ok ? 'ok' : 'denied',
          metadata: { eventIdHash, ...(outcome.code ? { code: outcome.code } : {}) },
        });
        if (!outcome.ok) return sendJson(res, outcome.statusCode ?? 409, { error: outcome.code });
        return sendJson(res, 200, { eventIdHash, ...outcome });
      }

      if (route === 'GET /idempotency/reconciliations') {
        activeAuthorizer.authorize(principal, route);
        requireExplicitScope(principal, 'idempotency:reconcile');
        requireGlobalAccess(principal, 'idempotency:cross-tenant');
        if (!idempotency) return sendJson(res, 404, { error: 'idempotency reconciliation is not enabled' });
        const allowed = new Set(['cursor', 'limit']);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
            || [...allowed].some((key) => url.searchParams.getAll(key).length > 1)) {
          return sendJson(res, 400, { error: 'only one cursor and one limit parameter are allowed' });
        }
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && !isSha256(cursor)) {
          return sendJson(res, 400, { error: 'cursor must be a lowercase SHA-256 digest' });
        }
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          return sendJson(res, 400, { error: 'limit must be an integer between 1 and 1000' });
        }
        const page = await idempotency.list({ cursor, limit });
        const capacity = await idempotency.capacity();
        return sendJson(res, 200, { ...page, capacity });
      }

      const idempotencyMatch = req.method === 'POST'
        && url.pathname.match(/^\/idempotency\/reconciliations\/([0-9a-f]{64})$/);
      if (idempotencyMatch) {
        activeAuthorizer.authorize(principal, 'POST /idempotency/reconciliations');
        requireExplicitScope(principal, 'idempotency:reconcile');
        requireGlobalAccess(principal, 'idempotency:cross-tenant');
        if (!idempotency) return sendJson(res, 404, { error: 'idempotency reconciliation is not enabled' });
        let raw;
        try {
          raw = await readBody(req, res);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? 'request rejected' : 'internal error' });
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'body must be a JSON reconciliation command' });
        }
        const allowed = new Set(['resolution', 'expectedStatus', 'expectedResultDigest', 'expectedErrorCode', 'reason']);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).some((key) => !allowed.has(key))) {
          return sendJson(res, 400, { error: 'reconciliation command has an invalid shape' });
        }
        const { resolution, expectedStatus, expectedResultDigest, expectedErrorCode } = payload;
        const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
        if (!['retry', 'forget', 'compact'].includes(resolution)
            || !['committed', 'unknown'].includes(expectedStatus)
            || reason.length < 1 || reason.length > 500) {
          return sendJson(res, 400, { error: 'resolution, expectedStatus, and a 1-500 character reason are required' });
        }
        if (expectedStatus === 'committed' && !isSha256(expectedResultDigest)) {
          return sendJson(res, 400, { error: 'committed evidence requires expectedResultDigest' });
        }
        if (expectedStatus === 'unknown'
            && (typeof expectedErrorCode !== 'string' || !/^[A-Z0-9_:-]{1,128}$/.test(expectedErrorCode))) {
          return sendJson(res, 400, { error: 'unknown evidence requires expectedErrorCode' });
        }
        const id = idempotencyMatch[1];
        await startAudit({
          actor: principal.subjectId,
          tenant: principal.tenantId,
          action: `idempotency.reconciliation.${resolution}`,
          resource: 'execution-idempotency-ledger',
          metadata: { id },
        });
        const changed = await idempotency.reconcileById(id, {
          resolution,
          expectedStatus,
          ...(expectedStatus === 'committed' ? { expectedResultDigest } : { expectedErrorCode }),
        });
        await recordAudit({
          actor: principal.subjectId,
          tenant: principal.tenantId,
          action: `idempotency.reconciliation.${resolution}`,
          resource: 'execution-idempotency-ledger',
          outcome: 'ok',
          metadata: {
            id,
            expectedStatus,
            reasonDigest: createHash('sha256').update(reason).digest('hex'),
          },
        });
        return sendJson(res, 200, { id, resolution, changed: Boolean(changed) });
      }

      if (route === 'POST /chat') {
        activeAuthorizer.authorize(principal, route);
        const idempotencyKey = requestIdempotencyKey(req.headers['idempotency-key']);
        let raw;
        try {
          raw = await readBody(req, res);
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { error: err.statusCode ? 'request rejected' : 'internal error' });
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'body must be JSON: {"sessionId": "...", "message": "..."}' });
        }
        const { sessionId, message } = payload ?? {};
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).some((key) => !['sessionId', 'message'].includes(key))
            || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || typeof message !== 'string' || !message || message.length > 100_000) {
          return sendJson(res, 400, { error: 'sessionId (1-256 chars) and message (1-100000 chars) are required strings' });
        }
        const outcome = await runChat({
          route,
          principal,
          sessionId,
          message,
          signal: abortController.signal,
          requestId,
          operationId,
          traceContext: span ? { traceId: span.traceId, parentSpanId: span.spanId } : undefined,
          idempotencyKey,
        });
        if (outcome.idempotencyApplied) res.setHeader('idempotency-status', outcome.deduplicated ? 'replayed' : 'created');
        return sendJson(res, 200, outcome.response);
      }

      if (route === 'GET /chat/stream') {
        return sendJson(res, 405, {
          error: 'GET /chat/stream is disabled because URL query strings can retain sensitive chat data',
          hint: 'use POST /chat/stream with JSON body: {"sessionId":"...","message":"..."}',
        });
      }

      if (route === 'POST /chat/stream') {
        activeAuthorizer.authorize(principal, route);
        const idempotencyKey = requestIdempotencyKey(req.headers['idempotency-key']);
        let raw;
        try {
          raw = await readBody(req, res);
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { error: err.statusCode ? 'request rejected' : 'internal error' });
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'body must be JSON: {"sessionId": "...", "message": "..."}' });
        }
        const { sessionId, message } = payload ?? {};
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).some((key) => !['sessionId', 'message'].includes(key))
            || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || typeof message !== 'string' || !message || message.length > 100_000) {
          return sendJson(res, 400, { error: 'sessionId (1-256 chars) and message (1-100000 chars) are required strings' });
        }
        const outcome = await runChat({
          route,
          principal,
          sessionId,
          message,
          signal: abortController.signal,
          requestId,
          operationId,
          traceContext: span ? { traceId: span.traceId, parentSpanId: span.spanId } : undefined,
          idempotencyKey,
        });
        if (outcome.idempotencyApplied) res.setHeader('idempotency-status', outcome.deduplicated ? 'replayed' : 'created');
        return writeSse(res, outcome.response.reply, outcome.response.costUsd);
      }

      if (route === 'GET /status') {
        activeAuthorizer.authorize(principal, route);
        requireGlobalAccess(principal, 'status:cross-tenant');
        const monthlyCostUsd = await costTracker.getMonthlyCost();
        const monthlyReservedUsd = await costTracker.getReservedCost();
        return sendJson(res, 200, {
          status: 'ok',
          activeSessions: await sessionStore.size(),
          monthlyCostUsd,
          monthlyReservedUsd,
          costUsd: monthlyCostUsd, // alias kept stable for external smoke checks
          budget: {
            monthlyBudgetUsd: config.budget.monthlyUsd,
            maxUsdPerRequest: config.budget.maxUsdPerRequest,
            reservedUsd: monthlyReservedUsd,
            overBudget: await costTracker.isOverBudget(config.budget.monthlyUsd),
          },
          jobs: scheduler.listJobs(),
          costSummary: await costTracker.summary(),
          capabilities: {
            runtimeProfile: config.runtimeProfile ?? 'development',
            telemetry: telemetry?.enabled === true ? 'enabled' : 'off',
            state: {
              adapter: stateStore?.adapterName ?? config.state?.adapter ?? 'memory',
              durable: stateStore?.capabilities?.durable === true,
              multiProcess: stateStore?.capabilities?.multiProcess === true,
              multiHost: stateStore?.capabilities?.multiHost === true,
              conformance: stateStore?.capabilities?.conformance ?? 'unknown',
            },
            scheduler: {
              adapter: scheduler.adapterName ?? 'local',
              durable: scheduler.capabilities?.durable === true,
              multiInstance: scheduler.capabilities?.multiInstance === true,
              conformance: scheduler.capabilities?.conformance ?? 'unknown',
            },
            dashboard: Boolean(dashboardHandler),
            audit: typeof audit?.capacity === 'function' ? await audit.capacity() : null,
          },
        });
      }

      // Human approval endpoints for pending write confirmations. These are the
      // OUT-OF-BAND channel: only a Bearer-authenticated operator reaches them,
      // the model inside the agent loop cannot.
      if (route === 'GET /confirmations') {
        activeAuthorizer.authorize(principal, route);
        return sendJson(res, 200, { pending: confirmations ? await confirmations.list({ principal }) : [] });
      }
      const confirmMatch = req.method === 'POST' && url.pathname.match(/^\/confirmations\/([^/]+)\/(approve|reject)$/);
      if (confirmMatch) {
        activeAuthorizer.authorize(principal, 'POST /confirmations');
        if (!confirmations) return sendJson(res, 404, { error: 'confirmation center not enabled' });
        const id = decodeURIComponent(confirmMatch[1]);
        const action = confirmMatch[2];
        await startAudit({
          actor: principal.subjectId,
          tenant: principal.tenantId,
          action: `confirmation.${action}`,
          resource: 'confirmation',
        });
        const outcome = action === 'approve'
          ? await confirmations.approve(id, { principal })
          : await confirmations.reject(id, { principal });
        if (!outcome.ok) return sendJson(res, outcome.statusCode ?? 404, { error: outcome.error ?? 'unknown confirmation id', id });
        await recordAudit({ actor: principal.subjectId, tenant: principal.tenantId, action: `confirmation.${action}`, resource: 'confirmation', outcome: 'ok' });
        return sendJson(res, 200, { id, action, ...outcome });
      }

      const jobMatch = req.method === 'POST' && url.pathname.match(/^\/jobs\/([^/]+)\/run$/);
      if (jobMatch) {
        activeAuthorizer.authorize(principal, 'POST /jobs/run');
        requireGlobalAccess(principal, 'jobs:cross-tenant');
        const name = decodeURIComponent(jobMatch[1]);
        const jobs = scheduler.listJobs().map((job) => job.name);
        if (!jobs.includes(name)) return sendJson(res, 404, { error: `unknown job "${name}"`, jobs });
        const idempotencyKey = requestIdempotencyKey(req.headers['idempotency-key']);
        if (!idempotencyKey) {
          const error = new Error('manual jobs require Idempotency-Key');
          error.code = 'IDEMPOTENCY_KEY_REQUIRED';
          error.statusCode = 428;
          error.unknownOutcome = false;
          throw error;
        }
        const outcome = await runManualJob({ principal, name, idempotencyKey });
        res.setHeader('idempotency-status', outcome.deduplicated ? 'replayed' : 'created');
        return sendJson(res, outcome.response.ok ? 200 : 500, outcome.response);
      }

      if (dashboardHandler && (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') || url.pathname.startsWith('/api/dashboard/'))) {
        return dashboardHandler(req, res, { url, route, principal, requestId, signal: abortController.signal });
      }

      return sendJson(res, 404, { error: `no route: ${route}` });
    } catch (err) {
      // Last-resort guard: never leak a stack trace to the client.
      console.error(`[http] ${safeRoute} failed code=${err.code ?? err.name ?? 'ERROR'}`);
      if (!res.headersSent) sendJson(res, err.statusCode ?? 500, {
        error: err.statusCode ? err.code ?? 'request rejected' : 'internal error',
        ...(err.reconciliationRequired ? { reconciliationRequired: true } : {}),
      });
      else res.end();
    }
  });

  // Bound slow-header/body and keep-alive resource occupancy explicitly rather
  // than inheriting Node defaults that can hold unauthenticated sockets open.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  // A finite maxRequestsPerSocket makes Node answer the first request beyond
  // the threshold with 503 on an otherwise healthy keep-alive connection.
  // Timeouts and maxConnections bound resource occupancy without injecting a
  // deterministic application-visible failure.
  server.maxRequestsPerSocket = 0;
  server.maxConnections = 10_000;

  return server;
}
