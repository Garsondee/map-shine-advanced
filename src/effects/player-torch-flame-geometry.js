/**
 * PLAYER TORCH FLAME + EMBERS — THE PURE HALF (mythica-machina-press#77/#578,
 * Stage 2a). Turns a live per-token snapshot
 * (`foundry/player-light-mode.js#readActivePlayerCarriedLightTokens`'s own
 * shape) plus the scene's resolved GM allowance
 * (`foundry/player-light-permissions.js#resolvePlayerLightPermissions`'s own
 * shape) into two things, both position-only and both re-derived fresh every
 * call — no THREE, no Foundry, matching `player-light-geometry.js`'s own
 * "PURE HALF" discipline:
 *
 *   1. `buildPlayerTorchFlameAnchors` — a `{x, y, id}` anchor per active,
 *      allowed torch, shaped EXACTLY like `candle-flame-geometry.js#
 *      computeCandleFlameArrays`'s own duck-typed `anchors` param (which
 *      needs only `x`/`y`, everything else optional and gracefully
 *      defaulted) — so a live player-torch anchor list flows through
 *      candle's own, already-built, already-tuned flame body renderer
 *      (`candle-flame-render.js#buildCandleFlameGeometry`/
 *      `buildCandleFlameMaterial`) with ZERO changes to that module: real
 *      code reuse, not a reimplementation, chosen because a candle's single-
 *      flame-sprite silhouette (chaotic life, wind lean, gutter, bright
 *      core) is a far more honest Stage-2a scope for "a torch's own flame"
 *      than fire's full multi-kind GPU particle engine — see
 *      `player-torch-flame-render.js`'s own header for why that engine
 *      doesn't fit a LIVE, moving origin at all (its spawn points are
 *      `'extracted'` at decode time, from a painted mask — a fundamentally
 *      static, scene-authored input, never a per-frame token read).
 *
 *   2. `computeTorchEmberArrays` — a SEPARATE small batch of glow-dot quads
 *      (a handful per torch), genuinely new (candle has no ember system of
 *      its own to reuse): the geometry itself stays a static, over-sized
 *      quad centred on the wick (same "the quad is dumb, the shader does the
 *      motion" principle `computeCandleFlameArrays`'s own header states),
 *      each vertex additionally carrying a per-ember `seed` so
 *      `player-torch-flame-render.js#buildTorchEmberMaterial` can drive each
 *      ember's own rise/jitter/fade cycle entirely in-shader, independently,
 *      from one shared clock — the SAME "no per-particle CPU object, GPU
 *      drives the motion" posture `particle-engine.js`'s own header states
 *      for the real engine, just at the small, quad-per-ember scale this
 *      module's own scope calls for.
 *
 * ⚠️ SPARKS ARE NOT BUILT (Stage 2a scope, `#578`'s own "concept only, NOT
 * V2's full per-control depth" framing) — a genuinely distinct, functional
 * flame + ember look is this dispatch's bar; a spark layer is a plausible,
 * cheap follow-up (the SAME quad-per-instance technique below, faster/
 * smaller/dimmer), named here rather than silently absent.
 *
 * @module effects/player-torch-flame-geometry
 */

import { hexToRgb01 } from './candle-flame-geometry.js';

/**
 * Every currently-active, currently-allowed TORCH (not flashlight, not a
 * vision-mode pick) as a flame-body anchor. Mirrors `player-light-geometry.js#
 * buildPlayerLightSources`'s own filter shape (mode + scene permission), but
 * produces the flame-body's own minimal `{x, y, id}` rather than a light
 * descriptor — this module's caller (the render half) never needs the light
 * fields at all.
 *
 * @param {Array<{tokenId: string, x: number, y: number, mode: string}>} tokenSnapshots -
 *   `foundry/player-light-mode.js#readActivePlayerCarriedLightTokens`'s own shape.
 * @param {{modes: Record<string, boolean>}} permissions - `resolvePlayerLightPermissions`'s own shape.
 * @returns {Array<{x: number, y: number, id: string}>}
 */
export function buildPlayerTorchFlameAnchors(tokenSnapshots, permissions) {
  const list = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];
  const out = [];
  for (const snap of list) {
    if (snap?.mode !== 'torch') continue; // a flashlight or a vision-mode pick — no flame body
    if (permissions?.modes?.torch !== true) continue; // the GM has not (or no longer) allowed torch on this scene
    const x = Number(snap?.x);
    const y = Number(snap?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y, id: String(snap?.tokenId ?? '') });
  }
  return out;
}

/**
 * A deterministic per-(token, ember-index) pseudo-random phase, folded into a
 * wide-enough range that `fract(time/duration + seed)` desyncs neighbouring
 * embers the same way `candle-flame-render.js#flameHash`'s own per-candle
 * seed desyncs neighbouring flames — string-keyed (not position-keyed like
 * `flameHash`) so a torch's own OWN embers desync from EACH OTHER even
 * though they all share one wick position.
 * @param {string} tokenId @param {number} emberIndex
 * @returns {number} a phase offset, roughly 0..97 (an arbitrary, sufficiently
 *   irrational-feeling spread — the fractional part is what matters).
 */
function deriveEmberSeed(tokenId, emberIndex) {
  const s = `${tokenId ?? ''}:${emberIndex}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const raw = Math.sin(h) * 43758.5453;
  const frac01 = raw - Math.floor(raw); // classic GLSL-hash fold, in [0,1)
  return frac01 * 97;
}

/**
 * Compute the batched ember-quad geometry arrays for a set of torch anchors —
 * `emberCount` quads PER anchor (each torch gets its OWN independent set,
 * never a shared/averaged emitter — the dispatch's own "multiple simultaneous
 * torches... correctly attached to their own token" requirement), all baked
 * in world space, PURE (no THREE) — mirrors `computeCandleFlameArrays`'s own
 * split (this is the testable vertex math; `player-torch-flame-render.js#
 * buildTorchEmberGeometry` is the thin THREE wrapper).
 *
 * Per ember: a SQUARE quad centred on the wick, deliberately OVERSIZED
 * (`sizePx` must be large enough to contain the ember's own whole rise+jitter
 * travel — see `buildTorchEmberMaterial`'s own `EMBER_*_PX` constants) — the
 * quad itself never moves or resizes; the glowing dot's actual position
 * within it is entirely the shader's job, driven by the baked `seed` +
 * `uGlobalTimeMs`, same "dumb quad, the shader does the motion" principle
 * `computeCandleFlameArrays` already established for the flame body itself.
 *
 * @param {Array<{x:number, y:number, id?:string}>} anchors
 * @param {{emberCount?:number, sizePx:number, colorHex?:string}} opts
 * @returns {{positions: Float32Array, uvs: Float32Array, centers: Float32Array, seeds: Float32Array, colors: Float32Array, indices: Uint32Array, quadCount: number}}
 */
export function computeTorchEmberArrays(anchors, { emberCount = 5, sizePx, colorHex = '#ffb347' } = {}) {
  const list = Array.isArray(anchors) ? anchors : [];
  const perAnchor = Math.max(0, Math.floor(Number(emberCount) || 0));
  const half = (Number(sizePx) > 0 ? Number(sizePx) : 1) / 2;
  const [cr, cg, cb] = hexToRgb01(colorHex);
  const maxQuads = list.length * perAnchor;
  const positions = new Float32Array(maxQuads * 4 * 3);
  const uvs = new Float32Array(maxQuads * 4 * 2);
  const centers = new Float32Array(maxQuads * 4 * 2);
  const seeds = new Float32Array(maxQuads * 4);
  const colors = new Float32Array(maxQuads * 4 * 3);
  const indices = new Uint32Array(maxQuads * 6);
  let quadCount = 0;
  for (let i = 0; i < list.length; i++) {
    const anchor = list[i];
    const cx = Number(anchor?.x);
    const cy = Number(anchor?.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue; // belt-and-braces, mirrors computeCandleFlameArrays
    for (let e = 0; e < perAnchor; e++) {
      const seed = deriveEmberSeed(anchor?.id, e);
      const q = quadCount;
      const p = q * 12;
      const uvo = q * 8;
      const co = q * 8;
      const clo = q * 12;
      const so = q * 4;
      const io = q * 6;
      const base = q * 4;
      positions[p + 0] = cx - half;
      positions[p + 1] = cy - half;
      positions[p + 2] = 0;
      positions[p + 3] = cx + half;
      positions[p + 4] = cy - half;
      positions[p + 5] = 0;
      positions[p + 6] = cx + half;
      positions[p + 7] = cy + half;
      positions[p + 8] = 0;
      positions[p + 9] = cx - half;
      positions[p + 10] = cy + half;
      positions[p + 11] = 0;
      uvs[uvo + 0] = 0;
      uvs[uvo + 1] = 0;
      uvs[uvo + 2] = 1;
      uvs[uvo + 3] = 0;
      uvs[uvo + 4] = 1;
      uvs[uvo + 5] = 1;
      uvs[uvo + 6] = 0;
      uvs[uvo + 7] = 1;
      for (let v = 0; v < 4; v++) {
        centers[co + v * 2] = cx;
        centers[co + v * 2 + 1] = cy;
        seeds[so + v] = seed;
        colors[clo + v * 3 + 0] = cr;
        colors[clo + v * 3 + 1] = cg;
        colors[clo + v * 3 + 2] = cb;
      }
      indices[io + 0] = base + 0;
      indices[io + 1] = base + 1;
      indices[io + 2] = base + 2;
      indices[io + 3] = base + 0;
      indices[io + 4] = base + 2;
      indices[io + 5] = base + 3;
      quadCount++;
    }
  }
  return { positions, uvs, centers, seeds, colors, indices, quadCount };
}
