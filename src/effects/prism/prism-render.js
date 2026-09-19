/**
 * PRISM's SURFACE — the TSL per-item material. THREE is INJECTED, never
 * imported (mythica-machina-press#137).
 *
 * ============================================================================
 * WHAT EACH TIER SHOWS, AND WHY DISPERSION NEEDS A CAPTURED TEXTURE
 * ============================================================================
 * Tiers 0-2 need nothing but this item's own mask and a fake, purely local
 * facet field — no dependent read, no capture, cheap ALU (`prism.js#PRISM
 * .tiers` has the full cost-class reasoning). Tier 3 (dispersion) is
 * different: it needs to read what is ACTUALLY behind the glass, which means
 * a real capture of the finished frame (`prism-refraction-subsystem.js`,
 * `behindTexture` below) — the SAME reason `effects/water/water-render.js`'s
 * own tier 5 cannot sample `buf:scene.color` from inside the pass that is
 * still writing it. This module mirrors that tier's own three-tap chromatic
 * remap almost exactly (`positionWorld` → `capturedRect`'s own UV space,
 * tap-validated against `buf:scene.depth` with a fallback to the centre,
 * undistorted UV) — see the tier-3 block below for the one real difference:
 * the OFFSET direction comes from a procedural Voronoi facet slope
 * (`prism-motion.js#computeVoronoiFacet`), not a simulated wave's own slope.
 *
 * ============================================================================
 * WHAT V2 DID, AND WHAT IS DELIBERATELY DIFFERENT HERE
 * ============================================================================
 * `legacy/compositor-v2/effects/PrismEffectV2.js` (recovered from git
 * history, `c328c9bd~1`) sampled its OWN tile's base-colour texture at three
 * offset UVs — a same-frame texel-offset approximation that could only ever
 * bend the tile's OWN art, never the actual scene behind the glass. That
 * offset was a plain UV delta (`offsetR = slope * intensity*0.01 * (1+spread)`)
 * because V2's "behind" texture was the same 0..1 tile UV space the facet
 * field itself lives in. This build reads a REAL captured frame instead
 * (the author's own "make it better" permission names exactly this
 * upgrade), which lives in WORLD/view UV space, not tile UV space — so the
 * offset is reinterpreted as a WORLD-PX distance (`PRISM_REFRACT_WORLD_PX_
 * PER_INTENSITY` below) rather than V2's own bare UV fraction. The formula's
 * SHAPE (slope × distance × (1±spread), red furthest / blue least) is kept
 * exactly; only the unit the distance is measured in changed, because the
 * texture it now displaces across is measured in a different space than
 * V2's was.
 *
 * @module effects/prism/prism-render
 */

import { computeFacetTimePhase, PRISM_DEFAULT_TIER, PRISM_MAX_TIER, prismTierPlan } from './prism-motion.js';

export { PRISM_DEFAULT_TIER, PRISM_MAX_TIER, prismTierPlan };

/**
 * WORLD PX PER UNIT OF `intensity` the dispersion tier's own offset reaches —
 * see this module's own header for why V2's bare UV-fraction offset had to be
 * reinterpreted in world px once the "behind" texture became a real scene
 * capture rather than the tile's own UV space. Chosen to land in the same
 * ORDER OF MAGNITUDE as `water`'s own `refractStrengthPx` range (0-200px,
 * `water.js`) at Prism's own `intensity` ceiling of 5: `5 * 24 = 120px`, a
 * strong-but-plausible bend, while the authored DEFAULT (`0.3`) stays subtle
 * (`0.3 * 24 = 7.2px`) — a real, considered choice, not a re-derivation of
 * V2's own literal (V2's UV-space number has no equivalent world-px value at
 * all, since the two textures are not the same size).
 * @type {number}
 */
export const PRISM_REFRACT_WORLD_PX_PER_INTENSITY = 24;

/** V2's own fake glass-fallback slope direction (`normalize(vWorldUv*0.5 + 0.0001)`,
 * `PrismEffectV2.js#main`) collapses, for a per-ITEM mesh with no meaningful
 * "world UV" of its own, to a fixed diagonal — a smooth, directionless-looking
 * fallback is all `facetSoftness` needs from it (this module's own tier-1
 * block has the full reasoning). */
const PRISM_GLASS_FALLBACK_SLOPE = [0.7071067811865476, 0.7071067811865476];

/**
 * Build the Prism surface material for ONE item's own mesh (mirrors
 * `buildSpecularSurfaceMaterial`'s/`buildFluidSurfaceMaterials`'s own
 * per-item shape — Prism v1 is TILE-only, `prism-seams.js`'s own header has
 * the full account of why a floor-level population is a deliberate follow-up).
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.maskTexture - this item's own authored `_Prism` file.
 * @param {*} [args.behindTexture] - `prism-refraction-subsystem.js`'s own
 *   captured copy of the finished frame. ALWAYS a real texture (a 1×1 stub
 *   below tier 3 or before the first capture) — the gate is `plan.
 *   dispersionEnabled`, never a null check, matching `lightBurnTexture`'s own
 *   contract in `effects/lens-render.js`.
 * @param {*} [args.depthTexture] - `buf:scene.depth`. Optional: a JS-time
 *   branch compiles the whole occlusion/tap-validation gate OUT when absent
 *   (`tsl/no-uniform-gates` — an unwired caller pays nothing and renders as
 *   though nothing stands in front of the glass), mirroring `water-render.js`
 *   /`window-render.js`'s own identical convention.
 * @param {*} [args.uViewRect] - the SHARED view-rect uniform NODE
 *   (`envLight.uViewRect`, a vec4 `[minX,minY,maxX,maxY]`) every other
 *   depth-authority consumer in this codebase already reads — never a plain
 *   rect rebuilt into a private uniform here. Passed BY REFERENCE so the one
 *   place that pushes a fresh `.value` every frame (`vt-pan-viewer.js`)
 *   updates every material's own occlusion/tap-validation gate for free,
 *   the identical convention `specular-render.js`'s/`water-render.js`'s own
 *   `uViewRect` parameter already follows. Needed only alongside
 *   `depthTexture`, for the occlusion/tap-validation screen-UV mapping
 *   (byte-for-byte `window-render.js`'s/`water-render.js`'s own floor-gate
 *   formula).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} [args.capturedRect] -
 *   the world rect `behindTexture`'s own UV space maps across
 *   (`prism-refraction-subsystem.js#capturedRect`). Defaults to a degenerate
 *   1×1 rect at the origin — safe to construct with, never sampled
 *   meaningfully until a real capture lands (mirrors `water-render.js#
 *   WATER_TIER5_PLACEHOLDER_RECT`'s own posture).
 * @param {{width:number,height:number}} [args.capturedTexSize] - `behindTexture`'s
 *   own texel dimensions, for the chromatic-fringe texel pitch (unused below
 *   tier 3 — kept optional rather than required, same posture water takes).
 * @param {number} [args.expectedDepth] - this item's own depth-authority rank
 *   (`depthAuthority.rankOf`), compared against `depthTexture` — 0 (nothing
 *   ranked above the mesh's own rank of 0) when omitted.
 * @param {boolean} [args.facetAnimate] - `PRISM_PARAMS.facetAnimate`'s own
 *   build-time value. A genuine JS-time branch (`tsl/no-uniform-gates`), not
 *   a uniform: this schema knob changes the GRAPH (whether the facet field
 *   reads the clock at all), not a per-frame amount, so it is read once at
 *   build time exactly like `tier` itself. Defaults `true`.
 * @param {number} [args.tier] - `PRISM_DEFAULT_TIER` default.
 * @returns {{material: *, maskTexNode: *, behindTexNodes: Array<*>, depthTexNode: (*|null),
 *   uniforms: object, tier: number}} `maskTexNode`/`behindTexNodes`/`depthTexNode` —
 *   re-point every frame the caller has a fresh texture identity for (mirrors
 *   `lens-render.js`'s own re-pointable-node contract); `behindTexNodes` is
 *   `[]` below tier 3 — nothing to re-point, matching `fluid-render.js`'s own
 *   "empty below its own gating tier" shape. `uniforms` carries every live
 *   knob keyed by `PRISM_PARAMS` name (`u` + PascalCase) plus the two
 *   per-frame values this build does not (yet) have a live feed for —
 *   `uTimeSec` and `uCameraOffsetPx` — pushed fresh every frame once a real
 *   pass exists, and safe zero-value defaults (a frozen facet field, no
 *   parallax) until then.
 */
export function buildPrismSurfaceMaterial({
  THREE,
  maskTexture,
  behindTexture,
  depthTexture,
  uViewRect,
  capturedRect,
  capturedTexSize,
  expectedDepth = 0,
  facetAnimate = true,
  tier = PRISM_DEFAULT_TIER,
}) {
  // ⚠️ `??`, NOT a default-parameter value — a caller legitimately passes
  // `capturedRect: null`/`capturedTexSize: null` for "no capture yet" (the
  // exact shape `prism-surface-subsystem.js`'s own entries carry before the
  // first tick), and a default PARAMETER only ever guards `undefined`,
  // never `null` — passing `null` bypasses it entirely and this constructor
  // would throw on `capturedRect.minX` a few lines down. Real bug, caught by
  // this module's own `prism-surface-subsystem.test.mjs`.
  capturedRect ??= { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  capturedTexSize ??= { width: 1, height: 1 };
  const plan = prismTierPlan(tier);
  const {
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    clamp,
    smoothstep,
    mix,
    max: maxNode,
    length,
    dot,
    floor,
    fract,
    sin,
    select,
    step,
    positionWorld,
    Fn,
  } = THREE.TSL;

  // ── UNIFORMS — every PRISM_PARAMS knob this material actually reads ─────
  const uMaskThreshold = uniform(float(0.9));
  const uOpacity = uniform(float(0.25));
  const uBrightness = uniform(float(1.5));
  const uMaskTintStrength = uniform(float(0));
  const uFacetScale = uniform(float(254));
  const uFacetSpeed = uniform(float(1.01));
  const uFacetSoftness = uniform(float(0.85));
  const uParallaxStrength = uniform(float(2.4));
  const uGlintStrength = uniform(float(0.4));
  const uGlintThreshold = uniform(float(0.13));
  const uIntensity = uniform(float(0.3));
  const uSpread = uniform(float(0.6));

  // Per-frame values, pushed fresh once a real pass exists — 0 by
  // construction until then, the same "safe to leave unwired" contract
  // `effects/lens-render.js`'s own tier-1 motion uniforms document.
  const uTimeSec = uniform(float(0));
  const uCameraOffsetPx = uniform(vec2(0, 0));

  const uExpectedDepth = uniform(float(expectedDepth));
  const uCapturedRect = uniform(vec4(capturedRect.minX, capturedRect.minY, capturedRect.maxX, capturedRect.maxY));
  const uCapturedTexelUv = uniform(
    vec2(1 / Math.max(1, capturedTexSize.width), 1 / Math.max(1, capturedTexSize.height))
  );

  // ── THE MASK — this item's OWN uv(), never a world-rect remap: a tile's
  // `_Prism` file is mounted 1:1 on its own mesh, the same convention
  // `fluid-render.js`'s own per-tile mask sampling already uses (only a
  // FLOOR-level surface, not built here — this module's own header — would
  // need a world-rect-to-UV remap the way `specular`'s own floor door does).
  const maskTexNode = texture(maskTexture, uv());
  const maskSample = maskTexNode.rgb;
  // Presence reads the mask's own LUMA, not R alone (`scene/mask-catalog.js`
  // `prism` kind's own `meaning` — a genuine, documented upgrade on V2's
  // R-only `smoothstep(uMaskThreshold, 1.0, maskSample.r)`): an ordinary
  // black-and-white mask has r=g=b, so luma reproduces V2's own reading
  // exactly, while a genuinely coloured mask still reports real presence
  // rather than reading as absent everywhere V2 would have (a blue-painted
  // gem having r=0 is the identical trap `specular`'s own mask note names).
  const maskLuma = dot(maskSample, vec3(0.2126, 0.7152, 0.0722));
  const presence = smoothstep(uMaskThreshold, float(1), maskLuma).toVar('prismPresence');
  // The tint direction: the mask's own hue/saturation, normalised so an
  // unsaturated (grey) mask contributes pure white — i.e. no tint — however
  // bright or dark it reads, which is what keeps `maskTintStrength: 0`'s own
  // "an ordinary mask tints nothing" contract exact regardless of how the
  // author painted the greys.
  const tintRaw = maxNode(maskSample, vec3(0.0001, 0.0001, 0.0001));
  const maskTint = mix(vec3(1, 1, 1), tintRaw.div(maxNode(maskLuma, float(0.0001))), clamp(uMaskTintStrength, 0, 1));

  // ── THE DEPTH-AUTHORITY OCCLUSION GATE — byte-for-byte `window-render.js`'s/
  // `water-render.js`'s own floor-gate formula (this module's own header)
  // ─────────────────────────────────────────────────────────────────────────
  let notOccluded = float(1);
  if (depthTexture && uViewRect) {
    const viewSpanX = maxNode(uViewRect.z.sub(uViewRect.x), float(1));
    const viewSpanY = maxNode(uViewRect.w.sub(uViewRect.y), float(1));
    const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
    const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
    const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1));
    const depthHere = texture(depthTexture, screenUv);
    // `step(edge,x) = x>=edge ? 1:0` — "is the stored depth at this pixel AT
    // OR ABOVE my own rank" — 1 unless a token/upper floor is drawn over it.
    notOccluded = step(uExpectedDepth, depthHere);
  }

  // ── THE FACET FIELD (tier 1) — `prism-motion.js#computeVoronoiFacet`,
  // transcribed into TSL. A plain JS `for` loop: TSL Fn bodies unroll at
  // BUILD time (9 fixed candidate taps, the same "unrolled, not a runtime
  // loop" shape `lens-render.js#buildLensCompositeMaterial`'s own Kawase
  // blur already uses), so the RUNTIME cost is 9 fixed ALU candidates and one
  // `select()`-driven reduction, never a real branch. ───────────────────────
  const hash2 = Fn(([p]) => {
    const dotA = dot(p, vec2(127.1, 311.7));
    const dotB = dot(p, vec2(269.5, 183.3));
    return fract(sin(vec2(dotA, dotB)).mul(43758.5453));
  });
  const TAU = Math.PI * 2;
  const cellJitter = Fn(([cell, timePhase]) => {
    const h = hash2(cell);
    return float(0.5).add(float(0.5).mul(sin(timePhase.add(h.mul(TAU)))));
  });
  /** @returns {{slope: *}} the blended facet/glass slope, as a vec2 node. */
  function buildFacetSlope() {
    // `facetAnimate` gates the CLOCK, not just the visible motion — see
    // `prism-motion.js#computeFacetTimePhase`'s own doc. A genuine JS-time
    // branch on the build-time `facetAnimate` argument (never a runtime
    // uniform gate, `tsl/no-uniform-gates`): OFF freezes the pattern at
    // phase 0 forever, not merely at whatever the clock read when disabled.
    const timePhase = facetAnimate ? uTimeSec.mul(uFacetSpeed) : float(0);
    const parallaxUv = uCameraOffsetPx.mul(0.0001).mul(uParallaxStrength);
    const facetUv = uv().add(parallaxUv).mul(uFacetScale);
    const cellOrigin = floor(facetUv);
    const cellFrac = fract(facetUv);

    let best = float(8.0);
    let slope = vec2(0, 0);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const neighbor = cellOrigin.add(vec2(i, j));
        const jitter = cellJitter(neighbor, timePhase);
        const candidate = vec2(i, j).add(jitter).sub(cellFrac);
        const d = dot(candidate, candidate);
        const closer = d.lessThan(best);
        best = select(closer, d, best);
        slope = select(closer, candidate, slope);
      }
    }
    const glassSlope = vec2(PRISM_GLASS_FALLBACK_SLOPE[0], PRISM_GLASS_FALLBACK_SLOPE[1]);
    return mix(slope, glassSlope, clamp(uFacetSoftness, 0, 1)).toVar('prismFacetSlope');
  }

  let baseColor = maskTint.toVar('prismBaseColor');
  const opacityTerm = presence
    .mul(clamp(uOpacity, 0, 1))
    .mul(notOccluded)
    .toVar('prismOpacity');
  let facetSlope = null;
  // ⚠️ FIX (independent review, 2026-09-19): glint is tracked as its OWN
  // additive term, never folded into `baseColor` itself. The first version
  // of this function added glint directly into `baseColor` and tried to
  // recover "whatever tier 1-2 added" at the dispersion tier via
  // `finalColor.sub(baseColor)` — but that difference is
  // `baseColor*(brightness-1)`, not the glint term alone, so at
  // `brightness === 1` the glint vanished ENTIRELY from the dispersion tier
  // (contradicting this function's own stated intent, "the glint highlight
  // still reads on top of real glass"), and at any other brightness the
  // residual also double-counted a scaled copy of the tint×facet-shade term.
  // Keeping glint as its own accumulator, added AFTER brightness at every
  // tier, is correct at every brightness value, not just the shipped
  // default (1.5, which is far enough from 1 that the bug was not obvious
  // from the numbers alone).
  let glintAdd = vec3(0, 0, 0);

  if (plan.facetsEnabled) {
    facetSlope = buildFacetSlope();
    // A cheap fake key-light so facets read as having real, varying
    // brightness even before the glint (tier 2) or dispersion (tier 3) rungs
    // — `dot()` against a fixed diagonal, remapped to 0..1 the same way a
    // Lambertian half-Lambert shading term is (never negative, never fully
    // dark, so a facet pointed away from the fake light still reads as
    // glass rather than going black). ─────────────────────────────────────
    const slopeLen = maxNode(length(facetSlope), float(1e-5));
    const slopeDir = facetSlope.div(slopeLen);
    const facetShade = clamp(dot(slopeDir, vec2(0.6, 0.8)), -1, 1)
      .mul(0.5)
      .add(0.5)
      .mul(0.5)
      .add(0.5);
    baseColor = baseColor.mul(facetShade).toVar('prismBaseColor');
  }

  if (plan.glintEnabled && facetSlope) {
    // V2's own rotating fake light direction (`prism-motion.js#
    // computeGlintAmount`'s own doc has the full formula/reasoning).
    // `cos(x) === sin(x + PI/2)` — written as a `sin()` so this shares the
    // same TSL primitive `cellJitter`'s own hash uses, rather than importing
    // a second trig function for one call site.
    const lightDir = vec2(sin(uTimeSec.mul(0.5)), sin(uTimeSec.mul(0.3).add(Math.PI / 2)));
    const slopeLen = maxNode(length(facetSlope), float(1e-5));
    const lightLen = maxNode(length(lightDir), float(1e-5));
    const alignment = dot(facetSlope.div(slopeLen), lightDir.div(lightLen));
    const glint = smoothstep(clamp(uGlintThreshold, 0, 0.99), float(1), alignment).mul(
      maxNode(uGlintStrength, float(0))
    );
    glintAdd = vec3(glint, glint, glint).toVar('prismGlintAdd');
  }

  /** @type {Array<*>} every `texture(behindTexture, …)` node this build
   * created — empty below tier 3, matching `water-render.js#capturedTexNodes`'s
   * own "re-point every one together" contract. */
  const behindTexNodes = [];
  let finalColor = baseColor.add(glintAdd).mul(maxNode(uBrightness, float(0)));

  if (plan.dispersionEnabled && facetSlope) {
    // `distAmt` — see this module's own header on why this is a WORLD-PX
    // distance, not V2's own bare UV fraction. Bounded the same way water's
    // own tier 5 bounds its wave slope before using it as an offset
    // (`water-render.js`'s own comment on the live "oil spill" bug this
    // guards against): a gentle slope (|slope|<=1, the overwhelming common
    // case) is untouched; only a rare, unusually steep facet boundary is
    // clamped to unit length first.
    const slopeLen = maxNode(length(facetSlope), float(1));
    const slopeBounded = facetSlope.div(slopeLen);
    const distAmt = maxNode(uIntensity, float(0)).mul(PRISM_REFRACT_WORLD_PX_PER_INTENSITY);
    const spreadClamped = clamp(uSpread, 0, 1);
    const offsetR = slopeBounded.mul(distAmt).mul(float(1).add(spreadClamped));
    const offsetG = slopeBounded.mul(distAmt);
    const offsetB = slopeBounded.mul(distAmt).mul(float(1).sub(spreadClamped));

    const capturedSpanX = maxNode(uCapturedRect.z.sub(uCapturedRect.x), float(1));
    const capturedSpanY = maxNode(uCapturedRect.w.sub(uCapturedRect.y), float(1));
    const centerUv = vec2(
      clamp(positionWorld.x.sub(uCapturedRect.x).div(capturedSpanX), 0, 1),
      clamp(positionWorld.y.sub(uCapturedRect.y).div(capturedSpanY), 0, 1)
    );
    /** @param {*} offset - a world-space vec2 offset. @returns {*} this channel's own captured-texture UV. */
    function offsetToUv(offset) {
      const worldXY = vec2(positionWorld.x, positionWorld.y).add(offset);
      return vec2(
        clamp(worldXY.x.sub(uCapturedRect.x).div(capturedSpanX), 0, 1),
        clamp(worldXY.y.sub(uCapturedRect.y).div(capturedSpanY), 0, 1)
      );
    }
    /** TAP VALIDATION — same `water-render.js` idiom: a tap landing on
     * something ranked ABOVE this glass (a token standing where the bend
     * would look) falls back to the centre, unrefracted UV. */
    function validated(uvNode) {
      if (!depthTexture || !uViewRect) return uvNode;
      const tapViewSpanX = maxNode(uViewRect.z.sub(uViewRect.x), float(1));
      const tapViewSpanY = maxNode(uViewRect.w.sub(uViewRect.y), float(1));
      const worldXY = uvNode.mul(vec2(capturedSpanX, capturedSpanY)).add(vec2(uCapturedRect.x, uCapturedRect.y));
      const tapScreenUv = vec2(
        clamp(worldXY.x.sub(uViewRect.x).div(tapViewSpanX), 0, 1),
        clamp(worldXY.y.sub(uViewRect.y).div(tapViewSpanY), 0, 1)
      );
      const depthAtTap = texture(depthTexture, tapScreenUv);
      const tapValid = step(uExpectedDepth, depthAtTap);
      return mix(centerUv, uvNode, tapValid);
    }

    const uvR = validated(offsetToUv(offsetR));
    const uvG = validated(offsetToUv(offsetG));
    const uvB = validated(offsetToUv(offsetB));
    const refractRNode = texture(behindTexture, uvR);
    const refractGNode = texture(behindTexture, uvG);
    const refractBNode = texture(behindTexture, uvB);
    behindTexNodes.push(refractRNode, refractGNode, refractBNode);
    const refractColor = vec3(refractRNode.r, refractGNode.g, refractBNode.b);

    // Dispersion REPLACES the flat mask tint with the real refracted scene —
    // `baseColor` (tint × facet shade) is dropped entirely here, but `glintAdd`
    // (tier 2's own additive highlight, tracked separately — see this
    // function's own fix note above) is kept and re-added at the SAME
    // brightness scale, so the glint highlight still reads on top of real
    // glass at every brightness value, not just ones far from 1.
    finalColor = refractColor
      .mul(maskTint)
      .add(glintAdd)
      .mul(maxNode(uBrightness, float(0)));
  }

  const material = new THREE.NodeMaterial();
  material.colorNode = vec4(finalColor, 1);
  material.opacityNode = opacityTerm;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;

  return {
    material,
    tier: plan.tier,
    maskTexNode,
    behindTexNodes,
    depthTexNode: depthTexture ? texture(depthTexture, uv()) : null,
    uniforms: {
      uMaskThreshold,
      uOpacity,
      uBrightness,
      uMaskTintStrength,
      uFacetScale,
      uFacetSpeed,
      uFacetSoftness,
      uParallaxStrength,
      uGlintStrength,
      uGlintThreshold,
      uIntensity,
      uSpread,
      uTimeSec,
      uCameraOffsetPx,
      uExpectedDepth,
      uCapturedRect,
      uCapturedTexelUv,
    },
  };
}

// Re-exported for a caller that wants the exact CPU-side phase this
// material's own `uTimeSec.mul(uFacetSpeed)` mirrors when `facetAnimate` is
// on, e.g. for a debug readout — see `prism-motion.js`'s own doc.
export { computeFacetTimePhase };
