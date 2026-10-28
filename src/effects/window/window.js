/**
 * WINDOW LIGHT — the declaration (manifest + params schema), pure data, no
 * THREE. Same split as bloom/candle/water/specular: this file is
 * Node-validatable; the TSL builder lives in the sibling render module with
 * THREE injected, never imported. `docs/planning/Windows.md` is the design
 * this implements.
 *
 * ============================================================================
 * WHAT SHIPS NOW, AND WHY IT IS DELIBERATELY SMALL
 * ============================================================================
 * Author directive (2026-07-27): get a SIMPLE version working first — "just
 * add the brightness back to scenes." So tier 0 only: the mask read as light
 * (`window-cookie.js`), added onto `buf:scene.illum`, gated to the visible
 * floor. No sky-drive, no drift, no cloud modelling yet — those are
 * `deferredRungs` below, in the SAME ladder shape `specular.js`/`water.js`
 * already use, so the manifest never claims more than exists
 * (`feedback_plausible_diagnosis_rots` — a doc describing an unbuilt rung as
 * built is exactly the rot that memory names).
 *
 * ⚠️ **Cloud shadows are LIVE (2026-09-10).** `window-render.js` takes
 * `cloudFactorNode` (the per-fragment cloud transmittance, 0..1 — a real
 * cloud passing overhead dims this window's own light) and `cloudOvercastNode`
 * (the scalar `cloudCover01`, driving a global blur + up-to-50% dim under a
 * fully overcast sky). `vt-pan-viewer.js` builds both from `world/cloud-field.js
 * #buildCloudGroundVisNode` and passes them to every window subsystem; a
 * caller that omits either still gets the old constant-1/no-op default, so
 * this remains a safe seam, not a stub slider (`params/no-dead-controls`
 * still has no "Cloud shadows" PARAM, on purpose — the sky/weather panel
 * owns cover/type/altitude, this effect only reads them).
 *
 * @module effects/window/window
 */

/**
 * The knobs. Each is read by `effects/window/window-render.js` TODAY
 * (`params/no-dead-controls` fails the build otherwise), and that module's
 * exported defaults are the single source of truth for the values.
 */
export const WINDOW_PARAMS = Object.freeze({
  strength: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    // LOWERED 3 → 1 (2026-09-21) — new live-tuned default, off the schema's
    // own max back toward neutral; the author's own dialled-in scene,
    // recorded exactly. Was RAISED 1 → 3 (2026-09-09) before this round.
    // 2026-09-25 — author's live-tuned "new defaults" dump (was 1).
    default: 1, // 2026-10-27 author's Studio export (was 1.5)
    category: 'Look',
    label: 'Window light',
    help: 'How much of the outdoor light the painted cookie lets in — higher saturates the painted falloff toward full sunlight sooner. Turn it to 0 to see the map with no window light at all.',
  },
  // THE OUTDOOR MATCH (2026-10-27, `window-weather.js#windowTargetLight`) —
  // author, on the Mansion greenhouse: "it should end up roughly the same
  // brightness as the outdoors around it, neither much darker nor brighter."
  outdoorMatch: {
    type: 'float',
    min: 0.5,
    max: 2.5,
    step: 0.01,
    default: 2, // 2026-10-27 author's Studio export (was 1.1)
    category: 'Look',
    label: 'Brightness vs outdoors',
    help: 'How bright a fully painted (white) window patch is compared with the open ground outside, at every hour — noon sun, golden hour, moonlight. 1 = exactly as lit as outdoors; above 1 adds glare.',
  },
  contrast: {
    type: 'float',
    min: 0.25,
    max: 4,
    step: 0.01,
    // RAISED 0.69 → 1 (2026-09-21) — new live-tuned default, back to neutral
    // (1 = exactly what you painted); see `WINDOW_DEFAULT_CONTRAST`'s own
    // header (window-render.js). Was LOWERED 1 → 0.69 (2026-09-08, recovered
    // from a stash that missed both this file's own commit and the 0.6.4
    // release; applied 2026-09-18) before this round.
    default: 1.5, // 2026-10-27 author's Studio export (was 1)
    category: 'Look',
    label: 'Patch contrast',
    help: 'Gamma on the painted falloff. Above 1 sharpens the cookie toward a hard-edged patch; below 1 softens it toward a broad glow. 1 = exactly what you painted.',
  },
  dawnDuskTint: {
    type: 'color',
    space: 'srgb',
    // 2026-10-27: deeper gold (was #ff8a3d) — author: golden hour "could be
    // pushed into the more dramatic".
    default: '#ffa570', // 2026-10-27 author's Studio export (was #ff6a14)
    category: 'Look',
    label: 'Dawn / dusk colour',
    help: 'The colour the window light leans toward, driven by the astrolabe, around sunrise and sunset. Fades to no tint by noon.',
  },
  tintAmount: {
    type: 'float',
    min: 0,
    max: 1.5,
    step: 0.01,
    default: 0.7,
    category: 'Look',
    label: 'Dawn / dusk colour strength',
    help: 'Scales how far the window light leans toward the Dawn / dusk and Night colours. 1 = as set, 0 = no lean at all (the light is just the outdoor light). Turn down if golden hour is too red.',
  },
  outdoorHue: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Look',
    label: 'Outdoor colour carried in',
    help: "How much of the outdoor light's own colour comes through the window. At golden hour the outdoors is already strongly orange-red; lower this to keep the brightness but drain that colour. 0 = neutral light.",
  },
  nightTint: {
    type: 'color',
    space: 'srgb',
    // 2026-10-27: colder moonlight (was #5c7cff) — author: night "should be
    // more dramatically cool in temp".
    default: '#8095ff', // 2026-10-27 author's Studio export (was #3a5cff)
    category: 'Look',
    label: 'Night colour',
    help: 'The colour the window light leans toward, driven by the astrolabe, once the sun is down.',
  },
  // ── WEATHER (2026-10-27, `window-weather.js`) — the outside world played
  // dramatically: "dramatic, never dull". All four act AFTER the highlight
  // shoulder, so they really show on a bright white `_Window`.
  goldenBoost: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    default: 2, // 2026-10-27 author's Studio export (was 0.9)
    category: 'Weather',
    label: 'Golden hour boost',
    help: 'How much harder the window light leans into the dawn/dusk colour with the sun low and golden. Colour only — the brightness follows the outdoors (see Brightness vs outdoors).',
  },
  weatherBreakFill: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // 2026-10-27 author's Studio export (was 0.1)
    category: 'Weather',
    label: 'Overcast fill',
    help: 'Under heavy cloud, light comes through drifting sun breaks at full strength; this is how much reaches the rest of the window. 0 = only the breaks, 1 = cloud never darkens window light.',
  },
  weatherBreakSizeM: {
    type: 'float',
    min: 2,
    max: 60,
    step: 1,
    default: 20, // 2026-10-27 author's Studio export (was 16)
    category: 'Weather',
    label: 'Sun break size (m)',
    help: 'How large the drifting sun breaks are under heavy cloud, in metres. Smaller = more, tighter shafts.',
  },
  weatherStormDarken: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.16, // 2026-10-27 author's Studio export (was 0.85)
    category: 'Rain waves',
    label: 'Wave darkness',
    help: 'How dark window light goes as each wave of heavy rain passes — the same waves the rain itself brightens on, travelling with the wind. 0 = rain never darkens window light.',
  },

  // ── RAIN WAVES (2026-10-27, `window-weather.js`) — how much the wind-driven
  // rain darkens window light. Author: *"give me controls so that I can change
  // how much the wind driven rain shader is effecting windows, give me a nice
  // range of controls in their own section"*. The waves are the wind field's own
  // gust fronts (the ones the torrent/curtain rain brightens on), so these shape
  // the RESPONSE, never the waves' size or speed — that stays locked to the wind.
  rainWaveBaseDarken: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.06, // 2026-10-27 author's Studio export (was 0.3)
    category: 'Rain waves',
    label: 'Overall rain dim',
    help: 'How much any heavy rain dims window light everywhere, before a wave even arrives. 0 = only the waves darken.',
  },
  rainWaveThreshold: {
    type: 'float',
    min: 0.3,
    max: 2,
    step: 0.01,
    default: 0.41, // 2026-10-27 author's Studio export (was 0.75)
    category: 'Rain waves',
    label: 'Wave threshold',
    help: 'How strong a gust has to be before it counts as a rain wave (1 = the average wind). Lower = more of the map is inside a wave; higher = only the strongest fronts.',
  },
  rainWaveSoftness: {
    type: 'float',
    min: 0.05,
    max: 2,
    step: 0.01,
    default: 2, // 2026-10-27 author's Studio export (was 0.85)
    category: 'Rain waves',
    label: 'Wave softness',
    help: 'How gradually a wave darkens from its edge to its heart. Small = a hard, sharp front; large = a slow swell of gloom.',
  },
  rainWaveFloor: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: 0.03,
    category: 'Rain waves',
    label: 'Darkest light',
    help: 'The least light a window keeps in the heart of the heaviest wave. 0 = it can go fully dark.',
  },
  rainWaveStartPrecip: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    category: 'Rain waves',
    label: 'Starts at rain',
    help: 'The precipitation level at which rain begins to darken windows.',
  },
  rainWaveFullPrecip: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.85,
    category: 'Rain waves',
    label: 'Full at rain',
    help: 'The precipitation level at which the darkening reaches its full strength.',
  },
  rainWaveSnowShare: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    category: 'Rain waves',
    label: 'Snow & hail share',
    help: 'How strongly snow and hail darken windows compared with rain. 1 = the same as rain.',
  },
  rainWaveTint: {
    type: 'color',
    space: 'srgb',
    default: '#8fa6c8',
    category: 'Rain waves',
    label: 'Wave colour',
    help: 'The colour window light shifts toward inside a rain wave — a cold storm grey by default.',
  },
  rainWaveTintAmount: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Rain waves',
    label: 'Wave colour amount',
    help: 'How far the light shifts toward Wave colour in the heart of a wave. 0 = no colour change.',
  },
  rainWaveLeadGlow: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Rain waves',
    label: 'Glow before the wave',
    help: 'A brief brightening just ahead of each wave front — the strange bright moment before a squall hits. 0 = off.',
  },

  // ── SUN & ROOMS (2026-10-28, `window-room-light.js` over `scene/room-map.js`) ──
  // Author: *"what would be really nice is if the _Window light also moved and smeared at different times of day.
  // HOWEVER, what we never want is for that light to move accidentally into another room or outside the building …
  // Be sure to give me a section under _Window for these variables so that I can edit them to fine tune the look."*
  // Defaults mirror `WINDOW_ROOM_DEFAULTS`.
  sunDrift: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Sun & rooms',
    label: 'Sun drift',
    help: 'How far window light slides away from the sun as it moves across the sky — long at dawn and dusk, short at noon. 0 = the light stays exactly where it is painted.',
  },
  sunThrowHeightPx: {
    type: 'float',
    min: 0,
    max: 400,
    step: 1,
    default: 120,
    category: 'Sun & rooms',
    label: 'Window height (px)',
    help: 'How high the windows are, in map pixels. Taller windows throw their light further across the floor for the same sun — the same rule as building shadows.',
  },
  sunMaxDriftPx: {
    type: 'float',
    min: 0,
    max: 1200,
    step: 5,
    default: 360,
    category: 'Sun & rooms',
    label: 'Longest drift (px)',
    help: 'The furthest the light can slide, in map pixels, however low the sun gets.',
  },
  sunSmear: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.65,
    category: 'Sun & rooms',
    label: 'Smear',
    help: 'How much the light stretches out along its drift instead of sliding as one patch. 0 = the whole patch moves; 1 = a long streak from where it is painted to where it has drifted.',
  },
  sunSmearKeep: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    category: 'Sun & rooms',
    label: 'Smear brightness',
    help: 'How bright the stretched light stays. 0 = a longer patch is a dimmer one (the same light spread wider); 1 = the streak keeps the full brightness of the painted light.',
  },
  roomWallFadePx: {
    type: 'float',
    min: 0,
    max: 240,
    step: 1,
    default: 48,
    category: 'Sun & rooms',
    label: 'Wall fade (px)',
    help: 'How far from a wall the moving light starts to fade, in map pixels — the soft shadow along every wall that keeps the light from ending on a hard line. Light never crosses into another room or outside either way.',
  },
  roomWallFadeStrength: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Sun & rooms',
    label: 'Wall fade strength',
    help: 'How dark that soft shadow along the walls gets. 0 = no fade (the light stops sharply at the wall).',
  },
  sunSideBoost: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.5,
    category: 'Sun & rooms',
    label: 'Sunny side boost',
    help: 'How much brighter the rooms whose windows face the sun get while the sun is low — the east rooms at dawn, the west rooms at dusk. 0.5 = half as bright again.',
  },
  sunSideDim: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    category: 'Sun & rooms',
    label: 'Shaded side dim',
    help: 'How much darker the rooms whose windows face away from the sun get while it is low. 1 = they go dark.',
  },
  sunLowDeg: {
    type: 'float',
    min: 5,
    max: 90,
    step: 1,
    default: 50,
    category: 'Sun & rooms',
    label: 'Low sun below (°)',
    help: 'The sun elevation, in degrees, under which the sunny and shaded sides start to differ. They differ most with the sun on the horizon and not at all above this.',
  },
  roomWallThicknessPx: {
    type: 'float',
    min: 2,
    max: 40,
    step: 1,
    default: 10,
    category: 'Sun & rooms',
    label: 'Wall seal (px)',
    help: 'How thick walls are drawn when the scene is divided into rooms. Raise it if two rooms leak into each other through a small gap between wall ends (debug view 16 shows the rooms).',
  },

  // ── THE GLASS (effects/window/window-glass.js) ────────────────────────────
  // Nine controls over ONE physical field — the pane's own thickness. Warp,
  // prism and caustic are its first and second derivatives, not three
  // independent looks, which is why they share `glassWarpPx` as a master and
  // all die together on flat glass. That module's header carries the model.
  glassWarpPx: {
    type: 'float',
    min: 0,
    max: 60,
    step: 0.5,
    // LOWERED 20 → 6.5 (2026-09-21) — new live-tuned default; the author's
    // own dialled-in scene, recorded exactly.
    default: 12.5, // 2026-10-27 author's Studio export (was 10)
    category: 'Glass',
    label: 'Glass thickness',
    help: 'How much the uneven pane bends the light, as a maximum shift in world pixels. 0 = perfectly flat modern glass: no distortion, no prism, no caustics. Raise it for thick, wavy, hand-blown panes.',
  },
  glassDispersion: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.59, // 2026-10-27 author's Studio export (was 1)
    category: 'Glass',
    label: 'Prism split',
    help: 'How far apart the red and blue ends of the light are pulled as they refract. 0 = the light distorts but keeps its colour; 1 = a strong rainbow fringe along every edge. Needs some Glass thickness to have anything to split.',
  },
  glassScale: {
    type: 'float',
    min: 8,
    max: 400,
    step: 1,
    default: 400, // 2026-10-27 author's Studio export (was 181)
    category: 'Glass',
    label: 'Blob size',
    help: 'The size of the lumps in the glass, in world pixels. Small = a fine rippled or seeded pane; large = a few broad rolling waves, like a big crown-glass round.',
  },
  glassDetail: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Glass',
    label: 'Fine detail',
    help: 'How much fine structure rides on top of the big lumps. 0 = smooth rolling glass; 1 = busy, pitted and seedy. This is the difference between a good pane and a cheap one.',
  },
  glassStriation: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Glass',
    label: 'Draw lines',
    help: 'Stretches the lumps into parallel streaks — the draw marks left by pulling cylinder glass. 0 = round blobs; 1 = strong directional banding.',
  },
  glassStriationAngle: {
    type: 'float',
    min: 0,
    max: 180,
    step: 1,
    default: 0,
    category: 'Glass',
    label: 'Draw-line angle',
    help: 'Which way those streaks run, in degrees. Does nothing while Draw lines is 0.',
  },
  glassCausticStrength: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 2, // 2026-10-27 author's Studio export (was 0.25)
    category: 'Glass',
    label: 'Caustic highlight',
    help: 'How strongly the thick spots focus light into bright knots, the way a glass of water throws a highlight. 0 = off. The dark bands between knots come with it — they are where that light went.',
  },
  glassCausticSharpness: {
    type: 'float',
    min: 0.5,
    max: 6,
    step: 0.1,
    default: 6,
    category: 'Glass',
    label: 'Caustic tightness',
    help: 'Whether the caustics are broad soft swells (low) or tight bright knots with a dark surround (high). Shapes bright and dark alike, so it never dims the whole cookie as you turn it up.',
  },
  glassSeed: {
    type: 'float',
    min: 0,
    max: 999,
    step: 1,
    default: 0,
    category: 'Glass',
    label: 'Pattern seed',
    help: 'Moves this pane to a different part of the glass. Change it when two windows on one map are showing the same lumps.',
  },

  // ── RAIN ON THE GLASS (window-rain.js). Every one of these is read by window-surface-subsystem.js, which pushes
  // it into the shader or into the flow-field derivation; the water itself follows the weather on its own. ────────
  rainResponse: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 2, // 2026-10-19 author's Studio export (was 1)
    category: 'Rain',
    label: 'Rain on the glass',
    help: 'How much rain shows on the windows. It follows the weather on its own: no rain, no drops. This scales how wet the glass gets for the rain that is falling. 0 switches rain on glass off; above 1 makes light rain read as heavier.',
  },
  rainDropScalePx: {
    type: 'float',
    min: 0.75,
    max: 8,
    step: 0.05,
    default: 5.45, // 2026-10-27 author's Studio export (was 3)
    category: 'Rain',
    label: 'Drop size',
    help: 'The radius of a bead of water, in map pixels. Beads are all close to this size with a little variation, and each has a ragged edge. Drops too small to see at the current zoom fade away.',
  },
  rainSplatDensity: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 2, // was 1
    category: 'Rain',
    label: 'Drop count',
    help: 'How many drops land and cling to the glass. Splashes already grow from a few in a drizzle to a crowd in a storm; this scales that. 0 = none.',
  },
  rainRefraction: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.78, // 2026-10-27 author's Studio export (was 0.99)
    category: 'Rain',
    label: 'Drop lens',
    help: 'How much each bead bends the light behind it, the wobble you see in the light pool. 0 leaves the light shape alone.',
  },
  rainCaustic: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.65, // 2026-10-27 author's Studio export (was 2)
    category: 'Rain',
    label: 'Drop highlight',
    help: 'The bright spot each bead of water focuses into the light.',
  },
  rainRimDarken: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.1, // 2026-10-27 author's Studio export (was 0.46)
    category: 'Rain',
    label: 'Drop shadow',
    help: 'How dark the edge of each bead and each wet streak is. This is the small, varying dimming the light gets under rain.',
  },
  rainSliders: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // was 0.7
    category: 'Rain',
    label: 'Running drops',
    help: 'How many drops run down the glass toward the sill. They need the outdoors mask (the buildings) to know which way is down. 0 = no running drops, only splashes.',
  },
  rainSlideSpeed: {
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    default: 3, // 2026-10-27 author's Studio export (was 2.12)
    category: 'Rain',
    label: 'Run speed',
    help: 'How fast the running drops slide, as a multiple of the storm pace (a storm runs at about 200 px per second). They stick, then slip, then stick again; the harder it rains the less they stick, and the wind carries them sideways.',
  },
  rainTrail: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // was 0.6
    category: 'Rain',
    label: 'Wet trails',
    help: 'The thin wet streak a running drop leaves behind it. 0 = none.',
  },
  rainProjectionStretch: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // was 0.35
    category: 'Rain',
    label: 'Drop stretch',
    help: 'Stretches each drop along the way the water runs, the way a window thrown onto the floor is stretched. 0 = round drops.',
  },
  rainDropWobblePx: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.1,
    default: 6, // 2026-10-27 author's Studio export (was 1.5)
    category: 'Rain',
    label: 'Drop wobble (px)',
    help: 'How far a running drop sways from side to side as it runs, in map pixels. Every drop sways its own way, so no two follow the same route. 0 = perfectly straight runs.',
  },
  rainCornerEasePx: {
    type: 'float',
    min: 8,
    max: 200,
    step: 1,
    default: 200, // was 96
    category: 'Rain',
    label: 'Corner blend',
    help: 'Around a building corner, how far the running direction takes to turn, in map pixels. Small gives a sharp switch between the two walls; large a long gentle blend. Needs the outdoors mask.',
  },
  rainWindwardBias: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // 2026-10-27 author's Studio export (was 0.09)
    category: 'Rain',
    label: 'Wind-driven rain',
    help: 'How much the wind decides which windows get wet. At 1 the windows facing into the wind stream with water and the sheltered ones stay almost dry.',
  },
  rainSheeting: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1, // 2026-10-27 author's Studio export (was 0.2)
    category: 'Rain',
    label: 'Storm sheeting',
    help: 'In the heaviest rain, a slow sheet of water runs over the glass and dims the light unevenly. 0 = none.',
  },
  rainLingerSec: {
    type: 'float',
    min: 2,
    max: 180,
    step: 1,
    default: 7, // 2026-10-27 author's Studio export (was 40)
    category: 'Rain',
    label: 'Drying time',
    help: 'How long beads cling to the glass after the rain stops, in seconds. Longer is a window that stays wet.',
  },
  rainMaskFloorPct: {
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    default: 50, // 2026-10-27 author's Studio export (was 80)
    category: 'Rain',
    label: 'Rain only in the brightest (%)',
    help: 'Shows the raindrops only in the brightest part of the window light. 100 = drops everywhere the window light is (the normal look). 30 = drops only in the brightest 30% of the light, fading out smoothly where it is dimmer. 0 = only the very brightest spots.',
  },
  // ── COLOUR (the CC, 2026-10-27, `window-grade.js`) — grades the FINISHED
  // window light, last of all. Author: *"a new CC section at the end which is
  // designed to let me fine tune the visual appearance of the whole window
  // effect."*
  ccExposure: {
    type: 'float',
    min: -3,
    max: 3,
    step: 0.05,
    default: 0,
    category: 'Colour',
    label: 'Exposure (EV)',
    help: 'Brightens or darkens the whole window effect, in photographic stops. +1 = twice as bright.',
  },
  ccContrast: {
    type: 'float',
    min: 0.25,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Colour',
    label: 'Contrast',
    help: 'Pushes bright window light brighter and dim light dimmer (above 1), or evens them out (below 1).',
  },
  ccSaturation: {
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 1,
    category: 'Colour',
    label: 'Saturation',
    help: 'How colourful the window light is. 0 = grey light, 2 = very rich colour.',
  },
  ccTemperature: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Colour',
    label: 'Temperature',
    help: 'Cools (−) or warms (+) the whole window effect.',
  },
  ccTint: {
    type: 'float',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Colour',
    label: 'Tint',
    help: 'Shifts the whole window effect toward green (−) or magenta (+).',
  },
  ccColorFilter: {
    type: 'color',
    space: 'srgb',
    default: '#ffffff',
    category: 'Colour',
    label: 'Colour filter',
    help: 'A colour multiplied over the whole window effect, like a gel over the glass. White = none.',
  },
  ccGamma: {
    type: 'float',
    min: 0.3,
    max: 3,
    step: 0.01,
    default: 1,
    category: 'Colour',
    label: 'Gamma',
    help: 'Lifts (above 1) or deepens (below 1) the mid-tones of the window light without moving its brightest point much.',
  },
});

/**
 * THE DEBUG CHANNELS — this effect family (a painted mask read as light,
 * drawn as a bounded quad, additively blended, floor-gated) has shipped
 * invisible three times already in this codebase — specular twice, fluid
 * once — every time with every Node test green. Building the diagnostic
 * alongside tier 0, rather than after the first "why is it not visible"
 * report, is the lesson from all three.
 *
 * Deliberately NOT a param, same reasoning as `SPECULAR_DEBUG_CHANNELS`: a
 * diagnostic view selector is not a property of the look and must never reach
 * the FOH/ROH card as a slider. Costs nothing when off — the channels compile
 * into their own third material, which no mesh draws until one is picked.
 */
export const WINDOW_DEBUG_CHANNELS = Object.freeze([
  Object.freeze({ n: 0, id: 'off', label: 'Off — normal render', reads: 'The effect as it ships.' }),
  Object.freeze({
    n: 1,
    id: 'quad',
    label: '1 · Quad (magenta)',
    reads:
      'Flat magenta over the mask AABB crop. BLACK/absent = the mesh is not drawing at all — bad mask URL, ' +
      'nothing painted, hidden, or the pass never ran. Magenta in the WRONG PLACE = the mask rect the ' +
      'authority served disagrees with where the cookie actually is.',
  }),
  Object.freeze({
    n: 2,
    id: 'mask',
    label: '2 · Mask RGB',
    reads:
      'The window mask file as this shader samples it. You should see your painted cookie, in its own ' +
      'colours. Black = sampling off the painted area, or a genuinely empty file.',
  }),
  Object.freeze({
    n: 3,
    id: 'presence',
    label: '3 · Presence',
    reads: 'The coverage gate — white wherever the mask clears the presence edge. This is the cookie silhouette.',
  }),
  Object.freeze({
    n: 4,
    id: 'level',
    label: '4 · Level',
    reads:
      'How much light lands here, before tint. Grey where you painted grey, bright where you painted bright. ' +
      'All-black with a healthy channel 2 means the alpha decode is wrong (the greyscale-no-alpha case).',
  }),
  Object.freeze({
    n: 5,
    id: 'tint',
    label: '5 · Tint',
    reads: 'The light colour at full strength. A stained-glass patch should read in its own hue here.',
  }),
  Object.freeze({
    n: 6,
    id: 'floorGate',
    label: '6 · Floor gate (R=visible, G=stored depth, B=expected depth)',
    reads:
      '2026-08-05 — the depth-authority verdict, replacing the old scene-attribute floor-index equality ' +
      'test. RED = the gate itself (1 = my own floor`s background is what`s really visible here, 0 = ' +
      'something ranked above it — a Tile, a roof, the floor above — is drawn over it instead). GREEN = ' +
      'the RAW stored depth at this pixel, as a grey ramp. BLUE = this quad`s own expected depth, ' +
      'broadcast flat across the whole quad — a solid, unchanging blue means setExpectedDepth is being ' +
      'pushed; pure black on a wired effect means it is stuck at its construction-time default and the ' +
      'seam feeding it is not calling through. ' +
      '⚠️ RED IS "VISIBLE", NOT "IS BACKGROUND" — fail-open polarity: an unwired depth texture compiles ' +
      'the whole gate OUT (RED reads 1 everywhere — check getStatus().floorGateCompiled) rather than ' +
      'reading as occluded.',
  }),
  Object.freeze({
    n: 7,
    id: 'daylightTint',
    label: '7 · Daylight tint',
    reads:
      'The astrolabe-driven recolour multiplier — neutral grey (1,1,1) at noon, warming toward "Dawn / ' +
      'dusk colour" as the sun nears the horizon, cooling toward "Night colour" once it is down. This is ' +
      "what channel 5's tint gets multiplied by before channel 9; flat grey regardless of the time of day " +
      'means the astrolabe hour never reached this effect.',
  }),
  Object.freeze({
    n: 8,
    id: 'glassHeight',
    label: '8 · Glass thickness field',
    reads:
      'THE PANE ITSELF — the thickness field every glass term is derived from, as grey (mid-grey is the ' +
      'average thickness, white the lumps, black the thin spots). This is the channel to tune "Blob size", ' +
      '"Fine detail", "Draw lines" and "Draw-line angle" against, because it shows them directly instead ' +
      'of through two derivatives. FLAT MID-GREY EVERYWHERE means the field is not varying at all — check ' +
      'Blob size is not enormous relative to the cookie. It ignores "Glass thickness", by design: that ' +
      'slider scales the RESULT of the field, not the field.',
  }),
  Object.freeze({
    n: 9,
    id: 'glassOffset',
    label: '9 · Refraction offset (R=x, G=y)',
    reads:
      'WHERE THE LIGHT MOVED TO, per axis, centred on mid-grey: red above/below 0.5 is a rightward/leftward ' +
      'shift, green is up/down, both scaled so the full "Glass thickness" range fills the channel. Flat ' +
      '0.5 grey = no displacement anywhere (Glass thickness at 0, or a field with no slope). This is the ' +
      'GREEN channel\'s offset — red and blue land at ±"Prism split" either side of what you see here.',
  }),
  Object.freeze({
    n: 10,
    id: 'caustic',
    label: '10 · Caustic gain',
    reads:
      'The focusing multiplier, where mid-grey is 1.0 (no change), brighter is a converging thick spot ' +
      'and darker a diverging thin one. Should read as a soft cellular web. UNIFORM MID-GREY means the ' +
      'caustic term is off (strength 0) or the field is flat. If the bright knots sit in the DIMPLES ' +
      'rather than on the lumps of channel 8, the lens sign is inverted — see window-glass.js.',
  }),
  Object.freeze({
    n: 11,
    id: 'rawLight',
    label: '11 · Raw light (pre-shoulder, pre-tint, boosted)',
    reads:
      'The contribution BEFORE the highlight shoulder AND before the astrolabe daylight tint (window-' +
      'cookie.js#shoulderedContribution), amplified ×8. Compare against channel 12 AT NOON, when the ' +
      'tint is neutral (1,1,1) and cannot confound the reading: if 11 looks much brighter/whiter than ' +
      '12 over a large painted area, the cookie was about to blow the composite out before the shoulder ' +
      'caught it — the shoulder is doing real work, not decoration. If 11 and 12 look nearly identical ' +
      'AT NOON, the cookie was never close to clipping and the shoulder is a no-op here. At any OTHER ' +
      'hour the two will differ by the tint as well — that difference is expected, not a shoulder symptom.',
  }),
  Object.freeze({
    n: 12,
    id: 'final',
    label: '12 · Final, post-shoulder, post-tint (boosted)',
    reads:
      'The cookie contribution ACTUALLY added to buf:scene.illum — after the highlight shoulder AND ' +
      'after the astrolabe daylight tint, in that order (the tint is deliberately LAST: it recolours ' +
      'the finished, correctly-exposed light rather than skewing what the shoulder treats as the peak — ' +
      "see window-render.js's own note on `uDaylightTint`) — amplified ×8 so a faint real contribution " +
      'is legible rather than looking identical to zero. This is the number that matters: ' +
      '`lit = EOTF(OETF(albedo) × illum)`, so whatever shows here is what illum gains at this texel, and ' +
      'a value pushing toward white even at ×8 boost means the room was already close to full ambient ' +
      'before this effect touched it — nothing left in this effect alone can fix that (see window-' +
      'cookie.js#shoulderedContribution`s own header for the honest limit).',
  }),
  Object.freeze({
    n: 13,
    id: 'rainFlow',
    label: '13 · Rain flow direction',
    reads:
      'Which way is DOWN THE PANE, per window pool, as a colour: R = 0.5 + 0.5x and G = 0.5 + 0.5y of the ' +
      'direction the water runs (toward the wall the window sits in, i.e. outward from the building), so ' +
      'east reads red, south green, west dark and north dark. Blue is the pane height: 0 at the sill, 1 at ' +
      'the far end of the pool. BLACK over a pool means no direction was found (no outdoors mask, the pool ' +
      'is not inside a building, or it sits between two opposite walls): that pool gets splashes and no ' +
      'running drops. A south-wall window that does not read green is an inverted field — see ' +
      'window-rain-field.js.',
  }),
  Object.freeze({
    n: 14,
    id: 'rainFlowAux',
    label: '14 · Rain facet blend / confidence / height',
    reads:
      'R = how far a pool near a corner has blended from its first facet to its second (0 = all first, ' +
      '1 = all second); G = how honest the direction is (1 = fully, 0 = none); B = pane height. A straight ' +
      'wall is black in R. At a building corner R should ramp smoothly from 0 to 1 across it: a hard edge ' +
      'there means Corner blend is too small.',
  }),
  Object.freeze({
    n: 15,
    id: 'rainDrops',
    label: '15 · Rain drops (gain, offset)',
    reads:
      'The rain as the shader adds it. R = brightness gain / 2 (so mid-red is 1.0, no change), G and B = ' +
      'the lens offset in x and y (mid = 0 px, full scale = 24 px either way). A dry pane is flat ' +
      '(0.5, 0.5, 0.5). Beads should read as a bright core with a dark rim in R and a small ' +
      'push-pull in G/B; running drops should be the same shape stretched along the flow of channel 13. ' +
      'Nothing at all while it is raining means the rain amount is 0 (check Rain on the glass and the ' +
      'weather) or this tier does not compile rain.',
  }),
  Object.freeze({
    n: 16,
    id: 'rooms',
    label: '16 · Rooms (one colour per room)',
    reads:
      'THE ROOM MAP — every room the Foundry walls divide this floor into, filled with its own colour (walls dark ' +
      'grey, outdoor rooms dimmed). Two rooms showing the SAME colour across a wall means a gap in the walls let ' +
      'them merge: raise "Wall seal" or close the gap. All black = no room map yet (no walls on this floor?).',
  }),
  Object.freeze({
    n: 17,
    id: 'roomWallDist',
    label: '17 · Distance to the nearest wall',
    reads:
      'Grey ramp: black on a wall, white 200 px or more away. This is what "Wall fade" fades the moving light by, ' +
      'so the light thins out against a wall instead of stopping on a line.',
  }),
  Object.freeze({
    n: 18,
    id: 'roomSun',
    label: '18 · Sun side (R=facing, G=has a window, B=low sun)',
    reads:
      'Per pixel: RED = how squarely the window nearest to it (through its own room) faces the sun right now — that ' +
      'share of the light moves and brightens, the rest stays and dims. GREEN = it has a window to judge by (black = ' +
      'an interior or outdoor room: the light there never moves). BLUE = how low the sun is (the strength of the ' +
      'sunny/shaded difference; black at noon and night). Red should turn smoothly around a corner between windows.',
  }),
  Object.freeze({
    n: 19,
    id: 'roomGate',
    label: '19 · Room gate (share of the smear that counts)',
    reads:
      'White = every smear tap read light from this same room; darker = taps fell into another room, outside, or ' +
      'against a wall and were dropped or faded. With the sun high (no drift) this is white everywhere.',
  }),
]);

/** Channel 12's (and 11's) amplification — see their own reading guides above. */
export const WINDOW_DEBUG_BOOST = 8;

/**
 * The manifest — the effect as data (Effects.md §2 shape). `tiers` lists only
 * what is ACTUALLY BUILT; everything else is `deferredRungs`, named and
 * ordered but not yet real code.
 *
 * `visualWeight: 0.65` — a mood read: an interior scene with dead windows
 * reads as a lighting bug rather than as a missing effect, much like
 * specular's metal.
 *
 * `a11y.photosensitive: false` — a static cookie today; no flashing.
 * ⚠️ Revisit when the lightning-coupling rung (a fast sky-brightness spike)
 * lands.
 *
 * @type {import('../effect-manifest.js').EffectManifest}
 */
export const WINDOW = Object.freeze({
  id: 'window',
  title: 'Window light',
  visualWeight: 0.65,
  a11y: Object.freeze({ photosensitive: false }),
  enabledFromProfile: 'low',
  readiness: Object.freeze({
    firstRunWork: true,
    coverage: 'partial',
    why: 'Builds a dedicated scene, mesh and material PER FLOOR, lazily, via sync() — which ALSO pushes a depth-authority-derived uniform every call, so sync() itself cannot safely run for a floor that is not yet the viewed one. The cookie-mask fetch (ensureMaskImage) has no such dependency, so vt-pan-viewer.js#prepareFloor calls it directly (exposed as prefetchMask) during floor-prepare, ahead of sync() ever running for that floor — fixed 2026-08-16 after a live report that the effect visibly popped in a beat after a floor switch, because nothing used to ask for this mask until the first real frame rendered on the new floor. COUNTED: that fetch (async, clears on success and failure). NOT COUNTED: the scene/mesh/material construction itself, which is synchronous — see water’s readiness note for why the flag that would express it fails closed when the effect is off.',
    probes: ['windowMaskLoad'],
  }),
  params: WINDOW_PARAMS,
  // HOW YOU ADD IT TO A MAP — the ＋ in this effect's card header opens the
  // brush already loaded with this mask (validateAuthoring, effect-manifest.js).
  authoring: Object.freeze({ paint: 'window' }),
  tiers: Object.freeze([
    Object.freeze({
      n: 0,
      name: 'cookie',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.06 }),
      adds:
        'The window mask read as LIGHT (value = level, hue+saturation = tint), ADDED onto ' +
        'buf:scene.illum, cropped to the mask own AABB (Law 6) and gated to the visible floor. No ' +
        'aperture, no wall, no sill — the artist already painted where the light lands. The term that ' +
        'cannot be a silent zero: with strength above 0 and a painted texel above the presence edge, ' +
        'this always contributes. Also carries the highlight shoulder (the exposure step that keeps a ' +
        'bright cookie from washing architectural art out to a flat white disc) and, LAST, a DAYLIGHT ' +
        "TINT: the finished light multiplied by a mix of the author's dawn/dusk and night colours, " +
        "driven by world/sun.js's dayFactor01/twilight01 (the SAME sun env/one-sun already computes " +
        'for everything else), neutral at noon. This is the genuinely cheap floor (glass moved to tier ' +
        "1, below) — one mask tap, the shoulder's own ALU, one CPU-resolved colour lerp.",
    }),
    Object.freeze({
      n: 1,
      name: 'glass',
      fromProfile: 'performance',
      cost: Object.freeze({ class: 'C4', estMsPerMp: 0.18 }),
      adds:
        'THE GLASS (effects/window/window-glass.js): one procedural THICKNESS field over world space, ' +
        'whose gradient displaces the cookie (warp), whose per-channel scaling of that same ' +
        'displacement splits red from blue along the same gradient (prism), and whose curvature ' +
        'focuses light into bright knots over the thick spots (fake caustics) — three derivatives of ' +
        'ONE field, sharing five noise taps, so the highlight always lands where the warp bunches and ' +
        'the fringe wraps it. The prism is what forces three mask taps instead of one: each channel ' +
        "now samples where ITS OWN wavelength came from. Wired 2026-08-29 to `window-render.js`'s own " +
        "`glass` JS-time construction flag — already built, per this rung's own history (see " +
        'deferredRungs below, formerly `glassPerfGate`) — never previously reachable at runtime, so it ' +
        'compiled in unconditionally at every profile. Below this rung, tier 0 alone is byte-identical ' +
        "to what the author's `glassWarpPx = 0` already produced (every glass term vanishes exactly " +
        'there) — this rung is the SAME picture, minus the five taps it costs to prove it, restored at ' +
        'the profile a player has NOT opted below. RAIN ON THE GLASS rides this rung too ' +
        '(window-rain.js): when the weather is rain, beads of water lens the light, drops run down the ' +
        'pane toward the wall, and a storm sheets water over it. It costs nothing dry (one uniform ' +
        'branch) and is not compiled below this rung. SUN & ROOMS rides it as well (window-room-light.js over ' +
        'scene/room-map.js, 2026-10-28): the cookie drifts away from the sun by the building-shadow throw and smears ' +
        'back toward where it is painted, every tap kept inside its own Foundry-wall room and faded near walls, and ' +
        'each room brightens or dims by whether its windows face the low sun — the old `drift` and `stretch` rungs.',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'skyDriven',
      note:
        'Drive the cookie with TWO lobes from effects/sky-access.js — a warm sharp KEY (the sun disc, ' +
        'dies under cloud) and a cool flat FILL (the sky dome, survives and slightly grows under ' +
        'cloud) — two gammas on the same fetch, zero extra taps. This is what makes a cloud change the ' +
        "light's CHARACTER rather than just its level (Windows.md §3.3). NOT the same thing as tier 0's " +
        'own daylightTint param above: that is a flat authored-colour lerp keyed to dayFactor01/' +
        'twilight01; this rung is a physically-modelled two-lobe sample of the sky itself.',
    }),
    Object.freeze({
      name: 'moon',
      note: 'The same cookie at night on the night dome colour — a cold faint pool instead of an off switch.',
    }),
    Object.freeze({
      name: 'glassConvergence',
      note:
        "UNIFY THIS EFFECT'S GLASS WITH `effects/lighting/aperture-gobo.js`'S. Both now model medieval " +
        'panes and neither shares a line: aperture-gobo has facets/grime/broken panes over real wall ' +
        'geometry (a 1-D offset along its spoke axis), tier 1 here has a 2-D displacement field with ' +
        'dispersion and caustics over a painted mask. Each has what the other lacks. They were kept ' +
        "apart deliberately (window-glass.js's header argues it: the parameterizations genuinely do not " +
        'overlap yet, and one shared helper taking the union of both would be a fork wearing an ' +
        'abstraction). The convergence worth building is the FIELD — one "what does hand-blown glass ' +
        'look like" model both sample, each applying it in its own geometry — not one shared warp ' +
        'function. Two examples now exist, which is the minimum needed to see the right seam.',
    }),
    Object.freeze({
      name: 'cloud',
      note:
        'PARTIALLY BUILT (2026-09-10). `world/cloud-field.js` exists and is the shared field ' +
        'shadow-access/environmental-light/water/specular all read too, never owned here — ' +
        '`window-render.js#cloudFactorNode` now carries a real per-fragment ground-shadow sample ' +
        '(`buildCloudGroundVisNode`, built once per subsystem in `vt-pan-viewer.js`), and ' +
        '`cloudOvercastNode` adds a global blur (widened presence edge + flattened contrast) and an ' +
        'up-to-50% dim keyed to the scalar `cloudCover01`, independent of whether a cloud is directly ' +
        "overhead right now. What is STILL missing, and is genuinely this rung's own remaining half: " +
        'the field killing the KEY lobe specifically and leaving the FILL, as one term of the `skyDriven` ' +
        "rung above's two-lobe sample — today's dim is a flat multiply on the whole cookie, not a " +
        'colour-character change. Landing `skyDriven` first and folding cloud into its key term is the ' +
        'natural next step, not a second mechanism bolted beside this one.',
    }),
    Object.freeze({
      name: 'pointLights',
      note:
        "AUTHOR'S OWN PROPOSAL (2026-07-27), flagged rather than assumed: instead of a flat quad " +
        'confined to exactly the painted pixels, label the mask connected-components (as ' +
        'fluid-net.js does for its own tube mask) and feed each bright blob into the point-light system ' +
        '(effects/lighting/point-light-pool.js) as a real light source. This is the fix for the ' +
        'structural limit tier 0 still has in common with V2: a flat cookie lights only where it is ' +
        'painted, with no spread into the room. A converted point light would smoothly fill the room ' +
        'the way an actual point light does. The open engineering question is real: it needs "getting ' +
        'working right" before it ships (per-blob light lifecycle, wall-clipped shape, cost at scale) — ' +
        'and whichever form ships, its QUALITY (intensity, colour) must respond to the SAME cloud ' +
        'factor that dims the flat cookie, so a point-light room goes dim under the identical passing ' +
        'cloud rather than the two mechanisms disagreeing about the weather.',
    }),
    Object.freeze({
      name: 'occlude',
      note:
        'The cookie cut by what blocks the sun outside — a neighbouring building shadow lying across ' +
        'the window kills its light. Reads the caster-height field sun-occlusion.js already marches.',
    }),
    Object.freeze({
      name: 'bounce',
      note: 'The fill lobe upgraded to a genuinely blurred cookie, plus a soft warm indirect wash into the room.',
    }),
    Object.freeze({
      name: 'shaft',
      note: 'The visible fan of light in the air above the patch. Half-res, temporally accumulated, additive.',
    }),
    Object.freeze({
      name: 'motes',
      note: 'Dust in the beam through the particle engine that already exists.',
    }),
  ]),
});
