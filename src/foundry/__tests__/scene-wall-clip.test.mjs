/**
 * Node verification for foundry/scene-wall-clip.js.
 *
 * `buildCandleWallClipConfig` is pure/testable here.
 * `computeCandleWallClippedShape` touches `canvas`/`CONFIG` (a live
 * `ClockwiseSweepPolygon.create()` call) — browser-only, same split as
 * every other `read*`/`compute*` function in this adapter (verified via
 * the debug panel / a live scene, not a mocked `canvas`).
 */
import { buildCandleWallClipConfig } from '../scene-wall-clip.js';

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
}
