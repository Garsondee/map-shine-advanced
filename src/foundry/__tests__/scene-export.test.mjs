/**
 * Node verification for foundry/scene-export.js. Only the pure builders are
 * testable here — the live `canvas.scene.toObject()` read is browser-only,
 * same split as every other reader in this zone.
 */
import { buildSceneExportPayload, collectExportTexturePaths, sceneExportFilename } from '../scene-export.js';

const LEVEL = {
  _id: 'lvl1',
  name: 'Ground',
  elevation: { bottom: 0, top: 20 },
  background: { src: 'assets/ground.webp', tint: '#ffffff', alphaThreshold: 0.75 },
  foreground: { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
  sort: 0,
};
const TILE = { _id: 't1', texture: { src: 'assets/overhead.webp' }, x: 10, y: 20, elevation: 5, levels: [] };
const WALL = { _id: 'w1', c: [0, 0, 100, 0], door: 0, ds: 0, levels: [] };
const LIGHT = { _id: 'l1', x: 50, y: 50, elevation: 0, config: { dim: 20, bright: 10 } };
const REGION = { _id: 'r1', name: 'Cellar', shapes: [{ type: 'r', x: 0, y: 0, width: 10, height: 10 }], behaviors: [] };

export function run(t) {
  const { ok } = t;

  // ---- buildSceneExportPayload ---------------------------------------------
  {
    const raw = {
      name: 'Mythica Machina Mansion',
      width: 12000,
      height: 12000,
      grid: { size: 100 },
      environment: { darknessLevel: 0.2 },
      levels: [LEVEL],
      tiles: [TILE],
      walls: [WALL],
      lights: [LIGHT],
      regions: [REGION],
      // Not captured — must not leak into the payload:
      tokens: [{ _id: 'tok1' }],
      drawings: [{ _id: 'd1' }],
      ownership: { default: 0 },
    };
    const p = buildSceneExportPayload(raw);
    ok('scene.name passes through', p.scene.name === 'Mythica Machina Mansion');
    ok('scene.width passes through', p.scene.width === 12000);
    ok('scene.grid passes through by reference', p.scene.grid === raw.grid);
    ok('scene.environment passes through by reference', p.scene.environment === raw.environment);
    ok('levels[] passes through', p.levels.length === 1 && p.levels[0] === LEVEL);
    ok('tiles[] passes through', p.tiles.length === 1 && p.tiles[0] === TILE);
    ok('walls[] passes through', p.walls.length === 1 && p.walls[0] === WALL);
    ok('lights[] passes through', p.lights.length === 1 && p.lights[0] === LIGHT);
    ok('regions[] passes through', p.regions.length === 1 && p.regions[0] === REGION);
    ok('tokens are NOT captured (out of scope, named in the module header)', !('tokens' in p));
    ok('drawings are NOT captured', !('drawings' in p));
    ok('ownership is NOT captured', !('ownership' in p.scene));
  }

  // ---- buildSceneExportPayload — degenerate input --------------------------
  {
    const p = buildSceneExportPayload(null);
    ok('null input does not throw and yields empty collections', Array.isArray(p.levels) && p.levels.length === 0);
    ok('null input yields an empty scene object, not a crash', typeof p.scene === 'object' && p.scene !== null);
  }
  {
    const p = buildSceneExportPayload({ levels: 'not-an-array', walls: undefined });
    ok(
      'a non-array collection value reads as empty, never passed through raw',
      Array.isArray(p.levels) && p.levels.length === 0
    );
    ok('an absent collection key reads as empty', Array.isArray(p.walls) && p.walls.length === 0);
  }

  // ---- collectExportTexturePaths --------------------------------------------
  {
    const payload = buildSceneExportPayload({
      levels: [
        LEVEL,
        { ...LEVEL, _id: 'lvl2', background: { src: 'assets/ground.webp' }, foreground: { src: 'assets/roof.webp' } },
      ],
      tiles: [TILE, { texture: { src: 'assets/overhead.webp' } }, { texture: {} }],
    });
    const paths = collectExportTexturePaths(payload);
    ok('duplicate texture paths are deduplicated', paths.filter((p) => p === 'assets/ground.webp').length === 1);
    ok('a null foreground.src (Ground floor) contributes nothing', !paths.includes('null'));
    ok('a real foreground.src is captured', paths.includes('assets/roof.webp'));
    ok('a tile with no texture.src is skipped, not crashed on', paths.length === 3);
    ok('the result is sorted', JSON.stringify(paths) === JSON.stringify([...paths].sort()));
  }
  {
    const paths = collectExportTexturePaths({ levels: [], tiles: [] });
    ok('no levels/tiles yields an empty list, never throws', Array.isArray(paths) && paths.length === 0);
  }

  // ---- sceneExportFilename ---------------------------------------------------
  {
    const fixedClock = () => new Date('2026-08-10T12:34:56.000Z');
    const name = sceneExportFilename('Mythica Machina Mansion', fixedClock);
    ok(
      'filename is slugified, lowercased, and stamped',
      name === 'msa-scene-export-mythica-machina-mansion-2026-08-10_12-34-56.json'
    );
  }
  {
    const fixedClock = () => new Date('2026-01-01T00:00:00.000Z');
    ok(
      'a missing scene name falls back to "scene", never "undefined"',
      sceneExportFilename(null, fixedClock).startsWith('msa-scene-export-scene-')
    );
    ok(
      'an empty-after-slugify name also falls back to "scene"',
      sceneExportFilename('!!!', fixedClock).startsWith('msa-scene-export-scene-')
    );
  }
  {
    const clock = () => new Date('2026-08-10T00:00:00.000Z');
    ok(
      'time is an INJECTED parameter, not a private Date.now() sample',
      typeof sceneExportFilename('x', clock) === 'string'
    );
  }
}
