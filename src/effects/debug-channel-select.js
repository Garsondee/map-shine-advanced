/**
 * THE DEBUG-CHANNEL SELECTOR — one definition, because the obvious one is wrong
 * on a real GPU and cost this project twelve live rounds before anyone looked at
 * the generated shader.
 *
 * ============================================================================
 * ⚠️ A `select()` CHAIN OVER A SHARED SUBGRAPH READS UNASSIGNED VARIABLES
 * ============================================================================
 * Every effect that ships debug channels wants the same thing: one material, a
 * `uDebugChannel` uniform, and "show me intermediate N". The natural way to
 * write that in TSL is a fold of `select()`s:
 *
 *     let out = vec3(0, 0, 0);
 *     for (const ch of CHANNELS) out = cond(ch).select(nodes[ch.id], out);   // ⛔
 *
 * It compiles, it runs, and **most of its channels are silently zero.** TSL's
 * `select()` does NOT emit a ternary — it emits real control flow, and a node's
 * variable ASSIGNMENT is emitted wherever the graph walk first reaches it. The
 * walk runs from the LAST branch to the first, so every `.toVar()` in the shared
 * subgraph lands inside whichever branch pulled it first, and every OTHER branch
 * reads a `var<private>` that WGSL default-initialises to zero. Verified by
 * dumping the real WGSL (`tools/shader-lab/bench-specular.js#dumpShader`),
 * 2026-08-01:
 *
 *     if ( abs(uDebugChannel - 16.0) < 0.5 ) {
 *       nodeVar15 = textureSample( attr, ... );                 // ← assigned HERE
 *       specFloorMatch = 1.0 - smoothstep( ..., nodeVar15.x );
 *     } else { ...
 *       if ( abs(uDebugChannel - 8.0) < 0.5 ) {
 *         specBackgroundArtHere = step( 0.251, nodeVar15.z );   // ← nodeVar15 is 0 here
 *
 * The consequence is worse than "a broken channel", because the zero reads as a
 * plausible MEASUREMENT. Specular's channel 8 rendered `(1, 1, 0)` — a confident
 * "floor matches, something was drawn, the background bit is CLEAR" — on a scene
 * where the bit was in fact set. Three separate live rounds re-diagnosed the
 * effect off that reading. `feedback_instruments_must_not_lie`, in its most
 * expensive form yet: the instrument did not fail loudly, it answered wrongly.
 *
 * ============================================================================
 * THE FIX: NO CONTROL FLOW AT ALL
 * ============================================================================
 * Selection becomes arithmetic. `pick(n)` is 1 on the chosen channel and 0
 * elsewhere, built from `step()` (a pure ALU op, no branch), and the result is a
 * SUM of every channel scaled by its own pick. Every channel's subgraph is then
 * built in the material's main flow, where "assigned before read" is guaranteed
 * by construction rather than by branch ordering.
 *
 * The cost is that a debug material evaluates every channel it offers. That is
 * the correct trade and not a close call: this material is attached to no mesh
 * at channel 0 (the shipping path pays nothing), and a diagnostic that is cheap
 * and wrong is worth strictly less than one that is expensive and right.
 *
 * ⚠️ ONE RULE FOR CALLERS, and it is the same trap one level down: **a channel
 * node must not be the first place a shared `.toVar()` gets built inside its
 * OWN conditional.** If a channel needs a branch (e.g. "show a diagnostic colour
 * when the bake failed"), express it with {@link pickEquals}/arithmetic too, not
 * with `select()`. Specular's `islands` channel had exactly that shape and was
 * converted for exactly this reason.
 *
 * @module effects/debug-channel-select
 */

/**
 * A 0/1 selector node — 1 when `valueNode` is within half a unit of `n`, 0
 * otherwise — with NO control flow.
 *
 * `1 - step(0.5, |value - n|)`: `step(edge, x)` is 1 when `x >= edge`, so this
 * is 1 exactly on the half-open window `|value - n| < 0.5`. Channel numbers are
 * integers pushed through a float uniform, so a half-unit window is the standard
 * tolerance for "is this uniform equal to this constant" and matches what the
 * `select()` version compared.
 *
 * @param {*} TSL - `THREE.TSL`.
 * @param {*} valueNode - the channel uniform.
 * @param {number} n - the channel number to match.
 * @returns {*} a float node, 1 or 0.
 */
export function pickEquals(TSL, valueNode, n) {
  const { float, step, abs } = TSL;
  return float(1).sub(step(float(0.5), abs(valueNode.sub(float(n)))));
}

/**
 * Fold a channel table into ONE vec3 node with no branches.
 *
 * @param {*} TSL - `THREE.TSL`.
 * @param {object} args
 * @param {Array<{n: number, id: string}>} args.channels - the effect's own
 *   channel table. `n === 0` is skipped: 0 means "off", and the caller detaches
 *   the debug material entirely rather than rendering a black one.
 * @param {Record<string, *>} args.nodes - channel id → vec3 node.
 * @param {*} args.uDebugChannel - the float uniform holding the picked channel.
 * @param {string} args.label - the effect's name, for the throw below.
 * @returns {*} a vec3 node.
 */
export function buildDebugChannelColor(TSL, { channels, nodes, uDebugChannel, label }) {
  const { vec3 } = TSL;
  let out = vec3(0, 0, 0);
  for (const ch of channels) {
    if (ch.n === 0) continue;
    const node = nodes[ch.id];
    // Loud at BUILD time, never a channel that quietly shows the one below it
    // (`feedback_instruments_must_not_lie`).
    if (!node) throw new Error(`${label} debug channel '${ch.id}' (n=${ch.n}) has no node in debugNodes`);
    out = out.add(node.mul(pickEquals(TSL, uDebugChannel, ch.n)));
  }
  return out;
}
