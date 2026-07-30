/**
 * THE SUN-SHADOW DEBUG VIEW — one shadow at a time, on a white background.
 *
 * Author, 2026-07-26: *"I want a debug view, a dropdown in the ROH controls,
 * allowing me to see just a single shadow at a time out of the whole system.
 * Render the shadow onto a white background so that we are isolating just the
 * shadow itself. You can also put debug things into that list so that I can help
 * tell you if an intermediate texture is actually broken."*
 *
 * ============================================================================
 * WHY THIS EXISTS, IN ONE PARAGRAPH
 * ============================================================================
 *
 * Sun shadows went four rounds of tuning without converging, and every round
 * failed for the same reason: the question *"is the intermediate data wrong, or
 * is the shader wrong?"* could not be asked. The report could say "8 sky-reach
 * items" while every one of them had a height of zero, and the picture looked
 * identical to "no items at all" (`feedback_instruments_must_not_lie` — "could
 * not measure" is not "is broken", and the two must never render the same). The
 * COVERAGE/HEIGHT pair below is the fix for that specific blindness: two views,
 * two facts, and the difference between them is the diagnosis.
 *
 * ============================================================================
 * ONE CONTROL, ONE ACTION
 * ============================================================================
 *
 * This dropdown REPLACES the three `showBuilding`/`showOverhead`/`showSkyReach`
 * booleans. Their own help text already said "Diagnosis:", and two controls that
 * isolate the same three producers is exactly how they end up disagreeing about
 * which one is on (`feedback_debug_ui_one_action_one_control`). Picking
 * "Building shadows only" both restricts the DERIVATION (the other producers'
 * channels are never written, so the isolation is real rather than a shader
 * multiply — `tsl/no-uniform-gates`) and switches the screen to the white-
 * background view. One pick, one meaning.
 *
 * ============================================================================
 * NO `uEnable*` GATE, AND HOW
 * ============================================================================
 *
 * The view is chosen by a pair of one-hot vec4 MASKS dotted with the two
 * samples — `dot(shadow, shadowMask) + dot(caster, casterMask)` — so exactly one
 * source contributes and the shader has no branch, no boolean uniform and
 * nothing named `uEnable`/`uUse`/`uHas`. Switching views writes eight floats.
 *
 * @module effects/lighting/sun-shadow-debug
 */

/**
 * Every debug view, in dropdown order. `id` is what the param stores; `include`
 * is the derivation restriction the view implies (absent = leave the field
 * whole); `shadow`/`caster` are the one-hot channel masks.
 *
 * ⚠️ THE LABELS BELOW MATCH THE PACKING AS OF ROUND SEVEN, 2026-07-30
 * (`sun-occlusion-render.js`'s own "THE PACKING" comment is the one true
 * source — verify against IT, not this list, if the two ever disagree):
 * R = sky-reach coverage ONLY (NOT overhead, NOT a general "occluder
 * coverage"), G = FLOATING height (overhead ∪ sky-reach — BUILDING EXCLUDED;
 * a building's height is a scene-wide uniform now, never a sampled byte), B =
 * FLOATING coverage (overhead ∪ sky-reach — building excluded here too, its
 * coverage is read straight from A where the march needs it). There is no
 * per-texel building channel left to show AT ALL — `shadow-building` still
 * isolates the DERIVATION (the mask authority stops writing overhead/
 * sky-reach for this view), but the `caster-*` data views have nothing
 * building-shaped to display. This is the SECOND time this comment has had to
 * chase a repack (found stale once already, 2026-07-30, before Round Seven
 * even landed: `caster-coverage` said "(R)" as if it meant every producer's
 * coverage, and the id `caster-building` claimed B was building-only when it
 * was already `building ∪ overhead`) — exactly the "instruments must not
 * lie" trap, twice running. The id was renamed this round (`caster-building`
 * → `caster-floating`) rather than relabeled a second time in place, since a
 * name claiming "building" for data that has never once shown building alone
 * is the same drift by another route.
 *
 * ⚠️ `caster-height` IS THE SKY-REACH SMOKING GUN. Compare it against
 * `caster-coverage`: a silhouette in coverage with BLACK in the same place in
 * height means the casters exist and are all zero-height — which is what a floor
 * with no declared `bottomElevation` produces, silently, while every count in
 * the report stays healthy. That pair is the single most useful thing here.
 */
export const SUN_SHADOW_DEBUG_VIEWS = Object.freeze([
  Object.freeze({ id: 'off', label: 'Normal render', shadow: null, caster: null }),
  Object.freeze({
    id: 'shadow-all',
    label: 'Shadows — all, on white',
    shadow: [1, 0, 0, 0],
    caster: null,
  }),
  Object.freeze({
    id: 'shadow-building',
    label: 'Shadows — building only',
    include: { building: true, overhead: false, skyReach: false },
    shadow: [1, 0, 0, 0],
    caster: null,
  }),
  Object.freeze({
    id: 'shadow-overhead',
    label: 'Shadows — overhead only',
    include: { building: false, overhead: true, skyReach: false },
    shadow: [1, 0, 0, 0],
    caster: null,
  }),
  Object.freeze({
    id: 'shadow-skyreach',
    label: 'Shadows — sky-reach only',
    include: { building: false, overhead: false, skyReach: true },
    shadow: [1, 0, 0, 0],
    caster: null,
  }),
  Object.freeze({
    id: 'caster-coverage',
    label: 'Data — sky-reach coverage (R)',
    shadow: null,
    caster: [1, 0, 0, 0],
  }),
  Object.freeze({
    id: 'caster-height',
    label: 'Data — floating height, overhead ∪ sky-reach (G)',
    shadow: null,
    caster: [0, 1, 0, 0],
  }),
  Object.freeze({
    id: 'caster-floating',
    label: 'Data — floating coverage, overhead ∪ sky-reach (B)',
    shadow: null,
    caster: [0, 0, 1, 0],
  }),
  Object.freeze({
    id: 'caster-gate',
    label: 'Data — receiver gate / outdoors (A)',
    shadow: null,
    caster: [0, 0, 0, 1],
  }),
]);

/** @param {string} id @returns {object} the view, or the `off` entry. */
export function sunShadowDebugView(id) {
  return SUN_SHADOW_DEBUG_VIEWS.find((v) => v.id === id) ?? SUN_SHADOW_DEBUG_VIEWS[0];
}

/**
 * The derivation restriction a view implies — what the mask authority's
 * `setCasterHeightSpec({include})` should be set to while this view is active.
 * Absent on most views = everything on.
 * @param {string} id
 * @returns {{building: boolean, overhead: boolean, skyReach: boolean}}
 */
export function sunShadowDebugInclude(id) {
  return sunShadowDebugView(id).include ?? { building: true, overhead: true, skyReach: true };
}

/** True when the view paints over the scene (i.e. anything but `off`). */
export function sunShadowDebugPaints(id) {
  const v = sunShadowDebugView(id);
  return !!(v.shadow || v.caster);
}

/**
 * Build the fullscreen debug material.
 *
 * Reads BOTH world-space fields and maps the camera's world rect onto each —
 * the same derivation `buildSunVisibilityNode` uses, and for the same reason:
 * these are scene-space buffers, so the screen pixel must be converted to world
 * before either can be sampled. Takes the CALLER's `uViewRect` rather than
 * making one, so the debug view can never show a differently-framed picture from
 * the render it is diagnosing (the shared-uniform rule that
 * `buildOutdoorsGate` states at length).
 *
 * @param {object} args
 * @param {*} args.THREE - carries `.TSL`.
 * @param {*} args.shadowTexture - the baked visibility field.
 * @param {*} args.casterTexture - the packed caster field (RGBA8).
 * @param {*} args.uViewRect - vec4 uniform, the camera's world rect (SHARED).
 * @param {*} args.uShadowRect - vec4 uniform, the rect both fields cover (SHARED).
 * @returns {{material: *, setView: (id: string) => void, setCasterTexture: (tex: *) => void}}
 */
export function buildSunShadowDebugMaterial({ THREE, shadowTexture, casterTexture, uViewRect, uShadowRect }) {
  // FUNCTION FORM for `dot`/`mix`, never the method chain. `dot` is symmetric
  // so it carries no receiver-order hazard itself, but this codebase has
  // already paid once for `a.mix(b,t)` silently meaning something other than
  // `mix(a,b,t)` (reference_tsl_method_chaining_trap) — the habit is cheaper
  // than re-learning which operators are safe to chain.
  const { uniform, texture, uv, vec2, vec3, vec4, float, mix, dot, Fn } = THREE.TSL;

  const shadowTexNode = texture(shadowTexture);
  const casterTexNode = texture(casterTexture);
  /** One-hot channel pick for the marched field. */
  const uShadowMask = uniform(vec4(1, 0, 0, 0));
  /** One-hot channel pick for the caster field. Exactly one of the two masks is
   * non-zero at a time, so their sum IS a selection — no branch, no gate. */
  const uCasterMask = uniform(vec4(0, 0, 0, 0));

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  material.fragmentNode = Fn(() => {
    const worldX = mix(uViewRect.x, uViewRect.z, uv().x);
    const worldY = mix(uViewRect.y, uViewRect.w, uv().y);
    const u = worldX.sub(uShadowRect.x).div(uShadowRect.z.sub(uShadowRect.x));
    const v = worldY.sub(uShadowRect.y).div(uShadowRect.w.sub(uShadowRect.y));
    const at = vec2(u.clamp(0, 1), v.clamp(0, 1));
    const value = dot(shadowTexNode.sample(at), uShadowMask).add(dot(casterTexNode.sample(at), uCasterMask));
    // WHITE = lit / present, BLACK = shadowed / absent. Greyscale on purpose:
    // the eye reads a value ramp far better in grey than in any false-colour
    // map, and "is this patch 0.3 or 0.6" is the actual question being asked.
    return vec4(vec3(value, value, value), float(1));
  })();

  return {
    material,
    setView(id) {
      const view = sunShadowDebugView(id);
      const s = view.shadow ?? [0, 0, 0, 0];
      const c = view.caster ?? [0, 0, 0, 0];
      uShadowMask.value.set(s[0], s[1], s[2], s[3]);
      uCasterMask.value.set(c[0], c[1], c[2], c[3]);
    },
    /** The caster texture is REBUILT on every field bake (a new DataTexture),
     * so the debug material must be re-pointed at the live one — capturing it
     * once would freeze this view on the first floor ever loaded. */
    setCasterTexture(tex) {
      casterTexNode.value = tex;
    },
  };
}
