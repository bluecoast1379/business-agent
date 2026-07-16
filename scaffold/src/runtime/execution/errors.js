export class ExecutionError extends Error {
  constructor(message, { code = 'EXECUTION_FAILED', retryable = false, unknownOutcome = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExecutionError';
    this.code = code;
    this.retryable = retryable;
    this.unknownOutcome = unknownOutcome;
  }
}

export class BulkheadRejectedError extends ExecutionError {
  constructor(message = 'Execution capacity is full') {
    super(message, { code: 'BULKHEAD_FULL', retryable: true });
    this.name = 'BulkheadRejectedError';
  }
}

export class CircuitOpenError extends ExecutionError {
  constructor(message = 'Circuit is open') {
    super(message, { code: 'CIRCUIT_OPEN', retryable: true });
    this.name = 'CircuitOpenError';
  }
}

export class ExecutionTimeoutError extends ExecutionError {
  constructor(timeoutMs) {
    super(`Execution timed out after ${timeoutMs}ms`, { code: 'TIMEOUT', retryable: true, unknownOutcome: true });
    this.name = 'ExecutionTimeoutError';
  }
}

export function classifyExecutionError(error) {
  if (error instanceof ExecutionError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ExecutionError(error.message || 'Execution aborted', {
      code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
      retryable: error?.name === 'TimeoutError',
      unknownOutcome: true,
      cause: error,
    });
  }
  const status = Number(error?.status ?? error?.statusCode);
  const retryable = [408, 425, 429, 500, 502, 503, 504, 529].includes(status) || error?.retryable === true;
  return new ExecutionError(error?.message || String(error), {
    code: error?.code || (Number.isFinite(status) ? `HTTP_${status}` : 'EXECUTION_FAILED'),
    retryable,
    unknownOutcome: error?.unknownOutcome === true,
    cause: error,
  });
}
