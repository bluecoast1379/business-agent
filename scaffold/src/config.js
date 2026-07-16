/**
 * Environment-driven configuration with fail-fast validation.
 * No built-in secrets, no internal hostnames: every sensitive value must
 * come from the environment, and missing required values throw immediately
 * with a fix hint instead of falling back to something "usable".
 */

const VALID_PROVIDERS = ['anthropic', 'openai-compatible', 'mock'];
const VALID_PROFILES = ['development', 'production'];
const VALID_STATE_ADAPTERS = ['memory', 'file'];
const VALID_SCHEDULERS = ['local', 'durable'];
const VALID_ROLES = new Set(['caller', 'operator', 'admin', 'service', 'auditor']);

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

function readRange(name, fallback, { min, max, integer = false } = {}) {
  const value = readNumber(name, fallback);
  if ((integer && !Number.isInteger(value)) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    const bounds = `${min !== undefined ? `>= ${min}` : ''}${min !== undefined && max !== undefined ? ' and ' : ''}${max !== undefined ? `<= ${max}` : ''}`;
    fail([`${name} must be ${integer ? 'an integer ' : ''}${bounds} (got: ${value}).`]);
  }
  return value;
}

function readHttpUrl(name, fallback) {
  const value = readEnv(name) ?? fallback;
  let url;
  try { url = new URL(value); } catch { fail([`${name} must be an absolute http(s) URL.`]); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail([`${name} must be an http(s) URL without credentials, query, or fragment.`]);
  }
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
}

function requireProductionTlsUrl(name, value, runtimeProfile) {
  if (!value || runtimeProfile !== 'production') return;
  const url = new URL(value);
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    fail([`${name} must use https in production unless it is a loopback endpoint.`]);
  }
}

function readBoolean(name, fallback = false) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail([`${name} must be true or false (got: ${raw}).`]);
}

function readJson(name, fallback) {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { fail([`${name} is not valid JSON.`]); }
}

function readEnum(name, values, fallback) {
  const value = readEnv(name) ?? fallback;
  if (!values.includes(value)) fail([`${name} must be one of: ${values.join('|')} (got: ${value}).`]);
  return value;
}

function validatePrincipal(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail([`${label} must be an object.`]);
  if (typeof value.subjectId !== 'string' || !value.subjectId.trim()) fail([`${label}.subjectId is required.`]);
  if (value.tenantId !== null && value.tenantId !== undefined && (typeof value.tenantId !== 'string' || !value.tenantId.trim())) fail([`${label}.tenantId must be a non-empty string or null.`]);
  if (!Array.isArray(value.roles) || !value.roles.length || value.roles.some((role) => !VALID_ROLES.has(role))) fail([`${label}.roles contains an unsupported role.`]);
  if (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== 'string' || !scope)) fail([`${label}.scopes must be an array of non-empty strings.`]);
}

/** Load and validate configuration from process.env. Throws on invalid setup. */
export function loadConfig() {
  const runtimeProfile = readEnum('RUNTIME_PROFILE', VALID_PROFILES, 'development');
  const provider = readEnv('LLM_PROVIDER');
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    fail([
      `LLM_PROVIDER is required and must be one of: ${VALID_PROVIDERS.join('|')} (got: ${provider ?? '<unset>'}).`,
      'Fix: cp .env.example .env, then set LLM_PROVIDER=mock for a local demo,',
      'or LLM_PROVIDER=anthropic|openai-compatible (plus LLM_API_KEY) for a real API.',
    ]);
  }
  if (runtimeProfile === 'production' && provider === 'mock') {
    fail(['LLM_PROVIDER=mock is development-only; production requires anthropic or openai-compatible.']);
  }

  const llmApiKey = readEnv('LLM_API_KEY');
  if (provider === 'anthropic' && !llmApiKey) {
    fail([
      'LLM_API_KEY is required when LLM_PROVIDER=anthropic.',
      'Fix: set LLM_API_KEY in .env (never commit it; .env is gitignored).',
      'To run without a key, use LLM_PROVIDER=mock.',
    ]);
  }

  const llmBaseUrl = readHttpUrl('LLM_BASE_URL', provider === 'openai-compatible' ? 'https://api.openai.com' : 'https://api.anthropic.com');
  const llmUrl = new URL(llmBaseUrl);
  requireProductionTlsUrl('LLM_BASE_URL', llmUrl.toString(), runtimeProfile);
  if (provider === 'openai-compatible' && runtimeProfile === 'production' && !llmApiKey) {
    fail(['LLM_API_KEY is required for openai-compatible in production profile.', 'Use development profile for an unauthenticated local stub.']);
  }

  const gatewayAuthToken = readEnv('GATEWAY_AUTH_TOKEN');
  if (gatewayAuthToken && gatewayAuthToken.length < 12) fail(['GATEWAY_AUTH_TOKEN must be at least 12 characters.']);
  const authPrincipals = readJson('AUTH_PRINCIPALS_JSON', []);
  if (!Array.isArray(authPrincipals)) fail(['AUTH_PRINCIPALS_JSON must be an array.']);
  const principalTokens = new Set();
  for (const [index, entry] of authPrincipals.entries()) {
    if (typeof entry?.token !== 'string' || entry.token.length < 12) fail([`AUTH_PRINCIPALS_JSON[${index}].token must be at least 12 characters.`]);
    if (principalTokens.has(entry.token)) fail(['AUTH_PRINCIPALS_JSON contains a duplicate credential.']);
    principalTokens.add(entry.token);
    validatePrincipal(entry.principal, `AUTH_PRINCIPALS_JSON[${index}].principal`);
  }
  if (!gatewayAuthToken && authPrincipals.length === 0) {
    fail([
      'GATEWAY_AUTH_TOKEN is required: it protects every endpoint except GET /health.',
      'Fix: set GATEWAY_AUTH_TOKEN in .env, e.g. generate one with `openssl rand -hex 24`.',
    ]);
  }
  if (runtimeProfile === 'production' && authPrincipals.length === 0) {
    fail(['AUTH_PRINCIPALS_JSON is required in production; GATEWAY_AUTH_TOKEN is only a legacy admin migration credential.']);
  }

  const stateAdapter = readEnum('STATE_ADAPTER', VALID_STATE_ADAPTERS, 'memory');
  const schedulerAdapter = readEnum('SCHEDULER_ADAPTER', VALID_SCHEDULERS, stateAdapter === 'memory' ? 'local' : 'durable');
  if (runtimeProfile === 'production' && stateAdapter === 'memory') fail(['STATE_ADAPTER=file is required in production profile.']);
  if (runtimeProfile === 'production' && schedulerAdapter === 'local') fail(['SCHEDULER_ADAPTER=durable is required in production profile.']);

  const telemetryEnabled = readBoolean('TELEMETRY_ENABLED', false);
  const telemetryEndpointRaw = readEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (telemetryEnabled && !telemetryEndpointRaw) fail(['OTEL_EXPORTER_OTLP_ENDPOINT is required when TELEMETRY_ENABLED=true.']);
  const telemetryEndpoint = telemetryEndpointRaw ? readHttpUrl('OTEL_EXPORTER_OTLP_ENDPOINT') : undefined;
  requireProductionTlsUrl('OTEL_EXPORTER_OTLP_ENDPOINT', telemetryEndpoint, runtimeProfile);
  const notifyWebhookUrlRaw = readEnv('NOTIFY_WEBHOOK_URL');
  const notifyWebhookUrl = notifyWebhookUrlRaw ? readHttpUrl('NOTIFY_WEBHOOK_URL') : undefined;
  requireProductionTlsUrl('NOTIFY_WEBHOOK_URL', notifyWebhookUrl, runtimeProfile);

  const quotaRequestsPerMinute = readRange('QUOTA_REQUESTS_PER_MINUTE', 60, { min: 1, max: 1_000_000, integer: true });
  const quotaConcurrency = readRange('QUOTA_CONCURRENCY', 8, { min: 1, max: 100_000, integer: true });
  const quotaTenantOverrides = readJson('QUOTA_TENANT_OVERRIDES_JSON', {});
  if (!quotaTenantOverrides || typeof quotaTenantOverrides !== 'object' || Array.isArray(quotaTenantOverrides)) {
    fail(['QUOTA_TENANT_OVERRIDES_JSON must be an object keyed by tenant id.']);
  }
  for (const [tenantId, limits] of Object.entries(quotaTenantOverrides)) {
    if (!tenantId || !limits || typeof limits !== 'object' || Array.isArray(limits)) fail(['QUOTA_TENANT_OVERRIDES_JSON contains an invalid tenant entry.']);
    for (const field of ['requestsPerMinute', 'concurrency']) {
      if (limits[field] !== undefined && (!Number.isInteger(limits[field]) || limits[field] < 1)) {
        fail([`QUOTA_TENANT_OVERRIDES_JSON.${field} must be a positive integer.`]);
      }
    }
  }

  const idempotencyMaxRecords = readRange('IDEMPOTENCY_MAX_RECORDS', 10_000, {
    min: 1,
    max: 1_000_000,
    integer: true,
  });
  const idempotencyResultRetentionSeconds = readRange('IDEMPOTENCY_RESULT_RETENTION_SECONDS', 300, {
    min: 0,
    max: 86_400,
    integer: true,
  });
  const auditMaxRecords = readRange('AUDIT_MAX_RECORDS', 10_000, {
    min: 1,
    max: 1_000_000,
    integer: true,
  });

  const webhookSecret = readEnv('WEBHOOK_SECRET');
  if (webhookSecret && webhookSecret.length < 16) fail(['WEBHOOK_SECRET must be at least 16 characters.']);
  const webhookIntegrationId = readEnv('WEBHOOK_INTEGRATION_ID') ?? 'default';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(webhookIntegrationId)) fail(['WEBHOOK_INTEGRATION_ID must contain 1-64 letters, digits, dots, underscores, or hyphens.']);
  const webhookPrincipalRaw = readJson('WEBHOOK_PRINCIPAL_JSON', undefined);
  if (webhookSecret && runtimeProfile === 'production' && webhookPrincipalRaw === undefined) {
    fail(['WEBHOOK_PRINCIPAL_JSON is required when WEBHOOK_SECRET is enabled in production.']);
  }
  if (webhookPrincipalRaw !== undefined && (!webhookPrincipalRaw || typeof webhookPrincipalRaw !== 'object' || Array.isArray(webhookPrincipalRaw))) {
    fail(['WEBHOOK_PRINCIPAL_JSON must be a principal object.']);
  }
  const webhookPrincipal = webhookPrincipalRaw ?? {
    subjectId: `webhook:${webhookIntegrationId}`,
    tenantId: 'demo-webhook',
    roles: ['caller'],
    scopes: ['chat:write'],
    authType: 'webhook-hmac',
  };
  validatePrincipal(webhookPrincipal, 'WEBHOOK_PRINCIPAL_JSON');

  let priceTable = {};
  const priceTableRaw = readEnv('LLM_PRICE_TABLE_JSON');
  if (priceTableRaw) {
    try {
      priceTable = JSON.parse(priceTableRaw);
    } catch {
      fail(['LLM_PRICE_TABLE_JSON is not valid JSON.', 'Fix: e.g. {"claude-sonnet-4-6":{"inputPerMTok":3,"outputPerMTok":15}}']);
    }
    if (!priceTable || typeof priceTable !== 'object' || Array.isArray(priceTable)) {
      fail(['LLM_PRICE_TABLE_JSON must be an object keyed by model id.']);
    }
    // Malformed entries would otherwise cost-compute to NaN and silently
    // disable both budget guards -- reject them at boot instead.
    for (const [model, entry] of Object.entries(priceTable)) {
      const badField = ['inputPerMTok', 'outputPerMTok'].find((f) => typeof entry?.[f] !== 'number' || !Number.isFinite(entry[f]) || entry[f] < 0);
      if (badField) {
        fail([
          `LLM_PRICE_TABLE_JSON entry "${model}" is missing a numeric "${badField}".`,
          'Fix: every entry needs numeric inputPerMTok and outputPerMTok,',
          'e.g. {"my-model":{"inputPerMTok":3,"outputPerMTok":15}}.',
        ]);
      }
    }
  }

  const configuredModel = readEnv('LLM_MODEL');
  if (provider === 'openai-compatible' && !configuredModel) {
    fail(['LLM_MODEL is required for openai-compatible providers because gateway model ids are deployment-specific.']);
  }
  const llmModel = configuredModel ?? 'claude-sonnet-4-6';
  const llmComplexModel = readEnv('LLM_COMPLEX_MODEL') ?? llmModel;
  if (runtimeProfile === 'production') {
    const missingPrices = [...new Set([llmModel, llmComplexModel])]
      .filter((model) => !Object.prototype.hasOwnProperty.call(priceTable, model));
    if (missingPrices.length) {
      fail([
        `LLM_PRICE_TABLE_JSON must define exact production prices for: ${missingPrices.join(', ')}.`,
        'A generic default can understate provider-specific billing and bypass the monthly budget guard.',
      ]);
    }
  }
  const maxUsdPerRequest = readRange('BUDGET_MAX_USD_PER_REQUEST', 0.5, { min: Number.EPSILON });
  const monthlyUsd = readRange('BUDGET_MONTHLY_USD', 50, { min: Number.EPSILON });
  const reservationTtlSeconds = readRange('BUDGET_RESERVATION_TTL_SECONDS', 7_200, {
    min: 1,
    max: 86_400,
    integer: true,
  });
  if (maxUsdPerRequest > monthlyUsd) fail(['BUDGET_MAX_USD_PER_REQUEST cannot exceed BUDGET_MONTHLY_USD.']);
  const host = readEnv('HOST') ?? '127.0.0.1';
  if (host.length > 253 || /[\s/\\]/.test(host)) fail(['HOST must be a valid hostname or IP literal.']);
  const tlsTerminatedByTrustedProxy = readBoolean('TLS_TERMINATED_BY_TRUSTED_PROXY', false);
  if (runtimeProfile === 'production' && !isLoopbackHostname(host) && !tlsTerminatedByTrustedProxy) {
    fail([
      'A production listener on a non-loopback HOST requires TLS_TERMINATED_BY_TRUSTED_PROXY=true.',
      'Bind the Node listener only to a trusted private ingress and terminate HTTPS before bearer credentials or business payloads reach it.',
    ]);
  }
  const backendUrlRaw = readEnv('BACKEND_URL');
  const backendUrl = backendUrlRaw ? readHttpUrl('BACKEND_URL') : undefined;
  requireProductionTlsUrl('BACKEND_URL', backendUrl, runtimeProfile);

  return Object.freeze({
    provider,
    runtimeProfile,
    llmApiKey,
    // Public Anthropic API endpoint (not an internal address); override via env.
    llmBaseUrl,
    llmModel,
    llmComplexModel,
    maxTurns: readRange('LLM_MAX_TURNS', 8, { min: 1, max: 100, integer: true }),
    maxTokens: readRange('LLM_MAX_TOKENS', 1024, { min: 1, max: 1_000_000, integer: true }),
    priceTable,
    gatewayAuthToken,
    authPrincipals,
    quota: Object.freeze({
      requestsPerMinute: quotaRequestsPerMinute,
      concurrency: quotaConcurrency,
      tenantOverrides: Object.freeze(quotaTenantOverrides),
    }),
    idempotency: Object.freeze({
      maxRecords: idempotencyMaxRecords,
      resultRetentionSeconds: idempotencyResultRetentionSeconds,
    }),
    audit: Object.freeze({ maxRecords: auditMaxRecords }),
    state: Object.freeze({
      adapter: stateAdapter,
      filePath: readEnv('STATE_FILE_PATH') ?? './local/state.json',
    }),
    schedulerAdapter,
    telemetry: Object.freeze({
      enabled: telemetryEnabled,
      endpoint: telemetryEndpoint,
    }),
    dashboard: Object.freeze({ enabled: readBoolean('DASHBOARD_ENABLED', true) }),
    host,
    tlsTerminatedByTrustedProxy,
    port: readRange('PORT', 3000, { min: 0, max: 65_535, integer: true }), // PORT=0 means "let the OS pick a free port"
    budget: Object.freeze({
      maxUsdPerRequest,
      monthlyUsd,
      reservationTtlSeconds,
    }),
    sessionTtlMinutes: readRange('SESSION_TTL_MINUTES', 30, { min: 1, max: 525_600, integer: true }),
    backendUrl,
    backendApiKey: readEnv('BACKEND_API_KEY'),
    webhookSecret,
    webhook: Object.freeze({
      secret: webhookSecret,
      integrationId: webhookIntegrationId,
      principal: Object.freeze(webhookPrincipal),
      replayTtlSeconds: readRange('WEBHOOK_REPLAY_TTL_SECONDS', 600, { min: 300, max: 86_400, integer: true }),
      replayMaxRecords: readRange('WEBHOOK_REPLAY_MAX_RECORDS', 10_000, { min: 1, max: 1_000_000, integer: true }),
    }),
    notifyWebhookUrl,
    patrol: Object.freeze({
      overdueDays: readRange('PATROL_OVERDUE_DAYS', 7, { min: 0, max: 3_650, integer: true }),
      minOnTimeRate: readRange('PATROL_MIN_ONTIME_RATE', 0.9, { min: 0, max: 1 }),
    }),
  });
}
