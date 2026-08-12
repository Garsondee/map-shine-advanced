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
 * ⚠️ **Cloud shadows are WIRED, not built.** `window-render.js` takes an
 * injectable `cloudFactorNode` (TSL node, 0..1) that defaults to a constant 1
 * — no dimming. The day `world/cloud-field.js` exists (Windows.md §4), the
 * caller passes a real per-fragment sample instead of the constant and NOTHING
 * else in this effect changes. That is the whole TODO: a seam with a safe
 * default, not a stub slider (`params/no-dead-controls` would fail the build
 * on a "Cloud shadows" param with no consumer, so it is not one yet).
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
    default: 1,
    category: 'Look',
    label: 'Window light',
    help: 'Master strength of every light cookie this effect draws. Turn it to 0 to see the map with no window light at all.',
  },
  contrast: {
    type: 'float',
    min: 0.25,
    max: 4,
    step: 0.01,
    default: 1,
    category: 'Look',
    label: 'Patch contrast',
    help: 'Gamma on the painted falloff. Above 1 sharpens the cookie toward a hard-edged patch; below 1 softens it toward a broad glow. 1 = exactly what you painted.',
  },
  dawnDuskTint: {
    type: 'color',
    space: 'srgb',
    default: '#ff8a3d',
    category: 'Look',
    label: 'Dawn / dusk colour',
    help: 'The colour the window light leans toward, driven by the astrolabe, around sunrise and sunset. Fades to no tint by noon.',
  },
  nightTint: {
    type: 'color',
    space: 'srgb',
    default: '#5c7cff',
    category: 'Look',
    label: 'Night colour',
    help: 'The colour the window light leans toward, driven by the astrolabe, once the sun is down.',
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
    default: 20,
    category: 'Glass',
    label: 'Glass thickness',
    help: 'How much the uneven pane bends the light, as a maximum shift in world pixels. 0 = perfectly flat modern glass: no distortion, no prism, no caustics. Raise it for thick, wavy, hand-blown panes.',
  },
  glassDispersion: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    category: 'Glass',
    label: 'Prism split',
    help: 'How far apart the red and blue ends of the light are pulled as they refract. 0 = the light distorts but keeps its colour; 1 = a strong rainbow fringe along every edge. Needs some Glass thickness to have anything to split.',
  },
  glassScale: {
    type: 'float',
    min: 8,
    max: 400,
    step: 1,
    default: 400,
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
    default: 2,
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
        'this always contributes. Also carries THE GLASS (effects/window/window-glass.js): one ' +
        'procedural THICKNESS field over world space, whose gradient displaces the cookie (warp), ' +
        'whose per-channel scaling of that same displacement splits red from blue along the same ' +
        'gradient (prism), and whose curvature focuses light into bright knots over the thick spots ' +
        '(fake caustics) — three derivatives of ONE field, sharing five noise taps, so the highlight ' +
        'always lands where the warp bunches and the fringe wraps it. The prism is what forces three ' +
        'mask taps instead of one: each channel now samples where ITS OWN wavelength came from. Every ' +
        'glass term vanishes exactly at glassWarpPx = 0 — flat glass refracts nothing — which is the ' +
        "off switch, and the whole subgraph is additionally omitted at BUILD time by window-render.js's " +
        "own `glass` flag. LAST, over the top of everything above (the glass's own warp/prism/caustic, " +
        'the highlight shoulder), a DAYLIGHT TINT: the finished light is multiplied by a mix of the ' +
        "author's dawn/dusk and night colours, driven by world/sun.js's dayFactor01/twilight01 (the " +
        'SAME sun `env/one-sun` already computes for everything else), neutral at noon. Deliberately ' +
        'ordered last (author directive, 2026-08-05: the RGB-shifted glass result must be what gets ' +
        'tinted) — see window-render.js#uDaylightTint for why applying it earlier would let the tint ' +
        "distort the highlight shoulder's own exposure maths. A cheap CPU-side colour lerp on a live " +
        '0..1 signal — not the physically-modelled sun/sky two-lobe drive `deferredRungs.skyDriven` ' +
        'below still is, which stays unbuilt.',
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
      name: 'drift',
      note:
        'One global UV offset sliding the cookie along the sun own throw as the hour changes — ' +
        'delegated verbatim from the sun shadow formula (marchDirectionToSun, heightPx/tan(elevation)), ' +
        'never re-derived (Windows.md §5.1).',
    }),
    Object.freeze({
      name: 'moon',
      note: 'The same cookie at night on the night dome colour — a cold faint pool instead of an off switch.',
    }),
    Object.freeze({
      name: 'glassPerfGate',
      note:
        'PUT THE GLASS ON A REAL PERFORMANCE TIER. The expensive half of tier 0 — five noise taps and ' +
        "two extra mask taps — already has its JS-time off switch (`window-render.js`'s `glass` " +
        'construction flag, which omits the subgraph rather than multiplying it by zero, per ' +
        'Effects.md Law 4). What is MISSING is the machinery to flip it while running: a perf tier has ' +
        'to change with the profile selector, and this subsystem never rebuilds its material (specular ' +
        'carries exactly that machinery and is the template). Declaring a `fromProfile` rung before ' +
        'that rebuild exists would be a manifest claiming a gate nothing honours, so the rung is named ' +
        'here instead. Until then the glass is always compiled in and `glassWarpPx = 0` is the ' +
        "author's exact, but runtime-cost-free-only-in-ALU, off switch.",
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
        '⚠️ THE NAMED GOAL, not yet built. world/cloud-field.js (Windows.md §4) — a two-octave analytic ' +
        'noise drifting on the wind, sampled at world position, killing the KEY lobe and leaving the ' +
        'FILL. Windows is its forcing function, NOT its owner: shadow-access/environmental-light/water/ ' +
        'specular all want the same field, and owning it here re-runs the eight-suns failure in the ' +
        'weather domain. The SEAM for this already exists today (window-render.js#cloudFactorNode) — ' +
        'this rung is "build the field and pass a real node", not "add a new uniform".',
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
      name: 'stretch',
      note:
        'Per-patch elongation at low sun, pivoting on each cookie own centroid — needs the connected- ' +
        'component table tier 0 does not build yet.',
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
