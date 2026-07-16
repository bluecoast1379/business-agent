import { randomBytes } from 'node:crypto';
import { sanitizeTelemetryAttributes } from './redaction.js';

function traceId() { return randomBytes(16).toString('hex'); }
function spanId() { return randomBytes(8).toString('hex'); }

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}

function otlpAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function unixNanos(value) {
  const ms = new Date(value).getTime();
  return String(BigInt(Number.isFinite(ms) ? ms : Date.now()) * 1_000_000n);
}

function signalEndpoint(base, signal) {
  const url = new URL(base);
  if (/\/v1\/(?:traces|metrics)\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/(?:traces|metrics)\/?$/, `/v1/${signal}`);
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${signal}`;
  }
  return url.toString();
}

function spanPayload(event) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'business-agent' } }] },
      scopeSpans: [{
        scope: { name: 'business-agent.runtime', version: '1' },
        spans: [{
          traceId: event.traceId,
          spanId: event.spanId,
          ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
          name: event.name,
          kind: 1,
          startTimeUnixNano: unixNanos(event.startedAt),
          endTimeUnixNano: unixNanos(event.endedAt),
          attributes: otlpAttributes(event.attributes),
          status: { code: event.outcome === 'error' ? 2 : 1 },
        }],
      }],
    }],
  };
}

function metricPayload(event) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'business-agent' } }] },
      scopeMetrics: [{
        scope: { name: 'business-agent.runtime', version: '1' },
        metrics: [{
          name: event.name,
          gauge: { dataPoints: [{ asDouble: Number(event.value), timeUnixNano: unixNanos(event.observedAt), attributes: otlpAttributes(event.attributes) }] },
        }],
      }],
    }],
  };
}

export function createNoopTelemetrySink() {
  return { export: async () => {}, flush: async () => {}, shutdown: async () => {} };
}

/** Minimal zero-dependency OTLP/HTTP JSON exporter. Start events stay local;
 * completed spans and metrics are exported after the redaction boundary. */
export function createOtlpHttpJsonSink({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  if (!endpoint) throw new Error('[telemetry] OTLP endpoint is required when telemetry is enabled');
  if (typeof fetchImpl !== 'function') throw new Error('[telemetry] fetch implementation is required');
  const tracesUrl = signalEndpoint(endpoint, 'traces');
  const metricsUrl = signalEndpoint(endpoint, 'metrics');

  return Object.freeze({
    async export(event) {
      if (event.kind === 'span' && event.phase !== 'end') return;
      if (event.kind !== 'span' && event.kind !== 'metric') return;
      const response = await fetchImpl(event.kind === 'span' ? tracesUrl : metricsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event.kind === 'span' ? spanPayload(event) : metricPayload(event)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`[telemetry] OTLP HTTP ${response.status}`);
        error.code = 'OTLP_HTTP_ERROR';
        throw error;
      }
    },
    async flush() {},
    async shutdown() {},
  });
}

export function createTelemetry({ enabled = false, sink = createNoopTelemetrySink(), now = Date.now, onExporterError = () => {} } = {}) {
  let exportAttempts = 0;
  const pending = new Set();

  function emit(event) {
    if (!enabled) return;
    exportAttempts += 1;
    const task = Promise.resolve(sink.export(event)).catch((error) => {
      onExporterError({ code: error?.code || 'TELEMETRY_EXPORT_FAILED' });
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  }

  function startSpan(name, { traceId: requestedTraceId = traceId(), parentSpanId = null, attributes = {} } = {}) {
    const currentSpanId = spanId();
    const startedAtMs = now();
    const base = {
      kind: 'span',
      name,
      traceId: requestedTraceId,
      spanId: currentSpanId,
      parentSpanId,
      startedAt: new Date(startedAtMs).toISOString(),
      attributes: sanitizeTelemetryAttributes(attributes),
    };
    void emit({ ...base, phase: 'start' });
    let ended = false;
    return {
      traceId: requestedTraceId,
      spanId: currentSpanId,
      child(childName, childAttributes = {}) {
        return startSpan(childName, { traceId: requestedTraceId, parentSpanId: currentSpanId, attributes: childAttributes });
      },
      end({ outcome = 'ok', error, attributes: endAttributes = {} } = {}) {
        if (ended) return;
        ended = true;
        const endedAtMs = now();
        void emit({
          ...base,
          phase: 'end',
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: Math.max(0, endedAtMs - startedAtMs),
          outcome,
          errorClass: error ? (error.code || error.name || 'Error') : undefined,
          attributes: sanitizeTelemetryAttributes({ ...attributes, ...endAttributes }),
        });
      },
    };
  }

  async function recordMetric(name, value, attributes = {}) {
    await emit({ kind: 'metric', name, value, observedAt: new Date(now()).toISOString(), attributes: sanitizeTelemetryAttributes(attributes) });
  }

  return {
    enabled,
    startSpan,
    recordMetric,
    exportAttempts: () => exportAttempts,
    async flush() {
      if (!enabled) return;
      await Promise.allSettled([...pending]);
      await sink.flush?.();
    },
    async shutdown() {
      if (!enabled) return;
      await Promise.allSettled([...pending]);
      await sink.shutdown?.();
    },
  };
}
