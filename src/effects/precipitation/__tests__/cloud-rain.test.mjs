/**
 * RAIN FROM THE CLOUDS (cloud-rain.js, 2026-11-03) — the CPU half: the link's fail-open ramp, the virtual deck,
 * the deck height's formula, the species' real fall speeds, and the push dial the fall reads relative to.
 * The TSL half (birthplaces, the fade, the lean) is judged in `tools/shader-lab/rain-cloud.html`.
 */
import {
  cloudRainLinkWeight,
  virtualRainDeck,
  VIRTUAL_DECK_SHARE,
  CLOUD_RAIN_DEPTH_LO,
  CLOUD_RAIN_DEPTH_HI,
  CLOUD_RAIN_CANDIDATES,
} from '../cloud-rain.js';
import { storybookDeckHeightAt, resolveStorybookDeck } from '../../clouds/storybook-clouds.js';
import { PRECIP_SPECIES } from '../precip-species.js';
import { PRECIPITATION_PARAMS } from '../precipitation.js';
import { WIND_PUSH_SHIPPED_PXS } from '../../particles/precip-runtime.js';

export function run(t) {
  // ⭐ FAILS OPEN: a clear deck never stops the rain; a little cloud links fully; the dial scales it.
  t.ok('cloud rain: no cloud => link 0 (rain everywhere)', cloudRainLinkWeight(0, 1) === 0);
  t.ok('cloud rain: a deck 12% full links fully', Math.abs(cloudRainLinkWeight(0.12, 1) - 1) < 1e-9);
  t.ok('cloud rain: the dial at 0 unlinks', cloudRainLinkWeight(0.6, 0) === 0);
  t.ok('cloud rain: the dial scales linearly', Math.abs(cloudRainLinkWeight(0.4, 0.5) - 0.5) < 1e-9);
  t.ok('cloud rain: the ramp rises monotonically', cloudRainLinkWeight(0.03, 1) < cloudRainLinkWeight(0.08, 1));
  t.ok(
    'cloud rain: heavy overcast eases the link (no dry views)',
    cloudRainLinkWeight(0.58, 1, 0.95) <= 0.21 && cloudRainLinkWeight(0.58, 1, 0.95) > 0
  );
  // ⭐ THE REGRESSION (MSA Lab 2026-11-09): the ease must engage at the fill the main deck can REALLY reach. It was
  // keyed on fill 0.55..0.85 while `storybookDensity` caps the main deck at 0.58, so 100% cloud left 36% of the
  // view dry. Tie the test to the deck's own resolver, not to a hand-picked fill.
  const overcastFill = resolveStorybookDeck({ cover01: 1, scalePx: 1100, eyeHeight: 1000 }).fill;
  t.ok(
    'cloud rain: Steady Rain (cover 1) at the main deck s real fill eases to a fifth',
    cloudRainLinkWeight(overcastFill, 1, 1) <= 0.21
  );
  t.ok(
    'cloud rain: a thunderstorm (cover 0.8) keeps its shower shafts (full link)',
    Math.abs(
      cloudRainLinkWeight(resolveStorybookDeck({ cover01: 0.8, scalePx: 1100, eyeHeight: 1000 }).fill, 1, 0.8) - 1
    ) < 1e-9
  );
  t.ok('cloud rain: mid cover keeps the full link', Math.abs(cloudRainLinkWeight(0.5, 1) - 1) < 1e-9);
  t.ok('cloud rain: junk in => 0, never NaN', cloudRainLinkWeight(NaN, undefined) === 0);
  t.ok('cloud rain: the depth window is ordered', CLOUD_RAIN_DEPTH_LO < CLOUD_RAIN_DEPTH_HI);
  t.ok('cloud rain: best of several birthplaces', CLOUD_RAIN_CANDIDATES >= 2);

  // The virtual deck: flat, at its share of the eye, the same shape as a storybook deck.
  const v = virtualRainDeck(1000, { minX: 0, minY: 0, maxX: 2000, maxY: 1000 });
  t.ok('virtual deck: flat at its share of the eye', v.baseHeight === VIRTUAL_DECK_SHARE * 1000 && v.domeHeight === 0);
  t.ok('virtual deck: no fill (so no link)', v.fill === 0 && cloudRainLinkWeight(v.fill, 1) === 0);
  t.ok(
    'virtual deck: height is the same everywhere',
    storybookDeckHeightAt(v, 0, 0) === storybookDeckHeightAt(v, 1900, 50)
  );

  // The storybook dome: highest at the board's centre, the base at the dome's rim, never below 0.
  const board = { minX: 0, minY: 0, maxX: 6000, maxY: 4000 };
  const deck = resolveStorybookDeck({ cover01: 0.5, scalePx: 1100, board, tableOn: true, eyeHeight: 1358 });
  const centre = storybookDeckHeightAt(deck, 3000, 2000);
  t.ok('deck height: base + dome at the centre', Math.abs(centre - (deck.baseHeight + deck.domeHeight)) < 1e-6);
  t.ok('deck height: lower off-centre', storybookDeckHeightAt(deck, 0, 0) < centre);
  t.ok('deck height: never negative far away', storybookDeckHeightAt(deck, -1e6, 1e6) >= 0);
  t.ok('deck height: under the eye (a drop is born below the camera)', centre < 1358 * 0.6);

  // ⭐ THE REAL FALL: rain and snow carry real terminal velocities (m/s), in the right order of magnitude.
  const rain = PRECIP_SPECIES.rain.fall;
  const snow = PRECIP_SPECIES.snow.fall;
  const hail = PRECIP_SPECIES.hail.fall;
  t.ok(
    'fall: rain 2-9 m/s (Gunn & Kinzer)',
    rain.terminalMps[0] >= 1.5 && rain.terminalMps[1] <= 9.5 && rain.dropLaw === true
  );
  t.ok('fall: snow 0.5-1.5 m/s', snow.terminalMps[0] >= 0.3 && snow.terminalMps[1] <= 2);
  t.ok('fall: hail falls fastest', hail.terminalMps[0] > rain.terminalMps[1] * 0.9);
  t.ok('fall: hail leaves the cloud with only part of the wind', hail.birthCarry01 > 0 && hail.birthCarry01 < 1);
  // The drop law's own end points (Atlas et al. 1973): 0.5 mm -> ~2.0 m/s, 4.5 mm -> ~8.9 m/s.
  const law = (d) => 9.65 - 10.3 * Math.exp(-0.6 * d);
  t.ok(
    'fall: drop law matches the table ends',
    Math.abs(law(0.5) - rain.terminalMps[0]) < 0.15 && Math.abs(law(4.5) - rain.terminalMps[1]) < 0.15
  );

  // The push dial: the fall reads it relative to its shipped default, so the two must agree.
  t.ok(
    "push: the fall's reference is the card's default",
    WIND_PUSH_SHIPPED_PXS === PRECIPITATION_PARAMS.windAirSpeedPxS.default
  );
  t.ok('fall speed dial: 1 = real terminal speed by default', PRECIPITATION_PARAMS.fallSpeedScale.default === 1);
  t.ok('cloud link dial: on by default', PRECIPITATION_PARAMS.cloudLink.default === 1);
}
