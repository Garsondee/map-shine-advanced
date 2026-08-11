/**
 * POINT-LIGHT BATCH MESH — S2.4 (`docs/holy/V4-Testament.md`, Stage 2's plan
 * of record: `docs/planning/Point-Light-Batching-Design.md` §3.2-§3.4).
 * Turns ONE bucket's membership into ONE merged `THREE.Mesh`, per-light
 * values carried as packed per-vertex attributes bound to the S2.1 shared
 * shading core (`buildIlluminationShadingCore`/`buildColorationShadingCore`)
 * — never a second, hand-written shader (design doc §0 rule 2).
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT DO YET (S2.5's job, not this one's)
 * ============================================================================
 * This module does not read live Foundry light data, does not decide bucket
 * MEMBERSHIP (that is `point-light-batch.js#partitionLightsForBatching`),
 * and does not value-diff against last frame — every `reconcile()` call
 * rewrites every member's VALUE attributes unconditionally (shape/position
 * IS already skipped when the bucket didn't rebuild — see `reconcile`'s own
 * doc). "Steady state writes zero bytes" (design doc §3.4) is S2.5's
 * dirty-skip layered on top of this module's `reconcile`, not built here.
 * Matches S2.2's own precedent: `point-light-batch.js` shipped with zero
 * live call sites until S2.5, "the sanctioned 'wall built before the room it
 * governs' case" (`docs/holy/V4-Testament.md`'s S2.2 entry).
 *
 * ============================================================================
 * THE PACKED LAYOUT (design doc §3.3) — implemented here EXACTLY, once
 * ============================================================================
 * Illumination `aParams` = (ratio, attenuationEased, exposure, expectedDepth);
 * `aColorA/B/C` = (background, dim, bright) tri-packed with one spare float.
 * Coloration `aParams` = (attenuationEased, colorationAlpha, expectedDepth,
 * SPARE) — NOT `ratio`, even though `buildColorationShadingCore` threads a
 * `ratio` value through to `animation.buildColorationSeed` whenever one
 * exists (`point-light-coloration.js`'s own seed-injection call). Checked
 * before building this, not assumed: every registered `buildColorationSeed`
 * across `effects/lighting/animations/*.js` was grepped for `uRatio` reads —
 * zero found (only the ILLUMINATION seed builders — torch/pulse/siren/flame/
 * candle-flicker — read it). So this is `edgeSoftFactor`'s exact shape: a
 * live wire with no current receiver, not a bug. If a FUTURE coloration
 * animation ever reads its own `ratio` input, it will silently see this
 * spare (always 0) on the BATCHED path only — the same class of gap §3.6
 * found and fixed for `positionLocal`. Named here so the next person who
 * adds a ratio-reading `buildColorationSeed` finds this comment before
 * shipping a parity bug.
 *
 * ============================================================================
 * THE PER-LIGHT "VALUE" CONTRACT — what `reconcile(members)` expects
 * ============================================================================
 * Every member: `{ sourceId, x, y, radius, shapePoints, ...channel fields }`.
 * `x`/`y` double as the wind centre (design doc §3.3: "wind centre IS the
 * light origin") — no separate wind-centre field needed.
 *
 * Illumination fields: `ratio, attenuationEased, exposure, expectedDepth,
 * bg:[r,g,b], dim:[r,g,b], bright:[r,g,b]`, plus `speedRaw, reverseSign, seed,
 * intensityRaw` iff this instance's `flags.animated`, plus `windExposure,
 * windResponse` iff `flags.windPresent`.
 *
 * Coloration fields: `attenuationEased, colorationAlpha, expectedDepth,
 * ratio` (packed but inert — see above), `lightColor:[r,g,b]`, plus the same
 * anim/wind fields under the same two gates.
 *
 * `flags.animated` MUST be resolved PER CHANNEL by the caller
 * (`!!animationEntry?.buildIlluminationSeed` / `?.buildColorationSeed` —
 * `point-light-coloration.js`/`point-light-illumination.js`'s own per-light
 * wrappers already do exactly this check; an entry can define one seed
 * builder but not the other). Passing the same boolean for both channel
 * instances of one bucket is a caller bug this module cannot detect.
 *
 * @module effects/lighting/point-light-batch-mesh
 */
import { createBucket, describeBucketVertexBuffers } from './point-light-batch.js';
import { buildIlluminationShadingCore, triangulateLightFan } from './point-light-illumination.js';
import { buildColorationShadingCore } from './point-light-coloration.js';

/** Per-buffer float count — the SAME names `describeBucketVertexBuffers` emits. */
const ITEM_SIZES = Object.freeze({
  position: 3,
  aLocalUnit: 2,
  aParams: 4,
  aColorA: 4,
  aColorB: 4,
  aColorC: 4,
  aLightColor: 4,
  aAnim: 4,
  aWind: 4,
});

/** Matches `point-light-pool.js#INITIAL_LIGHT_FAN_VERTICES` — the per-light
 * fan scratch buffer this module keeps (one per bucket member, reused across
 * frames) starts at the same size for the same reason: most lights never
 * exceed it, and `triangulateLightFan` grows it itself on the rare frame one
 * does (never a per-frame reallocation — the device-lost class). */
const INITIAL_FAN_SCRATCH_VERTICES = 192;

/**
 * VALUE equality for a flat numeric polygon array — the same content check
 * `point-light-pool.js` uses for the identical reason (that module's own
 * `shapePointsUnchanged` — duplicated here rather than imported, since the
 * dependency runs `point-light-pool.js → this module`, never the reverse).
 * Deliberately NOT `===`: a same-content-different-array frame must still
 * read as "unchanged" (this can only make the dirty-check MORE
 * conservative, never less).
 * @param {number[]|null} a @param {number[]|null} b
 * @returns {boolean}
 */
export function shapePointsUnchanged(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Broadcast this light's LOCAL-space triangulated fan into the bucket's
 * shared `position` (world-baked) and `aLocalUnit` (unit-radius local, the
 * `positionLocal.xy`-equivalent every shading-core term derives `dist`
 * from) buffers, at vertex offset `start`. Pure — plain array-likes in,
 * nothing THREE-shaped required, so this is Node-testable without a device.
 *
 * @param {{position?: {[i:number]: number}, aLocalUnit?: {[i:number]: number}}} arrays
 * @param {number} start - first vertex index to write (the member's span start).
 * @param {number} vertexCount
 * @param {ArrayLike<number>} localFanArray - `triangulateLightFan`'s own
 *   `array` output: interleaved local-space [x,y,z, ...], z always 0.
 * @param {number} originX @param {number} originY @param {number} radius
 */
export function writeLightSpanGeometry(arrays, start, vertexCount, localFanArray, originX, originY, radius) {
  const pos = arrays.position;
  const local = arrays.aLocalUnit;
  for (let v = 0; v < vertexCount; v++) {
    const lx = localFanArray[v * 3 + 0];
    const ly = localFanArray[v * 3 + 1];
    const vi = start + v;
    if (pos) {
      const po = vi * 3;
      pos[po + 0] = originX + lx * radius;
      pos[po + 1] = originY + ly * radius;
      pos[po + 2] = 0;
    }
    if (local) {
      const lo = vi * 2;
      local[lo + 0] = lx;
      local[lo + 1] = ly;
    }
  }
}

/**
 * Broadcast one ILLUMINATION light's per-frame VALUES across its already-
 * placed vertex span `[start, start+count)` — see this module's header for
 * the exact field contract and the §3.3 byte layout. Pure.
 *
 * @param {object} arrays - buffer name -> array-like (any buffer this
 *   bucket's layout lacks is simply absent — guarded, never assumed present).
 * @param {number} start @param {number} count
 * @param {object} values - one member's resolved per-light values.
 */
export function writeIlluminationValueSpan(arrays, start, count, values) {
  const {
    ratio,
    attenuationEased,
    exposure,
    expectedDepth,
    bg,
    dim,
    bright,
    speedRaw,
    reverseSign,
    seed,
    intensityRaw,
    x,
    y,
    windExposure,
    windResponse,
  } = values;
  for (let v = 0; v < count; v++) {
    const vi = start + v;
    if (arrays.aParams) {
      const o = vi * 4;
      arrays.aParams[o + 0] = ratio;
      arrays.aParams[o + 1] = attenuationEased;
      arrays.aParams[o + 2] = exposure;
      arrays.aParams[o + 3] = expectedDepth;
    }
    if (arrays.aColorA) {
      const o = vi * 4;
      arrays.aColorA[o + 0] = bg[0];
      arrays.aColorA[o + 1] = bg[1];
      arrays.aColorA[o + 2] = bg[2];
      arrays.aColorA[o + 3] = dim[0];
    }
    if (arrays.aColorB) {
      const o = vi * 4;
      arrays.aColorB[o + 0] = dim[1];
      arrays.aColorB[o + 1] = dim[2];
      arrays.aColorB[o + 2] = bright[0];
      arrays.aColorB[o + 3] = bright[1];
    }
    if (arrays.aColorC) {
      const o = vi * 4;
      arrays.aColorC[o + 0] = bright[2];
      arrays.aColorC[o + 1] = 0;
      arrays.aColorC[o + 2] = 0;
      arrays.aColorC[o + 3] = 0;
    }
    if (arrays.aAnim) {
      const o = vi * 4;
      arrays.aAnim[o + 0] = speedRaw;
      arrays.aAnim[o + 1] = reverseSign;
      arrays.aAnim[o + 2] = seed;
      arrays.aAnim[o + 3] = intensityRaw;
    }
    if (arrays.aWind) {
      const o = vi * 4;
      arrays.aWind[o + 0] = x;
      arrays.aWind[o + 1] = y;
      arrays.aWind[o + 2] = windExposure;
      arrays.aWind[o + 3] = windResponse;
    }
  }
}

/**
 * Broadcast one COLORATION light's per-frame VALUES — the sibling of
 * {@link writeIlluminationValueSpan}. Pure. See this module's header for why
 * `aParams`'s 4th float is a spare, not `ratio`.
 *
 * @param {object} arrays @param {number} start @param {number} count
 * @param {object} values
 */
export function writeColorationValueSpan(arrays, start, count, values) {
  const {
    attenuationEased,
    colorationAlpha,
    expectedDepth,
    lightColor,
    speedRaw,
    reverseSign,
    seed,
    intensityRaw,
    x,
    y,
    windExposure,
    windResponse,
  } = values;
  for (let v = 0; v < count; v++) {
    const vi = start + v;
    if (arrays.aParams) {
      const o = vi * 4;
      arrays.aParams[o + 0] = attenuationEased;
      arrays.aParams[o + 1] = colorationAlpha;
      arrays.aParams[o + 2] = expectedDepth;
      arrays.aParams[o + 3] = 0; // spare — see this module's header
    }
    if (arrays.aLightColor) {
      const o = vi * 4;
      arrays.aLightColor[o + 0] = lightColor[0];
      arrays.aLightColor[o + 1] = lightColor[1];
      arrays.aLightColor[o + 2] = lightColor[2];
      arrays.aLightColor[o + 3] = 0;
    }
    if (arrays.aAnim) {
      const o = vi * 4;
      arrays.aAnim[o + 0] = speedRaw;
      arrays.aAnim[o + 1] = reverseSign;
      arrays.aAnim[o + 2] = seed;
      arrays.aAnim[o + 3] = intensityRaw;
    }
    if (arrays.aWind) {
      const o = vi * 4;
      arrays.aWind[o + 0] = x;
      arrays.aWind[o + 1] = y;
      arrays.aWind[o + 2] = windExposure;
      arrays.aWind[o + 3] = windResponse;
    }
  }
}

/**
 * Build the ONE shared-core material this bucket instance draws with —
 * called ONCE, at construction. A bucket's graph-build-time flags
 * (animated/windPresent/animationEntry/animationQuality/falloffModel) are
 * fixed for its whole life: design doc §3.1's bucket KEY already encodes
 * every one of these, so a flag change means a light belongs to a DIFFERENT
 * bucket (a new `createBatchedLightMesh` instance), never an in-place
 * rebuild of this one. No `tsl/no-uniform-gates` risk here for exactly that
 * reason.
 *
 * @param {object} THREE @param {'illumination'|'coloration'} channel
 * @param {object} shared - passed straight through to the channel's own
 *   shading core (`buildIlluminationShadingCore`/`buildColorationShadingCore`'s
 *   own `shared` param — see each function's header for its exact shape).
 * @param {{animated: boolean, windPresent: boolean, animationEntry: object|null,
 *   animationQuality: number, falloffModel: string}} flags
 * @param {{buffers: string[]}} layout
 * @returns {*} a `THREE.NodeMaterial`.
 */
function buildBatchedMaterial({ THREE, channel, shared, flags, layout }) {
  const { attribute, vec2, vec3, vec4 } = THREE.TSL;
  const aParamsNode = attribute('aParams', 'vec4');

  const animInput = flags.animated
    ? (() => {
        const n = attribute('aAnim', 'vec4');
        return { speedRaw: n.x, reverseSign: n.y, seed: n.z, intensityRaw: n.w };
      })()
    : null;
  const windInput = flags.windPresent
    ? (() => {
        const n = attribute('aWind', 'vec4');
        return { center: vec2(n.x, n.y), exposure: n.z, response: n.w };
      })()
    : null;

  let coreInputs;
  if (channel === 'illumination') {
    const aColorANode = attribute('aColorA', 'vec4');
    const aColorBNode = attribute('aColorB', 'vec4');
    const aColorCNode = attribute('aColorC', 'vec4');
    coreInputs = {
      localUnitXY: attribute('aLocalUnit', 'vec2'),
      ratio: aParamsNode.x,
      attenuationEased: aParamsNode.y,
      exposure: aParamsNode.z,
      expectedDepth: aParamsNode.w,
      backgroundColor: vec3(aColorANode.x, aColorANode.y, aColorANode.z),
      dimColor: vec3(aColorANode.w, aColorBNode.x, aColorBNode.y),
      brightColor: vec3(aColorBNode.z, aColorBNode.w, aColorCNode.x),
      anim: animInput,
      wind: windInput,
    };
  } else {
    const aLightColorNode = attribute('aLightColor', 'vec4');
    coreInputs = {
      localUnitXY: attribute('aLocalUnit', 'vec2'),
      attenuationEased: aParamsNode.x,
      colorationAlpha: aParamsNode.y,
      expectedDepth: aParamsNode.z,
      // Design doc §3.3: the coloration bucket carries no ratio buffer (this
      // module's own header has the "checked, not assumed" account) —
      // `aParams.w` is the spare. `buildColorationShadingCore` still wants a
      // `ratio` input; the per-light path's OWN value (illumination's shared
      // `uRatio`) is a scene-static-ish default, near enough for a term that
      // — verified above — no registered coloration seed builder reads.
      ratio: aParamsNode.w,
      lightColor: vec3(aLightColorNode.x, aLightColorNode.y, aLightColorNode.z),
      anim: animInput,
      wind: windInput,
    };
  }

  const buildCore = channel === 'illumination' ? buildIlluminationShadingCore : buildColorationShadingCore;
  const { finalNode, alphaNode } = buildCore({
    THREE,
    inputs: coreInputs,
    shared,
    flags: {
      animation: flags.animated ? flags.animationEntry : null,
      animationQuality: flags.animationQuality,
      falloffModel: flags.falloffModel,
      apertureCount: 0, // batched lights never carry apertures — design doc §3.1
    },
  });

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
  material.fragmentNode = vec4(finalNode, alphaNode);
  void layout; // not needed by the graph itself — kept as a param for symmetry with the caller's own bookkeeping
  return material;
}

/**
 * Create ONE bucket's live mesh: material built once, geometry buffers
 * grow-only (never reallocated per frame — design doc §0 rule 3), spans
 * managed by {@link createBucket} (S2.2) so this module never re-solves the
 * same bookkeeping.
 *
 * @param {object} args @param {object} args.THREE
 * @param {'illumination'|'coloration'} args.channel
 * @param {object} args.shared - forwarded to the shading core untouched.
 * @param {{animated: boolean, windPresent: boolean, animationEntry: object|null,
 *   animationQuality: number, falloffModel: string}} args.flags
 * @returns {{mesh: *, reconcile: (members: object[]) => {rebuilt: boolean,
 *   grew: boolean, totalVertexCount: number, memberCount: number},
 *   dispose: () => void, layout: {buffers: string[], count: number}}}
 */
export function createBatchedLightMesh({ THREE, channel, shared, flags }) {
  if (channel !== 'illumination' && channel !== 'coloration') {
    throw new Error(`createBatchedLightMesh: channel must be 'illumination' or 'coloration' (got '${channel}')`);
  }
  const resolvedFlags = {
    animated: flags.animated === true,
    windPresent: flags.windPresent === true,
    animationEntry: flags.animationEntry ?? null,
    animationQuality: flags.animationQuality ?? 0,
    falloffModel: flags.falloffModel ?? 'foundry',
  };
  const layout = describeBucketVertexBuffers({
    channel,
    animated: resolvedFlags.animated,
    windPresent: resolvedFlags.windPresent,
  });
  if (!layout.ok) {
    throw new Error(
      `createBatchedLightMesh(${channel}): this bucket needs ${layout.count} vertex buffers ` +
        `[${layout.buffers.join(', ')}], over MAX_VERTEX_BUFFERS_PER_PIPELINE — see ` +
        `Point-Light-Batching-Design.md §3.3 before adding another field`
    );
  }

  const material = buildBatchedMaterial({ THREE, channel, shared, flags: resolvedFlags, layout });

  const geometry = new THREE.BufferGeometry();
  const arrays = {};

  function ensureCapacity(nextCapacity) {
    for (const name of layout.buffers) {
      const itemSize = ITEM_SIZES[name];
      const arr = new Float32Array(nextCapacity * itemSize);
      arrays[name] = arr;
      const attr = new THREE.BufferAttribute(arr, itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attr);
    }
  }
  // Every layout buffer exists from construction, even zero-length — a
  // never-populated bucket (this key's members all left, or never arrived)
  // is `mesh.visible = false` below, never a geometry with a missing
  // attribute an unrelated code path might touch.
  ensureCapacity(0);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  const bucket = createBucket();
  /** sourceId -> Float32Array — this member's own reusable LOCAL-space fan
   * scratch (the SAME per-light reuse discipline `point-light-pool.js`'s
   * `entry.scratchArray` already uses, for the SAME reason: a fresh
   * Float32Array per light per frame is the exact device-lost bug class
   * design doc §0 rule 3 forbids). */
  const fanScratch = new Map();
  /** sourceId -> {x, y, radius, shapePoints} — the (x,y,radius,shapePoints)
   * this member's GEOMETRY (position/aLocalUnit span) was last written
   * against. ⚠️ DELIBERATELY SEPARATE from `bucket`'s own `rebuilt` flag:
   * `createBucket#reconcile` only tracks MEMBERSHIP and per-member
   * VERTEX COUNT — a light that simply MOVES (or resizes without changing
   * its polygon's point count, the overwhelmingly common case) keeps the
   * exact same vertexCount, so the bucket reports `rebuilt:false` even
   * though this light's own span is now stale. Gating the geometry
   * rewrite on `rebuilt` alone would silently strand every moving light at
   * its OLD position forever after its first frame — caught here by
   * tracing the bench's own `span-position-rewrite-moves-a-light` scenario
   * against this module's real API before wiring it up, not by a live
   * report of frozen lights. Mirrors `point-light-pool.js`'s own
   * `lastShapeX/Y/Radius/Points` per-entry dirty-check (design doc §3.4:
   * "Movement/reshape: gated by the EXISTING per-light shape dirty-check"). */
  const lastPlacement = new Map();

  function placementChanged(sourceId, m) {
    const prev = lastPlacement.get(sourceId);
    if (!prev) return true;
    return (
      prev.x !== m.x ||
      prev.y !== m.y ||
      prev.radius !== m.radius ||
      !shapePointsUnchanged(prev.shapePoints, m.shapePoints)
    );
  }

  /**
   * Reconcile this bucket's mesh against THIS frame's membership. See this
   * module's header for the per-member value contract.
   *
   * ORDER MATTERS for the cheap path: `createBucket#reconcile`'s own
   * contract is idempotent only for an unchanged (sourceIds, order,
   * vertexCounts) — a caller whose member list order drifts frame to frame
   * for no membership reason pays a full repack every frame for nothing.
   *
   * NOT YET dirty-skipped at the VALUE level (S2.5's job — see this
   * module's header): every call rewrites every member's value buffers.
   * Geometry (position/aLocalUnit) IS skipped per-member when neither the
   * bucket rebuilt NOR that member's own placement changed.
   *
   * @param {object[]} members
   */
  function reconcile(members) {
    if (fanScratch.size) {
      const live = new Set(members.map((m) => m.sourceId));
      for (const id of fanScratch.keys()) {
        if (!live.has(id)) fanScratch.delete(id);
      }
      for (const id of lastPlacement.keys()) {
        if (!live.has(id)) lastPlacement.delete(id);
      }
    }
    const fans = new Map();
    const bucketMembers = new Array(members.length);
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      let scratch = fanScratch.get(m.sourceId);
      if (!scratch) scratch = new Float32Array(INITIAL_FAN_SCRATCH_VERTICES * 3);
      const fan = triangulateLightFan(m.shapePoints, m.x, m.y, m.radius, scratch);
      fanScratch.set(m.sourceId, fan.array);
      fans.set(m.sourceId, fan);
      bucketMembers[i] = { sourceId: m.sourceId, vertexCount: fan.vertexCount };
    }

    const { rebuilt, grew, spans, totalVertexCount, capacity } = bucket.reconcile(bucketMembers);
    if (grew) ensureCapacity(capacity);

    let anyGeometryWrite = rebuilt; // a rebuild always touches every span, so every member's geometry is written below regardless
    for (const m of members) {
      const span = spans.get(m.sourceId);
      if (rebuilt || placementChanged(m.sourceId, m)) {
        const fan = fans.get(m.sourceId);
        writeLightSpanGeometry(arrays, span.start, fan.vertexCount, fan.array, m.x, m.y, m.radius);
        lastPlacement.set(m.sourceId, { x: m.x, y: m.y, radius: m.radius, shapePoints: m.shapePoints });
        anyGeometryWrite = true;
      }
      writeValueSpan(m, span);
    }

    for (const name of layout.buffers) {
      const isGeometryBuffer = name === 'position' || name === 'aLocalUnit';
      if (isGeometryBuffer && !anyGeometryWrite) continue;
      geometry.attributes[name].needsUpdate = true;
    }

    geometry.setDrawRange(0, totalVertexCount);
    mesh.visible = totalVertexCount > 0;
    return { rebuilt, grew, totalVertexCount, memberCount: members.length };
  }

  function writeValueSpan(m, span) {
    if (channel === 'illumination') {
      writeIlluminationValueSpan(arrays, span.start, span.count, m);
    } else {
      writeColorationValueSpan(arrays, span.start, span.count, m);
    }
  }

  function dispose() {
    material.dispose();
    geometry.dispose();
    fanScratch.clear();
    lastPlacement.clear();
  }

  return { mesh, reconcile, dispose, layout };
}
