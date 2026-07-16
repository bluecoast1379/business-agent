export function createRetryPolicy({ maxAttempts = 3, baseDelayMs = 100, maxDelayMs = 5_000, jitter = 0.2, random = Math.random } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('[retry] maxAttempts must be >= 1');
  if (baseDelayMs < 0 || maxDelayMs < baseDelayMs) throw new Error('[retry] invalid delay bounds');
  return Object.freeze({ maxAttempts, baseDelayMs, maxDelayMs, jitter, random });
}

export function retryDelayMs(policy, attempt) {
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const spread = raw * Math.max(0, policy.jitter ?? 0);
  return Math.max(0, Math.round(raw - spread + 2 * spread * policy.random()));
}

export function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
