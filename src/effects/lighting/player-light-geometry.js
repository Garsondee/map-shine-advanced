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

/**
 * Which way a carried beam points THIS frame. A live aim — `aimAngleDeg`, the
 * bearer's own cursor or the angle their client relayed
 * (`foundry/player-aim-channel.js#annotate`), in `TokenDocument.rotation`'s own
 * convention — outranks the token's stored facing, and ignores `lockRotation`:
 * that setting pins how the token's ARTWORK is drawn, not where its bearer is
 * pointing a flashlight. With no aim (nobody has moved a cursor yet, a relayed
 * aim went stale, a flashlight set on an NPC by hand) the beam follows the
 * token's rotation exactly as it did before aiming existed.
 *
 * @param {{aimAngleDeg?: number|null, rotation?: number, lockRotation?: boolean}} [snapshot]
 * @returns {{x: number, y: number}} a unit vector, as {@link tokenRotationToForwardVector}.
 */
export function resolveBeamDirection({ aimAngleDeg, rotation, lockRotation } = {}) {
  if (Number.isFinite(aimAngleDeg)) return tokenRotationToForwardVector(aimAngleDeg, false);
  return tokenRotationToForwardVector(rotation, lockRotation);
}

function scaleVec2(v, k) {
  return { x: v.x * k, y: v.y * k };
}

/**
 * How much of its full throw a flashlight's beam is drawn at, from how far away
 * its bearer's cursor is (`reachPx`): the beam reaches the cursor, never past the
 * preset's full length and never less than `minReach01` of it.
 * No reach known (an older client, no cursor yet) is the full beam.
 *
 * HOW THE SHADER IS TOLD: not with a new uniform. The falloff reads
 * `axial = dot(fragment, beamDirection)` and `lateral = |dot(fragment, perp)|`
 * with NO normalization (`point-light-illumination.js#buildBeamFalloffNode`), so
 * a `beamDirection` of length `1/reach01` makes a fragment at (a, l) behave as
 * the full beam's (a/reach01, l/reach01) — the whole beam, cone angle and all,
 * scaled down about the bearer. The pool, both materials and the shader are
 * untouched; `point-light-illumination.test.mjs` pins the scaling identity.
 *
 * @param {number|undefined} reachPx
 * @param {number} radiusPx - the preset's full throw.
 * @param {number} minReach01
 * @returns {number} in [minReach01, 1]
 */
export function resolveBeamReach01(reachPx, radiusPx, minReach01) {
  if (!Number.isFinite(reachPx) || !(radiusPx > 0)) return 1;
  return Math.min(1, Math.max(minReach01, reachPx / radiusPx));
}

/**
 * A torch is OUT below this burn: no light, no flame. A burn that low is
 * already invisible (alpha scales with it), so nothing pops.
 */
export const PLAYER_TORCH_OUT_BELOW_BURN01 = 0.03;

/**
 * How brightly a held torch burns this frame, 0..1 — what its bearer's client
 * relayed (`foundry/player-aim-channel.js`: 1 until the cursor is dragged past
 * the leash, then falling to 0). No burn known is a torch burning normally. The
 * ONE definition, read by both the light and its flame, so they can never
 * disagree about whether the torch is out.
 * @param {{burn01?: number}} snapshot
 * @returns {number}
 */
export function resolveTorchBurn01(snapshot) {
  const b = snapshot?.burn01;
  return Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 1;
}

/** Below this burn a torch starts to redden — the amber shifts toward ember red as it dies. */
const TORCH_EMBER_START_BURN01 = 0.7;
/** The colour a dying torch fades to (a coal, not a flame). */
const TORCH_EMBER_HEX = '#c7301a';

/**
 * How far a guttering torch has shifted from its normal colour toward ember red:
 * 0 at and above burn 0.7, 1 at the point it goes out. (V2 swapped the whole
 * flame to red the instant it guttered; a blend reads as dying, not as a switch.)
 * @param {number} burn01
 * @returns {number} 0..1
 */
export function resolveTorchEmberMix01(burn01) {
  const span = TORCH_EMBER_START_BURN01 - PLAYER_TORCH_OUT_BELOW_BURN01;
  return Math.min(1, Math.max(0, (TORCH_EMBER_START_BURN01 - burn01) / span));
}

/** `#rrggbb` blended toward the ember red by `mix01`, as `#rrggbb`. */
export function mixTowardEmberHex(baseHex, mix01) {
  const a = hexToRgb01(baseHex);
  const b = hexToRgb01(TORCH_EMBER_HEX);
  const to = (i) =>
    Math.round((a[i] + (b[i] - a[i]) * mix01) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(0)}${to(1)}${to(2)}`;
}

/** A guttering torch lights a smaller area: its radius falls to this fraction of full as it dies. */
const TORCH_MIN_RADIUS_FRACTION = 0.1;

/**
 * Where a carried light — and, for a torch, its flame and embers — sits THIS
 * frame: the token's centre, plus the displacement of a light the bearer holds
 * out toward their cursor (`offsetX`/`offsetY`, world px, stamped by
 * `foundry/player-aim-channel.js#annotate`). No offset means the token's centre,
 * exactly as before holding existed. One definition so the light and the flame
 * can never disagree about where the torch is.
 *
 * @param {{x: number, y: number, offsetX?: number, offsetY?: number}} snapshot
 * @returns {{x: number, y: number}}
 */
export function resolveLightPosition(snapshot) {
  const dx = Number.isFinite(snapshot?.offsetX) ? snapshot.offsetX : 0;
  const dy = Number.isFinite(snapshot?.offsetY) ? snapshot.offsetY : 0;
  return { x: Number(snapshot?.x) + dx, y: Number(snapshot?.y) + dy };
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
    // HELD OUT at the bearer's cursor (`resolveLightPosition`): the light and its
    // flame sit at the end of an arm, not on the token.
    aimed: true,
    held: true,
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
    // POINTED at the bearer's cursor (`resolveBeamDirection`).
    aimed: true,
    // The beam is never drawn shorter than this fraction of `radiusPx`, however
    // close the cursor is — a flashlight pointed at your own feet still lights a
    // patch of floor (V2's floor was ~1.5 grid units).
    beamMinReach01: 0.2,
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

/** The rendered modes whose light is HELD OUT (displaced from its bearer, and able to gutter) — what `foundry/player-aim.js#PLAYER_AIM_HELD_MODES` mirrors. */
export const PLAYER_LIGHT_HELD_MODES = Object.freeze(
  PLAYER_LIGHT_RENDERED_MODES.filter((mode) => PLAYER_LIGHT_MODE_PRESETS[mode].held === true)
);

/** The rendered modes the bearer's cursor steers — what `foundry/player-aim.js#PLAYER_AIM_MODES` mirrors (a test holds them together). */
export const PLAYER_LIGHT_AIMED_MODES = Object.freeze(
  PLAYER_LIGHT_RENDERED_MODES.filter((mode) => PLAYER_LIGHT_MODE_PRESETS[mode].aimed === true)
);

/**
 * Build ONE light-source descriptor for a single carried light, or `null` if
 * this token's mode has no Stage-1 render (a vision mode) or the scene's own
 * permissions currently disallow it. Exported standalone (not just via the
 * batch `buildPlayerLightSources` below) so the light-pool merge point and a
 * unit test can both reason about one token without a whole-array dance.
 *
 * @param {{tokenId: string, x: number, y: number, elevation: number, mode: string, rotation?: number, lockRotation?: boolean, aimAngleDeg?: number, reachPx?: number, offsetX?: number, offsetY?: number, burn01?: number}} tokenSnapshot
 *   `aimAngleDeg` (optional) is the bearer's live aim — see {@link resolveBeamDirection};
 *   `reachPx` (optional) is how far away their cursor is — see {@link resolveBeamReach01};
 *   `offsetX`/`offsetY` (optional) is a held light's displacement — see {@link resolveLightPosition}.
 * @param {{modes: Record<string, boolean>}} permissions - `resolvePlayerLightPermissions`'s own shape.
 * @returns {object|null}
 */
export function buildOnePlayerLightSource(tokenSnapshot, permissions) {
  const mode = tokenSnapshot?.mode;
  const preset = PLAYER_LIGHT_MODE_PRESETS[mode];
  if (!preset) return null; // a vision-mode pick, or an unrecognized/absent mode — nothing to render yet
  if (permissions?.modes?.[mode] !== true) return null; // the GM has not (or no longer) allowed this mode on this scene
  const { x, y } = resolveLightPosition(tokenSnapshot);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // A held torch that has gone out is no light at all; one that is guttering is
  // dimmer (alpha) and lights less ground (radius) in proportion.
  const burn01 = preset.held === true ? resolveTorchBurn01(tokenSnapshot) : 1;
  if (burn01 < PLAYER_TORCH_OUT_BELOW_BURN01) return null;
  const radiusPx = preset.radiusPx * (TORCH_MIN_RADIUS_FRACTION + (1 - TORCH_MIN_RADIUS_FRACTION) * burn01);
  const elevation = Number.isFinite(tokenSnapshot.elevation) ? tokenSnapshot.elevation : 0;
  // Seeded from the TOKEN's own position, not the light's: a torch held out under
  // a moving cursor changes position every frame, and re-seeding its flicker
  // every frame would read as a stutter rather than a flame.
  const seed = deriveTokenSeed(Number(tokenSnapshot.x), Number(tokenSnapshot.y));
  const isBeam = preset.falloffModel === 'beam';
  const beamReach01 = isBeam ? resolveBeamReach01(tokenSnapshot.reachPx, preset.radiusPx, preset.beamMinReach01) : null;
  return {
    sourceId: `playerLight:${tokenSnapshot.tokenId}`,
    ownerEffectId: 'playerLight',
    x,
    y,
    elevation,
    radius: radiusPx,
    shapePoints: playerLightCirclePolygon(x, y, radiusPx),
    ratio: preset.ratio,
    attenuation01: preset.attenuation01,
    luminosity01: preset.luminosity01,
    hasColor: true,
    alpha01: preset.alpha01 * burn01,
    // A dying torch reddens toward ember (the flame and embers follow, see
    // player-torch-flame-geometry.js); a full-burn one is exactly its preset colour.
    color: hexToRgb01(mixTowardEmberHex(preset.colorHex, burn01 < 1 ? resolveTorchEmberMix01(burn01) : 0)),
    falloffModel: preset.falloffModel,
    // FLASHLIGHT BEAM (Stage 2a) — `null` for every non-beam mode (torch
    // today). `beamDirection` is the bearer's LIVE aim — their cursor, local or
    // relayed — else their token's rotation (`resolveBeamDirection`), re-derived
    // every call from this frame's own snapshot (never cached — the same
    // "recomputed every call" contract this module's own header already
    // documents for position); `beamShape` is the preset's own
    // constant shape, read straight through so `point-light-pool.js`'s
    // material builder can bake it once at entry-creation time.
    // Its LENGTH is 1/beamReach01 (1 = a unit vector, the full beam) — see
    // `resolveBeamReach01` for why that, rather than a uniform, sets the throw.
    beamDirection: isBeam ? scaleVec2(resolveBeamDirection(tokenSnapshot), 1 / beamReach01) : null,
    beamReach01,
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
    // Always an object, never null — the same shape scene lights' own
    // `deriveAnimationSnapshot` produces (`type: null` for "not animated").
    // (A `null` here once crashed the render loop; the pool now also falls
    // back to `NO_LIGHT_ANIMATION`, but descriptors should still be well-formed.)
    animation: {
      type: preset.animated ? 'candleFlicker' : null,
      speedRaw: 5,
      intensityRaw: 5,
      reverse: false,
      seed,
      quality: preset.animated ? preset.animationQuality : 0,
    },
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
