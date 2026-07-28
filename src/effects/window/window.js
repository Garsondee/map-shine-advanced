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
    label: '6 · Floor gate',
    reads:
      'Green = this texel belongs to the visible floor and may draw. Black everywhere means buf:scene.attr ' +
      'was unavailable (the gate compiled out — check getStatus().floorGateCompiled) or the viewed floor ' +
      'never matches the loaded mask.',
  }),
  Object.freeze({
    n: 7,
    id: 'rawLight',
    label: '7 · Raw light (pre-shoulder, boosted)',
    reads:
      'The contribution BEFORE the highlight shoulder (window-cookie.js#shoulderedContribution), amplified ' +
      '×8. Compare against channel 8: if this one looks much brighter/whiter than 8 over a large painted ' +
      'area, the cookie was about to blow the composite out before the shoulder caught it — the shoulder ' +
      'is doing real work, not decoration. If 7 and 8 look nearly identical, the cookie was never close ' +
      'to clipping and the shoulder is a no-op here.',
  }),
  Object.freeze({
    n: 8,
    id: 'final',
    label: '8 · Final, post-shoulder (boosted)',
    reads:
      'The cookie contribution ACTUALLY added to buf:scene.illum — after the highlight shoulder — ' +
      'amplified ×8 so a faint real contribution is legible rather than looking identical to zero. This ' +
      'is the number that matters: `lit = EOTF(OETF(albedo) × illum)`, so whatever shows here is what ' +
      'illum gains at this texel, and a value pushing toward white even at ×8 boost means the room was ' +
      'already close to full ambient before this effect touched it — nothing left in this effect alone ' +
      'can fix that (see window-cookie.js#shoulderedContribution`s own header for the honest limit).',
  }),
]);

/** Channel 8's (and 7's) amplification — see their own reading guides above. */
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
        'this always contributes.',
    }),
  ]),
  deferredRungs: Object.freeze([
    Object.freeze({
      name: 'skyDriven',
      note:
        'Drive the cookie with TWO lobes from effects/sky-access.js — a warm sharp KEY (the sun disc, ' +
        'dies under cloud) and a cool flat FILL (the sky dome, survives and slightly grows under ' +
        'cloud) — two gammas on the same fetch, zero extra taps. This is what makes a cloud change the ' +
        "light's CHARACTER rather than just its level (Windows.md §3.3).",
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
