/**
 * CRITTER INSTANCE — what every critter material knows about "its" agent.
 *
 * A critter is drawn as ONE instanced quad per arena slot. The vertex stage of each
 * material reads that slot's row out of the arena's storage buffers (the only stage
 * a storage buffer may be read from on this renderer — a fragment gets what it needs
 * as a VARYING), and every kind needs the same handful of derived values: where it
 * is, how big this individual is, and how visible it is right now. Here they are, so
 * the fly, the maggot and the firefly cannot disagree about them.
 *
 * ============================================================================
 * VISIBILITY IS A FRACTION OF A SLOT
 * ============================================================================
 *
 * `uActive` is a FLOAT: the number of slots currently showing. Slot k is fully
 * visible when `active ≥ k + 1`, invisible when `active ≤ k`, and cross-fading in
 * between — so when the twilight window opens or a storm blows in, the swarm swells
 * and thins one individual at a time instead of popping. `age` adds a short fade-in
 * after a slot respawns, so a fly recycled by the brain never appears from nothing.
 *
 * @module effects/critters/critter-instance
 */

/**
 * The smallest an individual may be relative to the author's size. A variation of 1 would otherwise let a
 * slot's multiplier reach 0 — a fly of zero length, and a division by it in the brain that poisons the
 * slot with NaN for good.
 */
export const MIN_SIZE_MUL = 0.3;

/** No body is shorter than this many px, whatever the sliders say: it is a divisor all over the brains. */
export const MIN_LENGTH_PX = 1;

/**
 * What a slot's stored seed means. The seed is `id + stamp`: the INTEGER part is the slot's identity, and
 * everything about how this individual looks derives from it (so it never changes); the FRACTIONAL part is
 * the stamp of the home it last spawned under (`critter-zone.js#createSlotStamper` says why the brain
 * wants it). Splitting here, in one place, is what lets the stamp change without a fly changing colour.
 *
 * @param {*} TSL
 * @param {*} seedNode - the stored seed (float node).
 * @param {*} variationNode - how much individuals differ in size (float node, 0..1).
 * @returns {{id: *, stamp: *, seed01: *, sizeMul: *}} float nodes.
 */
export function readSeed(TSL, seedNode, variationNode) {
  const { float, floor, fract, sin, max } = TSL;
  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const id = floor(seedNode);
  return {
    id,
    stamp: seedNode.sub(id),
    seed01: hash11(id.mul(3.1).add(0.5)),
    sizeMul: max(float(1).add(hash11(id.mul(1.7).add(3.1)).sub(0.5).mul(2).mul(variationNode)), MIN_SIZE_MUL),
  };
}

/**
 * @param {*} TSL
 * @param {object} a
 * @param {Record<string, *>} a.buffers - the arena's storage nodes.
 * @param {(name: string) => *} a.u - the uniform bank's `get`.
 * @param {string} a.sizeParam - uniform naming this kind's body length in px.
 * @param {string} a.variationParam - uniform naming how much individuals differ in size.
 * @param {number} [a.fadeInSec=0.6]
 * @returns {object} nodes: `i, fi, P, V, AGE, S (the slot's identity), C, PH, seed01, L, alpha`.
 */
export function buildInstance(TSL, { buffers, u, sizeParam, variationParam, fadeInSec = 0.6 }) {
  const { float, instanceIndex, clamp, select, max } = TSL;
  const i = instanceIndex;
  const fi = float(i);
  const P = buffers.position.element(i);
  const V = buffers.velocity.element(i);
  const AGE = buffers.age.element(i);
  const C = buffers.custom.element(i);
  const PH = buffers.phase.element(i);

  const { id: S, seed01, sizeMul } = readSeed(TSL, buffers.seed.element(i), u(variationParam));
  const L = max(u(sizeParam).mul(sizeMul), MIN_LENGTH_PX);

  const slotAlpha = clamp(u('active').sub(fi), 0, 1);
  const alpha = slotAlpha
    .mul(clamp(AGE.div(fadeInSec), 0, 1))
    .mul(u('opacity'))
    .mul(select(fi.lessThan(u('population')), float(1), float(0)));

  return { i, fi, P, V, AGE, S, C, PH, seed01, L, alpha };
}
