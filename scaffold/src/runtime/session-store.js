/**
 * In-memory session store with TTL sweep.
 * A session keeps the conversation messages so multi-turn chat works over
 * stateless HTTP. Swap this module for Redis/DB when you need persistence.
 */

/** Trim history to at most maxMessages, cutting only at a clean user-text turn
 *  so tool_use/tool_result pairs are never orphaned. */
function trimMessages(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages;
  for (let i = messages.length - maxMessages; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return messages.slice(i);
  }
  return []; // no clean boundary found: start fresh rather than send a broken transcript
}

export function createSessionStore({ ttlMs = 30 * 60_000, sweepIntervalMs = 60_000, maxMessages = 40 } = {}) {
  const sessions = new Map();

  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, s] of sessions) {
      if (now - s.lastActiveAt > ttlMs) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref?.(); // never keep the process alive just for sweeping

  return {
    getOrCreate(id) {
      let s = sessions.get(id);
      if (!s) {
        s = { id, messages: [], createdAt: Date.now(), lastActiveAt: Date.now() };
        sessions.set(id, s);
      }
      s.lastActiveAt = Date.now();
      return s;
    },
    setMessages(id, messages) {
      const s = this.getOrCreate(id);
      s.messages = trimMessages(messages, maxMessages);
    },
    size: () => sessions.size,
    sweep,
    close() {
      clearInterval(timer);
      sessions.clear();
    },
  };
}
