/**
 * WINDOW LIGHT — the cookie, in TSL. THREE is INJECTED, never imported.
 *
 * `window-cookie.js` is the maths in plain JS, asserted in Node; this is its
 * transcription, drawn as a bounded quad and ADDED onto `buf:scene.illum` —
 * the SAME buffer the ambient fill, region darkness and point lights already
 * accumulate into (`vt-pan-viewer.js#runLightAccumulatePass`), not
 * `buf:scene.color`/`scene.lit`. That is a real structural difference from
 * `specular-render.js`, which this module's shape otherwise mirrors closely:
 * this pass draws BEFORE the illumination is finished being composed, so it
 * needs no `illumTexture` input at all — it CONTRIBUTES to illum rather than
 * reading it.
 *
 * ============================================================================
 * ⚠️ THIS ADDS. IT NEVER TOUCHES COMPOSED SCENE COLOUR.
 * ============================================================================
 * `docs/planning/Windows.md` §2.2/§3.2: V2 folded its window glow into the lit
 * scene TWICE — once correctly (`totalIllumination += winIllum`) and once as
 * an additive haze on the ALREADY-LIT pixel (`litColor += winHueLit × spill`),
 * which flattens the art it is meant to be lighting. That second half is the
 * SAME mistake water's in-scatter term made and the sky's deleted "veil" made
 * — three effects in this codebase, one bug. This module only ever produces a
 * term that gets ADDED to `buf:scene.illum`; there is no second draw, no
 * spill, and no `scene.lit` write anywhere in this file.
 *
 * ============================================================================
 * THE MASK IS NOT AN APERTURE — READ `window-cookie.js`'S HEADER FIRST
 * ============================================================================
 * There is no aperture geometry here: no wall, no sill, no "which side is
 * outside". The author has already painted where the light lands, how
 * strong, and what colour — this shader reads exactly that, cropped to the
 * mask's own AABB and gated to the viewed floor. Nothing here derives a beam.
 *
 * ============================================================================
 * ⚠️ THE CLOUD FACTOR IS A SEAM, NOT A FEATURE — READ THIS BEFORE ADDING ONE
 * ============================================================================
 * `world/cloud-field.js` (`docs/planning/Windows.md` §4) does not exist yet.
 * `cloudFactorNode` is how its eventual per-fragment 0..1 sample plugs in
 * without touching anything else in this shader: pass a real node once the
 * field is built, and the constant-1 default below simply stops being
 * reached. This is deliberately NOT a uniform toggle (`tsl/no-uniform-gates`
 * forbids exactly that shape) and deliberately NOT a `WINDOW_PARAMS` entry
 * yet (`params/no-dead-controls` would fail the build on a control with no
 * consumer) — it is a JS-level injection point, the same idiom
 * `buildOutdoorsGate` uses in `specular-render.js`.
 *
 * @module effects/window/window-render
 */

import {
  WINDOW_PRESENCE_EDGE0,
  WINDOW_PRESENCE_EDGE1,
  WINDOW_ALPHA_EPSILON,
  WINDOW_SHOULDER_K,
} from './window-cookie.js';
import { WINDOW_DEBUG_CHANNELS, WINDOW_DEBUG_BOOST } from './window.js';

/**
 * Fraction of the authored file's resolution to upload for this shader's own
 * mask read. Mirrors `SPECULAR_MASK_IMAGE_SCALE` for the same reason: `'rgb'`
 * mode uploads RGBA, four bytes per texel, so half resolution costs roughly
 * what water's single-byte upload costs at full resolution.
 */
export const WINDOW_MASK_IMAGE_SCALE = 0.5;

/** Defaults, mirroring `WINDOW_PARAMS` — the single source of truth for the
 * values; the schema quotes them. A change lands in both or neither. */
export const WINDOW_DEFAULT_STRENGTH = 1;
export const WINDOW_DEFAULT_CONTRAST = 1;

/**
 * Build the window-light material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the authored `_Window` file, RGBA, RAW bytes.
 *   ⚠️ Uploaded `NoColorSpace`, matching `_Specular`'s convention — a "50%
 *   grey" texel means 0.5, not 0.21.
 * @param {*} [args.attrTexture] - `buf:scene.attr`; null compiles the floor
 *   gate OUT entirely (a JS-time branch, never a uniform × 0).
 * @param {*} args.uViewRect - envLight's OWN view-rect uniform, shared rather
 *   than duplicated: two rects on different cadences is how two consumers of
 *   one frame stop agreeing where a world point is.
 * @param {*} [args.cloudFactorNode] - see this module's header. A TSL node
 *   evaluating 0..1 (1 = no cloud shadow), or `null`/omitted for the constant
 *   1 this effect ships with until `world/cloud-field.js` exists.
 * @returns {object} the material plus its setters.
 */
export function buildWindowSurfaceMaterial({
  THREE,
  maskTexture,
  attrTexture = null,
  uViewRect,
  cloudFactorNode = null,
  strength = WINDOW_DEFAULT_STRENGTH,
  contrast = WINDOW_DEFAULT_CONTRAST,
}) {
  const TSL = THREE.TSL;
  const { texture, uv, vec2, vec3, vec4, float, uniform, positionWorld, smoothstep, clamp, max, abs, mix } = TSL;

  const uStrength = uniform(float(strength));
  const uContrast = uniform(float(contrast));
  /** The crop's extent in mask-UV space. THE ENTIRE mask lookup. */
  const uMaskUvBounds = uniform(vec4(0, 0, 1, 1));
  /** This quad's own floor, as `index / 255`. */
  const uFloorIndex01 = uniform(float(0));

  // ── THE MASK UV — the quad's own `uv()`, remapped by the crop ────────────
  // Same reasoning as specular-render.js's own note: `uv()` cannot exceed
  // 0..1, so this lookup cannot leave the texture, correct by construction.
  const maskUv = vec2(
    mix(uMaskUvBounds.x, uMaskUvBounds.z, uv().x),
    mix(uMaskUvBounds.y, uMaskUvBounds.w, uv().y)
  ).toVar('winMaskUv');
  const maskTexNode = texture(maskTexture, maskUv);
  const maskSample = maskTexNode.toVar('winMaskSample');

  // ── THE DECODE — the transcription of `decodeWindowMask` ────────────────
  const v = max(max(maskSample.r, maskSample.g), maskSample.b).toVar('winValue');
  const alpha = clamp(maskSample.a, 0, 1);
  // The alpha-missing fallback: a greyscale `_Window` with no alpha channel
  // is the common authoring case and would otherwise decode to pure black.
  const effectiveAlpha = alpha.lessThan(float(WINDOW_ALPHA_EPSILON)).select(float(1), alpha);
  const gated = v.mul(effectiveAlpha).toVar('winGated');

  const presence = smoothstep(float(WINDOW_PRESENCE_EDGE0), float(WINDOW_PRESENCE_EDGE1), gated).toVar('winPresence');
  const level = clamp(gated, 0, 1)
    .pow(max(uContrast, float(0.001)))
    .toVar('winLevel');

  // Re-normalised so the tint carries `level` as its own peak — a naive
  // `rgb × level` would darken saturated paint twice, once for being dark and
  // once for being coloured (see window-cookie.js's own header).
  const denom = max(v, float(1e-4));
  const tint = maskSample.rgb.div(denom).toVar('winTint');
  const cookie = tint.mul(level).toVar('winCookie');

  // ── THE FLOOR GATE ───────────────────────────────────────────────────────
  // A JS-time branch: with no attr texture the whole lookup is compiled OUT
  // rather than multiplied by a one (`tsl/no-uniform-gates`). Screen UV comes
  // from `positionWorld` mapped through the SAME view rect the geometry pass
  // wrote `buf:scene.attr` against — the exact mapping specular's floor gate
  // already uses, so the two agree about where a world point lands on
  // screen without a second derivation.
  const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1)).toVar('winViewSpanX');
  const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
  const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
  const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
  const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1)).toVar('winScreenUv');

  let visibility01 = float(1);
  let debugFloorGate = vec3(1, 1, 0);
  if (attrTexture) {
    const attrHere = texture(attrTexture, screenUv);
    // ⚠️ R ONLY — `buf:scene.attr`'s ALPHA lane is confirmed broken
    // (specular-render.js's own measured note); R and G are correct. Do not
    // multiply by alpha here for the same reason specular does not.
    const floorMatch = float(1)
      .sub(smoothstep(float(0.4 / 255), float(0.9 / 255), abs(attrHere.r.sub(uFloorIndex01))))
      .toVar('winFloorMatch');
    visibility01 = floorMatch;
    debugFloorGate = vec3(floorMatch, floorMatch, float(0));
  }

  const coverage = presence.mul(visibility01).toVar('winCoverage');

  // ── THE CLOUD SEAM — see this module's header ────────────────────────────
  const cloudFactor = (cloudFactorNode ?? float(1)).toVar('winCloudFactor');

  // ── THE COMPOSITE — this ADDS onto buf:scene.illum. Nothing here touches
  // composed scene colour (see this module's header). ─────────────────────
  const rawLight = cookie.mul(uStrength).mul(coverage).mul(cloudFactor).toVar('winRawLight');

  // ── THE HIGHLIGHT SHOULDER — the transcription of
  // `window-cookie.js#shoulderedContribution`. Shapes on the PEAK channel and
  // rescales all three by the SAME ratio, so hue/saturation survive
  // compression — see that function's own header for why this exists at all
  // (found live: a large cookie over bright architectural art washed out to
  // a flat, textureless white disc) and why it shapes the peak rather than
  // each channel independently (per-channel compression desaturates a
  // saturated cookie exactly where it is brightest).
  const rawPeak = max(max(rawLight.r, rawLight.g), rawLight.b).toVar('winRawPeak');
  const rawPeakSafe = max(rawPeak, float(1e-5));
  const shapedPeak = rawPeakSafe.div(float(1).add(rawPeakSafe.mul(float(WINDOW_SHOULDER_K))));
  const shoulderScale = shapedPeak.div(rawPeakSafe);
  const cookieLight = rawLight.mul(shoulderScale).toVar('winFinal');

  /** @param {*} material */
  function configureShared(material) {
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ A negative scale (Foundry's horizontal-flip convention) reverses the
    // effective winding and FrontSide would cull the quad as a backface —
    // visible in every JS status field and invisible on screen
    // (`feedback_doubleside_invisible_to_status_reports`).
    material.side = THREE.DoubleSide;
  }

  // ADDITIVE ONLY — buf:scene.illum is accumulated by ambient fill (overwrite),
  // region darkness (overwrite within footprint) and point lights (MAX), then
  // this draws AFTER all three: One/One on colour, and destination alpha left
  // EXACTLY as it was (Zero·src + One·dst is the identity), matching
  // specular's own alpha discipline — this pass has no opinion about
  // whatever convention illum's alpha carries.
  const windowMaterial = new THREE.NodeMaterial();
  windowMaterial.colorNode = vec4(cookieLight, 1);
  configureShared(windowMaterial);
  windowMaterial.blending = THREE.CustomBlending;
  windowMaterial.blendEquation = THREE.AddEquation;
  windowMaterial.blendSrc = THREE.OneFactor;
  windowMaterial.blendDst = THREE.OneFactor;
  windowMaterial.blendEquationAlpha = THREE.AddEquation;
  windowMaterial.blendSrcAlpha = THREE.ZeroFactor;
  windowMaterial.blendDstAlpha = THREE.OneFactor;

  // ── THE INSTRUMENT — a second material no mesh draws until asked ────────
  // `window.js#WINDOW_DEBUG_CHANNELS` holds the why and the reading guide.
  const uDebugChannel = uniform(float(0));
  const debugNodes = {
    quad: vec3(1, 0, 1),
    mask: maskSample.rgb,
    presence: vec3(presence, presence, presence),
    level: vec3(level, level, level),
    tint,
    floorGate: debugFloorGate,
    rawLight: rawLight.mul(float(WINDOW_DEBUG_BOOST)),
    final: cookieLight.mul(float(WINDOW_DEBUG_BOOST)),
  };
  let debugColor = vec3(0, 0, 0);
  for (const ch of WINDOW_DEBUG_CHANNELS) {
    if (ch.n === 0) continue;
    const node = debugNodes[ch.id];
    // Loud at BUILD time, never a channel that quietly shows the one below it
    // (`feedback_instruments_must_not_lie`).
    if (!node) throw new Error(`window debug channel '${ch.id}' (n=${ch.n}) has no node in debugNodes`);
    debugColor = abs(uDebugChannel.sub(float(ch.n)))
      .lessThan(float(0.5))
      .select(node, debugColor);
  }
  const debugMaterial = new THREE.NodeMaterial();
  debugMaterial.colorNode = vec4(debugColor, 1);
  configureShared(debugMaterial);
  // OPAQUE where the effect ADDS: a diagnostic whose "this is zero" answer
  // rendered as *nothing added* would reproduce the ambiguity it removes.
  debugMaterial.blending = THREE.CustomBlending;
  debugMaterial.blendEquation = THREE.AddEquation;
  debugMaterial.blendSrc = THREE.OneFactor;
  debugMaterial.blendDst = THREE.ZeroFactor;
  debugMaterial.blendEquationAlpha = THREE.AddEquation;
  debugMaterial.blendSrcAlpha = THREE.OneFactor;
  debugMaterial.blendDstAlpha = THREE.ZeroFactor;

  return {
    windowMaterial,
    debugMaterial,
    maskTexNode,
    /** THE ONE DOOR onto the mask texture. */
    setMaskTexture(tex) {
      maskTexNode.value = tex;
    },
    /** The crop's extent in MASK-UV space — the entire mask lookup.
     * @param {{minU:number,minV:number,maxU:number,maxV:number}} b */
    setMaskUvBounds(b) {
      uMaskUvBounds.value.set(b.minU, b.minV, b.maxU, b.maxV);
    },
    setFloorIndex(index) {
      uFloorIndex01.value = (Number.isFinite(index) ? Math.max(0, Math.min(255, index)) : 0) / 255;
    },
    setStrength(v2) {
      uStrength.value = Math.max(0, v2);
    },
    setContrast(v2) {
      uContrast.value = Math.max(0.001, v2);
    },
    /** Which intermediate `debugMaterial` shows. 0 = off; the CALLER makes 0
     * free by DETACHING the material rather than leaving it attached. */
    setDebugChannel(n) {
      uDebugChannel.value = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    },
    floorGateCompiled: !!attrTexture,
  };
}
