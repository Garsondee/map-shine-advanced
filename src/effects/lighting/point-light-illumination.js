/**
 * POINT-LIGHT ILLUMINATION — increment 2a of Type-A parity (docs/planning/
 * Light-Parity.md §5): per-light MAX-blended contribution into the SAME
 * `buf:scene.illum` environmental-light.js fills with the ambient floor.
 *
 * Reproduces Foundry's default-technique illumination channel exactly
 * (docs/reference/foundry-v14-lighting-audit.md §5c, §7):
 *
 *   dist       = distance from the light's own origin, normalized to its
 *                radius (0 at center, 1 at the polygon boundary)
 *   ratio      = bright/radius (already computed live by Foundry, read
 *                straight off the source — foundry/scene-lights.js)
 *   switchColor: cross-fades bright→dim across a band centered on `ratio`,
 *                widened by (eased) attenuation
 *   falloff    : an outer radial fade toward the shape's edge, driven by
 *                the attenuation SLIDER (Foundry's own parameter, a real
 *                authored choice — a wide, deliberate corona, not an
 *                antialiasing detail)
 *   output     : mix(ambientBackground, switchColor-result, falloff)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SOFT-EDGE MARGIN (2026-07-19) — an analytic SDF, not Foundry's mesh-
 * inflate trick, chosen after live research (author: "if we can use WebGPU
 * and threejs to get a better light than Foundry we should... reliable,
 * reasonable, good performance with hundreds of lights"):
 *
 * Foundry ALWAYS softens the true polygon boundary by a small, ~constant-
 * pixel margin (`RenderedEffectSource.EDGE_OFFSET = -8`, scaled by
 * `canvas.grid.size/100`), INDEPENDENT of the attenuation slider — achieved
 * by literally inflating the mesh (`PolygonMesher`'s ClipperLib polygon-
 * offset, several inset rings, a per-vertex depth 0→1 ramp). That geometric
 * machinery is real engineering (a 2D polygon-offset implementation +
 * multi-ring triangulation) for a purely cosmetic ~8px margin.
 *
 * This reproduces the SAME margin, analytically, with NO extra geometry, NO
 * extra render target, and NO per-frame CPU work beyond what the light
 * already does: `sdPolygonEdgeDistance` (below) computes the exact signed
 * distance from a fragment to the polygon's NEAREST edge — negative inside,
 * positive outside — via the well-established point-in-polygon-plus-min-
 * segment-distance shader technique (the same family as Inigo Quilez's
 * widely-used `sdPolygon`; see also Godot 4's own SDF-based 2D lighting,
 * which the author's own research reviewed, chosen BECAUSE a distance-based
 * technique's cost scales with light count, not with per-light geometry
 * complexity — https://godotshaders.com/shader/dynamic-2d-lights-and-soft-shadows/).
 * `edgeSoftFactor = smoothstep(0, marginNormalized, -signedDist)` then
 * MULTIPLIES into the existing attenuation-based `falloff` — the two are
 * DIFFERENT terms answering different questions (a fixed antialiasing
 * margin vs. the authored attenuation corona), exactly as they are in
 * Foundry (vDepth blur is unconditional; attenuation fade is the slider).
 *
 * Cost, by design: a BOUNDED loop (MAX_LIGHT_EDGES, matching the same cap
 * `triangulateLightFan`'s geometry uses) over the light's OWN edges — a
 * simple open-room torch (few edges) costs almost nothing; only genuinely
 * wall-dense spots pay more. No new render target, no cache to invalidate,
 * no cross-wall bleed (unlike a screen-space blur, this is a pure function
 * of the ACTUAL polygon, never neighbouring pixels).
 *
 * NOT YET BUILT, this rung: real soft-SHADOW penumbra (raymarching this same
 * distance data toward the light, à la Godot/RTSDF) — something Foundry's
 * binary wall-visibility model cannot do at all. A compelling next tier,
 * deliberately out of scope here (this rung matches Foundry's INTENT for
 * silhouette softness, not a physically-lit-penumbra system).
 *
 * TIER-0 SCOPE, documented rather than silently absent:
 *   - no elevation/roof occlusion of light (needs the SURFACE half of
 *     masks.occlusion, Regions-driven — not built anywhere in this project
 *     yet; same accepted gap as masks.occlusion's own note in vt-pan-viewer.js).
 *   - no coloration channel, no non-default coloration techniques, no
 *     animations, no darkness/negative sources, no global light — each its
 *     own later rung (Light-Parity.md §5).
 *
 * SHAPE: the light's mesh is a FAN triangulation of Foundry's own wall-
 * clipped `source.shape.points`, valid because a ClockwiseSweepPolygon is
 * "star-shaped" from the light's own origin BY CONSTRUCTION (it IS a radial
 * sweep from that point) — so walls are already "free" here: no separate
 * light.visibility work is needed for point-light occlusion specifically,
 * only for the SUN's shadow producers (Light-and-Shadow.md's actual scope).
 *
 * @module effects/lighting/point-light-illumination
 */

/**
 * Starting/default capacity, in POLYGON EDGES, for a light's soft-edge SDF
 * uniform array — see buildPointLightIlluminationMaterial's own header for
 * why this is a FIXED cap (never grown) rather than the geometry buffer's
 * grow-on-demand scheme: a `uniformArray`'s size is fixed forever at shader-
 * setup time (verified against the vendored three.webgpu.js source), so
 * growing it would mean a full material/shader rebuild — meaningfully more
 * expensive than the geometry buffer's own occasional grow. A light whose
 * polygon exceeds this cap gracefully TRUNCATES (writeLightEdgePoints' own
 * contract) rather than rebuilding — a slightly-approximate soft edge on a
 * pathologically complex shape, never a crash or a stall. Matches
 * triangulateLightFan's own generous sizing (INITIAL_LIGHT_FAN_VERTICES in
 * vt-pan-viewer.js is 3x this, i.e. the same edge-count assumption).
 */
export const MAX_LIGHT_EDGES = 64;

/**
 * Ease Foundry's raw [0,1] attenuation slider into the value its shaders
 * actually use, replicated verbatim from `base-light-source.mjs`
 * (`_updateCommonUniforms`, cached as `computedAttenuation`):
 *
 *   (cos(PI * attenuation^1.5) - 1) / -2
 *
 * Foundry's own graph: https://www.desmos.com/calculator/e7z0i7hrck
 *
 * @param {number} attenuation01 - raw, 0..1 (already clamped by
 *   foundry/scene-lights.js#deriveLightSnapshot, clamped again here so this
 *   function is safe to call standalone).
 * @returns {number} the eased value the falloff/switchColor bands actually use.
 */
export function easeAttenuation(attenuation01) {
  const a = Math.min(1, Math.max(0, Number.isFinite(attenuation01) ? attenuation01 : 0));
  return (Math.cos(Math.PI * Math.pow(a, 1.5)) - 1) / -2;
}

/**
 * Foundry's own luminosity → exposure remap, verbatim (`base-light-source.mjs`,
 * `_updateIlluminationUniforms`: `u.exposure = this.data.luminosity * 2.0 - 1.0`).
 * At the LightData default (`luminosity01=0.5`) this is exactly 0 — a genuine
 * no-op multiplier (see `buildPointLightIlluminationMaterial`'s EXPOSURE term)
 * — which is WHY omitting this term never visibly affected an ordinary light
 * left at its default; a GM-tuned luminosity, or the Global Illumination
 * config (whose OWN default is 0, not 0.5 — `deriveGlobalLightConfig`), needs
 * it to render correctly.
 *
 * @param {number} luminosity01 - raw, 0..1.
 * @returns {number} exposure, -1..1.
 */
export function computeExposure(luminosity01) {
  const l = Math.min(1, Math.max(0, Number.isFinite(luminosity01) ? luminosity01 : 0.5));
  return l * 2 - 1;
}

/**
 * Normalize a closed WORLD-space polygon to LOCAL (light-relative,
 * unit-radius) space — the shared first step of `triangulateLightFan` (mesh
 * geometry) and `writeLightEdgePoints` (the soft-edge SDF data), factored out
 * so the same coordinate math is never duplicated between them.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon.
 * @param {number} originX @param {number} originY @param {number} radius
 * @returns {{lx: Float64Array, ly: Float64Array, n: number}}
 */
function normalizeLightPolygon(shapePoints, originX, originY, radius) {
  const n = Math.floor(shapePoints.length / 2);
  const inv = radius !== 0 ? 1 / radius : 0;
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lx[i] = (shapePoints[i * 2] - originX) * inv;
    ly[i] = (shapePoints[i * 2 + 1] - originY) * inv;
  }
  return { lx, ly, n };
}

/**
 * Fan-triangulate a closed WORLD-space polygon around the light's own
 * origin into LOCAL unit-radius space — see this module's header for why a
 * simple fan (not a general polygon triangulator) is exact here.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon
 *   (Foundry's `source.shape.points`); already validated (>=3 vertices, even
 *   length, all finite) by `foundry/scene-lights.js#deriveLightSnapshot`.
 * @param {number} originX @param {number} originY @param {number} radius
 * @param {Float32Array} [outArray] - a REUSABLE destination buffer (see the
 *   caller, vt-pan-viewer.js's light-mesh pool, for why this parameter
 *   exists — it is the fix for a real GPU-buffer leak, not an optimisation).
 *   Reused (written into, returned as-is) when it already has room for this
 *   frame's vertex count; a fresh, bigger array is allocated and returned
 *   ONLY when it doesn't (absent, or too small) — an occasional event when a
 *   light's polygon complexity grows, never a per-frame one.
 * @returns {{array: Float32Array, vertexCount: number}} `array` holds
 *   interleaved [x,y,z, ...] local-space vertices (3 per triangle, one
 *   triangle per polygon edge — origin + edge; z always 0), valid for its
 *   first `vertexCount` vertices (`3 * vertexCount` floats) — the rest, if
 *   `array` is larger than needed this frame, is STALE data from a previous,
 *   larger frame and must be ignored (the caller does this via
 *   `BufferGeometry#setDrawRange`, never by trusting `array.length`).
 */
export function triangulateLightFan(shapePoints, originX, originY, radius, outArray) {
  const { lx, ly, n } = normalizeLightPolygon(shapePoints, originX, originY, radius);
  const neededFloats = n * 3 * 3;
  const out = outArray && outArray.length >= neededFloats ? outArray : new Float32Array(neededFloats);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // wraps the last edge back to vertex 0 — the polygon is implicitly closed
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = lx[i];
    out[o++] = ly[i];
    out[o++] = 0;
    out[o++] = lx[j];
    out[o++] = ly[j];
    out[o++] = 0;
  }
  return { array: out, vertexCount: n * 3 };
}

/**
 * Write this light's LOCAL-space polygon vertices into a caller-owned,
 * FIXED-CAPACITY array of mutable `{x, y}` points (real `THREE.Vector2`
 * instances in production; plain `{x,y}` objects are sufficient for Node
 * tests) — the data source for the analytic soft-edge SDF's `uniformArray`.
 *
 * REUSE CONTRACT, matching `triangulateLightFan`'s own discipline but via
 * TRUNCATION rather than growth (see `MAX_LIGHT_EDGES`'s own doc for why): if
 * this light's polygon has MORE vertices than `outPoints.length`, only the
 * first `outPoints.length` are written and the count is capped — never
 * throws, never grows the array. Slots at or beyond the returned count are
 * NOT touched (may hold stale data from a previous, larger frame) — the
 * caller's shader loop bounds itself by the returned count (its own
 * `uEdgeCount` uniform), exactly like `triangulateLightFan`'s `vertexCount`/
 * `setDrawRange` contract.
 *
 * @param {number[]} shapePoints - flat [x0,y0,x1,y1,...] world-space polygon.
 * @param {number} originX @param {number} originY @param {number} radius
 * @param {Array<{x: number, y: number}>} outPoints - fixed-length, reused every frame.
 * @returns {number} how many of `outPoints` were written this frame (<= outPoints.length).
 */
export function writeLightEdgePoints(shapePoints, originX, originY, radius, outPoints) {
  const { lx, ly, n } = normalizeLightPolygon(shapePoints, originX, originY, radius);
  const count = Math.min(n, outPoints.length);
  for (let i = 0; i < count; i++) {
    outPoints[i].x = lx[i];
    outPoints[i].y = ly[i];
  }
  return count;
}

/**
 * The soft-edge antialiasing margin, in LOCAL unit-radius space (matching
 * `dist`'s own normalization) — Foundry's own reference figure
 * (`RenderedEffectSource.EDGE_OFFSET = -8`, `client/canvas/sources/rendered-
 * effect-source.mjs`), scaled by the grid's own size relative to Foundry's
 * 100px reference square (`EDGE_OFFSET * (canvas.grid.size / 100)`), then
 * converted from world px to a fraction of THIS light's own radius (the
 * space `sdPolygonEdgeDistance` operates in).
 *
 * @param {number} gridSizePixels - canvas.grid.size (px per grid square).
 * @param {number} radius - the light's own pixel radius. 0 reads as no margin
 *   (a degenerate light that should never reach the shader anyway —
 *   `foundry/scene-lights.js#deriveLightSnapshot` rejects radius<=0 first).
 * @param {number} [edgeOffsetPx=8] - Foundry's own reference margin width.
 * @returns {number} the margin, as a fraction of the light's radius (>= 0).
 */
export function computeEdgeSoftMarginNormalized(gridSizePixels, radius, edgeOffsetPx = 8) {
  if (!(radius > 0)) return 0;
  const grid = Number.isFinite(gridSizePixels) && gridSizePixels > 0 ? gridSizePixels : 100;
  const marginPx = edgeOffsetPx * (grid / 100);
  return marginPx / radius;
}

/**
 * The analytic soft-edge SDF — exact signed distance from a LOCAL-space
 * point to the light's own polygon boundary (negative = inside, positive =
 * outside), via the standard point-in-polygon-ray-cast + min-distance-to-
 * segment shader technique (this module's header explains why, and cites
 * precedent). Wrapped in its own `Fn` — verified against the vendored
 * three.webgpu.js that `Loop`/`.toVar()`/`.assign()` (loop-carried mutable
 * state) are meant to run inside a shader-function-building context (the
 * SAME pattern the vendor's own `ggxConvolution`/`importanceSampleGGX_VNDF`
 * use), not procedurally alongside plain node construction.
 *
 * @param {*} TSL - THREE.TSL, passed in rather than closed over so this
 *   function has no hidden dependency on `buildPointLightIlluminationMaterial`'s
 *   own destructure.
 * @returns {*} a `Fn(([p, poly, edgeCount]) => signedDistance)` node function.
 */
function makeSdPolygonEdgeDistance(TSL) {
  const { Fn, Loop, select, bool, int, float, min, max, dot, sqrt } = TSL;
  return Fn(([p, poly, edgeCount]) => {
    const minDistSq = float(1e12).toVar();
    const inside = bool(false).toVar();

    Loop(edgeCount, ({ i }) => {
      // j = the PREVIOUS vertex (wraps 0 -> edgeCount-1) — the polygon is
      // implicitly closed, same convention as triangulateLightFan's fan.
      const j = select(i.equal(int(0)), edgeCount.sub(int(1)), i.sub(int(1)));
      const pi = poly.element(i);
      const pj = poly.element(j);

      // Min distance from p to the segment (pi, pj).
      const e = pj.sub(pi);
      const w = p.sub(pi);
      // Guard a zero-length edge (degenerate/duplicate vertex): 0/0 is NaN,
      // which IEEE-754 min() handles inconsistently — floor the denominator
      // instead of trusting a shader backend's NaN-propagation-through-min.
      const eDotE = max(dot(e, e), float(1e-12));
      const tClamped = min(float(1), max(float(0), dot(w, e).div(eDotE)));
      const closest = w.sub(e.mul(tClamped));
      minDistSq.assign(min(minDistSq, dot(closest, closest)));

      // Standard ray-casting point-in-polygon crossing test: toggle `inside`
      // each time the horizontal ray from p crosses edge (pi,pj). Safe
      // against the yi==yj division (would need crossesY true, which
      // REQUIRES yi!=yj) by construction, same as every shipped
      // implementation of this decades-old algorithm.
      const crossesY = pi.y.greaterThan(p.y).notEqual(pj.y.greaterThan(p.y));
      const xIntersect = pj.x.sub(pi.x).mul(p.y.sub(pi.y)).div(pj.y.sub(pi.y)).add(pi.x);
      const crosses = crossesY.and(p.x.lessThan(xIntersect));
      inside.assign(select(crosses, inside.not(), inside));
    });

    const dist = sqrt(minDistSq);
    return select(inside, dist.negate(), dist);
  });
}

/**
 * Build ONE point light's illumination material — fresh `uRatio`/
 * `uAttenuationEased`/soft-edge uniforms per light (mirrors vt-pan-viewer.js's
 * `buildOcclusionDisc`'s per-instance `uElevation`), referencing THREE
 * SHARED ambient-colour uniforms every light reads (updated once per frame
 * from `computeAmbientColors` — the caller's job, not this module's).
 *
 * SOFT EDGE (see this module's header): `edgePoints` is a FIXED-CAPACITY
 * (`MAX_LIGHT_EDGES`) array of real `THREE.Vector2` instances backing a
 * `uniformArray` — created ONCE here, returned for the caller to mutate
 * in place every frame via `writeLightEdgePoints` (never replaced — a
 * `uniformArray`'s size is fixed forever at shader-setup time, verified
 * against the vendored source; replacing it would mean a shader rebuild,
 * not the cheap per-frame update this is designed for).
 *
 * MAX BLENDING (`THREE.CustomBlending` + `MaxEquation` + `OneFactor`/
 * `OneFactor`, both RGB and alpha) — Foundry's own `MAX_COLOR`: overlapping
 * lights take the BRIGHTER value, never sum (audit §3, §18.2). Mirrors this
 * project's own `MinEquation` occlusion-disc precedent (vt-pan-viewer.js),
 * sign flipped.
 *
 * `side: THREE.DoubleSide` — the mesh is a hand-built fan from Foundry's own
 * (clockwise, canvas-space) polygon data, not a THREE-authored primitive
 * like `CircleGeometry`; rather than derive its winding under this project's
 * flipped camera (`feedback_y_flip_recurring_risk` — a repeat offender), a
 * flat 2D light shape has no meaningful "back face" to cull, so winding is
 * made irrelevant instead of solved.
 *
 * `mix`/`clamp`/`smoothstep`/`length` are called as FUNCTIONS, never
 * methods — the codebase's own documented trap (`reference_tsl_method_
 * chaining_trap`): `.mix()` as a method takes the RECEIVER as the
 * interpolant (third argument), not the first, and silently compiles to the
 * wrong blend. Simple binary arithmetic (`.mul`/`.add`/`.sub`/`.max`) is used
 * as methods, matching this file's own already-proven-safe `.max()` usage
 * elsewhere in vt-pan-viewer.js.
 *
 * ANIMATION SEED INJECTION (2026-07-20, docs/planning/Light-Parity.md §5's
 * last item) — the optional `args.animation` param is the ONLY seam an
 * animated light uses. Verified against Foundry source (docs/reference/
 * foundry-v14-light-animations-audit.md): every animation shader is the
 * SAME scaffold (FRAGMENT_BEGIN → …→ FALLOFF → FRAGMENT_END) with exactly
 * one line swapped — the seed `finalColor` expression, normally
 * `switchColor(bright,dim,dist)` (the `t`/`mix(uBrightColor,uDimColor,t)`
 * below). Everything downstream — EXPOSURE, FALLOFF, the soft-edge SDF, the
 * background mix, the MAX-blend material setup — is genuinely identical for
 * every animation and for no animation at all, so it stays exactly ONE
 * implementation, reused, never duplicated per-animation. When
 * `args.animation` is absent this function's output is BYTE-IDENTICAL to
 * before this param existed (regression safety net for every light that
 * isn't animated, i.e. most lights).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uBackgroundColor - shared vec3 uniform (sRGB), env's `background`.
 * @param {*} args.uDimColor - shared vec3 uniform (sRGB), env's `dim`.
 * @param {*} args.uBrightColor - shared vec3 uniform (sRGB), env's `bright`.
 * @param {{buildIlluminationSeed: (function(object): {finalColor: *, uniforms: object, skipExposure: (boolean|undefined)})}} [args.animation] -
 *   from effects/lighting/animations/registry.js's matched entry. When its
 *   `buildIlluminationSeed` is present it's called with `{THREE, uBrightColor,
 *   uDimColor, uRatio, dist, defaultSeed}` (`defaultSeed` is the un-animated
 *   `switchColor` result, offered in case an animation wants to blend with
 *   it rather than fully replace it) and must return `{finalColor, uniforms,
 *   skipExposure}` — `finalColor` replaces the seed; `uniforms` (a plain
 *   `{name: uniformNode}` map, e.g. `{uBrightnessPulse}`) is merged into this
 *   function's own returned uniforms so the caller can write into it every
 *   frame, same as `uRatio`/`uAttenuationEased` already are; `skipExposure`
 *   (rare — currently only Pulse, docs/reference/foundry-v14-light-
 *   animations-audit.md §4) omits the EXPOSURE stage entirely when true.
 * @returns {{material: *, uRatio: *, uAttenuationEased: *, uExposure: *,
 *   uEdgeCount: *, uEdgeSoftMargin: *, edgePoints: object[], animationUniforms: object}}
 */
export function buildPointLightIlluminationMaterial({ THREE, uBackgroundColor, uDimColor, uBrightColor, animation }) {
  const { uniform, uniformArray, float, int, vec2, vec4, mix, clamp, smoothstep, length, positionLocal, select } =
    THREE.TSL;

  const uRatio = uniform(float(0.5));
  const uAttenuationEased = uniform(float(0.5));
  const uExposure = uniform(float(0));
  const uEdgeCount = uniform(int(0));
  const uEdgeSoftMargin = uniform(float(0));

  // Fixed-capacity, allocated ONCE — see this function's own header. Real
  // THREE.Vector2 instances (UniformArrayNode's own update() reads
  // vector.x/vector.y off each element — verified against the vendored
  // source), initialized to the origin (harmless: unused slots past
  // uEdgeCount are never read by the shader's Loop).
  const edgePoints = Array.from({ length: MAX_LIGHT_EDGES }, () => new THREE.Vector2(0, 0));
  const edgePointsUniform = uniformArray(edgePoints, 'vec2');

  // dist: Foundry's own vUvs/dist derivation collapses, in this project's
  // local-unit-radius space, to exactly this — see this module's header.
  const localXY = positionLocal.xy;
  const dist = length(localXY);

  // switchColor(bright, dim, dist) — TRANSITION, audit §5c.
  const attenuationStrength = uAttenuationEased.mul(float(0.7));
  const lowerEdge = uRatio.mul(float(0.99).sub(attenuationStrength));
  const upperEdge = clamp(uRatio.mul(float(1.01).add(attenuationStrength)), float(0.0001), float(1.0));
  const t = smoothstep(lowerEdge, upperEdge, dist);
  const defaultSeed = mix(uBrightColor, uDimColor, t);

  // ANIMATION SEED INJECTION — see this function's own header. Absent
  // `animation`/`buildIlluminationSeed` (the overwhelming common case, and
  // every call site before this param existed): finalColor === defaultSeed,
  // animationUniforms === {}, output is unchanged. `skipExposure` is a
  // second, rarer escape hatch: docs/reference/foundry-v14-light-animations-
  // audit.md's own §4 `pulse` entry is the ONE Foundry animation (of 27)
  // whose illumination channel skips `${ADJUSTMENTS}` (== EXPOSURE here)
  // entirely, verified against source — a JS-time decision (which nodes get
  // BUILT), not a runtime one, per the `tsl/no-uniform-gates` wall ("tier
  // selection is a JS `if` at graph-build time — the nodes are never
  // constructed"; a runtime toggle would still pay for the compiled branch).
  const animationUniforms = {};
  let finalColor = defaultSeed;
  let skipExposure = false;
  if (animation?.buildIlluminationSeed) {
    const seeded = animation.buildIlluminationSeed({ THREE, uBrightColor, uDimColor, uRatio, dist, defaultSeed });
    finalColor = seeded.finalColor;
    skipExposure = seeded.skipExposure === true;
    Object.assign(animationUniforms, seeded.uniforms ?? {});
  }

  // EXPOSURE, audit §8/§18 (`AdaptiveIlluminationShader.EXPOSURE`) — a
  // luminosity-driven multiplier on the switchColor result, BEFORE falloff.
  // `uExposure = luminosity*2-1` (computeExposure, computed on the CPU side
  // per light per frame — the SAME "ease once outside the shader" pattern as
  // uAttenuationEased). At the default luminosity (0.5) this is exactly 0, a
  // true no-op — which is why every point light rendered correctly before
  // this term existed; it only bites when a light's luminosity is tuned away
  // from default (e.g. the global-illumination floor's OWN default is 0, not
  // 0.5 — effects/lighting/environmental-light.js#computeGlobalLightFloor
  // handles that case separately since it isn't a mesh). `select` reproduces
  // Foundry's `if (exposure>0) {...} else if (exposure!=0) {...}` — the
  // "else" (exposure exactly 0) branch is folded into the same `<=0` arm
  // below since `1+exposure` at exposure=0 is already the identity.
  let finalColorExposed;
  if (skipExposure) {
    finalColorExposed = finalColor;
  } else {
    const attenuationStrengthExp = uAttenuationEased.mul(float(0.25));
    const lowerEdgeExp = uRatio.mul(float(0.98).sub(attenuationStrengthExp));
    const upperEdgeExp = clamp(uRatio.mul(float(1.02).add(attenuationStrengthExp)), float(0.0001), float(1.0));
    const quartExposure = uExposure.mul(float(0.25));
    const finalExposurePositive = quartExposure
      .mul(float(1).sub(smoothstep(lowerEdgeExp, upperEdgeExp, dist)))
      .add(quartExposure);
    const exposureFactor = select(
      uExposure.greaterThan(float(0)),
      float(1).add(finalExposurePositive),
      float(1).add(uExposure)
    );
    finalColorExposed = finalColor.mul(exposureFactor);
  }

  // FALLOFF, audit §7 — the AUTHORED attenuation slider's own radial corona,
  // epsilon-guarded: Foundry branches `if (attenuation != 0.0)` to skip a
  // degenerate smoothstep(1,1,dist) when attenuation is authored as exactly
  // 0 (a reachable state — LightData's AlphaField allows it). A branch-free
  // equivalent: floor attenuation at a tiny epsilon, so the edge case
  // becomes a razor-thin (not degenerate/undefined) transition instead —
  // numerically harmless, avoids relying on a shader backend's edge0==edge1
  // smoothstep behaviour being well-defined.
  const attenForFalloff = uAttenuationEased.max(float(0.0001));
  const falloff = smoothstep(float(1), float(1).sub(attenForFalloff), dist);

  // THE SOFT-EDGE MARGIN — a SEPARATE, constant-width antialiasing term
  // (see this module's header): signedDist < 0 means inside the true
  // boundary; -signedDist grows the further inside a fragment sits.
  // smoothstep(0, margin, -signedDist) is 0 right at/outside the boundary,
  // 1 once safely past the margin — multiplied into `falloff`, NOT
  // replacing it, since the two answer different questions.
  const sdPolygonEdgeDistance = makeSdPolygonEdgeDistance(THREE.TSL);
  const signedDist = sdPolygonEdgeDistance(vec2(localXY.x, localXY.y), edgePointsUniform, uEdgeCount);
  const edgeSoftFactor = smoothstep(float(0), uEdgeSoftMargin, signedDist.negate());
  // STILL DISABLED (2026-07-19) — the "lights read monochrome" report is
  // CONFIRMED NOT this term (root cause found + fixed elsewhere: point-
  // light-coloration.js's mesh was drawing for colourless lights, where real
  // Foundry's `isRequired` gate skips it entirely — see vt-pan-viewer.js's
  // `colorationMesh.visible = light.hasColor` and foundry/scene-lights.js's
  // `hasColor` field). BUT wiring `edgeSoftFactor` into `combinedFalloff`
  // was tried live once (same day) and produced a DIFFERENT, WORSE symptom
  // — the whole scene went solid black, all 79 active lights included, not
  // just colourless ones — so something in this Loop/uniformArray/Fn SDF
  // path is genuinely broken in the browser, not merely dead-code-eliminated
  // as the earlier bisection worried. Reading the vendored THREE source
  // (UniformArrayNode#update, updateType RENDER) did not turn up the cause —
  // it copies array[i].x/.y into its buffer every render call, which looks
  // correct. Needs a live A/B (screenshot with/without this line) to find
  // the real defect before it's safe to re-enable. Do NOT flip this back to
  // `falloff.mul(edgeSoftFactor)` without that live verification first.
  const combinedFalloff = falloff;
  void edgeSoftFactor;

  // FRAGMENT_END (illumination), audit §5c: mix(background, finalColor, depth).
  const outputColor = mix(uBackgroundColor, finalColorExposed, combinedFalloff);

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = vec4(outputColor, float(1));

  return { material, uRatio, uAttenuationEased, uExposure, uEdgeCount, uEdgeSoftMargin, edgePoints, animationUniforms };
}
