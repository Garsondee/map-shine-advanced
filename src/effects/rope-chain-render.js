/**
 * ROPE & CHAIN — THE RIBBON MATERIAL (Phase 2, mythica-machina-press#1). The
 * TSL material + BufferGeometry glue for ONE rope/chain instance's tapered
 * ribbon mesh. Pure math (sag, modal sway, the ribbon vertex-array bake)
 * lives in `rope-chain-geometry.js`; this file is TSL/THREE glue only,
 * browser-verified live, mirroring `lightning-render.js`'s own split.
 *
 * ============================================================================
 * THE MITER-JOIN TECHNIQUE IS `lightning-render.js`'s, REUSED VERBATIM
 * ============================================================================
 * The degenerate-direction fallback, the `nPrev`/`nNext`/`miter`/
 * `miterScale` derivation and the magic safety constants (`1e-6`, `1e-3`,
 * `0.25`, `2.25`) are copied shape-for-shape from `lightning-render.js`'s own
 * `positionNode` — see that file's own header for the technique's origin
 * (ported from V2's clip-space miter join, applied here in WORLD space like
 * every other MSA ribbon). Factored into the MODULE-LEVEL
 * `buildRopeChainMiterNormal(TSL, cur, prev, next)` function below (not a
 * local closure of either material builder) because Phase 3 added a SECOND
 * builder (`buildRopeChainShadowMaterial`) that needs the exact same math
 * applied twice more of its own — four call sites across two functions is
 * past the point where "only one caller ever needed it" holds, and sharing
 * ONE copy means the rope's own ribbon and its shadow twin can never
 * silently drift apart on this specific formula (see "THE SHADOW TWIN"
 * below for why that matters more here than usual: the shadow is
 * specifically meant to trace the SAME curve shape as the rope, just offset).
 *
 * ============================================================================
 * THE MODAL DISPLACEMENT ORDER — read this before changing the vertex shader
 * ============================================================================
 * `rope-chain-geometry.js#buildRopeChainRibbonArrays` bakes the SAG-ONLY
 * shape (this file's `position`/`prevPos`/`nextPos` attributes never contain
 * live wind sway — `rope-chain-subsystem.js` always calls it with a
 * `() => 0` modal callback). The LIVE sway is added here, per vertex, every
 * frame, in three steps:
 *
 *   1. Compute the BASE tangent/normal from the three BAKED (sag-only)
 *      points — `buildRopeChainMiterNormal(TSL, cur, prevPos, nextPos)`.
 *   2. Displace all three points by their OWN modal term along that ONE
 *      shared base normal (`modalAt(s)`, the TSL mirror of
 *      `rope-chain-geometry.js#modalDisplacement`, reading the two live
 *      amplitude channels off the instance's own 1x1 published spring
 *      texture instead of a JS array). Using the CURRENT vertex's normal for
 *      all three neighbours is a deliberate simplification: on this smooth
 *      parabolic+sine curve the perpendicular direction barely changes
 *      across 3 adjacent samples, unlike lightning's jagged fractal path
 *      where per-point normals genuinely differ enough to matter.
 *   3. Re-run `buildRopeChainMiterNormal` against the DISPLACED points to get
 *      the FINAL ribbon-expansion normal — this is what actually varies as
 *      the rope sways, so the ribbon's cross-section stays correctly
 *      oriented mid-sway instead of being a flat sideways-shifted copy of
 *      the rest shape.
 *
 * `buildRopeChainShadowMaterial` (Phase 3, below) runs the SAME three steps
 * against the SAME baked attributes and the SAME live spring texture (so it
 * sways in exact lockstep with the rope — see its own header), then adds a
 * fourth: the height-scaled shadow throw, added to all three curve points
 * BEFORE a second `buildRopeChainMiterNormal` call re-derives the shadow's
 * OWN final ribbon-expansion normal from ITS OWN (further-displaced) points.
 *
 * ============================================================================
 * DEPTH TEST / DEPTH WRITE — VERIFIED, NOT GUESSED (2026-09-20)
 * ============================================================================
 * The Phase 2 brief asked for "whatever a comparable opaque, ordinarily-
 * occludable prop uses." Direct inspection of vt-pan-viewer.js found that
 * EVERY material it builds — the whole-image tile material, the vegetation
 * canopy/shadow material, the TAA resolve quad, the token-occlusion disc,
 * AND lightning's own additive glow — sets `depthTest:false,
 * depthWrite:false`. `runGeometryWorldPass`'s own comment says so outright:
 * "this renderer runs with depthTest:false everywhere except this one pass"
 * (the internal `buf:scene.depth` prepass, a separate dedicated camera/
 * target this ordinary ribbon never participates in). Occlusion in this
 * engine is by `renderOrder`/draw order and an opt-in depth-authority
 * TEXTURE gate (sampled, never hardware-tested — see
 * `lighting/point-light-illumination.js#buildDepthHeightGateNode`, which
 * lightning's own fragment shader opts into), not GPU depth test/write. So
 * there is no DIFFERENT convention to switch to here: this material sets
 * the SAME `depthTest:false/depthWrite:false` every other material already
 * does. What genuinely differs from lightning is `transparent`/`blending`
 * (a rope is a solid, opaque object, not an additive glow) and the absence
 * of the depth-authority gate — Rope & Chain does not wire one this phase
 * (no elevation-based occlusion yet against other floor content; a real,
 * documented gap, not an oversight — `rope-chain-subsystem.js`'s own header
 * names it, still true after Phase 3: the shadow twin below is purely a
 * sun-cast ground shadow and does not touch this gap either).
 *
 * ============================================================================
 * THE SHADOW TWIN (Phase 3, mythica-machina-press#1) —
 * `buildRopeChainShadowMaterial`, below
 * ============================================================================
 * A SEPARATE `THREE.Mesh` sharing the SAME `BufferGeometry` object the main
 * ribbon mesh already uses (see `rope-chain-subsystem.js`'s own header for
 * why that sharing is safe — the short version: both meshes read the same
 * geometry object's attributes at draw time, so an in-place attribute
 * refill already updates both, with no change needed to the refill path).
 * Mirrors `effects/vegetation-shadow-subsystem.js`'s own twin-mesh precedent
 * (same texture/tessellation/motion as the caster, offset by the sun's
 * throw) but NOT its multi-tap smear/sweep machinery — that exists
 * specifically to turn a FILLED canopy blob into a streak; a thin curve's
 * shadow is already line-shaped, so offsetting it just gives another line.
 *
 * THE HEIGHT PROBLEM AND ITS EXACT SOLUTION: a rope's implied height above
 * the floor varies along its length (tall at the anchors, at ground level at
 * the sag's lowest point), but only ONE height is ever authored
 * (`elevation`, at the anchors). `rope-chain-geometry.js#
 * impliedHeightFraction01(s)` derives a normalized 0..1 height-fraction curve
 * from the SAME parabolic shape family the sag already uses, at unit
 * amplitude — see that function's own doc. Because `effects/shadow-access.js#
 * forCaster`'s `offsetX`/`offsetY` are PROVABLY LINEAR in `heightPx` for a
 * fixed sun angle (both the raw throw and its soft-knee ceiling scale
 * linearly with height — see `shadow-access.js`'s own `maxThrowForHeightPx`
 * doc), ONE `forCaster()` call per instance per frame, at the anchor's own
 * `elevation` (`rope-chain-subsystem.js#applyShadowUniforms`), scaled
 * PER-VERTEX by `impliedHeightFraction01` here, is EXACT for every point
 * along the span — not an approximation that happens to look right.
 *
 * STRENGTH — JUDGMENT CALL, named in `rope-chain-subsystem.js`'s own
 * `ROPE_CHAIN_SHADOW_STRENGTH_DEFAULT`: the `ropeChain` anchor kind has no
 * authored `shadowStrength` param yet (unlike vegetation's own
 * `params.shadowStrength`), so a fixed constant stands in until a future
 * phase decides this is worth exposing.
 *
 * RENDER ORDER, BLENDING, FRAGMENT SHAPE: see `rope-chain-subsystem.js`'s own
 * header for the render-order case-1-vs-case-2 reasoning (a rope's shadow
 * draws BEFORE its own rope, same case as vegetation's self-canopy shadow).
 * The fragment output mirrors `vegetation-shadow-subsystem.js`'s own shadow
 * fragment exactly in SHAPE — flat black, alpha-only (`vec4(0,0,0,alpha)`),
 * "under ordinary alpha blending this IS a multiply-darken of whatever
 * ground is beneath it" (that file's own fragment comment) — with a light
 * alpha feather toward the ribbon edges (this file's own `vSide` varying,
 * already used by the main material's brightness-based "rounded cylinder"
 * touch) standing in for a softer, less hard-edged silhouette. Multi-tap
 * `penumbraPx`-driven blur is DELIBERATELY NOT attempted — Phase 2's own
 * design comment already says this effect's shadow does not need the smear
 * machinery vegetation's does, and a per-fragment blur is a bigger, separate
 * piece of work; `penumbraPx` is still captured into a uniform
 * (`uPenumbraPx`) for a future phase to use, simply unread by this phase's
 * fragment shader.
 *
 * ============================================================================
 * RENDER ORDER VS. THE TRANSPARENCY QUEUE — A REAL BUG CAUGHT BY READING
 * THREE's OWN SOURCE, NOT BY ASSUMING THE VEGETATION PRECEDENT TRANSFERS
 * ============================================================================
 * Vegetation's own canopy AND its shadow twin are BOTH `transparent = true`
 * (foliage art needs alpha cutouts), so `VEG_SHADOW_RENDER_ORDER_MAGNITUDE`'s
 * renderOrder trick works there: both meshes land in THREE's one TRANSPARENT
 * render list, and `renderOrder` is the list's own primary sort key
 * (confirmed by reading `three/src/renderers/common/RenderList.js`'s
 * `reversePainterSortStable`). Rope & Chain's own main material is
 * DELIBERATELY `transparent = false` (this file's own "DEPTH TEST / DEPTH
 * WRITE" header: "a rope is a solid, opaque object"). Naively giving the
 * shadow `transparent = true` (the first draft of this function) would have
 * put it in a DIFFERENT list — and `RenderList.js#push` partitions purely by
 * `material.transparent`, while the renderer ALWAYS finishes the entire
 * opaque list before starting the transparent one
 * (`renderers/common/Renderer.js`: `_renderObjects(opaqueObjects,...)` then
 * `_renderTransparents(transparentObjects,...)`, unconditionally, every
 * frame) — so `renderOrder` would have had ZERO effect on ordering relative
 * to the rope specifically: the transparent shadow would ALWAYS draw in a
 * LATER pass than the opaque rope, painting its dark alpha directly OVER the
 * rope's own already-drawn pixels wherever the two overlap (worst right at
 * the sag's own lowest point, where the shadow's height-scaled offset is
 * exactly zero and the two ribbons coincide) — the exact opposite of Case
 * 1's intent, and a real visual bug a literal reading of the vegetation
 * precedent would have shipped.
 *
 * THE FIX: `buildRopeChainShadowMaterial` sets `transparent = false` (the
 * SAME opaque list the rope itself is in, where `renderOrder` genuinely
 * governs draw order against it) and reproduces ordinary alpha blending's
 * exact GPU blend factors via `CustomBlending` instead of relying on
 * `NormalBlending`'s own implicit gate (`WebGPUPipelineUtils.js#_getBlending`
 * — confirmed by reading it directly — skips blending entirely when
 * `blending === NormalBlending && transparent === false`, but does NOT skip
 * an equivalent `CustomBlending`). See that function's own inline comments
 * for the exact six blend-factor values and their citation. The same
 * "opaque + CustomBlending" shape already exists elsewhere in this codebase
 * (`buildOcclusionDisc`, vt-pan-viewer.js) for a different blend equation —
 * this is a reuse of an established technique, not a new one.
 *
 * @module effects/rope-chain-render
 */

const DIRECT_ATTRS = Object.freeze([
  ['position', 'positions', 3],
  ['prevPos', 'prevPos', 3],
  ['nextPos', 'nextPos', 3],
]);

/** Packed groups — mirrors `lightning-render.js`'s own `PACKED_ATTRS` shape,
 * minus its two strand-envelope groups (this effect has no per-vertex baked
 * envelope — the sway is read live from the spring texture, not baked).
 * Only ONE packed group needed: side (±1) + uvOffset (arclength fraction
 * `s`) into one vec2, the same `sideUv` name/packing lightning uses so the
 * two effects stay structurally interchangeable to anyone reading both. 4
 * buffers total (3 direct vec3 + 1 packed vec2) — comfortably under
 * WebGPU's 8-vertex-buffer ceiling (lightning-render.js's own header cites
 * the real compile-time failure that ceiling caused live). */
const PACKED_ATTRS = Object.freeze([['sideUv', 2, ['side', 'uvOffset']]]);

/** Interleave same-length source arrays into one packed Float32Array —
 * verbatim copy of `lightning-render.js`'s own `interleaveInto` (not
 * imported: that one is a private, unexported helper of its own module, and
 * this is a generic enough few lines that duplicating it matches this
 * codebase's own "small generic helper, own copy per effect" precedent —
 * see `rope-chain-geometry.js`'s header on `lightningCirclePolygon`). Reuses
 * `existing` in place when already big enough. */
function interleaveInto(arrays, keys, itemSize, existing) {
  const n = arrays[keys[0]].length;
  const need = n * itemSize;
  const dst = existing && existing.length >= need ? existing : new Float32Array(need);
  for (let v = 0; v < n; v++) {
    const base = v * itemSize;
    for (let k = 0; k < itemSize; k++) dst[base + k] = arrays[keys[k]][v];
  }
  return dst;
}

/**
 * Build a fresh `THREE.BufferGeometry` from {@link
 * import('./rope-chain-geometry.js').buildRopeChainRibbonArrays}'s output —
 * kept thin so the vertex-array MATH stays in rope-chain-geometry.js
 * (Node-tested); only the GPU-object glue is here, mirroring
 * `lightning-render.js#buildLightningGeometry`.
 *
 * @param {*} THREE
 * @param {ReturnType<typeof import('./rope-chain-geometry.js').buildRopeChainRibbonArrays>} arrays
 * @returns {*} a `THREE.BufferGeometry`.
 */
export function buildRopeChainGeometry(THREE, arrays) {
  const geometry = new THREE.BufferGeometry();
  for (const [attrName, arrayKey, itemSize] of DIRECT_ATTRS) {
    geometry.setAttribute(attrName, new THREE.BufferAttribute(arrays[arrayKey], itemSize));
  }
  for (const [attrName, itemSize, keys] of PACKED_ATTRS) {
    geometry.setAttribute(attrName, new THREE.BufferAttribute(interleaveInto(arrays, keys, itemSize), itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geometry.setDrawRange(0, arrays.indexCount);
  return geometry;
}

/**
 * Refill an EXISTING instance's geometry in place — used when a live anchor
 * drag or a `sagPx` edit changes the BAKED shape of an already-live instance
 * (`rope-chain-subsystem.js`'s own "update, don't rebuild the whole
 * instance" path). Unlike lightning's population-driven refill, a rope/chain
 * instance's vertex/index COUNT never changes across a refill — it is always
 * exactly one source's own `pointsPerSpan` points, fixed for the instance's
 * whole lifetime — so this never needs to grow a buffer; it is included
 * anyway (rather than assuming capacity) for the same defensive-reuse
 * discipline `refillLightningGeometry` follows, and because "never actually
 * shrinks/grows" is a fact about today's caller, not a contract this
 * function should assume without checking.
 *
 * @param {*} THREE @param {*} geometry - a geometry built by {@link buildRopeChainGeometry}.
 * @param {ReturnType<typeof import('./rope-chain-geometry.js').buildRopeChainRibbonArrays>} arrays
 */
export function refillRopeChainGeometry(THREE, geometry, arrays) {
  for (const [attrName, arrayKey, itemSize] of DIRECT_ATTRS) {
    const array = arrays[arrayKey];
    const attr = geometry.getAttribute(attrName);
    if (attr && attr.array.length >= array.length) {
      attr.array.set(array);
      attr.needsUpdate = true;
    } else {
      geometry.setAttribute(attrName, new THREE.BufferAttribute(array, itemSize));
    }
  }
  for (const [attrName, itemSize, keys] of PACKED_ATTRS) {
    const attr = geometry.getAttribute(attrName);
    const packed = interleaveInto(arrays, keys, itemSize, attr ? attr.array : null);
    if (attr && attr.array === packed) {
      attr.needsUpdate = true; // reused in place
    } else {
      geometry.setAttribute(attrName, new THREE.BufferAttribute(packed, itemSize));
    }
  }
  const idx = geometry.getIndex();
  if (idx && idx.array.length >= arrays.indices.length) {
    idx.array.set(arrays.indices);
    idx.needsUpdate = true;
  } else {
    geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  }
  geometry.setDrawRange(0, arrays.indexCount);
}

/**
 * THE MITER-JOIN RIBBON-EXPANSION NORMAL — see this module's own header,
 * "THE MITER-JOIN TECHNIQUE", for why this is a MODULE-LEVEL function (not a
 * closure local to either material builder below): Phase 3's shadow twin
 * needs the exact same math applied twice more, and one shared copy is what
 * guarantees the rope's own ribbon and its shadow can never silently drift
 * apart on this specific formula. Ported from `lightning-render.js`'s own
 * `positionNode` verbatim, degenerate-direction fallback and magic safety
 * constants (`1e-6`, `1e-3`, `0.25`, `2.25`) included.
 *
 * Takes `TSL` explicitly (`THREE.TSL`) rather than closing over either
 * builder's own destructured locals, since it is now called from two
 * independent functions.
 *
 * @param {*} TSL - `THREE.TSL`.
 * @param {*} curXY @param {*} prevXY @param {*} nextXY - vec2 TSL nodes, three
 *   consecutive points along a curve.
 * @returns {*} a vec2 TSL node: the ribbon-expansion normal at `curXY`.
 */
function buildRopeChainMiterNormal(TSL, curXY, prevXY, nextXY) {
  const { vec2, float, length, normalize, dot, max, min, abs } = TSL;
  let dirPrev = curXY.sub(prevXY);
  let dirNext = nextXY.sub(curXY);
  const prevLen = length(dirPrev);
  const nextLen = length(dirNext);
  dirPrev = prevLen.lessThan(float(1e-6)).select(dirNext, dirPrev);
  dirNext = nextLen.lessThan(float(1e-6)).select(dirPrev, dirNext);
  dirPrev = normalize(dirPrev);
  dirNext = normalize(dirNext);

  const nPrev = vec2(dirPrev.y.negate(), dirPrev.x);
  const nNext = vec2(dirNext.y.negate(), dirNext.x);
  let miter = nPrev.add(nNext);
  const miterLen = length(miter);
  miter = miterLen.lessThan(float(1e-3)).select(nNext, miter.div(max(miterLen, float(1e-6))));
  const denom = max(float(0.25), abs(dot(miter, nNext)));
  const miterScale = min(float(2.25), float(1).div(denom));
  return miter.mul(miterScale);
}

/**
 * Build ONE rope/chain instance's ribbon `NodeMaterial`. Live uniforms
 * (thickness, taper, colour) are created here and returned for the caller to
 * drive every sync — the same "uniforms out, `.value` per sync" contract
 * `buildLightningMaterial`/`buildCandleFlameMaterial` use.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {number} args.pointsPerSpan - this instance's own per-span sample
 *   count (`rope-chain-subsystem.js`'s own build-time constant, identical to
 *   the value it passed `buildRopeChainRibbonArrays` when baking this same
 *   instance's geometry) — used to derive `dS`, the analytically-exact
 *   arclength step between this vertex and its baked neighbours (Phase 1's
 *   ribbon points are evenly spaced by construction, so this is exact, not
 *   an approximation).
 * @param {*} args.publishTexture - this INSTANCE's OWN 1x1 published spring-
 *   state texture (`rope-chain-subsystem.js`'s own per-instance render
 *   target — see `rope-chain-spring-gpu.js`'s header for why this effect is
 *   one trio per instance, never a shared/pooled texture). Sampled via
 *   `texture()` at a fixed `vec2(0.5, 0.5)` (any UV reads the same, only
 *   texel) rather than a hypothetical "uniform vec4" shortcut, so this stays
 *   structurally consistent with a possible future pooled version.
 * @returns {{material:*, uniforms: {uThicknessPx:*, uTaper:*, uColor:*}}}
 */
export function buildRopeChainMaterial({ THREE, pointsPerSpan, publishTexture }) {
  const { Fn, uniform, attribute, vec2, vec3, vec4, float, clamp, sin, texture, mix, pow, max, abs } = THREE.TSL;

  const uThicknessPx = uniform(float(20));
  const uTaper = uniform(float(0.55));
  // Overwritten immediately by rope-chain-subsystem.js's own hexToRgb01
  // decode of the source's authored colour — this default (neutral white)
  // is never actually seen in practice, matching lightning's own
  // `hexToRgb01` invalid-input fallback.
  const uColor = uniform(vec3(1, 1, 1));

  const prevPos = attribute('prevPos', 'vec3');
  const nextPos = attribute('nextPos', 'vec3');
  // Packed vertex attribute (see this file's own PACKED_ATTRS header).
  const sideUv = attribute('sideUv', 'vec2');
  const side = sideUv.x;
  const uvOffset = sideUv.y; // == s, rope-chain-geometry.js's own arclength fraction

  // Forwarded to the fragment stage for the cheap "rounded" shading touch —
  // same `.toVarying()` idiom lightning-render.js uses for its own raw
  // attribute forwards (side/uvOffset/etc.), not just computed expressions.
  const vSide = side.toVarying('vRopeChainSide');

  const pts = Math.max(2, Math.floor(pointsPerSpan) || 0);
  // BUILD-TIME constant (pointsPerSpan is fixed for this instance's whole
  // lifetime), so this is a plain JS number turned into one float() node,
  // not a live uniform — mirrors lightning's own `maxPointsPerStrand`
  // build-time-constant posture.
  const dS = float(1 / (pts - 1));

  // Sampled ONCE — every read below goes through this SAME node instance
  // (TSL shares one fetch across every reference to it within a stage), so
  // there is exactly one texture fetch here despite `modalAt` being called
  // three times below.
  const springState = texture(publishTexture, vec2(0.5, 0.5));

  /** TSL mirror of `rope-chain-geometry.js#modalDisplacement` (mode 1:
   * `sin(pi*s)`; mode 2: `sin(2*pi*s)`), reading the two live amplitude
   * channels (`springState.x`/`.z`) instead of a JS array. Inherits that
   * function's own tether-point guarantee for free: `sin(n*pi*0)` and
   * `sin(n*pi*1)` are exactly zero for every integer `n`, so this is zero at
   * s=0 and s=1 regardless of the live amplitude — a basis-function
   * identity, not a clamp. */
  const modalAt = (s) =>
    springState.x.mul(sin(float(Math.PI).mul(s))).add(springState.z.mul(sin(float(2 * Math.PI).mul(s))));

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  // See this file's own module header, "DEPTH TEST / DEPTH WRITE — VERIFIED,
  // NOT GUESSED" — every material in this renderer sets these two false;
  // there is no alternative "ordinary opaque prop" convention to switch to.
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  material.positionNode = Fn(() => {
    const cur = attribute('position', 'vec3');

    const sCur = uvOffset;
    const sPrev = clamp(sCur.sub(dS), float(0), float(1));
    const sNext = clamp(sCur.add(dS), float(0), float(1));

    // Step 1 — the BASE tangent/normal from the BAKED (sag-only) neighbours.
    const normal = buildRopeChainMiterNormal(THREE.TSL, cur.xy, prevPos.xy, nextPos.xy);

    // Step 2 — displace all three curve points by their OWN modal term
    // along that one shared base normal.
    const curDisplaced = cur.xy.add(normal.mul(modalAt(sCur)));
    const prevDisplaced = prevPos.xy.add(normal.mul(modalAt(sPrev)));
    const nextDisplaced = nextPos.xy.add(normal.mul(modalAt(sNext)));

    // Step 3 — the FINAL ribbon-expansion normal, from the DISPLACED points.
    const finalNormal = buildRopeChainMiterNormal(THREE.TSL, curDisplaced, prevDisplaced, nextDisplaced);

    // WIDTH/TAPER — symmetric around the span's MIDPOINT (distance from
    // s=0.5), not lightning's own one-directional uvOffset taper: a rope is
    // anchored at BOTH ends (unlike a bolt's single growing origin), so
    // "mix toward a narrower value at the ends" (plural, issue #1's own
    // brief) reads as pinching toward BOTH mount points with full width at
    // the belly. JUDGMENT CALL, flagged in the Phase 2 report: V2's own
    // shader-side taper shape is not recoverable from the physics-manager
    // history issue #1 cites (that file owned the CONSTRAINT SOLVER, not
    // rendering), so this is the most literal reading of the brief's own
    // words for a two-anchor span, not a rediscovered V2 behaviour.
    const distFromCentre = abs(sCur.sub(float(0.5))).mul(float(2));
    let taperT = pow(distFromCentre, max(uTaper, float(0.001)));
    taperT = taperT.mul(taperT).mul(float(3).sub(taperT.mul(float(2)))); // cubic smoothstep — lightning's own smooth01 shape
    const taperWidth = mix(float(1), float(0.12), taperT);
    const w = max(uThicknessPx.mul(taperWidth), float(1));

    const world = curDisplaced.add(finalNormal.mul(side).mul(w));
    return vec3(world.x, world.y, float(0));
  })();

  material.fragmentNode = Fn(() => {
    // A cheap "rounded cylinder" look: brighter along the ribbon's
    // centreline, slightly darker toward its edges. Deliberately simple —
    // not a lit-material shading model (out of scope per the Phase 2 brief).
    const edgeDist = abs(vSide);
    const roundedShade = float(1).sub(edgeDist.mul(float(0.35)));
    return vec4(uColor.mul(roundedShade), float(1));
  })();

  return {
    material,
    uniforms: { uThicknessPx, uTaper, uColor },
  };
}

/**
 * Build ONE rope/chain instance's SHADOW ribbon `NodeMaterial` (Phase 3,
 * mythica-machina-press#1) — see this module's own header, "THE SHADOW
 * TWIN", for the full design. A twin mesh sharing the SAME `BufferGeometry`
 * the main ribbon mesh uses (`rope-chain-subsystem.js`'s own header has the
 * "safe to share" reasoning), offset by the sun's throw and scaled per-vertex
 * by `rope-chain-geometry.js#impliedHeightFraction01` so the offset is
 * largest at the anchors and zero at the sag's lowest point.
 *
 * Mirrors `buildRopeChainMaterial`'s own shape/signature closely: same
 * attributes off the same shared geometry, the same miter-join + live-modal-
 * sway curve reconstruction (steps 1-2, so the shadow sways in EXACT
 * lockstep with the rope — it starts from literally the same computation,
 * never a separate copy that could drift), diverging only in:
 *   - an extra per-point offset step, added to curDisplaced/prevDisplaced/
 *     nextDisplaced BEFORE the final ribbon-expansion normal is recomputed
 *     (mirrors why the rope's own live modal sway is added before ITS final
 *     normal: the ribbon cross-section must stay correctly oriented for the
 *     curve it actually ends up tracing);
 *   - a flat, mostly-uniform dark fragment instead of the rope's own
 *     brightness-based "rounded cylinder" touch, with a light ALPHA feather
 *     toward the ribbon edges instead (a softer-edged shadow silhouette).
 *
 * NOT shared with `buildRopeChainMaterial`: the modal-sway formula (`modalAt`)
 * and the width/taper formula are both duplicated here verbatim rather than
 * factored into a second shared helper (only the miter-join got that
 * treatment — see this module's own header). Both are short, plain,
 * non-magic-number formulas (unlike the miter join's degenerate-direction
 * fallback and `1e-6`/`1e-3`/`0.25`/`2.25` constants); the two builders sit
 * one after another in this same file, so a future edit to one is easy to
 * spot-check against the other. `modalAt` also cannot literally be SHARED
 * (not just duplicated) without adding an indirection layer, because each
 * material must sample its OWN `texture()` node — TSL graphs are built once
 * per material, not shared across two — so a factory-of-a-closure would
 * trade a few duplicated lines for a layer of indirection around a 2-line
 * body (the same "TSL has no shared closure worth extracting for two call
 * sites this small" call `rope-chain-spring-gpu.js`'s own per-channel spring
 * step already makes).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {number} args.pointsPerSpan - SAME value the caller passed
 *   `buildRopeChainMaterial` for this instance (both materials read the
 *   identical shared geometry, so `dS` must agree).
 * @param {*} args.publishTexture - this INSTANCE's OWN published spring-state
 *   texture — the SAME texture `buildRopeChainMaterial` was given for this
 *   instance, so both materials sample the identical live sway.
 * @returns {{material:*, uniforms: {uThicknessPx:*, uTaper:*, uStrength01:*, uCastOffsetPx:*, uPenumbraPx:*}}}
 */
export function buildRopeChainShadowMaterial({ THREE, pointsPerSpan, publishTexture }) {
  const { Fn, uniform, attribute, vec2, vec3, vec4, float, clamp, sin, texture, mix, pow, max, abs, smoothstep } =
    THREE.TSL;

  // Mirrors buildRopeChainMaterial's own uThicknessPx/uTaper defaults —
  // rope-chain-subsystem.js#applyRenderUniforms drives both this material's
  // AND the main one's to the SAME values every sync, so the shadow is
  // always exactly as wide as the rope that casts it (own uniform objects,
  // mirrored VALUES — not a shared uniform node — matching this codebase's
  // established "own uniform bag per material" convention, e.g.
  // vegetation's canopy/shadow twin each get their own full uniform set).
  const uThicknessPx = uniform(float(20));
  const uTaper = uniform(float(0.55));
  // Pushed every sync by rope-chain-subsystem.js#applyShadowUniforms from
  // this instance's own `shadowHandle.forCaster(...)` result.
  const uStrength01 = uniform(float(0));
  const uCastOffsetPx = uniform(vec2(0, 0));
  // Captured for a possible future soft-shadow phase (a per-fragment blur
  // keyed by penumbra width) — NOT consumed by this phase's fragment shader
  // (this module's own header, "THE SHADOW TWIN": multi-tap penumbra blur is
  // explicitly out of scope this phase). Pushed into a uniform anyway so a
  // later pass has it on hand without a second CPU->GPU wiring pass.
  const uPenumbraPx = uniform(float(0));

  const prevPos = attribute('prevPos', 'vec3');
  const nextPos = attribute('nextPos', 'vec3');
  // Packed vertex attribute (see this file's own PACKED_ATTRS header) — the
  // SAME attribute names as buildRopeChainMaterial reads, off the SAME
  // shared geometry.
  const sideUv = attribute('sideUv', 'vec2');
  const side = sideUv.x;
  const uvOffset = sideUv.y; // == s, rope-chain-geometry.js's own arclength fraction

  // Forwarded to the fragment stage for the edge feather below — same
  // `.toVarying()` idiom the main material uses for its own "rounded" touch,
  // a DIFFERENT varying name (debug/shader-dump clarity; each material
  // compiles its own separate program regardless).
  const vSide = side.toVarying('vRopeChainShadowSide');

  const pts = Math.max(2, Math.floor(pointsPerSpan) || 0);
  const dS = float(1 / (pts - 1));

  // Sampled ONCE, same as buildRopeChainMaterial's own springState — this is
  // a SEPARATE texture() node (each material builds its own graph), but
  // reads the SAME instance's published spring texture, which is what keeps
  // the shadow's sway identical to the rope's, frame for frame.
  const springState = texture(publishTexture, vec2(0.5, 0.5));
  const modalAt = (s) =>
    springState.x.mul(sin(float(Math.PI).mul(s))).add(springState.z.mul(sin(float(2 * Math.PI).mul(s))));

  // rope-chain-geometry.js#impliedHeightFraction01, inlined in TSL — that
  // function's own doc has the physical argument. `1 - parabolicSag(s, 1)`
  // at unit amplitude, i.e. `1 - 4*s*(1-s)`: 1 at the anchors (s=0/1), 0 at
  // the sag's lowest point (s=0.5).
  const heightFractionAt = (s) => float(1).sub(float(4).mul(s).mul(float(1).sub(s)));

  const material = new THREE.NodeMaterial();
  // ⚠️ `transparent = false`, NOT `true` — see this module's own "THE SHADOW
  // TWIN" header, "RENDER ORDER VS. THE TRANSPARENCY QUEUE", for why: THREE's
  // render list partitions objects into an OPAQUE list and a TRANSPARENT list
  // purely by `material.transparent` (confirmed by reading
  // `three/src/renderers/common/RenderList.js#push` directly), and the
  // renderer always finishes the ENTIRE opaque list before starting the
  // transparent one (`Renderer.js`'s own `_renderObjects(opaqueObjects,...)`
  // then `_renderTransparents(transparentObjects,...)`) — `renderOrder` only
  // reorders WITHIN whichever list a material lands in, never across the two.
  // The main rope material is `transparent = false` (an opaque, solid prop —
  // this file's own "DEPTH TEST / DEPTH WRITE" header). A `transparent = true`
  // shadow would therefore ALWAYS draw in a later pass than the rope,
  // regardless of `renderOrder` — the shadow would paint OVER the rope, not
  // under it, the exact opposite of Case 1's intent
  // (`rope-chain-subsystem.js`'s own "THE SHADOW'S RENDER ORDER" header).
  // Staying in the SAME opaque queue as the rope is what lets `renderOrder`
  // actually do its job.
  material.transparent = false;
  // Same "no different convention to switch to" reasoning as the main
  // material — see this module's own "DEPTH TEST / DEPTH WRITE" header.
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // CustomBlending, set to the EXACT factors THREE's own WebGPU backend uses
  // for ordinary non-premultiplied NormalBlending — confirmed by reading
  // `WebGPUPipelineUtils.js#_getBlending` directly, not assumed: `NormalBlending`
  // resolves to color {SrcAlpha, OneMinusSrcAlpha, Add}, alpha {One,
  // OneMinusSrcAlpha, Add}. Reproducing those same six values via
  // `CustomBlending` gives BIT-IDENTICAL blending to ordinary NormalBlending
  // (still "a multiply-darken of whatever ground is beneath it" —
  // vegetation-shadow-subsystem.js's own fragment comment) while being
  // classified as `CustomBlending`, not `NormalBlending` — which is what lets
  // the pipeline enable blending even with `transparent = false`
  // (`WebGPUPipelineUtils.js`'s own gate skips blending ONLY when
  // `material.blending === NormalBlending AND material.transparent === false`;
  // anything else, including an equivalent `CustomBlending`, is not skipped).
  // The SAME "opaque + CustomBlending" shape `buildOcclusionDisc` already
  // uses elsewhere in this codebase (vt-pan-viewer.js) — a different
  // equation (MIN, not Add) for a different purpose, but the identical
  // structural trick, not a novel technique invented here.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  material.positionNode = Fn(() => {
    const cur = attribute('position', 'vec3');

    const sCur = uvOffset;
    const sPrev = clamp(sCur.sub(dS), float(0), float(1));
    const sNext = clamp(sCur.add(dS), float(0), float(1));

    // Steps 1-2 — IDENTICAL to buildRopeChainMaterial's own positionNode:
    // the base tangent/normal from the BAKED (sag-only) neighbours, then
    // displace by the SAME live modal sway sampled from this instance's own
    // published spring texture. This is what makes the shadow sway in exact
    // lockstep with the rope: it is literally the same computation, not a
    // copy that could drift (see this file's own header on why steps 1-2
    // are duplicated rather than shared).
    const normal = buildRopeChainMiterNormal(THREE.TSL, cur.xy, prevPos.xy, nextPos.xy);
    const curDisplaced = cur.xy.add(normal.mul(modalAt(sCur)));
    const prevDisplaced = prevPos.xy.add(normal.mul(modalAt(sPrev)));
    const nextDisplaced = nextPos.xy.add(normal.mul(modalAt(sNext)));

    // NEW STEP — the height-scaled shadow throw, added to all three curve
    // points BEFORE the final ribbon-expansion normal is recomputed. ONE
    // `forCaster()` call per instance per frame
    // (rope-chain-subsystem.js#applyShadowUniforms) is EXACT here, not
    // approximate, because `offsetX`/`offsetY` are provably linear in
    // heightPx for a fixed sun angle — see this module's own header for the
    // citation.
    const curShadow = curDisplaced.add(uCastOffsetPx.mul(heightFractionAt(sCur)));
    const prevShadow = prevDisplaced.add(uCastOffsetPx.mul(heightFractionAt(sPrev)));
    const nextShadow = nextDisplaced.add(uCastOffsetPx.mul(heightFractionAt(sNext)));

    // Step 3 — the FINAL ribbon-expansion normal, from the SHADOW-shifted
    // points (mirrors buildRopeChainMaterial's own step 3, applied to the
    // shadow's own final curve instead of the rope's).
    const finalNormal = buildRopeChainMiterNormal(THREE.TSL, curShadow, prevShadow, nextShadow);

    // WIDTH/TAPER — verbatim copy of buildRopeChainMaterial's own (see that
    // function's own JUDGMENT CALL comment for the symmetric-taper
    // rationale); uThicknessPx/uTaper are driven to the SAME values every
    // sync (rope-chain-subsystem.js#applyRenderUniforms), so the shadow is
    // always exactly as wide as the rope that casts it.
    const distFromCentre = abs(sCur.sub(float(0.5))).mul(float(2));
    let taperT = pow(distFromCentre, max(uTaper, float(0.001)));
    taperT = taperT.mul(taperT).mul(float(3).sub(taperT.mul(float(2))));
    const taperWidth = mix(float(1), float(0.12), taperT);
    const w = max(uThicknessPx.mul(taperWidth), float(1));

    const world = curShadow.add(finalNormal.mul(side).mul(w));
    return vec3(world.x, world.y, float(0));
  })();

  material.fragmentNode = Fn(() => {
    // A LIGHT edge feather — fading ALPHA toward the ribbon's edges instead
    // of the rope's own brightness-based "rounded cylinder" touch, for a
    // softer-edged shadow silhouette rather than a hard cutout at the mesh
    // boundary. JUDGMENT CALL: full strength across the centre 70% of the
    // ribbon's width, smoothly to zero at the very edge — "light," not a
    // heavy gradient across the whole shadow, per the brief.
    const edgeDist = abs(vSide);
    const edgeFeather = float(1).sub(smoothstep(float(0.7), float(1), edgeDist));
    const alpha = uStrength01.mul(edgeFeather);
    return vec4(float(0), float(0), float(0), alpha);
  })();

  return {
    material,
    uniforms: { uThicknessPx, uTaper, uStrength01, uCastOffsetPx, uPenumbraPx },
  };
}
