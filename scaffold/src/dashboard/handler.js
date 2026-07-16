import { readFile } from 'node:fs/promises';

import {
  DASHBOARD_DEFAULT_PAGE_SIZE,
  DASHBOARD_MAX_PAGE_SIZE,
  createDashboardReadModelProvider,
  decodeDashboardCursor,
  sanitizeDashboardEnvelope,
} from './read-model.js';
import {
  DASHBOARD_PAGES,
  renderAccessState,
  renderDashboardPage,
} from './render.js';

const ALLOWED_ROLES = new Set(['operator', 'admin', 'auditor']);
const CAPABILITY_ALIASES = Object.freeze({
  'dashboard:read': 'dashboard:view',
  'runs:read': 'runs:view',
  'costs:read': 'costs:view',
  'evals:read': 'evals:view',
  'approvals:read': 'approvals:view',
  'audit:read': 'audit:view',
  'system:read': 'system:view',
});
const PAGINATED_RESOURCES = new Set(['runs', 'costs', 'evals', 'approvals', 'audit']);
const ASSETS = Object.freeze({
  '/dashboard/assets/dashboard.css': {
    file: new URL('./assets/dashboard.css', import.meta.url),
    contentType: 'text/css; charset=utf-8',
  },
  '/dashboard/assets/dashboard.js': {
    file: new URL('./assets/dashboard.js', import.meta.url),
    contentType: 'text/javascript; charset=utf-8',
  },
});

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function collection(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === 'string') return new Set([value]);
  if (value && typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, enabled]) => enabled === true).map(([key]) => key));
  }
  return new Set();
}

function principalContext(principal) {
  const roles = collection(principal?.roles ?? principal?.role ?? principal?.claims?.roles);
  const rawCapabilities = collection(
    principal?.capabilities
      ?? principal?.claims?.capabilities
      ?? principal?.permissions
      ?? principal?.scopes,
  );
  const capabilities = new Set(rawCapabilities);
  for (const [alias, canonical] of Object.entries(CAPABILITY_ALIASES)) {
    if (rawCapabilities.has(alias)) capabilities.add(canonical);
  }
  const allowedRole = ['admin', 'auditor', 'operator'].find((role) => roles.has(role)) ?? null;
  return { roles, capabilities, allowedRole };
}

function hasCapability(capabilities, required) {
  return capabilities.has('*') || capabilities.has('dashboard:*') || capabilities.has(required);
}

function hasPageAccess(context, capability) {
  if (!context.allowedRole || !ALLOWED_ROLES.has(context.allowedRole)) return false;
  if (!hasCapability(context.capabilities, 'dashboard:view')) return false;
  return capability === 'dashboard:view' || hasCapability(context.capabilities, capability);
}

function environmentLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._ -]{1,48}$/.test(value)) return 'unknown';
  if (/(?:canary|secret|token|password|key)/i.test(value)) return 'unknown';
  return value;
}

function isDashboardPath(pathname) {
  return pathname === '/dashboard'
    || pathname.startsWith('/dashboard/')
    || pathname === '/api/dashboard'
    || pathname.startsWith('/api/dashboard/');
}

function decodePublicId(segment) {
  try {
    const value = decodeURIComponent(segment);
    if (!value || value.length > 128 || !/^[A-Za-z0-9._~:*•-]+$/u.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function parseRoute(pathname) {
  if (ASSETS[pathname]) return { kind: 'asset', asset: ASSETS[pathname], capability: 'dashboard:view' };

  const html = new Map([
    ['/dashboard', 'overview'],
    ['/dashboard/', 'overview'],
    ['/dashboard/runs', 'runs'],
    ['/dashboard/costs', 'costs'],
    ['/dashboard/evals', 'evals'],
    ['/dashboard/approvals', 'approvals'],
    ['/dashboard/audit', 'audit'],
    ['/dashboard/system', 'system'],
  ]);
  const htmlPage = html.get(pathname);
  if (htmlPage) return { kind: 'html', page: DASHBOARD_PAGES[htmlPage] };

  let match = pathname.match(/^\/dashboard\/runs\/([^/]+)$/);
  if (match) {
    const id = decodePublicId(match[1]);
    return id ? { kind: 'html', page: DASHBOARD_PAGES.run, id } : { kind: 'invalid' };
  }
  match = pathname.match(/^\/dashboard\/evals\/([^/]+)$/);
  if (match) {
    const id = decodePublicId(match[1]);
    return id ? { kind: 'html', page: DASHBOARD_PAGES.eval, id } : { kind: 'invalid' };
  }

  const api = new Map([
    ['/api/dashboard/overview', 'overview'],
    ['/api/dashboard/runs', 'runs'],
    ['/api/dashboard/costs', 'costs'],
    ['/api/dashboard/evals', 'evals'],
    ['/api/dashboard/approvals', 'approvals'],
    ['/api/dashboard/audit', 'audit'],
    ['/api/dashboard/system', 'system'],
  ]);
  const apiPage = api.get(pathname);
  if (apiPage) return { kind: 'api', page: DASHBOARD_PAGES[apiPage] };

  match = pathname.match(/^\/api\/dashboard\/runs\/([^/]+)$/);
  if (match) {
    const id = decodePublicId(match[1]);
    return id ? { kind: 'api', page: DASHBOARD_PAGES.run, id } : { kind: 'invalid' };
  }
  match = pathname.match(/^\/api\/dashboard\/evals\/([^/]+)$/);
  if (match) {
    const id = decodePublicId(match[1]);
    return id ? { kind: 'api', page: DASHBOARD_PAGES.eval, id } : { kind: 'invalid' };
  }

  return { kind: 'not_found' };
}

function responseHeaders(contentType, body) {
  return {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  };
}

function send(req, res, status, contentType, body, extraHeaders = {}) {
  const headers = { ...responseHeaders(contentType, body), ...extraHeaders };
  res.writeHead(status, headers);
  res.end(String(req.method ?? 'GET').toUpperCase() === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, value, extraHeaders) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extraHeaders);
}

function sendAccessState(req, res, route, status) {
  const unauthenticated = status === 401;
  const value = {
    error: {
      code: unauthenticated ? 'DASHBOARD_AUTHENTICATION_REQUIRED' : 'DASHBOARD_FORBIDDEN',
      message: unauthenticated ? 'Authentication is required.' : 'This role or capability cannot access the dashboard resource.',
    },
  };
  if (route.kind === 'api') return sendJson(req, res, status, value);
  return send(
    req,
    res,
    status,
    'text/html; charset=utf-8',
    renderAccessState({
      status,
      title: unauthenticated ? 'Authentication Required' : 'Permission State',
      message: unauthenticated
        ? 'Use the supported server authentication flow, then return to the Dashboard.'
        : 'An operator, admin or auditor role with the required read capability is required.',
    }),
  );
}

function parsePagination(url, resource) {
  const allowed = new Set(PAGINATED_RESOURCES.has(resource) ? ['limit', 'cursor'] : []);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new TypeError('unsupported dashboard query');
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) throw new TypeError('duplicate dashboard query');
  }
  if (!PAGINATED_RESOURCES.has(resource)) return undefined;

  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && (rawLimit.length > 6 || !/^[1-9][0-9]*$/.test(rawLimit))) throw new TypeError('invalid dashboard page size');
  const requested = rawLimit === null ? DASHBOARD_DEFAULT_PAGE_SIZE : Number(rawLimit);
  const limit = Math.min(requested, DASHBOARD_MAX_PAGE_SIZE);
  const cursor = url.searchParams.get('cursor');
  if (url.searchParams.has('cursor') && !cursor) throw new TypeError('invalid dashboard cursor');
  const offset = decodeDashboardCursor(resource, cursor);
  return { limit, offset };
}

async function resolvePrincipal(req, ctx) {
  if (typeof ctx.resolvePrincipal === 'function') return ctx.resolvePrincipal(req);
  return ctx.principal ?? null;
}

async function readProvider(provider, query) {
  if (typeof provider?.readRaw === 'function') return provider.readRaw(query);
  if (typeof provider?.read === 'function') return provider.read(query);
  const methods = {
    overview: 'getOverview',
    runs: 'listRuns',
    run: 'getRun',
    costs: 'listCosts',
    evals: 'listEvals',
    eval: 'getEval',
    approvals: 'listApprovals',
    audit: 'listAudit',
    system: 'getSystem',
  };
  const method = methods[query.resource];
  if (typeof provider?.[method] === 'function') return provider[method](query);
  throw new TypeError('dashboard read-model provider is not configured');
}

function correlationId(ctx, req) {
  if (typeof ctx.correlationId === 'function') return ctx.correlationId(req);
  return ctx.correlationId;
}

/**
 * Handle a Dashboard request without coupling the Dashboard to the main HTTP
 * channel. Returns false when the request is outside the Dashboard namespace;
 * otherwise writes the complete response and returns true.
 *
 * Integration context:
 *   principal | resolvePrincipal(req) -> server-authenticated role/capabilities
 *   readModelProvider -> createDashboardReadModelProvider(...) or compatible read()
 *   environment, telemetryEnabled, now, staleAfterMs, correlationId
 *   authorizeDashboard(decisionContext) -> optional additional deny-only policy
 */
export async function handleDashboardRequest(req, res, ctx = {}) {
  let url;
  try {
    url = new URL(req.url, 'http://dashboard.local');
  } catch {
    return false;
  }
  if (!isDashboardPath(url.pathname)) return false;

  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(req, res, 405, { error: { code: 'DASHBOARD_READ_ONLY', message: 'Only GET and HEAD are allowed.' } }, { allow: 'GET, HEAD' });
    return true;
  }

  const route = parseRoute(url.pathname);
  if (route.kind === 'invalid') {
    sendJson(req, res, 400, { error: { code: 'DASHBOARD_INVALID_ROUTE', message: 'The dashboard route is invalid.' } });
    return true;
  }
  if (route.kind === 'not_found') {
    sendJson(req, res, 404, { error: { code: 'DASHBOARD_NOT_FOUND', message: 'Dashboard resource not found.' } });
    return true;
  }

  let principal;
  try {
    principal = await resolvePrincipal(req, ctx);
  } catch {
    sendAccessState(req, res, route, 401);
    return true;
  }
  if (!principal || principal.authenticated === false) {
    sendAccessState(req, res, route, 401);
    return true;
  }
  const auth = principalContext(principal);
  const requiredCapability = route.capability ?? route.page?.capability ?? 'dashboard:view';
  if (!hasPageAccess(auth, requiredCapability)) {
    sendAccessState(req, res, route, 403);
    return true;
  }
  if (typeof ctx.authorizeDashboard === 'function') {
    let allowed = false;
    try {
      allowed = await ctx.authorizeDashboard({
        req,
        principal,
        role: auth.allowedRole,
        requiredCapabilities: requiredCapability === 'dashboard:view'
          ? ['dashboard:view']
          : ['dashboard:view', requiredCapability],
        resource: route.page?.resource ?? 'assets',
      });
    } catch {
      allowed = false;
    }
    if (allowed !== true) {
      sendAccessState(req, res, route, 403);
      return true;
    }
  }

  if (route.kind === 'asset') {
    try {
      const body = await readFile(route.asset.file, 'utf8');
      send(req, res, 200, route.asset.contentType, body);
    } catch {
      sendJson(req, res, 500, { error: { code: 'DASHBOARD_ASSET_UNAVAILABLE', message: 'Dashboard asset unavailable.' } });
    }
    return true;
  }

  if (route.kind === 'html') {
    try {
      parsePagination(url, route.page.resource);
    } catch {
      sendJson(req, res, 400, { error: { code: 'DASHBOARD_INVALID_QUERY', message: 'Use only the allowlisted cursor and page size.' } });
      return true;
    }
    const body = renderDashboardPage({
      page: route.page,
      role: auth.allowedRole,
      capabilities: auth.capabilities,
      environment: environmentLabel(ctx.environment),
      telemetryEnabled: ctx.telemetryEnabled === true,
    });
    send(req, res, 200, 'text/html; charset=utf-8', body);
    return true;
  }

  let pagination;
  try {
    pagination = parsePagination(url, route.page.resource);
  } catch {
    sendJson(req, res, 400, { error: { code: 'DASHBOARD_INVALID_QUERY', message: 'Use only the allowlisted cursor and page size.' } });
    return true;
  }

  const provider = ctx.readModelProvider ?? ctx.provider ?? createDashboardReadModelProvider({
    telemetryEnabled: ctx.telemetryEnabled === true,
    environment: ctx.environment,
    now: ctx.now,
    staleAfterMs: ctx.staleAfterMs,
  });
  const query = {
    resource: route.page.resource,
    id: route.id,
    pagination,
    principal: {
      subjectId: principal.subjectId ?? principal.id ?? null,
      tenantId: principal.tenantId ?? principal.tenant ?? null,
      role: auth.allowedRole,
      roles: [...auth.roles],
      capabilities: [...auth.capabilities],
      scopes: Array.isArray(principal.scopes) ? [...principal.scopes] : [],
    },
    correlationId: correlationId(ctx, req),
  };

  try {
    const raw = await readProvider(provider, query);
    const envelope = sanitizeDashboardEnvelope(route.page.resource, raw, {
      pagination,
      telemetryEnabled: ctx.telemetryEnabled === true,
      environment: ctx.environment,
      now: ctx.now,
      staleAfterMs: ctx.staleAfterMs,
      correlationId: query.correlationId,
    });
    const notFound = (route.page.resource === 'run' || route.page.resource === 'eval')
      && envelope.data === null
      && envelope.meta.availability === 'available';
    sendJson(req, res, notFound ? 404 : 200, envelope);
  } catch {
    const envelope = sanitizeDashboardEnvelope(route.page.resource, {
      data: null,
      meta: {
        availability: 'unavailable',
        freshness: 'unknown',
        telemetry: ctx.telemetryEnabled === true ? 'on' : 'off',
        source: 'dashboard-read-model',
      },
    }, {
      pagination,
      telemetryEnabled: ctx.telemetryEnabled === true,
      environment: ctx.environment,
      now: ctx.now,
      staleAfterMs: ctx.staleAfterMs,
      correlationId: query.correlationId,
    });
    sendJson(req, res, 503, {
      ...envelope,
      error: { code: 'DASHBOARD_SOURCE_UNAVAILABLE', message: 'The read model is temporarily unavailable.', recoverable: true },
    });
  }
  return true;
}
