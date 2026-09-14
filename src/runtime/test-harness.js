/**
 * Runtime test harness.
 *
 * `createPairedChannels()` returns a duck-typed wire-Channel
 * pair: messages sent on `a.send(...)` arrive on
 * `b`'s onMessage subscriber, and vice-versa. Sequence numbers are
 * per-direction monotonic, matching wire's contract.
 *
 * `RuntimeBuilder` is a fluent constructor for test runtimes
 * that hides the engine/airlock setup boilerplate.
 *
 * Exported through `src/runtime/index.js` so downstream test suites
 * can import both without reaching into a `_test/` directory.
 */

import { freshSession, restoreSession, snapshotSession } from '../host-owned-session.js';
import { Runtime } from './runtime.js';

/**
 * Construct a pair of in-process duck-typed channels. Bytes
 * sent on `a` arrive on `b`'s onMessage subscriber; bytes
 * sent on `b` arrive on `a`'s onMessage subscriber. Sequence
 * numbers are
 * per-direction monotonic (each channel keeps its own
 * counter for *received* messages).
 *
 * @returns {{ a: Channel, b: Channel, close: () => void }}
 */
export function createPairedChannels() {
  // Each direction is a queue of { payload, sequenceNumber }
  // plus a single resolver for a waiting receiver.
  const aToB = makeDirection();
  const bToA = makeDirection();

  return {
    a: makeEndpoint(aToB, bToA),
    b: makeEndpoint(bToA, aToB),
    close: () => {
      aToB.close();
      bToA.close();
    },
  };
}

function makeDirection() {
  return {
    queue:      [],         // messages waiting for a subscriber
    subscriber: null,       // onMessage callback, or null
    seq:        0n,         // monotonic counter (bumped per enqueue)
    closed:     false,
    close() {
      this.closed = true;
      this.subscriber = null;
    },
  };
}

function makeEndpoint(sendDir, recvDir) {
  return {
    /**
     * Enqueue a payload on the send direction. Bytes are
     * copied — caller can reuse the buffer after `send`
     * returns. Returns a resolved Promise (the paired
     * channel never applies backpressure in this fake).
     */
    send(payload) {
      if (sendDir.closed) {
        return Promise.reject(new Error('paired channel closed'));
      }
      enqueue(sendDir, payload);
      return Promise.resolve();
    },

    /**
     * Synchronous enqueue; always succeeds for the fake.
     */
    trySend(payload) {
      if (sendDir.closed) return false;
      enqueue(sendDir, payload);
      return true;
    },

    /**
     * Subscribe to incoming messages. Fire-and-forget per the
     * wire contract — the callback's return value (including
     * Promises) is ignored. Returns an unsubscribe function.
     * Only one subscriber at a time.
     */
    onMessage(cb) {
      if (typeof cb !== 'function') {
        throw new Error('onMessage: cb must be a function');
      }
      if (recvDir.subscriber !== null) {
        throw new Error('onMessage: a subscriber is already registered');
      }
      recvDir.subscriber = cb;
      // Drain anything already queued.
      while (recvDir.queue.length > 0 && recvDir.subscriber === cb) {
        const msg = recvDir.queue.shift();
        try { cb(msg); } catch { /* swallow per wire contract */ }
      }
      return () => {
        if (recvDir.subscriber === cb) recvDir.subscriber = null;
      };
    },
  };
}

function enqueue(dir, payload) {
  // Copy so the sender can reuse / mutate the source buffer.
  const copy = new Uint8Array(payload.byteLength);
  copy.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  dir.seq++;
  const msg = { payload: copy, sequenceNumber: dir.seq };
  if (dir.subscriber !== null) {
    try { dir.subscriber(msg); } catch { /* swallow per wire contract */ }
    return;
  }
  dir.queue.push(msg);
}

/**
 * Fluent test-runtime builder. Constructs an engine, wires
 * a paired-channel pair, and produces a Runtime ready to be
 * `start()`ed.
 *
 * Usage:
 *
 *   const { runtime, host } = new RuntimeBuilder()
 *     .capability({ name: 'echo', setup(airlock) { ... } })
 *     .hostService('clock', () => Date.now())
 *     .onInboundMessage((payload, seq) => { ... })
 *     .build()
 *   await runtime.start()
 *
 * `host` is the embedder-side of the channel pair — the
 * test code calls `host.send(...)` to deliver a message
 * inbound, and `host.onMessage(cb)` to subscribe to the
 * runtime's outbound.
 */
export class RuntimeBuilder {
  constructor() {
    this._sessionOptions       = {};
    this._capabilities        = [];
    this._hostServices        = {};
    this._subsystems          = {};
    this._onInboundMessage    = null;
    this._onHandlerError      = null;
    this._composeErrorEnvelope = null;
    this._extraSchedulerBackpressure = null;
    this._fuel                = undefined;
    this._name                = 'sandscript-runtime-test';
    this._restoreFrom         = null; // { vatBytes, membraneBytes }
    this._onSchedulerIdle     = null;
  }

  sessionOptions(opts) {
    Object.assign(this._sessionOptions, opts);
    return this;
  }

  /**
   * Build the runtime by restoring from snapshot bytes. The host-
   * owned-memory contract: the harness allocates its own memory +
   * buffer sized to the snapshot, copies the bytes in, and attaches.
   */
  fromSnapshot({ vatBytes, membraneBytes }) {
    this._restoreFrom = { vatBytes, membraneBytes };
    return this;
  }

  capability(cap) {
    this._capabilities.push(cap);
    return this;
  }

  capabilities(caps) {
    for (const c of caps) this._capabilities.push(c);
    return this;
  }

  hostService(name, value) {
    this._hostServices[name] = value;
    return this;
  }

  subsystem(name, value) {
    this._subsystems[name] = value;
    return this;
  }

  onInboundMessage(fn) {
    this._onInboundMessage = fn;
    return this;
  }

  onHandlerError(fn) {
    this._onHandlerError = fn;
    return this;
  }

  composeErrorEnvelope(fn) {
    this._composeErrorEnvelope = fn;
    return this;
  }

  extraSchedulerBackpressure(fn) {
    this._extraSchedulerBackpressure = fn;
    return this;
  }

  fuel(n) {
    this._fuel = n;
    return this;
  }

  name(n) {
    this._name = n;
    return this;
  }

  /**
   * Scheduler-idle notification hook. The runtime calls `fn` (no
   * argument, not awaited) at each arrival at final scheduler idle —
   * after the final concurrent drive returns, and after bootOnly().
   * Not called for QUIESCED or from resume(). Throws surface via
   * onHandlerError.
   */
  onSchedulerIdle(fn) {
    this._onSchedulerIdle = fn;
    return this;
  }

  /**
   * Build the runtime and return it alongside the host-side
   * channel handle.
   *
   * @returns {{
   *   runtime: Runtime,
   *   host: { send, trySend, onMessage },
   *   session: ReturnType<typeof createSession>,
   *   channels: { close: () => void },
   * }}
   */
  build() {
    const session = this._restoreFrom
      ? restoreSession(
          this._restoreFrom.vatBytes,
          this._restoreFrom.membraneBytes,
          this._sessionOptions)
      : freshSession(this._sessionOptions);

    const channels = createPairedChannels();
    // Runtime side: `a`. Host side (the test code): `b`.
    const runtime = new Runtime({
      session,
      // Host signals resume vs boot explicitly — the harness
      // knows which path it took above.
      resume:                       this._restoreFrom !== null,
      inboundChannel:               channels.a,
      outboundChannel:              channels.a,
      capabilities:                 this._capabilities,
      hostServices:                 this._hostServices,
      subsystems:                   this._subsystems,
      onInboundMessage:             this._onInboundMessage,
      onHandlerError:               this._onHandlerError,
      composeErrorEnvelope:         this._composeErrorEnvelope,
      extraSchedulerBackpressure:   this._extraSchedulerBackpressure,
      fuel:                         this._fuel,
      name:                         this._name,
      onSchedulerIdle:              this._onSchedulerIdle,
    });

    return {
      runtime,
      host:    channels.b,
      session,
      channels,
      /** Take a paired snapshot from this builder's session — the
       *  harness owns the buffers (via freshSession/restoreSession),
       *  so it can slice them on demand. Production hosts do their
       *  own slicing; this is the test convenience. */
      snapshot: () => snapshotSession(session),
    };
  }
}
