const ROLES = new Set(['caller', 'operator', 'admin', 'service', 'auditor']);

export function createPrincipal({ subjectId, tenantId, roles = [], scopes = [], authType = 'bearer' } = {}) {
  if (typeof subjectId !== 'string' || !subjectId.trim()) throw new Error('[auth] subjectId is required');
  if (tenantId !== null && tenantId !== undefined && (typeof tenantId !== 'string' || !tenantId.trim())) throw new Error('[auth] tenantId must be a non-empty string or null');
  if (!Array.isArray(roles) || !roles.length || roles.some((role) => !ROLES.has(role))) throw new Error('[auth] principal roles are invalid');
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || !scope)) throw new Error('[auth] principal scopes are invalid');
  return Object.freeze({ subjectId, tenantId: tenantId ?? null, roles: Object.freeze([...new Set(roles)]), scopes: Object.freeze([...new Set(scopes)]), authType });
}

export function hasRole(principal, ...roles) {
  return roles.some((role) => principal?.roles?.includes(role));
}

export function hasScope(principal, scope) {
  return principal?.roles?.includes('admin') || principal?.scopes?.includes(scope) || principal?.scopes?.includes('*');
}
