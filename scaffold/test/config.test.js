import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const CONFIG_KEYS = [
  'RUNTIME_PROFILE', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
  'LLM_COMPLEX_MODEL', 'LLM_PRICE_TABLE_JSON', 'LLM_MAX_TURNS', 'LLM_MAX_TOKENS',
  'GATEWAY_AUTH_TOKEN', 'AUTH_PRINCIPALS_JSON', 'STATE_ADAPTER', 'STATE_FILE_PATH',
  'SCHEDULER_ADAPTER', 'TELEMETRY_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'QUOTA_REQUESTS_PER_MINUTE', 'QUOTA_CONCURRENCY', 'QUOTA_TENANT_OVERRIDES_JSON',
  'BUDGET_MAX_USD_PER_REQUEST', 'BUDGET_MONTHLY_USD', 'SESSION_TTL_MINUTES',
  'WEBHOOK_SECRET', 'WEBHOOK_PRINCIPAL_JSON', 'WEBHOOK_INTEGRATION_ID', 'PORT', 'HOST',
  'NOTIFY_WEBHOOK_URL', 'TLS_TERMINATED_BY_TRUSTED_PROXY', 'BACKEND_URL', 'BACKEND_API_KEY',
  'AUDIT_MAX_RECORDS',
];
const VALID_PRINCIPALS = JSON.stringify([{
  token: '<sample-principal-credential>',
  principal: { subjectId: 'operator', tenantId: null, roles: ['operator'], scopes: ['chat:write', 'status:read'] },
}]);
const GATEWAY_PRICE_TABLE = JSON.stringify({
  'gateway-deployment-model': { inputPerMTok: 2.5, outputPerMTok: 10 },
});

function configured(values, operation) {
  const saved = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CONFIG_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return operation(); }
  finally {
    for (const key of CONFIG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('development defaults remain offline and telemetry-off', () => {
  const config = configured({ LLM_PROVIDER: 'mock', GATEWAY_AUTH_TOKEN: '<sample-placeholder-token>' }, loadConfig);
  assert.equal(config.runtimeProfile, 'development');
  assert.equal(config.state.adapter, 'memory');
  assert.equal(config.schedulerAdapter, 'local');
  assert.equal(config.telemetry.enabled, false);
});

test('production rejects mock, volatile state and missing gateway-specific model ids', () => {
  assert.throws(() => configured({ RUNTIME_PROFILE: 'production', LLM_PROVIDER: 'mock', GATEWAY_AUTH_TOKEN: '<sample-placeholder-token>' }, loadConfig), /development-only/);
  assert.throws(() => configured({
    RUNTIME_PROFILE: 'production', LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: '<sample-placeholder-key>',
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS, STATE_ADAPTER: 'file', SCHEDULER_ADAPTER: 'durable',
  }, loadConfig), /LLM_MODEL/);
  assert.throws(() => configured({
    RUNTIME_PROFILE: 'production', LLM_PROVIDER: 'anthropic', LLM_API_KEY: '<sample-placeholder-key>',
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS, STATE_ADAPTER: 'memory', SCHEDULER_ADAPTER: 'durable',
  }, loadConfig), /STATE_ADAPTER=file/);
});

test('enabled telemetry and numeric safety limits fail closed', () => {
  const base = { LLM_PROVIDER: 'mock', GATEWAY_AUTH_TOKEN: '<sample-placeholder-token>' };
  assert.throws(() => configured({ ...base, TELEMETRY_ENABLED: 'true' }, loadConfig), /OTEL_EXPORTER_OTLP_ENDPOINT/);
  assert.throws(() => configured({ ...base, QUOTA_CONCURRENCY: '0' }, loadConfig), /QUOTA_CONCURRENCY/);
  assert.throws(() => configured({ ...base, BUDGET_MAX_USD_PER_REQUEST: '2', BUDGET_MONTHLY_USD: '1' }, loadConfig), /cannot exceed/);
  assert.throws(() => configured({ ...base, LLM_PRICE_TABLE_JSON: 'null' }, loadConfig), /object keyed by model/);
  assert.throws(() => configured({ ...base, LLM_PRICE_TABLE_JSON: '{"m":{"inputPerMTok":"3","outputPerMTok":15}}' }, loadConfig), /numeric/);
});

test('production telemetry requires TLS except for a same-host collector', () => {
  const production = {
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE,
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    SCHEDULER_ADAPTER: 'durable',
    TELEMETRY_ENABLED: 'true',
  };
  assert.throws(
    () => configured({ ...production, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example/v1/traces' }, loadConfig),
    /must use https in production/,
  );
  assert.equal(
    configured({ ...production, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, loadConfig).telemetry.enabled,
    true,
  );
});

test('production notification webhooks require a credential-free HTTPS URL except loopback', () => {
  const base = {
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE,
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    SCHEDULER_ADAPTER: 'durable',
  };
  assert.throws(
    () => configured({ ...base, NOTIFY_WEBHOOK_URL: 'http://notify.example/hook' }, loadConfig),
    /NOTIFY_WEBHOOK_URL must use https/i,
  );
  assert.throws(
    () => configured({ ...base, NOTIFY_WEBHOOK_URL: 'https://user:pass@notify.example/hook' }, loadConfig),
    /without credentials/i,
  );
  assert.equal(
    configured({ ...base, NOTIFY_WEBHOOK_URL: 'http://127.0.0.1:8787/hook' }, loadConfig).notifyWebhookUrl,
    'http://127.0.0.1:8787/hook',
  );
});

test('production non-loopback listeners require an explicit trusted TLS terminator', () => {
  const production = {
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE,
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    SCHEDULER_ADAPTER: 'durable',
    HOST: '0.0.0.0',
  };
  assert.throws(() => configured(production, loadConfig), /TLS_TERMINATED_BY_TRUSTED_PROXY=true/);
  const accepted = configured({ ...production, TLS_TERMINATED_BY_TRUSTED_PROXY: 'true' }, loadConfig);
  assert.equal(accepted.tlsTerminatedByTrustedProxy, true);
});

test('production backend URLs require credential-free HTTPS except loopback', () => {
  const production = {
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE,
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    SCHEDULER_ADAPTER: 'durable',
  };
  assert.throws(() => configured({ ...production, BACKEND_URL: 'http://backend.example/api' }, loadConfig), /BACKEND_URL must use https/);
  assert.throws(() => configured({ ...production, BACKEND_URL: 'https://user:pass@backend.example/api' }, loadConfig), /without credentials/);
  assert.equal(configured({ ...production, BACKEND_URL: 'https://backend.example/api' }, loadConfig).backendUrl, 'https://backend.example/api');
});

test('production requires an exact price entry for every configured model', () => {
  const production = {
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    SCHEDULER_ADAPTER: 'durable',
  };
  assert.throws(() => configured(production, loadConfig), /exact production prices/);
  assert.throws(
    () => configured({ ...production, LLM_COMPLEX_MODEL: 'gateway-complex-model', LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE }, loadConfig),
    /gateway-complex-model/,
  );
  assert.equal(configured({ ...production, LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE }, loadConfig).llmModel, 'gateway-deployment-model');
});

test('a valid production configuration compiles without exposing values', () => {
  const config = configured({
    RUNTIME_PROFILE: 'production',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: '<sample-placeholder-key>',
    LLM_MODEL: 'gateway-deployment-model',
    LLM_PRICE_TABLE_JSON: GATEWAY_PRICE_TABLE,
    AUTH_PRINCIPALS_JSON: VALID_PRINCIPALS,
    STATE_ADAPTER: 'file',
    STATE_FILE_PATH: './local/test-state.json',
    SCHEDULER_ADAPTER: 'durable',
  }, loadConfig);
  assert.equal(config.runtimeProfile, 'production');
  assert.equal(config.llmModel, 'gateway-deployment-model');
  assert.equal(config.state.adapter, 'file');
});
