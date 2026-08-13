/**
 * POINT-LIGHT BATCH — S2.2 (`docs/holy/V4-Testament.md`, Stage 2's plan of
 * record: `docs/planning/Point-Light-Batching-Design.md`). Pure CPU-side
 * bookkeeping ONLY: which lights may share one compiled material (§3.1's
 * bucket key), which additionally qualify for the coloration channel
 * (§3.1's coloration membership), how many packed per-vertex buffers a
 * bucket's mesh needs and whether that count still fits the device's real
 * pipeline limit (§3.3), and a per-bucket span allocator that decides
 * whether a frame's membership change requires a full repack or is a no-op
 * (§3.4's "grow by doubling, rebuild only on membership change").
 *
 * NOTHING here touches THREE, a shader, or a Foundry document shape — no
 * device, no injected `THREE`, importable and testable in plain Node. The
 * caller (S2.5's pool integration, not yet built) is responsible for
 * turning a live Foundry light into the small, already-resolved
 * `BatchLightDescriptor` shape these functions consume (animation
 * resolution via `animations/registry.js#resolveLightAnimation`, aperture
 * counting via `aperture-gobo.js#findAperturesForLight` — both ALREADY
 * computed by `point-light-pool.js#update()`'s existing per-light loop
 * before this module would ever see a light, so nothing here re-derives
 * either).
 *
 * @typedef {object} BatchLightDescriptor
 * @property {string} sourceId
 * @property {string|null} animationType - `light.animation.type`, raw —
 *   only used to build the bucket key when `animationResolved` is true (an
 *   unported/absent type collapses to the SAME 'none' key regardless of its
 *   own string — design doc §3.1, "key on the resolution, not the raw
 *   string").
 * @property {boolean} animationResolved - whether
 *   `resolveLightAnimation(animationType)` returned a real registry entry
 *   (not null) — two DIFFERENT unported type strings both resolve to null
 *   and must key identically.
 * @property {boolean} [forceDefaultColor] - the resolved entry's own
 *   `forceDefaultColor` (registry.js's own field) — Foundry's
 *   `isRequired`-style override that draws coloration even for a colourless
 *   light. Default false.
 * @property {number} [animationQuality] - graph-build-time tier, default 0.
 * @property {string} falloffModel - `'foundry'` | `'inverseSquare'` — must
 *   be in `BATCH_FALLOFF_MODELS`' closed list or the light is inadmissible.
 * @property {boolean} [windPresent] - `Number.isFinite(light.windExposure)`.
 * @property {number} [apertureCount] - a light with any apertures is NEVER
 *   admitted in v1 (design doc §3.1: apGoboCols/Rows are graph-build-time
 *   unroll counts, would fragment buckets by construction).
 * @property {boolean} [hasColor]
 * @property {number} vertexCount - this light's own triangulated fan vertex
 *   count this frame (`triangulateLightFan`'s own `vertexCount`).
 *
 * @module effects/lighting/point-light-batch
 */

/**
 * The falloff models a bucket may batch — a closed list
 * (`feedback_category_string_must_be_in_closed_list`), not a negative check.
 * A light whose `falloffModel` is not one of these (should never happen
 * today — `point-light-pool.js` only ever produces these two — but this
 * module never trusts that from the outside) is inadmissible, same as an
 * aperture-lit one; it stays on the existing per-light path.
 */
export const BATCH_FALLOFF_MODELS = Object.freeze(['foundry', 'inverseSquare']);

/**
 * WebGPU's real per-pipeline vertex-buffer limit, as this codebase already
 * hit it once (`keyhole-vertex-buffer-limit-fix` memory). The design doc's
 * §3.3 fully-loaded illumination layout sits EXACTLY at this — anyone
 * extending the layout must re-run {@link describeBucketVertexBuffers}
 * first, not assume there's headroom.
 */
export const MAX_VERTEX_BUFFERS_PER_PIPELINE = 8;

/**
 * §3.1's bucket key: everything that is graph-BUILD-time (a different
 * value means a genuinely different compiled shader, `tsl/no-uniform-gates`)
 * collapsed into one string. Animation identity keys on RESOLUTION, not the
 * raw type string — see this module's own header and the
 * `BatchLightDescriptor` doc for why.
 *
 * @param {BatchLightDescriptor} light
 * @returns {string}
 */
export function computeBucketKey({ animationType, animationResolved, animationQuality, falloffModel, windPresent }) {
  const animKey = animationResolved ? animationType : 'none';
  const quality = Number.isFinite(animationQuality) ? animationQuality : 0;
  return `${animKey}|q${quality}|${falloffModel}|${windPresent ? 'wind' : 'noWind'}`;
}

/**
 * Admission — a light either belongs entirely to a bucket or stays entirely
 * on the existing per-light path (design doc §3.5); there is no partial
 * batching of one light. Aperture-lit lights are excluded UNCONDITIONALLY
 * in v1 (§3.1 — `apGoboCols`/`apGoboRows` are graph-build-time unroll
 * counts that would fragment buckets down to near-singletons anyway; S2.0's
 * census found zero aperture-lit lights on the flagship map, so this costs
 * nothing there).
 *
 * @param {BatchLightDescriptor} light
 * @returns {boolean}
 */
export function canBatchLight({ apertureCount, falloffModel }) {
  if (Number(apertureCount) > 0) return false;
  return BATCH_FALLOFF_MODELS.includes(falloffModel);
}

/**
 * §3.1's coloration membership: `hasColor || forceDefaultColor` — Foundry's
 * own `AdaptiveColorationShader#isRequired` shape
 * (`point-light-coloration.js`'s own header). A light can be admitted to
 * its illumination bucket while NOT joining the matching coloration one
 * (a colourless, non-`forceDefaultColor` light) — the two channels are
 * independently gated, same as today's per-light `colorationMesh.visible`/
 * `uColorationAlpha=0` posture, just decided by membership instead of a
 * drawn-but-zeroed mesh.
 *
 * @param {BatchLightDescriptor} light
 * @returns {boolean}
 */
export function isColorationEligible({ hasColor, forceDefaultColor }) {
  return hasColor === true || forceDefaultColor === true;
}

/**
 * §3.3's packed per-vertex-buffer layout for one bucket SHAPE (not one
 * bucket instance — every member of a bucket shares the same answer, since
 * membership is defined by graph identity). `position` (world-space,
 * baked at rebuild time) and `aLocalUnit` (the `positionLocal.xy`-
 * equivalent every shading-core term derives `dist` from) are always
 * present; `aAnim`/`aWind` only exist for buckets that actually need them,
 * matching the per-light wrapper's own "create only what `animation?.
 * buildXSeed`/`windExposure`-finiteness call for" conditions today.
 *
 * `channel: 'merged'` (S2.14, Performance-Audit-2026-08.md §3.1) packs BOTH
 * channels' own fields into one layout: `aParamsShared` (attenuationEased,
 * expectedDepth, ratio, exposure — the first two genuinely shared, the last
 * two illumination-only but coloration ignores them, exactly like today's
 * separate coloration `aParams` carries an inert `ratio` spare), `aColorA/
 * B/C` (bg/dim/bright, THEN colorationAlpha and lightColor.r/g once bright
 * is exhausted), `aLightColorB` (lightColor.b + 3 genuine spares). At the
 * fully-loaded (animated+wind) worst case this reaches 8 physical slots
 * ONLY because `aAnim`+`aWind` share ONE binding via an interleaved buffer
 * (`slotCount` below, not `buffers.length`, is what a device limit actually
 * counts) — see `point-light-batch-mesh.js#createBatchedLightMesh`'s own
 * interleaving construction for the other half of this contract.
 *
 * @param {object} args
 * @param {'illumination'|'coloration'|'merged'} args.channel
 * @param {boolean} args.animated
 * @param {boolean} args.windPresent
 * @returns {{buffers: string[], count: number, slotCount: number, ok: boolean}}
 *   `buffers`/`count` name every logical attribute (shader/attribute wiring
 *   needs every name, interleaved or not); `slotCount` is the real physical
 *   vertex-buffer-binding count (`count` minus 1 when `channel==='merged'`
 *   AND both `animated`/`windPresent` are true, since `aAnim`+`aWind` then
 *   share one binding). `ok` is false iff `slotCount` exceeds
 *   {@link MAX_VERTEX_BUFFERS_PER_PIPELINE} — a hard stop for whoever is
 *   about to add a field, not a warning to route around.
 */
export function describeBucketVertexBuffers({ channel, animated, windPresent }) {
  const buffers = ['position', 'aLocalUnit'];
  if (channel === 'illumination') {
    buffers.push('aParams', 'aColorA', 'aColorB', 'aColorC');
  } else if (channel === 'coloration') {
    buffers.push('aParams', 'aLightColor');
  } else {
    buffers.push('aParamsShared', 'aColorA', 'aColorB', 'aColorC', 'aLightColorB');
  }
  if (animated) buffers.push('aAnim');
  if (windPresent) buffers.push('aWind');
  const interleaved = channel === 'merged' && animated && windPresent;
  const slotCount = interleaved ? buffers.length - 1 : buffers.length;
  return { buffers, count: buffers.length, slotCount, ok: slotCount <= MAX_VERTEX_BUFFERS_PER_PIPELINE };
}

/**
 * ONE bucket's packed-span bookkeeping. `reconcile(members)` is idempotent
 * for an unchanged `members` list (same sourceIds, same order, same
 * per-member `vertexCount`) — a steady-state frame calls it and gets
 * `rebuilt: false` back, telling the caller its existing vertex-buffer
 * layout is still valid and only per-frame VALUES (not positions) need
 * writing (design doc §3.4's "steady state... writes ZERO bytes", one
 * layer up from what this function alone guarantees — this function is
 * the layout half of that promise).
 *
 * Capacity only GROWS (double the needed size once it must grow at all),
 * matching `point-light-pool.js`'s own existing device-lost-fix precedent
 * for `scratchArray`/`positionAttribute` (never shrinks, allocated once,
 * reused) — `point-light-pool.js:735-754`'s own header has the full "why"
 * (a per-frame reallocation leaks a native GPU buffer every time; this
 * module has no GPU buffer of its own YET, but the caller that eventually
 * sizes one against `capacity` inherits the same discipline for free by
 * following this contract).
 *
 * @returns {{reconcile: (members: Array<{sourceId: string, vertexCount: number}>) =>
 *   {rebuilt: boolean, grew: boolean, spans: Map<string,{start:number,count:number}>,
 *   totalVertexCount: number, capacity: number}}}
 */
export function createBucket() {
  let capacity = 0;
  let spans = new Map();
  let order = [];

  function reconcile(members) {
    const nextOrder = members.map((m) => m.sourceId);
    let unchanged = nextOrder.length === order.length && nextOrder.every((id, i) => id === order[i]);
    if (unchanged) {
      for (const m of members) {
        const prev = spans.get(m.sourceId);
        if (!prev || prev.count !== m.vertexCount) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) {
      let totalVertexCount = 0;
      for (const id of order) totalVertexCount += spans.get(id).count;
      return { rebuilt: false, grew: false, spans, totalVertexCount, capacity };
    }

    const nextSpans = new Map();
    let cursor = 0;
    for (const m of members) {
      nextSpans.set(m.sourceId, { start: cursor, count: m.vertexCount });
      cursor += m.vertexCount;
    }
    let grew = false;
    if (cursor > capacity) {
      capacity = capacity === 0 ? cursor : Math.max(cursor, capacity * 2);
      grew = true;
    }
    order = nextOrder;
    spans = nextSpans;
    return { rebuilt: true, grew, spans, totalVertexCount: cursor, capacity };
  }

  return { reconcile };
}

/**
 * A named collection of {@link createBucket} instances, keyed by whatever
 * string the caller uses (in practice: `${channel}:${computeBucketKey(...)}`
 * — this function is channel-agnostic on purpose, so illumination and
 * coloration buckets never accidentally collide or share state even when
 * their {@link computeBucketKey} string is identical).
 *
 * @returns {{getOrCreateBucket: (key: string) => ReturnType<typeof createBucket>,
 *   deleteBucket: (key: string) => void, keys: () => IterableIterator<string>}}
 */
export function createBucketRegistry() {
  const buckets = new Map();
  return {
    getOrCreateBucket(key) {
      let b = buckets.get(key);
      if (!b) {
        b = createBucket();
        buckets.set(key, b);
      }
      return b;
    },
    deleteBucket(key) {
      buckets.delete(key);
    },
    keys() {
      return buckets.keys();
    },
  };
}

/**
 * Partition one frame's lights into per-key illumination and coloration
 * groups (design doc §3.1) — the caller feeds each group's member array
 * into {@link createBucket}'s own `reconcile` (this function does the
 * admission + grouping, not the span bookkeeping itself, so a caller that
 * only needs to know WHO belongs together — a census, a diagnostic — never
 * has to construct a registry to ask). Lights failing {@link canBatchLight}
 * are returned separately, UNCHANGED —
 * this function never drops a light; the caller keeps them on the existing
 * per-light path (§3.5), same posture the registry's own map-absence rule
 * uses for an unrecognized animation type.
 *
 * @param {BatchLightDescriptor[]} lights
 * @returns {{illumMembers: Map<string, BatchLightDescriptor[]>,
 *   colorMembers: Map<string, BatchLightDescriptor[]>,
 *   excluded: BatchLightDescriptor[]}}
 */
export function partitionLightsForBatching(lights) {
  const illumMembers = new Map();
  const colorMembers = new Map();
  const excluded = [];
  for (const light of lights) {
    if (!canBatchLight(light)) {
      excluded.push(light);
      continue;
    }
    const key = computeBucketKey(light);
    if (!illumMembers.has(key)) illumMembers.set(key, []);
    illumMembers.get(key).push(light);
    if (isColorationEligible(light)) {
      if (!colorMembers.has(key)) colorMembers.set(key, []);
      colorMembers.get(key).push(light);
    }
  }
  return { illumMembers, colorMembers, excluded };
}
