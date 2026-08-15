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
 * PUBLISH MSA'S OWN DARKNESS BACK TO FOUNDRY — the only write in this reader.
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
 * authority]]` and it was not arbitrary — it named a real defect that any naive
 * write-back has: `world/environment.js#buildEnvSnapshot` folds Foundry's
 * darkness into its own as `max(nightDarkness, darknessInput)`. Write MSA's
 * OUTPUT into that INPUT and the max can never come back down — sweep the
 * astrolabe toward dawn and the scene stays pinned at midnight forever. That is
 * a genuine one-way ratchet, not a theoretical concern.
 *
 * WHAT CHANGED IS NOT THE AUTHOR'S MIND ABOUT ARCHITECTURE, IT IS THAT THE
 * RATCHET HAS A CLEAN FIX: remember exactly what we last published, and refuse
 * to treat that same value as an independent input when it comes back
 * (`darknessInputExcludingOwnEcho` below). MSA reads only genuine GM intent;
 * its own echo is subtracted before the fold ever sees it. That turns
 * "read-back loop" into "publish, and ignore your own publication" — which is
 * the ordinary way a renderer mirrors state into a host it does not own.
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
 * @param {number} darkness01 - MSA's own resolved darkness, 0..1.
 * @returns {{ok: boolean, published: number|null, reason: string|null}} — never
 *   throws, same posture as every reader here: a Foundry API surprise must not
 *   take a render frame down.
 */
export function publishSceneDarkness(darkness01) {
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
    env.initialize({ environment: { darknessLevel: clamped } });
    return { ok: true, published: clamped, reason: null };
  } catch (err) {
    return { ok: false, published: null, reason: `canvas.environment.initialize threw: ${err?.message ?? err}` };
  }
}

/**
 * THE ECHO GUARD — pure, so the one piece of logic that keeps the write-back
 * from becoming a feedback bus is Node-testable rather than only observable as
 * "the scene got stuck dark once."
 *
 * Given what Foundry currently reports and what MSA last published, decide what
 * `buildEnvSnapshot`'s `darknessInput` should actually be. If the two match,
 * Foundry is simply echoing us and there is NO independent input — return 0, so
 * `max(nightDarkness, darknessInput)` is driven purely by the sun. If they
 * differ, something else (the GM's own darkness slider, another module, a scene
 * load) genuinely set it, and that IS a real input we must honour.
 *
 * ⚠️ THE TOLERANCE IS NOT A FUDGE FACTOR. `publishSceneDarkness` clamps and
 * Foundry stores the value verbatim, so an exact `===` would very nearly work —
 * but `AlphaField`'s own cleaning and any round-trip through a document can
 * return a value that differs in the last bit, and a guard that fails open ONE
 * frame reintroduces the ratchet permanently (the max never comes back down).
 * A tolerance smaller than any darkness step a human can perceive costs nothing
 * and cannot be defeated by float noise. The failure mode it deliberately
 * accepts — a GM setting darkness to EXACTLY MSA's current value has their
 * setting ignored — is indistinguishable from honouring it, because the two
 * numbers are the same.
 *
 * @param {number} foundryDarkness01 - what `readSceneDarkness` just reported.
 * @param {number|null} lastPublished01 - what `publishSceneDarkness` last wrote
 *   successfully, or `null` if MSA has never published (a fresh session, or
 *   publishing disabled) — in which case every reading is genuine GM intent.
 * @returns {number} the darkness to feed `buildEnvSnapshot` as `darknessInput`.
 */
export function darknessInputExcludingOwnEcho(foundryDarkness01, lastPublished01) {
  const read = Number.isFinite(foundryDarkness01) ? Math.min(1, Math.max(0, foundryDarkness01)) : 0;
  if (!Number.isFinite(lastPublished01)) return read;
  return Math.abs(read - lastPublished01) <= DARKNESS_ECHO_EPSILON ? 0 : read;
}

/** See `darknessInputExcludingOwnEcho`'s own "THE TOLERANCE IS NOT A FUDGE
 *  FACTOR" note. ~1/2000 of the full range — far below a perceptible step. */
export const DARKNESS_ECHO_EPSILON = 5e-4;

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
