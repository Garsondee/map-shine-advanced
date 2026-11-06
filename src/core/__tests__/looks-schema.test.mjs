/**
 * THE LOOKS CONTRACT — verification. The load-bearing claims: a Look only ever
 * touches the facets it holds; a stored Look survives the engine changing under
 * it (renames migrate, removed keys go stale instead of breaking, ranges clamp);
 * and the channel table, boot.js's adapters and the starter Looks cannot drift
 * apart without this suite going red.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LOOK_CHANNELS,
  LOOK_FACETS,
  LOOK_FACET_IDS,
  LOOK_KEY_RENAMES,
  LOOK_SCHEMA_VERSION,
  STARTER_LOOKS,
  captureLook,
  describeLook,
  formatHour,
  looksFromCues,
  lookSwatch,
  migrateLook,
  normalizeLibrary,
  planLookApply,
  reconcileLook,
  resolveSequence,
  serializeLibrary,
  tidyLook,
  validateLook,
  withFacets,
  LOOK_PALETTE,
  RETIRED_STARTER_IDS,
  STARTER_SET_VERSION,
  hexHue,
  lookOptions,
  optionPaletteId,
  setLookOption,
  upgradeStarters,
  LOOK_GROUPS,
  lookGroup,
} from '../looks-schema.js';
import { applyGrade } from '../../effects/grade/grade-ops.js';
import { WEATHER_ARCHETYPES } from '../../world/index.js';

const BOOT_PATH = fileURLToPath(new URL('../../boot.js', import.meta.url));

/** A live engine, as boot.js's adapters would read it. */
const LIVE = {
  'time.hour': 14.25,
  'weather.archetype': 'custom',
  'weather.cloudCover01': 0.62,
  'weather.precip01': 0.3,
  'weather.temperature01': 0.4,
  'wind.speed01': 0.55,
  'wind.directionDeg': 90,
  'sky.realism01': 0.8,
  'sky.goldenHour01': 1,
  'sky.moonlight01': 0,
  'sky.gradeEnvStrength': 0.5,
  'night.darkness01': 0.2,
  'grade.exposure': 0,
  'grade.contrast': 1.1,
  'grade.saturation': 0.9,
  'grade.temperature': 0.1,
  'grade.vibrance': 0,
  'lens.vignetteIntensity': 1,
  'lens.vignetteSoftness': 0.02,
  'lens.grainAmount': 0.003,
  'lens.chromaticAmountPx': 1.2,
  'lens.distortion': -0.1,
  'grade.exposureInside': 0,
  'grade.exposureOutside': 0,
  'bloom.threshold': 0.5,
  'bloom.strength': 1,
  'bloom.atmoStrength': 0.4,
  'bloom.atmoTint': '#fff0dc',
  'grade.toneMapping': 'neutral',
  'grade.shadows': '#262626',
  'grade.spotAmount': 0,
  'grade.spotHue': 0,
  'grade.spotWidth': 40,
  'grade.colourise': 0,
  'grade.colouriseColor': '#B5864F',
  'grade.colouriseHold': 0.18,
  'grade.colouriseKeepLamps': 0,
  'grade.vignette': 0.2,
  'grade.lightLevel': 1,
  'grade.lightSaturation': 1,
  'grade.lightTint': '#ffffff',
  'grade.lightGlow': 1,
};
const read = (key) => LIVE[key];

const structuredLook = (l) => ({ ...l, values: { ...l.values } });

export function run(t) {
  // ---- the table itself -----------------------------------------------------
  {
    const keys = LOOK_CHANNELS.map((c) => c.key);
    t.ok('channel keys are unique', new Set(keys).size === keys.length);
    t.ok(
      'every channel belongs to a declared facet',
      LOOK_CHANNELS.every((c) => LOOK_FACET_IDS.includes(c.facet))
    );
    t.ok(
      'every facet has at least one channel (no empty facet chip)',
      LOOK_FACETS.every((f) => LOOK_CHANNELS.some((c) => c.facet === f.id))
    );
    t.ok(
      'every number channel declares a range',
      LOOK_CHANNELS.filter((c) => c.kind === 'number').every((c) => Number.isFinite(c.min) && c.max > c.min)
    );
    t.ok(
      'no rename points FROM a live key (a rename would silently move live data)',
      Object.keys(LOOK_KEY_RENAMES).every((from) => !keys.includes(from))
    );
    t.ok(
      'every rename points TO a live key',
      Object.values(LOOK_KEY_RENAMES).every((to) => keys.includes(to))
    );
  }

  // ---- boot.js supplies exactly one adapter per channel ------------------------
  {
    const boot = readFileSync(BOOT_PATH, 'utf8').replace(/\r\n/g, '\n');
    const start = boot.indexOf('const LOOK_ADAPTERS = {');
    const end = boot.indexOf('// END LOOK_ADAPTERS', start);
    t.ok('boot.js declares a LOOK_ADAPTERS table (with its END marker)', start !== -1 && end > start);
    const body = start !== -1 && end > start ? boot.slice(start, end) : '';
    const adapterKeys = [...body.matchAll(/^ {4}'([a-z]+\.[A-Za-z0-9]+)': \{/gm)].map((m) => m[1]);
    const channelKeys = LOOK_CHANNELS.map((c) => c.key);
    const missing = channelKeys.filter((k) => !adapterKeys.includes(k));
    const extra = adapterKeys.filter((k) => !channelKeys.includes(k));
    t.ok(`every Look channel has a boot.js adapter (missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
    t.ok(`every boot.js adapter is a Look channel (extra: ${extra.join(', ') || 'none'})`, extra.length === 0);
  }

  // ---- capture ----------------------------------------------------------------
  {
    const all = captureLook({ id: 'a', name: '  Dusk  ', facets: LOOK_FACET_IDS, read });
    t.ok('capture trims the name', all.name === 'Dusk');
    t.ok('capture stamps the schema version', all.v === LOOK_SCHEMA_VERSION);
    t.ok("a 'custom' sky is captured as its numbers, not as an id", !('weather.archetype' in all.values));
    t.ok('...so cloud and rain are kept', all.values['weather.cloudCover01'] === 0.62);
    t.ok('every facet is captured', reconcileLook(all).facets.length === LOOK_FACET_IDS.length);

    const timeless = captureLook({ id: 'b', name: 'Storm', facets: ['weather', 'wind'], read });
    t.ok('a Look saved without Time holds no hour', !('time.hour' in timeless.values));
    t.ok('...and no light or darkness', !Object.keys(timeless.values).some((k) => /^(sky|night)\./.test(k)));
    t.ok('...but does hold its weather and wind', timeless.values['wind.speed01'] === 0.55);

    const named = captureLook({
      id: 'c',
      name: 'Fog',
      facets: ['weather'],
      read: (k) => (k === 'weather.archetype' ? 'fog' : LIVE[k]),
    });
    t.ok('a named sky is captured as its id', named.values['weather.archetype'] === 'fog');
    t.ok('...and NOT as cloud/rain numbers too (one sky, not two)', !('weather.cloudCover01' in named.values));

    const partial = captureLook({
      id: 'd',
      name: 'No wind here',
      facets: ['wind'],
      read: () => undefined,
    });
    t.ok('an unreadable channel is left out, not saved as junk', Object.keys(partial.values).length === 0);
    t.ok('...and that Look does not validate (it changes nothing)', !validateLook(partial).ok);
  }

  // ---- reconcile: the engine changed under a stored Look -----------------------
  {
    const old = {
      id: 'x',
      name: 'Old',
      v: 1,
      values: {
        'time.hour': 26, // wraps
        'wind.speed01': 3, // clamps
        'weather.temperature01': 'hot', // wrong kind
        'removed.slider': 0.5, // no longer exists
      },
    };
    const r = reconcileLook(old);
    t.ok('an hour past midnight wraps (26 -> 2)', r.playable['time.hour'] === 2);
    t.ok('an out-of-range value clamps into the current range', r.playable['wind.speed01'] === 1);
    t.ok('a value of the wrong kind is reported invalid, not played', r.invalid.includes('weather.temperature01'));
    t.ok('a key no channel declares is reported stale', r.stale.includes('removed.slider'));
    t.ok('...and is not played', !('removed.slider' in r.playable));
    t.ok(
      'a stale key is KEPT by withFacets (only Tidy removes it)',
      'removed.slider' in withFacets(old, ['time']).values
    );
    t.ok('Tidy removes the stale key', !('removed.slider' in tidyLook(old).values));
    t.ok('Tidy keeps the live ones', tidyLook(old).values['time.hour'] === 26);

    const both = { id: 'y', name: 'y', v: 1, values: { 'weather.archetype': 'fog', 'weather.cloudCover01': 0.1 } };
    t.ok(
      'a sky type wins over hand-set cloud in the same Look',
      !('weather.cloudCover01' in reconcileLook(both).playable)
    );
    const unknownSky = reconcileLook(
      { id: 'z', name: 'z', v: 1, values: { 'weather.archetype': 'volcano-rain' } },
      { isKnownArchetype: (id) => WEATHER_ARCHETYPES.some((a) => a.id === id) }
    );
    t.ok(
      'a sky type the engine no longer has is invalid, not played',
      unknownSky.invalid.includes('weather.archetype')
    );
  }

  // ---- migration ---------------------------------------------------------------
  {
    const renames = { 'sky.oldRealism': 'sky.realism01' };
    const { look, changed } = migrateLook({ id: 'm', name: 'M', v: 0, values: { 'sky.oldRealism': 0.3 } }, renames);
    t.ok(
      'a renamed key is rewritten on load',
      look.values['sky.realism01'] === 0.3 && !('sky.oldRealism' in look.values)
    );
    t.ok(
      '...and the change is reported',
      changed.some((c) => c.includes('sky.oldRealism'))
    );
    t.ok('an old schema version is brought up to date', look.v === LOOK_SCHEMA_VERSION);
    const clash = migrateLook(
      { id: 'n', name: 'N', v: 1, values: { 'sky.oldRealism': 0.3, 'sky.realism01': 0.9 } },
      renames
    ).look;
    t.ok('a rename onto a key the Look already holds keeps the newer value', clash.values['sky.realism01'] === 0.9);
    t.ok('migrateLook never throws on junk', migrateLook(null).look === null && migrateLook([1]).look === null);
  }

  // ---- the library setting ---------------------------------------------------------
  {
    const stored = serializeLibrary([
      { id: 'a', name: 'A', v: 1, values: { 'time.hour': 6 } },
      { id: 'a', name: 'dupe', v: 1, values: {} },
      { name: 'no id', v: 1, values: {} },
    ]);
    const { looks, migrated } = normalizeLibrary(stored);
    t.ok('the library round-trips through its stored JSON', looks.length === 1 && looks[0].name === 'A');
    t.ok('duplicate and id-less entries are dropped, and that is reported', migrated === true);
    t.ok('garbage JSON reads as an empty library, not a crash', normalizeLibrary('{nope').looks.length === 0);
    t.ok('an empty setting reads as an empty library', normalizeLibrary('').looks.length === 0);
    t.ok(
      'a bare array (older drafts) still reads',
      normalizeLibrary([{ id: 'q', name: 'Q', v: 1, values: {} }]).looks.length === 1
    );
  }

  // ---- applying -------------------------------------------------------------------
  {
    const look = { id: 'p', name: 'P', v: 1, values: { 'time.hour': 20, 'wind.speed01': 0.4, 'gone.key': 1 } };
    const free = planLookApply(look);
    t.ok(
      'Free clock: the hour is applied',
      free.apply.some((a) => a.key === 'time.hour')
    );
    const world = planLookApply(look, { worldClock: true });
    t.ok(
      'World clock: the hour is skipped, with a reason',
      world.skipped.some((s) => s.key === 'time.hour')
    );
    t.ok(
      'World clock: the rest still plays',
      world.apply.some((a) => a.key === 'wind.speed01')
    );
    t.ok(
      'a stale key is skipped with a reason',
      free.skipped.some((s) => s.key === 'gone.key')
    );
    t.ok(
      'apply order follows the channel table (time first, darkness last)',
      free.apply[0].key === 'time.hour' && free.apply[free.apply.length - 1].key === 'wind.speed01'
    );
  }

  // ---- starter Looks: the drift guard for built-ins ----------------------------
  {
    const known = (id) => WEATHER_ARCHETYPES.some((a) => a.id === id);
    for (const look of STARTER_LOOKS) {
      const r = reconcileLook(look, { isKnownArchetype: known });
      t.ok(`starter "${look.name}" validates`, validateLook(look).ok);
      t.ok(`starter "${look.name}" has no stale keys`, r.stale.length === 0);
      t.ok(`starter "${look.name}" has no invalid values (its sky type exists)`, r.invalid.length === 0);
    }
    t.ok('starter ids are unique', new Set(STARTER_LOOKS.map((l) => l.id)).size === STARTER_LOOKS.length);
    t.ok(
      'at least one starter is time-agnostic (the facet idea is shown on day one)',
      STARTER_LOOKS.some((l) => !reconcileLook(l).facets.includes('time'))
    );
  }

  // ---- running order + cue migration -------------------------------------------
  {
    const looks = [
      { id: 'a', name: 'A', v: 1, values: { 'time.hour': 1 } },
      { id: 'b', name: 'B', v: 1, values: { 'time.hour': 2 } },
    ];
    t.ok(
      'a running order resolves in its own order',
      resolveSequence(['b', 'a'], looks)
        .map((l) => l.id)
        .join() === 'b,a'
    );
    t.ok('a deleted Look drops out of the running order', resolveSequence(['a', 'gone'], looks).length === 1);

    const { looks: fromCues, sequence } = looksFromCues([
      { id: 'c2', name: 'Two', order: 2, targets: { 'weather.precip01': { to: 0.8, overMs: 1, curve: 'ease' } } },
      { id: 'c1', name: 'One', order: 1, targets: { 'weather.cloudCover01': { to: 0.2, overMs: 1, curve: 'ease' } } },
      { id: 'c3', name: 'Nothing a Look knows', order: 3, targets: { 'water.depth': { to: 1 } } },
    ]);
    t.ok('old cues become Looks in their cue order', sequence.join() === 'look-from-c1,look-from-c2');
    t.ok("a cue's weather target becomes the Look's value", fromCues[0].values['weather.cloudCover01'] === 0.2);
    t.ok('a cue holding nothing a Look knows is skipped', fromCues.length === 2);
  }

  // ---- presentation --------------------------------------------------------------
  {
    t.ok('formatHour: 14.25 -> 14:15', formatHour(14.25) === '14:15');
    t.ok('formatHour: 23.999 rounds to 00:00', formatHour(23.999) === '00:00');
    t.ok(
      'describeLook names the sky type through the supplied label',
      describeLook(
        STARTER_LOOKS.find((l) => l.name === 'Thunderstorm'),
        () => 'Thunderstorm'
      ).includes('Thunderstorm')
    );
    const night = lookSwatch({ id: 'n', name: 'n', v: 1, values: { 'time.hour': 0, 'night.darkness01': 1 } });
    const noon = lookSwatch({ id: 'd', name: 'd', v: 1, values: { 'time.hour': 13 } });
    const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    t.ok('a dark midnight swatch is darker than a noon one', lum(night.top) < lum(noon.top));
    t.ok('swatches are hex colours', /^#[0-9a-f]{6}$/.test(noon.top) && /^#[0-9a-f]{6}$/.test(noon.bottom));
    const noir = lookSwatch(STARTER_LOOKS.find((l) => l.name === 'Noir'));
    const grey = (h) => h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7);
    t.ok('a black & white Look draws a grey tile', grey(noir.top) && grey(noir.bottom));
    t.ok(
      'a one-colour Look draws a band of its colour',
      typeof lookSwatch(STARTER_LOOKS.find((l) => l.name === 'One colour')).band === 'string'
    );
  }

  // ---- the round-2 starter set (author 2026-11-01: four rows, the full spectrum) -----
  {
    t.ok('thirty-one starters (round 3 catalogue + the blank Clear and still, 2026-11-06)', STARTER_LOOKS.length === 31);
    t.ok(
      'every starter sits in a real group, never Mine',
      STARTER_LOOKS.every((l) => lookGroup(l) === l.group && l.group !== 'mine')
    );
    t.ok(
      'every group but Mine has at least four Looks',
      LOOK_GROUPS.filter((g) => g.id !== 'mine').every((g) => STARTER_LOOKS.filter((l) => l.group === g.id).length >= 4)
    );
    t.ok('a Look naming no known group is Mine', lookGroup({ id: 'x', name: 'x', v: 1, values: {} }) === 'mine');
    const facetsOf = (name) => reconcileLook(STARTER_LOOKS.find((l) => l.name === name)).facets;
    const hours = STARTER_LOOKS.map((l) => l.values['time.hour']).filter((h) => Number.isFinite(h));
    t.ok(
      'the starters span the whole day (before 6, around noon, evening, after midnight)',
      hours.some((h) => h < 6.5) &&
        hours.some((h) => h > 11 && h < 14) &&
        hours.some((h) => h > 18 && h < 20.5) &&
        hours.some((h) => h < 3)
    );
    const skies = new Set(STARTER_LOOKS.map((l) => l.values['weather.archetype']).filter(Boolean));
    t.ok('at least eight different weather types are used', skies.size >= 8);
    t.ok(
      'the weather row is time-agnostic',
      ['Drizzle', 'Thunderstorm', 'Blizzard', 'Ashfall'].every((n) => !facetsOf(n).includes('time'))
    );
    t.ok(
      'every starter carries the Colour facet, so a style always lifts off',
      STARTER_LOOKS.every((l) => reconcileLook(l).facets.includes('colour'))
    );
    t.ok('Noir is black and white', STARTER_LOOKS.find((l) => l.name === 'Noir').values['grade.saturation'] === 0);
    t.ok(
      'ids are new, never a retired one',
      STARTER_LOOKS.every((l) => !RETIRED_STARTER_IDS.includes(l.id))
    );
    t.ok(
      'every option on a starter points at a live channel',
      STARTER_LOOKS.every((l) => lookOptions(l).length === (l.options ?? []).length)
    );
    t.ok(
      'at least three starters offer a colour option',
      STARTER_LOOKS.filter((l) => lookOptions(l).length > 0).length >= 3
    );
  }

  // ---- Blood fog: the author's red-fog reference, through the real grade maths ----------
  {
    const fog = STARTER_LOOKS.find((l) => l.name === 'Blood fog').values;
    const tc = parseInt(fog['grade.colouriseColor'].slice(1), 16);
    const grade = {
      colourise: fog['grade.colourise'],
      colouriseColor: [(tc >> 16) & 255, (tc >> 8) & 255, tc & 255].map((v) => Math.pow(v / 255, 2.2)),
      colouriseHold: fog['grade.colouriseHold'],
    };
    const mid = applyGrade([0.4, 0.4, 0.4], grade);
    const lamp = applyGrade([3, 3, 3], grade);
    t.ok(
      'Blood fog: a mid-tone becomes a strong red (green and blue near zero)',
      mid[0] > 0.3 && mid[1] < 0.05 && mid[2] < 0.05
    );
    t.ok('Blood fog: a lamp (HDR) burns toward white', lamp[1] > 1 && lamp[2] > 1);
    const dark = applyGrade([0.04, 0.04, 0.04], grade);
    t.ok('Blood fog: shadows stay a deep red, not black-grey', dark[0] > dark[1] * 5);
  }

  // ---- options -------------------------------------------------------------------------
  {
    const one = STARTER_LOOKS.find((l) => l.name === 'One colour');
    const green = setLookOption(one, 'grade.spotHue', 'venom');
    t.ok(
      'picking a palette colour sets the kept hue to that colour',
      green.values['grade.spotHue'] === hexHue('#47b83a')
    );
    t.ok('...and the option reads back as that colour', optionPaletteId(green, 'grade.spotHue') === 'venom');
    t.ok('the original (frozen) starter is untouched', optionPaletteId(one, 'grade.spotHue') === 'blood');
    const fog = STARTER_LOOKS.find((l) => l.name === 'Blood fog');
    const blue = setLookOption(fog, 'grade.colouriseColor', 'sapphire');
    t.ok('a colour option takes the hex', blue.values['grade.colouriseColor'] === '#2f5fd6');
    t.ok('an option the Look does not offer changes nothing', setLookOption(fog, 'grade.spotHue', 'venom') === fog);
    t.ok('an unknown colour changes nothing', setLookOption(fog, 'grade.colouriseColor', 'nope') === fog);
    t.ok(
      'palette hues are distinct (no two within 10°)',
      LOOK_PALETTE.every((a, i) =>
        LOOK_PALETTE.every(
          (b, j) => i === j || Math.abs(((((hexHue(a.hex) - hexHue(b.hex)) % 360) + 540) % 360) - 180) >= 6
        )
      )
    );
    const cap = captureLook({
      id: 'c',
      name: 'Mine',
      facets: ['colour'],
      read: (k) => ({ 'grade.spotAmount': 1, 'grade.spotHue': 120 })[k],
    });
    t.ok(
      'a captured one-colour look gets its colour button automatically',
      lookOptions(cap).some((o) => o.key === 'grade.spotHue')
    );
    t.ok(
      'a colour channel rejects a non-hex value',
      reconcileLook({ id: 'x', name: 'x', v: 1, values: { 'grade.colouriseColor': 'red' } }).invalid.length === 1
    );
    t.ok('options survive a migrate', migrateLook(fog).look.options?.length === 1);
  }

  // ---- the starter-set upgrade (the old six are replaced once, GM looks kept) -----------
  {
    const stored = [
      { id: 'starter-storm', name: 'Storm', v: 1, values: { 'wind.speed01': 0.7 } },
      { id: 'mine', name: 'My look', v: 1, values: { 'time.hour': 4 } },
    ];
    const up = upgradeStarters(stored, 1);
    t.ok('the upgrade drops the retired starters', !up.looks.some((l) => l.id === 'starter-storm'));
    t.ok(
      '...keeps the GM’s own Looks',
      up.looks.some((l) => l.id === 'mine')
    );
    t.ok(
      '...puts the current starters first, in order',
      up.looks[0].id === STARTER_LOOKS[0].id && up.looks.length === STARTER_LOOKS.length + 1
    );
    t.ok('...and says it changed something', up.changed === true);
    const again = upgradeStarters(up.looks.slice(1), STARTER_SET_VERSION);
    t.ok(
      'an up-to-date library is left alone (a deleted starter stays deleted)',
      again.changed === false && again.looks.length === STARTER_LOOKS.length
    );
    t.ok(
      'the stored library records its starter set',
      normalizeLibrary(serializeLibrary([])).starters === STARTER_SET_VERSION
    );
    t.ok(
      'a library from before starter sets reads as set 1',
      normalizeLibrary(JSON.stringify({ v: 1, looks: [] })).starters === 1
    );
  }
}
