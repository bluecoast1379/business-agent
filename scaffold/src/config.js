/**
 * Environment-driven configuration with fail-fast validation.
 * No built-in secrets, no internal hostnames: every sensitive value must
 * come from the environment, and missing required values throw immediately
 * with a fix hint instead of falling back to something "usable".
 */

const VALID_PROVIDERS = ['anthropic', 'mock'];

function readEnv(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function fail(lines) {
  throw new Error(`[config] ${lines.join(' ')}`);
}

function readNumber(name, fallback) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    fail([`${name}="${raw}" is not a number.`, `Fix: set ${name} to a numeric value or unset it to use the default (${fallback}).`]);
  }
  return n;
}

/** Load and validate configuration from process.env. Throws on invalid setup. */
export function loadConfig() {
  const provider = readEnv('LLM_PROVIDER');
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    fail([
      `LLM_PROVIDER is required and must be one of: ${VALID_PROVIDERS.join('|')} (got: ${provider ?? '<unset>'}).`,
      'Fix: cp .env.example .env, then set LLM_PROVIDER=mock for a local demo,',
      'or LLM_PROVIDER=anthropic (plus LLM_API_KEY) for the real API.',
    ]);
  }

  const llmApiKey = readEnv('LLM_API_KEY');
  if (provider === 'anthropic' && !llmApiKey) {
    fail([
      'LLM_API_KEY is required when LLM_PROVIDER=anthropic.',
      'Fix: set LLM_API_KEY in .env (never commit it; .env is gitignored).',
      'To run without a key, use LLM_PROVIDER=mock.',
    ]);
  }

  const gatewayAuthToken = readEnv('GATEWAY_AUTH_TOKEN');
  if (!gatewayAuthToken) {
    fail([
      'GATEWAY_AUTH_TOKEN is required: it protects every endpoint except GET /health.',
      'Fix: set GATEWAY_AUTH_TOKEN in .env, e.g. generate one with `openssl rand -hex 24`.',
    ]);
  }

  let priceTable = {};
  const priceTableRaw = readEnv('LLM_PRICE_TABLE_JSON');
  if (priceTableRaw) {
    try {
      priceTable = JSON.parse(priceTableRaw);
    } catch {
      fail(['LLM_PRICE_TABLE_JSON is not valid JSON.', 'Fix: e.g. {"claude-sonnet-4-6":{"inputPerMTok":3,"outputPerMTok":15}}']);
    }
    // Malformed entries would otherwise cost-compute to NaN and silently
    // disable both budget guards -- reject them at boot instead.
    for (const [model, entry] of Object.entries(priceTable)) {
      const badField = ['inputPerMTok', 'outputPerMTok'].find((f) => !Number.isFinite(Number(entry?.[f])));
      if (badField) {
        fail([
          `LLM_PRICE_TABLE_JSON entry "${model}" is missing a numeric "${badField}".`,
          'Fix: every entry needs numeric inputPerMTok and outputPerMTok,',
          'e.g. {"my-model":{"inputPerMTok":3,"outputPerMTok":15}}.',
        ]);
      }
    }
  }

  const llmModel = readEnv('LLM_MODEL') ?? 'claude-sonnet-4-6';

  return Object.freeze({
    provider,
    llmApiKey,
    // Public Anthropic API endpoint (not an internal address); override via env.
    llmBaseUrl: readEnv('LLM_BASE_URL') ?? 'https://api.anthropic.com',
    llmModel,
    llmComplexModel: readEnv('LLM_COMPLEX_MODEL') ?? llmModel,
    maxTurns: readNumber('LLM_MAX_TURNS', 8),
    maxTokens: readNumber('LLM_MAX_TOKENS', 1024),
    priceTable,
    gatewayAuthToken,
    host: readEnv('HOST') ?? '127.0.0.1',
    port: readNumber('PORT', 3000), // PORT=0 means "let the OS pick a free port"
    budget: Object.freeze({
      maxUsdPerRequest: readNumber('BUDGET_MAX_USD_PER_REQUEST', 0.5),
      monthlyUsd: readNumber('BUDGET_MONTHLY_USD', 50),
    }),
    sessionTtlMinutes: readNumber('SESSION_TTL_MINUTES', 30),
    backendUrl: readEnv('BACKEND_URL'),
    backendApiKey: readEnv('BACKEND_API_KEY'),
    webhookSecret: readEnv('WEBHOOK_SECRET'),
    notifyWebhookUrl: readEnv('NOTIFY_WEBHOOK_URL'),
    patrol: Object.freeze({
      overdueDays: readNumber('PATROL_OVERDUE_DAYS', 7),
      minOnTimeRate: readNumber('PATROL_MIN_ONTIME_RATE', 0.9),
    }),
  });
}
