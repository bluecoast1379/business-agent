import { BulkheadRejectedError } from './errors.js';

export function createBulkhead({ concurrency = 8, queueLimit = 32 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('[bulkhead] concurrency must be >= 1');
  if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new Error('[bulkhead] queueLimit must be >= 0');
  let active = 0;
  const queue = [];

  function pump() {
    while (active < concurrency && queue.length) {
      const waiter = queue.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        continue;
      }
      active += 1;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve(release);
    }
  }

  function release() {
    if (active > 0) active -= 1;
    pump();
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (active < concurrency) {
      active += 1;
      return Promise.resolve(release);
    }
    if (queue.length >= queueLimit) return Promise.reject(new BulkheadRejectedError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      queue.push(waiter);
    });
  }

  return { acquire, stats: () => ({ active, queued: queue.length, concurrency, queueLimit }) };
}
