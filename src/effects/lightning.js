/**
 * LIGHTNING — the forked-bolt strike effect (V2's `LightningEffectV2`: a
 * procedural fractal ribbon mesh with branching and a leader/return-stroke
 * flicker envelope). Distinct from a "weather/landscape lightning" screen-flash
 * effect (V2's `WeatherLightningEffectV2`) — that effect has no V3 equivalent
 * yet and is out of scope here; nothing in this file merges with it.
 *
 * THIS FILE IS THE DECLARATION (params schema + manifest) — mirrors
 * candle-flame.js's split exactly. The pure path/envelope/scheduling math
 * lives in lightning-geometry.js (Node-tested); the TSL material + THREE
 * geometry wrapper live in lightning-render.js (browser-verified); the CPU
 * spawn/reap lifecycle lives in lightning-subsystem.js.
 *
 * It renders anchors of kind `lightning` (scene/anchor-catalog.js) — two
 * linked endpoints (`role: 'start'`/`'end'` sharing a `linkId`) form one bolt
 * source, the successor to a V2 `effectTarget: 'lightning'` map-point group.
 *
 * V2's own defaults (legacy/compositor-v2/effects/LightningEffectV2.js,
 * frozen/quarantined, read directly for this port) are the starting point for
 * every value below. Every param below has a REAL consumer somewhere in src/
 * (`tools/verify-structure.mjs`'s `params/no-dead-controls` wall enforces
 * this at zero tolerance — no ratchet, no grace) — several V2 params had no
 * living behaviour left to port, or none their V3 consumer could honour, and
 * are dropped rather than carried forward as a lie an author would tune
 * against:
 *   - `enabled` — the settings cascade's job in V3, never a schema param.
 *   - `audioEnabled`/`audioStrikePath`/`audioVolume` — V2's own
 *     `_onStrikeAudio(_info) {}` is a literal empty stub; there is nothing to
 *     port.
 *   - `overheadOrder`/`zOffset` — V2's draw-order bands (`LayerOrderPolicy`)
 *     have no V3 equivalent yet; door-graphics.js hit the identical gap and
 *     recorded a matching `deferredRungs` entry (`roof-occlusion`) rather than
 *     shipping an inert param. Lightning draws unconditionally above the
 *     composited scene for now (trivially satisfying V2's own non-negotiable
 *     "always above tokens" baseline).
 *   - `originFlashFollowPointLightGain` — V2's own darkness-punch gain read a
 *     bespoke `LightingDirector.masterDarkness` scaled by a global point-
 *     light-intensity multiplier; this port's darkness punch instead scales
 *     the shared point-light pool's own luminosity/alpha (see lightning-
 *     geometry.js#buildLightningLightSources), which has no equivalent
 *     "global gain" concept to follow.
 *   - `originFlashWallPaddingPx`/`originFlashAllowWindows` — the origin
 *     flash reuses the SAME shared wall-clip primitive candle lights already
 *     use (`foundry/scene-wall-clip.js#computeCandleWallClippedShape`),
 *     which does not (yet) expose a wall-padding or window-passthrough knob.
 *     Extending that shared primitive would benefit candle too, but is out
 *     of scope here — recorded, not silently dropped.
 *
 * @module effects/lightning
 */

/**
 * The authorable LOOK/SHAPE/RESPONSE knobs (validated by core/params-
 * schema.js). Per-bolt data (which two anchors pair into one source, each
 * endpoint's own strike intensity) lives on the `lightning` anchor kind
 * (scene/anchor-catalog.js), not here — same split candle's per-candle
 * overrides use.
 *
 * @type {Record<string, object>}
 */
export const LIGHTNING_PARAMS = Object.freeze({
  // ── LOOK — the ribbon's own colour/brightness/silhouette ─────────────────
  outerColor: {
    type: 'color',
    space: 'srgb',
    // V2's outerColor {r:0, g:0.2144, b:1} converted to #rrggbb.
    default: '#0037ff',
    category: 'Look',
    label: 'Outer colour',
    help: 'The bolt’s outer glow colour.',
  },
  coreColor: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Look',
    label: 'Core colour',
    help: 'The bolt’s hot inner-core colour, blended in toward the centreline.',
  },
  brightness: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.05,
    default: 5,
    category: 'Look',
    label: 'Brightness',
    help: 'Overall emission strength of the bolt mesh.',
  },
  width: {
    type: 'float',
    min: 1,
    max: 120,
    step: 1,
    default: 30,
    category: 'Look',
    label: 'Width',
    help: 'Ribbon width in canvas pixels, before tapering toward the tip.',
  },
  taper: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.08,
    category: 'Look',
    label: 'Taper',
    help: 'How aggressively the ribbon narrows from base to tip.',
  },
  glowStrength: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.05,
    default: 5,
    category: 'Look',
    label: 'Glow strength',
    help: 'A second multiplier over brightness, for pushing the bolt into bloom.',
  },
  // ── DETAIL — the fine procedural texture riding on top of the ribbon ─────
  textureScrollSpeed: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.1,
    default: 25,
    category: 'Detail',
    label: 'Plasma scroll speed',
    help: 'How fast the inner plasma noise scrolls along the bolt.',
  },
  coreStaticAmount: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Detail',
    label: 'Core static amount',
    help: 'Crackling sparkle intensity on the bright core near the bolt base.',
  },
  coreStaticRange: {
    type: 'float',
    min: 0.15,
    max: 0.85,
    step: 0.01,
    default: 0.85,
    category: 'Detail',
    label: 'Core static range',
    help: 'How far along the bolt (from the base) the core static crackle reaches.',
  },
  // ── MOTION ─────────────────────────────────────────────────────────────
  windDriftStrength: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0,
    category: 'Motion',
    label: 'Wind drift',
    help: 'How much the bolt drifts with the shared wind field after the return stroke connects. 0 = wind cannot touch it (V2’s own default).',
  },
  // ── SHAPE — the fractal path + branching ──────────────────────────────────
  segments: {
    type: 'int',
    min: 4,
    max: 96,
    step: 1,
    default: 96,
    category: 'Shape',
    label: 'Segments',
    help: 'How many points the main bolt path is resampled to.',
  },
  curveAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.57,
    category: 'Shape',
    label: 'Curve amount',
    help: 'How far the bolt bows away from a straight line before fractal jitter is applied.',
  },
  macroDisplacement: {
    type: 'float',
    min: 0,
    max: 400,
    step: 1,
    default: 96,
    category: 'Shape',
    label: 'Fractal chaos',
    help: 'Root zigzag strength for the recursive midpoint-displacement path.',
  },
  microJitter: {
    type: 'float',
    min: 0,
    max: 120,
    step: 1,
    default: 3,
    category: 'Shape',
    label: 'Micro jitter',
    help: 'Fine high-frequency wobble layered onto the resampled path, fading out toward the tip.',
  },
  endPointRandomnessPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 1,
    default: 5,
    category: 'Shape',
    label: 'Endpoint randomness',
    help: 'Random jitter applied to the strike’s end point each burst, in pixels.',
  },
  branchAngleDeg: {
    type: 'float',
    min: 15,
    max: 60,
    step: 1,
    default: 45,
    category: 'Shape',
    label: 'Branch angle',
    help: 'Fork angle off the parent bolt’s local tangent, in degrees.',
  },
  branchChance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Shape',
    label: 'Branch chance',
    help: 'Probability a given burst spawns any side-branches at all.',
  },
  branchMax: {
    type: 'int',
    min: 0,
    max: 6,
    step: 1,
    default: 6,
    category: 'Shape',
    label: 'Branch max',
    help: 'Maximum number of side-branches per burst.',
  },
  branchLengthMin: {
    type: 'float',
    min: 0.05,
    max: 1,
    step: 0.01,
    default: 0.17,
    category: 'Shape',
    label: 'Branch length min',
    help: 'Shortest a branch can be, as a fraction of the main bolt’s length.',
  },
  branchLengthMax: {
    type: 'float',
    min: 0.05,
    max: 1.5,
    step: 0.01,
    default: 0.52,
    category: 'Shape',
    label: 'Branch length max',
    help: 'Longest a branch can be, as a fraction of the main bolt’s length.',
  },
  branchWidthScale: {
    type: 'float',
    min: 0.05,
    max: 1,
    step: 0.01,
    default: 0.52,
    category: 'Shape',
    label: 'Branch width scale',
    help: 'A branch’s width relative to its parent.',
  },
  branchIntensityScale: {
    type: 'float',
    min: 0.05,
    max: 1,
    step: 0.01,
    default: 0.82,
    category: 'Shape',
    label: 'Branch intensity scale',
    help: 'A branch’s brightness relative to its parent.',
  },
  branchDurationScale: {
    type: 'float',
    min: 0.1,
    max: 1,
    step: 0.01,
    default: 0.79,
    category: 'Shape',
    label: 'Branch duration scale',
    help: 'A branch’s lifetime relative to its parent’s strike duration.',
  },
  wildArcChance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Shape',
    label: 'Wild arc chance',
    help: 'Rare chance a strike ignores its two anchor points and shoots off in a random direction instead. Off by default.',
  },
  // ── RESPONSE — burst timing ────────────────────────────────────────────
  minDelayMs: {
    type: 'float',
    min: 0,
    max: 5000,
    step: 50,
    default: 5000,
    category: 'Response',
    label: 'Min delay',
    help: 'Shortest gap between bursts, in milliseconds.',
  },
  maxDelayMs: {
    type: 'float',
    min: 0,
    max: 10000,
    step: 50,
    default: 10000,
    category: 'Response',
    label: 'Max delay',
    help: 'Longest gap between bursts, in milliseconds.',
  },
  burstMinStrikes: {
    type: 'int',
    min: 1,
    max: 10,
    step: 1,
    default: 7,
    category: 'Response',
    label: 'Restrikes min',
    help: 'Minimum rapid flashes along the same channel within one burst.',
  },
  burstMaxStrikes: {
    type: 'int',
    min: 1,
    max: 16,
    step: 1,
    default: 16,
    category: 'Response',
    label: 'Restrikes max',
    help: 'Maximum rapid flashes along the same channel within one burst.',
  },
  strikeDurationMs: {
    type: 'float',
    min: 20,
    max: 2400,
    step: 10,
    default: 1000,
    category: 'Response',
    label: 'Strike duration',
    help: 'Total lifetime of one burst, in milliseconds.',
  },
  leaderFraction: {
    type: 'float',
    min: 0.1,
    max: 0.35,
    step: 0.01,
    default: 0.15,
    category: 'Response',
    label: 'Leader phase',
    help: 'Fraction of the strike spent as a dim, searching leader before the return stroke connects.',
  },
  flickerChance: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    category: 'Response',
    label: 'Flicker chance',
    help: 'How often the strike randomly dims mid-flight, for a twitchier, less mechanical look.',
  },
  // ── LIGHT — the screen-wide flash signal ──────────────────────────────
  outsideFlashEnabled: {
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Screen flash enabled',
    help: 'Publish a screen-wide flash signal when a bolt’s return stroke connects.',
  },
  outsideFlashGain: {
    type: 'float',
    min: 0,
    max: 5,
    step: 0.01,
    default: 1.09,
    category: 'Light',
    label: 'Screen flash gain',
    help: 'Overall strength of the published screen-wide flash signal.',
  },
  outsideFlashAttackMs: {
    type: 'float',
    min: 0,
    max: 150,
    step: 1,
    default: 111,
    category: 'Light',
    label: 'Screen flash attack',
    help: 'How fast the screen flash ramps up, in milliseconds.',
  },
  outsideFlashDecayMs: {
    type: 'float',
    min: 50,
    max: 2500,
    step: 10,
    default: 650,
    category: 'Light',
    label: 'Screen flash decay',
    help: 'How long the screen flash takes to fade out, in milliseconds.',
  },
  outsideFlashCurve: {
    type: 'float',
    min: 0.25,
    max: 4,
    step: 0.01,
    default: 1.6,
    category: 'Light',
    label: 'Screen flash decay curve',
    help: 'Shapes the decay falloff — higher values hold brighter for longer before dropping.',
  },
  outsideFlashFlickerAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.21,
    category: 'Light',
    label: 'Screen flash flicker amount',
    help: 'How much the screen flash flickers while it decays.',
  },
  outsideFlashFlickerRate: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.1,
    default: 0.6,
    category: 'Light',
    label: 'Screen flash flicker rate',
    help: 'Flicker frequency in Hz. Photosensitivity guidance flags 3–30 Hz as the range to avoid leaning on.',
  },
  outsideFlashMaxClamp: {
    type: 'float',
    min: 0,
    max: 10,
    step: 0.05,
    default: 2.0,
    category: 'Light',
    label: 'Screen flash clamp',
    help: 'Hard ceiling on the published screen flash value.',
  },
  originFlashEnabled: {
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Origin light enabled',
    help: 'A real, wall-clipped point light at the strike origin/impact that punches through darkness like a candle’s glow.',
  },
  originFlashAnchor: {
    type: 'enum',
    values: ['start', 'impact', 'both'],
    default: 'start',
    category: 'Light',
    label: 'Origin light anchor',
    help: 'Which end(s) of the bolt the origin light is placed at.',
  },
  originFlashRadiusPx: {
    type: 'float',
    min: 40,
    max: 2400,
    step: 10,
    default: 40,
    category: 'Light',
    label: 'Origin light radius',
    help: 'Base reach of the origin light, in canvas pixels.',
  },
  originFlashRadiusStrikeScale: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.48,
    category: 'Light',
    label: 'Origin light radius × strike',
    help: 'How much a brighter strike expands the origin light’s radius.',
  },
  originFlashInnerRadiusScale: {
    type: 'float',
    min: 0.05,
    max: 0.6,
    step: 0.01,
    default: 0.05,
    category: 'Light',
    label: 'Origin light inner radius',
    help: 'Radius of the light’s bright inner core, as a fraction of its outer radius.',
  },
  originFlashIntensity: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    default: 1.62,
    category: 'Light',
    label: 'Origin light intensity',
    help: 'Overall brightness multiplier for the origin light.',
  },
  originFlashStrikeScale: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 0.73,
    category: 'Light',
    label: 'Origin light × strike scale',
    help: 'How strongly the origin light follows the bolt’s own envelope brightness.',
  },
  originFlashDarknessCancel: {
    type: 'float',
    min: 0,
    max: 12,
    step: 0.05,
    default: 0.95,
    category: 'Light',
    label: 'Darkness punch',
    help: 'How hard the origin light cuts through scene darkness (scales its luminosity/coloration strength; see the shared point-light pool for how this composites).',
  },
  originFlashDarknessNightBoost: {
    type: 'float',
    min: 1,
    max: 4,
    step: 0.01,
    default: 1.6,
    category: 'Light',
    label: 'Darkness punch, night boost',
    help: 'Extra darkness-punch multiplier applied on top for the deepest nights.',
  },
  originFlashAttenuation: {
    type: 'float',
    min: 0.05,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Light',
    label: 'Origin light edge softness',
    help: 'Softness of the origin light’s outer falloff band.',
  },
  originFlashHotMix: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.81,
    category: 'Light',
    label: 'Origin light hot-core mix',
    help: 'Blends the origin light’s colour toward white-hot at peak intensity.',
  },
  originFlashLeaderPrecursor: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.37,
    category: 'Light',
    label: 'Origin light leader precursor',
    help: 'A faint pre-glow while the leader is still searching, before the bolt connects.',
  },
  originFlashFlickerAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.87,
    category: 'Light',
    label: 'Origin light flicker amount',
    help: 'How much the origin light flickers independently of the bolt mesh.',
  },
  originFlashFlickerRate: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.1,
    default: 1.0,
    category: 'Light',
    label: 'Origin light flicker rate',
    help: 'Flicker frequency in Hz. Photosensitivity guidance flags 3–30 Hz as the range to avoid leaning on.',
  },
  originFlashMinGain: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.04,
    category: 'Light',
    label: 'Origin light minimum gain',
    help: 'A floor under the origin light’s brightness so it never fully vanishes mid-flicker.',
  },
  originFlashWallClipEnabled: {
    type: 'bool',
    default: true,
    category: 'Light',
    label: 'Origin light wall-clipped',
    help: 'Clip the origin light to wall line-of-sight, same as a candle’s light.',
  },
  originFlashWallClipRadiusScale: {
    type: 'float',
    min: 0.1,
    max: 2,
    step: 0.01,
    default: 0.33,
    category: 'Light',
    label: 'Origin light wall-clip radius',
    help: 'Radius used for the wall-clip test — can differ from the light’s own visual radius so clipping does not thrash every time the light flickers.',
  },
});

/**
 * The manifest — the effect as data (Effects.md §2 shape).
 *
 * `a11y.photosensitive: true` is NOT optional: this is the first genuinely
 * flashing MSA effect. `effect-cascade.js#resolveEffectEnabled` step 4 reads
 * this flag and force-disables the whole effect for a player who has asked to
 * reduce photosensitive effects — beating a GM override, and beating even
 * that player’s own "on" pick. Do not flip this false; nothing in this
 * effect is safe to expose to a photosensitive player unconditionally.
 *
 * `enabledFromProfile: 'low'` mirrors candle’s own reasoning — a handful of
 * bolts is cheap and dramatic, so it is on at every performance profile by
 * default; the tier ladder below controls how MUCH of the effect a given
 * profile affords, not whether it exists at all.
 *
 * @type {import('./effect-manifest.js').EffectManifest}
 */
export const LIGHTNING = Object.freeze({
  id: 'lightning',
  title: 'Lightning',
  // Between candle's 0.5 (ambient decoration) and door's 0.75 (structural) —
  // a deliberate, GM-placed dramatic beat when present, not always-on ambience.
  visualWeight: 0.65,
  a11y: Object.freeze({ photosensitive: true }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'none',
    why: 'Builds its material, geometry and mesh on first use and rebuilds them on every tier change (ensureMaterial(quality)) — first-run work that can recur mid-session, but synchronous, with no pending window to probe and no safe flag (a scene with no lightning would never build, and a "not built yet" probe would never clear). Each build grows the pipeline set, so settle.js’s global pipeline-growth criterion sees it.',
  }),
  params: LIGHTNING_PARAMS,
  // ============================================================================
  // THE LADDER — V2 had NO performance tiers for this effect at all (always
  // full cost, no rungs). Built cost-class-monotonic from scratch here
  // (Effects.md Law 3), tier 0 unconditional (Law 1).
  // ============================================================================
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'strike',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds: 'a solo ribbon bolt per burst — fractal path, leader growth, return-stroke restrike flicker, additive glow, the rare wild-arc mode — the floor',
    }),
    Object.freeze({
      n: 1,
      name: 'branching',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.02 }),
      adds: "forking side-branches slaved to the parent bolt's leader growth",
    }),
    Object.freeze({
      n: 2,
      name: 'flash',
      fromProfile: 'low',
      cost: Object.freeze({ class: 'C1', estMsPerMp: 0.01 }),
      adds: 'a screen-wide flash signal on return-stroke connect (attack/decay/flicker), published for downstream consumers',
    }),
    Object.freeze({
      n: 3,
      name: 'originFlash',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C6', estMsPerMp: 0.15 }),
      adds: 'a wall-clipped, darkness-punching point light at the bolt origin/impact, reusing the shared point-light pool',
    }),
  ]),
  // Recorded, NOT built — still genuinely absent (Effects.md §0).
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'overhead-order',
      note: "V1 draws above the whole map stack (correct baseline — always above tokens, matching V2). Below/above-overhead selection needs the bolt's LayerKey wired into the main draw-list sort (scene/layer-order.js), the same deferred rung door-graphics.js already names for itself ('roof-occlusion'). Do not reintroduce an overheadOrder param until this exists.",
    }),
    Object.freeze({
      name: 'wandering-source',
      note: "V2 could re-randomize a 3+-point line group's start/end every burst. V1 imports a V2 wandering group as a static linked start/end pair (first+last point); interior points import as inert 'waypoint' anchors on the same linkId, so this can be built later without re-importing.",
    }),
    Object.freeze({
      name: 'embers',
      note: 'GPU-resident spark/ember particles at branch tips and the impact point on connect, reusing the existing ParticleArena (reserve slots from the shared arena — do not open a second instancedArray call site). Designed for, not built.',
    }),
    Object.freeze({
      name: 'weather-lightning-flash-merge',
      note: "V2 merged this effect's outsideFlash signal with its WeatherLightningEffectV2 sibling via max() for downstream consumers (vegetation brighten, etc). Out of scope until a V3 weather/landscape lightning effect exists.",
    }),
  ]),
});
