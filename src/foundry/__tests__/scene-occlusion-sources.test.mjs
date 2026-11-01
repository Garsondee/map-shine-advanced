/**
 * Node verification for foundry/scene-occlusion-sources.js. Same split as
 * scene-environment.test.mjs: only the pure logic is tested here; the live
 * `canvas.dimensions` read is browser-only.
 */
import {
  deriveDistancePixels,
  deriveGridSizePixels,
  computeTokenOcclusionRadiusPx,
  deriveOccludableToken,
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

  // ---- computeTokenOcclusionRadiusPx: Foundry's max(externalRadius, getLightRadius) ----
  {
    // The schema default (radius 0) still reveals the token's own half-size —
    // returning 0 here was why no default token ever cut a RADIAL hole.
    const r = computeTokenOcclusionRadiusPx({
      footprint: { width: 400, height: 400 },
      occludableRadius: 0,
      distancePixels: 20,
    });
    ok(`occludableRadius:0 => the token's own half-size (got ${r}, want 200)`, r === 200);
  }
  {
    // 10 units at 20px = 200px, plus externalRadius = min(400,200)/2 = 100 => 300.
    const r = computeTokenOcclusionRadiusPx({
      footprint: { width: 400, height: 200 },
      occludableRadius: 10,
      distancePixels: 20,
    });
    ok(`radius = |units|*distancePixels + min(w,h)/2 (got ${r}, want 300)`, r === 300);
  }
  ok(
    'a negative occludableRadius falls back to the token half-size (getLightRadius < 0, max picks externalRadius)',
    computeTokenOcclusionRadiusPx({
      footprint: { width: 100, height: 100 },
      occludableRadius: -5,
      distancePixels: 20,
    }) === 50
  );

  // ---- deriveOccludableToken ------------------------------------------------
  {
    const base = {
      id: 'abc',
      elevation: 0,
      center: { x: 150, y: 150 },
      size: { width: 100, height: 100 },
      occludableRadius: 0,
    };
    const d = deriveOccludableToken({ ...base, visionActive: false, los: null, testPoints: null }, 100);
    ok('id is the draw-list token id', d.id === 'token:abc');
    ok('no test points => the centre is tested', d.testPoints.length === 1 && d.testPoints[0].x === 150);
    ok('no vision => no polygon, radial only', d.visionActive === false && d.los === null);
    ok('default radius => half the token', d.radiusPx === 50);
    const v = deriveOccludableToken(
      {
        ...base,
        visionActive: true,
        los: { points: [0, 0, 300, 0, 300, 300], origin: { x: 150, y: 140 } },
        testPoints: [
          { x: 120, y: 130 },
          { x: 180, y: 170 },
        ],
      },
      100
    );
    ok('vision with a polygon => vision active, origin kept', v.visionActive && v.los.originY === 140);
    ok('test-point bounds span the dense points', v.minX === 120 && v.maxY === 170);
    const empty = deriveOccludableToken(
      { ...base, visionActive: true, los: { points: [1, 2] }, testPoints: null },
      100
    );
    ok('vision on but no usable polygon => treated as no vision (radial reveals)', empty.visionActive === false);
    ok('a token with no position is skipped', deriveOccludableToken({ id: 'x', center: null }, 100) === null);
  }

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
