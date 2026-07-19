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
