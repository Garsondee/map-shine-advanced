/**
 * Node verification for foundry/scene-tiles.js — picking a Tile to safely
 * ping for the editing-cadence perf stress test, and the ping/unping calls
 * themselves.
 *
 * These are deliberately thin: the module has almost no logic of its own (it
 * exists to keep a live Foundry document write inside src/foundry/, not to
 * compute anything), so the tests pin the two things that actually matter —
 * DETERMINISTIC tile choice (repeated runs must hit the same tile) and that
 * ping/unping never throw just because there is nothing to mutate.
 */
import { pickStressTestTile, pingStressTestTile, unpingStressTestTile } from '../scene-tiles.js';

const mkTile = (id) => ({ id, update: async () => {}, unsetFlag: async () => {} });

export async function run(t) {
  const { ok } = t;

  // ---- pickStressTestTile ---------------------------------------------
  {
    ok('null sceneDoc -> null, never throws', pickStressTestTile(null) === null);
    ok('sceneDoc with no tiles field -> null', pickStressTestTile({}) === null);
    ok('sceneDoc.tiles = [] -> null', pickStressTestTile({ tiles: [] }) === null);
  }
  {
    const a = mkTile('a');
    const b = mkTile('b');
    ok('a plain array of tiles picks the FIRST one', pickStressTestTile({ tiles: [a, b] })?.id === 'a');
    // Repeated calls against the SAME sceneDoc must agree — the whole point
    // of "deterministic, not random" is that two runs are comparable.
    const first = pickStressTestTile({ tiles: [a, b] });
    const second = pickStressTestTile({ tiles: [a, b] });
    ok('picking twice from the same scene agrees', first === second);
  }
  {
    // The real shape: an EmbeddedCollection (Map subclass) — tolerated via
    // .values(), same as scene-layers.js's own private tileDocsOf.
    const a = mkTile('a');
    const b = mkTile('b');
    const collection = new Map([
      ['a', a],
      ['b', b],
    ]);
    ok('an EmbeddedCollection-shaped tiles field is tolerated', pickStressTestTile({ tiles: collection })?.id === 'a');
  }

  // ---- pingStressTestTile / unpingStressTestTile -----------------------
  {
    const calls = [];
    const tile = {
      id: 't1',
      update: async (patch) => calls.push(['update', patch]),
      unsetFlag: async (moduleId, key) => calls.push(['unsetFlag', moduleId, key]),
    };
    const pinged = await pingStressTestTile(tile, 'map-shine-advanced', '__perfStressPing');
    ok('pingStressTestTile reports success', pinged === true);
    ok(
      'the update call writes the scoped flag path, nothing else',
      calls[0][0] === 'update' &&
        Object.keys(calls[0][1]).length === 1 &&
        calls[0][1]['flags.map-shine-advanced.__perfStressPing'] === true
    );
    const unpinged = await unpingStressTestTile(tile, 'map-shine-advanced', '__perfStressPing');
    ok('unpingStressTestTile reports success', unpinged === true);
    ok(
      'the unsetFlag call carries the same moduleId/key back',
      calls[1][0] === 'unsetFlag' && calls[1][1] === 'map-shine-advanced' && calls[1][2] === '__perfStressPing'
    );
  }
  {
    // ⚠️ NEVER THROW for "nothing to mutate" — a stress test skip-path must
    // not itself become the reason a report fails.
    ok(
      'pingStressTestTile(null, ...) resolves false, does not throw',
      (await pingStressTestTile(null, 'm', 'k')) === false
    );
    ok(
      'pingStressTestTile against a tile with no update() resolves false',
      (await pingStressTestTile({ id: 'x' }, 'm', 'k')) === false
    );
    ok(
      'unpingStressTestTile(null, ...) resolves false, does not throw',
      (await unpingStressTestTile(null, 'm', 'k')) === false
    );
    ok(
      'unpingStressTestTile against a tile with no unsetFlag() resolves false',
      (await unpingStressTestTile({ id: 'x' }, 'm', 'k')) === false
    );
  }
}
