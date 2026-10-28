/**
 * Node verification for foundry/flag-keys.js and the two readers that use it
 * (fade-persistence.js, cues-persistence.js). The nested input below is the
 * exact shape a live Foundry 14 scene returned for a flat
 * `{ 'weather.cloudCover01': {...} }` write (UI test pass, 2026-09-26).
 */
import { flattenDottedLeaves, hasOwnTo, nestDottedKeys } from '../flag-keys.js';
import { readFadeState, writeFadeState, fadeStateFlagValue } from '../fade-persistence.js';
import { readCueStack } from '../cues-persistence.js';

const entry = (to) => ({ from: 0, to, type: 'float', startedAtMs: 1, overMs: 5000, curve: 'ease' });

function withScene(flags, fn) {
  const prior = globalThis.canvas;
  globalThis.canvas = { scene: { getFlag: (ns, key) => flags[`${ns}.${key}`] } };
  try {
    return fn();
  } finally {
    globalThis.canvas = prior;
  }
}

/** A stand-in for Foundry 14's `foundry.data.operators.ForcedReplacement`. */
class FakeReplace {
  constructor(value) {
    this.value = value;
  }
  static create(value) {
    return new FakeReplace(value);
  }
}

export async function run(t) {
  const nested = { weather: { cloudCover01: entry(0.6), precip01: entry(0.2) } };
  const flat = flattenDottedLeaves(nested, hasOwnTo);
  t.ok(
    'nested flag shape flattens back to dotted keys',
    Object.keys(flat).sort().join() === 'weather.cloudCover01,weather.precip01'
  );
  t.ok(
    'leaf values are kept whole',
    flat['weather.cloudCover01'].to === 0.6 && flat['weather.cloudCover01'].overMs === 5000
  );

  const alreadyFlat = { 'weather.cloudCover01': entry(0.3) };
  t.ok(
    'already-flat input passes through unchanged',
    flattenDottedLeaves(alreadyFlat, hasOwnTo)['weather.cloudCover01'].to === 0.3
  );
  t.ok(
    'deeper nesting joins every level',
    'effects.water.depth' in flattenDottedLeaves({ effects: { water: { depth: entry(1) } } }, hasOwnTo)
  );
  t.ok('non-object input is an empty map', Object.keys(flattenDottedLeaves(null, hasOwnTo)).length === 0);
  t.ok('array input is an empty map', Object.keys(flattenDottedLeaves([1, 2], hasOwnTo)).length === 0);

  withScene({ 'map-shine-advanced.fadeState': nested }, () => {
    const { state } = readFadeState();
    t.ok('readFadeState repairs the nested flag', state['weather.precip01']?.to === 0.2 && !('weather' in state));
  });

  // nestDottedKeys is flattenDottedLeaves run backwards.
  const flatState = { 'weather.precip01': entry(0.1), 'wind.perceived01': entry(0.4), plain: entry(1) };
  const renested = nestDottedKeys(flatState);
  t.ok(
    'nestDottedKeys builds the shape Foundry would expand to',
    renested.weather.precip01.to === 0.1 && renested.wind.perceived01.to === 0.4 && renested.plain.to === 1
  );
  const roundTrip = flattenDottedLeaves(renested, hasOwnTo);
  t.ok(
    'nest → flatten round-trips every key',
    Object.keys(roundTrip).sort().join() === Object.keys(flatState).sort().join()
  );
  t.ok('nestDottedKeys of nothing is an empty map', Object.keys(nestDottedKeys(null)).length === 0);

  // THE 2026-10-27 BUG: a plain setFlag merges, so a key dropped from the
  // in-memory state (a finished fade, a deleted legacy key) stayed stored.
  // The write must be a whole replacement.
  const priorFoundry = globalThis.foundry;
  globalThis.foundry = { data: { operators: { ForcedReplacement: FakeReplace } } };
  try {
    const value = fadeStateFlagValue({ 'wind.perceived01': entry(0) });
    t.ok('the fade flag is written as a ForcedReplacement', value instanceof FakeReplace);
    t.ok(
      'the replacement holds the nested map, and only the keys given',
      value.value.wind.perceived01.to === 0 && !('weather' in value.value)
    );

    let written = null;
    const priorCanvas = globalThis.canvas;
    globalThis.canvas = {
      scene: {
        setFlag: async (ns, key, v) => {
          written = { ns, key, v };
        },
      },
    };
    try {
      const res = await writeFadeState({ 'wind.perceived01': entry(0) });
      t.ok('writeFadeState reports success', res.ok === true);
      t.ok(
        'writeFadeState passes the replacement to setFlag',
        written?.ns === 'map-shine-advanced' && written?.key === 'fadeState' && written?.v instanceof FakeReplace
      );
    } finally {
      globalThis.canvas = priorCanvas;
    }
  } finally {
    globalThis.foundry = priorFoundry;
  }
  const noFoundry = fadeStateFlagValue({ 'weather.precip01': entry(0.5) });
  t.ok(
    'outside Foundry the plain nested map is written',
    !(noFoundry instanceof FakeReplace) && noFoundry.weather.precip01.to === 0.5
  );

  const storedCues = [{ id: 'cue-1', name: 'Storm', order: 0, targets: nested }];
  withScene({ 'map-shine-advanced.cueStack': storedCues }, () => {
    const { cues } = readCueStack();
    t.ok('readCueStack repairs each cue’s nested targets', cues[0].targets['weather.cloudCover01']?.to === 0.6);
    t.ok(
      'readCueStack keeps the other cue fields',
      cues[0].id === 'cue-1' && cues[0].name === 'Storm' && cues[0].order === 0
    );
  });
  withScene({}, () => {
    t.ok('no stored stack reads as empty', readCueStack().cues.length === 0);
  });
}
