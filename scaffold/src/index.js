/**
 * Boot sequence: loadConfig -> buildRegistry -> startHttp -> startScheduler.
 * On success prints exactly one line to stdout: `listening on <port>`
 * (with PORT=0 the OS-assigned real port is printed) - external smoke checks
 * parse that line, do not change its format.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createProvider } from './runtime/llm.js';
import { createCostTracker } from './runtime/cost-tracker.js';
import { createSessionStore } from './runtime/session-store.js';
import { buildRegistry } from './agents/registry.js';
import { createHttpServer } from './channels/http.js';
import { createWebhookHandler, createWebhookReplayStore } from './channels/webhook.js';
import { createConfirmationCenter } from './guardrails/confirm-gate.js';
import { createAuthenticator, createDashboardSessionManager, createPrincipal, createQuotaManager } from './auth/index.js';
import { createFileStateStore, createMemoryStateStore } from './stores/index.js';
import { createDurableScheduler, createLocalScheduler } from './schedulers/index.js';
import { createDeadLetterQueue, createExecutor, createIdempotencyStore } from './runtime/execution/index.js';
import { createAuditLog, createOtlpHttpJsonSink, createTelemetry } from './observability/index.js';
import {
  createDashboardReadModelProvider,
  createRuntimeDashboardSources,
  handleDashboardRequest,
} from './dashboard/index.js';

async function createStateStore(config) {
  if (config.state.adapter === 'file') return createFileStateStore({ filePath: config.state.filePath });
  return createMemoryStateStore();
}

export async function startGateway({ config = loadConfig(), logger = console } = {}) {
  const startedAt = Date.now();
  const stateStore = await createStateStore(config);
  let server;
  let scheduler;
  let sessionStore;
  let telemetry;
  let audit;
  let closed = false;

  try {
    const authenticator = createAuthenticator({
      principals: config.authPrincipals,
      legacyAdminToken: config.gatewayAuthToken,
    });
    const quotaManager = createQuotaManager({ ...config.quota, stateStore });
    const dashboardSessions = createDashboardSessionManager({ stateStore });
    const sink = config.telemetry.enabled
      ? createOtlpHttpJsonSink({ endpoint: config.telemetry.endpoint })
      : undefined;
    telemetry = createTelemetry({
      enabled: config.telemetry.enabled,
      ...(sink ? { sink } : {}),
      onExporterError: ({ code }) => logger.error?.(`[telemetry] export failed code=${code}`),
    });
    audit = createAuditLog({ stateStore, maxRecords: config.audit?.maxRecords ?? 10_000 });
    const idempotency = createIdempotencyStore({
      stateStore,
      maxRecords: config.idempotency?.maxRecords ?? 10_000,
      resultRetentionMs: (config.idempotency?.resultRetentionSeconds ?? 300) * 1_000,
    });
    // Enforce short-lived result retention on restart even when one-shot keys
    // are never requested again. Tombstone/digest evidence remains intact.
    await idempotency.compactExpired();
    const executor = createExecutor({
      idempotency,
      deadLetters: createDeadLetterQueue({ stateStore }),
      onEvent(event) {
        const phase = event.type.split('.').at(-1);
        void telemetry.recordMetric(`execution.${phase}`, 1, {
          operation: event.name,
          outcome: phase,
          errorClass: event.code,
          attempt: event.attempts,
        });
      },
    });
    const provider = createProvider(config);
    const costTracker = createCostTracker({
      stateStore,
      reservationTtlMs: (config.budget.reservationTtlSeconds ?? 7_200) * 1_000,
    });
    sessionStore = createSessionStore({ stateStore, ttlMs: config.sessionTtlMinutes * 60_000 });
    const confirmations = createConfirmationCenter({ stateStore });
    const registry = buildRegistry({ config, provider, costTracker, sessionStore, confirmations, executor, telemetry, audit });

    scheduler = config.schedulerAdapter === 'durable'
      ? createDurableScheduler({
          stateStore,
          costTracker,
          monthlyBudgetUsd: config.budget.monthlyUsd,
          audit,
          logger,
        })
      : createLocalScheduler({ costTracker, monthlyBudgetUsd: config.budget.monthlyUsd, audit, logger });
    for (const job of registry.jobs) scheduler.registerJob(job);
    scheduler.start();

    const webhookPrincipal = config.webhookSecret ? createPrincipal(config.webhook.principal) : null;
    const webhookReplayStore = config.webhookSecret
      ? createWebhookReplayStore({
          stateStore,
          maxRecords: config.webhook.replayMaxRecords ?? 10_000,
        })
      : null;
    const webhookHandler = config.webhookSecret
      ? createWebhookHandler({
          secret: config.webhookSecret,
          integrationId: config.webhook.integrationId,
          principal: webhookPrincipal,
          replayStore: webhookReplayStore,
          replayTtlSeconds: config.webhook.replayTtlSeconds,
          quotaManager,
          audit,
          handleMessage: registry.handleMessage,
        })
      : null;

    const dashboardSources = createRuntimeDashboardSources({
      config,
      stateStore,
      sessionStore,
      costTracker,
      confirmations,
      scheduler,
      audit,
      startedAt,
    });
    const dashboardReadModel = createDashboardReadModelProvider({
      sources: dashboardSources,
      telemetryEnabled: telemetry.enabled,
      environment: config.runtimeProfile,
    });
    const dashboardHandler = config.dashboard.enabled
      ? (req, res, context) => handleDashboardRequest(req, res, {
          ...context,
          readModelProvider: dashboardReadModel,
          telemetryEnabled: telemetry.enabled,
          environment: config.runtimeProfile,
        })
      : null;

    server = createHttpServer({
      config,
      handleMessage: registry.handleMessage,
      scheduler,
      costTracker,
      sessionStore,
      webhookHandler,
      webhookReplayStore,
      webhookIntegrationId: config.webhookSecret ? config.webhook.integrationId : null,
      idempotency,
      confirmations,
      authenticator,
      quotaManager,
      telemetry,
      audit,
      dashboardHandler,
      dashboardSessions,
      stateStore,
    });

    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    const { port } = server.address();
    console.log(`listening on ${port}`); // exact format consumed by smoke checks
    logger.error?.(`[gateway] profile=${config.runtimeProfile} provider=${provider.name} state=${stateStore.adapterName} scheduler=${scheduler.adapterName} jobs=[${registry.jobs.map((job) => job.name).join(', ')}]`);

    async function close() {
      if (closed) return;
      closed = true;
      await scheduler.stop();
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
      await sessionStore.close?.();
      await audit.flush?.();
      await telemetry.flush?.();
      await telemetry.shutdown?.();
      await stateStore.close();
    }

    return Object.freeze({
      config,
      server,
      stateStore,
      scheduler,
      registry,
      costTracker,
      sessionStore,
      confirmations,
      telemetry,
      audit,
      close,
    });
  } catch (error) {
    await scheduler?.stop?.();
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await sessionStore?.close?.();
    await audit?.flush?.().catch?.(() => {});
    await telemetry?.shutdown?.().catch?.(() => {});
    await stateStore.close().catch(() => {});
    throw error;
  }
}

async function main() {
  let gateway;
  try {
    gateway = await startGateway();
  } catch (error) {
    console.error(error.message);
    console.error('[gateway] boot aborted: fix the configuration above and retry.');
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[gateway] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 3_000);
    force.unref?.();
    try {
      await gateway.close();
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      console.error(`[gateway] shutdown failed code=${error.code ?? error.name ?? 'ERROR'}`);
      process.exit(1);
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
