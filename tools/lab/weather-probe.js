/**
 * tools/lab/weather-probe.js — measure falling precipitation from its GPU state (MSA Lab, weather family).
 *
 * A cdp `eval --file` script, one `weatherProbePage(args)` (cdp.mjs calls it; see the note above it):
 *   node tools/foundry-cdp/cdp.mjs eval --name labc --file tools/lab/weather-probe.js --args '{"species":"rain","gapMs":300}'
 *
 * Reads `MapShine.readPrecipParticles()` twice, `gapMs` of sim time apart, and reports, per body that kept
 * falling between the reads (a respawn jumps UP, so it drops out):
 *   - fall speed (dh/dt) and the body's own terminal speed (custom.z), in m/s at the scene's px/m;
 *   - lateral speed and its direction (the wind's push), in m/s and degrees;
 *   - heights as a share of the tallest birth height (10 bands) — a steady fall fills them evenly;
 *   - spread of the bodies over their own bounding box (8 x 8 cells): coefficient of variation;
 *   - splash engines: live count, ages, sizes.
 * It REFUSES to run unless MSA's render scale is native (mmp-78u.41: below 1 the probes read the wrong pixel).
 */
// cdp.mjs appends `return await weatherProbePage(args);` (a committed page script has no top-level return: lint).
// eslint-disable-next-line no-unused-vars
async function weatherProbePage(args) {
  const a = typeof args === 'object' && args ? args : {};
  const species = a.species ?? 'rain';
  const gapMs = a.gapMs ?? 300;
  const rs = MapShine.getRenderScaleState?.();
  if (!rs || rs.userSetting !== '1' || rs.resolvedInternalScale !== 1) {
    return { refused: 'render scale is not native', renderScale: rs };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A = await MapShine.readPrecipParticles({ maxBodies: a.maxBodies ?? 20000 });
  await sleep(gapMs);
  const B = await MapShine.readPrecipParticles({ maxBodies: a.maxBodies ?? 20000 });
  const ppm = B.pxPerMetre ?? A.pxPerMetre;
  const dt = (B.simMs - A.simMs) / 1000;
  const fa = A.fall?.[species];
  const fb = B.fall?.[species];
  const q = (arr, f) => {
    if (!arr.length) return null;
    const s = Float64Array.from(arr).sort();
    return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(3);
  };
  const summ = (arr) => ({
    n: arr.length,
    p05: q(arr, 0.05),
    p25: q(arr, 0.25),
    p50: q(arr, 0.5),
    p75: q(arr, 0.75),
    p95: q(arr, 0.95),
  });
  const out = {
    species,
    paused: game.paused,
    simGapSec: +dt.toFixed(4),
    pxPerMetre: ppm,
    liveA: fa?.n ?? 0,
    liveB: fb?.n ?? 0,
    state: fb?.state
      ? {
          liveCount: fb.state.liveCount,
          capacity: fb.state.capacity,
          tuning: fb.state.tuning,
          wind: fb.state.wind,
          skyGate: fb.state.skyGate,
        }
      : null,
  };
  if (!fa?.n || !fb?.n || !(dt > 0) || !ppm) {
    out.note = !(dt > 0) ? 'no sim time passed between the reads (paused?)' : 'no live bodies';
    if (fa?.n && fb?.n) {
      // paused check: did anything move at all?
      let maxDh = 0;
      let maxDxy = 0;
      for (let i = 0; i < Math.min(fa.n, fb.n); i++) {
        maxDh = Math.max(maxDh, Math.abs(fa.custom[i * 4 + 3] - fb.custom[i * 4 + 3]));
        maxDxy = Math.max(
          maxDxy,
          Math.hypot(fa.position[i * 2] - fb.position[i * 2], fa.position[i * 2 + 1] - fb.position[i * 2 + 1])
        );
      }
      out.motionWhileStill = { maxDhPx: +maxDh.toFixed(3), maxDxyPx: +maxDxy.toFixed(3) };
    }
  } else {
    const n = Math.min(fa.n, fb.n);
    const fall = [];
    const term = [];
    const ratio = [];
    const lat = [];
    const heights = [];
    const sizes = [];
    const kernelDt = []; // the body's own clock (age) over the sim clock: < 1 = the kernel's dt clamp bit
    const fallKernel = []; // fall speed on the body's own clock
    let vx = 0;
    let vy = 0;
    let kept = 0;
    let topH = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) topH = Math.max(topH, fb.custom[i * 4 + 3]);
    for (let i = 0; i < n; i++) {
      const h0 = fa.custom[i * 4 + 3];
      const h1 = fb.custom[i * 4 + 3];
      const x = fb.position[i * 2];
      const y = fb.position[i * 2 + 1];
      heights.push(h1);
      sizes.push(fb.custom[i * 4 + 1]);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      // Same body in both reads: its age (ms, reset to 0 on landing) grew. A respawn resets it, so it drops out.
      const ageDelta = fb.age[i] - fa.age[i];
      if (!(ageDelta > 0) || !(h1 < h0)) continue;
      kernelDt.push(ageDelta / 1000 / dt);
      const dx = x - fa.position[i * 2];
      const dy = y - fa.position[i * 2 + 1];
      const f = (h0 - h1) / dt / ppm;
      fallKernel.push((h0 - h1) / (ageDelta / 1000) / ppm);
      const t = fb.custom[i * 4 + 2] / ppm;
      fall.push(f);
      term.push(t);
      if (t > 0) ratio.push(f / t);
      lat.push(Math.hypot(dx, dy) / dt / ppm);
      vx += dx;
      vy += dy;
      kept++;
    }
    // spread over the bodies' own bounding box: 8 x 8 cells
    const cells = new Array(64).fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.min(7, Math.floor(((fb.position[i * 2] - minX) / Math.max(1, maxX - minX)) * 8));
      const cy = Math.min(7, Math.floor(((fb.position[i * 2 + 1] - minY) / Math.max(1, maxY - minY)) * 8));
      cells[cy * 8 + cx]++;
    }
    const mean = cells.reduce((s, v) => s + v, 0) / 64;
    const sd = Math.sqrt(cells.reduce((s, v) => s + (v - mean) ** 2, 0) / 64);
    const bands = new Array(10).fill(0);
    for (const h of heights) bands[Math.min(9, Math.max(0, Math.floor((h / Math.max(1, topH)) * 10)))]++;
    out.fallMps = summ(fall);
    out.fallMpsOwnClock = summ(fallKernel);
    out.ownClockOverSim = summ(kernelDt);
    out.terminalMps = summ(term);
    out.fallOverTerminal = summ(ratio);
    out.lateralMps = summ(lat);
    out.meanDriftDeg = kept ? +((Math.atan2(vy, vx) * 180) / Math.PI).toFixed(1) : null;
    out.meanDriftMps = kept ? +(Math.hypot(vx, vy) / kept / dt / ppm).toFixed(3) : null;
    out.windDial = fb.state?.wind ?? null;
    out.windMps = fb.state?.wind ? +(fb.state.wind.speed01 * 70).toFixed(2) : null;
    out.heightTopPx = +topH.toFixed(1);
    out.heightBands = bands; // 0 = ground .. 9 = top
    out.sizePx = summ(sizes);
    out.bbox = { minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY) };
    out.spreadCv = +(sd / Math.max(1e-9, mean)).toFixed(3);
    // share of the 64 cells holding under a quarter of the mean: "dry" patches of the spawn area
    out.dryCellShare = +(cells.filter((c) => c < mean / 4).length / 64).toFixed(3);
    out.cells8x8 = cells;
    out.kept = kept;
  }
  // splashes
  out.splash = {};
  for (const [id, s] of Object.entries(B.splash ?? {})) {
    const ages = [];
    const sz = [];
    let born = 0;
    let dead = 0;
    for (let i = 0; i < s.n; i++) {
      const ag = s.age[i];
      if (ag < 0) born++;
      else if (ag > 1e8) dead++;
      else ages.push(ag);
      if (s.custom) sz.push(s.custom[i * 4 + 1]);
    }
    out.splash[id] = {
      liveCount: s.state?.liveCount,
      n: s.n,
      justBorn: born,
      dead,
      ageMs: summ(ages),
      sizePx: summ(sz),
      rate: s.state?.rate,
    };
  }
  return out;
}
