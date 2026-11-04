/**
 * FLUID's SURFACE — the TSL materials. THREE is INJECTED, never imported.
 *
 * ============================================================================
 * 2026-11-04 — REBUILT AS A LIT POTION, NOT A TINTED FILM
 * ============================================================================
 * The author: *"It needs to look like magical fluid rushing down glass pipes ... self illuminating ... fun,
 * dynamic ... 'reactions' where things suddenly change."* Three measured reasons it read as a pastel rainbow film
 * before this rebuild, each fixed here:
 *
 *   1. **The glow was multiplied by the night.** Both passes drew into `scene.color` BEFORE the light composite
 *      (`environmental-light.js`: lit = EOTF(OETF(scene) × illum + coloration)), so at night a glowing tube was
 *      darkened exactly like paint (illum ≈ 0.15 on Wizard's Lair). The two meshes now live in the subsystem's
 *      own `emitScene`, which the viewer draws onto `scene.lit` AFTER the composite — where the flames, sparks and
 *      specular glints already draw. The goo is a light source; light is not darkened by the dark.
 *   2. **The goo was under the painted glass.** The host tile paints its own glass (Wizard's Lair: alpha 0.78
 *      median over the tubes), and drawing under the host meant 78% of the goo was covered by grey before anyone
 *      saw it. Drawing over the composite instead, the goo is GATED by the host's own art (`hostGateTexture`,
 *      `fluid-alchemy.js#computeFluidHostGate`): ink lines, brass fittings and white glints stay on top; the pale
 *      paint that only depicts glass lets the goo through.
 *   3. **It was a rainbow, not a reagent.** `iridescence` 1 painted a thin-film rainbow over the whole body. The
 *      body is now the REAGENT's colour (`fluid-alchemy.js#fluidPalette`), transported by the sim, deep at the
 *      walls and hot down the centreline; the sheen is a thin film on the glass rim only.
 *
 * WHAT EACH TERM IS
 *   SILHOUETTE   the high-res mask file, thresholded (never the pack — a derived grid cannot supply an edge).
 *                Outside it the fragment is DISCARDED, so the whole-quad mesh costs one texture read per pixel off
 *                the tubes and the noise below runs only where there is goo.
 *   s, across    the pack (`fluid-pack.js`): arc length along the tube, distance from its centreline.
 *   CYLINDER     `√(1 − across²)`, the path length through a round tube seen from above — hot centre, deep walls.
 *   STATE        the sim's four transported channels (`fluid-sim.js`): φ fill, reagent position, energy, froth.
 *                A DEPENDENT read (the pack gives the coordinate), C5. A second tap one bin ahead finds FRONTS:
 *                where φ changes (the meniscus, foaming) and where the reagent changes (a reacting front, white-hot).
 *   TRAVEL       `along = s·length − x` in world px, `x` being how far this tube has flowed (`fluid-alchemy.js`),
 *                spatially constant per tube. Streaks, bubbles and motes are drawn at `along`, so they rush when the
 *                pump surges and stop dead when it stalls. Scaled by the item's PIPE radius, so a flask does not
 *                stretch them.
 *   FLASK        where the local radius is well above the pipe's, the goo SWIRLS (domain-warped noise in the item's
 *                own world space, marbling the next reagent in) and BOILS (Worley cells in time, faster when the tube
 *                is agitated by a reaction).
 *   ABSORB       Beer–Lambert by the reagent's own colour (the same σ = −log(c)/mean formula water uses), applied as
 *                a MULTIPLY over the lit glass beneath, gated like the glow — what makes it read as coloured liquid
 *                in daylight, where an added glow alone would only bleach.
 *
 * ⚠️ NO `mrtNode` ON EITHER MATERIAL. Both draw onto `scene.lit`, which has no `attr` attachment and no
 * renderer-global MRT: an `mrt({attr})` override there leaves the fragment's output struct EMPTY ("structures must
 * have at least one member" — the lab hit it on the first draw). Should these ever move back onto `scene.color`,
 * the absorb pass needs `attr = vec4(1)` again (the multiply identity is WHITE, `feedback_blend_neutral_element_
 * is_per_blend`), or it zeroes the floor attributes under every tube.
 *
 * @module effects/fluid/fluid-render
 */

import { FLUID_TARGET_TRAVERSAL_SECONDS } from './fluid-sim.js';

/** The authored tint's default — an "alchemical" cyan-green. Matches FLUID_PARAMS.tint. */
export const FLUID_TIER0_TINT = [0.15, 0.95, 0.7];
/** The second reagent's default — arcane violet. Matches FLUID_PARAMS.accent. */
export const FLUID_TIER0_ACCENT = [0.62, 0.28, 1.0];

/** How bright the goo burns at Glow = 1 (HDR; the bloom finds anything above ~1). */
export const FLUID_TIER0_GLOW = 0.35;

/** Mask bytes below this are not tube; above the upper edge they fully are. */
export const FLUID_PRESENCE_EDGE0 = 0.04;
export const FLUID_PRESENCE_EDGE1 = 0.18;

/** The goo's own silhouette ramp, wider than the shared presence edge above: the authored mask is a flat
 * interior (214 on Wizard's Lair) with an anti-aliased rim, and 99.5% of its mid values sit within 3 px of empty —
 * ramping across most of that rim keeps the glowing edge smooth when the camera zooms in. The shared EDGE0/1 still
 * decide PRESENCE (the discard, the shadow tint, the depth proxy). */
const FLUID_SILHOUETTE_EDGE1 = 0.6;

/** One sim bin at the design resolution (`FLUID_PROFILE_SAMPLES`), the step for the front finder. */
const FLUID_FRONT_EPSILON = 1 / 512;

/** How bright the goo is where nothing is lighting it up (a patch, a flare, a front, a pulse): a dim, deeply
 * coloured liquid, so the bright parts read by contrast. */
const FLUID_DIM_BODY = 0.1;

/** Thin-film strength default (the glass rim's sheen). */
export const FLUID_TIER3_IRIDESCENCE = 0.3;

/** Beer–Lambert strength of the absorb pass at full thickness. */
export const FLUID_ABSORPTION_STRENGTH = 1.6;

/** Streak/marbling strength default. Matches FLUID_PARAMS.structure. */
export const FLUID_TIER5_STRUCTURE = 0.7;

/** Bubble strength default. Matches FLUID_PARAMS.bubbles. */
export const FLUID_TIER6_BUBBLES = 0.6;

/** Mote (sparkle) strength default. Matches FLUID_PARAMS.sparkle. */
export const FLUID_TIER6_SPARKLE = 0.6;

/** How many performance-cascade rungs this effect declares (0..7, `fluid.js#FLUID.tiers`). */
export const FLUID_MAX_TIER = 7;

/** What `resolveEffectTier(FLUID, {profile: DEFAULT_PERFORMANCE_PROFILE})` resolves to — `standard` now reaches
 * every rung (2026-11-04: the sim, its reactions and the light ARE the effect the author asked for; each costs
 * well under a tenth of a millisecond per megapixel of tube, and the governor can still shed them). */
export const FLUID_DEFAULT_TIER = 7;

/**
 * The tier ladder, as a plan a builder can branch on.
 * @param {number} tier
 */
export function fluidTierPlan(tier) {
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(FLUID_MAX_TIER, Math.floor(tier))) : FLUID_DEFAULT_TIER;
  return {
    tier: t,
    cylinderEnabled: t >= 1,
    filmEnabled: t >= 3,
    fillEnabled: t >= 4,
    structureEnabled: t >= 5,
    bubblesEnabled: t >= 6,
    lightEnabled: t >= 7,
  };
}

/**
 * Build fluid's two surface materials — absorb (multiply) and emit (add), both drawn after the light composite.
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.maskTexture - the high-res `_Fluid` file (RED, linear).
 * @param {*} args.packTexture - `fluid-pack.js`'s RGBA pack.
 * @param {*} args.stateTexture - the sim's ping-pong state (φ, reagent, energy, froth), `samplesPerTube × tubeCount`.
 * @param {number} args.tubeCount
 * @param {*} args.timeMsNode - THE SHARED CLOCK (`core/frame-clock.js`).
 * @param {*} [args.tubeTexture] - `fluid-alchemy.js#writeFluidTubeTick`'s 2 × tubeCount texture (texel 1 = travel,
 *   length, agitation). Null → travel is the old analytic drift and nothing is agitated.
 * @param {*} [args.hostGateTexture] - R = 1 where the goo shows through the host's art (`computeFluidHostGate`).
 * @param {number} [args.pipeRadiusPx] - the item's typical pipe half-width, world px (pattern scale).
 * @param {number[]} [args.itemSizePx] - the item quad's world size [w, h] (flask swirl scale).
 * @returns {{absorbMaterial: *, emitMaterial: *, uniforms: object, maskTexNode: *, packTexNode: *,
 *   stateTexNodes: Array<*>, tier: number}}
 */
export function buildFluidSurfaceMaterials({
  THREE,
  maskTexture,
  packTexture,
  stateTexture,
  tubeCount,
  timeMsNode,
  tubeTexture = null,
  hostGateTexture = null,
  pipeRadiusPx = 20,
  itemSizePx = [4096, 4096],
  tint = FLUID_TIER0_TINT,
  accent = FLUID_TIER0_ACCENT,
  variety = 0.6,
  glow = FLUID_TIER0_GLOW,
  iridescence = FLUID_TIER3_IRIDESCENCE,
  opacity = 1,
  flowSpeed = 1,
  structure = FLUID_TIER5_STRUCTURE,
  bubbles = FLUID_TIER6_BUBBLES,
  sparkle = FLUID_TIER6_SPARKLE,
  chaos = 0.75,
  palette = null,
  tier = FLUID_DEFAULT_TIER,
}) {
  const plan = fluidTierPlan(tier);
  const {
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    smoothstep,
    clamp,
    max,
    min,
    sqrt,
    sin,
    mix,
    log,
    exp,
    dot,
    abs,
    mod,
    floor,
    fract,
    pow,
    length,
    select,
    Fn,
    If,
    Discard,
    mx_noise_float,
    mx_worley_noise_float,
  } = THREE.TSL;

  const uTint = uniform(vec3(tint[0], tint[1], tint[2]));
  const uAccent = uniform(vec3(accent[0], accent[1], accent[2]));
  // Eight slots (`FLUID_PALETTE_SLOTS`): the authored pair plus six wild reagents; `uPalCount` says how many play.
  const pal = Array.from({ length: 8 }, (_, i) => palette?.colors?.[i] ?? (i % 2 ? accent : tint));
  const uPal = pal.map((c) => uniform(vec3(c[0], c[1], c[2])));
  const uPalCount = uniform(float(palette?.count ?? 2));
  const uVariety = uniform(float(variety));
  const uGlow = uniform(float(glow));
  const uIridescence = uniform(float(iridescence));
  const uOpacity = uniform(float(opacity));
  // THE HOST'S OWN FADE, written every frame by `vt-pan-viewer.js#runMaskOcclusionPass` through
  // `fluid-surface-subsystem.js#setFadeForItem` (mythica-machina-press#545). 1 = authored, 0 = host faded out.
  const uFadeMul = uniform(float(1));
  const uFlowSpeed = uniform(float(flowSpeed));
  const uStructure = uniform(float(structure));
  const uBubbles = uniform(float(bubbles));
  const uSparkle = uniform(float(sparkle));
  const uChaos = uniform(float(chaos));
  const tubeCountF = float(Math.max(1, tubeCount));
  const R = float(Math.max(4, pipeRadiusPx));
  const itemSize = vec2(Math.max(1, itemSizePx[0]), Math.max(1, itemSizePx[1]));

  const quadUv = uv();
  const maskTexNode = texture(maskTexture, quadUv);
  const packTexNode = plan.cylinderEnabled ? texture(packTexture, quadUv) : null;
  const stateTexNodes = [];
  const tSec = timeMsNode.mul(float(1 / 1000));

  /** The palette colour at a reagent position (cyclic over `uPalCount`, blended to the next). */
  function paletteAt(g) {
    const gg = mod(max(g, float(0)), uPalCount);
    const i0 = floor(gg);
    const i1 = mod(i0.add(1), uPalCount);
    const f = smoothstep(float(0), float(1), fract(gg));
    // A balanced select tree (3 deep, not a 7-deep chain) over the eight slots.
    const pick = (i) => {
      const lo = select(
        i.lessThan(1.5),
        select(i.lessThan(0.5), uPal[0], uPal[1]),
        select(i.lessThan(2.5), uPal[2], uPal[3])
      );
      const hi = select(
        i.lessThan(5.5),
        select(i.lessThan(4.5), uPal[4], uPal[5]),
        select(i.lessThan(6.5), uPal[6], uPal[7])
      );
      return select(i.lessThan(3.5), lo, hi);
    };
    return mix(pick(i0), pick(i1), f);
  }

  /** A cheap 2-D cell hash, bounded so fp32 `sin` stays well-conditioned however far the goo has flowed. */
  function cellHash(c) {
    const b = mod(c, vec2(1024, 1024));
    return fract(sin(dot(b, vec2(12.9898, 78.233))).mul(43758.5453));
  }

  /**
   * ORGANIC FROTH (2026-11-04, round 4 — the author: "The circle/bubbles are a nice idea but need to be a lot more
   * random, uneven and not perfect circles"). A rim at a fixed Worley distance is a perfect circle by definition,
   * and every one shared one radius and one rim width — they read as stamped rings. Here:
   *   - the lookup is DOMAIN-WARPED by noise at about the bubble's own scale, so each outline is a different lump;
   *   - the SIZE varies from place to place (≈0.35×–1.65×), so tiny beads sit next to big gulps of gas;
   *   - the RIM WIDTH varies round each outline, and arcs DROP OUT (a broken, foaming rim, not a drawn circle);
   *   - each bubble's BRIGHTNESS varies, so some are only faint ghosts.
   * `bc` = (x, y in feature cells, z = the time axis the bubbles evolve along); `br` = the base rim radius in
   * cells. Returns `{ ring, hollow }` (hollow = the bubble's gas core, 1 at its centre).
   */
  function organicBubbles(bc, br) {
    const xy = bc.xy;
    const z = bc.z;
    const size = float(0.35).add(clamp(mx_noise_float(vec3(xy.mul(0.9), z.mul(0.3).add(1.7))).add(0.5), 0, 1).mul(1.3));
    const r = br.mul(size);
    // A lump or so across a typical bubble (two lobes read as scribbles in the lab, not bubbles).
    const k = float(1).div(br.mul(3.6));
    const kp = xy.mul(k);
    const warp = vec2(
      mx_noise_float(vec3(kp, z.mul(0.8).add(4.1))),
      mx_noise_float(vec3(kp.add(vec2(17.3, 5.9)), z.mul(0.8).add(9.2)))
    ).mul(r.mul(0.42));
    const wd = mx_worley_noise_float(vec3(xy.add(warp), z), float(1));
    const tk = float(0.22).add(clamp(mx_noise_float(vec3(kp.mul(1.7), z.add(2.3))).add(0.5), 0, 1).mul(0.6));
    const ring = smoothstep(r.mul(float(1).sub(tk)), r.mul(float(1).sub(tk.mul(0.35))), wd).mul(
      float(1).sub(smoothstep(r, r.mul(float(1).add(tk.mul(0.5))), wd))
    );
    const unbroken = smoothstep(float(-0.42), float(-0.05), mx_noise_float(vec3(kp.mul(1.1).add(31), z.mul(1.5))));
    const bright = float(0.3).add(clamp(mx_noise_float(vec3(xy.mul(0.7).add(50), z.mul(0.5))).add(0.5), 0, 1).mul(0.9));
    const hollow = float(1).sub(smoothstep(float(0), r.mul(0.8), wd));
    return { ring: ring.mul(unbroken).mul(bright), hollow };
  }

  /**
   * Every field both passes share — built ONCE, here, outside any Fn: the two materials reference the SAME
   * nodes (they cannot disagree about where the goo is or what colour it is), and the state samples exist at
   * construction so `stateTexNodes` can be re-pointed every tick. (Nodes created inside an Fn body only exist once
   * a renderer compiles it — a re-point list built there is empty at construction, which the sim-render test
   * caught.) Only `Discard` and the flask `If` need an Fn's stack; they live in the two Fn bodies below.
   */
  function fields() {
    const inside = smoothstep(float(FLUID_PRESENCE_EDGE0), float(FLUID_SILHOUETTE_EDGE1), maskTexNode.r);
    const gate = hostGateTexture ? texture(hostGateTexture, quadUv).r : float(1);

    let s = float(0);
    let across = float(0);
    let radiusPx = R;
    let stateV = float(0.5);
    let th = float(1);
    if (plan.cylinderEnabled) {
      s = packTexNode.r;
      across = clamp(packTexNode.g, 0, 1);
      radiusPx = max(packTexNode.a, float(2));
      stateV = packTexNode.b.sub(0.5).div(tubeCountF);
      th = sqrt(max(float(1).sub(across.mul(across)), float(0)));
    }

    // THE STATE (tier 4) — or a full, calm tube of the authored tint below it.
    let phi = float(1);
    let g = float(0);
    let energy = float(0.2);
    let froth = float(0.1);
    let front = float(0);
    let react = float(0);
    let travel = tSec.mul(uFlowSpeed).mul(float(220 / FLUID_TARGET_TRAVERSAL_SECONDS));
    let lengthPx = float(4096);
    let agitation = float(0.2);
    let mood = float(1);
    // Where the tube is wide, before the state is read (the lookup below depends on it).
    const wideAt = smoothstep(R.mul(2.0), R.mul(3.4), radiusPx);
    let sState = s;
    if (plan.fillEnabled) {
      if (tubeTexture) {
        const tube = texture(tubeTexture, vec2(float(0.75), stateV));
        travel = tube.r;
        lengthPx = max(tube.g, float(1));
        agitation = tube.b;
        mood = tube.a;
      }
      // BREAK THE WEDGES (2026-11-04 — the author, on a flask cut into straight colour wedges: "Sometimes
      // especially in wide areas we get these, arrows/lines/chevrons as a result of the way that the tubes are
      // calculated. How can we break them up so they look less even and perfect?"). Every texel's `s` is the arc
      // length of its NEAREST centreline point, so across a flask `s` is a Voronoi fan of the skeleton: constant along
      // straight lines, folding into a chevron at every bend — and a colour front read at `s` is cut along exactly
      // those lines. The lookup is pushed along the tube by a slow, swirling 2-D noise (two octaves, drifting), up to
      // ~1.9 local radii in a flask and a third of a radius in a pipe (a pipe's menisci only wobble a little), so a
      // front pours into a flask as a ragged, curling boundary instead of slicing it.
      const pw = quadUv.mul(itemSize).div(R.mul(10));
      const swirl = mx_noise_float(vec3(pw, tSec.mul(0.07)))
        .add(mx_noise_float(vec3(pw.mul(2.3).add(vec2(13.1, 7.7)), tSec.mul(0.13).add(5.0))).mul(0.45))
        .mul(1.4);
      const warpPx = radiusPx.mul(mix(float(0.33), float(1.9), wideAt));
      // Reflected at the tube ends, not clamped: a flask at a root (s ≈ 0) clamped a whole tongue of itself onto the
      // root bin, where fresh reagent and energy enter (a pale band curling round the neck in the lab).
      const sRaw = abs(s.add(swirl.mul(warpPx).div(lengthPx)));
      sState = float(1).sub(abs(float(1).sub(sRaw)));
    }
    if (plan.fillEnabled) {
      const st0 = texture(stateTexture, vec2(sState, stateV));
      // ...and in a flask the step is SOFTENED: two more taps a radius up and down the tube blend in, so a new reagent
      // swirls in over the flask rather than arriving as a hard edge.
      const softS = radiusPx.mul(0.7).div(lengthPx);
      const stUp = texture(stateTexture, vec2(clamp(sState.add(softS), 0, 1), stateV));
      const stDn = texture(stateTexture, vec2(clamp(sState.sub(softS), 0, 1), stateV));
      const st = mix(st0, st0.mul(0.5).add(stUp.mul(0.25)).add(stDn.mul(0.25)), wideAt);
      const ahead = texture(stateTexture, vec2(clamp(sState.add(FLUID_FRONT_EPSILON), 0, 1), stateV));
      stateTexNodes.push(st0, stUp, stDn, ahead);
      phi = st.r;
      g = st.g;
      energy = max(st.b, float(0));
      froth = clamp(st.a, 0, 1.5);
      // Fronts: a near-step in φ (the meniscus) or in the reagent (a reacting boundary) spikes a one-bin
      // difference and reads flat everywhere else.
      front = clamp(abs(ahead.r.sub(st.r)).mul(26), 0, 1).mul(max(st.r, ahead.r));
      // In a flask the warped boundary is a curl, not a line: a full-strength seam traced it as stacked contour
      // lines (a map, not a potion) — there it keeps a third of its strength.
      react = clamp(abs(ahead.g.sub(st.g)).mul(14), 0, 1)
        .mul(smoothstep(0.15, 0.6, max(st.r, ahead.r)))
        .mul(float(1).sub(wideAt.mul(0.67)));
    }
    // A FLASK (the tube widens well past a pipe) is a RESERVOIR: it never drains dry as a slug passes, it holds
    // most of a fill and brightens when a slug arrives (the lab showed flasks blinking full↔empty every second).
    const wide = smoothstep(R.mul(2.0), R.mul(3.4), radiusPx);
    const pipeLiquid = smoothstep(float(0.06), float(0.55), phi);
    const liquid = mix(pipeLiquid, float(0.62).add(pipeLiquid.mul(0.38)), wide);
    // Streaks, patches and flares ride the same broken-up lookup, so none of them runs straight across a flask either.
    const along = sState.mul(lengthPx).sub(travel);
    // COLOUR DRIFT (round 3 — "a better and more unpredictable colour range"): the body is never quite one
    // reagent. A slow, long noise riding the flow nudges the palette position up to ±0.4 of a step, so a slug
    // mottles toward its neighbouring reagents in patches several pipe-widths long — more with Variety, none at 0.
    const drift = mx_noise_float(vec3(along.div(R.mul(34)), g.mul(0.21).add(3.3), tSec.mul(0.07)))
      .mul(0.8)
      .mul(uVariety);
    const base = paletteAt(g.add(drift));
    return {
      inside,
      gate,
      s,
      across,
      radiusPx,
      th,
      phi,
      g,
      energy,
      froth,
      front,
      react,
      along,
      liquid,
      base,
      agitation,
      lengthPx,
      travel,
      wide,
      mood,
    };
  }

  const F = fields();

  // ── EMIT (ADD) ───────────────────────────────────────────────────────────
  const emitNode = Fn(() => {
    // Off the tubes: one mask read and out — the noise below runs only where there is goo.
    Discard(F.inside.lessThan(0.003));
    const { th, across, liquid, base, energy, froth, along } = F;

    // Deep at the walls, hot down the centreline; energy pushes the core toward white-hot.
    // Deep and saturated at the glass, the reagent's own colour through the body, white-hot only where energy
    // runs high (a front, a pulse) — the first pass mixed toward white everywhere and read as pastel.
    const hot = mix(base.mul(1.3), vec3(1, 1, 1), clamp(float(0.04).add(energy.mul(0.4)), 0, 0.85));
    const deep = base.mul(base).mul(0.6);

    let flowMod = float(1);
    let streak = float(0.6);
    let filament = float(0);
    if (plan.structureEnabled) {
      // LONG STREAKS riding the flow (low frequency along, high across), warped by a finer turbulence that
      // also rides it — together they read as liquid RUSHING, and stop when it stops. Where the turbulence
      // crosses zero, a thin bright FILAMENT: the streaks of light a magic potion is drawn with.
      const n1 = mx_noise_float(vec3(along.div(R.mul(7.5)), across.mul(3.4), tSec.mul(0.22)));
      const n2 = mx_noise_float(vec3(along.div(R.mul(2.1)), across.mul(6.5).add(n1.mul(1.4)), tSec.mul(0.65)));
      streak = clamp(float(0.55).add(n1.mul(0.5)).add(n2.mul(0.38)), 0, 1.4);
      flowMod = mix(float(1), float(0.3).add(streak), uStructure);
      filament = pow(clamp(float(1).sub(abs(n2).mul(3.2)), 0, 1), float(3)).mul(uStructure);
    }
    const coreMix = clamp(th.mul(th).mul(float(0.45).add(streak.mul(0.35))), 0, 1);
    const col = mix(deep, base, coreMix);
    // The body stays DARKER than its highlights: a uniformly bright tube reads as neon, not as a potion with
    // light moving inside it (iteration 3 in the lab).
    const body = liquid
      .mul(float(0.18).add(th.mul(0.55)))
      .mul(flowMod)
      .mul(float(1).add(energy.mul(0.85)))
      .mul(F.mood);
    // ONLY A LITTLE OF IT BURNS AT ONCE (2026-11-04). The author: "I'm happy for only a small amount to be bright
    // and self illuminated at a time to help create contrast. More dynamic and unpredictable changes would be
    // nice." The goo's resting state is a DIM coloured liquid; `lit` says where it burns right now:
    //   - slow PATCHES riding the flow (about a quarter of the pipe at any moment),
    //   - FLARES: every stretch of pipe (cells ~18 pipe radii long, riding the flow) rolls its own dice on its own
    //     clock and now and then swells into a bright knot and fades (a ~1.5 s swell, never a strobe) — more often
    //     with Reactions and while the tube is agitated, so the apparatus is never doing the same thing twice;
    //   - whatever the reactions carry: energy waves, slug fronts, reacting seams.
    //
    // ROUND 3 (2026-11-04 — "too bright in all places at once ... less bright sections"): the round-2 layers each
    // covered a fair share and together lit ~28% of the tube on average (peaks 52%, the lab meter). Patches are now
    // rare (~8%), flares half as frequent, and the always-on layers (filaments, swirl, bubbles, motes) only burn
    // where `lit` is — the dim body is where most of the goo now rests.
    const patch = smoothstep(
      float(0.46),
      float(0.7),
      mx_noise_float(vec3(along.div(R.mul(26)), F.g.mul(0.37), tSec.mul(0.09)))
    );
    const fc = along.div(R.mul(18));
    const fCell = floor(fc);
    const fClock = tSec.div(3.1).add(cellHash(vec2(fCell, 3.7)).mul(5));
    const fRoll = cellHash(vec2(fCell, floor(fClock)));
    const fRate = float(0.025).add(uChaos.mul(0.07)).add(F.agitation.mul(0.1));
    const fOn = smoothstep(float(1).sub(fRate), float(1).sub(fRate).add(0.02), fRoll);
    const fEnv = pow(sin(fract(fClock).mul(Math.PI)), float(2));
    const fd = fract(fc).sub(0.5);
    const flare = fOn.mul(fEnv).mul(exp(fd.mul(fd).div(0.05).negate()));
    // Patches and flares are noise over `along`, which is nearly CONSTANT across a flask (the skeleton crosses it
    // in a short stretch) — so in a flask they switched the whole disk on at once (round 3: a flask burned edge to
    // edge in cyan). They count a quarter there; a flask's own light is its 2-D swirl crest below.
    const flowLit = patch
      .mul(0.75)
      .add(flare.mul(1.4))
      .mul(float(1).sub(F.wide.mul(0.75)));
    const lit = clamp(
      flowLit
        // Only a real wave lights it (a pulse, a front, a catalyst's kick reach 1+); the tube-wide simmer of a
        // fizz or a boil (~0.4) stays below the line — that simmer lit whole pipes at once in round 2.
        .add(max(energy.sub(0.5), float(0)).mul(0.8))
        .add(F.front)
        .add(F.react),
      0,
      1.6
    );
    const glowAmt = mix(float(FLUID_DIM_BODY), float(1), lit);
    const out = col.mul(body).mul(glowAmt).toVar();
    // Filaments carry a hint of the NEXT reagent — a potion is never quite one colour.
    const filCol = mix(hot, paletteAt(F.g.add(1)).mul(1.4), uVariety.mul(0.35));
    out.addAssign(
      filCol
        .mul(filament)
        .mul(liquid)
        .mul(th)
        .mul(1.25)
        .mul(float(0.07).add(lit.mul(0.93)))
    );
    // A thin hot thread down the centreline, where the light path through the goo is longest.
    out.addAssign(
      hot
        .mul(liquid)
        .mul(pow(th, float(8)))
        .mul(0.32)
        .mul(lit)
    );

    // The FRONTS: a foaming meniscus where a slug arrives, a white-hot seam where two reagents react.
    out.addAssign(hot.mul(F.front).mul(1.4));
    out.addAssign(
      mix(hot, vec3(1, 1, 1), 0.55)
        .mul(F.react)
        .mul(1.6)
    );

    // FLASKS — where the tube widens well past a pipe: swirl and boil.
    if (plan.structureEnabled) {
      const wide = F.wide;
      If(wide.greaterThan(0.01), () => {
        const p = uv().mul(itemSize).div(R.mul(2.4));
        const q = vec2(
          mx_noise_float(vec3(p.mul(0.55), tSec.mul(0.11))),
          mx_noise_float(vec3(p.mul(0.55).add(5.2), tSec.mul(0.13).add(3.1)))
        );
        const sw = mx_noise_float(vec3(p.add(q.mul(1.9)), tSec.mul(0.32)));
        const sw2 = mx_noise_float(vec3(p.mul(1.7).add(q.mul(2.6)).add(11.3), tSec.mul(0.45)));
        // Bright VEINS where the second swirl crosses zero, over a deep body marbled with the next reagent.
        const veins = pow(clamp(float(1).sub(abs(sw2).mul(3.5)), 0, 1), float(3));
        const nextC = paletteAt(F.g.add(1));
        const swirlCol = mix(base, nextC, clamp(sw.mul(0.7).add(0.15), 0, 0.85).mul(uVariety));
        // A flask burns in swirling regions of its own (round 3: only the crest of the swirl, not a third of it), as
        // well as wherever the pipe's `lit` reaches it; its veins burn only there.
        const flaskLit = max(lit, smoothstep(float(0.55), float(0.85), sw.add(sw2.mul(0.5))));
        const swirled = mix(deep, swirlCol.mul(1.1), clamp(sw.mul(0.45).add(0.35), 0, 1)).add(
          hot.mul(veins).mul(float(0.12).add(flaskLit.mul(0.68)))
        );
        const flaskBody = swirled
          .mul(liquid)
          .mul(float(0.24).add(th.mul(0.4)))
          .mul(float(1).add(energy.mul(0.9)))
          .mul(mix(float(FLUID_DIM_BODY * 1.4), float(1), flaskLit));
        out.assign(mix(out, flaskBody, wide.mul(uStructure)));
        if (plan.bubblesEnabled) {
          // BOILING: cells that appear, swell and pop as the time axis moves through them — faster when agitated.
          const bc = vec3(p.mul(1.1), tSec.mul(float(0.35).add(F.agitation.mul(1.3))));
          const br = float(0.03).add(F.agitation.mul(0.05));
          const { ring } = organicBubbles(bc, br);
          out.addAssign(
            hot
              .mul(ring)
              .mul(wide)
              .mul(liquid)
              .mul(uBubbles)
              .mul(float(0.12).add(F.agitation.mul(1.6)))
          );
        }
      });
    }

    if (plan.bubblesEnabled) {
      // BUBBLES riding faster than the liquid (gas slips forward): bright rims, hollow cores.
      const bAlong = F.s.mul(F.lengthPx).sub(F.travel.mul(1.32));
      const bc = vec3(bAlong.div(R.mul(2.6)), across.mul(1.0), tSec.mul(0.12));
      const presence = smoothstep(
        float(0.3).sub(froth.mul(0.7)).sub(F.agitation.mul(0.3)),
        float(0.65),
        mx_noise_float(vec3(bc.xy.mul(0.3), 7.3)).add(0.5)
      );
      const br = float(0.05).add(froth.mul(0.08));
      const { ring, hollow } = organicBubbles(bc, br);
      const amt = uBubbles.mul(liquid).mul(presence).mul(th.mul(0.6).add(0.4));
      // Rims catch the light only where the goo burns (round 3); in the dim body they are faint glints.
      out.addAssign(
        hot
          .mul(ring)
          .mul(amt)
          .mul(float(0.3).add(lit.mul(1.2)))
      );
      out.assign(out.mul(float(1).sub(hollow.mul(amt).mul(0.5))));

      // MOTES — magic sparkles carried a little slower than the goo, each twinkling on its own clock (0.4-1.5 Hz).
      const mAlong = F.s.mul(F.lengthPx).sub(F.travel.mul(0.55));
      const cellUv = vec2(mAlong.div(R.mul(1.4)), across.mul(1.6));
      const cell = floor(cellUv);
      const local = fract(cellUv);
      const h1 = cellHash(cell);
      const h2 = cellHash(cell.add(vec2(17.3, 41.9)));
      const centre = vec2(float(0.2).add(h1.mul(0.6)), float(0.2).add(h2.mul(0.6)));
      const d = length(local.sub(centre));
      const spot = float(1).sub(smoothstep(float(0.04), float(0.17), d));
      const phase = fract(h2.mul(7.31).add(tSec.mul(float(0.4).add(h1.mul(1.1)))));
      const twinkle = pow(clamp(float(1).sub(abs(phase.mul(2).sub(1))), 0, 1), float(5));
      // Capped: a fizz once drove this to ~1, a sparkle in EVERY cell of the tube (34% of it over the line).
      const density = min(float(0.06).add(froth.mul(0.22)).add(F.agitation.mul(0.12)), float(0.38));
      const present = smoothstep(float(1).sub(density), float(1).sub(density).add(0.04), h1);
      out.addAssign(
        mix(hot, vec3(1, 1, 1), 0.6).mul(spot.mul(twinkle).mul(present).mul(liquid).mul(uSparkle).mul(4.5))
      );
    }

    if (plan.filmEnabled) {
      // THE GLASS SHEEN — a thin film on the rim only, banded by thickness, drifting slowly.
      const rim = smoothstep(float(0.72), float(0.98), across);
      const phase = th.mul(9).add(F.s.mul(2)).add(tSec.mul(0.35));
      const film = vec3(
        sin(phase).mul(0.5).add(0.5),
        sin(phase.add(2.1)).mul(0.5).add(0.5),
        sin(phase.add(4.2)).mul(0.5).add(0.5)
      );
      out.addAssign(film.mul(rim).mul(uIridescence).mul(0.35));
      // An empty stretch keeps a faint coat of its last reagent on the glass.
      out.addAssign(base.mul(float(1).sub(liquid)).mul(rim).mul(0.06));
    }

    return vec4(out.mul(uGlow).mul(F.inside).mul(F.gate).mul(uOpacity).mul(uFadeMul), 1);
  });

  // ── ABSORB (MULTIPLY) — Beer–Lambert by the reagent's own colour ──────────
  const absorbNode = Fn(() => {
    Discard(F.inside.lessThan(0.003));
    const hue = log(max(F.base, vec3(2e-3, 2e-3, 2e-3))).negate();
    const meanHue = max(dot(hue, vec3(1 / 3, 1 / 3, 1 / 3)), float(1e-4));
    // Plus a little NEUTRAL murk (round 3): normalised by its own mean, a light reagent (a sky blue) let green and
    // blue through untouched, and a flask of it over the pale painted glass read milky white, not as potion.
    const sigma = hue.div(meanHue).mul(float(FLUID_ABSORPTION_STRENGTH)).add(0.35);
    // A flask is many pipe-widths deep: its light path, and so its absorption, is longer.
    const depth = F.th
      .mul(F.liquid)
      .mul(float(1).add(F.wide.mul(0.9)))
      .mul(F.inside)
      .mul(F.gate)
      .mul(uOpacity)
      .mul(uFadeMul);
    return vec4(exp(sigma.negate().mul(depth)), 1);
  });

  function configureShared(material) {
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    // A negative scale (Foundry's flip) reverses winding; FrontSide would cull it invisibly.
    material.side = THREE.DoubleSide;
    material.toneMapped = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // Destination alpha is coverage, not a statement either pass makes: Zero·src + One·dst leaves it alone.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }

  const absorbMaterial = new THREE.NodeMaterial();
  absorbMaterial.colorNode = absorbNode();
  configureShared(absorbMaterial);
  absorbMaterial.blendSrc = THREE.ZeroFactor;
  absorbMaterial.blendDst = THREE.SrcColorFactor;

  const emitMaterial = new THREE.NodeMaterial();
  emitMaterial.colorNode = emitNode();
  configureShared(emitMaterial);
  emitMaterial.blendSrc = THREE.OneFactor;
  emitMaterial.blendDst = THREE.OneFactor;

  return {
    absorbMaterial,
    emitMaterial,
    maskTexNode,
    packTexNode,
    // EVERY sample of the ping-ponged state, in both materials (two each), so the tick re-points them all.
    stateTexNodes,
    tier: plan.tier,
    uniforms: {
      uTint,
      uAccent,
      uPal,
      uPalCount,
      uVariety,
      uGlow,
      uIridescence,
      uOpacity,
      uFadeMul,
      uFlowSpeed,
      uStructure,
      uBubbles,
      uSparkle,
      uChaos,
    },
  };
}
