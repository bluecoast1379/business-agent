export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function responseTooLarge(maxBytes) {
  const error = new Error(`[provider] response body exceeds ${maxBytes} bytes`);
  error.code = 'RESPONSE_TOO_LARGE';
  return error;
}

function assertLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('[provider] maxResponseBytes must be a positive safe integer');
  }
}

function contentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  try { return BigInt(raw); } catch { return null; }
}

async function cancelBody(body, reason) {
  try { await body?.cancel?.(reason); } catch { /* best-effort transport cleanup */ }
}

function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Read a fetch Response body without allowing either a declared Content-Length
 * or a chunked transfer to allocate beyond the configured boundary.
 */
export async function readBoundedResponseText(response, {
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal,
} = {}) {
  assertLimit(maxBytes);
  const declared = contentLength(response);
  if (declared !== null && declared > BigInt(maxBytes)) {
    const error = responseTooLarge(maxBytes);
    await cancelBody(response?.body, error);
    throw error;
  }

  const body = response?.body;
  if (typeof body?.getReader !== 'function') {
    // Repository tests and small embedders may provide a minimal fetch-shaped
    // response. Real Node fetch responses always take the bounded reader path.
    const text = await awaitWithSignal(response.text(), signal);
    if (Buffer.byteLength(text) > maxBytes) throw responseTooLarge(maxBytes);
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        const error = new Error('[provider] response stream emitted a non-byte chunk');
        error.code = 'MALFORMED_RESPONSE';
        throw error;
      }
      total += value.byteLength;
      if (total > maxBytes) throw responseTooLarge(maxBytes);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    try { await reader.cancel(error); } catch { /* best-effort transport cleanup */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }
}
