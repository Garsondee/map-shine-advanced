/**
 * PLAYER-CARRIED LIGHT — THE PURE HALF (mythica-machina-press#77, Stage 1).
 * Turns a live per-token snapshot (`foundry/player-light-mode.js#
 * readActivePlayerCarriedLightTokens`'s own shape) plus the scene's resolved
 * GM allowance (`foundry/player-light-permissions.js#
 * resolvePlayerLightPermissions`'s own shape) into point-light SOURCE
 * descriptors — shaped EXACTLY like `candle-flame-geometry.js#
 * buildCandleLightSources`'s and `fire-geometry.js#buildFireLightSources`'s
 * own output (`{sourceId, x, y, elevation, radius, shapePoints, ratio,
 * attenuation01, luminosity01, hasColor, alpha01, color, falloffModel,
 * animation}`), so a player's torch/flashlight flows through
 * `point-light-pool.js`'s identical mesh/material/MAX-blend/wall-clip path —
 * the same "connection between [X] and a point light we control" pattern
 * candle/lightning/fire already established, just authored from a Token's
 * live position instead of a static anchor or a Foundry document.
 *
 * ⚠️ STAGE 1 SCOPE (mythica-machina-press#77's own "Correction" comment) —
 * ONLY `torch` and `flashlight` are rendered here. The four vision-mode keys
 * (`nightVision`/`lowLight`/`infravision`/`activeInfravision`) are real,
 * selectable token-flag values (`player-light-mode.js#PLAYER_LIGHT_MODES`)
 * with NO visual treatment yet — Stage 2's own per-viewer TSL screen-space
 * grades, a completely different pipeline (a viewer-side post-process, not a
 * world-space point light). A token carrying one of those four simply
 * produces no descriptor here — silently, by construction (the mode filter
 * below), not a bug: the UI (`ui/rooms/player-light-picker.js`) is what tells
 * the player honestly that nothing renders yet, this module just doesn't
 * pretend to light anything for them.
 *
 * ⚠️ NO WIND RESPONSE (Stage 1 simplification, named rather than silent). A
 * candle/fire light's wind lean/gutter/snuff needs a per-position sky-
 * exposure sample (`boot.js#getCandleRenderState`'s own `safeSampleOutdoors`
 * call) — plumbing this module has no access to and Stage 1 does not build.
 * `windExposure`/`windResponse` are simply omitted from every descriptor
 * below, which `point-light-illumination.js`'s own `Number.isFinite(windExposure)`
 * gate already treats as "build no wind node at all" — the SAME safety-slide
 * every other un-wired wind consumer in this codebase gets, not a special
 * case invented here.
 *
 * @module effects/lighting/player-light-geometry
 */

/** `#rrggbb` → linear-ish [r,g,b] in 0..1 — same tiny local parser every
 * sibling geometry file (candle/fire/lightning) carries its own copy of
 * rather than sharing, per this codebase's own established precedent. */
function hexToRgb01(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** A closed circular polygon around (cx, cy), Foundry's own flat
 * `[x0,y0,x1,y1,...]` light-shape format — the naive fallback every sibling
 * light source builds before the light pool's own wall-clip cache
 * (point-light-pool.js) replaces it with a real wall-aware sweep wherever one
 * is available. */
function playerLightCirclePolygon(cx, cy, radius, segments = 32) {
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
 * A carrying token's own live FACING, as a world-space unit vector — the one
 * new live input the flashlight beam needs beyond position
 * (mythica-machina-press#579/#77 Stage 2a). Reads Foundry's `TokenDocument.
 * rotation` (degrees, `common/data/fields.mjs#AngleField`, a real synced
 * document field every connected client sees identically) — this is
 * SAMPLING position/rotation data, exactly the same posture Stage 1 already
 * established for `token.center` feeding a light's `x`/`y`: reading a
 * document field for "which way is this token facing" is not the same as
 * writing Foundry's own light-rendering fields, which is what #77's
 * "Correction" comment rejected.
 *
 * CONVENTION, verified against the vendored v14 client source rather than
 * assumed (`client/canvas/placeables/token.mjs`#`_refreshRotation`:
 * `this.mesh.angle = this.document.lockRotation ? 0 : this.document.rotation`
 * — a raw, uncorrected pass-through onto the token sprite's own PIXI
 * rotation): 0° means the token's own artwork faces "up" — world -Y, since
 * Foundry's canvas Y grows downward — and the angle increases CLOCKWISE, the
 * standard compass-bearing convention. `lockRotation` freezes the VISUAL
 * facing at 0 regardless of the document's stored `rotation` value, so a
 * locked token's beam always points up/north — matching what a player
 * actually sees on their own screen, not the (possibly stale) stored number.
 *
 * @param {number} rotationDeg - `TokenDocument.rotation`, degrees.
 * @param {boolean} [lockRotation=false] - `TokenDocument.lockRotation`.
 * @returns {{x: number, y: number}} a unit vector (or `{x:0,y:-1}`, "up", for
 *   a non-finite input — never `{x:NaN,y:NaN}`).
 */
export function tokenRotationToForwardVector(rotationDeg, lockRotation = false) {
  const deg = lockRotation ? 0 : Number(rotationDeg);
  const rad = (Number.isFinite(deg) ? deg : 0) * (Math.PI / 180);
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** A stable, position-derived pseudo-seed — same classic GLSL-hash shape as
 * `candle-flame-geometry.js#deriveCandleSeed`/`fire-geometry.js#deriveFireSeed`,
 * so a room of several torches desyncs its flicker the identical way a room
 * of candles already does. */
function deriveTokenSeed(x, y) {
  const raw = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return Math.abs(raw - Math.floor(raw)) * 1000;
}

/**
 * THE TWO STAGE-1 MODE PRESETS — everything about "what a torch/flashlight
 * looks like" lives here, one place, named constants (this codebase's own
 * comment discipline: a bug or a re-tune has exactly one number to change).
 *
 * `torch`: warm/amber, modest reach, MSA's own noise-driven flicker (reuses
 * `candleFlicker` — see this module's own header for why a second flicker
 * implementation was rejected).
 *
 * `flashlight`: cooler/near-white, `radiusPx` is now the beam's own THROW
 * LENGTH (STAGE 2A, mythica-machina-press#579/#77 — was a plain omni pool's
 * radius; bumped from 420 to 620 because a beam needs genuine reach to read
 * as a flashlight rather than a big torch), NO animation, `falloffModel:
 * 'beam'` — a real SDF cone/beam (`point-light-illumination.js#
 * buildBeamFalloffNode`), narrow near the bearer and widening with distance,
 * with a hot core / softer mid / faint rim across its own width. The
 * `beam*` fields below are that shape's ENTIRE authored surface — one place,
 * named constants, same discipline this preset block already followed for
 * torch. Mesh footprint stays a plain wall-clipped circle sized to
 * `radiusPx` (see `buildBeamFalloffNode`'s own header for why the directional
 * shape can only live in the shader, never the polygon).
 */
const PLAYER_LIGHT_MODE_PRESETS = Object.freeze({
  torch: Object.freeze({
    radiusPx: 220,
    ratio: 0.18,
    attenuation01: 0.7,
    luminosity01: 0.35,
    alpha01: 0.75,
    colorHex: '#ff9a42',
    falloffModel: 'inverseSquare',
    animated: true,
    animationQuality: 1, // candle-flicker.js tier 1 ("standard") — chaotic guttering, no oval/lean
  }),
  flashlight: Object.freeze({
    radiusPx: 620,
    ratio: 0.22,
    attenuation01: 0.6,
    luminosity01: 0.4,
    alpha01: 0.55,
    colorHex: '#dcecff',
    falloffModel: 'beam',
    animated: false,
    // BEAM SHAPE (Stage 2a) — all fractions of `radiusPx` (the beam's own
    // local unit-radius space, matching `dist`'s normalization elsewhere in
    // this pipeline).
    beamNearHalfWidth01: 0.05, // tight at the bearer's own hand
    beamFarHalfWidth01: 0.55, // wide open at max reach
    beamEdgeSoftness01: 0.18, // a soft, not razor, silhouette edge
    beamLengthFalloffExponent: 1.6, // reach falls off faster than linear
    beamCoreIntensity: 1.6, // hot core — legitimately brighter than the ambient it mixes toward
    beamMidIntensity: 1.0,
    beamRimIntensity: 0.35,
  }),
});

/** The two Stage-1-rendered mode keys — everything else in
 * `player-light-mode.js#PLAYER_LIGHT_MODES` is real and selectable but
 * produces no descriptor here (see this module's own Stage-1-scope header). */
export const PLAYER_LIGHT_RENDERED_MODES = Object.freeze(Object.keys(PLAYER_LIGHT_MODE_PRESETS));

/**
 * Build ONE light-source descriptor for a single carried light, or `null` if
 * this token's mode has no Stage-1 render (a vision mode) or the scene's own
 * permissions currently disallow it. Exported standalone (not just via the
 * batch `buildPlayerLightSources` below) so the light-pool merge point and a
 * unit test can both reason about one token without a whole-array dance.
 *
 * @param {{tokenId: string, x: number, y: number, elevation: number, mode: string}} tokenSnapshot
 * @param {{modes: Record<string, boolean>}} permissions - `resolvePlayerLightPermissions`'s own shape.
 * @returns {object|null}
 */
export function buildOnePlayerLightSource(tokenSnapshot, permissions) {
  const mode = tokenSnapshot?.mode;
  const preset = PLAYER_LIGHT_MODE_PRESETS[mode];
  if (!preset) return null; // a vision-mode pick, or an unrecognized/absent mode — nothing to render yet
  if (permissions?.modes?.[mode] !== true) return null; // the GM has not (or no longer) allowed this mode on this scene
  const x = Number(tokenSnapshot.x);
  const y = Number(tokenSnapshot.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const elevation = Number.isFinite(tokenSnapshot.elevation) ? tokenSnapshot.elevation : 0;
  const seed = deriveTokenSeed(x, y);
  const isBeam = preset.falloffModel === 'beam';
  return {
    sourceId: `playerLight:${tokenSnapshot.tokenId}`,
    ownerEffectId: 'playerLight',
    x,
    y,
    elevation,
    radius: preset.radiusPx,
    shapePoints: playerLightCirclePolygon(x, y, preset.radiusPx),
    ratio: preset.ratio,
    attenuation01: preset.attenuation01,
    luminosity01: preset.luminosity01,
    hasColor: true,
    alpha01: preset.alpha01,
    color: hexToRgb01(preset.colorHex),
    falloffModel: preset.falloffModel,
    // FLASHLIGHT BEAM (Stage 2a) — `null` for every non-beam mode (torch
    // today). `beamDirection` is the bearer's LIVE facing, re-derived every
    // call from this frame's own `tokenSnapshot.rotation` (never cached —
    // the same "recomputed every call" contract this module's own header
    // already documents for position); `beamShape` is the preset's own
    // constant shape, read straight through so `point-light-pool.js`'s
    // material builder can bake it once at entry-creation time.
    beamDirection: isBeam ? tokenRotationToForwardVector(tokenSnapshot.rotation, tokenSnapshot.lockRotation) : null,
    beamShape: isBeam
      ? {
          nearHalfWidth01: preset.beamNearHalfWidth01,
          farHalfWidth01: preset.beamFarHalfWidth01,
          edgeSoftness01: preset.beamEdgeSoftness01,
          lengthFalloffExponent: preset.beamLengthFalloffExponent,
          coreIntensity: preset.beamCoreIntensity,
          midIntensity: preset.beamMidIntensity,
          rimIntensity: preset.beamRimIntensity,
        }
      : null,
    animation: preset.animated
      ? {
          type: 'candleFlicker',
          speedRaw: 5,
          intensityRaw: 5,
          reverse: false,
          seed,
          quality: preset.animationQuality,
        }
      : null,
  };
}

/**
 * Build every currently-active, currently-allowed player-carried light
 * source for this frame. Pure and total — no THREE, no Foundry: the live
 * per-token read (`player-light-mode.js#readActivePlayerCarriedLightTokens`)
 * and the live permissions read (`player-light-permissions.js#
 * readScenePlayerLightPermissions`) both happen at the injected getter's own
 * call site (`boot.js`'s `getPlayerCarriedLightSources` closure), never here.
 *
 * @param {Array<{tokenId: string, x: number, y: number, elevation: number, mode: string}>} tokenSnapshots
 * @param {{modes: Record<string, boolean>}} permissions
 * @returns {Array<object>} light source descriptors, `point-light-pool.js`-ready.
 */
export function buildPlayerLightSources(tokenSnapshots, permissions) {
  const list = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];
  const out = [];
  for (const snap of list) {
    const source = buildOnePlayerLightSource(snap, permissions);
    if (source) out.push(source);
  }
  return out;
}
