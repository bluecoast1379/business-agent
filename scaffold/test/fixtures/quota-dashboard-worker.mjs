import { createDashboardSessionManager, createPrincipal, createQuotaManager } from '../../src/auth/index.js';
import { createFileStateStore } from '../../src/stores/index.js';

const [filePath, workerId] = process.argv.slice(2);
const stateStore = await createFileStateStore({ filePath });
const principal = createPrincipal({
  subjectId: `operator-${workerId}`,
  tenantId: 'shared-tenant',
  roles: ['operator'],
  scopes: ['dashboard:view', 'chat:write'],
});
const quota = createQuotaManager({
  requestsPerMinute: 100,
  concurrency: 1,
  concurrencyLeaseMs: 60_000,
  stateStore,
});
const dashboard = createDashboardSessionManager({ stateStore, maxLoginAttemptsPerMinute: 2 });
let releaseQuota = null;

function reply(message, result) {
  process.send?.({ type: 'result', requestId: message.requestId, result });
}

process.on('message', async (message) => {
  try {
    if (message?.type === 'quota.enter') {
      releaseQuota = await quota.enter(principal);
      reply(message, { ok: true });
    } else if (message?.type === 'quota.release') {
      reply(message, { ok: await releaseQuota?.() ?? false });
      releaseQuota = null;
    } else if (message?.type === 'dashboard.create') {
      reply(message, { token: await dashboard.create(principal) });
    } else if (message?.type === 'dashboard.authenticate') {
      const authenticated = await dashboard.authenticateCookie(message.cookie);
      reply(message, { subjectId: authenticated?.subjectId ?? null });
    } else if (message?.type === 'dashboard.revoke') {
      reply(message, { revoked: await dashboard.revokeCookie(message.cookie) });
    } else if (message?.type === 'close') {
      await releaseQuota?.();
      await stateStore.close();
      reply(message, { closed: true });
      process.disconnect?.();
    }
  } catch (error) {
    process.send?.({
      type: 'result',
      requestId: message?.requestId,
      result: { ok: false, code: error.code ?? error.name, statusCode: error.statusCode ?? null },
    });
  }
});

process.send?.({ type: 'ready' });
