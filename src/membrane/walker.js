import { TYPE, CONTEXT_STATUS_FREE } from '../fuel/constants.js';

/**
 * Build a Collector.valueObserver that records every TYPE.EXTERNAL slot it
 * visits into `into`. For a TYPE.EXTERNAL value, dataLo IS the handle slot.
 * MembraneWalker.collectLiveHandleSlots() and the host's single-pass GC
 * integration share this observer, so both compute heap-reachable handle
 * slots identically.
 *
 * @param {Set<number>} into
 * @returns {(type:number, dataLo:number, valueAddr:number) => void}
 */
export function makeExternalSlotObserver(into) {
  return (type, dataLo, _valueAddr) => {
    // EXTERNAL_METHOD bindings (`let f = Api.method`) carry the handle
    // slot in data_lo too — a binding is a live reference to its
    // handle even when the TYPE.EXTERNAL value itself is unreachable.
    if (type === TYPE.EXTERNAL || type === TYPE.EXTERNAL_METHOD) {
      into.add(dataLo);
    }
  };
}

/**
 * MembraneWalker: enumerates live handle and grant slots that the membrane
 * compactor must keep alive.
 *
 * "Live" means: there exists at least one reference to the slot, anywhere
 * the airlock or interpreter could later try to use it. Compaction frees
 * any slot NOT in this set.
 *
 * Reference sources walked:
 *
 *   - Interpreter heap — every value slot is checked; TYPE.EXTERNAL values'
 *     dataLo is a referenced handle slot.
 *   - Every active context's WAT grant stack — each entry's grantId is a
 *     referenced grant slot.
 *   - Closure-handle registry — each entry's capturedGrantIds Set
 *     contributes referenced grant slots, AND each entry's pointer keeps
 *     its underlying closure (and any externals it captures) alive
 *     via the GC's externalRoots mechanism.
 *   - Root grants — every slot in membrane.rootGrantSlots() is referenced.
 *   - Each live handle's grant list contributes grants. A live handle
 *     requires its authorizing grant(s) to remain alive, else the handle
 *     would be orphaned and its operations unauthorizable. One pass
 *     suffices — handles don't reference handles, grants don't reference
 *     grants.
 *
 *     The reverse direction — "each live grant's handle list contributes
 *     handles" — is INTENTIONALLY NOT applied. A grant's idList records
 *     which handles are *authorized* to operate under this grant (an
 *     authorization domain), not which handles are *reachable* through
 *     this grant (a reference relation). Handle reachability comes from
 *     the interpreter heap, closure captures, or declared globals — never
 *     from grant membership. Capability patterns that mint a fresh handle
 *     per call and attach it to a long-lived grant (e.g. each fetch Response
 *     added to the fetch grant) routinely create handles whose only lifetime
 *     anchor is the caller-side local variable; once the caller drops it,
 *     the handle is genuinely unreachable and compaction reaps it. Marking
 *     such handles live via the grant would leak them indefinitely.
 *
 * For the interpreter heap, the walk piggybacks on Collector's mark phase
 * via the `valueObserver` hook. Collector already knows where every value
 * slot lives; reusing its recursion is far cheaper than re-implementing the
 * structural walk. The mark pass mutates GC mark bits as a side effect,
 * but those bits are cleared at the start of every subsequent GC mark
 * pass (`Collector.clearAllMarks`), so the side effect is invisible to
 * the rest of the system.
 */
export class MembraneWalker {
  /**
   * @param {Object} memoryImage - A MemoryReader (or MemoryImage) — used
   *   for grant stack iteration; only read-only methods are called, so a
   *   bare MemoryReader works.
   * @param {Object} collector - The session's Collector (reused for heap walk)
   * @param {Object} airlock - The Airlock (for closure registry, root grants)
   * @param {Object} membrane - The Membrane (for inverse-index lookup)
   */
  constructor(memoryImage, collector, airlock, membrane) {
    this.memoryImage = memoryImage;
    this.collector = collector;
    this.airlock = airlock;
    this.membrane = membrane;
  }

  /**
   * Walk all roots and return the live-id sets.
   * @returns {{ liveHandleSlots: Set<number>, liveGrantSlots: Set<number> }}
   */
  walk() {
    const liveHandleSlots = this.collectLiveHandleSlots();
    return this.walkFrom(liveHandleSlots);
  }

  /**
   * Run the collector's mark phase with an observer that records every
   * reachable TYPE.EXTERNAL slot. A host that already runs the GC mark
   * phase can use the same observer and then call walkFrom(), avoiding a
   * second heap walk.
   *
   * @returns {Set<number>} live handle slots reachable from the interpreter heap.
   */
  collectLiveHandleSlots() {
    const liveHandleSlots = new Set();
    const observer = makeExternalSlotObserver(liveHandleSlots);

    // Use the airlock's canonical root set so we observe everything the GC
    // would observe (closures + linked promises). Otherwise externals
    // reachable only through a JS-bridged promise would be freed wrongly.
    const externalRoots = this.airlock.getClosureRoots();

    this.collector.externalRoots = externalRoots;
    this.collector.valueObserver = observer;
    try {
      this.collector.markPhase();
    } finally {
      this.collector.valueObserver = null;
      this.collector.externalRoots = [];
    }
    return liveHandleSlots;
  }

  /**
   * Given the heap-reachable handle slots, compute the full live sets from
   * the non-heap roots: WAT grant stacks, closure-captured grants, root
   * grants, and transitive handle-to-grant edges. This method does not run
   * a mark phase. The standalone walk() collects heap handles before
   * delegating here; a host that observes handles during its own mark pass
   * calls this method directly.
   *
   * @param {Set<number>} liveHandleSlots - heap-reachable handle slots.
   * @returns {{ liveHandleSlots: Set<number>, liveGrantSlots: Set<number> }}
   */
  walkFrom(liveHandleSlots) {
    const liveGrantSlots = new Set();

    // Every active context's WAT grant stack.
    const contextCount = this.memoryImage.getContextCount();
    for (let ctx = 0; ctx < contextCount; ctx++) {
      // Skip free context slots.
      if (this.memoryImage.getExitCondition(ctx) === CONTEXT_STATUS_FREE) continue;
      const depth = this.memoryImage.getGrantDepth(ctx);
      for (let i = 0; i < depth; i++) {
        const entry = this.memoryImage.getGrantEntry(ctx, i);
        liveGrantSlots.add(entry.grantId);
      }
    }

    // Closure handles' captured grant slots are read from the shared buffer,
    // not from a JS Map. The closures themselves were added as externalRoots
    // above so the heap walk picks up their captured TYPE.EXTERNAL values;
    // here we additionally record the grants captured at registration time.
    for (const entry of this.membrane.enumerateClosureHandles()) {
      for (const grantSlot of entry.capturedGrantSlots) {
        liveGrantSlots.add(grantSlot);
      }
    }

    // Object handles' captured grant slots are recorded separately. The
    // retained objects themselves (and every surrogate prototype) ride the
    // externalRoots set via airlock.getClosureRoots(), so the heap walk sees
    // their captured TYPE.EXTERNAL values; here we additionally record the
    // grants captured at first retention.
    for (const entry of this.membrane.enumerateObjectHandles()) {
      for (const grantSlot of entry.capturedGrantSlots) {
        liveGrantSlots.add(grantSlot);
      }
    }

    // Root grants.
    for (const slot of this.membrane.rootGrantSlots()) {
      liveGrantSlots.add(slot);
    }

    // Live handles contribute their authorizing grants in one pass because
    // handles don't reference handles. The reverse direction (grants to
    // handles) is intentionally omitted for the reasons described above.
    for (const handleSlot of liveHandleSlots) {
      const grantSet = this.membrane._readHandleGrantSet(handleSlot);
      for (const grantSlot of grantSet) {
        liveGrantSlots.add(grantSlot);
      }
    }

    return { liveHandleSlots, liveGrantSlots };
  }
}
