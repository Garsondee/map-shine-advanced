#!/usr/bin/env node
/**
 * tools/pan-smoothness/measure.mjs — how evenly does the camera move during a LIVE pan?
 *
 *   node tools/pan-smoothness/measure.mjs --cdp 9360 --mode drag|key|ideal
 *        [--speed 1500] [--seconds 3] [--effects on|off] [--smooth on|off] [--runs 3] [--out result.json]
 *        [--profile run.cpuprofile]
 *
 * Drives a real pan in a running Foundry + MSA page (a private rig: Chrome launched with
 * `tools/video-capture/record.mjs boot`) and logs, on EVERY displayed frame, the time
 * (rAF timestamp, vsync-aligned) and the camera Foundry handed MSA (canvas.stage.pivot).
 *
 *   drag  - right-mouse drag through Chrome's own input pipeline (CDP Input events every
 *           ~2 ms, like a high-rate mouse; Chrome coalesces them to frames as it does a real one)
 *   key   - ArrowRight held, auto-repeat every 33 ms (Windows' default repeat rate)
 *   ideal - the camera set once per frame from the frame's own time (the reference)
 *
 * A perfectly smooth pan moves the camera by speed x frame-time on every frame. Reported:
 *   stepCvPct  - spread of (camera step / frame time) around the pan's own speed, % (0 = perfect)
 *   holds      - frames where the camera did not move (< 25% of its due step) mid-pan
 *   doubles    - frames that moved > 175% of their due step (catching up after a hold)
 *   wobblePx   - screen-px spread of the camera around a straight line through time
 *   frameMs    - frame interval mean / spread / worst (how evenly MSA itself presents)
 * `--effects off` forces every MSA effect off for the run (restored afterwards).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const CDP = Number(opt('cdp', 9360));
const mode = opt('mode', 'drag');
const speed = Number(opt('speed', 1500)); // screen px / s
const seconds = Number(opt('seconds', 3));
const runs = Number(opt('runs', 3));
const effects = opt('effects', 'on');
const out = opt('out', null);
const pacing = opt('pacing', null); // off|auto|1..4: MapShine.setFramePacing for the run (left as set)
const smooth = opt('smooth', null); // on|off: MapShine.setSmoothPan for the run (left as set)

const EFFECT_IDS = [
  'albedoClarity',
  'apertureGobo',
  'bloom',
  'candleFlame',
  'depthOfField',
  'fire',
  'fluid',
  'grade',
  'gust',
  'lightning',
  'motionTileShadows',
  'specular',
  'strike',
  'sunShadows',
  'thunder',
  'tokenGrounding',
  'vegetation',
  'water',
  'wind',
  'window',
  'uiWindowShadow',
  'doorGraphics',
  'smellyFlies',
  'maggots',
  'fireflies',
  'dust',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP(`http://localhost:${CDP}`);
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes('/game')) ?? context.pages()[0];
await page.bringToFront();
const cdp = await context.newCDPSession(page);

await page.evaluate(async () => {
  for (let i = 0; i < 300; i++) {
    if (MapShine.getSceneSettle?.()?.settled) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
});

if (pacing) await page.evaluate((m) => MapShine.setFramePacing?.(/^\d$/.test(m) ? Number(m) : m), pacing);
if (smooth) await page.evaluate((on) => MapShine.setSmoothPan?.(on), smooth !== 'off');
let forced = [];
if (effects === 'off') {
  forced = await page.evaluate((ids) => {
    const ok = [];
    for (const id of ids) {
      try {
        MapShine.forceEffect(id, false);
        ok.push(id);
      } catch {}
    }
    return ok;
  }, EFFECT_IDS);
  await sleep(3000);
}

/** In-page recorder: one row per animation frame. */
const startRecorder = () =>
  page.evaluate(() => {
    const rec = (window.__panRec = { on: true, rows: [], moves: 0, pans: 0 });
    // Input actually delivered vs pans Foundry actually made, per frame — tells "no
    // mouse event this frame" apart from "an event arrived and was thrown away".
    if (!window.__panRecHooks) {
      window.__panRecHooks = true;
      window.addEventListener('pointermove', () => window.__panRec && window.__panRec.moves++, true);
      Hooks.on('canvasPan', () => window.__panRec && window.__panRec.pans++);
    }
    // Read on Foundry's ticker at LOW priority: after Foundry's own camera updates
    // (animatePan, the key glide) in the same frame, which is where MSA reads it too
    // (measured: MSA's syncFoundryCamera runs after the ticker on every frame). A plain
    // rAF callback runs BEFORE the ticker and records every ticker-driven move a frame late.
    const ticker = canvas.app.ticker;
    const tick = () => {
      const s = canvas.stage;
      // drawn: did this frame reach the screen (frame pacing may skip it)? Same-timestamp
      // calls only read the frame's decision.
      const drawn = MapShine.framePacingDecided ? MapShine.framePacingDecided(ticker.lastTime) : true;
      rec.rows.push([ticker.lastTime, s.pivot.x, s.pivot.y, s.scale.x, rec.moves, rec.pans, drawn ? 1 : 0]);
      rec.moves = 0;
      rec.pans = 0;
      if (!rec.on) ticker.remove(tick);
    };
    ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW);
  });
const stopRecorder = () =>
  page.evaluate(() => {
    window.__panRec.on = false;
    return window.__panRec.rows;
  });

async function placeCamera() {
  // Start left of centre so a rightward pan stays on the map.
  await page.evaluate(() => {
    const r = canvas.dimensions.sceneRect;
    canvas.pan({ x: r.x + r.width * 0.3, y: r.y + r.height * 0.5, scale: 0.6 });
  });
  await sleep(1500);
}

async function runDrag() {
  const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const x0 = Math.round(w * 0.8);
  const y = Math.round(h * 0.5);
  const send = (type, x, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: 2, clickCount: 1, ...extra });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y, button: 'none', buttons: 0 });
  await send('mousePressed', x0);
  // Get past Foundry's drag resistance before measuring.
  for (let i = 1; i <= 10; i++) {
    await send('mouseMoved', x0 - i);
    await sleep(4);
  }
  await startRecorder();
  const t0 = performance.now();
  for (;;) {
    const el = (performance.now() - t0) / 1000;
    if (el >= seconds) break;
    // Mouse moves LEFT: the view pans right across the map. No sleep: each CDP round
    // trip (~1 ms) paces the loop, like a 1000 Hz mouse (Windows timers are too coarse
    // for a 2 ms setTimeout to mean 2 ms).
    await send('mouseMoved', x0 - 10 - speed * el);
  }
  const rows = await stopRecorder();
  await send('mouseReleased', x0 - 10 - speed * seconds);
  return rows;
}

async function runKey() {
  await page.mouse.move(400, 300);
  const key = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
  await startRecorder();
  const t0 = performance.now();
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  let n = 1;
  for (;;) {
    const el = performance.now() - t0;
    if (el >= seconds * 1000) break;
    // Windows: first repeat after ~500 ms, then ~30 per second.
    const due = 500 + (n - 1) * 33;
    if (el >= due) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', autoRepeat: true, ...key });
      n++;
    }
    await sleep(2);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await sleep(300);
  return stopRecorder();
}

async function runIdeal() {
  return page.evaluate(
    ({ speed, seconds }) =>
      new Promise((resolve) => {
        const rows = [];
        const s = canvas.stage;
        const x0 = s.pivot.x;
        const y0 = s.pivot.y;
        const sc = s.scale.x;
        let t0 = null;
        // Registered BEFORE the recorder's read, in the same callback, so the row is
        // exactly the camera this frame set.
        const tick = (t) => {
          if (t0 === null) t0 = t;
          const el = (t - t0) / 1000;
          canvas.pan({ x: x0 + (speed * el) / sc, y: y0 });
          const drawn = MapShine.framePacingDecided ? MapShine.framePacingDecided(t) : true;
          rows.push([t, s.pivot.x, s.pivot.y, s.scale.x, 0, 0, drawn ? 1 : 0]);
          if (el < seconds) requestAnimationFrame(tick);
          else resolve(rows);
        };
        requestAnimationFrame(tick);
      }),
    { speed, seconds }
  );
}

function analyse(allRows, { skipStartMs = 300, skipEndMs = 150 } = {}) {
  // Only frames that reached the screen: with frame pacing on, the others were skipped.
  const rows = allRows.filter((r) => r[6] !== 0);
  const t0 = rows[0][0];
  const tEnd = rows.at(-1)[0];
  // Screen px: world step * scale.
  const pts = rows.map(([t, x, , s]) => ({ t, x: x * s }));
  const seg = pts.filter((p) => p.t - t0 >= skipStartMs && tEnd - p.t >= skipEndMs);
  // Drop a stationary tail/head (the pan must actually be moving).
  const n = seg.length;
  if (n < 10) return { error: 'too few frames', frames: n };
  const dur = seg.at(-1).t - seg[0].t;
  const v = (seg.at(-1).x - seg[0].x) / dur; // px per ms
  const steps = [];
  const dts = [];
  let holds = 0;
  let doubles = 0;
  for (let i = 1; i < n; i++) {
    const dt = seg[i].t - seg[i - 1].t;
    const dx = seg[i].x - seg[i - 1].x;
    dts.push(dt);
    const due = v * dt;
    steps.push(dx / dt / v);
    if (Math.abs(dx) < 0.25 * Math.abs(due)) holds++;
    else if (Math.abs(dx) > 1.75 * Math.abs(due)) doubles++;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
  };
  // Straight-line fit of x(t): residual spread = wobble.
  const tm = mean(seg.map((p) => p.t));
  const xm = mean(seg.map((p) => p.x));
  let num = 0;
  let den = 0;
  for (const p of seg) {
    num += (p.t - tm) * (p.x - xm);
    den += (p.t - tm) ** 2;
  }
  const slope = num / den;
  const resid = seg.map((p) => p.x - (xm + slope * (p.t - tm)));
  return {
    frames: n,
    speedPxPerS: +(v * 1000).toFixed(0),
    stepCvPct: +(100 * sd(steps)).toFixed(1),
    holds,
    doubles,
    wobblePx: +sd(resid).toFixed(2),
    frameMs: {
      mean: +mean(dts).toFixed(2),
      sd: +sd(dts).toFixed(2),
      worst: +Math.max(...dts).toFixed(1),
    },
  };
}

/** `--profile x.cpuprofile`: a V8 CPU profile of the LAST run, plus its top self-time list. */
const profileOut = opt('profile', null);
function summariseProfile(prof, top = 25) {
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dts = prof.timeDeltas;
  prof.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return {
    totalMs: +total.toFixed(0),
    top: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, ms]) => `${((100 * ms) / total).toFixed(1).padStart(5)}%  ${k}`),
  };
}

const results = [];
try {
  for (let r = 0; r < runs; r++) {
    await placeCamera();
    const profiling = profileOut && r === runs - 1;
    if (profiling) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    const rows = mode === 'drag' ? await runDrag() : mode === 'key' ? await runKey() : await runIdeal();
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop');
      fs.writeFileSync(profileOut, JSON.stringify(profile));
      const s = summariseProfile(profile);
      console.log(`[profile] ${s.totalMs} ms sampled\n` + s.top.join('\n'));
    }
    const a = analyse(rows, mode === 'key' ? { skipStartMs: 700, skipEndMs: 500 } : undefined); // key: the recorder runs 300 ms past the release (the ease-out is not a hold)
    results.push(a);
    console.log(JSON.stringify({ run: r + 1, mode, effects, smooth, pacing, ...a }));
    if (out) fs.writeFileSync(out.replace(/\.json$/, '') + `.r${r + 1}.rows.json`, JSON.stringify(rows));
  }
} finally {
  if (forced.length) {
    await page.evaluate((ids) => ids.forEach((id) => MapShine.forceEffect(id, null)), forced);
  }
}
if (out) fs.writeFileSync(out, JSON.stringify({ mode, effects, speed, seconds, forced, results }, null, 1));
await browser.close().catch(() => {});
process.exit(0);
