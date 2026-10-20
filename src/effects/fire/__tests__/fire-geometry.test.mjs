/**
 * fire-geometry.test.mjs — THE PHYSICS, PINNED.
 *
 * Everything in `fire-geometry.js` is a total function over numbers, which is
 * the whole reason it exists as its own module: the fire's behaviour is a chain
 * of derivations off ONE authored diameter, and a chain is exactly the thing
 * that rots silently when nobody checks its links.
 *
 * Three blocks here are load-bearing rather than routine:
 *
 *  - THE SLICE TABLE IS TOP-FIRST. The camera is above the fire, so front-to-
 *    back compositing means the highest slice is composited first and occludes
 *    what is below. Emitting it bottom-up would put the smoke BEHIND the flame
 *    and no shader tuning would recover it. Asserted directly.
 *  - THE COVERAGE RUNG CANNOT OSCILLATE. A rung change is a material rebuild
 *    (N is a build-time constant — Law 4), so a fire parked on a boundary while
 *    the GM nudges the zoom would recompile every frame. The hysteresis is
 *    tested by driving it across a boundary and back.
 *  - THE PUFF LAW HOLDS ACROSS THREE ORDERS OF MAGNITUDE. It is used instead of
 *    a tuned constant precisely because it cannot be tuned wrong, which is only
 *    true while something checks it against the correlation it came from.
 */
import {
  fireScaleChain,
  firePuffPhase,
  firePuffEnvelope,
  fireSlabPlan,
  fireSliceTable,
  fireTierPlan,
  fireShearSeconds,
  fireCoveragePx,
  fireWeatherResponse,
  fireWindMotion01,
  fireWindParticleResponse,
  fireIndoorParticleResponse,
  resolveFireCoverageRung,
  clusterFireSources,
  buildFireLightSources,
  computeFireQuadArrays,
  fireGeometrySignature,
  fireQuadSizePx,
  hexToRgb01,
  fireRampStops,
  fireRuntimeFromParams,
  fireWindSuppressionFloors,
  fireOpennessGain01,
  fireLeanGain01,
  fireLeanProfile01,
  fireLeanOffsetPx,
  fireWeatherStress01,
  fireStressResponse,
  fireGutter01,
  fireFlameBrightness01,
  createFireBrightnessSmoother,
  FIRE_LIGHT_SMOOTHING_SEC,
  FIRE_LEAN,
  FIRE_STRESS,
  fireTintMul,
  FIRE_DEFAULT_TIER,
  FIRE_FUELS,
  FIRE_RAMP_WOOD,
} from '../fire-geometry.js';

/** Grid scale of the author's own test map: 100 px per 5 ft ≈ 1.524 m. */
const M_PER_PX = 1.524 / 100;

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * The weather the FLAME ENGINES are handed (`fireRuntimeFromParams`, from the representative fire's chain) in the shape
 * `buildFireLightSources` takes — the same three numbers, so a test cannot give the light weather the sprites don't see.
 */
const lightWeather = (fire, params, wind) => {
  const rt = fireRuntimeFromParams(params, fireScaleChain(fire.diameterPx, M_PER_PX), wind);
  return { windMotion01: rt.windMotion01, rain01: rt.rain01, stressGain: rt.stressGain };
};

export function run(t) {
  // ── THE SCALE CHAIN ────────────────────────────────────────────────────────

  {
    // Cetegen & Ahmed: f ≈ 1.5/√D. Checked at four sizes spanning 3 orders of
    // magnitude in diameter, against the correlation rather than against a
    // recorded output — a snapshot test here would pin a typo just as happily.
    //
    // ⚠️ THE PIXEL SIZES ARE NOT INTUITIVE, and getting them wrong is how the
    // first version of this test failed. At the author's own grid scale
    // (100 px per 5 ft), ONE PIXEL IS 15 mm — so a real candle flame, ~8 mm
    // across, is HALF A PIXEL. An "8 px flame" is a 12 cm fire: a lamp, not a
    // candle. This is exactly why fire starts at oil-lamp scale and the candle
    // stays its own effect with a hand-tuned VISUAL size — at real physical
    // scale a candle is sub-pixel and has no silhouette to draw.
    // ⚠️ THE SECOND CALIBRATION SURPRISE, and worth writing down because it
    // sets the range the whole effect has to cover. At 100 px per 5 ft, a
    // METRE is 66 px. So a real campfire is ~66 px, a bonfire ~200 px, and a
    // burning-building inferno ~660 px. An earlier version of this test called
    // 520 px a campfire — that is a SEVEN-AND-A-HALF-METRE fire, and its
    // measured 0.53 Hz puff was correct physics for a size nobody meant.
    // The authored range fire actually needs to serve on a typical map is
    // roughly 5–700 px, NOT the 30–5200 px the design sketch assumed.
    const cases = [
      { px: 0.5, label: 'candle wick — 8 mm, sub-pixel; the candle effect owns this' },
      { px: 5, label: 'oil lamp — 8 cm' },
      { px: 20, label: 'brazier — 30 cm' },
      { px: 66, label: 'campfire — 1 m' },
      { px: 200, label: 'bonfire — 3 m' },
      { px: 660, label: 'inferno — 10 m' },
    ];
    for (const c of cases) {
      const chain = fireScaleChain(c.px, M_PER_PX);
      const expect = 1.5 / Math.sqrt(c.px * M_PER_PX);
      t.ok(`puff law holds for a ${c.label}`, near(chain.puffHz, expect, 1e-6));
    }
    const wick = fireScaleChain(0.5, M_PER_PX);
    const lamp = fireScaleChain(5, M_PER_PX);
    const campfire = fireScaleChain(66, M_PER_PX);
    const inferno = fireScaleChain(660, M_PER_PX);
    // The anchors that make the law worth using instead of a tuned constant —
    // every one of these is a real measured number for a real fire that size.
    t.ok('a candle-scale flame puffs at ~17 Hz', wick.puffHz > 12 && wick.puffHz < 22);
    t.ok('a 1 m campfire puffs at ~1.5 Hz', campfire.puffHz > 1.3 && campfire.puffHz < 1.8);
    t.ok('a 10 m inferno puffs at ~0.5 Hz', inferno.puffHz > 0.35 && inferno.puffHz < 0.65);
    t.ok('bigger fires puff slower than smaller ones', inferno.puffHz < lamp.puffHz && lamp.puffHz < wick.puffHz);
  }

  {
    // The laminar→turbulent transition is the cue that sells scale, and every
    // silhouette term hangs off it. Monotonic in diameter, and it must actually
    // REACH both ends rather than hovering in the middle for every real size.
    const sizes = [4, 16, 64, 256, 1024, 4096];
    const turbs = sizes.map((px) => fireScaleChain(px, M_PER_PX).turb01);
    let monotonic = true;
    for (let i = 1; i < turbs.length; i++) if (turbs[i] < turbs[i - 1]) monotonic = false;
    t.ok('turbulence rises monotonically with size', monotonic);
    t.ok('a tiny flame is fully laminar', turbs[0] < 0.05);
    t.ok('a huge fire is fully turbulent', turbs.at(-1) > 0.95);

    // The derived silhouette terms must follow it in the right direction.
    const small = fireScaleChain(4, M_PER_PX);
    const big = fireScaleChain(5200, M_PER_PX);
    t.ok('a big fire billows harder', big.billowAmp > small.billowAmp);
    t.ok('a big fire has more lobes', big.lobeFreq > small.lobeFreq);
    t.ok('a big fire resolves more octaves', big.octaves > small.octaves);
    t.ok('a small flame is tall relative to its width', small.heightPx / small.diameterPx > 3);
    t.ok('a big fire is squat relative to its width', big.heightPx / big.diameterPx < 2);
    // Aggregate steadiness: many independent lobes average out.
    t.ok('a big fire flickers less than a candle', big.flickerAmp < small.flickerAmp);
    // A candle gutters in a breeze; a bonfire does not.
    t.ok('a big fire resists being blown out', big.snuffWind > small.snuffWind * 2);
  }

  {
    // mPerPx is not decoration: the same painted blob is a bonfire on one map
    // and a housefire on another, and the puff rate has to know.
    const coarse = fireScaleChain(500, 0.05);
    const fine = fireScaleChain(500, 0.005);
    t.ok('grid scale changes the derived physics', !near(coarse.puffHz, fine.puffHz, 0.01));
    t.ok('a coarser grid makes the same blob a bigger fire', coarse.diameterM > fine.diameterM);
  }

  {
    // Degenerate input must degrade to a fire that exists, never to NaN — a
    // NaN diameter would propagate through every derived term and out into the
    // vertex buffer, where it silently kills the whole batched draw.
    for (const bad of [0, -5, NaN, undefined, null, Infinity]) {
      const chain = fireScaleChain(bad, M_PER_PX);
      const finite = Object.values(chain).every((v) => typeof v !== 'number' || Number.isFinite(v));
      t.ok(`a ${String(bad)} diameter still yields finite physics`, finite);
    }
    const noGrid = fireScaleChain(100, 0);
    t.ok('a zero mPerPx falls back rather than dividing by zero', Number.isFinite(noGrid.puffHz));
  }

  {
    const fuels = Object.keys(FIRE_FUELS);
    t.ok(
      'every fuel preset resolves',
      fuels.every((f) => Number.isFinite(fireScaleChain(300, M_PER_PX, { fuel: f }).heightPx))
    );
    t.ok('an unknown fuel falls back to wood', fireScaleChain(300, M_PER_PX, { fuel: 'plasma' }).fuel === 'wood');
    const wood = fireScaleChain(300, M_PER_PX, { fuel: 'wood' });
    const oil = fireScaleChain(300, M_PER_PX, { fuel: 'oil' });
    t.ok('oil burns taller than wood', oil.heightPx > wood.heightPx);
    t.ok('oil is sootier than wood', oil.soot01 > wood.soot01);
    // ⚠️ THE FUEL DIFFERENCE LIVES IN DENSITY, NOT EXTENT — and checking the
    // wrong one is what caught the original single-`smoke01` bug. At 300 px
    // (4.6 m) the "how much of the plume is smoke" smoothstep has long since
    // saturated at 1 for EVERY fuel, so a clamped product hid the gain
    // entirely. `smokeDensity` is the opacity question and is allowed past 1.
    t.ok('every big fire is fully in the smoke regime', wood.smoke01 === 1 && oil.smoke01 === 1);
    t.ok('oil smokes THICKER than wood', oil.smokeDensity > wood.smokeDensity);
    t.ok('smoke density may exceed 1 for sooty fuels', oil.smokeDensity > 1);
    t.ok(
      'coal smokes less than wood',
      fireScaleChain(300, M_PER_PX, { fuel: 'coal' }).smokeDensity < wood.smokeDensity
    );
  }

  // ── THE SHARED CLOCK ───────────────────────────────────────────────────────

  {
    // THE LOCKSTEP GUARANTEE. The light and the flame flicker together because
    // both call this one function — so it must be deterministic and it must
    // separate neighbouring fires.
    const chain = fireScaleChain(520, M_PER_PX);
    const a = firePuffPhase(1234, chain.puffHz, 0.25);
    const b = firePuffPhase(1234, chain.puffHz, 0.25);
    t.ok('the puff phase is deterministic', a === b);
    t.ok('different seeds desync neighbouring fires', firePuffPhase(1234, chain.puffHz, 0.9) !== a);
    t.ok('the phase advances with time', firePuffPhase(2234, chain.puffHz, 0.25) > a);
    t.ok('a non-finite time does not produce NaN', Number.isFinite(firePuffPhase(NaN, chain.puffHz, 0)));
    t.ok('a zero puffHz does not divide by zero', Number.isFinite(firePuffPhase(1000, 0, 0)));
  }

  {
    // A fire must never go fully black between puffs — a light that reaches 0
    // reads as a bug, not as a flicker.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const v = firePuffEnvelope(i * 0.017, 0.45);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    t.ok('the envelope never reaches zero', min >= 0.12);
    t.ok('the envelope actually varies', max - min > 0.2);
    t.ok('a zero amplitude gives a steady light', near(firePuffEnvelope(0.3, 0), 1, 1e-9));
  }

  // ── THE SLICE TABLE ────────────────────────────────────────────────────────

  {
    const chain = fireScaleChain(520, M_PER_PX);
    const plan = fireSlabPlan(3, 3);
    const slices = fireSliceTable(plan, chain);

    t.ok('the slice table has N entries', slices.length === plan.N);

    // ⚠️ THE LOAD-BEARING INVARIANT. Index 0 is the HIGHEST slice, because the
    // camera is above and front-to-back compositing must start nearest. Get
    // this backwards and the smoke draws behind the flame.
    let descending = true;
    for (let i = 1; i < slices.length; i++) if (slices[i].hK >= slices[i - 1].hK) descending = false;
    t.ok('the slice table is emitted TOP FIRST (heights descend)', descending);
    t.ok('the first slice is the top of the plume', slices[0].hK > 0.5);
    t.ok('the last slice is at the fuel bed', slices.at(-1).hK < 0.5);

    // The radius profile has a kink: flame tapers to a tip, smoke spreads.
    const flame = slices.filter((s) => s.hK <= chain.flameFrac);
    const smoke = slices.filter((s) => s.hK > chain.flameFrac);
    t.ok('both regimes are present at N=10', flame.length > 0 && smoke.length > 0);
    // Within the flame, higher means narrower (it tapers).
    let tapers = true;
    for (let i = 1; i < flame.length; i++) if (flame[i - 1].radiusK > flame[i].radiusK) tapers = false;
    t.ok('the flame tapers toward its tip', tapers);
    // Within the smoke, higher means wider (it entrains air).
    let spreads = true;
    for (let i = 1; i < smoke.length; i++) if (smoke[i - 1].radiusK < smoke[i].radiusK) spreads = false;
    t.ok('the smoke column spreads as it rises', spreads);

    // ⚠️ THE BASE IS WELDED TO THE FUEL. Author-reported live 2026-08-08 —
    // *"the entire effect is parented to a single spot... fire shouldn't wobble
    // sideways like this."* The old spacing put the lowest slice at h = 0.05,
    // so it carried 5% of the wind shear; since the BRIGHT flame slices live in
    // the bottom third, the whole fire slid across the map with every gust.
    // A fire's root does not move. Ever.
    t.ok('the bottom slice sits at EXACTLY h = 0', slices.at(-1).hK === 0);
    t.ok('...so the base takes ZERO wind shear', slices.at(-1).shearK === 0);
    t.ok('the top slice reaches h = 1', slices[0].hK === 1);

    // Shear is QUADRATIC in height, not linear: a parcel leaving the fuel bed
    // is momentum-dominated and has barely begun to be pushed sideways.
    // Quadratic pins the base hard while leaving the top's lean intact.
    {
      const mid = slices.find((s) => Math.abs(s.hK - 0.5) < 0.06);
      t.ok('a mid-height slice exists to test the curve', !!mid);
      // Linear would give shear ≈ 0.5 at h = 0.5; quadratic gives ≈ 0.25.
      t.ok(
        `shear is quadratic, not linear (h≈${mid?.hK} → shear ${mid?.shearK})`,
        mid && mid.shearK < 0.35 && mid.shearK > 0.15
      );
      t.ok('shear still reaches full at the top', slices[0].shearK === 1);
    }

    t.ok('temperature falls with height', slices.at(-1).tempK > slices[0].tempK);
    t.ok(
      'nothing below the flame tip is smoke',
      flame.every((s) => s.smokeMix === 0)
    );
    t.ok(
      'something above the flame tip IS smoke',
      smoke.some((s) => s.smokeMix > 0)
    );
    t.ok('smoke occludes harder than flame', slices[0].absorbK > slices.at(-1).absorbK);
    t.ok('billow amplitude grows with height', slices[0].ampK > slices.at(-1).ampK);
    t.ok('edges soften with height', slices[0].softK > slices.at(-1).softK);

    // Sheet indices must address a sheet that exists, or the shader reads
    // undefined and the whole material fails to build.
    t.ok(
      'every sheet index is in range',
      slices.every((s) => s.sheetLo >= 0 && s.sheetLo < plan.M && s.sheetHi >= 0 && s.sheetHi < plan.M)
    );
    t.ok(
      'every sheet blend is a fraction',
      slices.every((s) => s.sheetBlend >= 0 && s.sheetBlend <= 1)
    );
    t.ok(
      'every slice value is finite',
      slices.every((s) => Object.values(s).every((v) => Number.isFinite(v)))
    );
  }

  {
    // N=1 must still produce a usable slice rather than a degenerate one — this
    // is the far-zoom-out rung and it is the one most likely to be reached and
    // least likely to be looked at.
    const chain = fireScaleChain(520, M_PER_PX);
    const slices = fireSliceTable(fireSlabPlan(3, 0), chain);
    t.ok('a single-slice plan yields exactly one slice', slices.length === 1);
    t.ok('the single slice sits inside the flame', slices[0].hK > 0 && slices[0].hK < chain.flameFrac);
    t.ok('the single slice is hot', slices[0].tempK > 0.3);
  }

  {
    // Sheets can never exceed slices: a sheet nothing reads is pure cost.
    for (let tier = 0; tier <= 5; tier++) {
      for (let rung = 0; rung <= 3; rung++) {
        const p = fireSlabPlan(tier, rung);
        t.ok(`M <= N at tier ${tier} rung ${rung}`, p.M <= p.N);
        t.ok(`N respects the tier cap at tier ${tier} rung ${rung}`, p.N <= fireTierPlan(tier).maxSlices);
      }
    }
  }

  {
    // The variant key IS the material cache key — anything that changes the
    // compiled graph must change it, or a stale pipeline is reused for a
    // different shape and the failure is a wrong picture, not a crash.
    t.ok('a different tier is a different key', fireSlabPlan(2, 3).key !== fireSlabPlan(3, 3).key);
    t.ok('a different coverage rung is a different key', fireSlabPlan(3, 1).key !== fireSlabPlan(3, 3).key);
    t.ok('the same shape is the same key', fireSlabPlan(3, 3).key === fireSlabPlan(3, 3).key);
  }

  // ── THE SHEAR ──────────────────────────────────────────────────────────────

  {
    // Downwind offset = wind × time-of-flight, and time-of-flight = height /
    // riseSpeed. Nothing tunable in between, which is the point.
    const chain = fireScaleChain(520, M_PER_PX);
    const top = fireShearSeconds(1, chain.heightPx, chain.riseSpeedPx);
    const mid = fireShearSeconds(0.5, chain.heightPx, chain.riseSpeedPx);
    t.ok('shear is zero at the fuel bed', fireShearSeconds(0, chain.heightPx, chain.riseSpeedPx) === 0);
    t.ok('shear grows with height', top > mid && mid > 0);
    t.ok('shear is linear in height', near(top / 2, mid, 1e-9));
    // A faster-rising plume has LESS time to be pushed sideways.
    const slowRise = fireShearSeconds(1, chain.heightPx, chain.riseSpeedPx / 2);
    t.ok('a slower rise shears further', slowRise > top);
    t.ok('a zero rise speed does not divide by zero', Number.isFinite(fireShearSeconds(1, 100, 0)));
  }

  // ── COVERAGE AND HYSTERESIS ────────────────────────────────────────────────

  {
    t.ok('coverage grows with quad size', fireCoveragePx(400, 1) > fireCoveragePx(200, 1));
    t.ok('zooming out shrinks coverage', fireCoveragePx(400, 4) < fireCoveragePx(400, 1));
    t.ok('a degenerate zoom does not divide by zero', Number.isFinite(fireCoveragePx(400, 0)));
  }

  {
    // ⚠️ THE ANTI-RECOMPILE TEST. Park a fire exactly on a boundary and jitter
    // it. Without hysteresis this flips rung every frame, and every flip is a
    // material rebuild.
    const EDGE = 16_000;
    let state = resolveFireCoverageRung(EDGE * 0.5, null, 0);
    const startRung = state.rung;
    let changes = 0;
    for (let i = 0; i < 200; i++) {
      // ±5% jitter straddling the edge, with time advancing well past dwell.
      const cov = EDGE * (1 + (i % 2 === 0 ? 0.05 : -0.05));
      state = resolveFireCoverageRung(cov, state, i * 1000);
      if (state.changed) changes++;
    }
    t.ok('jittering on a boundary does not oscillate the rung', changes <= 1);
    t.ok('a boundary-parked fire settles on one rung', state.rung === startRung || state.rung === startRung + 1);
  }

  {
    // A decisive move past the dead band MUST still be followed, or the gate is
    // just a way to ignore the camera.
    let state = resolveFireCoverageRung(100, null, 0);
    t.ok('a tiny fire starts at the cheapest rung', state.rung === 0);
    state = resolveFireCoverageRung(1_000_000, state, 5_000);
    t.ok('a decisive zoom-in does raise the rung', state.rung > 0);
    // One rung at a time, so a hard zoom walks the ladder instead of jumping it
    // and compiling the top variant from cold.
    t.ok('the rung climbs one step at a time', state.rung === 1);
    state = resolveFireCoverageRung(1_000_000, state, 10_000);
    t.ok('successive frames keep climbing', state.rung === 2);
  }

  {
    // Dwell: a change inside the window is refused even when coverage is
    // decisive, so a fast zoom costs one rebuild rather than four.
    let state = resolveFireCoverageRung(100, null, 0);
    state = resolveFireCoverageRung(1_000_000, state, 5_000);
    const afterFirst = state.rung;
    const tooSoon = resolveFireCoverageRung(1_000_000, state, 5_100);
    t.ok('a second change inside the dwell window is refused', tooSoon.rung === afterFirst);
    t.ok('the dwell timestamp is carried forward', tooSoon.sinceMs === state.sinceMs);
  }

  // ── WEATHER ────────────────────────────────────────────────────────────────

  {
    const chain = fireScaleChain(520, M_PER_PX);
    const dry = fireWeatherResponse(chain, { weather: { precip01: 0 }, wind: { speed01: 0 } }, 1);
    const rain = fireWeatherResponse(chain, { weather: { precip01: 1 }, wind: { speed01: 0 } }, 1);
    t.ok('rain cools the fire', rain.tempScale < dry.tempScale);
    t.ok('rain shortens the flame', rain.heightScale < dry.heightScale);
    t.ok('rain makes much more smoke', rain.smokeScale > dry.smokeScale);
    t.ok('rain whitens the smoke (steam)', rain.whiteness > dry.whiteness);

    // ⚠️ RAIN AND WIND HAVE SEPARATE GATES, and conflating them is what the
    // first version of this test did — it passed "fully sheltered" for rain
    // while leaving wind exposure at its default 1, which describes a covered
    // but open-sided space, then asserted the fire felt nothing. A SEALED room
    // is both gates at 0.
    const sealed = fireWeatherResponse(chain, { weather: { precip01: 1 }, wind: { speed01: 1 } }, 0, 0);
    t.ok('a sealed room ignores rain', near(sealed.tempScale, dry.tempScale, 1e-9));
    t.ok('a sealed room ignores wind', sealed.alive01 === 1);

    // The feature that separation exists for: "candles in a drafty castle"
    // (Wind.md §6) — indoors, no rain, and still pushed around by a draft.
    const drafty = fireWeatherResponse(chain, { weather: { precip01: 1 }, wind: { speed01: 0.3 } }, 0, 1);
    t.ok('a drafty indoor room takes no rain', near(drafty.smokeScale, dry.smokeScale, 1e-9));
    t.ok('...but the draft still reaches the fire', drafty.tempScale !== dry.tempScale);
  }

  {
    // Bellows below the threshold, blown out above it — and the threshold
    // scales with size, so the same gale that kills a lamp leaves a bonfire
    // burning. That asymmetry is the whole point of `snuffWind`.
    const lamp = fireScaleChain(30, M_PER_PX);
    const bonfire = fireScaleChain(2000, M_PER_PX);
    // A full gale — `windRaw` is `speed01 × 10 × exposure`, so this is the top
    // of the scale. The ASYMMETRY is the feature under test, not the absolute
    // threshold: one wind, two outcomes, decided only by size.
    const gale = { weather: { precip01: 0 }, wind: { speed01: 1 } };
    const lampR = fireWeatherResponse(lamp, gale, 1, 1);
    const bonfireR = fireWeatherResponse(bonfire, gale, 1, 1);
    t.ok('a full gale blows out a lamp', lampR.alive01 < 0.2);
    t.ok('the SAME gale leaves a bonfire burning', bonfireR.alive01 > 0.8);
    t.ok('the snuff threshold scales with fire size', bonfire.snuffWind > lamp.snuffWind);
    // Shelter is the other half: the same lamp behind a wall survives it.
    t.ok('a sheltered lamp survives the same gale', fireWeatherResponse(lamp, gale, 1, 0).alive01 === 1);

    const breeze = { weather: { precip01: 0 }, wind: { speed01: 0.12 } };
    const still = { weather: { precip01: 0 }, wind: { speed01: 0 } };
    t.ok(
      'a breeze makes a bonfire hotter (bellows)',
      fireWeatherResponse(bonfire, breeze, 1).tempScale > fireWeatherResponse(bonfire, still, 1).tempScale
    );
  }

  // ── CLUSTERING AND LIGHTS ──────────────────────────────────────────────────

  {
    const fires = [
      { id: 'a', x: 100, y: 100, diameterPx: 100, intensity: 1 },
      { id: 'b', x: 140, y: 120, diameterPx: 100, intensity: 1 },
      { id: 'c', x: 9000, y: 9000, diameterPx: 100, intensity: 1 },
    ];
    const clusters = clusterFireSources(fires, 500);
    t.ok('nearby fires merge and distant ones do not', clusters.length === 2);
    // Two 100 px fires burn as one ~141 px fire (√Σd²), never a 200 px one —
    // radiated power adds, diameter does not.
    const merged = clusters.find((c) => c.count === 2);
    t.ok('merged diameter combines in quadrature', near(merged.diameterPx, Math.sqrt(2) * 100, 1e-6));

    // Determinism: the light pool reuses meshes by sourceId, so an unstable id
    // silently rebuilds every light every frame.
    const again = clusterFireSources([...fires].reverse(), 500);
    t.ok('clustering is order-independent', JSON.stringify(clusters) === JSON.stringify(again));
  }

  {
    // Area-weighted centroid: a bonfire beside three embers puts the light on
    // the bonfire, not at the arithmetic middle of the four.
    const [c] = clusterFireSources(
      [
        { id: 'big', x: 0, y: 0, diameterPx: 1000, intensity: 1 },
        { id: 's1', x: 400, y: 0, diameterPx: 20, intensity: 1 },
        { id: 's2', x: 400, y: 40, diameterPx: 20, intensity: 1 },
      ],
      5000
    );
    t.ok('the centroid is pulled to the biggest fire', c.x < 40);
  }

  {
    const sources = [
      { id: 'a', x: 100, y: 100, diameterPx: 300, intensity: 1, elevation: 0, windExposure: 1 },
      { id: 'b', x: 5000, y: 5000, diameterPx: 300, intensity: 1, elevation: 20, windExposure: 1 },
    ];
    const lights = buildFireLightSources(sources, { tier: 3, mPerPx: M_PER_PX, tMs: 1000 });
    t.ok('every fire yields a light', lights.length >= 1);
    const l = lights[0];
    t.ok('the light id is stable and namespaced', l.sourceId.startsWith('fire:'));
    // ⚠️ Candle lights bill to nobody, which is exactly why their 13.1 ms went
    // unnoticed. Fire's radii are bigger; it does not get to repeat that.
    t.ok('the light is attributed to the fire effect', l.ownerEffectId === 'fire');
    t.ok('the light carries a real elevation', Number.isFinite(l.elevation));
    t.ok('the light has a wall-clippable polygon', Array.isArray(l.shapePoints) && l.shapePoints.length > 8);
    // `'inverseSquareWide'`, not candle/lightning's plain `'inverseSquare'`
    // (mythica-machina-press#475) — same shape, fire's own gentler steepness.
    t.ok("the light uses fire's own (wide) inverse-square falloff", l.falloffModel === 'inverseSquareWide');
    // ⚠️ NO LONGER ASSERTS `puffHz` (removed 2026-08-09, author: "adjust fire
    // light to work more like candle light"). The GPU animation is now
    // `candleFlicker`'s own wind-aware noise (registry.js), driven by
    // `quality`/`seed`/`windExposure`/`windResponse`, not a CPU-baked puff
    // law — see `buildFireLightSources`'s own header note.
    t.ok(
      'the light animation is the (now candle-shared) fire type, quality-tiered',
      l.animation.type === 'firePuff' && l.animation.quality >= 0 && l.animation.quality <= 2
    );
    t.ok('every light number is finite', [l.radius, l.luminosity01, l.alpha01].every(Number.isFinite));
    t.ok('luminosity stays in range', l.luminosity01 > 0 && l.luminosity01 <= 1);

    // The radius derives from size, never from a code default — the 600×
    // coverage term is not allowed to be a magic number.
    const small = buildFireLightSources([{ id: 's', x: 0, y: 0, diameterPx: 30, intensity: 1 }], {
      tier: 3,
      mPerPx: M_PER_PX,
    });
    const big = buildFireLightSources([{ id: 'b', x: 0, y: 0, diameterPx: 3000, intensity: 1 }], {
      tier: 3,
      mPerPx: M_PER_PX,
    });
    t.ok('a bigger fire lights further', big[0].radius > small[0].radius);
  }

  {
    // A lower tier must merge harder — this is the frame-budget lever and a
    // ladder that does not actually change the light count is decorative.
    const many = [];
    for (let i = 0; i < 40; i++)
      many.push({ id: `f${i}`, x: (i % 8) * 220, y: Math.floor(i / 8) * 220, diameterPx: 200, intensity: 1 });
    const cheap = buildFireLightSources(many, { tier: 0, mPerPx: M_PER_PX });
    const rich = buildFireLightSources(many, { tier: 5, mPerPx: M_PER_PX });
    t.ok('a cheap tier emits fewer lights than a rich one', cheap.length < rich.length);
    t.ok('even the cheapest tier still emits light', cheap.length >= 1);
  }

  {
    // ⚠️ REWRITTEN 2026-09-04, AGAIN 2026-10-20 (mmp-26u) — the light used to read its own wind curve (first a hard
    // threshold, then `lightMul`), so it could disagree arbitrarily with what the flame SPRITES were doing. It now takes
    // the weather the engines are handed (`lightWeather`) and follows the flames' own brightness.
    const fire = { id: 'x', x: 0, y: 0, diameterPx: 20, intensity: 1, windExposure: 1 };
    const calm = buildFireLightSources([fire], {
      tier: 3,
      mPerPx: M_PER_PX,
      weather: lightWeather(fire, {}, { speed01: 0 }),
    });
    const gale = buildFireLightSources([fire], {
      tier: 3,
      mPerPx: M_PER_PX,
      weather: lightWeather(fire, {}, { speed01: 1 }),
    });
    t.ok('a calm fire and a full-gale fire both still emit light', calm.length === 1 && gale.length === 1);
    t.ok(
      'a full gale dims the light well below the calm baseline',
      gale[0].luminosity01 < calm[0].luminosity01 && gale[0].alpha01 < calm[0].alpha01
    );

    // A fire the author has marked immune to being blown out must dim LESS
    // than one that can — matching the higher activeCount floor the SAME
    // param gives the particles (`FLAME_GUTTER_COUNT_FLOOR_IMMUNE`).
    const galeImmune = buildFireLightSources([fire], {
      tier: 3,
      mPerPx: M_PER_PX,
      weather: lightWeather(fire, { canBeSnuffed: false }, { speed01: 1 }),
    });
    t.ok(
      "canBeSnuffed:false dims the light less than a snuffable fire's identical gale",
      galeImmune[0].alpha01 > gale[0].alpha01
    );

    // weatherResponse:0 must leave the light exactly at its calm reading —
    // the SAME "ignores wind entirely" promise the particles now keep too.
    const ignoresWind = buildFireLightSources([fire], {
      tier: 3,
      mPerPx: M_PER_PX,
      weather: lightWeather(fire, { weatherResponse: 0 }, { speed01: 1 }),
    });
    t.ok(
      'weatherResponse01=0 leaves the light exactly at its calm reading regardless of wind speed',
      near(ignoresWind[0].luminosity01, calm[0].luminosity01, 1e-9) &&
        near(ignoresWind[0].alpha01, calm[0].alpha01, 1e-9)
    );
  }

  // ── THE BENT FLAME (2026-10-19) ────────────────────────────────────────────
  // Author, full wind and full rain: the flame was a string of detached blobs marching off in a line. The lean is
  // now a function of AGE, so these pin the properties that make a bent, continuous flame the only possible outcome.
  {
    t.ok(
      'no wind, no lean; full wind, full lean (the gain spans exactly 0..1)',
      fireLeanGain01(0) === 0 && near(fireLeanGain01(1), 1, 1e-12)
    );
    t.ok(
      'the lean gain is superlinear: half the wind gives well under half the lean',
      near(fireLeanGain01(0.5), (0.5 * (1 + FIRE_LEAN.gainK * 0.5)) / (1 + FIRE_LEAN.gainK), 1e-12) &&
        fireLeanGain01(0.5) < 0.5
    );
    let monotone = true;
    for (let i = 1; i <= 100; i++) if (!(fireLeanGain01(i / 100) > fireLeanGain01((i - 1) / 100))) monotone = false;
    t.ok('the lean gain rises strictly with the wind', monotone);
    t.ok('a non-finite wind reads as calm, never NaN', fireLeanGain01(NaN) === 0 && fireLeanGain01(undefined) === 0);

    t.ok(
      'a newborn sprite does not lean at all; the oldest leans the full length (age^curve spans exactly 0..1)',
      fireLeanProfile01(0, 1.4) === 0 && fireLeanProfile01(1, 1.4) === 1
    );
    t.ok(
      'curve 1 is a straight tilted pillar; curve 2 anchors the base harder (a cantilever)',
      near(fireLeanProfile01(0.5, 1), 0.5, 1e-12) && fireLeanProfile01(0.5, 2) < fireLeanProfile01(0.5, 1)
    );
    t.ok(
      'the push is weaker when a particle is new and stronger as it gets old: the offset never decreases with age',
      [1, 1.4, 2, 3].every((curve) => {
        let prev = -1;
        for (let i = 0; i <= 50; i++) {
          const o = fireLeanOffsetPx({ motion01: 1, age01: i / 50, sizePx: 100, lengthSizes: 2.2, curve });
          if (o < prev) return false;
          prev = o;
        }
        return true;
      })
    );
    t.ok(
      'the offset is in the sprite own size: twice the sprite, twice the lean',
      near(
        fireLeanOffsetPx({ motion01: 1, age01: 0.8, sizePx: 200, lengthSizes: 2, curve: 1.4 }),
        2 * fireLeanOffsetPx({ motion01: 1, age01: 0.8, sizePx: 100, lengthSizes: 2, curve: 1.4 }),
        1e-9
      )
    );
    t.ok(
      'a full gale on a 100 px sprite with the default length reaches 2.2 sprite-widths at the tip: bounded, never flung',
      near(
        fireLeanOffsetPx({ motion01: 1, age01: 1, sizePx: 100, lengthSizes: 3.7 * FIRE_LEAN.sizesPerPush, curve: 1.4 }),
        222,
        1e-9
      )
    );

    // THE REGRESSION THIS WHOLE BLOCK EXISTS FOR. One flame ARCHETYPE engine holds 56 sprites (224 / 4). Spread across
    // their ages, consecutive sprites must overlap along the lean: the widest gap between neighbours has to be a small
    // fraction of a sprite, however hard the wind blows. (A force-driven flame at the author settings put its few young
    // sprites hundreds of px apart: a string of separate blobs.)
    {
      const N = 56;
      const sizePx = 100;
      let widest = 0;
      for (const curve of [1, 1.4, 2, 3]) {
        let prev = 0;
        for (let i = 1; i <= N; i++) {
          const o = fireLeanOffsetPx({ motion01: 1, age01: i / N, sizePx, lengthSizes: 6, curve });
          widest = Math.max(widest, o - prev);
          prev = o;
        }
      }
      t.ok(
        `even 56 sprites at a long lean (6 sprite-sizes, any curve) leave no gap wider than half a sprite (widest ${widest.toFixed(1)} px of ${sizePx})`,
        widest < sizePx * 0.5
      );
      let widestDefault = 0;
      let prevDefault = 0;
      for (let i = 1; i <= N; i++) {
        const o = fireLeanOffsetPx({
          motion01: 1,
          age01: i / N,
          sizePx,
          lengthSizes: 3.7 * FIRE_LEAN.sizesPerPush,
          curve: 1.4,
        });
        widestDefault = Math.max(widestDefault, o - prevDefault);
        prevDefault = o;
      }
      t.ok(
        `at the default length the widest gap between neighbouring sprites is a small fraction of one (${widestDefault.toFixed(1)} px of ${sizePx})`,
        widestDefault < sizePx * 0.1
      );
    }
  }

  // ── WEATHER STRESS (2026-10-19) ────────────────────────────────────────────
  // Author: a fire, outside, during full wind and full rain should be almost extinguished and barely surviving.
  {
    const none = fireWeatherStress01({});
    const wind = fireWeatherStress01({ windMotion01: 1 });
    const rain = fireWeatherStress01({ rain01: 1 });
    const both = fireWeatherStress01({ windMotion01: 1, rain01: 1 });
    t.ok('dry still air puts a fire under no stress', none === 0);
    t.ok(
      'a full gale alone, or full rain alone, is a fight the fire plainly survives (well under half stress)',
      near(wind, FIRE_STRESS.windWeight, 1e-12) && near(rain, FIRE_STRESS.rainWeight, 1e-12) && wind < 0.5 && rain < 0.5
    );
    t.ok(
      'full wind AND full rain together are far worse than either alone (the synergy)',
      both > wind + rain * 0.9 && both === 1
    );
    let mono = true;
    for (let i = 1; i <= 50; i++) {
      const w1 = fireWeatherStress01({ windMotion01: i / 50, rain01: 0.5 });
      const w0 = fireWeatherStress01({ windMotion01: (i - 1) / 50, rain01: 0.5 });
      const r1 = fireWeatherStress01({ windMotion01: 0.5, rain01: i / 50 });
      const r0 = fireWeatherStress01({ windMotion01: 0.5, rain01: (i - 1) / 50 });
      if (!(w1 >= w0) || !(r1 >= r0)) mono = false;
    }
    t.ok('stress never falls as wind or rain rises', mono);
    t.ok(
      'half wind is eased (the curve that spared the light from being far too strong): well under half the gale stress',
      fireWeatherStress01({ windMotion01: 0.5 }) < wind * 0.4
    );
    t.ok(
      'a fire that cannot be blown out feels only the immune fraction of the stress',
      near(
        fireWeatherStress01({ windMotion01: 1, rain01: 1, gain: FIRE_STRESS.immuneGain }),
        FIRE_STRESS.immuneGain,
        1e-12
      )
    );
    t.ok(
      'non-finite inputs read as no weather, never NaN',
      fireWeatherStress01({ windMotion01: NaN, rain01: undefined, gain: NaN }) === 0
    );

    const calm = fireStressResponse(0);
    const dead = fireStressResponse(1);
    t.ok(
      'no stress leaves everything at 1',
      calm.sizeMul === 1 && calm.opacityMul === 1 && calm.countMul === 1 && calm.emberCountMul === 1
    );
    t.ok(
      'full stress lands every term on its floor: small, dim, sparse, but never exactly gone',
      near(dead.sizeMul, FIRE_STRESS.sizeFloor, 1e-12) &&
        near(dead.opacityMul, FIRE_STRESS.opacityFloor, 1e-12) &&
        near(dead.countMul, FIRE_STRESS.countFloor, 1e-12) &&
        near(dead.emberCountMul, FIRE_STRESS.emberCountFloor, 1e-12) &&
        dead.sizeMul > 0 &&
        dead.opacityMul > 0
    );
    t.ok(
      'the flame shrinks as a WHOLE under stress (size, brightness and count together), not by thinning sprites alone',
      dead.sizeMul < 0.5 && dead.opacityMul < 0.5 && dead.countMul < 0.5 && fireStressResponse(0.5).sizeMul < 1
    );
  }

  // ── RAIN AND THE BENT FLAME THROUGH THE RUNTIME ────────────────────────────
  {
    const chain = fireScaleChain(66, M_PER_PX);
    const dry = fireRuntimeFromParams({}, chain, { speed01: 1 });
    t.ok('no precipitation, no rain', dry.rain01 === 0);
    const wet = fireRuntimeFromParams({}, chain, { speed01: 0, precip01: 0.8 });
    t.ok('rain is the eased precipitation x weather response x rain response', near(wet.rain01, 0.8, 1e-12));
    t.ok(
      'weatherResponse scales rain, and 0 makes a fire ignore it',
      near(fireRuntimeFromParams({ weatherResponse: 0.5 }, chain, { precip01: 0.8 }).rain01, 0.4, 1e-12) &&
        fireRuntimeFromParams({ weatherResponse: 0 }, chain, { precip01: 1 }).rain01 === 0
    );
    t.ok(
      'rainResponse is its own dial: 0 = rain does nothing, 2 = even a drizzle douses (clamped to 1)',
      fireRuntimeFromParams({ rainResponse: 0 }, chain, { precip01: 1 }).rain01 === 0 &&
        near(fireRuntimeFromParams({ rainResponse: 2 }, chain, { precip01: 0.3 }).rain01, 0.6, 1e-12) &&
        fireRuntimeFromParams({ rainResponse: 2 }, chain, { precip01: 0.9 }).rain01 === 1
    );
    const wetWind = fireRuntimeFromParams({}, chain, { speed01: 0.6, precip01: 1 });
    const dryWind = fireRuntimeFromParams({}, chain, { speed01: 0.6 });
    t.ok(
      'rain does NOT touch the wind signals (windMotion01 / windPushMotion01 are identical wet and dry)',
      wetWind.windMotion01 === dryWind.windMotion01 && wetWind.windPushMotion01 === dryWind.windPushMotion01
    );
    t.ok(
      'a fire that cannot be snuffed feels only the immune fraction of the stress',
      dry.stressGain === 1 &&
        near(fireRuntimeFromParams({ canBeSnuffed: false }, chain, {}).stressGain, FIRE_STRESS.immuneGain, 1e-12)
    );

    const lean = fireRuntimeFromParams({}, chain, {}).perKind.flame;
    t.ok(
      'the default flame lean: 3.7 push = 2.2 sprite-widths, a base-anchored curve, tapered, streaked',
      near(lean.leanLength, 3.7 * FIRE_LEAN.sizesPerPush, 1e-12) &&
        lean.leanCurve === 1.4 &&
        lean.leanTaper === 0.4 &&
        lean.leanStreak === 1.2 &&
        lean.leanFlutter === 0.35 &&
        lean.leanSpread === 0.3
    );
    t.ok(
      'Flame wind push is now the lean LENGTH, and the flame has no force-push scale left at all',
      near(fireRuntimeFromParams({ flameWindPush: 10 }, chain, {}).perKind.flame.leanLength, 6, 1e-12) &&
        lean.windPushScale === undefined
    );
    const huge = fireRuntimeFromParams(
      { flameLeanCurve: 99, flameLeanTaper: 5, flameLeanStreak: 99, flameLeanFlutter: 99, flameLeanSpread: 99 },
      chain,
      {}
    ).perKind.flame;
    const tiny = fireRuntimeFromParams(
      { flameLeanCurve: -1, flameLeanTaper: -1, flameLeanStreak: -1, flameLeanFlutter: -1, flameLeanSpread: -1 },
      chain,
      {}
    ).perKind.flame;
    t.ok(
      'the lean dials clamp to their declared ranges',
      huge.leanCurve === 6 &&
        huge.leanTaper === 1 &&
        huge.leanStreak === 4 &&
        huge.leanFlutter === 1.5 &&
        huge.leanSpread === 2 &&
        tiny.leanCurve === 0.3 &&
        tiny.leanTaper === 0 &&
        tiny.leanStreak === 0 &&
        tiny.leanFlutter === 0 &&
        tiny.leanSpread === 0
    );
    t.ok(
      'embers keep their force push AND gain a streak dial',
      fireRuntimeFromParams({ emberWindPush: 4, emberStreak: 2 }, chain, {}).perKind.ember.windPushScale === 4 &&
        fireRuntimeFromParams({ emberStreak: 2 }, chain, {}).perKind.ember.streak === 2 &&
        fireRuntimeFromParams({}, chain, {}).perKind.ember.streak === 1
    );
  }

  // ── THE LIGHT FOLLOWS THE WEATHER STRESS (2026-10-19) ──────────────────────
  {
    const fire = { id: 'x', x: 0, y: 0, diameterPx: 20, intensity: 1, windExposure: 1, outdoors01: 1 };
    const base = { tier: 3, mPerPx: M_PER_PX };
    const lightFor = (f, params, wind) =>
      buildFireLightSources([f], { ...base, weather: lightWeather(f, params, wind) })[0];
    const dry = lightFor(fire, {}, { speed01: 0 });
    const rain = lightFor(fire, {}, { speed01: 0, precip01: 1 });
    const gale = lightFor(fire, {}, { speed01: 1 });
    const both = lightFor(fire, {}, { speed01: 1, precip01: 1 });
    t.ok('rain alone dims the cast light', rain.alpha01 < dry.alpha01 && rain.luminosity01 < dry.luminosity01);
    t.ok(
      'full wind AND full rain dim the light far more than either alone',
      both.alpha01 <= rain.alpha01 && both.alpha01 <= gale.alpha01 && both.luminosity01 < rain.luminosity01
    );
    t.ok(
      'the light never goes out entirely — a flame barely surviving still casts the faint glow the light always had',
      both.alpha01 >= 0.05 && both.luminosity01 >= 0.05 && Number.isFinite(both.alpha01)
    );
    const roofed = buildFireLightSources([{ ...fire, outdoors01: 0 }], {
      ...base,
      weather: lightWeather(fire, {}, { speed01: 0, precip01: 1 }),
    })[0];
    t.ok('rain does not reach a fire under a roof: the light is untouched', near(roofed.alpha01, dry.alpha01, 1e-12));
    const immune = lightFor(fire, { canBeSnuffed: false }, { speed01: 1, precip01: 1 });
    t.ok('a fire that cannot be snuffed dims less', immune.alpha01 > both.alpha01);
    t.ok(
      'weatherResponse 0 leaves the light at its dry reading however hard it rains',
      near(lightFor(fire, { weatherResponse: 0 }, { speed01: 0, precip01: 1 }).alpha01, dry.alpha01, 1e-12)
    );
    t.ok(
      'rainResponse 0 ignores rain (wind still counts)',
      near(lightFor(fire, { rainResponse: 0 }, { speed01: 0, precip01: 1 }).alpha01, dry.alpha01, 1e-12)
    );
    const clusters = clusterFireSources(
      [
        { id: 'a', x: 0, y: 0, diameterPx: 40, outdoors01: 1 },
        { id: 'b', x: 5, y: 5, diameterPx: 40, outdoors01: 0 },
      ],
      500
    );
    t.ok(
      'a cluster carries the AVERAGE of its fires outdoors (rain reaches half of this pair)',
      clusters.length === 1 && near(clusters[0].outdoors, 0.5, 1e-12)
    );
    t.ok(
      'a cluster names its member fires, so a light can find their spawn points',
      clusters[0].ids.length === 2 && clusters[0].ids.includes('a') && clusters[0].ids.includes('b')
    );
  }

  // ── THE LIGHT IS THE FLAMES' OWN BRIGHTNESS (2026-10-20, mmp-26u) ──────────
  // Author: "the amount of light produced by a fire should be directly proportional to the brightness of the particles
  // currently emitted". The light used to read a separate curve with different inputs; these pin that it now cannot.
  {
    // The brightness model itself.
    t.ok(
      'with no stress a sprite is exactly as bright as in calm air, whatever the gutter says',
      fireFlameBrightness01(0) === 1 && fireFlameBrightness01(0, { fast: 1, cold: 1 }) === 1
    );
    t.ok('non-finite stress reads as calm, never NaN', fireFlameBrightness01(NaN) === 1);
    let falling = true;
    let prev = 1;
    for (let k = 1; k <= 40; k++) {
      const b = fireFlameBrightness01(k / 40);
      if (b > prev + 1e-12) falling = false;
      prev = b;
    }
    t.ok('brightness only falls as stress rises', falling && prev > 0);
    {
      const r = fireStressResponse(0.5);
      t.ok(
        'it is count × size² × opacity × the mean flicker — the three things the draw shader does to a stressed sprite',
        near(
          fireFlameBrightness01(0.5),
          r.countMul * r.sizeMul * r.sizeMul * r.opacityMul * (1 - 0.5 * FIRE_STRESS.flickerDepth * 0.5),
          1e-12
        )
      );
    }
    t.ok(
      'a cold dip dims a stressed sprite further (the flame nearly going out), and does nothing in calm air',
      fireFlameBrightness01(0.6, { cold: 1 }) < fireFlameBrightness01(0.6, { cold: 0 }) * 0.5
    );

    // The CPU gutter: inside 0..1, and cold dips come and go.
    let gLo = Infinity;
    let gHi = -Infinity;
    let coldN = 0;
    for (let k = 0; k < 600; k++) {
      const g = fireGutter01(k * 0.13, 100 + k * 7, 300 - k * 3);
      gLo = Math.min(gLo, g.fast, g.cold);
      gHi = Math.max(gHi, g.fast, g.cold);
      if (g.cold > 0.5) coldN++;
    }
    t.ok('the CPU gutter stays inside 0..1', gLo >= 0 && gHi <= 1);
    t.ok(`cold dips are occasional (${coldN} of 600)`, coldN > 600 * 0.02 && coldN < 600 * 0.5);

    // The light.
    const fire = { id: 'x', x: 0, y: 0, diameterPx: 200, intensity: 1, windExposure: 1, outdoors01: 1 };
    const chain = fireScaleChain(200, M_PER_PX);
    const base = { tier: 3, mPerPx: M_PER_PX };
    const lightFor = (f, weather, extra = {}) => buildFireLightSources([f], { ...base, weather, ...extra })[0];
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // CALM-SCENE LIGHT STAYS IDENTICAL: the numbers the light had before it followed the flames.
    const lumBefore = clamp(0.38 + 0.42 * 0 + 0.25 * (chain.baseTemp - 0.6), 0.05, 0.48);
    const alphaBefore = clamp(0.85 * 1 * chain.baseTemp, 0.05, 1);
    const calm = lightFor(fire, undefined);
    t.ok(
      'calm air: luminosity and alpha are EXACTLY what the light had before it followed the flames',
      near(calm.luminosity01, lumBefore, 1e-12) && near(calm.alpha01, alphaBefore, 1e-12)
    );
    const calmFromRuntime = lightFor(fire, lightWeather(fire, {}, { speed01: 0 }));
    t.ok(
      'the engines’ own calm weather gives that same light',
      near(calmFromRuntime.luminosity01, calm.luminosity01, 1e-12) && near(calmFromRuntime.alpha01, calm.alpha01, 1e-12)
    );

    // DIRECT PROPORTION: both channels scale by exactly the flames' brightness.
    const weather = { windMotion01: 0.8, rain01: 0, stressGain: 1 };
    const stress = fireWeatherStress01({ windMotion01: 0.8, rain01: 0, gain: 1 });
    const bright = fireFlameBrightness01(stress);
    const windy = lightFor(fire, weather);
    t.ok(`the windy flame is dimmer than calm (brightness ${bright.toFixed(3)})`, bright < 0.5 && bright > 0.1);
    t.ok(
      'the light is directly proportional to the flames: alpha AND luminosity scale by exactly their brightness',
      near(windy.alpha01 / calm.alpha01, bright, 1e-9) && near(windy.luminosity01 / calm.luminosity01, bright, 1e-9)
    );

    // THE MISMATCH THIS FIXES: fires of different sizes under the SAME weather. The light used to normalise the wind by
    // its own cluster's size, the sprites by the representative fire's, so a big bright flame could sit under a light
    // computed for a small stressed one. Now the weather is one number for all of them.
    const small = { id: 's', x: 0, y: 0, diameterPx: 30, intensity: 1, windExposure: 1, outdoors01: 1 };
    const big = { id: 'b', x: 9000, y: 0, diameterPx: 300, intensity: 1, windExposure: 1, outdoors01: 1 };
    const pair = buildFireLightSources([small, big], { ...base, tier: 5, weather });
    const brightOf = (light, d) => light.alpha01 / clamp(0.85 * fireScaleChain(d, M_PER_PX).baseTemp, 0.05, 1);
    const lb = pair.find((l) => l.sourceId === 'fire:b');
    const ls = pair.find((l) => l.sourceId === 'fire:s');
    t.ok(
      'a small fire and a big one under the same weather are lit by the same fraction of their calm light',
      pair.length === 2 && near(brightOf(lb, 300), bright, 1e-9) && near(brightOf(ls, 30), bright, 1e-9)
    );

    // PER-POSITION OPENNESS: the mean over the fire's own spawn points.
    const sealedAndOpen = new Map([
      [
        'x',
        [
          { x: 0, y: 0, openness: 0, sky: 1 },
          { x: 12, y: 0, openness: 1, sky: 1 },
        ],
      ],
    ]);
    const half = lightFor(fire, weather, { samplesByFire: sealedAndOpen });
    t.ok(
      'a fire half in a sealed room and half in the open is lit by the MEAN of its flames',
      near(half.alpha01 / calm.alpha01, (1 + bright) / 2, 1e-9)
    );
    const allSealed = lightFor(fire, weather, {
      samplesByFire: new Map([['x', [{ x: 0, y: 0, openness: 0, sky: 1 }]]]),
    });
    t.ok('every flame sealed from the wind: the light is its calm light', near(allSealed.alpha01, calm.alpha01, 1e-12));
    const roofed = lightFor(
      fire,
      { windMotion01: 0, rain01: 1, stressGain: 1 },
      {
        samplesByFire: new Map([['x', [{ x: 0, y: 0, openness: 1, sky: 0 }]]]),
      }
    );
    t.ok(
      'rain does not reach flames under a roof (sky 0): the light is its calm light',
      near(roofed.alpha01, calm.alpha01, 1e-12)
    );
    const exposedAnchor = lightFor({ ...fire, windExposure: 0 }, weather);
    t.ok(
      'with no spawn points the light falls back to its anchor’s exposure (a sealed anchor feels no wind)',
      near(exposedAnchor.alpha01, calm.alpha01, 1e-12)
    );

    // THE SLOW COLD DIP is followed, the fast shimmer is not.
    let coldAt = null;
    let warmAt = null;
    for (let k = 0; k < 4000 && (coldAt === null || warmAt === null); k++) {
      const g = fireGutter01(k * 0.01, 0, 0);
      if (coldAt === null && g.cold > 0.95) coldAt = k * 0.01;
      if (warmAt === null && g.cold === 0) warmAt = k * 0.01;
    }
    t.ok('the scan found both a cold and a warm moment', coldAt !== null && warmAt !== null);
    const noGutter = lightFor(fire, weather);
    const atCold = lightFor(fire, weather, { gutterTimeSec: coldAt });
    const atWarm = lightFor(fire, weather, { gutterTimeSec: warmAt });
    t.ok(
      'during a cold dip the light dims with the flame; between dips it is the plain stressed light',
      atCold.alpha01 < atWarm.alpha01 && near(atWarm.alpha01, noGutter.alpha01, 1e-12)
    );

    // SMOOTHING reaches the light through the callback, keyed by the light's id.
    const asked = [];
    const smoothed = lightFor(fire, weather, {
      smoothBrightness: (id, raw) => {
        asked.push([id, raw]);
        return 0.5;
      },
    });
    t.ok(
      'the light asks the smoother by its own id, with the raw brightness, and uses what it gives back',
      asked.length === 1 &&
        asked[0][0] === 'fire:x' &&
        near(asked[0][1], bright, 1e-9) &&
        near(smoothed.alpha01 / calm.alpha01, 0.5, 1e-9)
    );
  }

  // ── THE SMOOTHER ───────────────────────────────────────────────────────────
  {
    t.ok(
      'the smoothing is short: a fraction of a second, not a drift',
      FIRE_LIGHT_SMOOTHING_SEC >= 0.1 && FIRE_LIGHT_SMOOTHING_SEC <= 0.6
    );
    const sm = createFireBrightnessSmoother(0.3);
    sm.begin(0.016);
    t.ok('a light seen for the first time starts AT its target (no ramp up from nothing)', sm.smooth('a', 0.4) === 0.4);
    sm.end();
    sm.begin(0.3);
    const step = sm.smooth('a', 1);
    t.ok(
      'after one time constant a step has covered 1 − 1/e of the way (exponential, dt-aware)',
      near(step, 0.4 + 0.6 * (1 - Math.exp(-1)), 1e-12)
    );
    sm.end();
    sm.begin(0);
    t.ok('a zero-length frame holds the value', sm.smooth('a', 0) === step);
    sm.end();
    sm.begin(30);
    t.ok('a long stall converges rather than overshooting', near(sm.smooth('a', 0.2), 0.2, 1e-9));
    sm.end();
    sm.begin(0.016);
    sm.smooth('a', 0.2);
    sm.smooth('b', 0.7);
    sm.end();
    t.ok('both lights are remembered while they are asked for', sm.size() === 2);
    sm.begin(0.016);
    sm.smooth('b', 0.7);
    sm.end();
    t.ok('a light that stops being asked for is forgotten (a returning fire starts fresh)', sm.size() === 1);
    sm.begin(0.016);
    t.ok(
      'non-finite input reads as dark, never NaN',
      sm.smooth('b', NaN) <= 0.7 && Number.isFinite(sm.smooth('c', Infinity))
    );
    sm.end();
  }

  // ── PARAMS → RUNTIME ───────────────────────────────────────────────────────

  {
    // ⚠️ SCOPED TO `motionSpeed` ONLY, NOT FULL COVERAGE OF THIS FUNCTION.
    // `fireRuntimeFromParams` had ZERO test coverage before this block — which
    // is exactly how one field rotted: `animationSpeed` was read (satisfying
    // `params/no-dead-controls`, which only checks that a param KEY is
    // referenced somewhere in `src/`) into a field called `puffHz` that
    // multiplied `chain.puffHz` — plausible-looking, and nothing downstream
    // ever consumed it (`fire-subsystem.js`'s `engine.setParams` call never
    // mentioned it, so the "Speed" slider changed nothing). `motionSpeed`
    // replaces it as both the field name and the thing that actually reaches
    // `fire-particle-runtime.js`'s `uMotionSpeed` — see `fire-subsystem.test.mjs`
    // for the proof it reaches every engine's `setParams`.
    const runtime = fireRuntimeFromParams({}, fireScaleChain(66, M_PER_PX));
    t.ok('the default Speed (animationSpeed=1) resolves motionSpeed=1', runtime.motionSpeed === 1);

    const custom = fireRuntimeFromParams({ animationSpeed: 2.4 }, fireScaleChain(66, M_PER_PX));
    t.ok('a custom Speed passes straight through to motionSpeed', near(custom.motionSpeed, 2.4, 1e-9));

    const lo = fireRuntimeFromParams({ animationSpeed: -5 }, fireScaleChain(66, M_PER_PX));
    const hi = fireRuntimeFromParams({ animationSpeed: 99 }, fireScaleChain(66, M_PER_PX));
    t.ok('Speed clamps to its declared floor (0.1)', lo.motionSpeed === 0.1);
    t.ok('Speed clamps to its declared ceiling (3)', hi.motionSpeed === 3);

    // ⚠️ THE REGRESSION GUARD. `motionSpeed` must NOT depend on the fire's own
    // size the way the old (dead) `puffHz` field did — that coupling belonged
    // to the volumetric material's per-fragment noise clock, not to the
    // particle engines' shared playback rate. A fire's diameter changing
    // `chain.puffHz` underneath an unrelated call must not move `motionSpeed`.
    const small = fireRuntimeFromParams({ animationSpeed: 1.5 }, fireScaleChain(5, M_PER_PX));
    const huge = fireRuntimeFromParams({ animationSpeed: 1.5 }, fireScaleChain(660, M_PER_PX));
    t.ok('motionSpeed is independent of fire size, unlike the old puff clock', small.motionSpeed === huge.motionSpeed);
  }

  // ── WIND (2026-09-03) — fireWindMotion01 / fireWindParticleResponse ────────
  // Author's own endpoints: at wind 0, flame/smoke drift upward for depth and
  // flame runs lazy/long-lived; at wind 1, flame gutters (short lives, mostly
  // suppressed, pushed around hard) and smoke production hits zero.

  {
    t.ok('no wind at all resolves to exactly 0', fireWindMotion01() === 0);
    t.ok(
      'zero scene wind speed resolves to 0 regardless of other inputs',
      fireWindMotion01({ windSpeed01: 0, windResponseGain: 2, weatherResponse01: 1 }) === 0
    );

    // weatherResponse GATES to exactly 0, not merely dampens — the param's
    // own help text ("at 0 it burns regardless") must hold for particles too.
    t.ok(
      'weatherResponse01=0 zeroes the signal even at full wind',
      fireWindMotion01({ windSpeed01: 1, windResponseGain: 2, weatherResponse01: 0 }) === 0
    );
    // A sealed room (no exposure) is equally wind-immune.
    t.ok(
      'windExposure01=0 (a sealed room) zeroes the signal even at full wind',
      fireWindMotion01({ windSpeed01: 1, windExposure01: 0 }) === 0
    );

    // ⚠️ SIZE-NORMALISED BY snuffWind — a small fire's own `snuffWind` puts it
    // deep into its own gutter range at a wind speed a big fire barely
    // notices, matching the LIGHT's identical size-awareness (via this same
    // function, since 2026-09-04). Chosen so neither side saturates at 0 or
    // 1, to see the actual ratio. `snuffWind: 4` sits exactly on the
    // divisor's own floor (raised 0.05 → 0.4, 2026-09-04 — see
    // fireWindMotion01's own header) — anything at or below it behaves
    // identically, capping how much a tiny fire can amplify raw wind speed.
    const smallFireSignal = fireWindMotion01({ windSpeed01: 0.3, snuffWind: 4 }); // snuffFrac 0.4 (floored)
    const bigFireSignal = fireWindMotion01({ windSpeed01: 0.3, snuffWind: 8 }); // snuffFrac 0.8
    t.ok(
      `a small fire's own snuffWind reads more wind than a big fire's does at the same scene speed, capped rather than unbounded (small=${smallFireSignal}, big=${bigFireSignal})`,
      near(smallFireSignal, 0.75, 1e-9) &&
        near(bigFireSignal, 0.375, 1e-9) &&
        near(smallFireSignal, bigFireSignal * 2, 1e-9)
    );

    // windResponseGain keeps its own declared meaning regardless of size —
    // dividing by snuffFrac happens on the GAINED product, not before it, so
    // raising the gain can still pull a large fire's signal back toward 1.
    // Same windSpeed01/snuffWind as `bigFireSignal` above so the comparison
    // isolates the gain alone.
    const gained = fireWindMotion01({ windSpeed01: 0.3, snuffWind: 8, windResponseGain: 2 });
    t.ok('raising windResponseGain moves a size-dampened signal back up', gained > bigFireSignal);

    // Always clamped to 0..1, however large the gain or however small snuffWind.
    t.ok(
      'the signal never exceeds 1 even with gain=2 and a tiny snuffWind',
      fireWindMotion01({ windSpeed01: 1, windResponseGain: 2, snuffWind: 0.1 }) === 1
    );

    // ── THE CURVES THEMSELVES ──
    // ⚠️ NO LONGER CARRIES A `flameLifeMul` FIELD, 2026-09-04 ROUND 7 — life
    // moved to a GPU-side, per-particle wind0/wind1 blend
    // (`fire-particle-runtime.js#effectiveWindMotionAt`); see this function's
    // own header for why. Only count/opacity/smoke remain here — see
    // `fire-subsystem.test.mjs` for the new life-blend contract.
    const calm = fireWindParticleResponse(0, true);
    t.ok(
      'at windMotion01=0, count/opacity/smoke sit at their neutral 1x — a windless fire is unaffected',
      calm.flameActiveCountMul === 1 && calm.flameOpacityMul === 1 && calm.smokeActiveCountMul === 1
    );

    const guttering = fireWindParticleResponse(1, true);
    t.ok(
      // ⚠️ FLOORS RAISED 2026-09-04 (from 0.15/0.55) — author, live, TWICE:
      // "far too strong" — see FLAME_GUTTER_COUNT_FLOOR's own header.
      'at windMotion01=1 (can be snuffed), flame is mostly suppressed, never literally zero',
      near(guttering.flameActiveCountMul, 0.3, 1e-9) &&
        near(guttering.flameOpacityMul, 0.65, 1e-9) &&
        guttering.flameActiveCountMul > 0
    );
    t.ok(
      "at windMotion01=1, smoke production is EXACTLY zero — the author's own literal endpoint",
      guttering.smokeActiveCountMul === 0
    );

    const immune = fireWindParticleResponse(1, false);
    t.ok(
      'canBeSnuffed=false raises the suppression floors so a "cannot blow out" fire never empties',
      immune.flameActiveCountMul > guttering.flameActiveCountMul &&
        immune.flameOpacityMul > guttering.flameOpacityMul &&
        near(immune.flameActiveCountMul, 0.65, 1e-9) &&
        near(immune.flameOpacityMul, 0.85, 1e-9)
    );
    t.ok(
      'canBeSnuffed does NOT gate the smoke shutoff — that is cosmetic, not "did it go out"',
      immune.smokeActiveCountMul === 0
    );

    // Monotonic across the whole range, and smoke fades AHEAD of flame's own
    // suppression (real smoke shears apart before a flame actually gutters).
    const mid = fireWindParticleResponse(0.5, true);
    t.ok(
      'count and opacity fall monotonically from calm to guttering',
      mid.flameActiveCountMul < calm.flameActiveCountMul && mid.flameActiveCountMul > guttering.flameActiveCountMul
    );
    t.ok(
      'at the midpoint, smoke has already faded further than flame has been suppressed',
      mid.smokeActiveCountMul < mid.flameActiveCountMul
    );
    t.ok(
      // ⚠️ THE OTHER HALF OF THE "TOO STRONG" FIX (2026-09-04) —
      // SUPPRESSION_EASE_POWER. Bare `smoothstep01` would put "half wind" at
      // `eased = 0.5` — roughly half suppressed. Powered, `eased ≈ 0.22`
      // (`0.5 ** 2.2`), so activeCountMul stays around 0.85 — barely
      // suppressed at all until the back half of the range.
      'half wind leaves flame at roughly 85% of its calm population, not roughly half',
      mid.flameActiveCountMul > 0.8
    );

    // ── THROUGH fireRuntimeFromParams ITSELF ──
    const chain66 = fireScaleChain(66, M_PER_PX); // snuffWind ≈ 1.2 + 6.5·√(66·M_PER_PX)
    const noWind = fireRuntimeFromParams({}, chain66);
    const explicitNoWind = fireRuntimeFromParams({}, chain66, { speed01: 0 });
    t.ok(
      'omitting the wind argument entirely matches passing speed01=0 explicitly (backward-compatible default)',
      noWind.windMotion01 === explicitNoWind.windMotion01
    );
    t.ok(
      // ⚠️ LIFE IS NO LONGER CPU-BLENDED, 2026-09-04 ROUND 7 — `lifeAtWind0`/
      // `lifeAtWind1` are the (clamped) author dial values, passed through
      // UNCOMBINED regardless of wind speed; the particle kernel blends them
      // per particle against real spawn-point exposure instead. See
      // `fireWindParticleResponse`'s own header.
      "flame's lifeAtWind0/lifeAtWind1 fall back to the same defaults fire.js's schema ships",
      near(noWind.perKind.flame.lifeAtWind0, 2.8, 1e-6) && near(noWind.perKind.flame.lifeAtWind1, 1.5, 1e-6)
    );
    t.ok(
      'a windless scene leaves smoke/flame activeCount at exactly their author-dialled values',
      noWind.perKind.smoke.activeCount === 24 && noWind.perKind.flame.activeCount === 12
    );

    const fullWind = fireRuntimeFromParams({}, chain66, { speed01: 1 });
    // ⚠️ THE CURVE MOVED INTO THE SHADER, 2026-10-07. The flame/smoke population
    // and brightness used to be pre-thinned HERE from a map-wide exposure (the
    // MAX across every fire on the floor), so an indoor hearth sharing a floor
    // with an outdoor campfire inherited the campfire's suppression. The CPU now
    // hands over the author's own counts untouched plus the flame's two floors,
    // and the draw shader runs fireWindParticleResponse's curve at each sprite's
    // own position (fire-sprite.js#buildFireWindSuppressionNode, pinned to it by
    // the parity test in fire-sprite.test.mjs).
    t.ok(
      "a full gale leaves smoke activeCount at the author's own dial — the wind curve is per particle now, not pre-applied",
      fullWind.perKind.smoke.activeCount === noWind.perKind.smoke.activeCount && noWind.perKind.smoke.activeCount === 24
    );
    t.ok(
      "a full gale leaves flame activeCount and opacity at the author's own dials too",
      fullWind.perKind.flame.activeCount === noWind.perKind.flame.activeCount &&
        fullWind.perKind.flame.opacityScale === noWind.perKind.flame.opacityScale
    );
    t.ok(
      "the flame's suppression floors travel with the runtime: gutterable fires empty out harder than immune ones",
      near(fullWind.windSuppression.countFloor, 0.3, 1e-9) &&
        near(fullWind.windSuppression.opacityFloor, 0.65, 1e-9) &&
        fireRuntimeFromParams({ canBeSnuffed: false }, chain66, { speed01: 1 }).windSuppression.countFloor > 0.3
    );
    t.ok(
      'a full gale does NOT move lifeAtWind0/lifeAtWind1 — wind speed no longer touches the CPU-side value at all',
      fullWind.perKind.flame.lifeAtWind0 === noWind.perKind.flame.lifeAtWind0 &&
        fullWind.perKind.flame.lifeAtWind1 === noWind.perKind.flame.lifeAtWind1
    );
    t.ok(
      'runtime.windMotion01 is exposed for fire-subsystem.js to forward to every engine',
      fullWind.windMotion01 > 0.9
    );

    // ⚠️ WEATHER RESPONSE MUST NOT GATE THE PUSH (2026-10-19). The author tuned
    // `weatherResponse` down to 0.1 so a gale stops snuffing/dimming fires, and
    // wind then stopped MOVING them too: one gated signal fed both, so a full
    // gale reached the push as 0.1 (and ~2% of the shove after the gust curve).
    const lowWeather = fireRuntimeFromParams({ weatherResponse: 0.1, windResponse: 2 }, chain66, { speed01: 1 });
    t.ok(
      'weatherResponse 0.1 leaves the PUSH signal at full strength in a full gale',
      lowWeather.windPushMotion01 > 0.9
    );
    t.ok(
      'weatherResponse 0.1 still scales the suppression signal down (guttering stays the weather dial)',
      near(lowWeather.windMotion01, lowWeather.windPushMotion01 * 0.1, 1e-9)
    );
    t.ok(
      'windResponse 0 still turns the push off entirely',
      fireRuntimeFromParams({ weatherResponse: 1, windResponse: 0 }, chain66, { speed01: 1 }).windPushMotion01 === 0
    );
    t.ok('no wind, no push', fireRuntimeFromParams({}, chain66, { speed01: 0 }).windPushMotion01 === 0);

    // ⚠️ THE SPLIT, COMPLETED (2026-10-07). 2026-09-04 moved PUSH, lifespan and
    // chaos/rise to per-particle exposure and left the flame/smoke population on
    // the CPU "because a shared arena has no per-particle home for it". It does:
    // the draw shader reads the same wind-cell buffer in the vertex stage. So
    // there is no CPU-side exposure input at all any more — `exposure01` is
    // ignored if a stale caller still passes it, and nothing here can differ with
    // it. Exposure enters exactly once, in the shader.
    const legacyCallerSealed = fireRuntimeFromParams({}, chain66, { speed01: 1, exposure01: 0 });
    t.ok(
      'a stale caller still passing exposure01 changes NOTHING — exposure is applied per particle in the shader, never here',
      legacyCallerSealed.windMotion01 === fullWind.windMotion01 &&
        legacyCallerSealed.perKind.flame.activeCount === fullWind.perKind.flame.activeCount &&
        legacyCallerSealed.perKind.smoke.activeCount === fullWind.perKind.smoke.activeCount
    );
  }

  // ── THE OPENNESS GAIN HAS NO FLOOR (2026-10-07) ────────────────────────────
  // Author: "I don't want fires and candles and anything else which is indoors
  // reacting to wind as if they were outdoors." The kernel's gain used to be
  // max(sqrt(openness), 0.3): measured on a real GPU, a sealed room's embers
  // drifted 16% as far downwind as a field's. These pin the CPU twin of the
  // shader's replacement (fire-sprite.js#buildFireOpennessGainNode, parity-tested
  // in fire-sprite.test.mjs).
  {
    t.ok('a sealed spot (openness 0) feels NONE of the gale — there is no 0.3 floor', fireOpennessGain01(0) === 0);
    t.ok('an open spot feels all of it', fireOpennessGain01(1) === 1);
    t.ok(
      'the gain is LINEAR: no square root inflating a small leaked reading (0.1 stays 0.1, not 0.32)',
      fireOpennessGain01(0.1) === 0.1 && fireOpennessGain01(0.25) === 0.25
    );
    t.ok(
      'out-of-range readings clamp, and a non-finite one means "no geometry data => open outdoors", never "sealed"',
      fireOpennessGain01(-3) === 0 && fireOpennessGain01(7) === 1 && fireOpennessGain01(NaN) === 1
    );
    t.ok(
      'the suppression floors a flame eases toward: 0.3/0.65 gutterable, 0.65/0.85 immune',
      near(fireWindSuppressionFloors(true).countFloor, 0.3, 1e-9) &&
        near(fireWindSuppressionFloors(true).opacityFloor, 0.65, 1e-9) &&
        near(fireWindSuppressionFloors(false).countFloor, 0.65, 1e-9) &&
        near(fireWindSuppressionFloors(false).opacityFloor, 0.85, 1e-9) &&
        fireWindSuppressionFloors().countFloor === fireWindSuppressionFloors(true).countFloor
    );
  }

  // ── INDOOR SUPPRESSION (2026-09-07) — fireIndoorParticleResponse ───────────
  // Author's own endpoints: a fully indoor fire cuts ember/smoke count by 90%
  // and their lifetime to 15% by default; a fully outdoor fire is untouched;
  // flame is never touched by either.

  {
    const outdoors = fireIndoorParticleResponse(0);
    t.ok(
      'indoor01=0 (fully outdoors) leaves every multiplier at its neutral 1x',
      outdoors.emberActiveCountMul === 1 &&
        outdoors.emberLifeMul === 1 &&
        outdoors.smokeActiveCountMul === 1 &&
        outdoors.smokeLifeMul === 1
    );

    const indoors = fireIndoorParticleResponse(1);
    t.ok(
      'indoor01=1 (fully indoors): embers are cut to ZERO (2026-10-16), smoke keeps its count, both live 15% as long, and smoke is drawn at half opacity',
      near(indoors.emberActiveCountMul, 0, 1e-9) &&
        near(indoors.smokeActiveCountMul, 1, 1e-9) &&
        near(indoors.emberLifeMul, 0.15, 1e-9) &&
        near(indoors.smokeLifeMul, 0.15, 1e-9) &&
        near(indoors.smokeOpacityMul, 0.5, 1e-9) &&
        near(outdoors.smokeOpacityMul, 1, 1e-9)
    );

    const half = fireIndoorParticleResponse(0.5);
    t.ok(
      'a linear blend, not eased like the wind curve — half indoor lands exactly halfway between the two endpoints',
      near(half.emberActiveCountMul, 0.5, 1e-9) &&
        near(half.emberLifeMul, 1 - 0.5 * (1 - 0.15), 1e-9) &&
        near(half.smokeOpacityMul, 0.75, 1e-9)
    );

    const customised = fireIndoorParticleResponse(1, {
      emberSuppression: 0.5,
      emberLifeScale: 0.4,
      smokeSuppression: 0.2,
      smokeLifeScale: 2,
    });
    t.ok(
      "an author's own suppression/life-scale dials override the defaults",
      near(customised.emberActiveCountMul, 0.5, 1e-9) &&
        near(customised.emberLifeMul, 0.4, 1e-9) &&
        near(customised.smokeActiveCountMul, 0.8, 1e-9) &&
        near(customised.smokeLifeMul, 2, 1e-9)
    );

    t.ok(
      'a non-finite indoor01 falls back to 0 (outdoors), never NaN',
      fireIndoorParticleResponse(NaN).emberActiveCountMul === 1
    );

    // ── THROUGH fireRuntimeFromParams ITSELF ──
    const chain66Indoor = fireScaleChain(66, M_PER_PX);
    const outdoorRuntime = fireRuntimeFromParams({}, chain66Indoor, { outdoor01: 1 });
    const noArgRuntime = fireRuntimeFromParams({}, chain66Indoor);
    t.ok(
      'omitting `wind` entirely matches passing outdoor01=1 explicitly (backward-compatible default)',
      outdoorRuntime.perKind.ember.activeCount === noArgRuntime.perKind.ember.activeCount &&
        outdoorRuntime.perKind.smoke.activeCount === noArgRuntime.perKind.smoke.activeCount
    );

    const indoorRuntime = fireRuntimeFromParams({}, chain66Indoor, { outdoor01: 0 });
    t.ok(
      'a fully indoor fire makes NO embers (2026-10-16), and keeps its full smoke count',
      indoorRuntime.perKind.ember.activeCount === 0 &&
        indoorRuntime.perKind.smoke.activeCount === outdoorRuntime.perKind.smoke.activeCount
    );
    t.ok(
      'a fully indoor fire draws its smoke at half the outdoor opacity, and outdoor smoke is untouched',
      near(indoorRuntime.perKind.smoke.opacityScale, outdoorRuntime.perKind.smoke.opacityScale * 0.5, 1e-9) &&
        outdoorRuntime.perKind.smoke.opacityScale === 1
    );
    t.ok(
      "flame's activeCount is completely untouched by indoor01 — the author's own ask was embers and smoke only",
      indoorRuntime.perKind.flame.activeCount === outdoorRuntime.perKind.flame.activeCount
    );
    t.ok(
      "ember's lifeAtWind0/lifeAtWind1 both shrink to 15% indoors, together — the wind0/wind1 SHAPE survives, only the scale changes",
      near(indoorRuntime.perKind.ember.lifeAtWind0, outdoorRuntime.perKind.ember.lifeAtWind0 * 0.15, 1e-6) &&
        near(indoorRuntime.perKind.ember.lifeAtWind1, outdoorRuntime.perKind.ember.lifeAtWind1 * 0.15, 1e-6)
    );
    t.ok(
      // mythica-machina-press#512 — smoke's life used to be a `lifeScale`
      // field nothing downstream ever read (fire-particle-runtime.js#setParams
      // has no handler for that key). Proving a real lifeAtWind0/lifeAtWind1
      // pair exists and moves with indoor01 is this fix's own regression
      // test, not just the new feature's.
      "smoke now carries a real lifeAtWind0/lifeAtWind1 pair (mythica-machina-press#512's fix), and both shrink indoors",
      Number.isFinite(outdoorRuntime.perKind.smoke.lifeAtWind0) &&
        Number.isFinite(outdoorRuntime.perKind.smoke.lifeAtWind1) &&
        near(indoorRuntime.perKind.smoke.lifeAtWind0, outdoorRuntime.perKind.smoke.lifeAtWind0 * 0.15, 1e-6) &&
        near(indoorRuntime.perKind.smoke.lifeAtWind1, outdoorRuntime.perKind.smoke.lifeAtWind1 * 0.15, 1e-6)
    );
    t.ok(
      "an author's own emberIndoorSuppression dial reaches the real call path",
      near(
        fireRuntimeFromParams({ emberIndoorSuppression: 0 }, chain66Indoor, { outdoor01: 0 }).perKind.ember.activeCount,
        outdoorRuntime.perKind.ember.activeCount,
        1
      )
    );

    // Wind and indoor are independent axes. Indoor smoke no longer cuts the
    // CPU-side count by default (2026-10-16 — it is dimmed by opacity instead),
    // so an equally windy indoor and outdoor fire send the same smoke count;
    // wind's own per-particle suppression still runs in the shader.
    const windyOutdoor = fireRuntimeFromParams({}, chain66Indoor, { speed01: 0.3, exposure01: 1, outdoor01: 1 });
    const windyIndoor = fireRuntimeFromParams({}, chain66Indoor, { speed01: 0.3, exposure01: 1, outdoor01: 0 });
    t.ok(
      'an equally windy indoor fire sends the same smoke count, but at half the opacity',
      windyIndoor.perKind.smoke.activeCount === windyOutdoor.perKind.smoke.activeCount &&
        near(windyIndoor.perKind.smoke.opacityScale, windyOutdoor.perKind.smoke.opacityScale * 0.5, 1e-9)
    );
  }

  // ── COLOUR CC (2026-08-30) — color/posterize/bandCount/colorHueShift ───────
  // fireRuntimeFromParams computed flameColor/posterize/bands for these since
  // the schema shipped, but fire-subsystem.js never forwarded any of the three
  // to a live engine — the same "reads the key, drops the value" shape the
  // block above documents for the old puffHz field. This is that fix's own
  // proof, for the params → runtime half; fire-subsystem.test.mjs proves the
  // runtime → engine half.

  {
    // `color`'s neutral anchor IS its own shipped default — must be a
    // provable no-op there, not merely "close".
    const identity = fireTintMul('#fdba35');
    t.ok(
      'fireTintMul is exactly [1,1,1] at the shipped default (#fdba35)',
      identity.every((c) => near(c, 1, 1e-6))
    );
    const reddened = fireTintMul('#ff0000');
    t.ok(
      'a different swatch produces a real, non-identity multiplier',
      reddened.some((c) => Math.abs(c - 1) > 0.05)
    );
    t.ok(
      'an invalid hex falls back to identity rather than NaN',
      fireTintMul('not-a-colour').every((c) => near(c, 1, 1e-6))
    );

    // hueShiftRad — fuel's own turns-based shift plus the manual ROH degrees
    // dial, combined into one radian value the shader reads once.
    const neutral = fireRuntimeFromParams({}, fireScaleChain(66, M_PER_PX));
    t.ok('no fuel contribution, no manual shift → hueShiftRad is 0', near(neutral.hueShiftRad, 0, 1e-9));

    const manual = fireRuntimeFromParams({ colorHueShift: 90 }, fireScaleChain(66, M_PER_PX));
    t.ok('a 90° manual shift resolves to π/2 radians', near(manual.hueShiftRad, Math.PI / 2, 1e-6));

    const magicalChain = fireScaleChain(66, M_PER_PX, { fuel: 'magical' });
    const magical = fireRuntimeFromParams({ fuel: 'magical' }, magicalChain);
    t.ok(
      "magical fuel's own built-in shift resolves correctly (its help text's own '180°')",
      near(magical.hueShiftRad, FIRE_FUELS.magical.hueShift * 2 * Math.PI, 1e-6) &&
        near(magical.hueShiftRad, Math.PI, 1e-6)
    );

    const both = fireRuntimeFromParams({ fuel: 'magical', colorHueShift: 90 }, magicalChain);
    t.ok(
      'fuel and the manual dial ADD rather than override',
      near(both.hueShiftRad, magical.hueShiftRad + Math.PI / 2, 1e-6)
    );

    const overdriven = fireRuntimeFromParams({ colorHueShift: 999 }, fireScaleChain(66, M_PER_PX));
    t.ok('the manual dial clamps to its declared ±180° before combining', near(overdriven.hueShiftRad, Math.PI, 1e-6));

    // posterize/bands now genuinely reach the runtime object, ready to flow
    // downstream.
    t.ok('posterize now defaults to 0 (smooth) — see fire.js for why not the old 0.85', neutral.posterize === 0);
    const banded = fireRuntimeFromParams({ posterize: 1, bandCount: 4.6 }, fireScaleChain(66, M_PER_PX));
    t.ok('posterize passes straight through', banded.posterize === 1);
    t.ok('bandCount passes through rounded and clamped', banded.bands === 5);
  }

  // ── GEOMETRY ───────────────────────────────────────────────────────────────

  {
    const fires = [
      {
        x: 100,
        y: 200,
        diameterPx: 300,
        intensity: 1,
        expectedDepth: 0.4,
        windExposure: 1,
        color: '#FDBA35',
        maskClip: true,
      },
      {
        x: 900,
        y: 800,
        diameterPx: 120,
        intensity: 0.5,
        expectedDepth: 0.7,
        windExposure: 0.2,
        color: '#EE7B10',
        maskClip: false,
      },
    ];
    const g = computeFireQuadArrays(fires, { mPerPx: M_PER_PX });

    t.ok('one quad per fire', g.quadCount === 2);
    t.ok('position is 4 verts × vec3', g.position.length === 2 * 4 * 3);
    t.ok('uv is 4 verts × vec2', g.uv.length === 2 * 4 * 2);
    t.ok('center is 4 verts × vec2', g.center.length === 2 * 4 * 2);
    t.ok('colorIntensity is 4 verts × vec4', g.colorIntensity.length === 2 * 4 * 4);
    t.ok('fireParams is 4 verts × vec4', g.fireParams.length === 2 * 4 * 4);
    t.ok('the index buffer is two triangles per quad', g.index.length === 2 * 6);
    t.ok('every position is finite', g.position.every(Number.isFinite));

    // The quad is CENTRED on the fire, which the material relies on to place
    // the plume spine without a uniform that could move it off the fuel.
    for (let v = 0; v < 4; v++) {
      t.ok(`vertex ${v} carries the fire centre`, g.center[v * 2] === 100 && g.center[v * 2 + 1] === 200);
    }
    const xs = [0, 1, 2, 3].map((v) => g.position[v * 3]);
    t.ok('the quad brackets its fire in x', Math.min(...xs) < 100 && Math.max(...xs) > 100);
    const ys = [0, 1, 2, 3].map((v) => g.position[v * 3 + 1]);
    t.ok('the quad brackets its fire in y', Math.min(...ys) < 200 && Math.max(...ys) > 200);

    // ⚠️ PER-VERTEX expectedDepth, not a uniform: one draw call batches every
    // visible fire and different fires legitimately sit on different floors.
    // (Compared with a tolerance because these are Float32Array round-trips —
    // 0.4 stores as 0.4000000059604645 and an `===` here fails for a reason
    // that has nothing to do with the code under test.)
    t.ok('quad 0 carries its own depth', near(g.fireParams[2], 0.4, 1e-6));
    t.ok('quad 1 carries a DIFFERENT depth in the same buffer', near(g.fireParams[4 * 4 + 2], 0.7, 1e-6));
    t.ok('quad 1 carries its own wind exposure', near(g.fireParams[4 * 4 + 1], 0.2, 1e-6));

    // maskClip is the 4th component — a mask-derived fire is clipped in the
    // shader, an anchor-placed one never is, and they can share a batch.
    t.ok('quad 0 (mask-derived) is flagged for the mask clip', g.fireParams[3] === 1);
    t.ok('quad 1 (anchor) is NOT flagged for the mask clip', g.fireParams[4 * 4 + 3] === 0);

    // The second triangle must share vertices 0 and 2 with the first, or the
    // quad renders as a bowtie.
    t.ok('the two triangles share a diagonal', g.index[3] === g.index[0] && g.index[4] === g.index[2]);
  }

  {
    // ⚠️ FAILS OPEN: a fire with no `maskClip` field at all (a caller that has
    // not labelled its source yet) must default to UNCLIPPED, the same
    // `feedback_gate_polarity_must_fail_open` shape `expectedDepth` already
    // uses — an invisible flame is a worse failure than an unclipped one.
    const g = computeFireQuadArrays([{ x: 0, y: 0, diameterPx: 100 }], { mPerPx: M_PER_PX });
    t.ok('an unlabelled fire defaults to NOT clipped', g.fireParams[3] === 0);
  }

  {
    // The quad must contain the sheared plume, or a windy fire gets clipped
    // into a visible rectangle. Sized wind-INDEPENDENTLY on purpose so a gust
    // never triggers a geometry rebake.
    const chain = fireScaleChain(300, M_PER_PX);
    const size = fireQuadSizePx(chain);
    t.ok('the quad is wider than the fire', size > chain.diameterPx);
    t.ok('the quad allows for the plume height', size > chain.heightPx);
    const windy = computeFireQuadArrays([{ x: 0, y: 0, diameterPx: 300, windExposure: 1 }], { mPerPx: M_PER_PX });
    const calm = computeFireQuadArrays([{ x: 0, y: 0, diameterPx: 300, windExposure: 0 }], { mPerPx: M_PER_PX });
    t.ok('quad size does not depend on wind exposure', windy.quadSizes[0] === calm.quadSizes[0]);
  }

  {
    // Malformed fires must be dropped, not baked as NaN — one NaN vertex kills
    // the entire batched draw, taking every healthy fire with it.
    const g = computeFireQuadArrays(
      [
        { x: 0, y: 0, diameterPx: 100 },
        { x: NaN, y: 0, diameterPx: 100 },
        { x: 0, y: 0, diameterPx: 0 },
        { x: 5, y: 5, diameterPx: 50 },
      ],
      { mPerPx: M_PER_PX }
    );
    t.ok('malformed fires are dropped', g.quadCount === 2);
    t.ok('no NaN survives into the vertex buffer', g.position.every(Number.isFinite));
    t.ok('an empty list yields an empty, valid bake', computeFireQuadArrays([], {}).quadCount === 0);
  }

  {
    // ⚠️ NOT ONE NON-FINITE NUMBER MAY REACH A VERTEX BUFFER, from ANY input.
    // Author-reported live 2026-08-08: a per-frame flood of
    // `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN`.
    // A batched draw shares one buffer, so a single poisoned vertex stops every
    // healthy fire in it from rendering — the failure is never local.
    const hostile = [
      { x: 0, y: 0, diameterPx: 100, intensity: NaN, expectedDepth: NaN, windExposure: NaN },
      { x: 10, y: 10, diameterPx: Infinity },
      { x: 20, y: 20, diameterPx: 100, fuel: 'nonsense', color: 'not-a-colour' },
      { x: 30, y: 30, diameterPx: 1e12 },
      { x: 40, y: 40, diameterPx: 1e-9 },
    ];
    for (const mpp of [0.01524, 0, NaN, -1, 1e9]) {
      const out = computeFireQuadArrays(hostile, { mPerPx: mpp });
      const clean =
        out.position.every(Number.isFinite) &&
        out.center.every(Number.isFinite) &&
        out.colorIntensity.every(Number.isFinite) &&
        out.fireParams.every(Number.isFinite);
      t.ok(`hostile input at mPerPx=${mpp} produces no non-finite vertex data`, clean);
    }
  }

  {
    // Same guarantee on the LIGHT side — the pool builds a fan geometry from
    // these descriptors and one NaN takes out the whole batch.
    const hostile = [
      { id: 'a', x: 0, y: 0, diameterPx: 100, intensity: NaN, elevation: NaN, windExposure: NaN },
      { id: 'b', x: NaN, y: 0, diameterPx: 100 },
      { id: 'c', x: 5, y: 5, diameterPx: Infinity },
    ];
    for (const mpp of [0.01524, 0, NaN]) {
      const lights = buildFireLightSources(hostile, { tier: 3, mPerPx: mpp, tMs: 1000 });
      const clean = lights.every(
        (l) =>
          [l.x, l.y, l.radius, l.luminosity01, l.alpha01, l.elevation, l.windExposure].every(Number.isFinite) &&
          Array.isArray(l.shapePoints) &&
          l.shapePoints.every(Number.isFinite)
      );
      t.ok(`hostile light input at mPerPx=${mpp} yields only finite descriptors (${lights.length} light(s))`, clean);
    }
  }

  {
    // ⚠️ THE POLYGON IS FLAT `[x0,y0,x1,y1,…]`, AND THIS TEST EXISTS BECAUSE
    // THE ONE ABOVE USED TO ASSERT THE OPPOSITE. It checked
    // `Number.isFinite(p.x) && Number.isFinite(p.y)` — which passes ONLY for an
    // array of `{x,y}` objects, the wrong format, and so it actively locked in
    // the bug that made fire cast no light at all: the pool's
    // `normalizeLightPolygon` indexes `shapePoints[i*2]` and subtracts a number,
    // getting NaN out of an object, and NaN triangles are silently discarded.
    // A green test asserted the broken shape was correct
    // (`feedback_synthetic_fixture_invariant_is_not_authored_art` in its purest
    // form: the fixture agreed with the code because I wrote both from the same
    // wrong assumption). Pinned against the REAL sibling producers' format.
    const [light] = buildFireLightSources([{ id: 'f', x: 100, y: 200, diameterPx: 120, intensity: 1 }], {
      tier: 3,
      mPerPx: M_PER_PX,
      tMs: 0,
    });
    t.ok('a light is produced at all', !!light);
    t.ok(
      'shapePoints is a flat number array',
      light.shapePoints.every((v) => typeof v === 'number')
    );
    t.ok('shapePoints holds whole x,y PAIRS', light.shapePoints.length % 2 === 0 && light.shapePoints.length >= 16);
    // Every vertex must sit on the light's own circle, which is only checkable
    // once the layout is known — the real proof the pairs are not transposed.
    let onCircle = true;
    for (let i = 0; i < light.shapePoints.length; i += 2) {
      const dx = light.shapePoints[i] - light.x;
      const dy = light.shapePoints[i + 1] - light.y;
      if (Math.abs(Math.hypot(dx, dy) - light.radius) > 1e-3) onCircle = false;
    }
    t.ok('every flat pair lands on the light radius', onCircle);
  }

  {
    // The bake is signature-gated, so the signature must move on anything the
    // bake reads — and stay put on anything it does not.
    const base = [{ x: 1, y: 2, diameterPx: 100, intensity: 1, expectedDepth: 0.5, windExposure: 1, color: '#FDBA35' }];
    const sig = fireGeometrySignature(base);
    t.ok('the signature is stable', sig === fireGeometrySignature(base));
    t.ok('moving a fire changes it', sig !== fireGeometrySignature([{ ...base[0], x: 2 }]));
    t.ok('resizing a fire changes it', sig !== fireGeometrySignature([{ ...base[0], diameterPx: 101 }]));
    t.ok('a floor change changes it', sig !== fireGeometrySignature([{ ...base[0], expectedDepth: 0.6 }]));
    t.ok('a colour change changes it', sig !== fireGeometrySignature([{ ...base[0], color: '#EE7B10' }]));
    t.ok('a fuel change changes it', sig !== fireGeometrySignature([{ ...base[0], fuel: 'oil' }]));
    t.ok('adding a fire changes it', sig !== fireGeometrySignature([...base, { x: 9, y: 9, diameterPx: 10 }]));
    t.ok('an empty list has a signature', Number.isFinite(fireGeometrySignature([])));
  }

  // ── THE COLOUR SPEC ────────────────────────────────────────────────────────

  {
    t.ok('hex parses to 0..1 triples', JSON.stringify(hexToRgb01('#ffffff')) === JSON.stringify([1, 1, 1]));
    t.ok('hex parses without the hash', hexToRgb01('000000')[0] === 0);
    t.ok('malformed hex returns null, never a wrong colour', hexToRgb01('#xyz') === null);
    t.ok('a missing hex returns null', hexToRgb01(undefined) === null);

    const stops = fireRampStops();
    t.ok('the ramp has every stop', stops.length === FIRE_RAMP_WOOD.length);
    t.ok(
      'every ramp colour parsed',
      stops.every((s) => Array.isArray(s.rgb))
    );
    // Hottest first, and monotonic — a shader that walks this expects order.
    let descending = true;
    for (let i = 1; i < stops.length; i++) if (stops[i].t >= stops[i - 1].t) descending = false;
    t.ok('the ramp is ordered hottest first', descending);
    // The reference image's defining property: the core is pale, the rim is
    // saturated orange. If red ever stops leading blue this is not fire.
    t.ok('the core is the palest stop', stops[0].rgb[2] > stops.at(-1).rgb[2]);
    t.ok(
      'every stop is warm (r > g > b)',
      stops.every((s) => s.rgb[0] >= s.rgb[1] && s.rgb[1] >= s.rgb[2])
    );
  }

  // ── THE DEFAULT-TIER ANTI-DRIFT GUARD ──────────────────────────────────────

  {
    // Pinned against the ladder's own length rather than a literal, so adding a
    // rung cannot leave this pointing at a different look. The cross-check
    // against what DEFAULT_PERFORMANCE_PROFILE actually resolves lives in
    // effects/__tests__/effect-tier.test.mjs, beside the other ladders.
    t.ok('the default tier exists in the ladder', fireTierPlan(FIRE_DEFAULT_TIER) === fireTierPlan(FIRE_DEFAULT_TIER));
    t.ok('the default tier draws smoke', fireTierPlan(FIRE_DEFAULT_TIER).smoke === true);
    t.ok('the default tier shears', fireTierPlan(FIRE_DEFAULT_TIER).shear === true);
    // A malformed tier must degrade to the intended look, never to the cheapest
    // rung and never to the most expensive one.
    for (const bad of [undefined, null, NaN, 'three']) {
      t.ok(`a ${String(bad)} tier resolves to the default`, fireTierPlan(bad) === fireTierPlan(FIRE_DEFAULT_TIER));
    }
    t.ok('an out-of-range tier clamps into the ladder', fireTierPlan(99) === fireTierPlan(5));
    t.ok('a negative tier clamps to rung 0', fireTierPlan(-3) === fireTierPlan(0));
  }

  // === 🔒 spriteCountScale (2026-08-30) — fire's 3rd real tier lever ========
  // Mirrors clusterFactor's own coverage just below each block above, for the
  // newer field. See fire-subsystem.test.mjs for proof this actually reaches
  // a live activeCount, not just the plan data itself.
  {
    t.ok('rung 0 (the absolute floor) is the sparsest, not zero', fireTierPlan(0).spriteCountScale > 0);
    t.ok(
      'the ladder is non-decreasing across every rung, never a step backward',
      [0, 1, 2, 3, 4, 5].every(
        (n) => n === 0 || fireTierPlan(n).spriteCountScale >= fireTierPlan(n - 1).spriteCountScale
      )
    );
    t.ok(
      'the DEFAULT tier (standard) already sits at the ceiling — 1.0, matching PER_FIRE exactly',
      fireTierPlan(FIRE_DEFAULT_TIER).spriteCountScale === 1.0
    );
    t.ok(
      'every rung AT OR ABOVE the default is byte-identical to it — this lever never exceeds today`s shipped density',
      [FIRE_DEFAULT_TIER, 4, 5].every((n) => fireTierPlan(n).spriteCountScale === 1.0)
    );
    t.ok(
      'every rung BELOW the default is genuinely cheaper, not just cosmetically different',
      [0, 1, 2].every((n) => fireTierPlan(n).spriteCountScale < 1.0)
    );
  }

  // ── THE LIGHT FOLLOWS THE FLAME, NOT THE SPRITE-ERA STRESS CURVE (round 5) ────────────────────────────────────────
  {
    const fire = { id: 'g', x: 100, y: 100, diameterPx: 300, intensity: 1, elevation: 0, windExposure: 1, ids: ['g'] };
    const life = (v) => new Map([['g', { vitality: v, coal: 1 }]]);
    const mk = (speed01, v) =>
      buildFireLightSources([{ ...fire }], {
        tier: 3,
        mPerPx: M_PER_PX,
        weather: lightWeather(fire, {}, { speed01 }),
        lifeByFire: life(v),
      });
    const calm = mk(0, 1)[0];
    const gale = mk(1, 1)[0];
    t.ok(
      'a gale on a still-burning fire keeps most of its light (while flame is drawn, light is cast)',
      gale && gale.alpha01 > 0.6 * calm.alpha01
    );
    const dying = mk(1, 0.3)[0];
    t.ok('the light drops only as the flame itself dies down', dying && dying.alpha01 < gale.alpha01 * 0.5);
  }
}
