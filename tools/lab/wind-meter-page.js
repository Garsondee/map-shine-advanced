/**
 * tools/lab/wind-meter-page.js — runs IN the lab client (cdp.mjs eval --file), the body of an async function
 * with `args` in scope (mmp-vm1.1, the Wind lab).
 *
 * Reads the BAKED wind field back (`MapShine.readWindField`) for `args.seconds` at about `args.hz`, and keeps:
 *   - the field vector at every named point (bilinear, the same filter the GPU consumers use), per baked frame;
 *   - whole-grid snapshots every `args.snapEverySec` (for spatial correlation and the overlay plots);
 *   - the grid, the ambient, the CPU cell channels (openness, shadow, solid, sky) once.
 * Times are the sim time each copy was BAKED at (`bakedAtMs`), never wall time, so a paused world reads as
 * repeats and a slow frame does not smear the series. A copy whose bake has not advanced is skipped.
 *
 * args: { points: [{name, x, y}] in SCENE px, seconds, hz, snapEverySec, setWind?: {directionDeg, speed01},
 *         settleSec?, unpause?: boolean, livingWind?: boolean|null (LIVING WIND on/off for the run) }
 */
// The driver appends `return await windMeterPage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function windMeterPage(args) {
  const a = args ?? {};
  const seconds = Number(a.seconds ?? 30);
  const hz = Number(a.hz ?? 10);
  const snapEvery = Number(a.snapEverySec ?? 5);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  if (typeof MapShine?.readWindField !== 'function')
    return { ok: false, reason: 'MapShine.readWindField missing (old build?)' };
  const renderScale = game.settings.get('map-shine-advanced', 'renderScale');
  if (a.unpause && game.paused) game.togglePause(false, { broadcast: true });
  if (a.livingWind !== undefined && typeof MapShine?.setLivingWind === 'function') {
    MapShine.setLivingWind(a.livingWind);
  }
  if (a.setWind) {
    await MapShine.setWind(a.setWind);
  }
  if (a.settleSec) await sleep(Number(a.settleSec) * 1000);

  const first = await MapShine.readWindField({ cells: true });
  if (!first?.ok) return { ok: false, reason: first?.reason ?? 'read failed', first };
  const g = first.grid;
  const dims = canvas.dimensions;
  const ox = dims.sceneX;
  const oy = dims.sceneY;

  const clampC = (c) => Math.min(g.cols - 1, Math.max(0, c));
  const clampR = (r) => Math.min(g.rows - 1, Math.max(0, r));
  /** Bilinear read at a world point, texel centres at origin + (c + ½)·cellSize, clamp-to-edge. */
  function sampleAt(f, wx, wy) {
    const u = (wx - g.originX) / g.cellSize - 0.5;
    const v = (wy - g.originY) / g.cellSize - 0.5;
    const c0 = Math.floor(u);
    const r0 = Math.floor(v);
    const fu = u - c0;
    const fv = v - r0;
    const i = (c, r) => clampR(r) * g.cols + clampC(c);
    const lerp = (p, q, t) => p + (q - p) * t;
    const at = (arr) =>
      lerp(lerp(arr[i(c0, r0)], arr[i(c0 + 1, r0)], fu), lerp(arr[i(c0, r0 + 1)], arr[i(c0 + 1, r0 + 1)], fu), fv);
    return [Math.round(at(f.fx) * 1e5) / 1e5, Math.round(at(f.fy) * 1e5) / 1e5];
  }

  const points = (a.points ?? []).map((p) => ({ ...p, wx: p.x + ox, wy: p.y + oy }));
  const series = Object.fromEntries(points.map((p) => [p.name, []]));
  const t = [];
  const snaps = [];
  let lastFrames = -1;
  let lastSnapT = -Infinity;
  const wallStart = performance.now();
  let reads = 0;
  let repeats = 0;
  while (performance.now() - wallStart < seconds * 1000) {
    const tick = performance.now();
    const r = await MapShine.readWindField({ cells: false });
    reads++;
    if (!r?.ok) break;
    if (r.bakeFrames === lastFrames) {
      repeats++;
      await frame();
      continue;
    }
    lastFrames = r.bakeFrames;
    const tSec = r.bakedAtMs / 1000;
    t.push(Math.round(r.bakedAtMs));
    for (const p of points) series[p.name].push(sampleAt(r.now, p.wx, p.wy));
    if (tSec - lastSnapT >= snapEvery - 1e-6) {
      snaps.push({
        t: Math.round(r.bakedAtMs),
        fx: r.now.fx.map((x) => Math.round(x * 1e4) / 1e4),
        fy: r.now.fy.map((x) => Math.round(x * 1e4) / 1e4),
      });
      lastSnapT = tSec;
    }
    const wait = 1000 / hz - (performance.now() - tick);
    if (wait > 0) await sleep(wait);
  }

  return {
    ok: true,
    renderScale,
    paused: game.paused,
    scene: canvas.scene?.name,
    sceneOffset: { x: ox, y: oy },
    grid: g,
    ambient: first.ambient,
    livingWind: typeof MapShine?.getLivingWind === 'function' ? MapShine.getLivingWind() : null,
    cells: first.cells,
    points,
    t,
    series,
    snaps,
    reads,
    repeats,
    wallSec: Math.round(performance.now() - wallStart) / 1000,
  };
}
