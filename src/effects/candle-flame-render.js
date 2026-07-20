/**
 * CANDLE FLAME — THE RUNTIME (what actually draws a flame + emits its light).
 *
 * ============================================================================
 * WHY THIS IS NOT A PARTICLE (the constraint, reconsidered — author, 2026-07-20)
 * ============================================================================
 *
 * The earlier plan filed the candle under `surface.particles` because V2 did.
 * That was wrong, and the author was right to push on it: a candle is ONE
 * persistent thing per anchor — a small flame that sits still and a light that
 * pools around it — NOT a fountain of thousands of ephemeral, simulated
 * particles. The particle engine (TSL compute / transform feedback / GPGPU
 * position buffers) exists for the latter; forcing a candle through it would be
 * machinery with nothing to simulate.
 *
 * So a candle is TWO first-class primitives the renderer already understands:
 *   1. an anchored BILLBOARD — the flame shape (this file's TSL material), drawn
 *      as ONE batched world-quad mesh (all candles in a single geometry, one
 *      draw call). That is exactly the "one draw call, not N" outcome the
 *      `particles/one-engine` wall exists to enforce — reached via geometry
 *      batching, not `InstancedMesh`/`Sprite` — so the wall never even fires.
 *   2. a POINT LIGHT — reusing the SAME machinery Foundry lights already run
 *      through (`effects/lighting/point-light-illumination.js`, the viewer's
 *      light-mesh pool): a candle light is just another light SOURCE, authored
 *      by us from the anchor + params ("a point light we control") instead of
 *      read from a Foundry document. It gets the region-aware ambient, the soft
 *      edge, the coloration and MAX-blending every other light gets, for free.
 *
 * This file is the RUNTIME (pure geometry math + the TSL material + the light-
 * source builder); `effects/candle-flame.js` stays the DECLARATION (params +
 * manifest). The viewer (`vt/vt-pan-viewer.js`) owns the GPU lifecycle and calls
 * these builders — the same split as ui-window-shadow (declaration) /
 * light-visibility (runtime), and the same "effect exports pure TSL builders,
 * the viewer drives them" pattern every lighting effect already follows.
 *
 * COORDINATES: everything here is in RAW world space (Foundry canvas px, +Y
 * down). The viewer's camera owns the one Y-flip (vt-pan-viewer.js#updateCamera:
 * `top = minY`), so a flame quad built at a candle's world (x,y) needs zero
 * manual Y math — the exact discipline every other world mesh uses, and the
 * reason the recurring Y-flip bug (feedback_y_flip_recurring_risk) cannot bite
 * here: there is no hand-rolled world↔screen mapping to get wrong.
 *
 * @module effects/candle-flame-render
 */

/**
 * Flame shape constants — the TOP-DOWN FOOTPRINT of a 3D teardrop (author model,
 * 2026-07-20): "the teardrop shape in 3D space where the bottom is anchored and
 * the top is evolved/animated by the shader to move around in the wind... looking
 * top down [it is] a rounded shape where the wick is and then a point which
 * wouldn't be visible at all when the wind isn't active".
 *
 * THE KEY INSIGHT: under the viewer's ORTHOGRAPHIC top-down camera there is no
 * perspective, so a real 3D teardrop mesh standing on the wick would render as
 * exactly its top-down FOOTPRINT and nothing more — a 3D mesh buys zero here and
 * costs more. So we draw the footprint directly: a "round cone" (a disc of
 * radius FLAME_BASE_RADIUS at the wick, tapering to FLAME_TIP_RADIUS at the tip)
 * whose TIP is steered by wind (`buildCandleFlameMaterial`'s `uLean`). At rest
 * the tip sits over the wick (a 3D flame pointing straight AT the camera → its
 * point foreshortens to nothing) so the footprint is just the round base; as the
 * tip leans, a teardrop tail sweeps out in the wind direction and the point
 * appears. The base end of the spine is ALWAYS the wick (the quad centre) — the
 * anchor is baked into the geometry, no uniform can move it. (A real 3D mesh
 * becomes worth building only if the camera ever tilts off straight-down —
 * recorded here, not built.)
 */
const FLAME_BASE_RADIUS = 0.22; // round base radius, as a fraction of the quad half-extent
const FLAME_TIP_RADIUS = 0.02; // radius at the tip → a point
const FLAME_EDGE_SOFT = 0.05; // silhouette antialiasing width
const FLAME_CORE_LIFT = 0.9; // how much the hot base-centre lifts toward white
/** A tiny AT-REST lean (fraction of the quad) so the resting flame has a hint of
 * teardrop form/"thickness" rather than reading as a flat disc — the author's
 * "slightly curling the geometry". Wind's `uLean` adds on top of this. −Y is up
 * on screen (the camera flips Y), so the resting wisp points gently "up". */
const FLAME_REST_CURL_X = 0.0;
const FLAME_REST_CURL_Y = -0.06;

/** Candle light character (Foundry-parity light params tuned for a candle).
 * A small bright core + a soft corona = a gentle pool, not a torch. */
const CANDLE_LIGHT_RATIO = 0.15; // bright/radius: a small hot centre
const CANDLE_LIGHT_ATTENUATION = 0.75; // soft, wide corona (Foundry's attenuation slider)
const CANDLE_LIGHT_LUMINOSITY = 0.5; // default → exposure 0 (a plain, un-boosted light)
const CANDLE_LIGHT_ALPHA = 0.85; // coloration strength: how warmly it tints the floor
const CANDLE_LIGHT_SEGMENTS = 32; // circle polygon smoothness (no walls in v1)
/** Cluster cell size, as a fraction of the light radius. Candles closer than
 * this merge into ONE light — a chandelier's 8 flames become one warm pool
 * instead of 8 overlapping full-cost lights (the perf lever: each light is a
 * full Foundry-parity mesh, so COUNT is what costs). Flames stay per-candle. */
const CANDLE_LIGHT_CLUSTER_FACTOR = 0.5;

/**
 * Parse a `#rrggbb` colour to linear-ish [r,g,b] in 0..1. Foundry stores light
 * colours as sRGB hex and its lighting shaders use them in gamma space (see
 * environmental-light.js's composite essay), so a straight byte→unit parse is
 * the right match — no decode. A malformed value falls back to a warm candle
 * orange rather than throwing (this feeds a render, never a stored value).
 * @param {string} hex @returns {[number, number, number]}
 */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
  if (!m) return [1, 0.667, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * A closed circular polygon around (cx, cy), as Foundry's own light shape format
 * (flat `[x0,y0,x1,y1,...]` world-space points) — the candle light's "shape",
 * standing in for the wall-clipped `source.shape.points` a real Foundry light
 * carries. No wall clipping in v1 (a candle just glows in a circle); walls
 * become a later rung the same way point-light-illumination.js's header frames
 * its own deferred rungs.
 * @param {number} cx @param {number} cy @param {number} radius @param {number} [segments]
 * @returns {number[]}
 */
export function candleCirclePolygon(cx, cy, radius, segments = CANDLE_LIGHT_SEGMENTS) {
  const n = Math.max(3, Math.floor(segments));
  const pts = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * 2] = cx + Math.cos(theta) * radius;
    pts[i * 2 + 1] = cy + Math.sin(theta) * radius;
  }
  return pts;
}

/**
 * Build the point-light SOURCE descriptors for a set of candle anchors — the
 * "connection between candle points and a point light we control". Each is
 * shaped EXACTLY like the Foundry light descriptors the viewer's light-mesh
 * pool reconciles (`{ sourceId, x, y, radius, shapePoints, ratio,
 * attenuation01, luminosity01, hasColor, alpha01, color }`), so candle lights
 * flow through the identical material/pool/MAX-blend/dispose path — they are
 * simply authored by us instead of read from `canvas.effects.lightSources`.
 *
 * Pure (no THREE, no Foundry): Node-testable, and the viewer just merges the
 * result into its existing light list.
 *
 * @param {Array<{id:string, x:number, y:number}>} anchors - served candle anchors.
 * @param {{lightRadiusPx:number, colorHex:string}} params
 * @returns {Array<object>} light source descriptors.
 */
export function buildCandleLightSources(anchors, { lightRadiusPx, colorHex }) {
  const radius = Number(lightRadiusPx);
  // radius 0 (or ≤0) is the author's "a flame with no light" — emit no sources,
  // rather than silently substituting a default (the param help promises this).
  if (!(radius > 0)) return [];
  const color = hexToRgb01(colorHex);
  const clusters = clusterCandleAnchors(anchors, radius * CANDLE_LIGHT_CLUSTER_FACTOR);
  const out = [];
  for (const c of clusters) {
    out.push({
      // Stable id from the sorted member ids (a rounded-centroid fallback for a
      // memberless cluster) → the viewer's light pool REUSES the mesh across
      // frames instead of rebuilding it.
      sourceId: `candle:${c.id || `${Math.round(c.x)}_${Math.round(c.y)}`}`,
      x: c.x,
      y: c.y,
      radius,
      shapePoints: candleCirclePolygon(c.x, c.y, radius),
      ratio: CANDLE_LIGHT_RATIO,
      attenuation01: CANDLE_LIGHT_ATTENUATION,
      luminosity01: CANDLE_LIGHT_LUMINOSITY,
      hasColor: true,
      alpha01: CANDLE_LIGHT_ALPHA,
      color,
      // Shaped exactly like a real Foundry light source (this function's own
      // header) — a live PointLightSource ALWAYS has an `animation` object
      // (LightData.animation, default {type:null,...}), so a candle light
      // carries the same "no animation" shape rather than an absent field
      // vt-pan-viewer.js's animated-lights wiring would otherwise choke on.
      animation: { type: null, speedRaw: 5, intensityRaw: 5, reverse: false, seed: 0 },
    });
  }
  return out;
}

/**
 * Grid-bucket candle anchors into clusters (the perf lever — see
 * CANDLE_LIGHT_CLUSTER_FACTOR). Deterministic (same anchors → same clusters, in
 * a stable order via the sorted-id key), O(N), so it is cheap to run per frame
 * and the resulting `sourceId`s are stable for pool reuse. Non-finite / id-less
 * anchors are dropped (the light pool never sees a bad source).
 *
 * @param {Array<{id?:string, x:number, y:number}>} anchors
 * @param {number} cellPx - bucket size in world px (anchors within a cell merge).
 * @returns {Array<{x:number, y:number, count:number, id:string}>} cluster centroids.
 */
export function clusterCandleAnchors(anchors, cellPx) {
  const list = Array.isArray(anchors) ? anchors : [];
  const size = Number.isFinite(cellPx) && cellPx > 0 ? cellPx : 1;
  const cells = new Map();
  for (const a of list) {
    const x = Number(a?.x);
    const y = Number(a?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = `${Math.floor(x / size)}:${Math.floor(y / size)}`;
    let c = cells.get(key);
    if (!c) {
      c = { sumX: 0, sumY: 0, n: 0, ids: [] };
      cells.set(key, c);
    }
    c.sumX += x;
    c.sumY += y;
    c.n++;
    if (typeof a.id === 'string') c.ids.push(a.id);
  }
  const out = [];
  for (const c of cells.values()) {
    out.push({ x: c.sumX / c.n, y: c.sumY / c.n, count: c.n, id: c.ids.slice().sort().join(',') });
  }
  return out;
}

/**
 * Compute the batched flame billboard geometry arrays for a set of anchors —
 * ONE quad per candle, baked in world space. PURE (no THREE): the vertex math
 * is the testable part; `buildCandleFlameGeometry` is the thin THREE wrapper.
 *
 * Per candle at (cx, cy): a SQUARE quad CENTRED on the wick (the anchor sits at
 * uv 0.5,0.5). The flame's round base draws at that centre and the tail can
 * sweep out in ANY direction — so the quad must surround the wick, not extend
 * off it. Side = `sizePx`. This quad is intentionally dumb/static: the teardrop
 * footprint AND its wind lean are entirely the material's job off the uv
 * (`buildCandleFlameMaterial`), never a geometry rebuild — this just gives the
 * shader a canvas centred on the anchor.
 *
 * @param {Array<{x:number, y:number}>} anchors
 * @param {{sizePx:number}} opts
 * @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint32Array, quadCount: number}}
 */
export function computeCandleFlameArrays(anchors, { sizePx }) {
  const list = Array.isArray(anchors) ? anchors : [];
  const n = list.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const indices = new Uint32Array(n * 6);
  const half = (Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 1) / 2;
  let quadCount = 0;
  for (let i = 0; i < n; i++) {
    const cx = Number(list[i]?.x);
    const cy = Number(list[i]?.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue; // authority guarantees finite; belt-and-braces
    const q = quadCount;
    const p = q * 12;
    const uvo = q * 8;
    const io = q * 6;
    const base = q * 4;
    // A square CENTRED on the wick (cx, cy) → the anchor is at uv (0.5, 0.5).
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
    // uv: (0,0) at one corner … (1,1) at the opposite; wick at (0.5, 0.5).
    uvs[uvo + 0] = 0;
    uvs[uvo + 1] = 0;
    uvs[uvo + 2] = 1;
    uvs[uvo + 3] = 0;
    uvs[uvo + 4] = 1;
    uvs[uvo + 5] = 1;
    uvs[uvo + 6] = 0;
    uvs[uvo + 7] = 1;
    indices[io + 0] = base + 0;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base + 0;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
    quadCount++;
  }
  return { positions, uvs, indices, quadCount };
}

/**
 * Build (or fill) a THREE.BufferGeometry for the flame billboards. Kept thin so
 * the geometry MATH stays in `computeCandleFlameArrays` (Node-tested) and only
 * the GPU-object glue is here.
 * @param {*} THREE @param {Array<{x:number,y:number}>} anchors @param {{sizePx:number}} opts
 * @returns {{geometry: *, quadCount: number}}
 */
export function buildCandleFlameGeometry(THREE, anchors, opts) {
  const { positions, uvs, indices, quadCount } = computeCandleFlameArrays(anchors, opts);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Draw only the quads actually filled — matters only if the belt-and-braces
  // finite check dropped an anchor (the authority guarantees it never does), in
  // which case the buffers hold trailing zeros that would draw degenerate tris.
  geometry.setDrawRange(0, quadCount * 6);
  return { geometry, quadCount };
}

/**
 * Build the flame's TSL material — the TOP-DOWN FOOTPRINT of a bending 3D
 * teardrop (see the FLAME shape-constants header for the full model). `uColor`
 * (flame tint, sRGB 0..1) and `uIntensity` (overall brightness) are created here
 * and returned for the viewer to drive from the resolved params (the same
 * "uniforms out, update .value per frame" contract point-light-illumination.js
 * uses).
 *
 * ============================================================================
 * THE SHAPE — a steerable "round cone", and the WIND SEAM (`uLean`)
 * ============================================================================
 *
 * The flame is the distance-field of a ROUND CONE: a disc of radius
 * FLAME_BASE_RADIUS at the wick (the quad centre) tapering to FLAME_TIP_RADIUS
 * at the TIP. The tip sits at `restCurl + uLean`, both fractions of the quad:
 *   - the wick end of the spine is the quad CENTRE, ALWAYS — the anchor is baked
 *     into the geometry, so no value of `uLean` can ever move the root off the
 *     candle (the author's hard requirement);
 *   - at rest (`uLean`=0) the tip sits at `restCurl` — a tiny offset that gives
 *     the resting flame a hint of teardrop form ("a little thickness"); its
 *     point is barely off-centre, reading as a rounded base with no obvious
 *     point, exactly the at-rest look asked for;
 *   - wind writes `uLean` (tip displacement, x/y in quad fractions) and a
 *     teardrop TAIL sweeps out in that direction — a plain per-frame uniform
 *     write, as cheap as `uColor`, NO geometry rebuild. `uLean` defaults to
 *     (0,0); no wind source exists yet — the seam is wired, at rest.
 *
 * The footprint is the standard round-cone SDF: project the fragment onto the
 * spine segment [wick→tip], clamp to the segment (spherical caps → the rounded
 * base + soft point), and compare its distance to the radius interpolated along
 * the spine. Brightness is hottest at the base (the fuel) fading to the tip,
 * with a white-hot core near the wick centre.
 *
 * Additive blending makes it GLOW over the lit scene regardless of scene
 * darkness — a flame emits light, it is not lit by it — and overlapping flames
 * add. `side: DoubleSide` sidesteps quad winding under the flipped camera.
 * Multi-arg TSL calls use the FUNCTION form (`smoothstep`/`clamp`/`mix`/`length`/
 * `dot`/`max`) — the `.mix()`-as-method trap (reference_tsl_method_chaining_trap)
 * applies to all of them.
 *
 * @param {{THREE: *}} args
 * @returns {{material: *, uColor: *, uIntensity: *, uLean: *}}
 */
export function buildCandleFlameMaterial({ THREE }) {
  const { uv, uniform, vec2, vec3, vec4, float, length, dot, clamp, smoothstep, mix, max } = THREE.TSL;

  const uColor = uniform(vec3(1, 0.667, 0));
  const uIntensity = uniform(float(1));
  // THE WIND SEAM (see this function's own header) — tip displacement in quad
  // fractions; at rest until a wind source writes it. uLean.x/y ≈ 0.3 leans hard.
  const uLean = uniform(vec2(0, 0));

  // Fragment position relative to the wick (the quad centre), in quad fractions.
  const p = uv().sub(vec2(0.5, 0.5));
  // The spine runs from the wick (0,0) to the tip. restCurl is the at-rest form;
  // wind adds uLean. The wick end is fixed at (0,0) — the root cannot move.
  const tip = uLean.add(vec2(FLAME_REST_CURL_X, FLAME_REST_CURL_Y));

  // Round-cone distance field. h = projection of p onto the spine, clamped to
  // [0,1] (0 = the wick/base, 1 = the tip); the clamp's caps round both ends.
  const h = clamp(dot(p, tip).div(max(dot(tip, tip), float(1e-6))), float(0), float(1));
  const closest = tip.mul(h);
  const distToSpine = length(p.sub(closest));
  const radiusAt = mix(float(FLAME_BASE_RADIUS), float(FLAME_TIP_RADIUS), h); // taper base→tip
  const signed = distToSpine.sub(radiusAt); // < 0 inside the teardrop

  // Soft silhouette: 1 well inside, 0 outside (the well-defined smoothstep
  // direction, then inverted — never a reversed-edge smoothstep).
  const inside = float(1).sub(smoothstep(float(-FLAME_EDGE_SOFT), float(0), signed));
  // Hottest at the base (h=0, the fuel), fading toward the tip.
  const heat = mix(float(1), float(0.35), h);

  // White-hot core near the wick centre (small radius, base only).
  const core = clamp(float(1).sub(distToSpine.div(float(FLAME_BASE_RADIUS))), float(0), float(1)).mul(
    mix(float(1), float(0), h)
  );
  const colorOut = uColor.add(vec3(core.mul(float(FLAME_CORE_LIFT))));

  const emission = inside.mul(heat).mul(uIntensity);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  // AdditiveBlending = SrcAlpha·rgb + dst → the contribution is colorOut ×
  // emission, added onto scene.lit — a glow that fades at the silhouette.
  material.fragmentNode = vec4(colorOut, emission);

  return { material, uColor, uIntensity, uLean };
}
