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
 * every other MSA ribbon). Factored into a local `buildMiterNormal(cur,
 * prev, next)` closure here because THIS effect calls it TWICE per vertex
 * (see "THE MODAL DISPLACEMENT ORDER" below) — lightning only ever needs it
 * once, so it never had reason to extract the shape into its own function.
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
 *      points — `buildMiterNormal(cur, prevPos, nextPos)`.
 *   2. Displace all three points by their OWN modal term along that ONE
 *      shared base normal (`modalAt(s)`, the TSL mirror of
 *      `rope-chain-geometry.js#modalDisplacement`, reading the two live
 *      amplitude channels off the instance's own 1x1 published spring
 *      texture instead of a JS array). Using the CURRENT vertex's normal for
 *      all three neighbours is a deliberate simplification: on this smooth
 *      parabolic+sine curve the perpendicular direction barely changes
 *      across 3 adjacent samples, unlike lightning's jagged fractal path
 *      where per-point normals genuinely differ enough to matter.
 *   3. Re-run `buildMiterNormal` against the DISPLACED points to get the
 *      FINAL ribbon-expansion normal — this is what actually varies as the
 *      rope sways, so the ribbon's cross-section stays correctly oriented
 *      mid-sway instead of being a flat sideways-shifted copy of the rest
 *      shape.
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
 * documented Phase 3 gap, not an oversight — `rope-chain-subsystem.js`'s
 * own header names it).
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
  const {
    Fn,
    uniform,
    attribute,
    vec2,
    vec3,
    vec4,
    float,
    length,
    dot,
    clamp,
    normalize,
    sin,
    texture,
    mix,
    pow,
    max,
    min,
    abs,
  } = THREE.TSL;

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

  /** The miter-join ribbon-expansion normal — `lightning-render.js`'s own
   * `positionNode` technique verbatim (degenerate-direction fallback
   * included), parameterized over which three curve points to build it
   * from. See this file's own "THE MODAL DISPLACEMENT ORDER" header for why
   * it is called twice per vertex here. */
  const buildMiterNormal = (curXY, prevXY, nextXY) => {
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
  };

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
    const normal = buildMiterNormal(cur.xy, prevPos.xy, nextPos.xy);

    // Step 2 — displace all three curve points by their OWN modal term
    // along that one shared base normal.
    const curDisplaced = cur.xy.add(normal.mul(modalAt(sCur)));
    const prevDisplaced = prevPos.xy.add(normal.mul(modalAt(sPrev)));
    const nextDisplaced = nextPos.xy.add(normal.mul(modalAt(sNext)));

    // Step 3 — the FINAL ribbon-expansion normal, from the DISPLACED points.
    const finalNormal = buildMiterNormal(curDisplaced, prevDisplaced, nextDisplaced);

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
