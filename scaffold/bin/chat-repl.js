#!/usr/bin/env node
/**
 * CLI REPL: talks straight to registry.handleMessage (no HTTP port opened).
 * Works fully offline with LLM_PROVIDER=mock:
 *   LLM_PROVIDER=mock node bin/chat-repl.js
 */
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

// The REPL never opens a port, so the gateway token is unused here; inject a
// random throwaway value only to satisfy fail-fast config when it is unset.
process.env.GATEWAY_AUTH_TOKEN ??= `repl-local-${randomUUID()}`;

const { loadConfig } = await import('../src/config.js');
const { createProvider } = await import('../src/runtime/llm.js');
const { createCostTracker } = await import('../src/runtime/cost-tracker.js');
const { createSessionStore } = await import('../src/runtime/session-store.js');
const { buildRegistry } = await import('../src/agents/registry.js');
const { createConfirmationCenter } = await import('../src/guardrails/confirm-gate.js');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const provider = createProvider(config);
const costTracker = createCostTracker();
const sessionStore = createSessionStore({ ttlMs: config.sessionTtlMinutes * 60_000 });
// In the REPL the person at the keyboard IS the human operator: /approve <id>
// is their out-of-band approval channel for pending write confirmations.
const confirmations = createConfirmationCenter();
const registry = buildRegistry({ config, provider, costTracker, sessionStore, confirmations });
const sessionId = `repl-${Date.now()}`;

console.log(`agent-gateway REPL | provider=${provider.name} model=${config.llmModel}`);
console.log('Commands: /cost, /confirmations, /approve <id>, /reject <id>, /exit. Try: "top customers".');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
rl.prompt();

// Async iteration keeps line handling sequential, so piped input
// (e.g. `printf 'top customers\n/exit\n' | npm run chat`) works too.
for await (const line of rl) {
  const input = line.trim();
  if (input === '/exit' || input === '/quit') break;
  if (input === '/cost') {
    console.log(JSON.stringify(costTracker.summary(), null, 2));
  } else if (input === '/confirmations') {
    console.log(JSON.stringify(confirmations.list(), null, 2));
  } else if (input.startsWith('/approve ') || input.startsWith('/reject ')) {
    const [cmd, id] = input.split(/\s+/);
    const outcome = cmd === '/approve' ? confirmations.approve(id) : confirmations.reject(id);
    console.log(JSON.stringify(outcome));
  } else if (input) {
    try {
      const result = await registry.handleMessage(sessionId, input);
      console.log(`agent> ${result.text}`);
      console.log(`(cost this turn: $${(result.costUsd ?? 0).toFixed(4)})`);
    } catch (err) {
      console.error(`error> ${err.message}`);
    }
  }
  rl.prompt();
}

rl.close();
sessionStore.close();
console.log('bye');
