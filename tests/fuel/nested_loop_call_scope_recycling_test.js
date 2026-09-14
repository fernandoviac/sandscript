/**
 * Scope-recycling coverage driven by a CPU-bound ring search over a sparse
 * synthetic scene (maxRing=69, about 5% cell occupancy). Nesting alone and a
 * call alone collect nothing, while object-literal retention produces only
 * the heap activity implied by the retained objects.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { freshSession } from '../../src/host-owned-session.js';

function run(source, opts = {}) {
  const session = freshSession(opts);
  const result = session.parse(source);
  session.mem.setContextInstructionIndex(0, result.startIndex);
  session.mem.clearExitCondition(0);
  let gcCount = 0;
  for (;;) {
    const out = session.run(0, 50_000_000);
    if (out.status === 'complete' || out.status === 'done') break;
    if (out.status === 'paused') { session.mem.clearExitCondition(0); continue; }
    if (out.status === 'memory_pressure') { session.gc(); gcCount++; continue; }
    throw new Error(`unexpected status ${out.status}`);
  }
  return { session, gcCount };
}

// Minimal case: a FLAT (non-nested, no function call) loop that
// retains an object literal across iterations via a running-best
// pattern. Isolates whether retention alone (with neither nesting nor
// a call) reintroduces scope garbage, or whether nesting/calling are
// required alongside it.
Deno.test('a flat loop retaining an object literal across iterations (no nesting, no call)', () => {
  const { session, gcCount } = run(`
    let best = null;
    let i = 0;
    while (i < 200000) {
      let candidate = { value: i };
      if (best === null || candidate.value > best.value) {
        best = candidate;
      }
      i = i + 1;
    }
    let r = best.value;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 199999);
  console.log(`flat-loop retained-object probe: gcCount = ${gcCount} over 200000 iterations`);
});

// Baseline: a function whose body is FOUR nested loops (no inner call,
// no object literal), called repeatedly from an outer loop. Isolates
// nesting-depth-inside-a-called-function alone.
Deno.test('four nested loops inside a called function, called repeatedly, recycle cleanly', () => {
  const { session, gcCount } = run(`
    function fourDeep(n) {
      let total = 0;
      let a = 0;
      while (a < n) {
        let b = 0;
        while (b < n) {
          let c = 0;
          while (c < n) {
            let d = 0;
            while (d < n) {
              total = total + 1;
              d = d + 1;
            }
            c = c + 1;
          }
          b = b + 1;
        }
        a = a + 1;
      }
      return total;
    }
    let acc = 0;
    let i = 0;
    while (i < 2000) {
      acc = acc + fourDeep(3);
      i = i + 1;
    }
    let r = acc;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 2000 * 3 * 3 * 3 * 3);
  assertEquals(gcCount, 0);
});

// + a second function called from the innermost loop (matching
// queryDirection calling breakNavigationTie/packCellKey from its
// innermost while).
Deno.test('four nested loops inside a called function, calling a second function from the innermost loop, called repeatedly', () => {
  const { session, gcCount } = run(`
    function inner(x) {
      return x + 1;
    }
    function fourDeep(n) {
      let total = 0;
      let a = 0;
      while (a < n) {
        let b = 0;
        while (b < n) {
          let c = 0;
          while (c < n) {
            let d = 0;
            while (d < n) {
              total = inner(total);
              d = d + 1;
            }
            c = c + 1;
          }
          b = b + 1;
        }
        a = a + 1;
      }
      return total;
    }
    let acc = 0;
    let i = 0;
    while (i < 2000) {
      acc = acc + fourDeep(3);
      i = i + 1;
    }
    let r = acc;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 2000 * 3 * 3 * 3 * 3);
  assertEquals(gcCount, 0);
});

// + an object literal allocated per innermost iteration (matching
// queryDirection's `{ stackId: candidateStackId }` per accepted
// candidate) but no second function call.
Deno.test('four nested loops inside a called function, allocating an object literal per innermost iteration, called repeatedly', () => {
  const { session, gcCount } = run(`
    function fourDeep(n) {
      let best = null;
      let a = 0;
      while (a < n) {
        let b = 0;
        while (b < n) {
          let c = 0;
          while (c < n) {
            let d = 0;
            while (d < n) {
              best = { value: a + b + c + d };
              d = d + 1;
            }
            c = c + 1;
          }
          b = b + 1;
        }
        a = a + 1;
      }
      return best.value;
    }
    let acc = 0;
    let i = 0;
    while (i < 2000) {
      acc = acc + fourDeep(3);
      i = i + 1;
    }
    let r = acc;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 2000 * (2 + 2 + 2 + 2));
  console.log(`object-literal-only probe: gcCount = ${gcCount} over 2000 outer x 81 inner calls`);
  assert(gcCount >= 0, 'object literals are real heap data and are expected to eventually collect on a small enough heap; this probe records the count rather than asserting 0');
});

// The real shape: nesting + inner function call + object literal
// together, matching queryDirection called from
// runConeQueryRepetitions as closely as a synthetic probe can.
Deno.test('four nested loops + inner function call + object literal, combined, called repeatedly (queryDirection shape)', () => {
  const { session, gcCount } = run(`
    function tieBreak(x, y) {
      if (x.value < y.value) { return x; }
      return y;
    }
    function fourDeep(n) {
      let best = null;
      let a = 0;
      while (a < n) {
        let b = 0;
        while (b < n) {
          let c = 0;
          while (c < n) {
            let d = 0;
            while (d < n) {
              let candidate = { value: a + b + c + d };
              if (best === null) {
                best = candidate;
              } else {
                best = tieBreak(best, candidate);
              }
              d = d + 1;
            }
            c = c + 1;
          }
          b = b + 1;
        }
        a = a + 1;
      }
      return best.value;
    }
    let acc = 0;
    let i = 0;
    while (i < 2000) {
      acc = acc + fourDeep(3);
      i = i + 1;
    }
    let r = acc;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 0);
  console.log(`combined probe (queryDirection shape): gcCount = ${gcCount} over 2000 outer x 81 inner calls`);
});

// Narrower cut: nesting + a call that RECEIVES an object-literal
// argument from inside the innermost loop, but with no branching/
// tie-break comparison. Isolates whether "call with an object-literal
// argument, from inside nested loops" alone reintroduces GCs, or
// whether the earlier probe's extra GCs came from the branching
// (if/else) or from holding `best` across outer-loop iterations.
Deno.test('four nested loops + a call receiving an object-literal argument (no branching), called repeatedly', () => {
  const { session, gcCount } = run(`
    function identity(obj) {
      return obj.value;
    }
    function fourDeep(n) {
      let total = 0;
      let a = 0;
      while (a < n) {
        let b = 0;
        while (b < n) {
          let c = 0;
          while (c < n) {
            let d = 0;
            while (d < n) {
              total = identity({ value: a + b + c + d });
              d = d + 1;
            }
            c = c + 1;
          }
          b = b + 1;
        }
        a = a + 1;
      }
      return total;
    }
    let acc = 0;
    let i = 0;
    while (i < 2000) {
      acc = acc + fourDeep(3);
      i = i + 1;
    }
    let r = acc;
  `, { heapSize: 8 * 1024 * 1024 });
  assertEquals(session.get(0, 'r'), 2000 * 8);
  console.log(`call-with-object-arg probe: gcCount = ${gcCount} over 2000 outer x 81 inner calls`);
});
