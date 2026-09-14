// Test-only adapter for the runtime's host-side channel
// endpoint. Wire/runtime's reader API is callback-only; tests
// often want a pull-style "wait for the next outbound message"
// assertion. This helper subscribes once and exposes that
// pull-style API. NEVER use this pattern in real (non-test)
// code — pull-Promise patterns over streams of events are a
// banned design.

/**
 * Subscribe to the host endpoint's incoming messages and return
 * a queue-and-await helper.
 *
 * Returns:
 *   {
 *     received: () => ReadonlyArray<ReceivedMessage>,
 *       // Snapshot of messages received so far, in arrival
 *       // order.
 *
 *     nextMessage(timeoutMs?): Promise<ReceivedMessage>,
 *       // Resolves with the next not-yet-consumed message,
 *       // parking if none is currently queued. Throws on
 *       // timeout (default 1s).
 *
 *     tryNextMessage(): ReceivedMessage | null,
 *       // Synchronous pull — returns the next queued message
 *       // or null if none.
 *
 *     unsubscribe(): void,
 *   }
 */
export function collectMessages(host, { defaultTimeoutMs = 1000 } = {}) {
  const queue = [];
  const waiters = [];

  const unsubscribe = host.onMessage((msg) => {
    if (waiters.length > 0) {
      waiters.shift().resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    received: () => queue.slice(),

    nextMessage(timeoutMs = defaultTimeoutMs) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        waiters.push(entry);
        const t = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error(
              `collectMessages.nextMessage: timed out after ${timeoutMs} ms`));
          }
        }, timeoutMs);
        const inner = entry.resolve;
        entry.resolve = (v) => { clearTimeout(t); inner(v); };
      });
    },

    tryNextMessage() {
      return queue.length > 0 ? queue.shift() : null;
    },

    unsubscribe,
  };
}
