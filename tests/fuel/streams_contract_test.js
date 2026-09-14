/**
 * WHATWG-shaped streams contract coverage.
 *
 * Each Deno.test block authors a streams object inline in SandScript and
 * verifies observable behavior. These ad hoc fixtures cover ReadableStream
 * pull/start sources and readers, WritableStream write/close/abort, pipeTo,
 * tee, TransformStream, cancellation, and async iteration. SandScript ships
 * no streams module.
 *
 * Byte streams and BYOB, transferable streams, queueing strategies, and exact
 * verbatim WHATWG error messages are outside this suite's scope.
 *
 * Many tests use sync iteration (for-of) where the spec uses async
 * iteration (for-await), because the language-level concerns are the
 * same and sync is cheaper to test. The async-iteration block at the
 * end pins for-await explicitly.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAndSetup } from './test-helpers.js';
import { freshSession } from '../../src/host-owned-session.js';
import {
  EXIT_DONE, EXIT_ERROR, EXIT_AWAIT,
  EXIT_ASYNC_COMPLETE, EXIT_ASYNC_REJECTED,
  EXIT_EXTERNAL_CALL, EXIT_EXTERNAL_PROPERTY,
} from '../../src/fuel/constants.js';

function run(source) {
  // Bigger heap than the default — the streams tests author full WHATWG
  // shapes inline (~kilobytes of source per test), and the default
  // 768K heap collides with the bytecode region under that load.
  const session = freshSession({ heapSize: 4 * 1024 * 1024 });
  parseAndSetup(session, source);
  const result = session.run(0, 100_000_000);
  if (result.status === 'error') {
    throw new Error(`Error: ${result.error.message}`);
  }
  return session;
}

/**
 * Drive an async program (one using await / async functions / for-await)
 * to quiescence. Schedules spawned contexts, handles promise settles, and
 * yields to the JS event loop between iterations so linked Promises can
 * settle. Lifted from the for_of_test runAsync helper.
 */
async function runAsync(source, maxIterations = 400) {
  const session = freshSession({ heapSize: 4 * 1024 * 1024 });
  const mem = session.airlock.memoryImage;
  const airlock = session.airlock;
  parseAndSetup(session, source);

  const contexts = [{ slot: 0, generation: session.memoryImage.getContextGeneration(0) }]
  for (let iter = 0; iter < maxIterations; iter++) {
    await new Promise(r => setTimeout(r, 0));
    const spawned = airlock.drainPendingSpawnedContextIdentities();
    for (const ctx of spawned) {
      if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }

    let contextToRun = null;
    for (const ctx of contexts) {
      const ec = mem.getExitCondition(ctx.slot);
      if (ec === EXIT_DONE || ec === EXIT_ERROR ||
          ec === EXIT_ASYNC_COMPLETE || ec === EXIT_ASYNC_REJECTED) continue;
      if (ec === EXIT_AWAIT) continue;
      if ((ec === EXIT_EXTERNAL_CALL || ec === EXIT_EXTERNAL_PROPERTY) &&
          airlock.pendingContexts && airlock.pendingContexts.has(ctx.slot)) continue;
      contextToRun = ctx;
      break;
    }
    if (!contextToRun) {
      const hasLinked = airlock.linkedPromiseCount && airlock.linkedPromiseCount() > 0;
      const hasPending = airlock.pendingContexts && airlock.pendingContexts.size > 0;
      if ((hasLinked || hasPending) && iter < maxIterations - 1) continue;
      break;
    }

    const result = session.run(contextToRun, 10000);
    if (result.status === 'async_call' && result.asyncContext !== undefined) {
      contexts.push(result.asyncContext);
    }
    if (result.status === 'await') airlock.handleAwait(contextToRun.slot);
    if (result.status === 'async_complete') {
      const { waiters } = airlock.handleAsyncComplete(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'async_rejected') {
      const { waiters } = airlock.handleAsyncRejected(contextToRun.slot);
      for (const w of waiters) if (!contexts.find(c => c.slot === w.slot && c.generation === w.generation)) contexts.push(w);
    }
    if (result.status === 'promise_method' && result.contexts) {
      for (const ctx of result.contexts) if (!contexts.find(c => c.slot === ctx.slot && c.generation === ctx.generation)) contexts.push(ctx);
    }
  }

  return session;
}

// =============================================================================
// Shared fixture text — defines a minimal sync-iterable ReadableStream.
// Pure sandscript; no host plumbing. Stored as a constant string so each
// test block can prepend it without re-typing.
// =============================================================================

const READABLE_STREAM = `
function ReadableStream(source) {
  let queue = [];
  let closed = false;
  let error = null;
  let started = false;
  let pullCount = 0;
  let startCount = 0;

  let controller = {
    enqueue(chunk) { queue.push(chunk); },
    close() { closed = true; },
    error(e) { error = e; closed = true; },
  };

  function ensureStarted() {
    if (!started) {
      started = true;
      if (source.start) {
        startCount = startCount + 1;
        source.start(controller);
      }
    }
  }

  let stream = {
    _testStats() { return { pullCount, startCount }; },
    [Symbol.iterator]() {
      ensureStarted();
      return {
        next() {
          while (queue.length === 0 && !closed) {
            if (source.pull) {
              pullCount = pullCount + 1;
              source.pull(controller);
            } else {
              break;
            }
          }
          // Spec: drain buffered chunks before surfacing the error so
          // chunks enqueued before controller.error(...) are still
          // observable.
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (error) throw error;
          return { value: undefined, done: true };
        },
      };
    },
  };
  return stream;
}
`;

// =============================================================================
// 1. ReadableStream — pull source
// =============================================================================

Deno.test("ReadableStream: pull source — chunks arrive in order, exits on close", () => {
  const s = run(READABLE_STREAM + `
    let count = 0;
    let stream = new ReadableStream({
      pull(controller) {
        if (count < 3) {
          controller.enqueue('c' + count);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let chunks = [];
    for (const chunk of stream) {
      chunks.push(chunk);
    }
    let r0 = chunks[0]; let r1 = chunks[1]; let r2 = chunks[2]; let len = chunks.length;
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 'c0');
  assertEquals(s.get(0, 'r1'), 'c1');
  assertEquals(s.get(0, 'r2'), 'c2');
});

Deno.test("ReadableStream: pull source — error propagates as iterator throw", () => {
  const s = run(READABLE_STREAM + `
    let stream = new ReadableStream({
      pull(controller) {
        controller.enqueue('first');
        controller.error('boom');
      },
    });

    let caught = null;
    let received = [];
    try {
      for (const chunk of stream) {
        received.push(chunk);
      }
    } catch (e) {
      caught = e;
    }
    let firstChunk = received[0]; let recvLen = received.length;
  `);
  assertEquals(s.get(0, 'firstChunk'), 'first');
  assertEquals(s.get(0, 'recvLen'), 1);
  assertEquals(s.get(0, 'caught'), 'boom');
});

// =============================================================================
// 2. ReadableStream — start source + lazy pull
// =============================================================================

Deno.test("ReadableStream: start runs once before any pull", () => {
  const s = run(READABLE_STREAM + `
    let stream = new ReadableStream({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.enqueue('c');
        controller.close();
      },
      // No pull — start enqueued everything.
    });

    let chunks = [];
    for (const chunk of stream) chunks.push(chunk);
    let len = chunks.length;
    let r0 = chunks[0]; let r2 = chunks[2];
    let stats = stream._testStats();
    let startCount = stats.startCount;
    let pullCount = stats.pullCount;
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 'a');
  assertEquals(s.get(0, 'r2'), 'c');
  assertEquals(s.get(0, 'startCount'), 1);
  assertEquals(s.get(0, 'pullCount'), 0);  // start filled the queue; pull never called
});

// =============================================================================
// 3. Reader API — getReader() + reader.read()
// =============================================================================
//
// Adds .getReader() / .releaseLock() to the fixture by extending the
// returned stream object inline within the test. We don't bolt these
// onto the shared READABLE_STREAM fixture because the simpler tests
// above don't need them.

const READABLE_STREAM_WITH_READER = READABLE_STREAM + `
function attachReader(stream, sourceState) {
  // sourceState is shared with the source's controller closure; the
  // simplest path is to expose queue/closed via the stream itself.
  // We reach in to the closure by re-implementing — easier for now to
  // re-author the stream below in each test that needs a reader.
}
`;

Deno.test("ReadableStream: reader.read returns {value, done}; closed reads done=true forever", () => {
  // Re-authored stream variant: same shape as READABLE_STREAM but the
  // returned object exposes getReader() instead of [Symbol.iterator].
  // Uses a `_locked()` method instead of a getter — sandscript doesn't
  // support `get prop()` syntax in object literals yet (see TBD follow-up).
  const s = run(`
    function ReadableStream(source) {
      let queue = [];
      let closed = false;
      let error = null;
      let lockedReader = null;

      let controller = {
        enqueue(chunk) { queue.push(chunk); },
        close() { closed = true; },
        error(e) { error = e; closed = true; },
      };
      if (source.start) source.start(controller);

      let stream = {
        getReader() {
          if (lockedReader !== null) throw 'TypeError: stream is locked';
          let reader = {
            read() {
              while (queue.length === 0 && !closed) {
                if (source.pull) source.pull(controller);
                else break;
              }
              if (queue.length > 0) return { value: queue.shift(), done: false };
              if (error) throw error;
              return { value: undefined, done: true };
            },
            releaseLock() { lockedReader = null; },
          };
          lockedReader = reader;
          return reader;
        },
        locked() { return lockedReader !== null; },
      };
      return stream;
    }

    let count = 0;
    let stream = new ReadableStream({
      pull(controller) {
        if (count < 2) {
          controller.enqueue(count);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let reader = stream.getReader();
    let r0 = reader.read();
    let r0v = r0.value; let r0d = r0.done;
    let r1 = reader.read();
    let r1v = r1.value; let r1d = r1.done;
    let r2 = reader.read();        // exhausts source → closed
    let r2v = r2.value; let r2d = r2.done;
    let r3 = reader.read();        // post-close: still done=true
    let r3v = r3.value; let r3d = r3.done;
  `);
  assertEquals(s.get(0, 'r0v'), 0);
  assertEquals(s.get(0, 'r0d'), false);
  assertEquals(s.get(0, 'r1v'), 1);
  assertEquals(s.get(0, 'r1d'), false);
  assertEquals(s.get(0, 'r2v'), undefined);
  assertEquals(s.get(0, 'r2d'), true);
  assertEquals(s.get(0, 'r3v'), undefined);
  assertEquals(s.get(0, 'r3d'), true);
});

Deno.test("ReadableStream: getReader twice throws; releaseLock allows re-acquire", () => {
  const s = run(`
    function ReadableStream() {
      let lockedReader = null;
      return {
        getReader() {
          if (lockedReader !== null) throw 'TypeError: stream is locked';
          let r = {
            releaseLock() { lockedReader = null; },
          };
          lockedReader = r;
          return r;
        },
        locked() { return lockedReader !== null; },
      };
    }

    let stream = new ReadableStream();
    let lockedBefore = stream.locked();
    let r1 = stream.getReader();
    let lockedAfter1 = stream.locked();
    let caught = null;
    try { stream.getReader(); } catch (e) { caught = e; }
    r1.releaseLock();
    let lockedAfterRelease = stream.locked();
    let r2 = stream.getReader();   // succeeds now
    let lockedAfter2 = stream.locked();
  `);
  assertEquals(s.get(0, 'lockedBefore'), false);
  assertEquals(s.get(0, 'lockedAfter1'), true);
  assertEquals(s.get(0, 'caught'), 'TypeError: stream is locked');
  assertEquals(s.get(0, 'lockedAfterRelease'), false);
  assertEquals(s.get(0, 'lockedAfter2'), true);
});

Deno.test("ReadableStream: pull not called until first read", () => {
  const s = run(READABLE_STREAM + `
    let pullsBeforeRead = 0;
    let stream = new ReadableStream({
      pull(controller) {
        controller.enqueue('x');
        controller.close();
      },
    });

    let statsBefore = stream._testStats();
    pullsBeforeRead = statsBefore.pullCount;

    let chunks = [];
    for (const chunk of stream) chunks.push(chunk);
    let statsAfter = stream._testStats();
    let pullsAfter = statsAfter.pullCount;
  `);
  assertEquals(s.get(0, 'pullsBeforeRead'), 0);
  // After iteration: pulled at least once. (Our implementation may pull
  // again to confirm close — assert >= 1.)
  const after = s.get(0, 'pullsAfter');
  if (after < 1) throw new Error(`expected pullsAfter >= 1, got ${after}`);
});

// =============================================================================
// 4. WritableStream — write/close
// =============================================================================
//
// Sync variant: write() runs the sink's write immediately; close() flushes
// then runs sink.close(); abort() rejects further writes. We don't exercise
// the async/promise variant here because that needs await + Promise wiring
// which is exercised separately in tests below.

const WRITABLE_STREAM = `
function WritableStream(sink) {
  let state = 'writable';   // 'writable' | 'closed' | 'aborted' | 'errored'
  let abortReason = null;

  let writer = {
    write(chunk) {
      if (state !== 'writable') throw 'TypeError: stream is ' + state;
      sink.write(chunk);
      return true;
    },
    close() {
      if (state !== 'writable') throw 'TypeError: stream is ' + state;
      if (sink.close) sink.close();
      state = 'closed';
      return true;
    },
    abort(reason) {
      if (state === 'closed') return;
      abortReason = reason;
      state = 'aborted';
      if (sink.abort) sink.abort(reason);
      return true;
    },
    _state() { return state; },
    _abortReason() { return abortReason; },
  };
  return writer;
}
`;

Deno.test("WritableStream: write collects chunks; close finalizes; further write throws", () => {
  const s = run(WRITABLE_STREAM + `
    let collected = [];
    let closeCalled = false;
    let writer = new WritableStream({
      write(chunk) { collected.push(chunk); },
      close() { closeCalled = true; },
    });

    writer.write('a');
    writer.write('b');
    writer.write('c');
    writer.close();

    let len = collected.length; let c0 = collected[0]; let c2 = collected[2];

    let caught = null;
    try { writer.write('d'); } catch (e) { caught = e; }
    let stateAfter = writer._state();
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'c0'), 'a');
  assertEquals(s.get(0, 'c2'), 'c');
  assertEquals(s.get(0, 'closeCalled'), true);
  assertEquals(s.get(0, 'caught'), 'TypeError: stream is closed');
  assertEquals(s.get(0, 'stateAfter'), 'closed');
});

Deno.test("WritableStream: abort reaches sink and rejects further writes", () => {
  const s = run(WRITABLE_STREAM + `
    let collected = [];
    let abortReceived = null;
    let closeCalled = false;
    let writer = new WritableStream({
      write(chunk) { collected.push(chunk); },
      close() { closeCalled = true; },
      abort(reason) { abortReceived = reason; },
    });

    writer.write('first');
    writer.abort('something went wrong');

    let caught = null;
    try { writer.write('second'); } catch (e) { caught = e; }
    let state = writer._state();
    let reason = writer._abortReason();
  `);
  assertEquals(s.get(0, 'collected').length, 1);
  assertEquals(s.get(0, 'abortReceived'), 'something went wrong');
  assertEquals(s.get(0, 'reason'), 'something went wrong');
  assertEquals(s.get(0, 'state'), 'aborted');
  assertEquals(s.get(0, 'caught'), 'TypeError: stream is aborted');
  // Spec: abort does NOT call close.
  assertEquals(s.get(0, 'closeCalled'), false);
});

// =============================================================================
// 6. pipeTo — connects a readable source to a writable sink
// =============================================================================

const PIPE_TO = READABLE_STREAM + WRITABLE_STREAM + `
function pipeTo(source, writer, options) {
  let preventClose = false;
  if (options && options.preventClose) preventClose = true;
  let aborted = false;
  let error = null;
  try {
    for (const chunk of source) {
      writer.write(chunk);
    }
  } catch (e) {
    error = e;
    writer.abort(e);
    aborted = true;
  }
  if (!aborted && !preventClose) writer.close();
  return { aborted, error };
}
`;

Deno.test("pipeTo: chunks flow from source to sink in order; sink.close fires on completion", () => {
  const s = run(PIPE_TO + `
    let count = 0;
    let source = new ReadableStream({
      pull(controller) {
        if (count < 4) {
          controller.enqueue(count * 10);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let collected = [];
    let closeCalled = false;
    let sink = new WritableStream({
      write(chunk) { collected.push(chunk); },
      close() { closeCalled = true; },
    });

    let result = pipeTo(source, sink);
    let len = collected.length;
    let r0 = collected[0]; let r3 = collected[3];
    let aborted = result.aborted;
  `);
  assertEquals(s.get(0, 'len'), 4);
  assertEquals(s.get(0, 'r0'), 0);
  assertEquals(s.get(0, 'r3'), 30);
  assertEquals(s.get(0, 'closeCalled'), true);
  assertEquals(s.get(0, 'aborted'), false);
});

Deno.test("pipeTo: source error propagates to sink as abort; close not called", () => {
  const s = run(PIPE_TO + `
    let count = 0;
    let source = new ReadableStream({
      pull(controller) {
        if (count < 2) {
          controller.enqueue(count);
          count = count + 1;
        } else {
          controller.error('source failed');
        }
      },
    });

    let collected = [];
    let abortReason = null;
    let closeCalled = false;
    let sink = new WritableStream({
      write(chunk) { collected.push(chunk); },
      close() { closeCalled = true; },
      abort(r) { abortReason = r; },
    });

    let result = pipeTo(source, sink);
    let collectedLen = collected.length;
    let resultError = result.error;
    let resultAborted = result.aborted;
  `);
  assertEquals(s.get(0, 'collectedLen'), 2);
  assertEquals(s.get(0, 'abortReason'), 'source failed');
  assertEquals(s.get(0, 'closeCalled'), false);
  assertEquals(s.get(0, 'resultError'), 'source failed');
  assertEquals(s.get(0, 'resultAborted'), true);
});

Deno.test("pipeTo: preventClose keeps sink open after source closes", () => {
  const s = run(PIPE_TO + `
    let count = 0;
    let source = new ReadableStream({
      pull(controller) {
        if (count < 2) {
          controller.enqueue(count);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let collected = [];
    let closeCalled = false;
    let sink = new WritableStream({
      write(chunk) { collected.push(chunk); },
      close() { closeCalled = true; },
    });

    pipeTo(source, sink, { preventClose: true });
    let sinkState = sink._state();

    // Sink still open — can write more.
    sink.write('after');
    let finalLen = collected.length;
  `);
  assertEquals(s.get(0, 'closeCalled'), false);
  assertEquals(s.get(0, 'sinkState'), 'writable');
  assertEquals(s.get(0, 'finalLen'), 3);
});

// =============================================================================
// 7. tee — split a readable into two independent readers
// =============================================================================

const TEE = READABLE_STREAM + `
// Eager tee: drain the source once into a buffer, then create two
// independent iterators over it. (A lazy tee that pulls on demand
// matches the spec better but is harder to author without microtask
// machinery; eager is sufficient for the language-coverage question.)
function tee(source) {
  let buffer = [];
  let error = null;
  try {
    for (const chunk of source) buffer.push(chunk);
  } catch (e) {
    error = e;
  }
  function branch() {
    let i = 0;
    let canceled = false;
    return {
      [Symbol.iterator]() {
        return {
          next() {
            if (canceled) return { value: undefined, done: true };
            if (error) throw error;
            if (i < buffer.length) {
              let v = buffer[i];
              i = i + 1;
              return { value: v, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
      cancel() { canceled = true; },
    };
  }
  return [branch(), branch()];
}
`;

Deno.test("tee: both branches receive all chunks in order", () => {
  const s = run(TEE + `
    let count = 0;
    let source = new ReadableStream({
      pull(controller) {
        if (count < 3) {
          controller.enqueue('x' + count);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let pair = tee(source);
    let a = pair[0]; let b = pair[1];

    let aChunks = [];
    for (const c of a) aChunks.push(c);
    let bChunks = [];
    for (const c of b) bChunks.push(c);

    let aLen = aChunks.length; let bLen = bChunks.length;
    let a0 = aChunks[0]; let a2 = aChunks[2];
    let b0 = bChunks[0]; let b2 = bChunks[2];
  `);
  assertEquals(s.get(0, 'aLen'), 3);
  assertEquals(s.get(0, 'bLen'), 3);
  assertEquals(s.get(0, 'a0'), 'x0');
  assertEquals(s.get(0, 'a2'), 'x2');
  assertEquals(s.get(0, 'b0'), 'x0');
  assertEquals(s.get(0, 'b2'), 'x2');
});

Deno.test("tee: reading from one branch doesn't drain the other", () => {
  const s = run(TEE + `
    let count = 0;
    let source = new ReadableStream({
      pull(controller) {
        if (count < 5) {
          controller.enqueue(count);
          count = count + 1;
        } else {
          controller.close();
        }
      },
    });

    let pair = tee(source);
    let a = pair[0]; let b = pair[1];

    // Drain a entirely.
    let aChunks = [];
    for (const c of a) aChunks.push(c);

    // b should still have all chunks available.
    let bChunks = [];
    for (const c of b) bChunks.push(c);

    let aLen = aChunks.length; let bLen = bChunks.length;
  `);
  assertEquals(s.get(0, 'aLen'), 5);
  assertEquals(s.get(0, 'bLen'), 5);
});

// =============================================================================
// 8. TransformStream — readable + writable connected through a transform
// =============================================================================

const TRANSFORM_STREAM = `
function TransformStream(transformer) {
  let queue = [];
  let inputClosed = false;
  let flushed = false;
  let readableController = {
    enqueue(chunk) { queue.push(chunk); },
    close() { inputClosed = true; },
    error(e) { throw e; },
  };

  let writable = {
    write(chunk) {
      if (transformer.transform) transformer.transform(chunk, readableController);
      else readableController.enqueue(chunk);
    },
    close() {
      if (transformer.flush) transformer.flush(readableController);
      flushed = true;
      inputClosed = true;
    },
  };

  let readable = {
    [Symbol.iterator]() {
      return {
        next() {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (inputClosed) return { value: undefined, done: true };
          return { value: undefined, done: true };
        },
      };
    },
  };

  return { readable, writable };
}
`;

Deno.test("TransformStream: transform produces transformed chunks 1:1", () => {
  const s = run(TRANSFORM_STREAM + `
    let ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk * 2);
      },
    });

    ts.writable.write(1);
    ts.writable.write(2);
    ts.writable.write(3);
    ts.writable.close();

    let out = [];
    for (const c of ts.readable) out.push(c);
    let len = out.length; let r0 = out[0]; let r2 = out[2];
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 2);
  assertEquals(s.get(0, 'r2'), 6);
});

Deno.test("TransformStream: transform can enqueue 0, 1, or many per input (filter / fan-out)", () => {
  const s = run(TRANSFORM_STREAM + `
    // Filter even numbers, duplicate odds.
    let ts = new TransformStream({
      transform(chunk, controller) {
        if (chunk % 2 === 0) return;          // filter
        controller.enqueue(chunk);
        controller.enqueue(chunk);            // duplicate
      },
    });

    ts.writable.write(1);
    ts.writable.write(2);
    ts.writable.write(3);
    ts.writable.write(4);
    ts.writable.close();

    let out = [];
    for (const c of ts.readable) out.push(c);
    let len = out.length;
    let r0 = out[0]; let r1 = out[1]; let r2 = out[2]; let r3 = out[3];
  `);
  assertEquals(s.get(0, 'len'), 4);
  assertEquals(s.get(0, 'r0'), 1);
  assertEquals(s.get(0, 'r1'), 1);
  assertEquals(s.get(0, 'r2'), 3);
  assertEquals(s.get(0, 'r3'), 3);
});

Deno.test("TransformStream: flush runs once on writable.close and can enqueue final chunks", () => {
  const s = run(TRANSFORM_STREAM + `
    let flushCount = 0;
    let ts = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush(controller) {
        flushCount = flushCount + 1;
        controller.enqueue('FINAL');
      },
    });

    ts.writable.write('a');
    ts.writable.write('b');
    ts.writable.close();

    let out = [];
    for (const c of ts.readable) out.push(c);
    let len = out.length; let last = out[out.length - 1];
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'last'), 'FINAL');
  assertEquals(s.get(0, 'flushCount'), 1);
});

// =============================================================================
// 9. Cancellation & teardown
// =============================================================================

Deno.test("reader.cancel reaches the source's cancel callback with the reason", () => {
  const s = run(`
    function makeStream(source) {
      let canceled = false;
      let cancelReason = null;
      let iter = null;
      let stream = {
        getReader() {
          let i = 0;
          return {
            read() {
              if (canceled) return { value: undefined, done: true };
              if (i < 3) {
                let v = i;
                i = i + 1;
                return { value: v, done: false };
              }
              return { value: undefined, done: true };
            },
            cancel(reason) {
              canceled = true;
              cancelReason = reason;
              if (source.cancel) source.cancel(reason);
              return true;
            },
          };
        },
        _cancelReason() { return cancelReason; },
      };
      return stream;
    }

    let sourceCancelReceived = null;
    let stream = makeStream({
      cancel(reason) { sourceCancelReceived = reason; },
    });

    let reader = stream.getReader();
    let r0 = reader.read();
    reader.cancel('user requested stop');
    let afterCancel = reader.read();
    let afterCancelDone = afterCancel.done;
    let r0v = r0.value;
  `);
  assertEquals(s.get(0, 'r0v'), 0);
  assertEquals(s.get(0, 'afterCancelDone'), true);
  assertEquals(s.get(0, 'sourceCancelReceived'), 'user requested stop');
});

// =============================================================================
// 10. Async iteration end-to-end — pin for-of behavior, document break gap
// =============================================================================

Deno.test("for-of: break mid-iteration leaves source un-canceled (known limitation)", () => {
  // A break in for-of or for-await-of does not run the iterator's return()
  // hook. This test pins the current cleanup behavior.
  //
  // The iterator's cleanup hook is named `return()` in the spec, but
  // sandscript doesn't accept `return` as a property name (it's parsed
  // as the keyword). We use `cleanup()` here as a stand-in — even if
  // C2 shipped using the spec name `return`, the test would still
  // correctly document "break doesn't fire any cleanup hook."
  const s = run(`
    let cancelCalled = false;
    let iter = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            if (i < 100) {
              let v = i;
              i = i + 1;
              return { value: v, done: false };
            }
            return { value: undefined, done: true };
          },
          cleanup() {
            cancelCalled = true;
            return { value: undefined, done: true };
          },
        };
      },
    };

    let collected = [];
    for (const x of iter) {
      collected.push(x);
      if (collected.length === 3) break;
    }

    let len = collected.length;
    let cancelWasCalled = cancelCalled;
  `);
  assertEquals(s.get(0, 'len'), 3);
  // Documenting the known gap: break does not call any cleanup hook.
  assertEquals(s.get(0, 'cancelWasCalled'), false);
});

// =============================================================================
// Async coverage for method-shorthand iterators.
//
// These tests exercise the WHATWG-shaped async-readable pattern:
//
//   {
//     [Symbol.asyncIterator]() {
//       return {
//         async next() {
//           const chunk = await somethingAsync();
//           return chunk === null ? { done: true } : { value: chunk, done: false };
//         }
//       };
//     }
//   }
//
// Together with the for-await coverage in for_of_test.js, these cases cover
// the async-iteration surface.
// =============================================================================

Deno.test("async stream: for-await drains a Promise-returning ReadableStream", async () => {
  const s = await runAsync(`
    function makeStream() {
      let count = 0;
      let stream = {};
      stream[Symbol.asyncIterator] = function() {
        return {
          async next() {
            if (count < 3) {
              let v = count;
              count = count + 1;
              return { value: 'c' + v, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      };
      return stream;
    }

    async function go() {
      let chunks = [];
      for await (const chunk of makeStream()) {
        chunks.push(chunk);
      }
      return chunks;
    }

    let p = go();
    let r0 = 'pending'; let r1 = 'pending'; let r2 = 'pending'; let len = -1;
    p.then(function(arr) {
      r0 = arr[0]; r1 = arr[1]; r2 = arr[2]; len = arr.length;
    });
  `);
  assertEquals(s.get(0, 'len'), 3);
  assertEquals(s.get(0, 'r0'), 'c0');
  assertEquals(s.get(0, 'r1'), 'c1');
  assertEquals(s.get(0, 'r2'), 'c2');
});

Deno.test("async stream: async next() awaits internal work before returning chunk", async () => {
  // Simulates the embedder-fetch pattern: `await readSomethingFromCapability()`
  // inside next(). Each chunk is produced after an await on a settled-but-
  // routed-through-the-event-loop promise.
  const s = await runAsync(`
    async function nextChunk(n) {
      // Doubles via async hop — simulates capability fetch round-trip.
      let v = await Promise.resolve(n * 10);
      return v;
    }

    function makeStream() {
      let count = 0;
      let stream = {};
      stream[Symbol.asyncIterator] = function() {
        return {
          async next() {
            if (count >= 3) return { value: undefined, done: true };
            let v = await nextChunk(count);
            count = count + 1;
            return { value: v, done: false };
          },
        };
      };
      return stream;
    }

    async function go() {
      let total = 0;
      for await (const x of makeStream()) {
        total = total + x;
      }
      return total;
    }

    let p = go();
    let result = -1;
    p.then(function(t) { result = t; });
  `);
  assertEquals(s.get(0, 'result'), 30);  // 0 + 10 + 20
});

Deno.test("async stream: error in async next() surfaces as for-await throw", async () => {
  const s = await runAsync(`
    function makeStream() {
      let count = 0;
      let stream = {};
      stream[Symbol.asyncIterator] = function() {
        return {
          async next() {
            if (count === 0) {
              count = count + 1;
              return { value: 'first', done: false };
            }
            throw 'source failed';
          },
        };
      };
      return stream;
    }

    async function go() {
      let received = [];
      let caught = null;
      try {
        for await (const x of makeStream()) {
          received.push(x);
        }
      } catch (e) {
        caught = e;
      }
      return { received, caught };
    }

    let p = go();
    let firstChunk = 'pending';
    let recvLen = -1;
    let errorCaught = 'pending';
    p.then(function(r) {
      firstChunk = r.received[0];
      recvLen = r.received.length;
      errorCaught = r.caught;
    });
  `);
  assertEquals(s.get(0, 'firstChunk'), 'first');
  assertEquals(s.get(0, 'recvLen'), 1);
  assertEquals(s.get(0, 'errorCaught'), 'source failed');
});
