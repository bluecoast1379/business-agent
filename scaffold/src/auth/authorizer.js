import { hasRole, hasScope } from './principal.js';

export class AuthorizationError extends Error {
  constructor(message, code = 'FORBIDDEN') {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
    this.statusCode = code === 'UNAUTHENTICATED' ? 401 : 403;
  }
}

export function authorize(principal, { roles = [], scopes = [], tenantId, allowCrossTenant = false } = {}) {
  if (!principal) throw new AuthorizationError('Authentication required', 'UNAUTHENTICATED');
  if (roles.length && !hasRole(principal, ...roles)) throw new AuthorizationError('Role is not allowed');
  for (const scope of scopes) if (!hasScope(principal, scope)) throw new AuthorizationError(`Missing scope: ${scope}`);
  if (tenantId !== undefined && tenantId !== null && principal.tenantId !== tenantId) {
    if (!(allowCrossTenant && hasRole(principal, 'admin', 'operator', 'auditor'))) throw new AuthorizationError('Cross-tenant access denied');
  }
  return true;
}

export function createRouteAuthorizer(policies = {}) {
  return {
    authorize(principal, route, context = {}) {
      const policy = policies[route];
      if (!policy) throw new AuthorizationError(`No route policy for ${route}`);
      return authorize(principal, { ...policy, ...context });
    },
  };
}
