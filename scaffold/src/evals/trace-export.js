import { redactValue } from '../observability/redaction.js';

export function exportReviewedTraces(traces, { reviewed = false, reviewer } = {}) {
  if (!reviewed || !reviewer) throw new Error('[evals] trace export requires an explicit reviewer');
  return traces.map((trace, index) => ({
    schemaVersion: '1.0',
    id: `reviewed-trace-${index + 1}`,
    input: '[REDACTED_REVIEW_REQUIRED]',
    expected: { contains: [] },
    provenance: { reviewer, traceId: trace.traceId, reviewed: true },
    metadata: redactValue(trace.metadata ?? {}),
  }));
}
