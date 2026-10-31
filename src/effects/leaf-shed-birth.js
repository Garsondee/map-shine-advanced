/**
 * LEAF SHED — THE BIRTH RECORD, the one fact the CPU tells the GPU about a leaf.
 *
 * Pure JS, Node-tested; the engine (`effects/particles/leaf-shed-runtime.js`)
 * reads the same layout in TSL through {@link unpackBirthTagNodes}.
 *
 * Each arena slot owns two `vec4`s in one storage buffer that ONLY the CPU
 * writes:
 *
 *   rec0 = (x, y, stamp, tag)        world px; stamp; packed kind/ramp/size
 *   rec1 = (r, g, b, heightPx)       straight sRGB 0..1; birth height above ground
 *
 * THE STAMP is how a GPU slot learns it has been reborn — the critter zone's
 * trick (`critter-zone.js#createSlotStamper`): the kernel keeps the stamp it
 * last started from (in the arena's `seed` row) and starts a new leaf the frame
 * the two differ. The CPU never writes the slot's moving state, so it never
 * clobbers what the kernel has integrated since (the CPU's copy of THAT is
 * stale by construction — `no-gpu-readback`).
 *
 * ⚠️ THE TAG IS THREE QUANTITIES IN ONE FLOAT, BY DESIGN — normally a named bug
 * class here (`feedback_one_byte_two_quantities`), so it is a documented
 * ENCODING with one packer and one unpacker, never arithmetic at a call site:
 *
 *   tag = kind × 262144 + round(ramp × 63) × 4096 + min(4095, round(sizePx))
 *
 * kind ∈ {0,1,2} (leaf, clump, twig), ramp ∈ [0,1] in 1/63 steps (how hard the
 * CPU thought the wind was blowing when it proposed this birth — the GPU
 * divides the real local air by it), sizePx ∈ [1, 4095]. The largest tag is
 * 2×262144 + 63×4096 + 4095 = 786431, far inside a float's exact-integer range
 * (2²⁴), so the round trip is exact.
 *
 * @module effects/leaf-shed-birth
 */

/** vec4s per slot in the birth buffer. */
export const BIRTH_VEC4_PER_SLOT = 2;
/** Floats per slot in the birth buffer. */
export const BIRTH_FLOATS_PER_SLOT = BIRTH_VEC4_PER_SLOT * 4;

const KIND_UNIT = 262144;
const RAMP_UNIT = 4096;
const RAMP_STEPS = 63;
const SIZE_MAX = 4095;
/** Stamps cycle 1..STAMP_WRAP (exact as floats; far more births than any ring holds). */
export const STAMP_WRAP = 8_000_000;

/**
 * @param {number} kind - 0 leaf, 1 clump, 2 twig.
 * @param {number} ramp01
 * @param {number} sizePx
 * @returns {number}
 */
export function packBirthTag(kind, ramp01, sizePx) {
  const k = Math.min(2, Math.max(0, Math.round(kind) || 0));
  const r = Math.round(Math.min(1, Math.max(0, Number(ramp01) || 0)) * RAMP_STEPS);
  const s = Math.min(SIZE_MAX, Math.max(1, Math.round(Number(sizePx) || 1)));
  return k * KIND_UNIT + r * RAMP_UNIT + s;
}

/** @param {number} tag @returns {{kind:number, ramp01:number, sizePx:number}} */
export function unpackBirthTag(tag) {
  const t = Math.max(0, Math.round(tag));
  const kind = Math.floor(t / KIND_UNIT);
  const rest = t - kind * KIND_UNIT;
  const r = Math.floor(rest / RAMP_UNIT);
  return { kind, ramp01: r / RAMP_STEPS, sizePx: rest - r * RAMP_UNIT };
}

/**
 * The TSL twin of {@link unpackBirthTag}. Floors on floats that are exact
 * integers, so it agrees with the JS unpacker bit for bit.
 * @param {*} TSL @param {*} tag - float node.
 * @returns {{kind:*, ramp01:*, sizePx:*}}
 */
export function unpackBirthTagNodes(TSL, tag) {
  const { float, floor } = TSL;
  const t = floor(tag.add(0.5));
  const kind = floor(t.div(float(KIND_UNIT)));
  const rest = t.sub(kind.mul(float(KIND_UNIT)));
  const r = floor(rest.div(float(RAMP_UNIT)));
  return { kind, ramp01: r.div(float(RAMP_STEPS)), sizePx: rest.sub(r.mul(float(RAMP_UNIT))) };
}

/**
 * Write one birth into a slot of the backing array.
 * @param {Float32Array} backing - the birth buffer's floats.
 * @param {number} slot
 * @param {number} stamp - a value this slot has never held before.
 * @param {{x:number,y:number,kind:number,ramp:number,sizePx:number,rgb:number[],heightPx:number}} b - rgb in sRGB bytes.
 */
export function writeBirth(backing, slot, stamp, b) {
  const o = slot * BIRTH_FLOATS_PER_SLOT;
  backing[o] = b.x;
  backing[o + 1] = b.y;
  backing[o + 2] = stamp;
  backing[o + 3] = packBirthTag(b.kind, b.ramp, b.sizePx);
  backing[o + 4] = b.rgb[0] / 255;
  backing[o + 5] = b.rgb[1] / 255;
  backing[o + 6] = b.rgb[2] / 255;
  backing[o + 7] = b.heightPx;
}

/**
 * The CPU's slot ring. Births go to consecutive slots, wrapping; a slot is
 * reused oldest-first, so the ring only cuts a leaf short when the scene asks
 * for more than `capacity` leaves alive at once (the caller's budget keeps that
 * rare). Stamps only ever grow, starting at 1 so a zeroed buffer (stamp 0)
 * matches the kernel's zeroed `seed` row and births nothing.
 *
 * @param {number} capacity
 */
export function createBirthRing(capacity) {
  const cap = Math.max(1, capacity | 0);
  let next = 0;
  let stamp = 1;
  return {
    capacity: cap,
    /**
     * Claim `n` slots. Returns the claimed runs as `[start, count]` pairs (one,
     * or two when the claim wraps) so the uploader can send just those ranges.
     * @param {number} n
     * @returns {{slots:number[], stamps:number[], runs:Array<[number, number]>}}
     */
    claim(n) {
      const count = Math.min(cap, Math.max(0, n | 0));
      const slots = new Array(count);
      const stamps = new Array(count);
      for (let i = 0; i < count; i++) {
        slots[i] = next;
        stamps[i] = stamp;
        // Wrapped well inside a float's exact integers (2²⁴). A slot's previous
        // stamp is at most `cap` births old, so a wrapped stamp still differs.
        stamp = stamp >= STAMP_WRAP ? 1 : stamp + 1;
        next = (next + 1) % cap;
      }
      const runs = [];
      if (count > 0) {
        const first = slots[0];
        const tail = Math.min(count, cap - first);
        runs.push([first, tail]);
        if (count > tail) runs.push([0, count - tail]);
      }
      return { slots, stamps, runs };
    },
    get nextSlot() {
      return next;
    },
  };
}
