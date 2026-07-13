/**
 * HTTP channel on node:http (zero dependencies).
 * Endpoints:
 *   GET  /health          - liveness, NO auth
 *   POST /chat            - {sessionId, message} -> {sessionId, reply, costUsd}
 *   GET  /chat/stream     - SSE variant (?sessionId=&message=)
 *   GET  /status          - sessions / monthly cost / budget (real cost-tracker data)
 *   GET  /confirmations   - pending write confirmations awaiting a human
 *   POST /confirmations/:id/approve | /reject - human out-of-band approval
 *   POST /jobs/:name/run  - manually trigger a registered patrol job
 *   POST /webhook         - inbound webhook (only when WEBHOOK_SECRET is set;
 *                           authenticated by HMAC signature instead of Bearer)
 * Everything except /health and /webhook requires Authorization: Bearer <GATEWAY_AUTH_TOKEN>.
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time Bearer token check (compare SHA-256 digests, not raw strings). */
function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

/** Push a reply through SSE in small chunks, then a done event.
 *  (Pseudo-streaming: the reply is computed first. To stream true model deltas,
 *  extend the provider with the Messages API `stream: true` mode.) */
function writeSse(res, reply, costUsd) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
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

export function createHttpServer({ config, handleMessage, scheduler, costTracker, sessionStore, webhookHandler, confirmations }) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
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
          raw = await readBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { error: err.message });
        }
        const { status, body } = await webhookHandler(raw, req.headers);
        return sendJson(res, status, body);
      }

      if (!isAuthorized(req, config.gatewayAuthToken)) {
        return sendJson(res, 401, { error: 'unauthorized', hint: 'send header: Authorization: Bearer <GATEWAY_AUTH_TOKEN>' });
      }

      if (route === 'POST /chat') {
        let raw;
        try {
          raw = await readBody(req);
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { error: err.message });
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'body must be JSON: {"sessionId": "...", "message": "..."}' });
        }
        const { sessionId, message } = payload ?? {};
        if (typeof sessionId !== 'string' || !sessionId || typeof message !== 'string' || !message) {
          return sendJson(res, 400, { error: 'sessionId and message are required strings' });
        }
        const result = await handleMessage(sessionId, message);
        return sendJson(res, 200, { sessionId, reply: result.text, costUsd: result.costUsd ?? 0 });
      }

      if (route === 'GET /chat/stream') {
        const sessionId = url.searchParams.get('sessionId');
        const message = url.searchParams.get('message');
        if (!sessionId || !message) {
          return sendJson(res, 400, { error: 'query params sessionId and message are required' });
        }
        const result = await handleMessage(sessionId, message);
        return writeSse(res, result.text, result.costUsd ?? 0);
      }

      if (route === 'GET /status') {
        const monthlyCostUsd = costTracker.getMonthlyCost();
        return sendJson(res, 200, {
          status: 'ok',
          activeSessions: sessionStore.size(),
          monthlyCostUsd,
          costUsd: monthlyCostUsd, // alias kept stable for external smoke checks
          budget: {
            monthlyBudgetUsd: config.budget.monthlyUsd,
            maxUsdPerRequest: config.budget.maxUsdPerRequest,
            overBudget: costTracker.isOverBudget(config.budget.monthlyUsd),
          },
          jobs: scheduler.listJobs(),
          costSummary: costTracker.summary(),
        });
      }

      // Human approval endpoints for pending write confirmations. These are the
      // OUT-OF-BAND channel: only a Bearer-authenticated operator reaches them,
      // the model inside the agent loop cannot.
      if (route === 'GET /confirmations') {
        return sendJson(res, 200, { pending: confirmations ? confirmations.list() : [] });
      }
      const confirmMatch = req.method === 'POST' && url.pathname.match(/^\/confirmations\/([^/]+)\/(approve|reject)$/);
      if (confirmMatch) {
        if (!confirmations) return sendJson(res, 404, { error: 'confirmation center not enabled' });
        const id = decodeURIComponent(confirmMatch[1]);
        const action = confirmMatch[2];
        const outcome = action === 'approve' ? confirmations.approve(id) : confirmations.reject(id);
        if (!outcome.ok) return sendJson(res, 404, { error: outcome.error ?? 'unknown confirmation id', id });
        return sendJson(res, 200, { id, action, ...outcome });
      }

      const jobMatch = req.method === 'POST' && url.pathname.match(/^\/jobs\/([^/]+)\/run$/);
      if (jobMatch) {
        const name = decodeURIComponent(jobMatch[1]);
        const outcome = await scheduler.runNow(name);
        if (outcome === null) return sendJson(res, 404, { error: `unknown job "${name}"`, jobs: scheduler.listJobs().map((j) => j.name) });
        return sendJson(res, outcome.ok ? 200 : 500, { job: name, ...outcome });
      }

      return sendJson(res, 404, { error: `no route: ${route}` });
    } catch (err) {
      // Last-resort guard: never leak a stack trace to the client.
      console.error(`[http] ${route} failed:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  return server;
}
