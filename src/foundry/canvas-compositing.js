/**
 * THE INTERFACE SEAM — MSA owns the ART, Foundry's PIXI keeps the CHROME.
 *
 * ============================================================================
 * THE FINDING (2026-07-17): Foundry already draws the line we need.
 * ============================================================================
 *
 * `CONFIG.Canvas.layers` (client/config.mjs:703) assigns every canvas layer to
 * a group, and the split is exact:
 *
 *   primary   -> the ART. Every token/tile/background sprite. (+ `weather`)
 *   effects   -> lighting, vision, darkness
 *   interface -> tokens, tiles, walls, grid, controls, notes, lighting,
 *                drawings, templates, regions, sounds — EVERY interactive layer
 *
 * And `Token#_draw` (placeables/token.mjs:1211) splits one object down the
 * same line:
 *
 *     this.mesh = canvas.primary.addToken(this);           // ART   -> primary
 *     this.border ||= this.addChild(new PIXI.Graphics());  // CHROME -> interface
 *
 * The token's PICTURE goes to `primary`. Its selection border, bars, target
 * pips and hit area stay on the Token, in `interface`. So MSA replaces
 * `primary` + `effects` and leaves `interface` alone — that is not a clever
 * trick, it is Foundry's own architecture.
 *
 * ============================================================================
 * WHY THIS IS NOT V2's BLUNDER (Engine-Postmortem.md §1)
 * ============================================================================
 *
 * V2's root blunder was NOT "PIXI and Three coexist". It was TWO RENDERERS,
 * BOTH AUTHORITATIVE FOR THE SAME PICTURE — both drew the scene art, so 1,838
 * lines existed purely to make them agree, and they still did not.
 *
 * Here the two renderers draw DISJOINT SETS. There is no shared picture, so
 * there is nothing to reconcile and no sync code to write. `interaction-
 * manager.js`'s 8,955 lines of re-implemented selection stay dead. Same move as
 * mirroring `canvas.stage` instead of owning a camera (keyhole-input-model-
 * decision), applied to OUTPUT instead of input.
 *
 * >>> If you ever find yourself writing code to keep MSA and PIXI in agreement
 * >>> about a pixel, STOP. You are re-growing frame-coordinator.js. They must
 * >>> never draw the same thing.
 *
 * ============================================================================
 * THE BUG THIS FIXES
 * ============================================================================
 *
 * MSA's canvas was `zIndex: 5`, `background: #000` (OPAQUE), mounted as a
 * sibling of `canvas#board` (which is `z-index: var(--z-index-canvas)` = 0,
 * verified foundry2.css:15108). So MSA sat ON TOP of the entire PIXI canvas:
 *
 *   - INPUT worked. `pointer-events: none` let clicks through; Foundry
 *     hit-tested; documents updated. Selection genuinely functioned.
 *   - OUTPUT was dead. Selection borders, control icons, walls, grid, rulers,
 *     targets, door controls and drag previews all render into `#board` —
 *     behind an opaque black canvas. Invisible.
 *
 * Keyhole.md said "token selection may not need building at all (Foundry
 * hit-tests)". True, and only half the question: it answers where the CLICK
 * goes and never asks where the BORDER gets drawn.
 *
 * ============================================================================
 * THE MECHANISM — all public API, all source-verified, no monkey-patching
 * ============================================================================
 *
 * 1. `canvasConfig` (board.mjs:723) fires `Hooks.callAll("canvasConfig", config)`
 *    on a MUTABLE options object immediately before `new PIXI.Application`.
 *    We set `backgroundAlpha = 0` there.
 *
 *    ⚠️ THIS HOOK IS THE ONLY CHANCE, EVER. PIXI's ContextSystem.init
 *    (pixi.js 7.4.3, dist/pixi.js:5535) derives the GL context's `alpha`
 *    attribute from the background alpha AT CONTEXT CREATION:
 *
 *        const alpha = this.renderer.background.alpha < 1;
 *        ... this.initFromOptions({ alpha, ... })
 *
 *    WebGL context attributes are immutable after creation. Set
 *    `backgroundAlpha` later and the context is already `alpha: false` — the
 *    canvas is opaque for the rest of the session and NOTHING can fix it.
 *
 *    (Foundry's own `transparent: false` on board.mjs:717 is VESTIGIAL: PIXI v7
 *    removed `transparent`; BackgroundSystem.init reads only `backgroundAlpha`.
 *    Do not "fix" it by setting `transparent: true` — it is not read.)
 *
 * 2. `initializeCanvasEnvironment` (groups/environment.mjs:201) — THE TRAP, and
 *    it would have been vicious to diagnose live. `EnvironmentCanvasGroup#
 *    initialize()` line 179 does:
 *
 *        canvas.app.renderer.background.color = this.colors.rendererBackground;
 *
 *    PIXI's `set color` -> `Color#setValue` -> `set value` -> `normalize()`
 *    (dist/pixi.js:1695-1711), and for a bare number `a2 = 1` is FORCED into
 *    the alpha component; for a Color instance the components (incl. alpha) are
 *    copied wholesale. Line 1527 only skips this when the colour is UNCHANGED.
 *
 *    So Foundry RESETS our clear alpha to 1 whenever the environment background
 *    colour changes — scene load, darkness change, a lighting preview. The
 *    canvas would go transparent at boot and silently turn opaque the first
 *    time the sun set. `initializeCanvasEnvironment` fires as the LAST statement
 *    of that same `initialize()` (line 201, right after line 179), so it is the
 *    exact, public, source-verified place to re-assert.
 *
 *    This is NOT frame-coordinator sync code: it is one idempotent assignment
 *    reacting to one named event that provably clobbers one field. It does not
 *    reconcile two sources of truth — Foundry remains the only owner of the
 *    clear colour; we own one channel of it.
 *
 * 3. Suppress `primary` + `effects` WITHOUT freezing `primary`'s internal
 *    cache (rewritten 2026-08-13 — see "THE PRIMARY-CACHE-FREEZE FIX" below
 *    for why the original single-lever version broke Foundry's own fog
 *    shader). Two separate, more surgical moves:
 *
 *      canvas.primary.sprite.renderable = false;   // hides primary's OUTPUT only
 *      canvas.effects.renderable = false;           // effects has no cache to protect
 *
 *    `primary` itself (and hence `CachedContainer#render`'s cache-refresh
 *    half — containers/advanced/cached-container.mjs:209-221) is left
 *    running every frame. `primary` already sets `eventMode = "none"`
 *    (groups/primary.mjs:36) so nothing hit-tests through it regardless of
 *    which lever suppresses it. `renderable` (not `visible`), same reason as
 *    always: PIXI's EventBoundary skips INVISIBLE subtrees when hit-testing,
 *    and we must never disturb hit-testing.
 *
 * 4. MSA's canvas drops `pointer-events: none` and stacks BELOW `#board`. The
 *    hack becomes unnecessary: a canvas underneath cannot swallow a click.
 *
 * ============================================================================
 * THE PRIMARY-CACHE-FREEZE FIX (2026-08-13) — why §3 changed from one lever
 * to two, source-verified line-by-line, not guessed
 * ============================================================================
 *
 * The original version of this file suppressed with one assignment:
 * `canvas.environment.renderable = false`. `canvas.environment` is the
 * literal PIXI PARENT of `canvas.primary` (groups/environment.mjs:21, "A
 * container group which contains the primary canvas group and the effects
 * canvas group"), and neither it nor `CanvasGroupMixin` override `render()` —
 * it is the stock `PIXI.Container#render()`, which early-returns on
 * `!this.renderable` BEFORE walking `this.children`. So suppressing the
 * PARENT didn't just hide `canvas.primary` — it meant PIXI never called
 * `canvas.primary.render(renderer)` AT ALL.
 *
 * `canvas.primary` is a `CachedContainer` (groups/primary.mjs:29,
 * `PrimaryCanvasGroup extends CanvasGroupMixin(CachedContainer)`), and
 * `CachedContainer#render()` is where its children (background/tiles/
 * tokens/weather) get re-rendered into `canvas.primary.renderTexture` — an
 * internal cache, gated by that SAME `!renderable` early-return. Never
 * reached ⇒ that render texture froze solid at whatever it held the instant
 * suppression engaged (effectively scene boot), and nothing about that was
 * visible... until Foundry's OWN fog-of-war shader turned out to depend on
 * it: `CanvasVisibility#_draw()` builds its `VisibilityFilter` with
 * `primaryTexture: canvas.primary.renderTexture` (groups/visibility.mjs:336),
 * and the fragment shader's "explored, not-currently-visible" fog zone
 * (rendering/filters/visibility.mjs:140,149) blends 50% of that frozen
 * snapshot UNDER whatever MSA renders live. Because the shader samples it in
 * screen space (`filterMaskTextureCoord`, same file:91), not world space, the
 * frozen snapshot fills the current viewport regardless of camera position —
 * it reads as a second, camera-locked copy of the map ghosted under MSA's
 * own correctly camera-tracked render. Author-reported 2026-08-13 ("I see a
 * double set of albedos and one of them moves... the other one stays
 * still"), traced to here, tracked as Bug #18 in `docs/planning/
 * Bug-Tracker.md`. Full source trail: memory
 * `keyhole-fog-shader-primary-texture-freeze`.
 *
 * Nobody had exercised this path before, because `canvas.visibility.visible`
 * (the whole group this filter lives in) only goes true once a vision
 * source is active (groups/visibility.mjs:489) — a GM with no controlled
 * token never rendered it, which is how almost every prior live-testing
 * session was conducted.
 *
 * The fix: split "keep the cache fresh" from "show the cache on screen".
 * `CachedContainer#render()` already has this split built in — an
 * unconditional `this.#sprite?.render(renderer)` blit (the normal on-screen
 * path) plus a SEPARATE `displayed`-gated raw re-render (default `false`,
 * unused here). Suppressing the bound `sprite`'s OWN `renderable` stops only
 * the blit; `canvas.primary`'s own `renderable` stays `true` (its default),
 * so the cache-refresh block keeps running every frame, feeding Foundry's
 * fog shader (and anything else that reads `canvas.primary.renderTexture`)
 * correctly. `canvas.effects` never had this failure mode — it's a plain
 * `PIXI.Container` (groups/effects.mjs:31), not a `CachedContainer` — so it
 * keeps being suppressed the simple way, just no longer riding on
 * `environment`'s shared lever.
 *
 * Cost, honestly stated: this gives back some of the render-to-texture work
 * MSA previously skipped by suppressing at the parent level — the same cost
 * vanilla Foundry (no MSA) already pays every frame as normal operation.
 * Measure before assuming it matters (feedback_measure_the_output_not_the_
 * equation) — do not re-introduce the parent-level shortcut to "optimize"
 * this without re-deriving that it doesn't reopen the frozen-texture bug.
 *
 * ⚠️ SUPERSEDED 2026-08-15 — IT MATTERED. Measured at 37.1 ms/frame vs 8.35 ms
 * on a two-floor map's upper floor (Bug #21). The cost is gone and the frozen-
 * texture bug is now structurally unreachable, because nothing samples that
 * texture any more: MSA supplies the fog filter's explored wash directly. See
 * "THE THIRD LEVER" further down. The paragraph above is kept because its
 * warning still binds — the parent-level shortcut (`canvas.environment.
 * renderable = false`) remains the wrong move, for the reason it gives.
 *
 * ============================================================================
 * THE COUPLING RULE — why `decideArtSuppression` exists (the safety slide)
 * ============================================================================
 *
 * The two halves must never land apart. Suppress Foundry's art while the PIXI
 * canvas is still OPAQUE and you get the worst state available: a blank scene
 * with floating selection borders and no art from EITHER renderer. That is
 * strictly worse than doing nothing.
 *
 * So suppression is a DECISION taken from measured facts, defaulting to REFUSE
 * (feedback_safety_slide_outranks_doctrine: fall back to Foundry by default,
 * announce always, never silently). Every refusal carries a `code` and a
 * `reason` — "I could not measure this" never looks like "the thing is broken"
 * (Keyhole doctrine #5, feedback_instruments_must_not_lie).
 *
 * ============================================================================
 * NOT DONE HERE, ON PURPOSE
 * ============================================================================
 *
 * - `canvas.visibility` (fog/vision) is a THIRD group, sibling of `environment`
 *   under `rendered`. It is deliberately LEFT WITH PIXI. The author's direction
 *   (2026-07-17, keyhole-vision-fog-direction) is that MSA takes fog+vision
 *   EVENTUALLY — reproducing Foundry's logic, rendering it with Three's
 *   strengths (smooth fog), which would obsolete the whole primary-texture
 *   dependency above at once. Until then, §3's two-lever suppression is the
 *   scoped fix. Keep suppression per-group and reversible so that day is an
 *   addition, not a rewrite.
 * - The DRAG PREVIEW's art. A preview Token is a real Token, so its `_draw`
 *   also pushes a mesh into `primary` — suppressed with everything else. MSA
 *   draws from DOCUMENTS and a preview is not a document; it lives at
 *   `canvas.tokens.preview.children` (layers/base/placeables-layer.mjs:47).
 *   Expect to drag an outline with no picture until that is wired. Real,
 *   bounded, and NOT silently pretended away.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('interface-seam');

/** The Foundry canvas groups MSA takes over. `visibility` is NOT among them — see the header. */
export const MSA_OWNED_GROUPS = Object.freeze(['primary', 'effects']);

/**
 * THE DECISION, pure and Node-tested. Given what we could actually MEASURE,
 * may we suppress Foundry's art?
 *
 * Defaults to REFUSE on every unknown. Refusing means Foundry renders normally
 * and MSA is simply invisible underneath — a working table with no MSA. That is
 * the safety slide's whole point, and it is always better than the alternative
 * failure (art suppressed under an opaque canvas = nothing renders at all).
 *
 * @param {object} facts
 * @param {boolean|null} facts.contextAlpha - the GL context's `alpha` attribute.
 *   `null` = could not read. IMMUTABLE for the session once the context exists.
 * @param {number|null} facts.clearAlpha - `renderer.background.alpha`. `null` =
 *   could not read.
 * @param {boolean} facts.groupsPresent - do `canvas.primary`, `canvas.primary.sprite`
 *   and `canvas.effects` all exist to suppress?
 * @returns {{suppress: boolean, code: string, reason: string}}
 */
export function decideArtSuppression({ contextAlpha, clearAlpha, groupsPresent }) {
  if (contextAlpha === null || contextAlpha === undefined) {
    return {
      suppress: false,
      code: 'context-alpha-unknown',
      reason:
        'Could not read the WebGL context alpha attribute. This is "not measured", NOT "broken" — ' +
        'refusing because suppressing art on an unknown is the dangerous direction.',
    };
  }
  if (contextAlpha === false) {
    return {
      suppress: false,
      code: 'context-opaque',
      reason:
        'The PIXI WebGL context was created with alpha:false, so its canvas can NEVER be transparent ' +
        'this session (context attributes are immutable). The canvasConfig hook did not take — it must ' +
        'be registered before Foundry\'s Canvas#initialize, which runs between the "setup" and "ready" hooks.',
    };
  }
  if (clearAlpha === null || clearAlpha === undefined) {
    return {
      suppress: false,
      code: 'clear-alpha-unknown',
      reason: 'Could not read renderer.background.alpha. Not measured, not broken — refusing on the unknown.',
    };
  }
  if (clearAlpha > 0) {
    return {
      suppress: false,
      code: 'clear-alpha-opaque',
      reason:
        `renderer.background.alpha is ${clearAlpha}, so PIXI clears its canvas opaque every frame and ` +
        'MSA underneath would be invisible. Foundry resets this whenever the environment background ' +
        'colour changes (environment.mjs:179) — the initializeCanvasEnvironment re-assert did not run.',
    };
  }
  if (!groupsPresent) {
    return {
      suppress: false,
      code: 'no-render-targets',
      reason:
        'canvas.primary / canvas.primary.sprite / canvas.effects do not all exist yet — nothing to ' +
        'suppress. Normal before a scene is drawn.',
    };
  }
  return {
    suppress: true,
    code: 'ok',
    reason: 'PIXI canvas is verifiably transparent; Foundry art can be suppressed safely.',
  };
}

/**
 * Read the real compositing facts from live PIXI/Foundry. GROUND TRUTH ONLY —
 * every field is read from the thing itself, never inferred from what we asked
 * for. A field is `null` when it could not be read, and `null` is never
 * conflated with a real value.
 *
 * @returns {{contextAlpha: boolean|null, clearAlpha: number|null,
 *   primaryPresent: boolean, primarySpritePresent: boolean, effectsPresent: boolean,
 *   groupsPresent: boolean, primarySpriteRenderable: boolean|null,
 *   effectsRenderable: boolean|null, foundryArtRenderable: boolean|null,
 *   readErrors: string[]}}
 */
export function readCompositingFacts() {
  const readErrors = [];
  const app = typeof canvas !== 'undefined' ? canvas?.app : null;

  let contextAlpha = null;
  try {
    // The context's OWN attributes, not the options we passed in. This is the
    // difference between "what we asked for" and "what we got".
    const gl = app?.renderer?.gl ?? null;
    const attrs = gl?.getContextAttributes?.() ?? null;
    if (attrs) contextAlpha = attrs.alpha === true;
    else readErrors.push('no GL context attributes available (renderer.gl missing or not WebGL)');
  } catch (err) {
    readErrors.push(`getContextAttributes threw: ${err?.message ?? err}`);
  }

  let clearAlpha = null;
  try {
    const a = app?.renderer?.background?.alpha;
    if (typeof a === 'number') clearAlpha = a;
    else readErrors.push('renderer.background.alpha is not a number (PIXI API drift?)');
  } catch (err) {
    readErrors.push(`reading renderer.background.alpha threw: ${err?.message ?? err}`);
  }

  const primary = typeof canvas !== 'undefined' ? (canvas?.primary ?? null) : null;
  const effects = typeof canvas !== 'undefined' ? (canvas?.effects ?? null) : null;
  const primaryPresent = !!primary;
  const primarySpritePresent = !!primary?.sprite;
  const effectsPresent = !!effects;
  const groupsPresent = primaryPresent && primarySpritePresent && effectsPresent;

  let primarySpriteRenderable = null;
  try {
    if (primary?.sprite && typeof primary.sprite.renderable === 'boolean') {
      primarySpriteRenderable = primary.sprite.renderable;
    }
  } catch (err) {
    readErrors.push(`reading canvas.primary.sprite.renderable threw: ${err?.message ?? err}`);
  }

  let effectsRenderable = null;
  try {
    if (effects && typeof effects.renderable === 'boolean') effectsRenderable = effects.renderable;
  } catch (err) {
    readErrors.push(`reading canvas.effects.renderable threw: ${err?.message ?? err}`);
  }

  // Single combined signal, mirroring the pre-2026-08-13 `environmentRenderable`
  // shape for callers that just want "is Foundry's own art currently showing" —
  // true only when BOTH halves genuinely read true; any false or unread (null)
  // on either half means Foundry's art is at least partly suppressed.
  const foundryArtRenderable =
    primarySpriteRenderable === true && effectsRenderable === true
      ? true
      : primarySpriteRenderable === null && effectsRenderable === null
        ? null
        : false;

  return {
    contextAlpha,
    clearAlpha,
    primaryPresent,
    primarySpritePresent,
    effectsPresent,
    groupsPresent,
    primarySpriteRenderable,
    effectsRenderable,
    foundryArtRenderable,
    readErrors,
  };
}

/** Re-assert the transparent clear alpha after Foundry clobbers it. See header §2. */
function reassertClearAlpha() {
  try {
    const bg = typeof canvas !== 'undefined' ? canvas?.app?.renderer?.background : null;
    if (!bg) return false;
    if (bg.alpha === 0) return true; // already right; do not touch
    bg.alpha = 0;
    return true;
  } catch (err) {
    console.error(
      '[MSA] canvas-compositing: could not re-assert transparent clear alpha. Foundry art will ' +
        'stay opaque and MSA will be invisible underneath (this is the safe direction):',
      err
    );
    return false;
  }
}

// ============================================================================
// THE THIRD LEVER (2026-08-15) — MSA takes the explored-fog render off Foundry
// ============================================================================
//
// THE COST THE HEADER ABOVE ASKED SOMEONE TO MEASURE. The PRIMARY-CACHE-FREEZE
// FIX kept `canvas.primary.renderable = true` so `CachedContainer#render()` would
// keep re-rendering every map object into `canvas.primary.renderTexture` each
// frame, and closed with "Measure before assuming it matters." Measured, live,
// 2026-08-15 (Bug #21 / `docs/holy/V4-Reckoning.md` R0.9): on a two-floor map's
// upper floor it was costing **37.1 ms/frame vs 8.35 ms** — 27 fps against a
// vsync-capped 120. It mattered enormously.
//
// It is also, structurally, the V2 blunder this file exists to prevent: TWO
// RENDERERS DRAWING THE SAME PICTURE. MSA draws the map; Foundry was drawing it
// again into a texture, every frame, at canvas resolution.
//
// WHO ACTUALLY READ THAT TEXTURE (grepped in the vendored v14 source, all six):
//   effects.mjs:245, rendered-effect-source.mjs:290, point-vision-source.mjs:424,
//   point-darkness-source.mjs:236, base-light-source.mjs:238   -> all live inside
//     `canvas.effects`, which this file already suppresses. They never render.
//   visibility.mjs:336 (the fog filter)                        -> THE ONLY LIVE
//     CONSUMER, and it uses the texture for exactly one term.
//
// WHAT THAT ONE TERM DOES (rendering/filters/visibility.mjs:140,148-149):
//
//     vec4 baseColor = texture2D(primaryTexture, vMaskTextureCoord);
//     float reflec   = perceivedBrightness(baseColor.rgb);
//     vec4 explored  = vec4(min((exploredColor * reflec)
//                             + (baseColor.rgb * exploredColor), vec3(1.0)), 0.5);
//
// `baseColor` tints the EXPLORED-but-not-currently-visible zone and nothing else.
// The masking that matters is untouched by it: UNEXPLORED is a flat
// `vec4(unexploredColor, 1.0)` (opaque — it hides MSA's map, which is what keeps
// players' secrets), and CURRENTLY-VISIBLE is `vec4(0.0)` (transparent — MSA's
// map shows through). Only the 50%-alpha memory wash reads the map.
//
// SO: MSA hands the filter its OWN texture for that term and Foundry stops
// redrawing the map. Foundry keeps every scrap of the vision LOGIC — sweep
// polygons, the vision mask, fog exploration and its persistence, who may see
// what — because that logic is correctness, it is Foundry's job, and MSA must
// not fork it (the parity doctrine, and the fog-of-war gap is a live security
// concern). MSA takes over only the LOOK of the stale region, which is a
// rendering decision, which is MSA's job.
//
// WHY A FLAT COLOUR IS FAITHFUL, not a shrug: substitute a mid-grey C=0.5 into
// the shader above and, for the default `exploredColor` of white,
// `explored.rgb = exploredColor*B(0.5) + 0.5*exploredColor = exploredColor` —
// exactly what vanilla produces for a mid-brightness map pixel. The flat base
// reproduces vanilla's AVERAGE result and loses only the per-pixel modulation
// (bright map areas hazing slightly more than dark ones) — for a blurred,
// half-alpha wash drawn over MSA's own live map, which is still fully visible
// underneath. The knob is `setExploredFogBase()` so the author can tune the
// memory wash directly instead of inheriting whatever the art happened to be.
//
// ⚠️ This is ON BY DEFAULT and has no flag, by the author's explicit rule
// (2026-08-15): "If you build it and place it behind a console command or button
// I might forget to do that work which will lead to confusion and wasted time."
// `restoreFoundryArt()` reverses all three levers together so the renderer A/B
// toggle stays honest.

// `createLogger`, not console.* — the `log/one-door` tripwire's whole point is
// that console output cannot be exported, so a bypassed line is a line missing
// from the flight-recorder bundle the author sends when something goes wrong.
// Everything below is exactly the kind of thing you want in that bundle.

/** MSA's default explored-fog base — mid-grey; see the section header for why. */
export const DEFAULT_EXPLORED_FOG_BASE = Object.freeze({ r: 128, g: 128, b: 128 });

/**
 * Normalise an explored-fog base colour. Pure — the clamping and the shape are
 * what the live path depends on, so they are Node-tested rather than trusted.
 *
 * Accepts `{r,g,b}` (0-255), a `#rrggbb` string, or a 24-bit number. Anything
 * unusable returns the default rather than throwing: a bad colour must never be
 * able to take out the fog render.
 *
 * @param {object|string|number|null|undefined} input
 * @returns {{r: number, g: number, b: number}} 0-255 integers
 */
export function resolveExploredFogBase(input) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v))));
  const ok = (v) => Number.isFinite(Number(v));
  if (typeof input === 'string') {
    const hex = input.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return { ...DEFAULT_EXPLORED_FOG_BASE };
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(input)));
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  if (input && ok(input.r) && ok(input.g) && ok(input.b)) {
    return { r: clamp(input.r), g: clamp(input.g), b: clamp(input.b) };
  }
  return { ...DEFAULT_EXPLORED_FOG_BASE };
}

/** The live base colour + its 1×1 PIXI texture. Rebuilt only when the colour changes. */
let exploredFogBase = { ...DEFAULT_EXPLORED_FOG_BASE };
let exploredFogTexture = null;
let exploredFogTextureKey = null;

/**
 * The 1×1 texture MSA feeds the fog filter in place of Foundry's whole-map
 * re-render. Built from a canvas element (no PIXI internals), cached by colour.
 * A 1×1 texture with default clamped wrapping returns the same colour for every
 * sample, including the out-of-range coordinates the filter can produce.
 * @returns {object|null} a PIXI.Texture, or null if PIXI is unavailable
 */
function ensureExploredFogTexture() {
  const key = `${exploredFogBase.r},${exploredFogBase.g},${exploredFogBase.b}`;
  if (exploredFogTexture && exploredFogTextureKey === key) return exploredFogTexture;
  if (typeof PIXI === 'undefined' || typeof document === 'undefined') return null;
  try {
    const el = document.createElement('canvas');
    el.width = 1;
    el.height = 1;
    const ctx = el.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = `rgb(${exploredFogBase.r},${exploredFogBase.g},${exploredFogBase.b})`;
    ctx.fillRect(0, 0, 1, 1);
    const next = PIXI.Texture.from(el);
    // Destroy the previous one only AFTER the new one exists — a throw halfway
    // must never leave the filter holding a destroyed texture.
    const prev = exploredFogTexture;
    exploredFogTexture = next;
    exploredFogTextureKey = key;
    try {
      prev?.destroy(true);
    } catch {
      /* a texture we no longer reference failing to free is not worth a throw */
    }
    return exploredFogTexture;
  } catch (err) {
    log.error('building the explored-fog base texture failed', { err: err?.message ?? String(err) });
    return null;
  }
}

/**
 * Point Foundry's visibility filter at MSA's explored-fog base instead of
 * `canvas.primary.renderTexture`. Idempotent and cheap (a reference compare), so
 * it is safe on a per-refresh hook — which it needs to be, because
 * `CanvasVisibility#_draw()` builds a BRAND NEW filter on every canvas draw and
 * would silently re-adopt Foundry's texture otherwise.
 *
 * @returns {{applied: boolean, reason: string}}
 */
export function applyExploredFogBase() {
  try {
    const filter = typeof canvas !== 'undefined' ? (canvas?.visibility?.filter ?? null) : null;
    if (!filter?.uniforms) return { applied: false, reason: 'no visibility filter yet (canvas not drawn)' };
    const tex = ensureExploredFogTexture();
    if (!tex) return { applied: false, reason: 'could not build the explored-fog base texture' };
    if (filter.uniforms.primaryTexture === tex) return { applied: true, reason: 'already applied' };
    filter.uniforms.primaryTexture = tex;
    return { applied: true, reason: 'explored-fog base is MSA-owned' };
  } catch (err) {
    log.error('pointing the fog filter at MSA’s explored base failed', { err: err?.message ?? String(err) });
    return { applied: false, reason: `threw: ${err?.message ?? err}` };
  }
}

/**
 * ============================================================================
 * THE VISION/FOG TAKEOVER LEVER (Pillar 11) — hand `canvas.visibility` to MSA.
 * ============================================================================
 *
 * The SAME single lever already used for `primary` and `effects`
 * (`renderable = false`), applied to the third group the interface seam
 * deliberately left with PIXI. See `docs/planning/Vision-Fog-Ownership.md`.
 *
 * ⚠️ THIS IS THE MOST DANGEROUS SWITCH IN THE MODULE AND IT DOES NOT DEGRADE
 * GRACEFULLY. `canvas.visibility` IS the layer that hides things from players.
 * Turning it off without a complete replacement does not dim or glitch — it
 * shows every player the entire map, instantly, including everything the GM
 * has never revealed. That is Testament Law 7 (player-facing information
 * gating is sacred) and mission priority #2 (secrets safe from players), which
 * is why its caller defaults OFF and why `restoreFoundryVisibility` exists as
 * the paired revert (Law 5's safety slide).
 *
 * ⚠️ IT IS ALSO NOT SUFFICIENT ON ITS OWN. Suppressing this group removes
 * EXPLORED-AREA MEMORY too, not just the live vision cone — Foundry's fog
 * exploration renders through the same group. Until MSA's own explored-area
 * persistence exists (slice 3), a session with this on shows a player only
 * what they can see RIGHT NOW and nothing they have previously explored.
 * That is a gameplay regression, not a rendering one, and it is the reason
 * the plan requires slices 3 and 5 to land before the flag may default on.
 *
 * @param {boolean} on - true = MSA owns it, false = give it back to Foundry.
 * @returns {{applied: boolean, reason: string}}
 */
export function setVisibilitySuppression(on) {
  try {
    const visibility = typeof canvas !== 'undefined' ? (canvas?.visibility ?? null) : null;
    if (!visibility) return { applied: false, reason: 'no canvas.visibility yet' };
    // FAIL TOWARD FOUNDRY: any doubt and the group keeps rendering. An extra
    // fog layer is a cosmetic double-darken; a missing one is a secrets leak.
    visibility.renderable = on !== true;
    return {
      applied: true,
      reason:
        on === true ? 'canvas.visibility suppressed — MSA owns vision/fog' : 'canvas.visibility restored to Foundry',
    };
  } catch (err) {
    log.error('toggling canvas.visibility suppression failed', { err: err?.message ?? String(err) });
    return { applied: false, reason: `threw: ${err?.message ?? err}` };
  }
}

/**
 * Give the fog filter Foundry's own render texture back. Paired with
 * `restoreFoundryArt()` — if Foundry is drawing the map again, its fog should
 * read the map again.
 * @returns {boolean}
 */
function restoreFoundryFogBase() {
  try {
    const filter = typeof canvas !== 'undefined' ? (canvas?.visibility?.filter ?? null) : null;
    const rt = typeof canvas !== 'undefined' ? (canvas?.primary?.renderTexture ?? null) : null;
    if (!filter?.uniforms || !rt) return false;
    filter.uniforms.primaryTexture = rt;
    return true;
  } catch (err) {
    log.error('restoring the fog filter’s primaryTexture failed', { err: err?.message ?? String(err) });
    return false;
  }
}

/**
 * Set the colour MSA washes explored-but-unseen regions with. Applies live.
 * @param {object|string|number} color - `{r,g,b}` 0-255, `#rrggbb`, or 0xRRGGBB
 * @returns {{base: {r: number, g: number, b: number}, applied: boolean, reason: string}}
 */
export function setExploredFogBase(color) {
  exploredFogBase = resolveExploredFogBase(color);
  const res = applyExploredFogBase();
  return { base: { ...exploredFogBase }, ...res };
}

/** The colour MSA is currently washing explored regions with. */
export function getExploredFogBase() {
  return { ...exploredFogBase };
}

/**
 * Apply (or refuse) art suppression, from measured facts. Idempotent — safe to
 * call on every canvasReady.
 *
 * @param {{silent?: boolean}} [opts] - `silent:true` skips the refusal
 *   console.warn below. For the RARE callers (scene load, floor-switch
 *   commit, the debug-panel A/B toggle) a refusal is worth announcing loudly
 *   — per feedback_safety_slide_outranks_doctrine, never a silent fallback.
 *   For a FREQUENT reassertion caller (the `visibilityRefresh` hook,
 *   registered below — same per-canvas-draw cadence as `applyExploredFogBase`)
 *   a legitimate, steady-state "not suppressing" (safety slide engaged, MSA
 *   not active) would otherwise spam the console on every fog/vision update
 *   for the whole time that state holds. The suppress/decision LOGIC is
 *   identical either way — only whether a refusal announces itself changes.
 * @returns {{applied: boolean, code: string, reason: string, facts: object}}
 */
export function applyArtSuppression({ silent = false } = {}) {
  const facts = readCompositingFacts();
  const decision = decideArtSuppression(facts);

  if (!decision.suppress) {
    // ANNOUNCE, ALWAYS (unless `silent` — see param doc above) — never a
    // silent fallback (feedback_safety_slide_outranks_doctrine).
    // 'no-render-targets' is the one benign case: it just means no scene is drawn yet.
    if (!silent && decision.code !== 'no-render-targets') {
      console.warn(
        `[MSA] interface seam: NOT suppressing Foundry's art (${decision.code}) — ${decision.reason} ` +
          'Foundry is rendering the scene normally; MSA is underneath and invisible.'
      );
    }
    return { applied: false, code: decision.code, reason: decision.reason, facts };
  }

  try {
    // THREE levers — see header §3, "THE PRIMARY-CACHE-FREEZE FIX", and "THE
    // THIRD LEVER" above. Order matters only for readability; all are idempotent.
    canvas.primary.sprite.renderable = false; // Foundry's map OUTPUT — off since 2026-07
    canvas.effects.renderable = false; // Foundry's lighting/vision output — off
    // ...and the map RE-RENDER itself (2026-08-15, Bug #21). The cache existed
    // for one live consumer, the fog filter's explored wash, and MSA now supplies
    // that directly. Nothing left reads the texture, so nothing needs it built.
    canvas.primary.renderable = false;
  } catch (err) {
    console.error('[MSA] interface seam: suppressing Foundry primary/effects failed:', err);
    return {
      applied: false,
      code: 'suppress-threw',
      reason: `Setting canvas.primary.sprite.renderable/canvas.effects.renderable/canvas.primary.renderable = false threw: ${err?.message ?? err}`,
      facts,
    };
  }
  // The fog filter may not exist yet on the first canvasReady — this is
  // idempotent and the `visibilityRefresh` hook re-applies until it takes.
  const fogBase = applyExploredFogBase();
  return { applied: true, code: decision.code, reason: decision.reason, facts, fogBase };
}

/**
 * Hand Foundry's art back. The reverse of applyArtSuppression, for the safety
 * slide's "fall back to Foundry" path and for Stop/Clear. Best-effort: restores
 * whichever of `canvas.primary.sprite` / `canvas.effects` actually exists,
 * rather than requiring both (the safety slide prefers showing SOME Foundry
 * art over refusing entirely on a partial state).
 *
 * @returns {boolean} whether at least one restore actually happened
 */
export function restoreFoundryArt() {
  try {
    const primary = typeof canvas !== 'undefined' ? (canvas?.primary ?? null) : null;
    const effects = typeof canvas !== 'undefined' ? (canvas?.effects ?? null) : null;
    let restored = false;
    if (primary?.sprite) {
      primary.sprite.renderable = true;
      restored = true;
    }
    if (effects) {
      effects.renderable = true;
      restored = true;
    }
    // The third lever, reversed — and the fog filter handed back Foundry's own
    // texture. If Foundry is drawing the map again its fog must read the map
    // again, or the A/B toggle would compare against a half-restored Foundry.
    if (primary) {
      primary.renderable = true;
      primary.renderDirty = true; // the cache is stale by exactly as long as it was off
      restoreFoundryFogBase();
      restored = true;
    }
    return restored;
  } catch (err) {
    console.error('[MSA] interface seam: restoring canvas.primary/canvas.effects failed:', err);
    return false;
  }
}

/**
 * §4 — FOUNDRY'S OWN TICKER MUST NOT LAG MSA'S (2026-08-15, "door icons
 * wriggle when panning").
 *
 * Foundry hard-caps its PIXI ticker to the player's "Maximum Frame Rate"
 * setting: `board.mjs#_configurePerformanceMode()` runs
 * `this.app.ticker.maxFPS = PIXI.Ticker.shared.maxFPS = PIXI.Ticker.system.
 * maxFPS = game.settings.get("core", "maxFPS")`, a NumberField clamped
 * 10..60 (`client/game.mjs`, `initial: 60`) — 60 is the CEILING, not a
 * default that can be raised in Foundry's own UI. MSA's render loop
 * (`vt/vt-pan-viewer.js#renderFrame`) is uncapped and reads `canvas.stage`
 * fresh every rAF tick on purpose (`syncFoundryCamera`: "a camera that lags
 * is a camera that disagrees"), so on any display faster than 60Hz — this
 * project's 120Hz target included — MSA repaints the map more often than
 * Foundry repaints its OWN interface chrome (walls, selection borders, door
 * control icons). The icon holds its screen position for an extra MSA frame
 * while the map keeps sliding underneath it: exactly the "PIXI door icons
 * wriggle" symptom, and it would hit every interface-layer object, not just
 * doors.
 *
 * Fix: uncap the TICKER, not the setting. `game.settings.get('core',
 * 'maxFPS')` still reads back whatever the player chose in Foundry's own
 * config screen — only what `_configurePerformanceMode` derived from it
 * changes, so nothing here fights the settings UI. `canvas.app.ticker` is
 * created once by `Canvas#initialize` and lives for the whole client
 * session (never rebuilt on a scene or floor switch), so a one-shot
 * `Hooks.once('canvasReady', ...)` — AFTER `initialize()` has already run —
 * covers every later scene.
 *
 * Known gap, deliberately not handled: if the player opens Foundry's
 * Configure Settings > Performance panel mid-session and drags the maxFPS
 * slider, its `onChange` reruns `_configurePerformanceMode()` and re-caps
 * the ticker. Rare (nobody tunes that setting while playing) and cheap to
 * notice (`tickerMaxFps` in `getFoundryRendererCensus()` below would read
 * the cap again) — not worth a settings-change listener for a one-off.
 *
 * @returns {boolean} true if the ticker was actually uncapped
 */
export function uncapFoundryTicker() {
  try {
    const ticker = typeof canvas !== 'undefined' ? canvas?.app?.ticker : null;
    if (!ticker) return false;
    ticker.maxFPS = 0; // 0 == uncapped in PIXI.Ticker
    return true;
  } catch (err) {
    console.error(
      "[MSA] interface seam: uncapping Foundry's PIXI ticker failed — its own chrome (door/wall/token " +
        "icons, selection borders) may visibly lag MSA's map while panning on a display faster than 60Hz:",
      err
    );
    return false;
  }
}

/**
 * Register the two hooks that make the seam work. MUST be called at module load
 * (Foundry's Canvas#initialize runs between the "setup" and "ready" hooks, and
 * `canvasConfig` fires inside it — see header §1: there is no second chance).
 *
 * @returns {{registered: boolean, reason: string|null}}
 */
export function registerCanvasCompositing() {
  if (typeof Hooks === 'undefined') {
    return { registered: false, reason: 'no Foundry Hooks global — not running inside Foundry' };
  }

  // §1 — the one-shot that decides the GL context's alpha attribute forever.
  Hooks.once('canvasConfig', (config) => {
    try {
      config.backgroundAlpha = 0;
    } catch (err) {
      console.error(
        '[MSA] interface seam: could not set backgroundAlpha on the canvasConfig options. The PIXI ' +
          'canvas will be OPAQUE for this whole session and MSA cannot show through it. Foundry will ' +
          'render normally (the safe fallback):',
        err
      );
    }
  });

  // §2 — re-assert after Foundry's environment colour update clobbers the alpha.
  Hooks.on('initializeCanvasEnvironment', () => {
    reassertClearAlpha();
  });

  // §3 — re-assert MSA's explored-fog base AND art suppression. `CanvasVisibility
  // #_draw()` builds a BRAND NEW VisibilityFilter (groups/visibility.mjs:331) on
  // every canvas draw and hands it `canvas.primary.renderTexture`, so a one-shot
  // assignment would be silently reverted by the next scene load or canvas
  // redraw — and the symptom would be a perf regression nobody could see, which
  // is precisely how this cost hid for two days. `visibilityRefresh` fires from
  // the group's own refresh (groups/visibility.mjs:635); each handler is a cheap
  // reference-compare/boolean-write on the already-applied path, so riding a
  // frequent hook is deliberate and cheap.
  //
  // applyArtSuppression joined this hook 2026-08-24: `syncInterfaceSeam`'s own
  // call only ran AFTER a floor-switch commits, leaving Foundry's `primary`/
  // `effects` groups at PIXI's own default (`renderable:true`) for the entire
  // — potentially tens-of-seconds — prepare window beforehand, which Foundry's
  // OWN `canvas.draw()` is believed to reset on every floor switch the same way
  // it resets the fog filter. That's the measured Bug #21 cost (37ms vs 8.35ms
  // per frame) recurring for the whole prepare window, on top of everything
  // else. `{silent:true}` — see `applyArtSuppression`'s own param doc — this
  // hook must not spam a console warning every fog/vision update for as long as
  // the safety slide (or MSA simply not being active) makes suppression a
  // legitimate, steady-state "no".
  Hooks.on('visibilityRefresh', () => {
    applyExploredFogBase();
    applyArtSuppression({ silent: true });
  });

  // §4 — uncap Foundry's own ticker once, the first time its canvas is ready
  // (see uncapFoundryTicker's header for why once is enough).
  Hooks.once('canvasReady', () => {
    uncapFoundryTicker();
  });

  return { registered: true, reason: null };
}

/**
 * The debug-panel report. Answers the only question that matters — is the seam
 * actually live? — from measured facts, not from what we intended.
 */
export function getCanvasCompositingReport() {
  const facts = readCompositingFacts();
  const decision = decideArtSuppression(facts);
  return {
    report: 'interface-seam',
    generatedAt: new Date().toISOString(),
    contextAlpha: facts.contextAlpha,
    clearAlpha: facts.clearAlpha,
    primaryPresent: facts.primaryPresent,
    primarySpritePresent: facts.primarySpritePresent,
    effectsPresent: facts.effectsPresent,
    primarySpriteRenderable: facts.primarySpriteRenderable,
    effectsRenderable: facts.effectsRenderable,
    foundryArtRenderable: facts.foundryArtRenderable,
    readErrors: facts.readErrors,
    decision,
    msaOwnedGroups: [...MSA_OWNED_GROUPS],
    interpretation:
      'HEALTHY = contextAlpha:true, clearAlpha:0, foundryArtRenderable:false (i.e. ' +
      'primarySpriteRenderable:false AND effectsRenderable:false). That means the PIXI canvas is ' +
      "genuinely transparent, Foundry's art output is off (though canvas.primary's own internal cache " +
      "keeps refreshing every frame — deliberate, see the header's PRIMARY-CACHE-FREEZE FIX section — " +
      "so Foundry's own fog shader still reads a live snapshot), and its interface chrome (selection " +
      'borders, grid, walls, control icons, rulers) is drawing on top of MSA. ' +
      'contextAlpha:false is UNRECOVERABLE this session — the canvasConfig hook did not run in time. ' +
      'clearAlpha:1 with contextAlpha:true means Foundry re-clobbered the alpha and the ' +
      'initializeCanvasEnvironment re-assert is not firing. ' +
      'foundryArtRenderable:true alongside a refusal is CORRECT and deliberate — the safety slide ' +
      'chose Foundry rendering over a blank screen; read decision.reason for which fact forced it.',
  };
}

/**
 * ⚖️ THE SECOND-RENDERER CENSUS (TEMPORARY — `docs/holy/V4-Reckoning.md`; remove
 * with the Reckoning Report when its R4 gates close).
 *
 * HOW MUCH work Foundry's own renderer is still doing, as opposed to the seam
 * report above which answers WHETHER its art is showing. Those are different
 * questions and only the first one has ever been asked here.
 *
 * The PRIMARY-CACHE-FREEZE FIX in this file's header (2026-08-13, Bug #18)
 * deliberately leaves `canvas.primary.renderable === true` so `CachedContainer#
 * render()` keeps re-rendering every map object into `canvas.primary.
 * renderTexture` each frame — at CANVAS RESOLUTION — purely so Foundry's own fog
 * shader reads a live snapshot. That section states the cost honestly and ends
 * "Measure before assuming it matters." This function is the measurement's raw
 * material, and it is the one large GPU consumer MSA's own per-pass timestamps
 * structurally cannot see: different context, different ticker.
 *
 * Every read is defensive — this runs against live Foundry, and a diagnostic
 * that throws is worse than one that reports `null`.
 *
 * @returns {object} counts + sizes; `null` fields where Foundry did not answer.
 */
export function getFoundryRendererCensus() {
  const readErrors = [];
  const read = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      readErrors.push(`${label}: ${err?.message ?? err}`);
      return null;
    }
  };
  const c = typeof canvas !== 'undefined' ? canvas : null;
  const primary = read('canvas.primary', () => c?.primary ?? null);
  const rt = read('canvas.primary.renderTexture', () => primary?.renderTexture ?? null);
  const kids = read('canvas.primary.children', () => (Array.isArray(primary?.children) ? primary.children : [])) ?? [];

  let renderableChildren = null;
  if (kids.length > 0 || Array.isArray(kids)) {
    renderableChildren = read('children renderable scan', () => {
      let n = 0;
      for (const child of kids) if (child?.renderable !== false && child?.visible !== false) n++;
      return n;
    });
  }

  const rtW = read('renderTexture.width', () => rt?.width ?? null);
  const rtH = read('renderTexture.height', () => rt?.height ?? null);

  const filter = read('canvas.visibility.filter', () => c?.visibility?.filter ?? null);
  return {
    // FALSE is the healthy state since 2026-08-15 (Bug #21): Foundry no longer
    // re-renders the map. TRUE means the third lever is off and the whole-map
    // re-render is back — the 27-fps state.
    primaryRenderable: read('primary.renderable', () => primary?.renderable ?? null),
    // Which texture the fog filter's explored wash is reading. 'msa' is healthy.
    exploredFogBaseOwner: read('fog filter primaryTexture owner', () => {
      if (!filter?.uniforms) return 'no-filter';
      const t = filter.uniforms.primaryTexture;
      if (!t) return 'none';
      if (t === exploredFogTexture) return 'msa';
      if (t === rt) return 'foundry-primary-cache';
      return 'other';
    }),
    exploredFogBase: { ...exploredFogBase },
    primaryCacheTexture: rtW && rtH ? { w: rtW, h: rtH, mpx: Math.round(((rtW * rtH) / 1e6) * 100) / 100 } : null,
    primaryChildren: kids.length,
    primaryChildrenRenderable: renderableChildren,
    tickerStarted: read('app.ticker.started', () => c?.app?.ticker?.started ?? null),
    tickerFps: read('app.ticker.FPS', () => (c?.app?.ticker?.FPS != null ? Math.round(c.app.ticker.FPS) : null)),
    // 0 = uncapped (the §4 fix in this file's header took), a positive number
    // (10..60) means Foundry's ticker is still capped and its own chrome —
    // door/wall/token icons — can visibly lag MSA's uncapped map on a
    // display faster than that cap.
    tickerMaxFps: read('app.ticker.maxFPS', () => c?.app?.ticker?.maxFPS ?? null),
    visibilityVisible: read('visibility.visible', () => c?.visibility?.visible ?? null),
    rendererSize: read('app.renderer size', () =>
      c?.app?.renderer?.width != null ? { w: c.app.renderer.width, h: c.app.renderer.height } : null
    ),
    readErrors,
    interpretation:
      'HEALTHY since 2026-08-15 (Bug #21) = primaryRenderable:false AND exploredFogBaseOwner:"msa" — Foundry is ' +
      "NOT re-rendering the map every frame, and its fog filter reads MSA's explored-fog base instead of a " +
      'whole-map cache. primaryRenderable:true is the REGRESSED state: Foundry re-renders ' +
      'primaryChildrenRenderable objects into a primaryCacheTexture-sized texture every frame in its own GL ' +
      'context — invisible to every MSA perf zone, immune to every MSA effect toggle, scaling with both ' +
      'resolution and floor (measured: 37.1ms vs 8.35ms per frame on an upper floor). ' +
      'exploredFogBaseOwner:"foundry-primary-cache" means a canvas redraw re-adopted Foundry\'s texture and ' +
      'the visibilityRefresh re-assert is not firing.',
  };
}
