/**
 * THE PARTICLE ARENA — one pool of GPU storage, allocated ONCE, sub-ranged per
 * system, never freed. This is the whole GC answer (docs/planning/Particles.md
 * §10-11), made executable.
 *
 * ============================================================================
 * WHY "NEVER FREED" IS THE POINT, NOT A SHORTCUT
 * ============================================================================
 *
 * A `StorageInstancedBufferAttribute` extends `BufferAttribute`, which has NO
 * `dispose()` (memory: reference_bufferattribute_no_dispose_trap — the leak that
 * cost a live WebGPU device-loss in ~30s). So "how do you free a particle
 * buffer" is a genuinely unanswered question in this build. This arena makes the
 * question moot: it allocates its ENTIRE budget once, and after that the engine
 * never allocates or frees a GPU buffer again. A system deregistering returns its
 * slot range to a CPU-side free-list (an array operation); the GPU memory is
 * recycled, never destroyed. There is no disposal path to get wrong because there
 * is no disposal — the same discipline as vt/atlas.js's one DataArrayTexture.
 *
 * At the sizes involved this is free: the default 96 MB budget is ~2.1M particles
 * and a rounding error against the ~2.5 GB ceiling that caused the 12k-map
 * device-loss (memory: keyhole-device-loss-large-map). VRAM is a non-issue here;
 * it is stated because that crash makes every new GPU allocation look guilty.
 *
 * ============================================================================
 * WHY THIS IS THE ONE DOOR
 * ============================================================================
 *
 * `instancedArray()` is particle-memory allocation. It lives here and nowhere
 * else, enforced by the `particles/allocator-only` wall (tools/verify-structure
 * .mjs) — the exact sibling of `gpu/allocator-only` for render targets. Storage
 * buffers slip past graph/three-allocator.js (which guards only render targets),
 * so this budget is their ONLY ceiling. The allocator that enforced Keyhole's
 * render-target law sat with ZERO callers and would have thrown on first use; the
 * one-sentence finding of this whole module is that an optional law loses. This
 * one is wired from its first commit.
 *
 * The pure bookkeeping (`describeParticleArena`, the free-list) is THREE-free so
 * it is Node-tested today; `allocateBuffers()` is the thin browser-only wrapper —
 * the same testable-core / thin-GPU-shell split graph/three-allocator.js uses.
 *
 * @module effects/particles/particle-arena
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('particle-arena');

/**
 * Byte size of each TSL storage type. The budget math is DERIVED from the layout
 * through this table, never hand-copied, so capacity can't silently drift from
 * the attribute set (the derive-once discipline —
 * memory: feedback_probed_constants_vs_derived).
 * @readonly
 */
const TSL_TYPE_BYTES = Object.freeze({ float: 4, vec2: 8, vec3: 12, vec4: 16 });

/**
 * The per-particle attributes — Structure-of-Arrays, GPU-resident. A particle is
 * a ROW across these buffers, never a struct and never a JS object (that object
 * was V2's actual bottleneck, present in 11 files — Particles.md §2, §11).
 *
 * First-slice layout, deliberately alignment-friendly: every type is naturally
 * aligned (no vec3, which WebGPU pads to 16), so `BYTES_PER_PARTICLE` is exact,
 * not an estimate. Packing into fewer vec4s is a later, measure-then-pack step
 * once diag/perf-lab.js proves bandwidth demands it (Particles.md §10) — clarity
 * first.
 * @readonly
 */
export const PARTICLE_ATTRIBUTES = Object.freeze([
  Object.freeze({ name: 'position', type: 'vec2' }), // world xy
  Object.freeze({ name: 'velocity', type: 'vec2' }), // world px/s
  Object.freeze({ name: 'age', type: 'float' }), // seconds alive
  Object.freeze({ name: 'life', type: 'float' }), // total lifespan (set at spawn)
  Object.freeze({ name: 'seed', type: 'float' }), // per-particle RNG seed, stable for life
  Object.freeze({ name: 'custom', type: 'vec4' }), // per-system packed extras
]);

/** Exact bytes one particle occupies across all buffers. Derived, never typed. */
export const BYTES_PER_PARTICLE = PARTICLE_ATTRIBUTES.reduce((n, a) => n + TSL_TYPE_BYTES[a.type], 0);

/** 96 MB ≈ 2.1M particles at the first-slice layout. A rounding error vs the ceiling. */
export const DEFAULT_BUDGET_BYTES = 96 * 1024 * 1024;

/**
 * Pure: a budget → the capacity and layout it buys. No THREE, no GPU — so the
 * whole cost model is a Node test, months before a buffer is allocated.
 *
 * @param {{budgetBytes?: number, bytesPerParticle?: number}} [config]
 * @returns {{budgetBytes:number, bytesPerParticle:number, capacity:number, attributes:typeof PARTICLE_ATTRIBUTES}}
 */
export function describeParticleArena({
  budgetBytes = DEFAULT_BUDGET_BYTES,
  bytesPerParticle = BYTES_PER_PARTICLE,
} = {}) {
  const capacity = Math.max(0, Math.floor(budgetBytes / bytesPerParticle));
  return { budgetBytes, bytesPerParticle, capacity, attributes: PARTICLE_ATTRIBUTES };
}

/**
 * A handle to a system's reserved slot range within the arena.
 * @typedef {{offset:number, capacity:number}} ArenaReservation
 */

/**
 * The arena: a fixed pool of particle slots, sub-ranged by a coalescing free-list.
 * Bookkeeping is pure and total (Node-tested); {@link ParticleArena#allocateBuffers}
 * is the one browser-only method.
 */
export class ParticleArena {
  /** @param {{budgetBytes?: number, bytesPerParticle?: number}} [config] */
  constructor(config = {}) {
    const { capacity, budgetBytes, bytesPerParticle, attributes } = describeParticleArena(config);
    /** Total slot count the whole engine owns. */
    this.capacity = capacity;
    this.budgetBytes = budgetBytes;
    this.bytesPerParticle = bytesPerParticle;
    this.attributes = attributes;
    /**
     * Disjoint free ranges `[start, end)`, kept sorted by `start`. Begins as one
     * range spanning the whole arena. Coalesced on {@link release} so
     * register/deregister churn can't fragment it.
     * @type {{start:number, end:number}[]}
     */
    this._free = capacity > 0 ? [{ start: 0, end: capacity }] : [];
    this._used = 0;
    /** GPU storage nodes, created once by allocateBuffers(). Null until then. */
    this._buffers = null;
  }

  /** Slots currently reserved by systems. */
  get used() {
    return this._used;
  }

  /** Slots still available to reserve. */
  get available() {
    return this.capacity - this._used;
  }

  /**
   * Reserve a contiguous range of `count` slots for a system (first-fit). Throws
   * LOUD if the budget can't fit it — a dev-time crash at the call site with the
   * numbers, never a silent over-allocation surfacing as a device-loss weeks
   * later (the graph/three-allocator.js posture).
   *
   * @param {number} count
   * @returns {ArenaReservation}
   */
  reserve(count) {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return { offset: 0, capacity: 0 };

    for (let i = 0; i < this._free.length; i++) {
      const r = this._free[i];
      if (r.end - r.start >= n) {
        const offset = r.start;
        r.start += n;
        if (r.start === r.end) this._free.splice(i, 1);
        this._used += n;
        return { offset, capacity: n };
      }
    }

    throw new Error(
      `[particle budget] ParticleArena.reserve(${n}): only ${this.available} of ${this.capacity} slots free ` +
        `(${this.attributes.length} buffers × ${this.bytesPerParticle} B/particle, ` +
        `${Math.round(this.budgetBytes / (1024 * 1024))} MB budget). A particle system asked for more memory ` +
        `than the whole engine owns. Raise the budget DELIBERATELY (a design decision — Particles.md §10) or ` +
        `lower the system's max-tier capacity. This cap is hard by design: storage buffers slip past the ` +
        `render-target allocator, so it is their only ceiling.`
    );
  }

  /**
   * Return a reservation's range to the free-list, coalescing with any adjacent
   * free ranges. The GPU memory is NOT freed (§10 — there is no dispose path to
   * get wrong); the slots are recycled for the next system to reserve.
   *
   * @param {ArenaReservation} handle
   */
  release(handle) {
    if (!handle || !(handle.capacity > 0)) return;
    const start = handle.offset;
    const end = handle.offset + handle.capacity;

    // Insertion point, keeping _free sorted by start.
    let i = 0;
    while (i < this._free.length && this._free[i].start < start) i++;

    // Overlap with a neighbour means a double-release or a bogus handle — a bug.
    // Report it (never a silent swallow — memory: feedback_instruments_must_not_lie)
    // and refuse, rather than corrupt the free-list into overlapping ranges.
    const prev = this._free[i - 1];
    const next = this._free[i];
    if ((prev && start < prev.end) || (next && end > next.start)) {
      log.error(
        `release([${start},${end})) overlaps a free range — double-release or bogus handle; ignored. ` +
          'Accounting may be off; the arena is NOT corrupted.'
      );
      return;
    }

    this._free.splice(i, 0, { start, end });
    // Coalesce left, then right, where ranges exactly touch.
    if (i > 0 && this._free[i - 1].end === this._free[i].start) {
      this._free[i - 1].end = this._free[i].end;
      this._free.splice(i, 1);
      i--;
    }
    if (i < this._free.length - 1 && this._free[i].end === this._free[i + 1].start) {
      this._free[i].end = this._free[i + 1].end;
      this._free.splice(i + 1, 1);
    }
    this._used -= handle.capacity;
  }

  /**
   * Create the ONE set of GPU storage buffers, once (idempotent). Browser-only:
   * needs `THREE.TSL`. This is the SOLE `instancedArray` call site in the app —
   * the `particles/allocator-only` wall guarantees it.
   *
   * @param {*} TSL - `THREE.TSL`.
   * @returns {Record<string, *>} attribute name → storage node
   */
  allocateBuffers(TSL) {
    if (this._buffers) return this._buffers;
    const { instancedArray } = TSL;
    const buffers = {};
    for (const attr of this.attributes) {
      buffers[attr.name] = instancedArray(this.capacity, attr.type);
    }
    this._buffers = buffers;
    log.info(
      `arena allocated: ${this.capacity} slots × ${this.attributes.length} buffers, ` +
        `${Math.round(this.budgetBytes / (1024 * 1024))} MB budget`
    );
    return buffers;
  }

  /** The storage nodes, or null before allocateBuffers(). */
  get buffers() {
    return this._buffers;
  }
}
