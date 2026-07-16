import { CircuitOpenError } from './errors.js';

export function createCircuitBreaker({ failureThreshold = 5, resetTimeoutMs = 30_000, now = Date.now } = {}) {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error('[circuit] failureThreshold must be >= 1');
  const circuits = new Map();

  function entry(key) {
    let value = circuits.get(key);
    if (!value) {
      value = { state: 'closed', failures: 0, openedAt: null, probeActive: false };
      circuits.set(key, value);
    }
    return value;
  }

  function before(key) {
    const value = entry(key);
    if (value.state === 'open') {
      if (now() - value.openedAt < resetTimeoutMs) throw new CircuitOpenError(`Circuit "${key}" is open`);
      value.state = 'half_open';
      value.probeActive = false;
    }
    if (value.state === 'half_open') {
      if (value.probeActive) throw new CircuitOpenError(`Circuit "${key}" is probing`);
      value.probeActive = true;
    }
    return value.state;
  }

  function success(key) {
    const value = entry(key);
    value.state = 'closed';
    value.failures = 0;
    value.openedAt = null;
    value.probeActive = false;
  }

  function failure(key) {
    const value = entry(key);
    value.probeActive = false;
    value.failures += 1;
    if (value.state === 'half_open' || value.failures >= failureThreshold) {
      value.state = 'open';
      value.openedAt = now();
    }
  }

  function snapshot(key) {
    const value = entry(key);
    return { ...value };
  }

  return { before, success, failure, snapshot };
}
