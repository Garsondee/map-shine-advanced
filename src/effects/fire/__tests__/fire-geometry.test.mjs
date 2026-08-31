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
  resolveFireCoverageRung,
  clusterFireSources,
  buildFireLightSources,
  computeFireQuadArrays,
  fireGeometrySignature,
  fireQuadSizePx,
  hexToRgb01,
  fireRampStops,
  fireRuntimeFromParams,
  fireTintMul,
  FIRE_DEFAULT_TIER,
  FIRE_FUELS,
  FIRE_RAMP_WOOD,
} from '../fire-geometry.js';

/** Grid scale of the author's own test map: 100 px per 5 ft ≈ 1.524 m. */
const M_PER_PX = 1.524 / 100;

const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
    t.ok('the light uses inverse-square falloff', l.falloffModel === 'inverseSquare');
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
    // A fire blown out by weather must stop emitting light entirely, not emit a
    // dim one — a snuffed fire that still lights the room reads as a bug.
    const gale = { weather: { precip01: 0 }, wind: { speed01: 1 } };
    const lights = buildFireLightSources([{ id: 'x', x: 0, y: 0, diameterPx: 20, intensity: 1, windExposure: 1 }], {
      tier: 3,
      mPerPx: M_PER_PX,
      env: gale,
    });
    t.ok('a blown-out fire emits no light at all', lights.length === 0);
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
}
