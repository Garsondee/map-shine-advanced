/**
 * Node verification for foundry/player-light-mode.js. `readTokenPlayerLightMode`
 * only ever calls the token document's own `getFlag` (a plain function, not a
 * real Foundry global), so it's testable against a fake document — no
 * `canvas`/`Hooks` needed. `writeTokenPlayerLightMode` similarly only calls
 * `setFlag`. `readActivePlayerCarriedLightTokens` is the one live,
 * `canvas.tokens.placeables`-reading export here and is NOT covered — same
 * split every other live reader in this zone follows.
 */
import { readTokenPlayerLightMode, writeTokenPlayerLightMode, PLAYER_LIGHT_MODES } from '../player-light-mode.js';

function fakeTokenDocument(initialMode) {
  let stored = initialMode ?? null;
  const calls = [];
  return {
    calls,
    getFlag: (ns, key) => (ns === 'map-shine-advanced' && key === 'playerLightMode' ? stored : undefined),
    setFlag: async (ns, key, value) => {
      calls.push({ ns, key, value });
      stored = value;
      return value;
    },
  };
}

export async function run(t) {
  const { ok } = t;

  ok('exactly six modes are declared', PLAYER_LIGHT_MODES.length === 6);
  ok(
    'torch/flashlight are among them',
    PLAYER_LIGHT_MODES.includes('torch') && PLAYER_LIGHT_MODES.includes('flashlight')
  );

  // ---- readTokenPlayerLightMode --------------------------------------
  ok('a token with no flag set reads as null', readTokenPlayerLightMode(fakeTokenDocument(null)) === null);
  ok('a token with a real mode reads it back', readTokenPlayerLightMode(fakeTokenDocument('torch')) === 'torch');
  ok(
    'a corrupt/unrecognized stored value reads as null, not passed through',
    readTokenPlayerLightMode(fakeTokenDocument('some-modded-value')) === null
  );
  ok('a null/undefined token document is total, not a throw', readTokenPlayerLightMode(null) === null);
  ok(
    'a document whose getFlag throws is total, not a throw',
    readTokenPlayerLightMode({
      getFlag: () => {
        throw new Error('boom');
      },
    }) === null
  );

  // ---- writeTokenPlayerLightMode --------------------------------------
  {
    const doc = fakeTokenDocument(null);
    const result = await writeTokenPlayerLightMode(doc, 'flashlight');
    ok('a real mode write reports ok', result.ok === true);
    ok('the write actually landed', readTokenPlayerLightMode(doc) === 'flashlight');
  }
  {
    const doc = fakeTokenDocument('torch');
    const result = await writeTokenPlayerLightMode(doc, null);
    ok('clearing (null) reports ok', result.ok === true);
    ok('clearing actually landed', readTokenPlayerLightMode(doc) === null);
  }
  {
    const doc = fakeTokenDocument(null);
    const result = await writeTokenPlayerLightMode(doc, 'not-a-real-mode');
    ok('an unrecognized mode is coerced to null rather than stored verbatim', result.ok === true);
    ok('the coerced write is null, not the garbage value', readTokenPlayerLightMode(doc) === null);
  }
  {
    const result = await writeTokenPlayerLightMode(null, 'torch');
    ok('writing to a missing token document fails softly', result.ok === false && typeof result.reason === 'string');
  }
  {
    const doc = {
      setFlag: async () => {
        throw new Error('not your token');
      },
    };
    const result = await writeTokenPlayerLightMode(doc, 'torch');
    ok('a rejected write (not the owner) fails softly, never throws', result.ok === false);
  }
}
