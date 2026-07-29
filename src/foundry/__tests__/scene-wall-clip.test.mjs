/**
 * Node verification for foundry/scene-wall-clip.js.
 *
 * `buildCandleWallClipConfig`/`buildLightWallClipConfig` are pure/testable
 * here. `computeCandleWallClippedShape`/`computeLightWallClippedShape` touch
 * `canvas`/`CONFIG` (a live `ClockwiseSweepPolygon.create()` call) —
 * browser-only, same split as every other `read*`/`compute*` function in
 * this adapter (verified via the debug panel / a live scene, not a mocked
 * `canvas`).
 */
import { buildCandleWallClipConfig, buildLightWallClipConfig } from '../scene-wall-clip.js';

export function run(t) {
  const { ok } = t;

  const cfg = buildCandleWallClipConfig(300);
  ok('type is "light" (CONFIG.Canvas.polygonBackends.light === ClockwiseSweepPolygon)', cfg.type === 'light');
  ok('radius passes through', cfg.radius === 300);
  ok('walls block this shape (edgeTypes.wall true)', cfg.edgeTypes.wall === true);
  ok('omnidirectional (angle 360, no facing concept for a candle)', cfg.angle === 360);
  ok('no rotation', cfg.rotation === 0);
  ok('no external radius', cfg.externalRadius === 0);
  ok('default priority', cfg.priority === 0);
  ok('useThreshold matches real point-light parity', cfg.useThreshold === true);
  ok("does NOT include a level — that is the caller's job (a real Level document)", !('level' in cfg));

  const other = buildCandleWallClipConfig(50);
  ok(
    'a different radius produces a different config radius, everything else identical shape',
    other.radius === 50 && other.type === cfg.type
  );

  // ---- buildLightWallClipConfig — the REAL-light analog (2026-07-29 fix:
  // recompute the shape Foundry zeroed for a light disabled ONLY by its own
  // darkness gate). Unlike a candle, a real light can be a cone. -----------
  {
    const defaults = buildLightWallClipConfig(300);
    ok('type is "light"', defaults.type === 'light');
    ok('radius passes through', defaults.radius === 300);
    ok('walls block by default (Foundry default true)', defaults.edgeTypes.wall === true);
    ok('angle defaults to 360 (omnidirectional) when not authored', defaults.angle === 360);
    ok('rotation defaults to 0', defaults.rotation === 0);
    ok('externalRadius defaults to 0', defaults.externalRadius === 0);
    ok('priority defaults to 0', defaults.priority === 0);
    ok('useThreshold matches real point-light parity', defaults.useThreshold === true);
    ok('surfaceExposure is present (point-light-source.mjs parity)', typeof defaults.surfaceExposure === 'object');
    ok("does NOT include a level — that is the caller's job (a real Level document)", !('level' in defaults));
  }
  {
    const cone = buildLightWallClipConfig(200, {
      angle: 90,
      rotation: 45,
      walls: false,
      externalRadius: 10,
      priority: 2,
    });
    ok('a real cone angle passes through', cone.angle === 90);
    ok('rotation passes through', cone.rotation === 45);
    ok('walls:false is respected (not blocked)', cone.edgeTypes.wall === false);
    ok('externalRadius passes through', cone.externalRadius === 10);
    ok('priority passes through', cone.priority === 2);
  }
  ok(
    'a non-finite angle/rotation falls back to the omnidirectional default, never NaN',
    buildLightWallClipConfig(100, { angle: NaN, rotation: NaN }).angle === 360 &&
      buildLightWallClipConfig(100, { angle: NaN, rotation: NaN }).rotation === 0
  );
}
