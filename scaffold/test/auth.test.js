import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationError, QuotaExceededError, authorize, createAuthenticator, createDashboardSessionManager, createPrincipal, createQuotaManager, createRouteAuthorizer } from '../src/auth/index.js';

const caller = createPrincipal({ subjectId: 'caller-a', tenantId: 'tenant-a', roles: ['caller'], scopes: ['chat:write'] });
const operator = createPrincipal({ subjectId: 'operator-a', tenantId: 'tenant-a', roles: ['operator'], scopes: ['runs:read'] });
const admin = createPrincipal({ subjectId: 'admin', tenantId: null, roles: ['admin'], scopes: ['*'] });
const CALLER_CREDENTIAL = ['synthetic', 'credential', 'caller', '123'].join('-');
const LEGACY_CREDENTIAL = ['synthetic', 'credential', 'legacy', '123'].join('-');

test('authenticator maps opaque bearer tokens to server-owned principals', () => {
  const auth = createAuthenticator({ principals: [{ token: CALLER_CREDENTIAL, principal: caller }], legacyAdminToken: LEGACY_CREDENTIAL });
  assert.equal(auth.authenticateHeader(`Bearer ${CALLER_CREDENTIAL}`).subjectId, 'caller-a');
  assert.equal(auth.authenticateHeader('Bearer wrong-token-value'), null);
  assert.equal(auth.authenticateHeader('Basic abc'), null);
  assert.equal(auth.authenticateHeader(`Bearer ${LEGACY_CREDENTIAL}`).roles[0], 'admin');
  assert.equal(JSON.stringify(auth).includes(CALLER_CREDENTIAL), false);
});

test('RBAC, scopes, tenant boundaries and missing route policies fail closed', () => {
  assert.equal(authorize(caller, { roles: ['caller'], scopes: ['chat:write'], tenantId: 'tenant-a' }), true);
  assert.throws(() => authorize(caller, { roles: ['operator'] }), AuthorizationError);
  assert.throws(() => authorize(caller, { tenantId: 'tenant-b' }), /Cross-tenant/);
  assert.equal(authorize(operator, { roles: ['operator'], tenantId: 'tenant-b', allowCrossTenant: true }), true);
  assert.equal(authorize(admin, { scopes: ['anything'] }), true);
  const routes = createRouteAuthorizer({ 'POST /chat': { roles: ['caller', 'operator', 'admin'], scopes: ['chat:write'] } });
  assert.throws(() => routes.authorize(caller, 'GET /unclassified'), /No route policy/);
});

test('quota enforces per-tenant rate and concurrency with deterministic refill', () => {
  let clock = 0;
  const quota = createQuotaManager({ requestsPerMinute: 2, concurrency: 1, now: () => clock });
  const release = quota.enter(caller);
  assert.throws(() => quota.enter(caller), (error) => error instanceof QuotaExceededError && error.code === 'CONCURRENCY_LIMIT');
  release();
  quota.enter(caller)();
  assert.throws(() => quota.enter(caller), (error) => error.code === 'RATE_LIMIT');
  clock += 30_000;
  quota.enter(caller)();
  assert.equal(quota.snapshot('tenant-a').active, 0);
});

test('dashboard browser sessions are short-lived, HttpOnly and rate-limited', () => {
  let clock = 1_000;
  const sessions = createDashboardSessionManager({ ttlMs: 2_000, maxLoginAttemptsPerMinute: 2, now: () => clock });
  const opaque = sessions.create(operator);
  const cookie = sessions.setCookie(opaque, { secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(sessions.authenticateCookie(cookie).subjectId, operator.subjectId);
  assert.equal(JSON.stringify(sessions).includes(opaque), false);
  assert.equal(sessions.allowLoginAttempt('loopback'), true);
  assert.equal(sessions.allowLoginAttempt('loopback'), true);
  assert.equal(sessions.allowLoginAttempt('loopback'), false);
  clock += 2_001;
  assert.equal(sessions.authenticateCookie(cookie), null);
});
