/**
 * Node verification for foundry/scene-occlusion-sources.js. Same split as
 * scene-environment.test.mjs: only the pure logic is tested here; the live
 * `canvas.dimensions` read is browser-only.
 */
import {
  deriveDistancePixels,
  deriveGridSizePixels,
  computeTokenOcclusionRadiusPx,
  deriveMouseHoverPoint,
} from '../scene-occlusion-sources.js';

export function run(t) {
  const { ok } = t;

  // ---- deriveDistancePixels: same "could not read" vs "read a real value"
  // discipline as deriveDarkness ----------------------------------------
  {
    const d = deriveDistancePixels(20);
    ok('a positive finite value passes through', d.distancePixels === 20);
    ok('source is "scene" for a real read', d.source === 'scene');
    ok('no reason attached to a clean read', d.reason === null);
  }
  ok('zero is rejected (a real scene never has 0 px/unit)', deriveDistancePixels(0).source === 'default');
  ok('negative is rejected', deriveDistancePixels(-5).source === 'default');
  ok('NaN is rejected', deriveDistancePixels(NaN).source === 'default');
  ok('undefined (no canvas.dimensions) is rejected', deriveDistancePixels(undefined).source === 'default');
  ok('the default is a documented positive constant, never 0', deriveDistancePixels(undefined).distancePixels === 100);
  {
    const a = deriveDistancePixels(undefined);
    const b = deriveDistancePixels('nope');
    ok('two different bad inputs still both land on the same safe default', a.distancePixels === b.distancePixels);
    ok('but their reasons differ (JSON.stringify(raw) is embedded)', a.reason !== b.reason);
  }

  // ---- deriveGridSizePixels: same discipline, a DIFFERENT Foundry property
  // (canvas.grid.size, px per grid SQUARE — not px per distance unit) ------
  {
    const g = deriveGridSizePixels(150);
    ok('a positive finite value passes through', g.gridSizePixels === 150);
    ok('source is "scene" for a real read', g.source === 'scene');
    ok('no reason attached to a clean read', g.reason === null);
  }
  ok('zero grid size is rejected', deriveGridSizePixels(0).source === 'default');
  ok('negative grid size is rejected', deriveGridSizePixels(-10).source === 'default');
  ok('NaN grid size is rejected', deriveGridSizePixels(NaN).source === 'default');
  ok('undefined (no canvas.grid) is rejected', deriveGridSizePixels(undefined).source === 'default');
  ok('the default is a documented positive constant, never 0', deriveGridSizePixels(undefined).gridSizePixels === 100);

  // ---- computeTokenOcclusionRadiusPx ---------------------------------------
  {
    // occludableRadius=0 => no disc, REGARDLESS of footprint or distancePixels —
    // this is the exact flag the token draw-list comment relies on ("0 means
    // this token contributes no disc").
    const r = computeTokenOcclusionRadiusPx({
      footprint: { width: 400, height: 400 },
      occludableRadius: 0,
      distancePixels: 20,
    });
    ok('occludableRadius:0 => exactly 0, not just small', r === 0);
  }
  {
    // 10 grid-distance-units at 20px/unit = 200px, plus half the larger
    // footprint dimension (400/2=200) => 400.
    const r = computeTokenOcclusionRadiusPx({
      footprint: { width: 400, height: 200 },
      occludableRadius: 10,
      distancePixels: 20,
    });
    ok(`radius = |units|*distancePixels + externalRadius (got ${r}, want 400)`, r === 400);
  }
  ok(
    'a negative occludableRadius still contributes a positive disc (Math.abs, matching Foundry)',
    computeTokenOcclusionRadiusPx({ footprint: { width: 0, height: 0 }, occludableRadius: -5, distancePixels: 20 }) ===
      100
  );
  ok(
    'a missing/malformed footprint does not throw — externalRadius degrades to 0',
    computeTokenOcclusionRadiusPx({ footprint: null, occludableRadius: 5, distancePixels: 20 }) === 100
  );

  // ---- deriveMouseHoverPoint: mythica-machina-press#470's hover-fade hit
  // test needs Foundry's live canvas.mousePosition — same "could not read"
  // vs "read a real value" discipline as the others, except the safe
  // fallback here is `null` (no hover this frame), never a synthetic point —
  // world (0,0) is real geometry, unlike a pixels-per-unit constant. -------
  {
    const p = deriveMouseHoverPoint({ x: 100, y: 200 }, true, false);
    ok('a real point with mousePositionVisible passes through', p.x === 100 && p.y === 200);
    ok('eligible is true when mousePositionVisible is true', p.eligible === true);
  }
  ok(
    'eligible is true when ONLY mousePositionExplored is true (the real OR-gate)',
    deriveMouseHoverPoint({ x: 0, y: 0 }, false, true).eligible === true
  );
  ok(
    'eligible is false when NEITHER visible nor explored',
    deriveMouseHoverPoint({ x: 0, y: 0 }, false, false).eligible === false
  );
  ok('eligible is true when BOTH are true', deriveMouseHoverPoint({ x: 0, y: 0 }, true, true).eligible === true);
  // World (0,0) is a real, legitimate point — must NOT be rejected as falsy.
  ok('(0,0) is a real point, not treated as missing', deriveMouseHoverPoint({ x: 0, y: 0 }, true, true) !== null);
  ok(
    'a missing point (no canvas.mousePosition) -> null, not a fabricated origin',
    deriveMouseHoverPoint(undefined, true, true) === null
  );
  ok('a malformed point (non-numeric x) -> null', deriveMouseHoverPoint({ x: 'nope', y: 0 }, true, true) === null);
  ok('a malformed point (NaN y) -> null', deriveMouseHoverPoint({ x: 0, y: NaN }, true, true) === null);
  ok('a null point -> null', deriveMouseHoverPoint(null, true, true) === null);
}
