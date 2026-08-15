/**
 * THE SCENE-ENVIRONMENT READER — the one place a live Foundry session's
 * environment is read for the lighting model:
 *   - `canvas.scene.environment.darknessLevel` (v14 schema:
 *     `common/documents/scene.mjs:117`, an `AlphaField` — 0..1), and
 *   - the ambient colour palette `canvas.colors.{ambientDaylight,ambientDarkness,
 *     ambientBrightest}` (the endpoints Foundry's own `AdaptiveLighting` shaders
 *     mix from — `client/canvas/groups/environment.mjs`, read by every
 *     `BaseLightSource._updateCommonUniforms` as `canvas.colors.*`).
 *
 * `world/environment.js#buildEnvSnapshot` takes both as plain INPUTS
 * (`darknessInput`, `ambientInput`) precisely so the read lives here, behind
 * the `foundry/adapter-only` wall, and the pure snapshot builder never touches
 * a Foundry global — same one-way-input shape as every other `world/` consumer
 * of Foundry state.
 *
 * WHY READ THE ENDPOINTS, NOT `canvas.colors.background`: parity reproduces
 * Foundry's own ambient ladder (`foundry-v14-lighting-audit.md` §5a:
 * `background = mix(ambientDaylight, ambientDarkness, darknessLevel)`) inside
 * the light pass, so it needs the two endpoints (and the per-pixel darkness
 * field, once `_Outdoors` lands — increment 1b). Depending on the pre-mixed
 * scalar `background` would work at one darkness but could not go per-pixel.
 *
 * Split the same way `canvas-compositing.js` splits `decideArtSuppression`
 * (pure, Node-tested) from `readCompositingFacts` (impure, browser-only):
 * `deriveDarkness`/`deriveAmbient` are the testable logic, the `readScene*`
 * functions are the live gatherers around them. "Could not read" and "read a
 * real value" must stay distinguishable — collapsing them is the exact class of
 * lying instrument this project has already paid for once
 * (feedback_instruments_must_not_lie).
 *
 * @module foundry/scene-environment
 */

/**
 * Foundry's own fallback ambient colours, used when a live read fails — so a
 * missing palette reads as Foundry's DEFAULT look, never as black or white.
 * Verbatim from `EnvironmentCanvasGroup.#fallbackColors`
 * (`client/canvas/groups/environment.mjs`): daylight `#EEEEEE`, darkness
 * `#242448`, brightest `#FFFFFF`.
 * @type {{daylight: [number,number,number], darkness: [number,number,number], brightest: [number,number,number]}}
 */
export const FOUNDRY_FALLBACK_AMBIENT = Object.freeze({
  daylight: Object.freeze([0xee / 255, 0xee / 255, 0xee / 255]),
  darkness: Object.freeze([0x24 / 255, 0x24 / 255, 0x48 / 255]),
  brightest: Object.freeze([1, 1, 1]),
});

/**
 * @param {*} rawLevel - whatever `canvas.scene.environment.darknessLevel` was.
 * @param {boolean} sceneWasPresent - false if `canvas.scene` itself was absent.
 * @returns {{darkness01: number, source: 'scene'|'default', reason: string|null}}
 */
export function deriveDarkness(rawLevel, sceneWasPresent) {
  if (typeof rawLevel === 'number' && Number.isFinite(rawLevel)) {
    return { darkness01: Math.min(1, Math.max(0, rawLevel)), source: 'scene', reason: null };
  }
  return {
    darkness01: 0,
    source: 'default',
    reason: !sceneWasPresent
      ? 'no active scene (canvas.scene is absent) — reading as darkness:0, not guessed'
      : `environment.darknessLevel was ${JSON.stringify(rawLevel)}, not a finite number — reading as darkness:0`,
  };
}

/**
 * Live read. Never throws — a Foundry API surprise here must never take a
 * render frame down with it (same reasoning as `readCompositingFacts`).
 *
 * @returns {{darkness01: number, source: 'scene'|'default', reason: string|null}}
 */
export function readSceneDarkness() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    return deriveDarkness(scene?.environment?.darknessLevel, !!scene);
  } catch (err) {
    return {
      darkness01: 0,
      source: 'default',
      reason: `reading canvas.scene.environment.darknessLevel threw: ${err?.message ?? err}`,
    };
  }
}

/* -------------------------------------------- */
/*  Darkness WRITE-BACK (2026-08-15)            */
/* -------------------------------------------- */

/**
 * ============================================================================
 * PUBLISH MSA'S OWN DARKNESS TO FOUNDRY — the only write in this reader, and
 * MSA is now the SOLE authority on `darknessLevel`. It never reads Foundry's
 * copy back into its own computation.
 * ============================================================================
 *
 * ⚠️ THIS REVERSES A PREVIOUSLY-DOCUMENTED REFUSAL, ON THE AUTHOR'S OWN
 * INSTRUCTION (2026-08-15): *"When we change from day to night the scene gets
 * darker which is good but the actual 'scene darkness' value doesn't change.
 * We probably need to make sure that we accurately change the actual scene
 * darkness when time of day changes in case things in game systems depend on
 * knowing what the current brightness is."*
 *
 * The refusal was recorded in `[[feedback_foundry_darkness_gate_is_a_second_
 * authority]]`, and `docs/planning/Environment.md §2.2` names the exact reason
 * it existed: *"Darkness gets ONE direction of authority: an input we read, OR
 * a value we own and never read back."* Two months of dated V2 scars sit behind
 * that sentence (§0.3) — three separate incidents, one of them a read-back loop
 * that pinned the scene dark.
 *
 * ⚠️ THE FIRST CUT OF THIS FIX (same day) GOT THAT LAW WRONG, AND IT IS WORTH
 * RECORDING WHY RATHER THAN QUIETLY FIXING IT. It kept `world/environment.js`
 * reading Foundry's `darknessLevel` as a live INPUT (`max(nightDarkness,
 * darknessInput)`, the pre-existing V3 architecture — the FIRST branch of the
 * law's either/or) and ADDED a write on top — both directions at once, exactly
 * what §2.2 forbids. The write would have ratcheted darkness upward forever the
 * instant Foundry's echo fed back into the same fold, so that cut added an
 * "echo guard" (`darknessInputExcludingOwnEcho`, since deleted) — a
 * remember-what-I-last-said, ignore-it-when-it-comes-back guard flag. That is
 * structurally the SAME shape `world/day-clock.js`'s own header names as the
 * pattern this project moved away from on purpose: *"a feedback loop held
 * together by a guard flag... two modes with opposite READ directions and no
 * WRITE direction removes the loop by construction: there is no flag anyone can
 * forget, because there is nothing to guard."* A passing test that models one
 * ratchet scenario is not the same guarantee as removing the loop.
 *
 * THE ACTUAL FIX: MSA now OWNS darkness outright — the second branch of §2.2's
 * either/or, chosen because the author's own ask is for MSA's day/night to be
 * the thing "game systems" see. `world/environment.js#buildEnvSnapshot` no
 * longer receives a live `darknessInput` from this viewer at all (see
 * `vt-pan-viewer.js`'s own call site); `darkness01` is purely `nightDarkness`,
 * the sun model. `readSceneDarkness` below still runs, but ONLY to fill a
 * diagnostic report field (`foundryDarkness01` — "what does Foundry currently
 * hold, for comparison") — it is never again an argument to anything that
 * computes MSA's own darkness. Observing a value for a human to read is not the
 * same as folding it into your own output; only the second one is the loop.
 *
 * ⚠️ WHY THIS ALSO FIXES A SECOND, SEPARATELY-REPORTED BUG (*"Tokens which are
 * outside at noon believe they are currently in the dark… tokens seem to only
 * be able to 'see' point lights"*). Verified by reading
 * `client/canvas/groups/environment.mjs` in the vendored v14 source, not
 * assumed:
 *
 *   - `EnvironmentCanvasGroup#initialize` assigns
 *     `this.#darknessLevel = scene.environment.darknessLevel = dl` — so the
 *     value game systems read off the scene genuinely moves (bug 1), and
 *   - it then calls `canvas.perception.update({refreshPrimary: true,
 *     refreshLighting: true, refreshVision: true})` — so every token's vision
 *     is re-evaluated against the new darkness (bug 2), and
 *   - `#configureGlobalLight` re-initialises the scene's `GlobalLightSource`,
 *     whose own darkness activation window is what decides whether the map has
 *     ambient daylight at all. With darkness frozen at whatever the document
 *     happened to say, that window's verdict was frozen too — which is exactly
 *     "it is noon on the astrolabe and Foundry still thinks it is night."
 *
 * ⚠️ CLIENT-LOCAL, NOT PERSISTED. This calls `canvas.environment.initialize`,
 * NEVER `scene.update()`. The distinction is load-bearing: `scene.update()` is
 * a document write that broadcasts to every connected client and writes to
 * disk, and MSA's aesthetic clock is a LOCAL viewing preference — persisting it
 * would have one GM's astrolabe drag rewrite the saved scene for everybody.
 * `foundry/camera-path-player.js#writeDarkness01` deliberately does use
 * `scene.update()`, because a camera path is an authored, shared artifact; this
 * is not.
 *
 * ⚠️ THROTTLED BY THE CALLER, AND IT MUST BE. `initialize()` ends in a
 * `refreshLighting + refreshVision` perception update — Foundry re-running its
 * own lighting and every token's vision polygons. Calling this per frame during
 * an astrolabe sweep would be a self-inflicted performance bug of exactly the
 * kind mission priority #1 exists to prevent. See `shouldPublishDarkness`.
 *
 * ⚠️ `globalLightWindow` IS CARRIED IN THIS **SAME** CALL, NOT A SECOND ONE —
 * AND THAT IS NOT COSMETIC, IT IS A FIX FOR A REAL BUG THIS PROJECT'S OWN
 * LIVE HARNESS CAUGHT (2026-08-15, `tests/playwright/msa-global-light-
 * writeback.spec.js`). The first cut of the Global Illumination fix
 * (`deriveGlobalLightWindow`'s own section below) called `canvas.environment.
 * initialize()` a SECOND time, separately, with its own `{environment:
 * {globalLight}}` payload. `#configureEnvironment`'s merge
 * (`mergeObject(environment, currentEnvironment, {overwrite:false,
 * insertKeys:true})`, verified against source) fills in any key ABSENT from
 * the passed `environment` object from the scene document's OWN stale value —
 * so every time THIS function's own call fired without `globalLight` in its
 * payload (i.e. every single darkness publish, which happens up to 4×/sec
 * during any sweep), it silently stomped the OTHER function's just-published
 * window back to the scene's raw, GM-authored `{enabled:false}`. A live probe
 * proved it: `globalLightSource.active` was flapping true→(stomped)→true
 * within the same second, invisible to a diagnostic that only ever checked
 * "did the last publish attempt succeed" (it had — the STOMP was a different,
 * unrelated successful publish). Two independent writers touching the same
 * merge target is the exact "one direction of authority" violation this
 * project's darkness design already learned the hard way once (this
 * function's own header, above) — the fix is the same shape: ONE call carries
 * every fact that needs to survive it, not two calls racing each other.
 *
 * @param {number} darkness01 - MSA's own resolved darkness, 0..1.
 * @param {{enabled: boolean, max: number|null}|null} [globalLightWindow] -
 *   `deriveGlobalLightWindow`'s result, or omitted/null to leave
 *   `globalLight` out of this call entirely (falls through to the scene's own
 *   current value via Foundry's own merge — used when the caller has no
 *   opinion, never when it wants "off": pass `{enabled:false, max:null}`
 *   explicitly for that).
 * @returns {{ok: boolean, published: number|null, reason: string|null}} — never
 *   throws, same posture as every reader here: a Foundry API surprise must not
 *   take a render frame down.
 */
export function publishSceneDarkness(darkness01, globalLightWindow) {
  const value = Number(darkness01);
  if (!Number.isFinite(value)) {
    return { ok: false, published: null, reason: `darkness01 was ${JSON.stringify(darkness01)}, not a finite number` };
  }
  const clamped = Math.min(1, Math.max(0, value));
  try {
    const env = typeof canvas !== 'undefined' ? (canvas?.environment ?? null) : null;
    if (!env || typeof env.initialize !== 'function') {
      return { ok: false, published: null, reason: 'canvas.environment.initialize is unavailable' };
    }
    const environment = { darknessLevel: clamped };
    if (globalLightWindow) {
      environment.globalLight = globalLightWindow.enabled
        ? { enabled: true, darkness: { min: 0, max: globalLightWindow.max } }
        : { enabled: false };
    }
    env.initialize({ environment });
    return { ok: true, published: clamped, reason: null };
  } catch (err) {
    return { ok: false, published: null, reason: `canvas.environment.initialize threw: ${err?.message ?? err}` };
  }
}

/**
 * How much darkness must move before it is worth paying Foundry's own
 * `refreshLighting + refreshVision` for, and how often at most.
 *
 * ⚠️ BOTH GATES ARE NEEDED, AND THEY STOP DIFFERENT THINGS. The STEP stops a
 * frozen clock from republishing forever (MSA's darkness is a float off a sun
 * model — it is never bit-identical frame to frame, so an equality check alone
 * would publish every frame at a standstill). The INTERVAL stops a fast
 * astrolabe sweep from firing a perception update every frame while the value
 * genuinely IS changing that fast. Either alone leaves the other case open.
 *
 * 1/64 is finer than Foundry's own darkness slider steps and far finer than any
 * visible lighting change; 250 ms means a sweep publishes at most 4×/sec, which
 * is a smooth ramp to the eye and a rounding error to the frame budget.
 */
export const DARKNESS_PUBLISH_STEP = 1 / 64;
export const DARKNESS_PUBLISH_MIN_INTERVAL_MS = 250;

/**
 * Decide whether to publish this frame — pure, for the same reason the echo
 * guard is: a throttle that silently never fires is a feature that silently
 * never works, and this way that is a red test rather than a live mystery.
 *
 * @param {object} args
 * @param {number} args.darkness01 - MSA's current resolved darkness.
 * @param {number|null} args.lastPublished01 - last successfully published value, or null.
 * @param {number} args.nowMs @param {number} args.lastPublishedAtMs
 * @returns {boolean}
 */
export function shouldPublishDarkness({ darkness01, lastPublished01, nowMs, lastPublishedAtMs }) {
  if (!Number.isFinite(darkness01)) return false;
  // NEVER PUBLISHED YET ⇒ always publish, ignoring the interval. Otherwise a
  // scene that loads and sits still keeps Foundry on the document's stale value
  // until the author happens to move something — the exact "it's noon and the
  // tokens are in the dark" symptom, just delayed.
  if (!Number.isFinite(lastPublished01)) return true;
  if (Math.abs(darkness01 - lastPublished01) < DARKNESS_PUBLISH_STEP) return false;
  return nowMs - lastPublishedAtMs >= DARKNESS_PUBLISH_MIN_INTERVAL_MS;
}

/* -------------------------------------------- */
/*  Global Illumination WRITE-BACK (2026-08-15) */
/* -------------------------------------------- */

/**
 * ============================================================================
 * WHY THIS EXISTS: `publishSceneDarkness` ABOVE claims to fix "a token
 * standing outside at noon believes it is in the dark" — and it does fix ONE
 * real, necessary half of that bug. It does not fix the whole thing.
 * ============================================================================
 *
 * Verified against the CURRENT vendored v14 source
 * (`client/canvas/groups/environment.mjs#configureGlobalLight`,
 * `client/canvas/groups/effects.mjs#testInsideLight`,
 * `client/canvas/sources/base-effect-source.mjs#active`,
 * `common/documents/scene.mjs`'s `environment.globalLight` schema), not
 * assumed from the comment above this one:
 *
 *   `configureGlobalLight` computes `disabled: !globalLight.enabled` FIRST,
 *   independently of any darkness value, and `BaseEffectSource#active` is
 *   `attached && !disabled && !suppressed`. `testInsideLight`'s own darkness-
 *   window check (`if (globalLightSource.active) { const {min,max} = ...;
 *   if (darknessLevel >= min && darknessLevel <= max) return true; }`) is
 *   INSIDE that `if`, so it is never even reached while `enabled` is false —
 *   at ANY darkness level, including a correctly-published 0 at noon.
 *   `environment.globalLight.enabled` schema-defaults to `false`
 *   (`common/documents/scene.mjs:120`), and confirmed live against the actual
 *   bench Mansion scene export (`tests/playwright-artifacts/look/mansion-
 *   redux-remapped.json`): `environment.globalLight.enabled === false`,
 *   never touched by any GM authoring. So a token with no personal
 *   `sight.range` and no nearby real light — `CanvasVisibility#testVisibility`
 *   routes 2/3b, `docs/reference/foundry-v14-vision-darkness-audit.md` §2 —
 *   stays exactly as blind at a correctly-published noon as it was before
 *   that fix, on every scene, until `enabled` ALSO becomes true. This file's
 *   OWN prior write-back comment ("that window's verdict was frozen too")
 *   is the plausible-but-incomplete diagnosis this project's own
 *   `feedback_plausible_diagnosis_rots` names — real progress, not the full
 *   answer; left uncorrected above so the history stays honest, fixed here.
 *
 * ⚠️ WHY NOT JUST FLIP `enabled: true` SCENE-WIDE. Once active, the window
 * check runs for EVERY point in the scene, not just true outdoor space —
 * `getDarknessLevel(point)` (`effects.mjs`) samples a darkness-adjusting
 * REGION's own mesh first and only falls back to the scene's global scalar
 * where no region covers that point. The actual bench Mansion scene protects
 * its interior with exactly that mechanism — two `adjustDarknessLevel`
 * regions (one per floor, `mode:DARKEN, modifier:0.5`, confirmed by reading
 * the scene export directly) — meaning indoor floors never read darker-
 * friendly than 0.5 no matter the hour. Foundry's own DEFAULT window is
 * `{min:0,max:1}` — the ENTIRE range — so turning Global Illumination on
 * with that default would ALSO satisfy the window everywhere indoors,
 * silently erasing every dark room's need for a torch. That is not a
 * cosmetic regression: an over-lit indoor room a player's token can suddenly
 * "see" into is exactly mission priority #2 (secrets safe from players).
 *
 * THE FIX: derive the window's `max` from the darkest-at-noon floor any
 * currently-active region actually authors (`region-geometry.js#
 * computeMinimumDarknessFloor` — the SAME formula Foundry's own region mesh
 * applies, reused rather than re-derived), then stay strictly below it. Any
 * region-protected interior point NEVER qualifies, at any hour, by
 * construction — this can only ever WIDEN outdoor daylight vision, never
 * narrow indoor protection relative to today. If a scene has NO active
 * darkness-adjusting region at all, there is no signal to safely bound a
 * window against, so this deliberately does nothing (`enabled:false`) rather
 * than guess — the SAFETY SLIDE default (`feedback_safety_slide_outranks_
 * doctrine`): uncertain ⇒ fall back to Foundry's own prior behavior, not a
 * new one.
 *
 * ⚠️ THE ONE THING THIS CANNOT SEE: a room that is dark ONLY via MSA's own
 * painted `_Outdoors`/indoor mask (a rendering-only concept with no Foundry
 * Region backing at all) gets NO protection here, same as it gets none
 * today — Foundry's vision system has never been able to read that mask, and
 * this fix does not change that. Such a room would newly read as daylight-
 * visible to Foundry's OWN vision/fog system whenever MSA's outdoor scalar
 * says "day", even though MSA's own WebGPU rendering still paints it dark.
 * Whether the bench Mansion's two multi-shape regions cover EVERY room that
 * needs protecting, or only some, is a fact about authored content this
 * file cannot verify by reading code — worth the author's own eyes (or a
 * quick pixel-probe check of an unregioned interior room) before trusting
 * this fully indoors, per this project's own `BUILT (unverified) vs LIVE`
 * rule. The outdoor-at-noon half is what was reported broken, and that half
 * is safe by construction regardless of how this question resolves.
 *
 * ⚠️ THERE IS NO SEPARATE `publishGlobalLightWindow` HERE, ON PURPOSE. An
 * earlier cut of this fix had one — a second, independent
 * `canvas.environment.initialize()` call with its own `{globalLight}`
 * payload. Live-tested (same session) and found to silently STOMP itself:
 * see `publishSceneDarkness`'s own header, "`globalLightWindow` IS CARRIED IN
 * THIS SAME CALL", for the full mechanism. The window this section derives is
 * PUBLISHED by `publishSceneDarkness` alongside darkness — this section only
 * computes the value now, it does not write it.
 */

/**
 * How dark it can get before Global Illumination stops granting ambient
 * daylight vision. The window is `[0, max]` and Foundry compares it against
 * the PER-POINT darkness (`getDarknessLevel`), so this one scalar has to sit
 * ABOVE outdoor daylight and BELOW an authored dark interior.
 *
 * 0.25 = "a quarter of the way to pitch black". Noon outdoors is 0, so
 * daylight vision holds through morning/afternoon and switches off around
 * dusk, which is when torches become the point. The bench Mansion's own
 * authored interiors sit at 0.5 (`DARKEN, modifier 0.5`), comfortably above
 * this, so they stay protected — and any interior darker than the window is
 * ERASED from global light by Foundry itself (`CanvasVisibility#
 * refreshDynamicIllumination`, verified in the vendored v14 source: meshes
 * whose darkness falls outside `[min,max]` get `BLEND_MODES.ERASE`).
 */
export const GLOBAL_LIGHT_DAYLIGHT_MAX = 0.25;

/**
 * Pure derivation — see this section's own header for the full reasoning.
 *
 * ⚠️ REWRITTEN 2026-08-15, SAME DAY, AFTER THE AUTHOR RE-REPORTED THE
 * ORIGINAL SYMPTOM: *"I have a token, outside, scene darkness is 0, time of
 * day is noon and the only area that is visible when I select them is a
 * point light nearby, not the majority of the scene."* The first cut of this
 * function returned `{enabled:false}` — i.e. DID NOTHING AT ALL — in two
 * cases that between them cover most real scenes:
 *
 *   1. **No darkness-adjusting regions on the scene** (`minRegionFloor ===
 *      null`). Nearly every Foundry scene has zero Regions. The first cut
 *      called this the "SAFETY SLIDE default" — but a safety default that
 *      makes the reported bug reproduce verbatim is not safety, it is the
 *      bug. It also made the feature's existence depend on an unrelated
 *      authoring choice nobody would connect to "can my token see outside".
 *   2. **A region whose floor computed to ~0** — see
 *      `computeMinimumDarknessFloor`, fixed alongside this.
 *
 * THE CORRECTION IS ALSO A SIMPLIFICATION, and that is the real lesson:
 * Foundry ALREADY does per-region protection by itself, both for rendering
 * (the `ERASE` blend above) and for the vision test (`testInsideLight` calls
 * `getDarknessLevel(point)`, which samples the REGION's own mesh before
 * falling back to the scene scalar). So this never needed to derive
 * permission from the regions — it only needs to put the threshold in the
 * right place and let Foundry's own mechanism do the per-area work. The
 * region floor is now a CLAMP (keep the window under an unusually-shallow
 * authored interior), not a precondition.
 *
 * @param {number|null} minRegionFloor - `computeMinimumDarknessFloor`'s
 *   result, or null when no region makes a darkness claim. Only ever narrows
 *   the window; never decides whether there is one.
 * @returns {{enabled: boolean, max: number}} always enabled — the WINDOW,
 *   compared against live darkness, is what turns daylight off at night, so
 *   there is no case where the source itself needs disabling.
 */
export function deriveGlobalLightWindow(minRegionFloor) {
  let max = GLOBAL_LIGHT_DAYLIGHT_MAX;
  if (Number.isFinite(minRegionFloor)) {
    // Stay strictly under an authored interior, margined by the same step the
    // darkness publish uses — reused rather than inventing a second "how much
    // darkness difference matters" constant; it exists for the identical
    // reason here (float noise, and the sun sweeping exactly THROUGH the
    // boundary, must not flicker the verdict).
    max = Math.min(max, minRegionFloor - DARKNESS_PUBLISH_STEP);
  }
  // A clamp to exactly 0 is still a USEFUL window, not a broken one: it admits
  // a point whose darkness is 0, which is precisely noon outdoors. The first
  // cut treated `max <= 0` as "give up", which threw away the one case the
  // author was actually testing.
  return { enabled: true, max: Math.min(1, Math.max(0, max)) };
}

/**
 * Live read of what Foundry is holding RIGHT NOW for Global Illumination —
 * independent of anything MSA remembers publishing, same reasoning as
 * `readSceneDarkness` vs `lastPublishedDarkness01` (a diagnostics report needs
 * "what we sent" and "what's actually there" as two separate facts, or a
 * silently-ignored write reads identically to a successful one). Never
 * throws.
 *
 * ⚠️ `enabled`/`min`/`max` READ THE SCENE DOCUMENT (`environment.globalLight`)
 * — live-verified (2026-08-15, `tests/playwright/msa-global-light-writeback.
 * spec.js`) to stay exactly as GM-authored (`enabled:false` on the bench
 * scene) EVEN WHILE this fix is correctly working, because — unlike
 * `darknessLevel`, which `EnvironmentCanvasGroup#initialize` explicitly
 * assigns back onto `scene.environment.darknessLevel` — Foundry's own
 * `#configureGlobalLight` never writes `globalLight` back onto the scene
 * document at all; it only feeds the merged, client-local config into
 * `this.globalLightSource.initialize(...)`. So these three fields answer "what
 * did the GM author / what would a fresh load show", not "is this working
 * right now" — that second question is `active`, confirmed live to correctly
 * track the derived window (true at noon, false at midnight on the bench
 * scene). Reporting only the document fields here would have been exactly
 * the lying-instrument trap this project's own `feedback_instruments_must_
 * not_lie` names — a report saying "enabled: false" while vision was
 * correctly working would send a future reader chasing a bug that isn't one.
 *
 * @returns {{enabled: boolean|null, min: number|null, max: number|null, active: boolean|null}}
 */
export function readSceneGlobalLightRaw() {
  try {
    const g = typeof canvas !== 'undefined' ? (canvas?.scene?.environment?.globalLight ?? null) : null;
    const src = typeof canvas !== 'undefined' ? (canvas?.environment?.globalLightSource ?? null) : null;
    // THE LIVE SOURCE's own state — what Foundry is ACTUALLY deciding with
    // right now, as opposed to the document fields above (which this fix never
    // writes and which therefore never move). `liveMax`/`liveDisabled` are what
    // `shouldPublishGlobalLightWindow` uses to notice that something else
    // re-initialised the environment and wiped our window.
    const live = {
      active: src?.active ?? null,
      liveDisabled: src?.data?.disabled ?? null,
      liveMin: Number.isFinite(src?.data?.darkness?.min) ? src.data.darkness.min : null,
      liveMax: Number.isFinite(src?.data?.darkness?.max) ? src.data.darkness.max : null,
    };
    if (!g) return { enabled: null, min: null, max: null, ...live };
    return {
      enabled: typeof g.enabled === 'boolean' ? g.enabled : null,
      min: Number.isFinite(g.darkness?.min) ? g.darkness.min : null,
      max: Number.isFinite(g.darkness?.max) ? g.darkness.max : null,
      ...live,
    };
  } catch {
    return { enabled: null, min: null, max: null, active: null, liveDisabled: null, liveMin: null, liveMax: null };
  }
}

/**
 * Did the DERIVED window change since the last publish? Used by the caller as
 * an extra OR term alongside `shouldPublishDarkness` — `publishSceneDarkness`
 * carries both facts in ONE call now (see its own header for why a separate
 * call was a real, live-caught bug), so a fresh window value needs to force
 * that combined publish even on a frame where darkness01 itself hasn't moved
 * enough to trigger `shouldPublishDarkness` on its own (e.g. a GM edits a
 * region's modifier while time of day sits still). Unlike darkness (a
 * continuously-sweeping float), the region set behind this value is static
 * almost all the time, so THIS half throttles on CHANGE alone, not time —
 * publishing once and then staying silent is correct here, not a bug
 * (contrast `shouldPublishDarkness`, where silence after one publish WAS the
 * bug — see that function's own header).
 *
 * ⚠️ IT ALSO REPAIRS DRIFT, AND IT HAS TO. A change-only throttle silently
 * assumes nobody else writes this value — and that assumption is false:
 * `canvas.environment.initialize()` is called by Foundry itself (a Scene
 * Config save, `animateDarkness`, any module doing the same), and
 * `#configureEnvironment` rebuilds `globalLight` from the SCENE DOCUMENT,
 * where `enabled` is still the GM-authored `false`. That silently wipes our
 * window, and a throttle comparing only our own last-derived value against
 * our own current one would never notice — the feature would work until the
 * first unrelated environment refresh and then be off forever, which is
 * indistinguishable from "the fix doesn't work". So `live` (what Foundry is
 * ACTUALLY holding) is compared too, and a disagreement re-asserts.
 *
 * This is NOT the read-back loop `docs/planning/Environment.md §2.2` forbids:
 * `live` never enters what MSA COMPUTES (`deriveGlobalLightWindow` is a pure
 * function of the region floor). It only answers "did the value I already
 * decided actually land?" — observing an output to re-assert it is not the
 * same as folding it into the input, which is the distinction
 * `publishSceneDarkness`'s own header already draws for `foundryDarkness01`.
 *
 * RATE-LIMITED, because a republish costs Foundry's own `refreshLighting +
 * refreshVision`. If something genuinely fights us every frame, this settles
 * to at most one re-assert per `DARKNESS_PUBLISH_MIN_INTERVAL_MS` instead of
 * a per-frame perception storm (mission priority #1).
 *
 * @param {{enabled: boolean, max: number}} next - this frame's derived window.
 * @param {{enabled: boolean, max: number}|null} last - the last PUBLISHED window, or null if never.
 * @param {{liveDisabled: boolean|null, liveMax: number|null}} [live] - what
 *   Foundry currently holds (`readSceneGlobalLightRaw`). Omit to skip drift repair.
 * @param {number} [nowMs] @param {number} [lastPublishedAtMs] - rate limit for the drift path only.
 * @returns {boolean}
 */
export function shouldPublishGlobalLightWindow(next, last, live, nowMs, lastPublishedAtMs) {
  if (!last) return true;
  if (next.enabled !== last.enabled) return true;
  if (Math.abs((next.max ?? 0) - (last.max ?? 0)) >= DARKNESS_PUBLISH_STEP) return true;

  if (!live) return false;
  const liveEnabled = live.liveDisabled === null || live.liveDisabled === undefined ? null : !live.liveDisabled;
  const enabledDrifted = liveEnabled !== null && liveEnabled !== next.enabled;
  const maxDrifted = Number.isFinite(live.liveMax) && Math.abs(live.liveMax - (next.max ?? 0)) >= DARKNESS_PUBLISH_STEP;
  if (!enabledDrifted && !maxDrifted) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastPublishedAtMs)) return true;
  return nowMs - lastPublishedAtMs >= DARKNESS_PUBLISH_MIN_INTERVAL_MS;
}

/* -------------------------------------------- */
/*  Ambient palette                             */
/* -------------------------------------------- */

/** @param {*} c @returns {[number,number,number]|null} a finite, clamped rgb triple, or null */
function validRgb(c) {
  if (!Array.isArray(c) || c.length < 3) return null;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number(c[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/**
 * Fold three raw rgb triples (each possibly missing) into the ambient palette
 * the snapshot carries. A missing/invalid endpoint falls back to Foundry's own
 * default for THAT endpoint (never a blanket black/white), and the reason names
 * which endpoints were defaulted — "could not read daylight" must not read the
 * same as "daylight happened to be #EEEEEE".
 *
 * @param {{daylight?: *, darkness?: *, brightest?: *}} raw - already-extracted
 *   rgb triples (Color→rgb done by the live reader, so this stays Node-pure).
 * @param {boolean} sceneWasPresent - false if `canvas`/`canvas.colors` was absent.
 * @returns {{daylight: [number,number,number], darkness: [number,number,number],
 *   brightest: [number,number,number], source: 'scene'|'partial'|'default', reason: string|null}}
 */
export function deriveAmbient(raw, sceneWasPresent) {
  const fb = FOUNDRY_FALLBACK_AMBIENT;
  const daylight = validRgb(raw?.daylight);
  const darkness = validRgb(raw?.darkness);
  const brightest = validRgb(raw?.brightest);
  const defaulted = [];
  if (!daylight) defaulted.push('daylight');
  if (!darkness) defaulted.push('darkness');
  if (!brightest) defaulted.push('brightest');

  let source;
  let reason;
  if (!sceneWasPresent) {
    source = 'default';
    reason = 'no active scene (canvas.colors absent) — ambient reads as Foundry fallback palette';
  } else if (defaulted.length === 0) {
    source = 'scene';
    reason = null;
  } else if (defaulted.length === 3) {
    source = 'default';
    reason = 'canvas.colors had no valid ambient endpoints — using Foundry fallback palette';
  } else {
    source = 'partial';
    reason = `defaulted endpoint(s) [${defaulted.join(', ')}] to Foundry fallback; others read live`;
  }

  return {
    daylight: daylight ?? [...fb.daylight],
    darkness: darkness ?? [...fb.darkness],
    brightest: brightest ?? [...fb.brightest],
    source,
    reason,
  };
}

/**
 * Live read of Foundry's ambient palette. Never throws — a Foundry API surprise
 * here must never take a render frame down (same reasoning as
 * `readSceneDarkness`). `Color#rgb` is Foundry's own [r,g,b] 0..1 getter
 * (`common/utils/color.mjs`).
 *
 * @returns {ReturnType<typeof deriveAmbient>}
 */
export function readSceneAmbient() {
  try {
    const colors = typeof canvas !== 'undefined' ? (canvas?.colors ?? null) : null;
    return deriveAmbient(
      {
        daylight: colors?.ambientDaylight?.rgb,
        darkness: colors?.ambientDarkness?.rgb,
        brightest: colors?.ambientBrightest?.rgb,
      },
      !!colors
    );
  } catch (err) {
    return {
      ...deriveAmbient({}, false),
      reason: `reading canvas.colors ambient palette threw: ${err?.message ?? err}`,
    };
  }
}
