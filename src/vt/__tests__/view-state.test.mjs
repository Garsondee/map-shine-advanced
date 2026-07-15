/**
 * Node verification for vt/view-state.js — pure keyboard-driven pan/zoom/
 * floor-switch state. No DOM, no THREE.
 */
import {
  createInitialViewState, applyPanKey, applyZoomKey, applyFloorSwitchKey, applyKey, viewToWorldRect,
} from '../view-state.js';

export function run(t) {
  const { ok } = t;
  const WORLD = 12000;

  // --- initial state --------------------------------------------------------
  {
    const v = createInitialViewState({ worldSizePx: WORLD });
    ok('initial: centered on the world', v.centerXPx === WORLD / 2 && v.centerYPx === WORLD / 2);
    ok('initial: floor 0 by default', v.floorIndex === 0);
    ok('initial: halfSpanPx is positive and sane', v.halfSpanPx > 0 && v.halfSpanPx < WORLD);
  }

  // --- pan ------------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD });
    const v1 = applyPanKey(v0, 'ArrowRight', WORLD);
    ok('pan right: centerX increases', v1.centerXPx > v0.centerXPx);
    ok('pan right: centerY unchanged', v1.centerYPx === v0.centerYPx);
    ok('pan: original state never mutated', v0.centerXPx === WORLD / 2);

    const v2 = applyPanKey(v0, 'ArrowDown', WORLD);
    ok('pan down: centerY increases (image-space, Y grows downward)', v2.centerYPx > v0.centerYPx);

    const v3 = applyPanKey(v0, 'q', WORLD); // not a pan key
    ok('pan: unrecognized key returns the SAME reference (no-op, not a new object)', v3 === v0);
  }

  // --- pan clamping at world edges -------------------------------------------
  {
    const edge = { ...createInitialViewState({ worldSizePx: WORLD }), centerXPx: 5 };
    const afterMany = Array.from({ length: 50 }).reduce((v) => applyPanKey(v, 'ArrowLeft', WORLD), edge);
    ok('pan: clamps at 0, never goes negative', afterMany.centerXPx === 0);

    const edgeMax = { ...createInitialViewState({ worldSizePx: WORLD }), centerXPx: WORLD - 5 };
    const afterManyMax = Array.from({ length: 50 }).reduce((v) => applyPanKey(v, 'ArrowRight', WORLD), edgeMax);
    ok('pan: clamps at worldSizePx, never exceeds it', afterManyMax.centerXPx === WORLD);
  }

  // --- zoom -------------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD });
    const zoomedIn = applyZoomKey(v0, '+', WORLD);
    ok('zoom in: halfSpanPx shrinks', zoomedIn.halfSpanPx < v0.halfSpanPx);
    const zoomedOut = applyZoomKey(v0, '-', WORLD);
    ok('zoom out: halfSpanPx grows', zoomedOut.halfSpanPx > v0.halfSpanPx);
    ok('zoom: unrecognized key is a no-op (same reference)', applyZoomKey(v0, 'x', WORLD) === v0);
  }

  // --- zoom clamping ----------------------------------------------------------
  {
    let v = { ...createInitialViewState({ worldSizePx: WORLD }), halfSpanPx: 60 };
    for (let i = 0; i < 30; i++) v = applyZoomKey(v, '+', WORLD);
    ok('zoom in: never goes below the min half-span', v.halfSpanPx >= 50 && v.halfSpanPx < 60);

    let v2 = { ...createInitialViewState({ worldSizePx: WORLD }), halfSpanPx: 1000 };
    for (let i = 0; i < 30; i++) v2 = applyZoomKey(v2, '-', WORLD);
    ok('zoom out: never exceeds half the world', v2.halfSpanPx <= WORLD * 0.5);
  }

  // --- floor switch ------------------------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD, floorIndex: 0 });
    ok('floor switch: numeric key selects that floor', applyFloorSwitchKey(v0, '2', 3).floorIndex === 2);
    ok('floor switch: out-of-range numeric key is a no-op', applyFloorSwitchKey(v0, '9', 3) === v0);
    const afterTab = applyFloorSwitchKey(v0, 'Tab', 3);
    ok('floor switch: Tab cycles forward', afterTab.floorIndex === 1);
    ok('floor switch: Tab wraps around', applyFloorSwitchKey({ ...v0, floorIndex: 2 }, 'Tab', 3).floorIndex === 0);
  }

  // --- unified applyKey dispatch ----------------------------------------------
  {
    const v0 = createInitialViewState({ worldSizePx: WORLD, floorIndex: 0 });
    const ctx = { worldSizePx: WORLD, floorCount: 3 };
    ok('applyKey: routes a pan key to pan', applyKey(v0, 'ArrowRight', ctx).centerXPx > v0.centerXPx);
    ok('applyKey: routes a zoom key to zoom', applyKey(v0, '+', ctx).halfSpanPx < v0.halfSpanPx);
    ok('applyKey: routes a floor key to floor switch', applyKey(v0, '1', ctx).floorIndex === 1);
    ok('applyKey: unrecognized key changes nothing', applyKey(v0, 'z', ctx) === v0);
  }

  // --- viewToWorldRect ---------------------------------------------------------
  {
    const v = { centerXPx: 6000, centerYPx: 6000, halfSpanPx: 500, floorIndex: 0 };
    const r = viewToWorldRect(v);
    ok('viewToWorldRect: correct rect from center+halfSpan', r.minX === 5500 && r.maxX === 6500 && r.minY === 5500 && r.maxY === 6500);
  }
}
