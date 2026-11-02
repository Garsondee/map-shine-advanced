/**
 * @fileoverview vt/token-grounding.js — how a TOKEN's art is sampled so it
 * shares the map's pixel scale instead of sitting on top of it (author,
 * 2026-11-02: *"they look visually 'wrong' within the scene but it's hard to
 * describe it, too detailed, too sharp, grainy. We need a robust, vibrant way
 * to mix them into the scene but we need to make them feel more grounded in
 * the Albedo layer."*). Same seam shape as `albedo-clarity.js`: THREE arrives
 * by parameter, nothing here touches `game`/`canvas`/settings, and the pure
 * maths at the bottom is Node-tested.
 *
 * ===========================================================================
 * WHAT WAS WRONG, MEASURED (2026-11-02)
 * ===========================================================================
 * The author's own token art (`Data/tokenizer`, 400 files): 178 are 2000x2000,
 * 94 are 1000x1000. On a 150 px grid that is 13.3 and 6.7 source texels per
 * WORLD pixel. The maps they stand on (Mad Scientist's Compound, Docklands)
 * are 1.0. So a token carries 7-13x the detail density of the floor around it,
 * and the 2026-10-27 sharpness fix widened that gap on purpose:
 *
 *  1. `TOKEN_SHARP_LOD_BIAS = -0.75` read a mip 1.7x finer than the pixel
 *     covers. That is under-filtering: fine brushwork aliases into a speckle
 *     that crawls as the token moves (TAA only reprojects the camera, so a
 *     moving token never gets smoothed). That is the "grainy".
 *  2. CAS ran at full strength with no far roll-off on top of it, sharpening
 *     the aliasing it had just made. That is the "too sharp".
 *  3. Zoomed in past the map's native size the floor goes soft (it has run out
 *     of texels) while a 2000 px token keeps resolving brush hairs. That is
 *     the "too detailed" — the two layers stop sharing a pixel scale.
 *
 * RULED OUT, also measured, so nobody re-chases them:
 *  - The offline contrast-preserving mip correction. On a real 2000 px token
 *    its gain at the mips a token uses is 1.006-1.029; the ground's own is
 *    1.01-1.12.
 *  - Tonal range. Measured at the SCALE THEY ARE SEEN (token Lanczos-reduced to
 *    150 px, map at 1:1), linear luma: token ink p1 ~0.007, map 0.005-0.007;
 *    token p99 ~0.65, map 0.59-0.62. They already match. (A first pass compared
 *    a 1024 px token against a 1024 px whole-map thumbnail and saw tokens as far
 *    darker and brighter — an artefact of reducing the map 7x and the token 2x.
 *    A black-lift curve built on that would have made every token milky.)
 *
 * ===========================================================================
 * THE FIX — two token-only stages, one node
 * ===========================================================================
 * A. DETAIL MATCH. A token may resolve at most `detail` times the ground's
 *    texel density (texels per world px). No per-token plumbing: a token's
 *    density is texelsPerPixel / worldPerPixel, so the LOD floor that caps it
 *    reduces to a derivative scale of `1 / (maxDensity * worldPerPixel)`, and
 *    worldPerPixel is the camera's, one shared uniform written per frame (the
 *    view is orthographic, so it is the same at every pixel; a per-pixel
 *    `positionWorld` derivative would cost a vertex varying, and the whole-image
 *    material already sits at WebGPU's limit of 16 — measured live, 17 failed
 *    to compile). It engages only once the screen shows
 *    more pixels per world px than `maxDensity`, i.e. only when zoomed in past
 *    the point where the floor itself has gone soft. Resizing or swapping a
 *    token's art needs nothing recomputed. Alpha goes through it too, so the
 *    silhouette edge softens to the same scale as the map's own painted props.
 *
 * B. SUPERSAMPLE, NOT BIAS. Four rotated-grid taps inside the pixel, each with
 *    half the pixel's footprint (one mip finer), averaged in premultiplied
 *    space. The 2026-10-27 complaint ("fuzzy, low resolution") was trilinear
 *    blending two coarse mips; the negative bias fixed the blur by
 *    under-filtering. Supersampling gets the crispness from correctly-filtered
 *    samples, so there is nothing to alias. Tokens are a few hundred pixels on
 *    screen, so four taps cost nothing measurable. No CAS on top — nothing was
 *    averaged away that a sharpen needs to put back.
 *
 * @module vt/token-grounding
 */

const TOKEN_GROUNDING_DEFAULTS = Object.freeze({
  /** Highest texel density a token may show, as a multiple of the floor's.
   * 1 = exactly the map's pixel scale; higher keeps more portrait detail when
   * zoomed in. */
  detail: 1.5,
});

const _tg = { ...TOKEN_GROUNDING_DEFAULTS, enabled: true };
/** The floor's texel density (texels per world px), set per scene by the viewer. */
let _groundTexelsPerWorldPx = 1;
/** World px per render-target pixel, from the camera each frame. */
let _worldPerPixel = 1;
/** @type {null|{maxDensity:any, worldPerPixel:any}} */
let _uniforms = null;

/** The Studio/console schema; ranges mirror `setTokenGrounding`'s clamps. */
export const TOKEN_GROUNDING_PARAMS = Object.freeze({
  detail: {
    type: 'float',
    min: 0.5,
    max: 8,
    step: 0.25,
    default: TOKEN_GROUNDING_DEFAULTS.detail,
    category: 'Look',
    label: 'Token detail',
    help: "The most detail a token may show, as a multiple of the map's own. 1 = the same pixel scale as the floor; higher keeps more of the portrait when zoomed right in.",
  },
});

function pushUniforms() {
  if (!_uniforms) return;
  // Off = the art's full resolution (supersampling stays: it is plain correct
  // filtering, not a look).
  _uniforms.maxDensity.value = _tg.enabled ? Math.max(1e-3, _groundTexelsPerWorldPx * _tg.detail) : 1e6;
}

function tokenGroundingUniforms(THREE) {
  if (_uniforms === null) {
    const { uniform, float } = THREE.TSL;
    _uniforms = { maxDensity: uniform(float(1)), worldPerPixel: uniform(float(_worldPerPixel)) };
    pushUniforms();
  }
  return _uniforms;
}

/**
 * Tune token grounding live (one shared uniform — every token at once).
 * @param {{detail?:number, enabled?:boolean}} next
 */
export function setTokenGrounding(next = {}) {
  if (Number.isFinite(next.detail)) _tg.detail = Math.max(0.5, Math.min(8, next.detail));
  if (typeof next.enabled === 'boolean') _tg.enabled = next.enabled;
  pushUniforms();
  return getTokenGrounding();
}

export function resetTokenGrounding() {
  return setTokenGrounding({ ...TOKEN_GROUNDING_DEFAULTS, enabled: true });
}

export function getTokenGrounding() {
  return { ..._tg, groundTexelsPerWorldPx: _groundTexelsPerWorldPx, applied: _uniforms !== null };
}

/**
 * The floor's texel density — the background art's native width over its
 * world width. Set by the viewer whenever a level background is placed.
 * @param {number} texelsPerWorldPx
 */
export function setTokenGroundingGroundDensity(texelsPerWorldPx) {
  if (Number.isFinite(texelsPerWorldPx) && texelsPerWorldPx > 0) _groundTexelsPerWorldPx = texelsPerWorldPx;
  pushUniforms();
}

/**
 * The camera's world px per render-target pixel — called by the viewer every
 * frame with the frustum it just set.
 * @param {number} worldPerPixel
 */
export function setTokenGroundingWorldPerPixel(worldPerPixel) {
  if (!(Number.isFinite(worldPerPixel) && worldPerPixel > 0)) return;
  _worldPerPixel = worldPerPixel;
  if (_uniforms) _uniforms.worldPerPixel.value = worldPerPixel;
}

/** Rotated-grid sub-pixel offsets, in pixels (the classic 4-rook pattern). */
const RGSS = [
  [0.125, 0.375],
  [-0.375, 0.125],
  [-0.125, -0.375],
  [0.375, -0.125],
];

/**
 * Sample a token's art: detail-matched and supersampled. Drop-in for
 * `buildAlbedoClarityNode` — linear rgb + straight alpha out.
 *
 * @param {*} THREE @param {*} tex @param {*} uvNode - final uv (uvScale applied).
 * @returns {{rgb:any, a:any}}
 */
export function buildTokenArtNode(THREE, tex, uvNode) {
  const TSL = THREE.TSL;
  const { float, vec3, vec4, dFdx, dFdy, texture } = TSL;
  const u = tokenGroundingUniforms(THREE);

  // UNIFORM CONTROL FLOW: every derivative before anything that could branch.
  const duvdx = dFdx(uvNode).toVar();
  const duvdy = dFdy(uvNode).toVar();

  // A: `cap` is screen pixels per capped texel; the four taps together cover
  // max(1, cap) pixels — one pixel normally, the cap's own footprint when
  // zoomed in past it.
  // B: each tap carries HALF that footprint, so the four tile it exactly.
  // (Giving each tap the whole capped footprint as well as spreading them
  // across it doubled the blur — seen live at 1x, a portrait softer than the
  // map's ink lines.)
  const cap = float(1)
    .div(u.maxDensity.mul(TSL.max(u.worldPerPixel, float(1e-6))))
    .toVar();
  const spread = TSL.max(float(1), cap).toVar();
  const gx = duvdx.mul(spread.mul(0.5));
  const gy = duvdy.mul(spread.mul(0.5));

  const acc = vec4(0).toVar();
  for (const [ox, oy] of RGSS) {
    const uvT = uvNode.add(duvdx.mul(ox).add(duvdy.mul(oy)).mul(spread));
    const s = texture(tex, uvT).grad(gx, gy);
    // Premultiplied, so transparent texels never bleed colour into the edge.
    acc.addAssign(vec4(s.rgb.mul(s.a), s.a));
  }
  acc.mulAssign(0.25);
  const a = acc.a;
  const rgb = TSL.max(acc.rgb.div(TSL.max(a, float(1e-4))), vec3(0));
  return { rgb, a };
}

/**
 * Stage A, for tests: screen pixels per capped texel. <=1 = the cap is not
 * reached (the plain one-pixel supersample wins), >1 = the token is held to it.
 * @param {number} maxDensityTexelsPerWorldPx @param {number} worldPerPixel
 */
export function detailCapScale(maxDensityTexelsPerWorldPx, worldPerPixel) {
  return 1 / (maxDensityTexelsPerWorldPx * Math.max(worldPerPixel, 1e-6));
}
