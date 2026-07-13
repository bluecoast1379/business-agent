/**
 * Brewline interactive assistant (demo agent).
 * The system prompt is assembled ON EVERY REQUEST:
 *  - the current date is evaluated at call time (never at module load), and
 *  - the business glossary is read from src/knowledge/glossary.md at runtime,
 *    so editing that file changes agent behavior without a restart.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgent } from '../runtime/agent.js';

const GLOSSARY_PATH = fileURLToPath(new URL('../knowledge/glossary.md', import.meta.url));

function loadGlossary() {
  try {
    return readFileSync(GLOSSARY_PATH, 'utf8');
  } catch {
    return '(glossary file missing: src/knowledge/glossary.md)';
  }
}

/** Build the system prompt fresh for one request. */
export function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10); // evaluated per request
  return [
    'You are the Brewline operations assistant. Brewline is a fictional specialty',
    'coffee bean B2B supplier; its customers are cafes. You help internal staff with',
    'orders, invoices/receivables, supplier performance, and deliveries.',
    '',
    `Current date: ${today}.`,
    '',
    'Capabilities: query customers/orders/invoices/suppliers/deliveries through the',
    'provided tools; create credit notes (write operation, human-confirmed).',
    '',
    'Business glossary (authoritative wording for this domain):',
    '---',
    loadGlossary(),
    '---',
    '',
    'Rules:',
    '- Ground every number in a tool result; never invent figures.',
    '- Prefer summary-mode tools; use query_raw_data only when summaries cannot answer.',
    '- Write tools are two-phase: when a tool returns pendingConfirmation, relay the',
    '  summary and confirmToken to the user, and only call again with the token after',
    '  the user explicitly approves. Never fabricate or reuse tokens.',
    '- If a request is outside Brewline operations, say so briefly.',
    '- Answer in the language the user writes in.',
  ].join('\n');
}

/**
 * Create the interactive assistant agent (session reuse handled by registry).
 */
export function createAssistant({ config, provider, costTracker, tools }) {
  return createAgent({
    name: 'assistant',
    model: config.llmModel,
    systemPrompt: buildSystemPrompt, // function => re-evaluated on every prompt()
    tools,
    maxBudgetUsd: config.budget.maxUsdPerRequest,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    provider,
    costTracker,
    priceTable: config.priceTable,
  });
}
