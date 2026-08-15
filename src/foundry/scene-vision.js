/**
 * THE VISION-SOURCE READER — the one place `canvas.effects.visionSources` is
 * read, and slice 1 of "MSA owns vision/fog" (Testament Pillar 11,
 * `docs/planning/Vision-Fog-Ownership.md`).
 *
 * ⚠️ THIS MODULE CONSUMES FOUNDRY'S VISION COMPUTE AND MUST NEVER REPRODUCE
 * IT. Every polygon here was already computed by Foundry's own wall sweep
 * (`ClockwiseSweepPolygon`), against the live wall set, honouring sight sense
 * types, elevation, darkness sources, and whatever the active GAME SYSTEM
 * overrode — PF2e's rules-based vision rewrites detection modes wholesale, for
 * instance. That ruleset is Foundry's module-compatibility surface:
 * re-deriving any of it here would be a perpetual parity chase AND would break
 * modules that legitimately patch it. Reading the ANSWER is compatible with
 * every system by construction; recomputing it is compatible with none.
 * The division is LOCKED — see `keyhole-vision-fog-direction` and §2 of the
 * planning doc. MSA owns the RENDER; Foundry owns WHAT IS VISIBLE.
 *
 * WHY POLYGON DATA AND NOT FOUNDRY'S RENDERED FOG TEXTURE: MSA's WebGPU canvas
 * and Foundry's PIXI/WebGL canvas are separate GPU contexts. Sampling Foundry's
 * rendered fog would force a per-frame GPU→CPU→GPU readback — the exact V2
 * failure this rebuild exists to avoid. These `.points` arrays are plain JS
 * that Foundry has already computed on the CPU; reading them costs nothing.
 *
 * Split pure-vs-live exactly like every other reader in this zone
 * (`scene-regions.js`, `scene-environment.js`): `deriveVisionSource` is the
 * testable normalisation, `readActiveVisionSources` is the impure gatherer.
 * Never throws — a Foundry API surprise must not take a render frame down.
 *
 * @module foundry/scene-vision
 */

/** A polygon needs at least 3 vertices — 6 flat numbers — to enclose any area. */
export const MIN_POLYGON_FLOATS = 6;

/**
 * Is this a usable flat polygon point array (`[x0,y0,x1,y1,…]`)?
 *
 * Deliberately does NOT copy: these arrays are re-created by Foundry whenever
 * vision is recomputed and are read-only to us, so copying every one every
 * frame would be pure garbage for a renderer that only wants to triangulate
 * them. Callers must not mutate.
 *
 * @param {*} pts @returns {boolean}
 */
export function isUsablePolygon(pts) {
  return Array.isArray(pts) ? pts.length >= MIN_POLYGON_FLOATS && pts.length % 2 === 0 : false;
}

/**
 * Normalise ONE raw vision-source read into the shape the fog renderer wants,
 * or `null` if it contributes nothing this frame.
 *
 * ⚠️ `radius` AND `lightRadius` ARE TWO DIFFERENT QUESTIONS AND MUST NOT BE
 * MERGED (this project has paid for merging two quantities into one field
 * before — `feedback_one_byte_two_quantities`):
 *   - `radius` is `basicSight`: how far this token can see with NO light at
 *     all. Illumination-INDEPENDENT by Foundry's own design — a token sees
 *     this far in pitch darkness.
 *   - `lightRadius` is `lightPerception`: how far it can see THINGS THAT ARE
 *     LIT. Foundry's default is unlimited (`Infinity`).
 * The fog join (`docs/planning/Vision-Fog-Ownership.md` §3) reveals
 * `insideOwnSightRadius OR (insideLightPolygon AND litEnough)`, so collapsing
 * them would either grant darkvision to everyone or delete it from everyone.
 *
 * ⚠️ `Infinity` IS A LEGITIMATE VALUE HERE, not a bug, and it is preserved as a
 * real number rather than normalised away. `JSON.stringify(Infinity)` is
 * `"null"`, which reads identically to "missing" — that cost a full round of
 * the investigation that started this build, so any DIAGNOSTIC printing these
 * must stringify it deliberately (`feedback_instruments_must_not_lie`).
 *
 * @param {object|null} raw - already-plucked plain values from a live
 *   `PointVisionSource` (or a Node-test stand-in of the same shape).
 * @returns {{sourceId: string, x: number, y: number, elevation: number,
 *   radius: number, lightRadius: number, blinded: boolean,
 *   losPoints: number[]|null, lightPoints: number[]|null}|null}
 */
export function deriveVisionSource(raw) {
  if (!raw) return null;
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0) return null;
  // An inactive source is not a vision source this frame. A source with no
  // ACTIVE LAYER is Foundry's own "do not draw me" signal and is honoured for
  // the same reason — both are Foundry's verdict, not ours to second-guess.
  if (raw.active === false || raw.hasActiveLayer === false) return null;

  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const losPoints = isUsablePolygon(raw.losPoints) ? raw.losPoints : null;
  const lightPoints = isUsablePolygon(raw.lightPoints) ? raw.lightPoints : null;
  // No geometry at all ⇒ nothing to rasterise. Reported as "not a contributor"
  // rather than an empty-polygon entry the renderer would have to special-case.
  if (!losPoints && !lightPoints) return null;

  const num = (v, fallback) => {
    const n = Number(v);
    // Infinity is deliberately KEPT (see this function's own header).
    return Number.isFinite(n) || n === Infinity ? n : fallback;
  };

  return {
    sourceId: raw.sourceId,
    x,
    y,
    elevation: Number.isFinite(Number(raw.elevation)) ? Number(raw.elevation) : 0,
    radius: Math.max(0, num(raw.radius, 0)),
    lightRadius: Math.max(0, num(raw.lightRadius, 0)),
    // A blinded source keeps its geometry but must not REVEAL through it —
    // Foundry drops it from the light mask for exactly this reason. Carried as
    // a flag rather than by dropping the source, so the renderer can still show
    // a blinded token its own zero-radius state instead of silently vanishing.
    blinded: raw.blinded === true,
    losPoints,
    lightPoints,
  };
}

/**
 * Live read of every active vision source. Never throws.
 *
 * `sources` is empty for the extremely common GM-with-nothing-selected case —
 * that is not a failure, and `reason` stays null for it. Distinguishing "no
 * vision sources exist" from "could not read them" matters here more than
 * almost anywhere else in the codebase: the first means "GM sees everything,
 * correctly", the second would mean MSA is about to render fog from nothing
 * and hide the map from its own author.
 *
 * @returns {{sources: Array<NonNullable<ReturnType<typeof deriveVisionSource>>>,
 *   source: 'scene'|'default', reason: string|null}}
 */
export function readActiveVisionSources() {
  try {
    const collection = typeof canvas !== 'undefined' ? (canvas?.effects?.visionSources ?? null) : null;
    if (!collection) {
      return {
        sources: [],
        source: 'default',
        reason: 'no active scene (canvas.effects.visionSources is absent) — reading as zero sources, not guessed',
      };
    }
    const sources = [];
    for (const vs of collection) {
      const derived = deriveVisionSource({
        sourceId: vs?.sourceId,
        active: vs?.active,
        hasActiveLayer: vs?.hasActiveLayer,
        x: vs?.data?.x,
        y: vs?.data?.y,
        elevation: vs?.data?.elevation,
        radius: vs?.radius,
        lightRadius: vs?.lightRadius,
        blinded: vs?.isBlinded,
        // `.shape` is the LOS polygon (walls only); `.light` is the
        // light-perception polygon. Read BOTH — they differ whenever a token's
        // light perception is range-limited, and the fog join needs each one
        // for a different half of its expression.
        losPoints: vs?.shape?.points,
        lightPoints: vs?.light?.points,
      });
      if (derived) sources.push(derived);
    }
    return { sources, source: 'scene', reason: null };
  } catch (err) {
    return {
      sources: [],
      source: 'default',
      reason: `reading canvas.effects.visionSources threw: ${err?.message ?? err}`,
    };
  }
}

/**
 * Is vision actually gating anything right now? Mirrors Foundry's own
 * `CanvasVisibility#refresh` verdict:
 * `visible = visionSources.some(s => s.active) || !game.user.isGM`.
 *
 * ⚠️ THIS IS THE CHECK THAT MADE TWO EARLIER "VERIFIED" CLAIMS MEANINGLESS. A
 * GM with no controlled token skips Foundry's ENTIRE visibility group, so the
 * whole fog mechanism is never exercised and everything looks correct no
 * matter how broken it is. MSA's own fog must reproduce that same skip (a GM
 * with nothing selected sees the unobstructed map), and any harness verifying
 * this build must control a real token or it is measuring nothing.
 *
 * @param {{sourceCount: number, isGM: boolean}} args
 * @returns {boolean} should a fog/vision mask gate the view at all?
 */
export function shouldGateVision({ sourceCount, isGM }) {
  if (sourceCount > 0) return true;
  return !isGM;
}
