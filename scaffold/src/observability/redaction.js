import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|signature|api[_-]?key|prompt|message|content|args?|result|payload|record|body)/i;
const SECRET_SHAPE = /(?:bearer\s+[a-z0-9._~+/-]{8,}|(?:sk|api|tok|secret)[_-][a-z0-9_-]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;

export function pseudonymize(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

export function redactValue(value, { depth = 0, maxDepth = 6 } = {}) {
  if (depth > maxDepth) return '[REDACTED_DEPTH]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(SECRET_SHAPE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactValue(item, { depth: depth + 1, maxDepth }));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, { depth: depth + 1, maxDepth });
    }
    return out;
  }
  return String(value);
}

const ALLOWED_SPAN_FIELDS = new Set([
  'requestId', 'runId', 'sessionId', 'traceId', 'spanId', 'parentSpanId',
  'subjectId', 'tenantId', 'agent', 'provider', 'model', 'tool', 'operation',
  'policyDecision', 'outcome', 'errorClass', 'durationMs', 'inputTokens',
  'outputTokens', 'costUsd', 'attempt', 'queueDepth', 'statusCode',
]);

export function sanitizeTelemetryAttributes(attributes = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_SPAN_FIELDS.has(key)) continue;
    if (['subjectId', 'tenantId', 'sessionId'].includes(key) && value !== undefined) out[key] = pseudonymize(value);
    else out[key] = redactValue(value);
  }
  return out;
}
