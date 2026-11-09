/**
 * tools/lab/weather-set.js — put Lab · Weather into a weather state (MSA Lab, weather family).
 *
 * A cdp `eval --file` BODY (`args` in scope):
 *   {precip, kind, cloud, fog, lightning, temp, hour, wind, dir, view: {x, y, scale}, pause}
 *
 * ⚠️ WRITES THE SCENE'S OWN `sky` / `wind` FLAGS, the way a GM's saved scene holds weather. Live targets
 * (`MapShine.setWeatherTargets`) do not survive: any scene-flag write (setWind, setLightning) re-applies the
 * stored sky and puts the weather back (found 2026-11-09: rain 0.6 decayed to 0 within a minute after setWind).
 * Weather lands at once (no fade) because the lab's sky has `weatherMode: 'director'` and the flag write is a
 * resolve, not a fade. Waits for the axes to arrive before it returns.
 */
/* global MapShine, game, canvas */
const a = typeof args === 'object' && args ? args : {};
const M = 'map-shine-advanced';
const scene = canvas.scene;
if (scene?.getFlag(M, 'lab') !== 'scene:weather') return { refused: 'not on Lab · Weather', scene: scene?.name };
const sky = { ...(scene.getFlag(M, 'sky') ?? {}) };
const set = (k, v) => {
  if (v !== undefined) sky[k] = v;
};
set('precip01', a.precip);
set('cloudCover01', a.cloud);
set('fogDensity01', a.fog);
set('lightning01', a.lightning);
set('temperature01', a.temp);
set('todHour', a.hour);
if (a.kind !== undefined) sky.precipKindAuthored = a.kind;
sky.weatherArchetype = 'custom';
await scene.setFlag(M, 'sky', sky);
if (a.wind !== undefined || a.dir !== undefined) {
  const w = { ...(scene.getFlag(M, 'wind') ?? {}) };
  if (a.wind !== undefined) w.speed01 = a.wind;
  if (a.dir !== undefined) w.directionDeg = a.dir;
  await scene.setFlag(M, 'wind', w);
}
if (a.pause !== undefined && game.paused !== a.pause) game.togglePause(a.pause, { broadcast: true });
if (a.view) {
  const d = canvas.dimensions;
  await canvas.animatePan({ x: d.sceneX + a.view.x, y: d.sceneY + a.view.y, scale: a.view.scale ?? 1, duration: 0 });
}
// wait (up to 8 s) for the live axes to reach the flag's values
const want = { precip01: sky.precip01, cloudCover01: sky.cloudCover01, fogDensity01: sky.fogDensity01 };
let st = null;
for (let i = 0; i < 40; i++) {
  st = MapShine.getWeatherState?.()?.state ?? null;
  if (st && Object.entries(want).every(([k, v]) => v === undefined || Math.abs((st[k] ?? 0) - v) < 0.01)) break;
  await new Promise((r) => setTimeout(r, 200));
}
const p = MapShine.getPrecipitation();
return {
  sky: {
    precip01: sky.precip01,
    cloud: sky.cloudCover01,
    fog: sky.fogDensity01,
    kind: sky.precipKindAuthored,
    hour: sky.todHour,
  },
  wind: scene.getFlag(M, 'wind'),
  live: st,
  pops: p.activePopulations,
  rainLive: p.engines?.rain?.liveCount ?? null,
  paused: game.paused,
};
