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
 * ONLY `torch` and `flashlight` are rendered here. The five vision-mode keys
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

/** `a` at `t`=0, `b` at `t`=1 — the one lerp this module needs, for a flashlight
 * cookie's own distance-dependent blur/brightness (see the flashlight preset).
 * A non-finite `t` reads as 0 (`a`, the close-in end), never `NaN`. */
function lerp01(a, b, t) {
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return a + (b - a) * k;
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
 * A BEARING, in `TokenDocument.rotation`'s own convention, as a world-space
 * unit vector. It was written for a carrying token's stored FACING
 * (mythica-machina-press#579/#77 Stage 2a) and that is still the only kind of
 * angle a Foundry document hands out — degrees, `common/data/fields.mjs#
 * AngleField`, a real synced field every connected client sees identically —
 * but the live beam no longer reads a facing at all: it converts the bearer's
 * own AIM (`resolveBeamDirection`). What is left here is the convention, in one
 * place. Reading a document's own angle to learn "which way is this token
 * facing" remains SAMPLING document data, the same posture Stage 1 already
 * established for `token.center` feeding a light's `x`/`y`, and not writing
 * Foundry's own light-rendering fields, which is what #77's "Correction"
 * comment rejected.
 *
 * CONVENTION, verified against the vendored v14 client source rather than
 * assumed (`client/canvas/placeables/token.mjs`#`_refreshRotation`:
 * `this.mesh.angle = this.document.lockRotation ? 0 : this.document.rotation`
 * — a raw, uncorrected pass-through onto the token sprite's own PIXI
 * rotation): 0° means the token's own artwork faces "up" — world -Y, since
 * Foundry's canvas Y grows downward — and the angle increases CLOCKWISE, the
 * standard compass-bearing convention. Every bearing this module converts —
 * the bearer's live aim included — is in THAT convention, which is why this
 * helper outlived the token-rotation fallback it was first written for. (It
 * takes an ANGLE and nothing else: `lockRotation` is a token-DOCUMENT setting
 * again, applied where the artwork is drawn, not to a bearing.)
 *
 * @param {number} rotationDeg - an angle in that convention, degrees.
 * @returns {{x: number, y: number}} a unit vector (or `{x:0,y:-1}`, "up", for
 *   a non-finite input — never `{x:NaN,y:NaN}`).
 */
export function tokenRotationToForwardVector(rotationDeg) {
  const deg = Number(rotationDeg);
  const rad = (Number.isFinite(deg) ? deg : 0) * (Math.PI / 180);
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/**
 * Whether anybody is actually STEERING this carried light this frame — the
 * bearer's own cursor, or the aim their client relayed
 * (`foundry/player-aim-channel.js#annotate`). The ONE definition of "lit", read
 * by the light AND its flame, so they can never disagree about whether a torch
 * is burning — the same role `resolveTorchBurn01` plays for "is it OUT".
 *
 * NO AIM IS NO LIGHT (2026-10-15, the author's own ask: "as soon as I deselect
 * the token the flashlight points north… as a GM the flashlight should turn
 * off and for the players it should always follow their cursor IF that token
 * is owned by them with full control"). A carried light is CHOSEN on a token
 * (a per-token flag, `player-light-mode.js`) but it only exists once somebody
 * drives it: a player's own token is always steered by their cursor, a GM
 * steers whichever token they have SELECTED, and a scene freshly loaded — or a
 * token whose owner has disconnected — carries no light at all rather than a
 * beam frozen pointing north (`TokenDocument.rotation`'s own 0°).
 *
 * @param {{aimAngleDeg?: number|null}} [snapshot]
 * @returns {boolean}
 */
export function hasCarriedLightAim(snapshot) {
  return Number.isFinite(snapshot?.aimAngleDeg);
}

/**
 * Which way a carried beam points THIS frame: `aimAngleDeg` — the bearer's own
 * cursor or the angle their client relayed (`foundry/player-aim-channel.js#
 * annotate`), in `TokenDocument.rotation`'s own convention. `lockRotation` is
 * deliberately not consulted: that setting pins how the token's ARTWORK is
 * drawn, not where its bearer is pointing a flashlight.
 *
 * `null` means nobody is steering this light — see {@link hasCarriedLightAim},
 * which is what every renderer gates on; there is no fallback to the token's
 * stored facing any more.
 *
 * @param {{aimAngleDeg?: number|null}} [snapshot]
 * @returns {{x: number, y: number}|null} a unit vector, as
 *   {@link tokenRotationToForwardVector}, or `null` when nobody is aiming.
 */
export function resolveBeamDirection({ aimAngleDeg } = {}) {
  if (!Number.isFinite(aimAngleDeg)) return null;
  return tokenRotationToForwardVector(aimAngleDeg);
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
 * a `beamDirection` of length `1/reach01` puts this beam's END exactly `reach01`
 * of the way out: the shader's own `axial` reaches 1 there, which is where its
 * length falloff arrives at zero. The cone's own WIDTH no longer shrinks with the
 * drawn length (2026-10-15) — it is world-anchored, a fixed mouth plus a fixed
 * divergence, so a shortened beam is the full beam TRUNCATED rather than a scaled
 * copy of it. (A cone scaled down about the bearer collapses to a needle at
 * point-blank range, which is exactly what the author reported.) The pool, both
 * materials and the shader's uniform list are untouched;
 * `point-light-illumination.test.mjs` pins the width identity.
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

/**
 * How far from its token's centre a flashlight sits, along its beam: on the rim
 * of the circle the token occupies, so the light starts outside the token and
 * does not wash over the artwork that carries it. It rolls around that rim as the
 * aim turns. `rimPx` is what `foundry/player-aim-channel.js#annotate` worked out,
 * already pulled in from any wall the rim would cross; without it the plain
 * radius is the best this pure module can say. No radius known is the centre.
 *
 * The beam is aimed down the line from the token's centre to the cursor, and the
 * rim point lies on that line, so a beam that starts there and points the same
 * way still ends exactly at the cursor.
 *
 * @param {{rimPx?: number, radiusPx?: number}} [snapshot]
 * @returns {number} px, >= 0
 */
export function resolveFlashlightRimPx(snapshot) {
  if (Number.isFinite(snapshot?.rimPx)) return Math.max(0, snapshot.rimPx);
  const radius = Number(snapshot?.radiusPx);
  return Number.isFinite(radius) && radius > 0 ? radius : 0;
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
 * `flashlight`: WARM near-white — an old-fashioned incandescent torch
 * (2026-10-15; the author's own ask that the beam, the cookie spot it lands on
 * and that spot's own bounced fill all carry ONE very slightly warm colour, so
 * `colorHex` below is that single number and all three read it), `radiusPx` is
 * now the beam's own THROW
 * LENGTH (STAGE 2A, mythica-machina-press#579/#77 — was a plain omni pool's
 * radius; bumped from 420 to 620 when the beam landed, then to 820 when the
 * torch's own omni pool grew to 690 — a focused beam must still reach further
 * than a torch throws in every direction), NO animation, `falloffModel:
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
    radiusPx: 690,
    ratio: 0.25,
    attenuation01: 0.7,
    luminosity01: 0.65,
    alpha01: 1,
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
    // The beam's own THROW: wider than the torch's omni pool (690) because a
    // focused beam must genuinely reach further than the thrower of a torch.
    radiusPx: 820,
    ratio: 0.22,
    attenuation01: 0.6,
    luminosity01: 0.4,
    alpha01: 0.55,
    // ONE warm white for the WHOLE lamp — the beam, the cookie spot and the
    // bounced fill all read this (see this preset block's own header). An old
    // incandescent bulb, not a modern LED: a real but gentle push toward amber
    // (red over blue, nowhere near the torch's own #ff9a42).
    colorHex: '#fff0d6',
    falloffModel: 'beam',
    animated: false,
    // POINTED at the bearer's cursor (`resolveBeamDirection`).
    aimed: true,
    // The beam is never drawn shorter than this fraction of `radiusPx` — a
    // NUMERICAL floor (the shader is handed `1/beamReach01`), not a gameplay one.
    // It was 0.2 ("a flashlight pointed at your own feet still lights a patch of
    // floor, V2's floor was ~1.5 grid units"), which the author caught live
    // (2026-10-15): drawn length a cursor closer than the floor never asked for
    // is length the beam paints PAST the cookie — "the arc is a thin needle and
    // extends beyond the cookie". The beam now ends where the cursor is; the
    // patch of floor a beam aimed at its bearer's own feet lights comes from the
    // cookie's own `endpointLightMinRadiusPx` below, which needs no length at all.
    beamMinReach01: 0.02,
    // BEAM SHAPE (Stage 2a) — all fractions of `radiusPx` (the beam's own
    // local unit-radius space, matching `dist`'s normalization elsewhere in
    // this pipeline).
    beamNearHalfWidth01: 0.02, // tight at the bearer's own hand
    beamFarHalfWidth01: 0.17, // about a 19° full cone at maximum throw
    beamEdgeSoftness01: 0.2, // a soft, not razor, silhouette edge
    beamLengthFalloffExponent: 1.6, // reach falls off faster than linear
    beamCoreIntensity: 1.6, // hot core — legitimately brighter than the ambient it mixes toward
    beamMidIntensity: 1.0,
    beamRimIntensity: 0.35,
    // ENDPOINT SPOT — the flashlight's own projected cookie, sized from the
    // beam's cone width AT the endpoint (not an independent radius ramp), so the
    // spot is exactly as wide as the arc of light that reaches it: narrow when
    // the cursor is close, wide when far. `*Elongation` squashes it into an oval
    // along the beam (a grazing-angle spot) and grows with distance.
    endpointLightMinRadiusPx: 26, // a floor, so a beam aimed at the bearer's own feet still shows a spot
    endpointLightMinElongation: 1.05,
    endpointLightElongationPerReach: 0.55,
    // ...and its SHADING softens and dims the further away that spot lands
    // (2026-10-15, the author's own ask: "make the cookie become more blurred as
    // it goes further away and have it become less bright as it reaches away from
    // the token" — each `*Near01` is the value with the cursor on the token itself,
    // each `*Far01` at full throw, and the descriptor lerps between them on
    // `reach01`). Attenuation below is the BLUR knob, and the cookie's descriptor
    // is on `foundry`'s own falloff model — the ONE model that reads it — so a low
    // attenuation close in is a compact, defined spot of the gobo, while a high one
    // at arm's length spreads the same pattern out into a broad, soft smear.
    // Luminosity and the coloured alpha both fall with distance on top of that,
    // which is the "less bright as it reaches away" half.
    endpointLightAttenuationNear01: 0.3,
    endpointLightAttenuationFar01: 0.85,
    endpointLightLuminosityNear01: 0.85,
    endpointLightLuminosityFar01: 0.32,
    endpointLightAlphaNear01: 0.9,
    endpointLightAlphaFar01: 0.42,
    // BOUNCED LIGHT (2026-10-15, author's own follow-up: "the flashlight needs
    // its own point light where the cookie is… a much larger radius but soft…
    // this represents bounced light from the cookie splashing to fill the
    // room"). A THIRD source, co-located with the cookie spot above and left
    // exactly there: the cookie itself must keep matching the cone's own arc
    // (see `endpointLight*`), so the fill is carried by its OWN light rather
    // than by inflating the spot. A plain CIRCLE, never an oval — bounced light
    // scatters off whatever surface it lands on in every direction; it does not
    // keep the beam's shape. `bounceRadiusPx` is 0.61× the beam's throw with a
    // point-blank beam and 0.8× at full reach, against the cookie's own 26..139
    // px — a genuine room-filler.
    //
    // The SHADING half of this light (ratio/attenuation/luminosity/alpha) sits
    // with the flashlight's OTHER extra light — the cookie spot — in
    // `buildPlayerLightSources` below, right where that light's own constants
    // already are: the two are read side by side when tuning. Its COLOUR is the
    // one exception, and deliberately so — that is this lamp's own `colorHex`
    // above, the single warm tint the beam, the cookie spot and this fill share.
    bounceRadiusPx: 460,
    bounceRadiusPerReachPx: 200,
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
 * @param {{tokenId: string, x: number, y: number, elevation: number, mode: string, aimAngleDeg?: number, reachPx?: number, offsetX?: number, offsetY?: number, burn01?: number, radiusPx?: number, rimPx?: number}} tokenSnapshot
 *   `aimAngleDeg` is the bearer's live aim — WITHOUT it an aimed mode produces no
 *   source at all ({@link hasCarriedLightAim}), and it is also the beam's own
 *   direction ({@link resolveBeamDirection});
 *   `reachPx` is how far away their cursor is — see {@link resolveBeamReach01};
 *   `offsetX`/`offsetY` is a held light's displacement — see {@link resolveLightPosition}.
 * @param {{modes: Record<string, boolean>}} permissions - `resolvePlayerLightPermissions`'s own shape.
 * @returns {object|null}
 */
export function buildOnePlayerLightSource(tokenSnapshot, permissions) {
  const mode = tokenSnapshot?.mode;
  const preset = PLAYER_LIGHT_MODE_PRESETS[mode];
  if (!preset) return null; // a vision-mode pick, or an unrecognized/absent mode — nothing to render yet
  if (permissions?.modes?.[mode] !== true) return null; // the GM has not (or no longer) allowed this mode on this scene
  // NO AIM IS NO LIGHT (2026-10-15) — see {@link hasCarriedLightAim}: a carried
  // light exists only while somebody is steering it, so a token in a freshly
  // loaded scene (or one whose owner has disconnected) renders NO source at all
  // rather than a beam frozen pointing north, and neither does its flame below.
  if (PLAYER_LIGHT_AIMED_MODES.includes(mode) && !hasCarriedLightAim(tokenSnapshot)) return null;
  const isBeam = preset.falloffModel === 'beam';
  const beamUnit = isBeam ? resolveBeamDirection(tokenSnapshot) : null;
  // A beam starts on the rim of its token's circle, in the direction it points.
  const rimPx = isBeam ? resolveFlashlightRimPx(tokenSnapshot) : 0;
  const held = resolveLightPosition(tokenSnapshot);
  const x = isBeam ? held.x + beamUnit.x * rimPx : held.x;
  const y = isBeam ? held.y + beamUnit.y * rimPx : held.y;
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
  // `reachPx` is how far the cursor is from the token's CENTRE; the beam starts
  // `rimPx` out along that line, so it needs that much less to reach the cursor.
  const beamReachPx = Number.isFinite(tokenSnapshot.reachPx) ? Math.max(0, tokenSnapshot.reachPx - rimPx) : undefined;
  const beamReach01 = isBeam ? resolveBeamReach01(beamReachPx, preset.radiusPx, preset.beamMinReach01) : null;
  // The endpoint tracks the AIM POINT — the post-wall-clamp cursor distance
  // (`player-aim-channel.js` clamps `reachPx` to the first wall hit, so the
  // cookie can never land on the far side of a wall) — and it is derived from
  // `beamReach01` ITSELF rather than from the raw cursor distance, so the spot
  // sits exactly where the beam's own arc stops at every range. The two can then
  // never drift apart into the author's own 2026-10-15 report ("the arc is a
  // thin needle and extends beyond the cookie"): whatever the beam is drawn, the
  // cookie is at its end.
  const endpointReachPx = isBeam ? beamReach01 * preset.radiusPx : 0;
  // The cone's HALF-WIDTH at that aim point, in the same unit-radius space the
  // beam shader uses. The shader's width is world-anchored — a fixed mouth plus a
  // fixed divergence, `near + (far - near)·d/radiusPx` at world distance `d`
  // (`point-light-illumination.js#buildBeamFalloffNode`) — so evaluated at the
  // beam's own end (`d = reach01·radiusPx`) it is exactly this fraction times the
  // throw. The cookie's thin radius is that in world px, so the spot lines up with
  // the arc of light landing there at EVERY reach, not only at full throw. The
  // long axis is that radius times an elongation that grows with distance — a
  // grazing-angle oval.
  const endpointReach01 = preset.radiusPx > 0 ? Math.min(1, endpointReachPx / preset.radiusPx) : 0;
  const endpointConeHalfWidth01 =
    preset.beamNearHalfWidth01 + (preset.beamFarHalfWidth01 - preset.beamNearHalfWidth01) * endpointReach01;
  const endpointRadiusPx = Math.max(preset.endpointLightMinRadiusPx, endpointConeHalfWidth01 * preset.radiusPx);
  const endpointElongation =
    preset.endpointLightMinElongation + preset.endpointLightElongationPerReach * endpointReach01;
  const flashlightEndpoint = isBeam
    ? {
        x: x + beamUnit.x * endpointReachPx,
        y: y + beamUnit.y * endpointReachPx,
        radiusPx: endpointRadiusPx,
        alongPx: endpointRadiusPx * endpointElongation,
        angleRad: Math.atan2(beamUnit.y, beamUnit.x),
        // How far out this spot landed, as a fraction of the beam's own throw —
        // what its blur/brightness shading is lerped on (see the descriptor in
        // `buildPlayerLightSources`, and the preset's own `endpointLight*` block).
        reach01: endpointReach01,
      }
    : null;
  // BOUNCED LIGHT (2026-10-15) — the cookie's own landing point (light bounces
  // off whatever the beam actually hit), with a radius that grows with how far
  // that point is, so the fill reads as "the room the beam is in" rather than
  // as a fixed bullseye. Geometry only, like its sibling above; the descriptor
  // that turns it into a light lives beside that sibling's own, below.
  const flashlightBounce =
    flashlightEndpoint && preset.bounceRadiusPx > 0
      ? {
          x: flashlightEndpoint.x,
          y: flashlightEndpoint.y,
          radiusPx: preset.bounceRadiusPx + preset.bounceRadiusPerReachPx * endpointReach01,
        }
      : null;
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
    // relayed — re-derived every call from this frame's own snapshot (never
    // cached — the same "recomputed every call" contract this module's own
    // header already documents for position); `beamShape` is the preset's own
    // constant shape, read straight through so `point-light-pool.js`'s
    // material builder can bake it once at entry-creation time.
    // Its LENGTH is 1/beamReach01 (1 = a unit vector, the full beam) — see
    // `resolveBeamReach01` for why that, rather than a uniform, sets the throw.
    beamDirection: isBeam ? scaleVec2(beamUnit, 1 / beamReach01) : null,
    beamReach01,
    flashlightEndpoint,
    flashlightBounce,
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
    if (!source) continue;
    out.push(source);
    // THE LAMP'S OWN COLOUR, resolved once (2026-10-15). The cookie spot and the
    // bounced fill are both parts of this same flashlight, so all three read the
    // preset's single `colorHex` — one number, one warm tint, no drift between
    // them. (`source.color` is the same value via its own ember-mix call; a
    // flashlight never gutters, so the mix is inert for it.)
    const preset = PLAYER_LIGHT_MODE_PRESETS[snap.mode];
    const lightColor = hexToRgb01(preset.colorHex);
    const endpoint = source.flashlightEndpoint;
    if (endpoint) {
      const radius = Math.max(1, endpoint.radiusPx);
      const endpointReach01 = Number.isFinite(endpoint.reach01) ? endpoint.reach01 : 0;
      out.push({
        sourceId: `playerLightEndpoint:${snap.tokenId}`,
        ownerEffectId: 'playerLight',
        x: endpoint.x,
        y: endpoint.y,
        elevation: source.elevation,
        // `radius` is the THIN (perpendicular) axis; `ellipseAlongPx` the long
        // axis along the beam, and `ellipseAngleRad` orients it. A plain light
        // leaves both unset and stays circular (see point-light-pool's scale).
        radius,
        ellipseAlongPx: Math.max(radius, Number.isFinite(endpoint.alongPx) ? endpoint.alongPx : radius),
        ellipseAngleRad: Number.isFinite(endpoint.angleRad) ? endpoint.angleRad : 0,
        shapePoints: playerLightCirclePolygon(endpoint.x, endpoint.y, radius),
        ratio: 0.2,
        // ...AND ITS SHADING, lerped on how far out the spot landed (2026-10-15
        // — the author's own ask, see the preset's `endpointLight*` block). A
        // flashlight held close lays a compact, defined spot of its gobo on the
        // floor; at arm's length the same pattern is scattershot: bigger, softer
        // edged and dimmer. `attenuation01` is the blur, `luminosity01` the
        // illumination and `alpha01` the coloured glow, all three falling away
        // with distance.
        attenuation01: lerp01(
          preset.endpointLightAttenuationNear01,
          preset.endpointLightAttenuationFar01,
          endpointReach01
        ),
        luminosity01: lerp01(
          preset.endpointLightLuminosityNear01,
          preset.endpointLightLuminosityFar01,
          endpointReach01
        ),
        hasColor: true,
        alpha01: lerp01(preset.endpointLightAlphaNear01, preset.endpointLightAlphaFar01, endpointReach01),
        color: lightColor,
        // FOUNDRY'S OWN MODEL, deliberately (2026-10-15): it is the only falloff
        // in the pool whose attenuation slider does anything at all, and that
        // slider is exactly the blur the line above asks for. The cookie is never
        // batched (`canBatchLight`: a `cookiePattern` light stays on the ordinary
        // path), so this model choice costs nothing.
        falloffModel: 'foundry',
        animation: { type: null, speedRaw: 5, intensityRaw: 5, reverse: false, seed: 0, quality: 0 },
        cookiePattern: 'flashlight',
      });
    }
    // BOUNCED LIGHT (2026-10-15) — see the flashlight preset's own `bounce*`
    // block for what this is and why it is a separate source. NO cookie (this
    // is the fill, not a gobo) and NO ellipse (bounced light scatters off the
    // surface in every direction), so it is the ONE player light the batch path
    // may merge — everything else it needs, the pool's own wall-clip included
    // (keyed on its own sourceId), already flows through the ordinary path.
    const bounce = source.flashlightBounce;
    if (bounce) {
      const radius = Math.max(1, bounce.radiusPx);
      out.push({
        sourceId: `playerLightBounce:${snap.tokenId}`,
        ownerEffectId: 'playerLight',
        x: bounce.x,
        y: bounce.y,
        elevation: source.elevation,
        radius,
        shapePoints: playerLightCirclePolygon(bounce.x, bounce.y, radius),
        // LOW ratio: most of the pool then falls in the scene's own DIM ambient
        // band (`computeSwitchColorBand`) rather than its bright one — a wash,
        // not a second hot disc.
        ratio: 0.18,
        // FOUNDRY'S OWN FALLOFF MODEL, at a HIGH attenuation (2026-10-15, the
        // author's own follow-up: "about 25% of this brightness and higher
        // attenuation"). This is the ONE model whose attenuation slider does
        // anything at all — both inverse-square curves take their steepness from
        // a module constant and ignore it — and a high value is what that ask
        // means visually: the pool keeps its full radius, but real strength only
        // reaches the inner tenth and falls away smoothly to nothing at the rim,
        // instead of the near-flat disc `inverseSquareWide` painted (still 85%
        // strength at HALF the radius).
        attenuation01: 0.85,
        // A QUARTER of what a default-luminosity source puts out: exposure is
        // `luminosity*2-1`, so 0.1 lands at 0.2× across the pool. Reflected light
        // spreads the scene's own ambient; it never competes with the beam or the
        // cookie spot that produced it.
        luminosity01: 0.1,
        hasColor: true,
        // The coloured wash is cut to the same quarter (coloration alpha is
        // `alpha*2`), so the pool reads as light that has already come off a
        // surface — a tint, not a second lamp.
        alpha01: 0.08,
        color: lightColor,
        // See `attenuation01` above — the model and the slider are one decision,
        // and this is the only falloff in the pool that reads that slider.
        falloffModel: 'foundry',
        animation: { type: null, speedRaw: 5, intensityRaw: 5, reverse: false, seed: 0, quality: 0 },
      });
    }
  }
  return out;
}
