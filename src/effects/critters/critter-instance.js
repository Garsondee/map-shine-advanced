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
 * @param {*} TSL
 * @param {object} a
 * @param {Record<string, *>} a.buffers - the arena's storage nodes.
 * @param {(name: string) => *} a.u - the uniform bank's `get`.
 * @param {string} a.sizeParam - uniform naming this kind's body length in px.
 * @param {string} a.variationParam - uniform naming how much individuals differ in size.
 * @param {number} [a.fadeInSec=0.6]
 * @returns {object} nodes: `i, fi, P, V, AGE, S, C, PH, seed01, L, alpha`.
 */
export function buildInstance(TSL, { buffers, u, sizeParam, variationParam, fadeInSec = 0.6 }) {
  const { float, instanceIndex, fract, sin, clamp, select } = TSL;
  const i = instanceIndex;
  const fi = float(i);
  const P = buffers.position.element(i);
  const V = buffers.velocity.element(i);
  const AGE = buffers.age.element(i);
  const S = buffers.seed.element(i);
  const C = buffers.custom.element(i);
  const PH = buffers.phase.element(i);

  const hash11 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const seed01 = hash11(S.mul(3.1).add(0.5));
  const sizeMul = float(1).add(hash11(S.mul(1.7).add(3.1)).sub(0.5).mul(2).mul(u(variationParam)));
  const L = u(sizeParam).mul(sizeMul);

  const slotAlpha = clamp(u('active').sub(fi), 0, 1);
  const alpha = slotAlpha
    .mul(clamp(AGE.div(fadeInSec), 0, 1))
    .mul(u('opacity'))
    .mul(select(fi.lessThan(u('population')), float(1), float(0)));

  return { i, fi, P, V, AGE, S, C, PH, seed01, L, alpha };
}
