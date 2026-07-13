/**
 * Agent runtime: the tool-call loop around a provider.
 *  - capped by maxTurns;
 *  - every turn's usage is reported to the cost tracker (wired, not decorative);
 *  - when the per-request budget (maxBudgetUsd) is exceeded, the loop stops and
 *    returns whatever content was produced so far, plus a notice.
 */
import { computeCostUsd } from './llm.js';
import { validateArgs } from './tool.js';

function stringifyResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

async function executeToolCall(tools, call) {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { content: `Error: unknown tool "${call.name}"`, isError: true };
  const { ok, errors } = validateArgs(tool, call.args);
  if (!ok) return { content: `Error: invalid arguments: ${errors.join('; ')}`, isError: true };
  try {
    const result = await tool.handler(call.args ?? {});
    return { content: stringifyResult(result), isError: false };
  } catch (err) {
    return { content: `Error: ${err.message}`, isError: true };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.model
 * @param {string|(() => string)} opts.systemPrompt - a function is re-evaluated on
 *   every prompt() call (so dates / runtime-loaded knowledge stay fresh).
 * @param {Array} [opts.tools]
 * @param {number} [opts.maxBudgetUsd] - per-request budget cap
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxTokens]
 * @param {object} opts.provider
 * @param {object} opts.costTracker
 * @param {object} [opts.priceTable]
 * @returns {{ name: string, prompt: (text: string, opts?: {sessionMessages?: Array}) => Promise<{text, messages, costUsd, turns}> }}
 */
export function createAgent({
  name,
  model,
  systemPrompt,
  tools = [],
  maxBudgetUsd = 0.5,
  maxTurns = 8,
  maxTokens = 1024,
  provider,
  costTracker,
  priceTable = {},
}) {
  if (!provider) throw new Error('[agent] provider is required');

  async function prompt(text, { sessionMessages = [] } = {}) {
    // System prompt is assembled per request, never at module load time.
    const system = typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt;
    const messages = [...sessionMessages, { role: 'user', content: text }];
    const partials = [];
    let spentUsd = 0;
    let turns = 0;

    while (turns < maxTurns) {
      turns += 1;
      const res = await provider.complete({ model, system, messages, tools, maxTokens });

      const costUsd = computeCostUsd(model, res.usage, priceTable);
      spentUsd += costUsd;
      costTracker?.trackUsage({ agent: name, model, usage: res.usage, costUsd });

      const wantsTools = res.stopReason === 'tool_use' && res.toolCalls?.length > 0;

      if (!wantsTools) {
        const finalText = res.text || '(no content)';
        messages.push({ role: 'assistant', content: finalText });
        return { text: finalText, messages, costUsd: spentUsd, turns };
      }

      if (res.text) partials.push(res.text);

      // Record the assistant tool_use turn, run every tool, feed results back.
      const assistantContent = [];
      if (res.text) assistantContent.push({ type: 'text', text: res.text });
      for (const call of res.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const results = [];
      for (const call of res.toolCalls) {
        const { content, isError } = await executeToolCall(tools, call);
        const block = { type: 'tool_result', tool_use_id: call.id, content };
        if (isError) block.is_error = true;
        results.push(block);
      }
      messages.push({ role: 'user', content: results });

      if (spentUsd >= maxBudgetUsd) {
        const notice = `[notice] Request budget reached ($${spentUsd.toFixed(4)} of $${maxBudgetUsd}). Stopping here; partial results only.`;
        const textOut = [...partials, notice].join('\n\n');
        messages.push({ role: 'assistant', content: textOut });
        return { text: textOut, messages, costUsd: spentUsd, turns };
      }
    }

    const notice = `[notice] Reached max turns (${maxTurns}) before finishing. Partial results only.`;
    const textOut = [...partials, notice].join('\n\n');
    messages.push({ role: 'assistant', content: textOut });
    return { text: textOut, messages, costUsd: spentUsd, turns };
  }

  return { name, prompt };
}
