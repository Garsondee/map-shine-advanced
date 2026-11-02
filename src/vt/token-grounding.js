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
 * C. CONTACT SHADOW (author, 2026-11-02: "Yes, build it"). Tokens cast nothing,
 *    so they read as stickers. Each drawn token gets one quad, its own geometry
 *    grown by `shadowSize` on every side, that MULTIPLIES `buf:scene.illum`
 *    after every light has accumulated and before the composite: a contact
 *    shadow is light that never reached the floor, so it then darkens exactly
 *    as the map's own lit art does, through every grade, Look and fog stage
 *    after it. The shape is the token's own alpha silhouette, blurred with a
 *    ring of taps that read ZERO outside the art (a clamped edge would smear
 *    the rim outwards forever). Three gates:
 *     - Only tokens this client DRAWS get one. A GM-hidden token is never
 *       collected for a player (`foundry/scene-tokens.js`), so it has no
 *       shadow to leak.
 *     - Token pixels are never darkened (the depth-flags token bit): tokens do
 *       not shadow themselves or each other. Nor is anything drawn ABOVE the
 *       token (a statue, a roof edge): the shadow lands only where the stored
 *       depth is at or below the token's own tie-safe rank, the same test
 *       window light uses (found live: a skull prop over a token's edge went
 *       dark).
 *     - The vision mask is read at the token's CENTRE, not at the shadow
 *       pixel: a token out of sight behind a wall casts nothing, even where
 *       its halo would land on floor the viewer can see. (R or B, the mask
 *       alone, because reading illum while drawing into it is a hazard.)
 *
 * @module vt/token-grounding
 */

const TOKEN_GROUNDING_DEFAULTS = Object.freeze({
  /** Highest texel density a token may show, as a multiple of the floor's.
   * 1 = exactly the map's pixel scale; higher keeps more portrait detail when
   * zoomed in. */
  detail: 1.5,
  /** Contact shadow darkness at the token's foot, 0..1 of the light removed. */
  shadow: 0.65,
  /** How far the shadow reaches past the token's edge, as a fraction of its size. */
  shadowSize: 0.12,
});

const _tg = { ...TOKEN_GROUNDING_DEFAULTS, enabled: true };
/** The floor's texel density (texels per world px), set per scene by the viewer. */
let _groundTexelsPerWorldPx = 1;
/** World px per render-target pixel, from the camera each frame. */
let _worldPerPixel = 1;
/** @type {null|{maxDensity:any, worldPerPixel:any, shadow:any, shadowSize:any}} */
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
  shadow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: TOKEN_GROUNDING_DEFAULTS.shadow,
    category: 'Look',
    label: 'Token contact shadow',
    help: 'How dark the soft shadow under every token is. 0 turns it off.',
  },
  shadowSize: {
    type: 'float',
    min: 0.02,
    max: 0.4,
    step: 0.01,
    default: TOKEN_GROUNDING_DEFAULTS.shadowSize,
    category: 'Look',
    label: 'Contact shadow size',
    help: 'How far the shadow spreads past the edge of a token, as a fraction of its size.',
  },
});

function pushUniforms() {
  if (!_uniforms) return;
  // Off = the art's full resolution (supersampling stays: it is plain correct
  // filtering, not a look).
  _uniforms.maxDensity.value = _tg.enabled ? Math.max(1e-3, _groundTexelsPerWorldPx * _tg.detail) : 1e6;
  _uniforms.shadow.value = _tg.enabled ? _tg.shadow : 0;
  _uniforms.shadowSize.value = _tg.shadowSize;
}

function tokenGroundingUniforms(THREE) {
  if (_uniforms === null) {
    const { uniform, float } = THREE.TSL;
    _uniforms = {
      maxDensity: uniform(float(1)),
      worldPerPixel: uniform(float(_worldPerPixel)),
      shadow: uniform(float(0)),
      shadowSize: uniform(float(TOKEN_GROUNDING_DEFAULTS.shadowSize)),
    };
    pushUniforms();
  }
  return _uniforms;
}

/**
 * Tune token grounding live (one shared uniform — every token at once).
 * @param {{detail?:number, shadow?:number, shadowSize?:number, enabled?:boolean}} next
 */
export function setTokenGrounding(next = {}) {
  if (Number.isFinite(next.detail)) _tg.detail = Math.max(0.5, Math.min(8, next.detail));
  if (Number.isFinite(next.shadow)) _tg.shadow = Math.max(0, Math.min(1, next.shadow));
  if (Number.isFinite(next.shadowSize)) _tg.shadowSize = Math.max(0.02, Math.min(0.4, next.shadowSize));
  if (typeof next.enabled === 'boolean') _tg.enabled = next.enabled;
  pushUniforms();
  return getTokenGrounding();
}

export function resetTokenGrounding() {
  return setTokenGrounding({ ...TOKEN_GROUNDING_DEFAULTS, enabled: true });
}

/** Is any contact shadow to be drawn at all? The viewer skips the pass when not. */
export function isTokenContactShadowOn() {
  return _tg.enabled && _tg.shadow > 0;
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

/**
 * Ring tap layout for the shadow blur, in units of the shadow reach: the
 * centre, an inner ring and an outer ring. Weights fall with distance so the
 * shadow is densest under the token's rim and fades to nothing at its reach.
 */
const SHADOW_TAPS = (() => {
  const taps = [[0, 0, 1]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    taps.push([Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.8]);
  }
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    taps.push([Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.45]);
  }
  return taps;
})();

/** The depth-flags token bit (`scene-depth.js#DEPTH_FLAG_IS_TOKEN`). */
const TOKEN_FLAG = 64;

/**
 * The contact-shadow material for ONE token (stage C). Drawn with the token's
 * own geometry into `buf:scene.illum`, multiplying it.
 *
 * @param {*} THREE
 * @param {object} args
 * @param {*} args.tex - the token's art texture.
 * @param {number[]} [args.uvScale] - the token tile's padding crop (`t.uvScale`).
 * @param {number} args.texWidth - the texture's texel width, sizes the blur mip.
 * @param {*} args.flagsTexture - `buf:scene.depth`'s colour (flags in .b).
 * @param {*} args.depthTexture - `buf:scene.depth`'s depth (rank).
 * @param {*} args.visionMaskTexture - the vision mask (R sight, B light perception).
 * @returns {{material:any, uCenter:any, uAlpha:any, uTokenDepth:any}} `uTokenDepth`: the token
 *   tile's own `uExpectedDepth`, copied in every frame.
 */
export function buildTokenContactShadowMaterial(
  THREE,
  { tex, uvScale, texWidth, flagsTexture, depthTexture, visionMaskTexture }
) {
  const TSL = THREE.TSL;
  const { Fn, uniform, vec2, vec3, vec4, float, uv, texture, positionLocal, positionWorld, screenUV, dFdx, dFdy } = TSL;
  const u = tokenGroundingUniforms(THREE);
  const uCenter = uniform(vec2(0, 0));
  const uAlpha = uniform(float(1));
  const uTokenDepth = uniform(float(0));
  const uUvScale = uniform(vec2(uvScale?.[0] ?? 1, uvScale?.[1] ?? 1));
  const uTexWidth = uniform(float(Math.max(1, texWidth || 1)));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // The world camera is Y-down, which flips a world quad's winding: without
  // this every shadow quad is back-face culled and draws nothing (found live).
  material.side = THREE.DoubleSide;
  // dst * src on colour; alpha kept.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.ZeroFactor;
  material.blendDst = THREE.SrcColorFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;

  // Grow the token's own quad about its centre by TWICE the shadow's reach.
  // The blur's real support is wider than `reach` (the outer taps sit at 0.9
  // reach, and each tap is a mip whose texels are a third of it), so a quad
  // grown by `reach` alone cut the halo off while it was still visible, a
  // hard square along the four sides (author, live, 2026-11-02; measured:
  // still darkening at 15 world px, 0 at the 18 px quad edge).
  const margin = u.shadowSize.mul(2);
  const pad = float(1).add(margin.mul(2));
  material.positionNode = vec3(uCenter.add(positionLocal.xy.sub(uCenter).mul(pad)), positionLocal.z);

  material.colorNode = Fn(() => {
    // Derivatives first, in uniform control flow.
    const suvX = dFdx(screenUV.x);
    const suvY = dFdy(screenUV.y);
    const wX = dFdx(positionWorld.x);
    const wY = dFdy(positionWorld.y);

    // The art uv this fragment would have on the un-grown quad.
    const artUv = uv().sub(0.5).mul(pad).add(0.5).toVar();
    // The reach in art uv, and a mip whose texels are a third of it.
    const reach = u.shadowSize;
    const lod = TSL.log2(TSL.max(float(1), uTexWidth.mul(uUvScale.x).mul(reach).div(3)));
    // Past the art's own border the alpha must fall away SMOOTHLY, over about
    // the blur's width, as a blurred zero-padded image would. A hard step(0..1)
    // mask here made every tap fall off a cliff at the square's border, and a
    // ring token touches that border mid-side: the halo showed straight cuts
    // top/bottom/left/right (author, live, 2026-11-02; measured: -12 levels
    // inside 3 world px).
    const cover = (p) => {
      const out = TSL.max(TSL.max(p.negate(), p.sub(1)), vec2(0)).length();
      const fade = float(1).sub(TSL.smoothstep(0, reach.mul(0.6), out));
      return texture(tex, p.clamp(0, 1).mul(uUvScale)).level(lod).a.mul(fade);
    };
    const acc = float(0).toVar();
    let wsum = 0;
    for (const [ox, oy, w] of SHADOW_TAPS) {
      acc.addAssign(cover(artUv.add(vec2(ox, oy).mul(reach))).mul(w));
      wsum += w;
    }
    // A touch of contrast so the rim reads as a contact, not a fog.
    const s = TSL.smoothstep(0, 0.85, acc.div(wsum));

    // Gate 1: never on a token's own pixels.
    const flagsByte = TSL.floor(texture(flagsTexture, screenUV).b.mul(255).add(0.5));
    const isToken = TSL.mod(TSL.floor(flagsByte.div(TOKEN_FLAG)), 2);
    // ...and never on anything drawn above the token.
    const atOrBelow = depthTexture ? TSL.step(uTokenDepth, texture(depthTexture, screenUV).x) : float(1);
    // Gate 2: the token's CENTRE must be revealed to this viewer. Screen uv
    // per world px from the derivatives (sign included), so no camera maths
    // is duplicated here. The camera is orthographic and axis-aligned, so
    // neither world derivative is ever 0; the guard only stops a NaN.
    const safe = (d) => TSL.select(TSL.abs(d).lessThan(1e-6), float(1e-6), d);
    const centreUv = vec2(
      screenUV.x.add(uCenter.x.sub(positionWorld.x).mul(suvX.div(safe(wX)))),
      screenUV.y.add(uCenter.y.sub(positionWorld.y).mul(suvY.div(safe(wY))))
    ).clamp(0, 1);
    const mask = texture(visionMaskTexture, centreUv);
    const revealed = TSL.step(0.5, TSL.max(mask.r, mask.b));

    // Belt and braces: reach exactly zero before the quad's own border, so no
    // shadow size or token shape can ever show a straight cut.
    const q = uv();
    const toBorder = TSL.min(TSL.min(q.x, q.y), TSL.min(float(1).sub(q.x), float(1).sub(q.y)));
    const edgeFade = TSL.smoothstep(0, reach.mul(0.5).div(pad), toBorder);

    const dark = s.mul(edgeFade).mul(u.shadow).mul(uAlpha).mul(float(1).sub(isToken)).mul(atOrBelow).mul(revealed);
    return vec4(vec3(float(1).sub(dark)), 1);
  })();
  return { material, uCenter, uAlpha, uTokenDepth };
}
