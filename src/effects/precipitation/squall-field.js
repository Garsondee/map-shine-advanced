/**
 * THE SQUALL FIELD — one banded field, three consumers (Precipitation.md §3.4).
 *
 * ============================================================================
 * ⭐ ONE FIELD, NOT ONE PER CONSUMER — THAT IS THE WHOLE POINT
 * ============================================================================
 *
 * §3.4 gives the curtain three jobs, and the second is the load-bearing one:
 *
 *   *"The SAME field value scales specimen spawn density at each (x, y) — so
 *   the bands are visible in the bodies when zoomed in and in the veil when
 *   zoomed out. One field, two consumers, no fork."*
 *
 * So this module exists rather than the expression living inside the curtain's
 * material. Three things read it:
 *
 *   1. **the curtain's alpha** (§3.4 job 1 — the distance stand-in),
 *   2. **the falling bodies' visibility** (§3.4 job 2 — the same bands, in the
 *      specimens, when you zoom in),
 *   3. **the splash rate** (§4.1's `rate ∝ precip01 × skyReach × squallField`,
 *      whose third factor P2 deliberately left missing rather than faking with
 *      a private noise).
 *
 * If those three ever drift apart, a downpour shows a dense band of drops
 * falling through a thin patch of veil onto dry-looking stone, which is worse
 * than having no bands at all.
 *
 * ============================================================================
 * ⭐ THE FRONTS ARE THE WIND'S OWN, NOT A SECOND IDEA OF GUSTINESS
 * ============================================================================
 *
 * The travelling half of this field IS `world/wind-field.js#computeGustEnvelope`
 * — the same function the vegetation bends to and the gust particles ride,
 * sampled at a coarser scale. §3.4 is explicit: *"Squalls are therefore the
 * same events the bodies and the vegetation respond to, at a larger wavelength
 * — never a second, private idea of gustiness."*
 *
 * ⚠️ AND IT NEEDED A 90° CORRECTION TO GET THERE, which is a real finding
 * rather than a fudge. The two zones disagree about what `directionDeg` means
 * as a vector:
 *
 * ```
 *   world/wind-field.js   flow      = −(cos θ, sin θ)      … θ=0 ⇒ WEST
 *   effects/precipitation windToward = ( −sin θ, cos θ)     … θ=0 ⇒ SOUTH
 * ```
 *
 * Both are "correct" for their own consumers because each was calibrated
 * separately against the map — precipitation's was fixed live by the author
 * after being wrong twice, and the wind field's own consumers were tuned
 * against theirs. That is `feedback_shared_field_two_meanings_two_registries`
 * wearing a compass, and the real repair (one exported helper every consumer
 * calls) is filed against `wind-field.js` because it would retune shipped
 * looks.
 *
 * What CANNOT wait is this field: `computeGustEnvelope`'s own comment says a
 * front travelling at an angle to the wind it modulates *"would read as two
 * unrelated weather systems"* — and 90° is the most visible angle there is.
 * So {@link gustDirectionForPrecip} pre-rotates the angle handed to it, and
 * the rotation is DERIVED (`−(cos(θ−90), sin(θ−90)) = (−sin θ, cos θ)`) and
 * pinned by a Node assertion, never eyeballed.
 *
 * ============================================================================
 * THE TWO ENGINEERING TRAPS, VERBATIM FROM THE WIND RESEARCH
 * ============================================================================
 *
 * §3.4 names them and they are obeyed here:
 *
 *  1. **Never animate the field's SCALE.** A scale that breathes reads as the
 *     world sliding, not as weather. Every frequency below is a module
 *     constant; nothing multiplies them by an axis. (`computeGustEnvelope`
 *     does ramp its own frequency with wind speed — that is its own long-argued
 *     lever and it is shared, not a second opinion introduced here.)
 *  2. **Never let per-band UV offsets advect independently.** There is ONE
 *     advection term, applied to the whole cell coordinate before any octave is
 *     taken. Independent offsets decorrelate and never resync.
 *
 * @module effects/precipitation/squall-field
 */
import { computeGustEnvelope } from '../../world/index.js';

/**
 * How much coarser the gust envelope is sampled for the curtain than for a
 * blade of grass — §3.4's *"at a larger wavelength"*.
 *
 * A gust front that makes a bush shiver is metres across; a squall band that
 * makes a courtyard grey is tens of them. Dividing the sample position widens
 * the pattern by exactly this factor, which also widens the travel (the
 * advection term is unscaled), so a big front crosses the map fast — which is
 * what big fronts do.
 */
export const CURTAIN_GUST_SCALE = 0.11;

/**
 * The slow "weather cell" — one octave, deliberately. §3.4 asks for *"one slow
 * large-scale weather cell noise of its own"*, and one is the number: a second
 * octave at a coarse scale is indistinguishable from the first at this
 * amplitude, and a second at a fine scale reintroduces the sub-pixel detail the
 * curtain exists to replace.
 *
 * ⚠️ MEASURED, NOT GUESSED, AND THE FIRST VALUE WAS 5× TOO COARSE. `0.00021`
 * is a ~4,800 px wavelength across the wind and ~26,000 px along it — wider
 * than most maps, so the whole "banded" field measured as a smooth 5% GRADIENT
 * across the frame with no bands in it at all. Correct arithmetic, invisible
 * phenomenon. At `0.0011` a band is ~900 px across (nine grid squares) and
 * ~5,000 px long, so a normal view holds three to six of them, which is what
 * "squall bands" has to mean to be worth having.
 */
export const CELL_FREQ = 0.0011;

/**
 * How far the cell pattern is stretched ALONG the wind, as a divisor on the
 * along-wind coordinate. Bands are long and thin because weather arrives in
 * lines, not in blobs; an isotropic cell noise reads as fog patches.
 */
export const CELL_ANISOTROPY = 5.5;

/** World px/s the cell pattern drifts downwind at full gale. Slow: this is the
 * WEATHER moving, not the wind. */
export const CELL_DRIFT_PX_PER_SEC = 46;

/**
 * How deep the bands cut. 0 = a flat field (no bands at all), 1 = bands that
 * reach zero between them.
 *
 * ⚠️ DELIBERATELY SHORT OF 1. A field that reaches zero produces gaps of
 * literally no rain, and a downpour with holes in it reads as a broken effect
 * rather than as a squall. The lull is thin weather, not clear sky.
 *
 * ⚠️ RAISED FROM 0.55 AFTER MEASUREMENT. The bench reads peak-to-trough
 * contrast across the bands as ~27% at depth 1 and ~9% at 0.55 — and 9% is a
 * variation you can measure but not really see, which is the worst place for a
 * default to sit: the feature is present, costs its full price, and reads as
 * absent. 0.8 lands near 22% with room in the dial in both directions.
 */
export const BAND_DEPTH = 0.8;

/**
 * ⭐ HOW DEEPLY THE CELL MODULATES — and the KEY here is that it modulates
 * rather than multiplies.
 *
 * ⚠️ THE FIRST CUT MULTIPLIED THE RAW `cell01` (a 0..1 noise, mean 0.5)
 * STRAIGHT INTO THE FIELD, so even at full precipitation the veil averaged HALF
 * strength everywhere and never reached full anywhere — a downpour that could
 * not look like one. Multiplying by a zero-mean-ish noise dims; MIXING toward 1
 * modulates. `mix(1 − contrast, 1, cell01)` peaks at exactly 1 inside a band
 * and bottoms at `1 − contrast` between them, which is the same shape
 * `computeGustEnvelope` already returns and therefore composes with it cleanly.
 */
export const CELL_CONTRAST = 0.85;

/**
 * ⭐ THE 90° RECONCILIATION — what angle to hand `computeGustEnvelope` so its
 * fronts travel the way precipitation actually falls.
 *
 * DERIVED, not tuned. `computeGustEnvelope` builds `flow = −(cos θ′, sin θ′)`;
 * precipitation drives along `(−sin θ, cos θ)`. Setting them equal:
 *
 * ```
 *   −cos θ′ = −sin θ   ⇒  cos θ′ =  sin θ
 *   −sin θ′ =  cos θ   ⇒  sin θ′ = −cos θ
 *   ⇒ θ′ = θ − 90°
 * ```
 *
 * Pinned in Node against pure twins of BOTH conventions, because a compass
 * error here is invisible in code review and obvious on a map — and this
 * project has paid for that twice already in this very effect.
 *
 * @param {number} directionDeg - meteorological, as the wind handle reports it.
 * @returns {number} the angle to pass to `computeGustEnvelope`.
 */
export function gustDirectionForPrecip(directionDeg) {
  return (Number(directionDeg) || 0) - 90;
}

/**
 * CPU twin of `world/wind-field.js`'s internal flow vector. Exists ONLY so
 * {@link gustDirectionForPrecip}'s derivation is checkable in Node — nothing
 * renders with it.
 * @param {number} deg @returns {{x: number, y: number}}
 */
export function windFieldFlowVector(deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  return { x: -Math.cos(r), y: -Math.sin(r) };
}

/**
 * Build the squall field as a TSL node in 0..1.
 *
 * ⚠️ TAKES `TSL` AND NODES, RETURNS A NODE — no uniforms of its own, no state,
 * no clock. Every consumer already owns a world position and the wind
 * uniforms; a module that held its OWN copies would be a fourth place the wind
 * could go stale, which is exactly the bug the fall runtime already fixed once
 * (*"wind doesn't seem to affect it at all"*).
 *
 * @param {object} TSL
 * @param {object} inputs
 * @param {*} inputs.worldXY - vec2 node, world px.
 * @param {*} inputs.timeMs - float node.
 * @param {*} inputs.directionDeg - float node, METEOROLOGICAL. Rotated here.
 * @param {*} inputs.speed01 - float node.
 * @param {*} inputs.gustiness01 - float node.
 * @param {*} [inputs.bandDepth] - float node overriding {@link BAND_DEPTH}.
 * @param {*} [inputs.scale] - float node; multiplies the sample position, so
 *   values BELOW 1 make bands WIDER. A static authoring dial, not an animated
 *   one — trap 1 forbids a scale that breathes, not a scale that is chosen.
 * @returns {*} float node, 0..1. **1 means "full weather here"**, not "a gust".
 */
export function buildSquallField(
  TSL,
  { worldXY: rawXY, timeMs, directionDeg, speed01, gustiness01, bandDepth = null, scale = null }
) {
  const { float, vec2, mx_noise_float: perlin, mix, sin, cos, clamp } = TSL;
  // ONE scaling, applied before anything reads a position — so the gust half
  // and the cell half stay locked to each other at every setting. Scaling them
  // independently is trap 2 wearing a dial.
  const worldXY = scale ? rawXY.mul(scale) : rawXY;

  // ⭐ THE SAME FRONTS THE VEGETATION BENDS TO, at curtain scale and rotated
  // into precipitation's compass — see this module's header for the derivation.
  const gustDeg = directionDeg.sub(float(90));
  const gust = computeGustEnvelope(TSL, {
    centerXY: worldXY.mul(float(CURTAIN_GUST_SCALE)),
    time: timeMs,
    directionDeg: gustDeg,
    gustiness01,
    speed01,
  });

  // ── THE SLOW WEATHER CELL ──
  // Precipitation's own drive direction, in this zone's convention. Written out
  // rather than imported from the runtime because that copy is a local arrow
  // inside a factory; both are the same rule and the CPU twin
  // (`precip-species.js#windTowardVector`) pins it for all four cardinals.
  const rad = directionDeg.mul(float(Math.PI / 180));
  const toward = vec2(sin(rad).negate(), cos(rad));
  const across = vec2(toward.y.negate(), toward.x);

  // ⚠️ ONE ADVECTION TERM, applied to the coordinate BEFORE the octave is
  // taken — trap 2. Independent per-band offsets decorrelate and never resync.
  const t = timeMs.mul(float(0.001));
  const drift = t.mul(float(CELL_DRIFT_PX_PER_SEC)).mul(speed01);
  const alongRaw = worldXY.x.mul(toward.x).add(worldXY.y.mul(toward.y)).sub(drift);
  const acrossRaw = worldXY.x.mul(across.x).add(worldXY.y.mul(across.y));

  // ⚠️ THE FREQUENCIES ARE CONSTANTS — trap 1. Nothing here multiplies them by
  // an axis: a scale that breathes reads as the world sliding rather than as
  // weather changing.
  const cellN = perlin(vec2(alongRaw.mul(float(CELL_FREQ / CELL_ANISOTROPY)), acrossRaw.mul(float(CELL_FREQ))));
  const cell01 = cellN.mul(float(0.5)).add(float(0.5));
  // MODULATE, never multiply — peaks at 1 inside a band, bottoms at
  // `1 − CELL_CONTRAST` between them. See CELL_CONTRAST for the bug this fixed.
  const cellTerm = mix(float(1 - CELL_CONTRAST), float(1), cell01);

  // The two factors compose: a band exists where the slow cell says "weather
  // here" AND the fast front is not in its lull. `gust` already returns 1 when
  // `gustiness01` is 0, so a still day yields the cell alone rather than a flat
  // field — the bands survive calm, they just stop travelling. Both terms peak
  // at 1, so a body of weather in a band gets the FULL strength its axes asked
  // for rather than a fraction of it.
  const raw = clamp(cellTerm.mul(gust), float(0), float(1));

  // ⚠️ LERP FROM 1, NOT FROM 0. `mix(1, raw, depth)` at depth 0 is a CONSTANT 1
  // — full weather everywhere, i.e. exactly the un-banded behaviour every
  // consumer had before this field existed. That makes "no squall" the
  // identity rather than a value that merely happens to look unchanged, and it
  // is what lets the depth dial go to zero without anything going dark.
  const depth = bandDepth ?? float(BAND_DEPTH);
  return mix(float(1), raw, depth);
}
