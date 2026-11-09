/**
 * tools/lab/wind-fire-page.js — what each fire on Lab · Wind feels (mmp-vm1.1.6). Runs in the lab client
 * (cdp.mjs eval --file), the body of an async function with `args` in scope.
 *
 * Samples `MapShine.getFireStatus().billow.weather` (one row per flame cluster: the wind push the billow model got,
 * weather-gated, and — on builds that have it — the local air speed and direction) at ~`hz` for `seconds`, under
 * one dial setting. Returns per-cluster series; `wind-fire.py` (or the caller) turns them into mean / std / direction.
 *
 * args: { seconds, hz, speed01, directionDeg, livingWind (true|false|null), settleSec, unpause }
 */
// The driver appends `return await windFirePage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function windFirePage(args) {
  const a = args ?? {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (a.unpause && game.paused) game.togglePause(false, { broadcast: true });
  if (a.livingWind !== undefined && typeof MapShine.setLivingWind === 'function') MapShine.setLivingWind(a.livingWind);
  if (a.speed01 !== undefined) await MapShine.setWind({ directionDeg: a.directionDeg ?? 90, speed01: a.speed01 });
  await sleep((a.settleSec ?? 6) * 1000);
  const seconds = Number(a.seconds ?? 30);
  const hz = Number(a.hz ?? 5);
  const series = {};
  const t0 = performance.now();
  let samples = 0;
  while (performance.now() - t0 < seconds * 1000) {
    const tick = performance.now();
    const st = MapShine.getFireStatus?.();
    const rows = st?.billow?.weather ?? [];
    const tMs = Math.round(performance.now() - t0);
    for (const r of rows) {
      const k = String(r.id);
      (series[k] ??= []).push({ t: tMs, ...r });
    }
    samples++;
    const wait = 1000 / hz - (performance.now() - tick);
    if (wait > 0) await sleep(wait);
  }
  return {
    ok: true,
    samples,
    dial: MapShine.getWind?.(),
    living: MapShine.getLivingWind?.() ?? null,
    status: {
      fires: MapShine.getFireStatus?.()?.billow?.fires,
      clusters: MapShine.getFireStatus?.()?.billow?.clusters,
    },
    series,
  };
}
