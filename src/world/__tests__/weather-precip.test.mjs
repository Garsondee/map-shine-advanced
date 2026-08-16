/**
 * THE PRECIPITATION AXES + THE precipKind DERIVATION (P1).
 *
 * What is proven here:
 *   - `precip01`/`temperature01` are real, eased axes with sane pacing;
 *   - ⭐ the sleet BAND is closed at BOTH ends — the named half-open bug class;
 *   - an AUTHORED kind beats the derivation outright (LAW 4 upstream);
 *   - `precipKindAuthored` is NOT an eased axis, and cannot become one;
 *   - LAW 5 survives the new axes: a fresh director manager still matches
 *     `DEFAULT_WEATHER` on every axis it shares with it.
 */
import {
  createWeatherManager,
  derivePrecipKind,
  PRECIP_KINDS,
  PRECIP_SLEET_BAND,
  WEATHER_AXES,
  WEATHER_AXIS_NAMES,
} from '../weather.js';

export function run(t) {
  // ---- the axes themselves ----------------------------------------------------
  {
    t.ok('precip01 is a real axis now', Object.hasOwn(WEATHER_AXES, 'precip01'));
    t.ok('temperature01 is a real axis now', Object.hasOwn(WEATHER_AXES, 'temperature01'));
    t.ok(
      'both declare a LIVE consumer — the unconsumed-axis rule discharged',
      WEATHER_AXES.precip01.consumerStatus === 'live' && WEATHER_AXES.temperature01.consumerStatus === 'live'
    );
    t.ok('⭐ precip01 defaults to 0 — LAW 5: a clear day is the neutral', WEATHER_AXES.precip01.fallback === 0);
    t.ok(
      'rain arrives brisker than it tapers',
      WEATHER_AXES.precip01.durationUpSec < WEATHER_AXES.precip01.durationDownSec
    );
    t.ok(
      'temperature is the SLOWEST axis in the table (thermal mass)',
      WEATHER_AXIS_NAMES.every((n) => WEATHER_AXES.temperature01.durationUpSec >= WEATHER_AXES[n].durationUpSec)
    );
    // ⚠️ THE STRUCTURAL GUARD: an enum can never be an eased axis.
    t.ok(
      '⭐ precipKindAuthored is NOT in the axis table — an enum cannot be eased',
      !Object.hasOwn(WEATHER_AXES, 'precipKindAuthored')
    );
    t.ok(
      'every axis in the table is still numeric (no enum crept in)',
      WEATHER_AXIS_NAMES.every((n) => Number.isFinite(WEATHER_AXES[n].fallback))
    );
  }

  // ---- the closed list ---------------------------------------------------------
  {
    t.ok('the kind list contains auto plus six species', PRECIP_KINDS.length === 7 && PRECIP_KINDS[0] === 'auto');
    t.ok('sleet is IN the enum (the band needs somewhere to land)', PRECIP_KINDS.includes('sleet'));
  }

  // ---- ⭐ the sleet band, closed at both ends ----------------------------------
  {
    const { coldEdge, warmEdge } = PRECIP_SLEET_BAND;
    t.ok('the band is ordered and non-empty', warmEdge > coldEdge);

    t.ok('well below the band is pure snow', derivePrecipKind('auto', 0.05).kind === 'snow');
    t.ok('well above the band is pure rain', derivePrecipKind('auto', 0.9).kind === 'rain');
    t.ok('the middle of the band is sleet', derivePrecipKind('auto', (coldEdge + warmEdge) / 2).kind === 'sleet');

    // ⚠️ `feedback_half_open_band_excludes_its_own_member`: BOTH edges must be
    // members of the band, or the one input that should be most sleet-like
    // reads as not sleet at all.
    t.ok('⭐ the COLD edge is IN the band, not below it', derivePrecipKind('auto', coldEdge).kind === 'sleet');
    t.ok('⭐ the WARM edge is IN the band, not above it', derivePrecipKind('auto', warmEdge).kind === 'sleet');

    // The mix weight ramps across it, cold end = all snow.
    t.ok(
      'mixWeight is 1 (all snow) at the cold edge',
      Math.abs(derivePrecipKind('auto', coldEdge).mixWeight - 1) < 1e-9
    );
    t.ok('mixWeight is 0 (all rain) at the warm edge', Math.abs(derivePrecipKind('auto', warmEdge).mixWeight) < 1e-9);
    t.ok(
      'mixWeight is 0.5 at the midpoint',
      Math.abs(derivePrecipKind('auto', (coldEdge + warmEdge) / 2).mixWeight - 0.5) < 1e-9
    );
    t.ok(
      'mixWeight ramps monotonically DOWN as it warms',
      derivePrecipKind('auto', coldEdge + 0.01).mixWeight > derivePrecipKind('auto', warmEdge - 0.01).mixWeight
    );
    // A consumer multiplies by mixWeight unconditionally, so it must be defined
    // and sane for every answer, not only for sleet.
    t.ok('pure snow reports mixWeight 1', derivePrecipKind('auto', 0).mixWeight === 1);
    t.ok('pure rain reports mixWeight 0', derivePrecipKind('auto', 1).mixWeight === 0);
  }

  // ---- authored beats derived ---------------------------------------------------
  {
    t.ok(
      '⭐ an authored kind wins at ANY temperature (LAW 4)',
      derivePrecipKind('snow', 0.95).kind === 'snow' && derivePrecipKind('rain', 0.0).kind === 'rain'
    );
    t.ok('an authored answer says so', derivePrecipKind('snow', 0.9).authored === true);
    t.ok('a derived answer says so too', derivePrecipKind('auto', 0.9).authored === false);
    t.ok('authored snow still reports full cold mixWeight', derivePrecipKind('snow', 0.9).mixWeight === 1);
    t.ok(
      'authored ash is honoured even though it is not a built species yet',
      derivePrecipKind('ash', 0.5).kind === 'ash'
    );
    // Fail-open: garbage falls back to the derivation, never throws.
    t.ok(
      'an unknown authored kind falls through to the derivation',
      derivePrecipKind('nonsense', 0.05).kind === 'snow'
    );
    t.ok(
      'a non-finite temperature yields a sane default rather than NaN',
      ['rain', 'snow', 'sleet'].includes(derivePrecipKind('auto', NaN).kind)
    );
  }

  // ---- the manager's own wiring --------------------------------------------------
  {
    const mgr = createWeatherManager();
    // LAW 5 survives the new axes.
    const snap = mgr.toSnapshotWeather();
    t.ok('⭐ LAW 5: a fresh manager is still a clear, dry sky', snap.precip01 === 0 && snap.cloudCover01 === 0);
    t.ok('a dry default still names a kind rather than null', typeof snap.precipKind === 'string');
    t.ok('the default authored kind is auto', snap.precipKindAuthored === 'auto');

    const set = mgr.setPrecipKindAuthored('snow');
    t.ok('setting a known kind is accepted', set.ok === true && set.kind === 'snow');
    t.ok('the snapshot reflects the authored kind immediately', mgr.toSnapshotWeather().precipKind === 'snow');

    const bad = mgr.setPrecipKindAuthored('sleeeet');
    t.ok(
      'an unknown kind fails open to auto WITH a reason',
      bad.ok === false && bad.kind === 'auto' && /unknown/.test(bad.reason)
    );
    t.ok('after the fallback the derivation is back in charge', mgr.toSnapshotWeather().precipKindAuthored === 'auto');

    // precip01 eases like every other axis.
    mgr.setTargets({ precip01: 1 });
    t.ok('precip01 accepts a target', mgr.read().targets.precip01 === 1);
    t.ok('and does not teleport there', mgr.read().state.precip01 === 0);
    // ⚠️ "LOOKS done" (95%, the declared 30s) and "HAS ARRIVED" (within the
    // 1/500 epsilon, so `settling` finally goes false) are different questions,
    // and this test asked the wrong one first: an exponential needs ~6.2τ to
    // reach 1/500, i.e. roughly twice the declared duration. That is the
    // designed behaviour (`SETTLE_TAUS`'s own note), not a slow ease.
    for (let i = 0; i < 60 * 30; i++) mgr.tick(1 / 60);
    t.ok('precip01 LOOKS done after its declared 30s duration (95%)', mgr.read().state.precip01 > 0.94);
    for (let i = 0; i < 60 * 60; i++) mgr.tick(1 / 60);
    t.ok('precip01 fully ARRIVES (epsilon-snaps) a while after that', mgr.read().state.precip01 === 1);
    t.ok('and `settling` is finally false', mgr.read().settling === false);

    // The status block prints every factor, not just the answer.
    const st = mgr.getStatus();
    t.ok('status reports the derived kind', typeof st.precipitation.kind === 'string');
    t.ok('status reports the temperature that decided it', Number.isFinite(st.precipitation.temperature01));
    t.ok(
      'status reports the band itself, so a reader can check the arithmetic',
      st.precipitation.sleetBand.coldEdge === PRECIP_SLEET_BAND.coldEdge
    );
  }

  // ---- ⭐ THE SHELF: clicking a named sky must deliver what it promises ---------
  // Author-reported: *"I can't get snow to appear by clicking on the snow
  // button."* It set a snow SKY (cover 0.9, precip 0.6) but `precipKind` is
  // DERIVED from `temperature01`, archetypes deliberately never set temperature
  // (a sky is not a climate), and the 0.55 default is well clear of the sleet
  // band — so snow fell as rain. The row now AUTHORS its kind, which LAW 4
  // says beats the derivation.
  {
    const mgr = createWeatherManager();
    mgr.applyArchetype('snow', { immediate: true });
    const snowy = mgr.toSnapshotWeather();
    t.ok('⭐ clicking SNOW actually yields snow', snowy.precipKind === 'snow');
    t.ok('...and says it was authored, not derived', snowy.precipKindAuthored === 'snow');
    t.ok('...and it is genuinely precipitating', snowy.precip01 > 0);
    t.ok(
      '...without the row having overwritten the climate',
      mgr.read().targets.temperature01 === WEATHER_AXES.temperature01.fallback
    );

    // ⚠️ THE OTHER HALF: a row that does NOT name a kind must RESET to auto,
    // or the map stays frozen forever after one snow click.
    mgr.applyArchetype('steady-rain', { immediate: true });
    const wet = mgr.toSnapshotWeather();
    t.ok('⭐ clicking STEADY-RAIN afterwards returns control to temperature', wet.precipKindAuthored === 'auto');
    t.ok('...and it rains rather than staying snow', wet.precipKind === 'rain');

    mgr.applyArchetype('clear', { immediate: true });
    t.ok('clicking CLEAR stops the precipitation entirely', mgr.toSnapshotWeather().precip01 === 0);
  }

  // ---- events compose onto temperature, and that changes what falls -------------
  {
    const mgr = createWeatherManager();
    mgr.jumpTo({ temperature01: 0.9, precip01: 0.8 });
    t.ok('a warm map rains', mgr.toSnapshotWeather().precipKind === 'rain');
    mgr.addEvent({
      kind: 'mana-storm',
      envelope: { attackSec: 0, sustainSec: 'held', releaseSec: 1 },
      overrides: [{ axis: 'temperature01', op: 'set', value: 0.05 }],
    });
    mgr.tick(1 / 60);
    // ⚠️ This is why the derivation reads the COMPOSED temperature: an event
    // that freezes the map must actually change what falls out of the sky.
    t.ok('⭐ an event that freezes the map turns the rain to snow', mgr.toSnapshotWeather().precipKind === 'snow');
    t.ok(
      'the BASE temperature is still untouched (the overlay guarantee holds)',
      mgr.read().state.temperature01 === 0.9
    );
  }
}
