/**
 * Boot sequence: loadConfig -> buildRegistry -> startHttp -> startScheduler.
 * On success prints exactly one line to stdout: `listening on <port>`
 * (with PORT=0 the OS-assigned real port is printed) - external smoke checks
 * parse that line, do not change its format.
 */
import { loadConfig } from './config.js';
import { createProvider } from './runtime/llm.js';
import { createCostTracker } from './runtime/cost-tracker.js';
import { createSessionStore } from './runtime/session-store.js';
import { createScheduler } from './runtime/scheduler.js';
import { buildRegistry } from './agents/registry.js';
import { createHttpServer } from './channels/http.js';
import { createWebhookHandler } from './channels/webhook.js';
import { createConfirmationCenter } from './guardrails/confirm-gate.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    console.error('[gateway] boot aborted: fix the configuration above and retry.');
    process.exit(1);
  }

  const provider = createProvider(config);
  const costTracker = createCostTracker();
  const sessionStore = createSessionStore({ ttlMs: config.sessionTtlMinutes * 60_000 });
  const confirmations = createConfirmationCenter();
  const registry = buildRegistry({ config, provider, costTracker, sessionStore, confirmations });

  const scheduler = createScheduler({ costTracker, monthlyBudgetUsd: config.budget.monthlyUsd });
  for (const job of registry.jobs) scheduler.registerJob(job);
  scheduler.start();

  const webhookHandler = config.webhookSecret
    ? createWebhookHandler({ secret: config.webhookSecret, handleMessage: registry.handleMessage })
    : null;

  const server = createHttpServer({
    config,
    handleMessage: registry.handleMessage,
    scheduler,
    costTracker,
    sessionStore,
    webhookHandler,
    confirmations,
  });

  server.listen(config.port, config.host, () => {
    const { port } = server.address();
    console.log(`listening on ${port}`); // exact format consumed by smoke checks
    console.error(`[gateway] provider=${provider.name} model=${config.llmModel} host=${config.host} jobs=[${registry.jobs.map((j) => j.name).join(', ')}]`);
  });

  function shutdown(signal) {
    console.error(`[gateway] ${signal} received, shutting down`);
    scheduler.stop();
    sessionStore.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
