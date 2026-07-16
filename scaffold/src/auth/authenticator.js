import { createHash, timingSafeEqual } from 'node:crypto';
import { createPrincipal } from './principal.js';

function tokenDigest(token) {
  return createHash('sha256').update(String(token)).digest();
}

function parseBearer(header) {
  const match = /^Bearer ([^\s]+)$/i.exec(String(header ?? ''));
  return match?.[1] ?? null;
}

export function createAuthenticator({ principals = [], legacyAdminToken } = {}) {
  const entries = principals.map((entry) => {
    if (typeof entry?.token !== 'string' || entry.token.length < 12) throw new Error('[auth] principal token must be at least 12 characters');
    return { digest: tokenDigest(entry.token), principal: createPrincipal(entry.principal) };
  });
  if (legacyAdminToken) {
    if (legacyAdminToken.length < 12) throw new Error('[auth] legacy admin token must be at least 12 characters');
    entries.push({
      digest: tokenDigest(legacyAdminToken),
      principal: createPrincipal({ subjectId: 'legacy-admin', tenantId: null, roles: ['admin'], scopes: ['*'], authType: 'legacy-bearer' }),
    });
  }

  function authenticateHeader(header) {
    const token = parseBearer(header);
    if (!token) return null;
    const candidate = tokenDigest(token);
    for (const entry of entries) if (timingSafeEqual(candidate, entry.digest)) return entry.principal;
    return null;
  }

  return Object.freeze({ authenticateHeader, configuredPrincipals: entries.length });
}

export function parsePrincipalConfig(json) {
  if (!json) return [];
  let value;
  try { value = JSON.parse(json); } catch { throw new Error('[auth] AUTH_PRINCIPALS_JSON must be valid JSON'); }
  if (!Array.isArray(value)) throw new Error('[auth] AUTH_PRINCIPALS_JSON must be an array');
  return value;
}
