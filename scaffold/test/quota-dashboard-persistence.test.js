import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DASHBOARD_SESSION_COOKIE,
  QuotaExceededError,
  createDashboardSessionManager,
  createPrincipal,
  createQuotaManager,
} from '../src/auth/index.js';
import { createFileStateStore } from '../src/stores/index.js';
import { createSessionStore } from '../src/runtime/session-store.js';

const WORKER = new URL('./fixtures/quota-dashboard-worker.mjs', import.meta.url);
const principal = createPrincipal({
  subjectId: 'operator-a',
  tenantId: 'shared-tenant',
  roles: ['operator'],
  scopes: ['dashboard:view', 'chat:write'],
});

async function withStateFile(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'business-agent-quota-dashboard-'));
  const filePath = join(directory, 'state.json');
  try {
    return await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== 'ready') return;
      cleanup();
      resolve();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited before ready: ${code}`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function callWorker(child, type, fields = {}) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker timed out: ${type}`));
    }, 10_000);
    const onMessage = (message) => {
      if (message?.type !== 'result' || message.requestId !== requestId) return;
      cleanup();
      resolve(message.result);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited before ${type}: ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send({ type, requestId, ...fields });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 3_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await wait(intervalMs);
  }
}

test('two durable adapters share atomic tenant rate and concurrency quotas', async () => {
  await withStateFile(async (filePath) => {
    const [storeA, storeB] = await Promise.all([
      createFileStateStore({ filePath }),
      createFileStateStore({ filePath }),
    ]);
    try {
      const quotaA = createQuotaManager({ requestsPerMinute: 1, concurrency: 1, stateStore: storeA });
      const quotaB = createQuotaManager({ requestsPerMinute: 1, concurrency: 1, stateStore: storeB });
      const release = await quotaA.enter(principal);
      await assert.rejects(quotaB.enter(principal), (error) => (
        error instanceof QuotaExceededError && error.code === 'CONCURRENCY_LIMIT'
      ));
      await release();
      await assert.rejects(quotaB.enter(principal), (error) => (
        error instanceof QuotaExceededError && error.code === 'RATE_LIMIT'
      ));
      const snapshot = await quotaA.snapshot('shared-tenant');
      assert.equal(snapshot.active, 0);
      assert.equal(snapshot.tokens < 1, true);
      assert.equal(JSON.stringify(await storeA.exportSnapshot()).includes('shared-tenant'), false, 'quota keys and values must pseudonymize tenant identity');
    } finally {
      await Promise.all([storeA.close(), storeB.close()]);
    }
  });
});

test('short durable quota leases heartbeat across adapters and abort when ownership is lost', async () => {
  await withStateFile(async (filePath) => {
    const [storeA, storeB] = await Promise.all([
      createFileStateStore({ filePath }),
      createFileStateStore({ filePath }),
    ]);
    let releaseA;
    let releaseB;
    try {
      const options = {
        requestsPerMinute: 1_000,
        concurrency: 1,
        concurrencyLeaseMs: 180,
        leaseHeartbeatMs: 30,
      };
      const quotaA = createQuotaManager({ ...options, stateStore: storeA });
      const quotaB = createQuotaManager({ ...options, stateStore: storeB });
      releaseA = await quotaA.enter(principal);
      assert.equal(releaseA.signal.aborted, false);
      const initial = (await storeA.list('idempotency', { prefix: 'quota:' })).items[0];

      await wait(450);
      const renewed = (await storeB.list('idempotency', { prefix: 'quota:' })).items[0];
      assert.equal(renewed.value.leases[0].expiresAt > initial.value.leases[0].expiresAt, true);
      await assert.rejects(quotaB.enter(principal), (error) => error.code === 'CONCURRENCY_LIMIT');

      await storeB.transaction(async (tx) => {
        const record = tx.get('idempotency', renewed.key);
        tx.put('idempotency', renewed.key, { ...record.value, leases: [] }, { ifRevision: record.revision });
      });
      await waitFor(() => releaseA.signal.aborted);
      assert.equal(releaseA.signal.reason.code, 'QUOTA_LEASE_LOST');

      releaseB = await quotaB.enter(principal);
      assert.equal(await releaseB(), true);
      releaseB = null;
      assert.equal(await releaseA(), false);
      releaseA = null;
    } finally {
      await releaseA?.().catch(() => {});
      await releaseB?.().catch(() => {});
      await Promise.all([storeA.close(), storeB.close()]);
    }
  });
});

test('durable dashboard sessions and login attempts are shared without persisting cookie secrets', async () => {
  await withStateFile(async (filePath) => {
    const [storeA, storeB] = await Promise.all([
      createFileStateStore({ filePath }),
      createFileStateStore({ filePath }),
    ]);
    try {
      const dashboardA = createDashboardSessionManager({ stateStore: storeA, maxLoginAttemptsPerMinute: 2 });
      const dashboardB = createDashboardSessionManager({ stateStore: storeB, maxLoginAttemptsPerMinute: 2 });
      const token = await dashboardA.create(principal);
      const cookie = `${DASHBOARD_SESSION_COOKIE}=${token}`;
      assert.equal((await dashboardB.authenticateCookie(cookie)).subjectId, principal.subjectId);

      assert.equal(await dashboardA.allowLoginAttempt('203.0.113.8'), true);
      assert.equal(await dashboardB.allowLoginAttempt('203.0.113.8'), true);
      assert.equal(await dashboardA.allowLoginAttempt('203.0.113.8'), false);

      const snapshot = await storeB.exportSnapshot();
      const serialized = JSON.stringify(snapshot);
      assert.equal(serialized.includes(token), false, 'raw cookie token must never reach durable state');
      assert.equal(serialized.includes('203.0.113.8'), false, 'login-attempt keys must not retain raw network identifiers');
      const session = snapshot.namespaces.session.find((record) => record.key.startsWith('dashboard-session:'));
      assert.deepEqual(Object.keys(session.value).sort(), ['digest', 'expiresAt', 'principal']);
      assert.equal(session.value.digest, createHash('sha256').update(token).digest('hex'));
      assert.equal(session.key.includes(token), false);

      // Chat-session TTL maintenance must not treat browser-auth records as
      // conversation records or remove them from the shared namespace.
      const chatSessions = createSessionStore({ stateStore: storeA, ttlMs: 1_000, now: () => Date.now() + 60_000 });
      assert.equal(await chatSessions.sweep(), 0);
      assert.equal((await dashboardB.authenticateCookie(cookie)).subjectId, principal.subjectId);
      chatSessions.close();

      assert.equal(await dashboardB.revokeCookie(cookie), true);
      assert.equal(await dashboardA.authenticateCookie(cookie), null);
    } finally {
      await Promise.all([storeA.close(), storeB.close()]);
    }
  });
});

test('separate OS processes share quota leases and dashboard authentication/revocation', async () => {
  await withStateFile(async (filePath) => {
    const children = ['a', 'b'].map((name) => fork(WORKER, [filePath, name], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }));
    try {
      await Promise.all(children.map(waitReady));
      const entered = await Promise.all(children.map((child) => callWorker(child, 'quota.enter')));
      assert.equal(entered.filter((result) => result.ok).length, 1);
      assert.equal(entered.filter((result) => result.code === 'CONCURRENCY_LIMIT').length, 1);
      const winnerIndex = entered.findIndex((result) => result.ok);
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      assert.equal((await callWorker(children[winnerIndex], 'quota.release')).ok, true);
      assert.equal((await callWorker(children[loserIndex], 'quota.enter')).ok, true);
      assert.equal((await callWorker(children[loserIndex], 'quota.release')).ok, true);

      const { token } = await callWorker(children[0], 'dashboard.create');
      const cookie = `${DASHBOARD_SESSION_COOKIE}=${token}`;
      assert.equal((await callWorker(children[1], 'dashboard.authenticate', { cookie })).subjectId, 'operator-a');
      assert.equal((await callWorker(children[1], 'dashboard.revoke', { cookie })).revoked, true);
      assert.equal((await callWorker(children[0], 'dashboard.authenticate', { cookie })).subjectId, null);
      assert.equal((await readFile(filePath, 'utf8')).includes(token), false);
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.connected) await callWorker(child, 'close').catch(() => {});
        if (child.exitCode === null) child.kill('SIGKILL');
      }));
    }
  });
});
