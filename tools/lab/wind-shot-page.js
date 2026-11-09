/**
 * tools/lab/wind-shot-page.js — set up one framed view of Lab · Wind for a picture (mmp-vm1.1). Runs in the lab
 * client (cdp.mjs eval --file); the shot itself is `cdp.mjs shot --clean`.
 *
 * args: { view: {x, y, w, h} in SCENE px (the rect to fill the screen), speed01, directionDeg, livingWind,
 *         overlay: boolean, settleSec, unpause }
 */
// The driver appends `return await windShotPage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function windShotPage(args) {
  const a = args ?? {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (a.unpause && game.paused) game.togglePause(false, { broadcast: true });
  if (a.livingWind !== undefined) MapShine.setLivingWind(a.livingWind);
  if (a.speed01 !== undefined) await MapShine.setWind({ directionDeg: a.directionDeg ?? 90, speed01: a.speed01 });
  // The overlay toggle is a debug action that flips and reports `armed`; flip again if it landed the wrong way.
  let overlay = null;
  if (a.overlay !== undefined) {
    const parse = (r) => (typeof r === 'string' ? JSON.parse(r) : r);
    overlay = parse(await MapShine.debug.runReport('wind-overlay-toggle'));
    if (!!overlay?.armed !== !!a.overlay) overlay = parse(await MapShine.debug.runReport('wind-overlay-toggle'));
  }
  if (a.view) {
    const d = canvas.dimensions;
    const cx = d.sceneX + a.view.x + a.view.w / 2;
    const cy = d.sceneY + a.view.y + a.view.h / 2;
    const scale = Math.min(window.innerWidth / a.view.w, window.innerHeight / a.view.h);
    await canvas.animatePan({ x: cx, y: cy, scale, duration: 0 });
  }
  await sleep((a.settleSec ?? 6) * 1000);
  return { overlay, living: MapShine.getLivingWind?.(), wind: MapShine.getWind?.() };
}
