import { createBulkhead } from './bulkhead.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import { createDeadLetterQueue } from './dead-letter.js';
import { classifyExecutionError, ExecutionTimeoutError } from './errors.js';
import { createIdempotencyStore } from './idempotency.js';
import { abortableDelay, createRetryPolicy, retryDelayMs } from './retry-policy.js';

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ExecutionTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createExecutor({
  bulkhead = createBulkhead(),
  circuitBreaker = createCircuitBreaker(),
  idempotency = createIdempotencyStore(),
  deadLetters = createDeadLetterQueue(),
  retryPolicy = createRetryPolicy(),
  onEvent = () => {},
} = {}) {
  async function execute({
    name,
    operation,
    signal,
    timeoutMs = 60_000,
    idempotencyKey,
    idempotent = false,
    retry = true,
    persistIdempotencyResult = false,
    idempotencyTtlMs,
    payloadRef,
    context = {},
    unknownOnUnclassifiedError = false,
  }) {
    if (!name || typeof operation !== 'function') throw new Error('[executor] name and operation are required');
    if (idempotencyKey && !idempotent) throw new Error('[executor] idempotencyKey requires idempotent=true');

    const run = async () => {
      const release = await bulkhead.acquire(signal);
      let releaseDeferred = false;
      let attempts = 0;
      try {
        circuitBreaker.before(name);
        for (;;) {
          attempts += 1;
          const timeout = timeoutSignal(timeoutMs);
          const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
          onEvent({ type: 'execution.attempt', name, attempts, context });
          const operationPromise = Promise.resolve()
            .then(() => operation({ signal: combined, attempt: attempts, context }));
          try {
            // AbortSignal propagation alone is advisory. Race the operation so
            // the caller gets a bounded response. If the operation ignores the
            // signal, keep its bulkhead slot until it really settles; releasing
            // early would let repeated timeouts create unbounded zombie work.
            const value = await awaitWithSignal(
              operationPromise,
              combined,
            );
            timeout.clear();
            circuitBreaker.success(name);
            onEvent({ type: 'execution.success', name, attempts, context });
            return { value, attempts };
          } catch (rawError) {
            timeout.clear();
            if (combined.aborted && !releaseDeferred) {
              releaseDeferred = true;
              operationPromise.then(release, release);
            }
            const error = classifyExecutionError(rawError);
            // For externally visible write effects, a generic exception does
            // not prove that the side effect was rejected. Only adapters that
            // can positively prove a pre-effect/known rejection may opt out
            // with `unknownOutcome: false` on the original error.
            if (unknownOnUnclassifiedError && rawError?.unknownOutcome !== false) {
              error.unknownOutcome = true;
              error.reconciliationRequired = true;
            }
            const canRetry = retry && idempotent && error.retryable && !error.unknownOutcome && attempts < retryPolicy.maxAttempts;
            onEvent({ type: 'execution.failure', name, attempts, code: error.code, retrying: canRetry, context });
            if (canRetry) {
              await abortableDelay(retryDelayMs(retryPolicy, attempts), signal);
              continue;
            }
            circuitBreaker.failure(name);
            if (attempts >= retryPolicy.maxAttempts || !canRetry) {
              try {
                await deadLetters.add({ operation: name, payloadRef, error, attempts, context });
              } catch (deadLetterError) {
                // DLQ is secondary evidence. Capacity/storage failure must
                // never replace the primary outcome classification: doing so
                // could turn an ambiguous write into a known failure and make
                // its idempotency claim replayable.
                error.deadLetterRecordFailed = true;
                error.deadLetterErrorCode = deadLetterError?.code ?? deadLetterError?.name ?? 'DEAD_LETTER_FAILED';
                onEvent({
                  type: 'execution.dead_letter_failure',
                  name,
                  attempts,
                  code: error.deadLetterErrorCode,
                  context,
                });
              }
            }
            throw error;
          }
        }
      } finally {
        if (!releaseDeferred) release();
      }
    };

    if (!idempotencyKey) return run();
    const result = await idempotency.run(idempotencyKey, run, {
      ...(idempotencyTtlMs === undefined ? {} : { ttlMs: idempotencyTtlMs }),
      persistResult: persistIdempotencyResult,
    });
    return { ...result.value, deduplicated: result.deduplicated };
  }

  return { execute, bulkhead, circuitBreaker, idempotency, deadLetters };
}
