import { createHash, randomBytes } from 'node:crypto';
import { createPrincipal } from './principal.js';

export const DASHBOARD_SESSION_COOKIE = 'ba_dashboard_session';

const SESSION_NAMESPACE = 'session';
const SESSION_KEY_PREFIX = 'dashboard-session:';
const ATTEMPT_NAMESPACE = 'idempotency';
const ATTEMPT_KEY_PREFIX = 'dashboard-login-attempt:';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function validTokenFromCookie(header) {
  const token = cookieValue(header, DASHBOARD_SESSION_COOKIE);
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return token;
}

function currentTime(now) {
  const value = Number(now());
  if (!Number.isFinite(value) || value < 0) throw new Error('[dashboard-session] now() must return a finite non-negative timestamp');
  return value;
}

function storedPrincipal(principal) {
  const normalized = createPrincipal(principal);
  return {
    subjectId: normalized.subjectId,
    tenantId: normalized.tenantId,
    roles: [...normalized.roles],
    scopes: [...normalized.scopes],
    authType: normalized.authType,
  };
}

function restorePrincipal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.authType !== 'string' || !value.authType || value.authType.length > 64) return null;
  try {
    return createPrincipal(value);
  } catch {
    return null;
  }
}

function parseSessionRecord(record, expectedDigest) {
  const value = record?.value;
  if (!value
      || Object.keys(value).sort().join(',') !== 'digest,expiresAt,principal'
      || !DIGEST_PATTERN.test(value.digest)
      || (expectedDigest && value.digest !== expectedDigest)
      || !Number.isFinite(value.expiresAt)
      || value.expiresAt < 0) return null;
  const principal = restorePrincipal(value.principal);
  return principal ? { digest: value.digest, expiresAt: value.expiresAt, principal } : null;
}

function parseAttemptRecord(record, expectedDigest) {
  const value = record?.value;
  if (!value
      || Object.keys(value).sort().join(',') !== 'count,digest,expiresAt'
      || value.digest !== expectedDigest
      || !DIGEST_PATTERN.test(value.digest)
      || !Number.isInteger(value.count)
      || value.count < 1
      || !Number.isFinite(value.expiresAt)
      || value.expiresAt < 0) return null;
  return value;
}

function listAll(tx, namespace, prefix) {
  const records = [];
  let cursor = null;
  do {
    const page = tx.list(namespace, { prefix, cursor, limit: 1_000 });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

function cookieMethods(ttlMs) {
  function setCookie(token, { secure = false } = {}) {
    return `${DASHBOARD_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1_000)}${secure ? '; Secure' : ''}`;
  }

  function clearCookie({ secure = false } = {}) {
    return `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  return { setCookie, clearCookie };
}

function createPersistentDashboardSessionManager({
  stateStore,
  ttlMs,
  maxSessions,
  maxLoginAttemptsPerMinute,
  now,
}) {
  const cookies = cookieMethods(ttlMs);

  async function create(principal) {
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = digest(token);
    const expiresAt = currentTime(now) + ttlMs;
    const normalizedPrincipal = storedPrincipal(principal);

    await stateStore.transaction(async (tx) => {
      const current = currentTime(now);
      const live = [];
      for (const record of listAll(tx, SESSION_NAMESPACE, SESSION_KEY_PREFIX)) {
        const parsed = parseSessionRecord(record);
        if (!parsed) throw new Error('[dashboard-session] persistent session record is invalid; refusing to weaken authentication');
        if (parsed.expiresAt <= current) tx.delete(SESSION_NAMESPACE, record.key, { ifRevision: record.revision });
        else live.push({ ...record, expiresAt: parsed.expiresAt });
      }
      live.sort((a, b) => a.expiresAt - b.expiresAt || a.key.localeCompare(b.key));
      while (live.length >= maxSessions) {
        const evicted = live.shift();
        tx.delete(SESSION_NAMESPACE, evicted.key, { ifRevision: evicted.revision });
      }
      tx.put(SESSION_NAMESPACE, `${SESSION_KEY_PREFIX}${tokenDigest}`, {
        digest: tokenDigest,
        principal: normalizedPrincipal,
        expiresAt,
      }, { ifRevision: null });
    });
    return token;
  }

  async function authenticateCookie(header) {
    const token = validTokenFromCookie(header);
    if (!token) return null;
    const tokenDigest = digest(token);
    const key = `${SESSION_KEY_PREFIX}${tokenDigest}`;
    const record = await stateStore.get(SESSION_NAMESPACE, key);
    if (!record) return null;
    const parsed = parseSessionRecord(record, tokenDigest);
    if (!parsed) return null;
    if (parsed.expiresAt <= currentTime(now)) {
      await stateStore.delete(SESSION_NAMESPACE, key, { ifRevision: record.revision }).catch(() => {});
      return null;
    }
    return parsed.principal;
  }

  async function revokeCookie(header) {
    const token = validTokenFromCookie(header);
    if (!token) return false;
    const key = `${SESSION_KEY_PREFIX}${digest(token)}`;
    return stateStore.transaction(async (tx) => {
      const record = tx.get(SESSION_NAMESPACE, key);
      if (!record) return false;
      tx.delete(SESSION_NAMESPACE, key, { ifRevision: record.revision });
      return true;
    });
  }

  async function allowLoginAttempt(key = 'unknown') {
    const attemptDigest = digest(String(key));
    const recordKey = `${ATTEMPT_KEY_PREFIX}${attemptDigest}`;
    return stateStore.transaction(async (tx) => {
      const current = currentTime(now);
      for (const record of listAll(tx, ATTEMPT_NAMESPACE, ATTEMPT_KEY_PREFIX)) {
        const expected = record.key.slice(ATTEMPT_KEY_PREFIX.length);
        const parsed = parseAttemptRecord(record, expected);
        if (!parsed) throw new Error('[dashboard-session] persistent login-attempt record is invalid; refusing to reset the limit');
        if (parsed.expiresAt <= current) tx.delete(ATTEMPT_NAMESPACE, record.key, { ifRevision: record.revision });
      }
      const record = tx.get(ATTEMPT_NAMESPACE, recordKey);
      const previous = record ? parseAttemptRecord(record, attemptDigest) : null;
      if (record && !previous) throw new Error('[dashboard-session] persistent login-attempt record is invalid; refusing to reset the limit');
      const count = previous && previous.expiresAt > current ? previous.count + 1 : 1;
      const expiresAt = previous && previous.expiresAt > current ? previous.expiresAt : current + 60_000;
      tx.put(ATTEMPT_NAMESPACE, recordKey, { digest: attemptDigest, count, expiresAt }, record ? { ifRevision: record.revision } : { ifRevision: null });
      return count <= maxLoginAttemptsPerMinute;
    });
  }

  async function size() {
    return stateStore.transaction(async (tx) => {
      const current = currentTime(now);
      let count = 0;
      for (const record of listAll(tx, SESSION_NAMESPACE, SESSION_KEY_PREFIX)) {
        const parsed = parseSessionRecord(record);
        if (!parsed) throw new Error('[dashboard-session] persistent session record is invalid');
        if (parsed.expiresAt <= current) tx.delete(SESSION_NAMESPACE, record.key, { ifRevision: record.revision });
        else count += 1;
      }
      return count;
    });
  }

  return Object.freeze({ create, authenticateCookie, revokeCookie, allowLoginAttempt, ...cookies, size });
}

export function createDashboardSessionManager({
  ttlMs = 15 * 60_000,
  maxSessions = 1_000,
  maxLoginAttemptsPerMinute = 10,
  stateStore,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new Error('[dashboard-session] ttlMs must be at least 1000');
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('[dashboard-session] maxSessions must be a positive integer');
  if (!Number.isInteger(maxLoginAttemptsPerMinute) || maxLoginAttemptsPerMinute < 1) {
    throw new Error('[dashboard-session] maxLoginAttemptsPerMinute must be a positive integer');
  }
  if (stateStore) return createPersistentDashboardSessionManager({ stateStore, ttlMs, maxSessions, maxLoginAttemptsPerMinute, now });

  const sessions = new Map();
  const attempts = new Map();
  const cookies = cookieMethods(ttlMs);

  function prune() {
    const current = currentTime(now);
    for (const [key, value] of sessions) if (value.expiresAt <= current) sessions.delete(key);
    for (const [key, value] of attempts) if (current - value.startedAt >= 60_000) attempts.delete(key);
  }

  function create(principal) {
    prune();
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), { principal: createPrincipal(principal), expiresAt: currentTime(now) + ttlMs });
    return token;
  }

  function authenticateCookie(header) {
    prune();
    const token = validTokenFromCookie(header);
    return token ? sessions.get(digest(token))?.principal ?? null : null;
  }

  function revokeCookie(header) {
    const token = validTokenFromCookie(header);
    return token ? sessions.delete(digest(token)) : false;
  }

  function allowLoginAttempt(key = 'unknown') {
    prune();
    const current = currentTime(now);
    const bucket = attempts.get(key) ?? { startedAt: current, count: 0 };
    bucket.count += 1;
    attempts.set(key, bucket);
    return bucket.count <= maxLoginAttemptsPerMinute;
  }

  return Object.freeze({ create, authenticateCookie, revokeCookie, allowLoginAttempt, ...cookies, size: () => sessions.size });
}
