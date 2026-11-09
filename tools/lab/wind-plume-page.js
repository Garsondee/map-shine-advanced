/**
 * tools/lab/wind-plume-page.js — where each fire's smoke and flame lean on Lab · Wind, at each wind speed (mmp-vm1.1.6).
 * Runs in the lab client (cdp.mjs eval --file), the body of an async function with `args` in scope.
 *
 * For every dial speed: set the wind, let it settle, then centre the view on each fire in turn (so the smoke camera's lean
 * out from the middle of the view is the same for all) and sample its row of `MapShine.getFireStatus().billow.weather`:
 * the plume meter (`smokeDx/Dy`, `flameDx/Dy`: the drawn lobes' weighted middle, world px from the fuel bed) and the air
 * the fire felt. `wind-plume.py` turns the samples into lean angles and plots.
 *
 * args: { fires: [{key, x, y}] scene px, speeds: [speed01...], directionDeg, livingWind, settleSec, dwellSec,
 *         seconds, hz, viewW, viewH, padX, padY }
 */
// The driver appends `return await windPlumePage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function windPlumePage(args) {
  const a = args ?? {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (game.paused) game.togglePause(false, { broadcast: true });
  if (a.livingWind !== undefined && typeof MapShine.setLivingWind === 'function') MapShine.setLivingWind(a.livingWind);
  const d = canvas.dimensions;
  const viewW = a.viewW ?? 1400;
  const viewH = a.viewH ?? 880;
  const scale = Math.min(window.innerWidth / viewW, window.innerHeight / viewH);
  const hz = Number(a.hz ?? 10);
  const out = [];
  for (const speed01 of a.speeds ?? [0.15]) {
    await MapShine.setWind({ directionDeg: a.directionDeg ?? 90, speed01 });
    let first = true;
    for (const f of a.fires ?? []) {
      const wx = d.sceneX + f.x;
      const wy = d.sceneY + f.y;
      await canvas.animatePan({ x: wx, y: wy, scale, duration: 0 });
      await sleep((first ? (a.settleSec ?? 12) : (a.dwellSec ?? 3)) * 1000);
      first = false;
      const rows = [];
      const t0 = performance.now();
      while (performance.now() - t0 < (a.seconds ?? 6) * 1000) {
        const tick = performance.now();
        const list = MapShine.getFireStatus?.()?.billow?.weather ?? [];
        let best = null;
        let bestD = Infinity;
        for (const r of list) {
          const dd = (r.x - wx) ** 2 + (r.y - wy) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = r;
          }
        }
        if (best && bestD < 400 * 400) rows.push({ t: Math.round(performance.now() - t0), ...best });
        const wait = 1000 / hz - (performance.now() - tick);
        if (wait > 0) await sleep(wait);
      }
      out.push({ speed01, key: f.key, rows });
    }
  }
  return { ok: true, living: MapShine.getLivingWind?.() ?? null, dial: MapShine.getWind?.(), runs: out };
}
