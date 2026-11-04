#!/usr/bin/env node
/**
 * tools/video-capture/record.mjs — hitch-free map videos, rendered OFFLINE.
 *
 * WHY: a screen recorder films the screen in real time, so one compile, GC
 * pause or slow page upload lands in the video as a stutter. This tool never
 * films the screen. It puts Map Shine Advanced into capture mode
 * (`MapShine.capture`, core/frame-clock.js's capture clock): for video frame n
 * the world's time is exactly n/fps, the camera is exactly where the shot plan
 * says it is at that instant, everything the view needs is loaded before the
 * frame is drawn, and the pixels are read back and piped into ffmpeg. However
 * long a frame takes to make, it sits exactly 1/fps after the last one.
 *
 * It drives a PRIVATE Foundry (never the live server — capture mode stops the
 * live loop for whoever is watching): Chrome via Playwright, at the capture
 * size as the page's viewport (default 3840x2160, device scale 1).
 *
 *   node tools/video-capture/record.mjs boot  --url http://localhost:30060 [--cdp 9360] [--width 3840 --height 2160]
 *       launch Chrome, log in as Gamemaster, leave it running (Ctrl+C to quit)
 *   node tools/video-capture/record.mjs run   --plan plan.json --out <dir> [--cdp 9360]
 *       render every shot in the plan to <dir>/<shot>.mp4 + <dir>/<shot>.frames.json
 *   node tools/video-capture/record.mjs eval  --file script.js [--cdp 9360]
 *       run an async page script (body of an async function; `args` = --args JSON)
 *
 * Plan (JSON): {
 *   "fps": 60, "renderScale": "1",
 *   "encoder": { "codec": "avc1.640034", "qp": 18 },  // default: Chrome's hardware encoder
 *              // (WebCodecs) at a FIXED quantizer — variable bitrate pumped detail every 2 s on
 *              // pans (README, "Pan jitter"). "qp": null + "bitrate" = variable bitrate.
 *              // "x264" = RGBA readback + libx264 ("crf", "preset" apply), slower.
 *   "stall": { "everyFrames": 0, "ms": 0 },     // TEST ONLY: freeze the page between frames
 *   "shots": [ { "name": "01-sweep", "seconds": 6, "easing": "cosine", "preRollSec": 1.5,
 *                "setup": "optional page script run before the shot",
 *                "keys": [ { "t": 0, "x": 1000, "y": 800, "scale": 0.5 },
 *                          { "t": 1, "x": 4000, "y": 2600, "scale": 0.8 } ] } ]
 * }
 * `t` is 0..1 across the shot. Position eases per segment; scale is
 * interpolated geometrically (equal ratios per second), which is how a zoom
 * reads as even to the eye.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const log = (...a) => console.log('[video-capture]', ...a);

const CDP_PORT = Number(opt('cdp', 9360));

function findFfmpeg() {
  const explicit = opt('ffmpeg', process.env.FFMPEG);
  if (explicit) return explicit;
  // The machine's ffmpeg ships inside imageio-ffmpeg (Python); fall back to PATH.
  const appdata = process.env.APPDATA ?? '';
  for (const py of ['Python314', 'Python313', 'Python312', 'Python311']) {
    const dir = path.join(appdata, 'Python', py, 'site-packages', 'imageio_ffmpeg', 'binaries');
    if (fs.existsSync(dir)) {
      const exe = fs.readdirSync(dir).find((f) => /^ffmpeg.*\.exe$/i.test(f));
      if (exe) return path.join(dir, exe);
    }
  }
  return 'ffmpeg';
}

async function boot() {
  const url = opt('url', 'http://localhost:30060');
  const width = Number(opt('width', 3840));
  const height = Number(opt('height', 2160));
  const profile = opt('profile', path.join(HERE, '.chrome-profile'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: { width, height },
    deviceScaleFactor: 1,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      '--enable-unsafe-webgpu',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 300)));
  await page.goto(url + '/join', { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/join')) {
    await page.fill('input[name=username]', opt('user', 'Gamemaster'));
    await Promise.all([
      page.waitForURL('**/game', { timeout: 120000 }),
      page.click('button[type=submit], button[name=join]'),
    ]);
  }
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 300000 });
  log(`game ready at ${width}x${height}; leaving Chrome running on CDP ${CDP_PORT}`);
  await new Promise(() => {});
}

async function connect() {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('/game')) ?? context.pages()[0];
  return { browser, page };
}

/**
 * A one-shot local sink: the page POSTs each frame's raw RGBA here, in order,
 * and every frame goes straight into ffmpeg's stdin. The response is only sent
 * once ffmpeg has accepted the bytes, so the page can never run ahead of the
 * encoder (backpressure) and no frame is ever dropped or repeated: an
 * out-of-order or wrong-sized frame is refused and fails the run loudly.
 */
/**
 * The WebCodecs sink: the page encodes on the GPU (Chrome's hardware encoder)
 * and POSTs the Annex-B elementary stream here in numbered pieces; they are
 * appended to <file>.264/.265 in order, then ffmpeg only REMUXES it into an
 * .mp4 at an exact constant frame rate (no re-encode, so no quality loss).
 */
function startStreamSink({ file, fps, ext }) {
  const raw = `${file}.${ext}`;
  const fd = fs.openSync(raw, 'w');
  let nextIndex = 0;
  let bytes = 0;
  let failure = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') {
      res.writeHead(204);
      res.end();
      return;
    }
    const index = Number(new URL(req.url, 'http://x').searchParams.get('i'));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (index !== nextIndex) {
        failure = `stream piece ${index} refused: expected ${nextIndex}`;
        res.writeHead(409);
        res.end(failure);
        return;
      }
      nextIndex++;
      fs.writeSync(fd, buf);
      bytes += buf.length;
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        frames: () => null,
        bytes: () => bytes,
        failure: () => failure,
        async finish() {
          server.close();
          fs.closeSync(fd);
          const ff = spawn(
            findFfmpeg(),
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-framerate',
              String(fps),
              '-i',
              raw,
              '-c',
              'copy',
              '-movflags',
              '+faststart',
              file,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
          );
          let err = '';
          ff.stderr.on('data', (d) => (err += d.toString()));
          const code = await new Promise((r) => ff.on('close', r));
          if (code === 0 && !opt('keep-stream')) fs.rmSync(raw, { force: true });
          return { code, stderrTail: err.slice(-4000) };
        },
      });
    });
  });
}

function startFrameSink({ ffmpegArgs, width, height }) {
  const ffmpegPath = findFfmpeg();
  const ff = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => {
    ffErr = (ffErr + d.toString()).slice(-4000);
  });
  const ffDone = new Promise((resolve) => ff.on('close', (code) => resolve(code)));
  const expectBytes = width * height * 4;
  let nextIndex = 0;
  let failure = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') {
      res.writeHead(204);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://x');
    const index = Number(u.searchParams.get('i'));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (index !== nextIndex || buf.length !== expectBytes) {
        failure = `frame ${index} refused: expected index ${nextIndex}, ${expectBytes} bytes; got ${buf.length} bytes`;
        res.writeHead(409);
        res.end(failure);
        return;
      }
      nextIndex++;
      ff.stdin.write(buf, (err) => {
        if (err) {
          failure = `ffmpeg refused frame ${index}: ${err.message}`;
          res.writeHead(500);
          res.end(failure);
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        frames: () => nextIndex,
        failure: () => failure,
        async finish() {
          server.close();
          ff.stdin.end();
          const code = await ffDone;
          return { code, stderrTail: ffErr };
        },
      });
    });
  });
}

/** The per-shot page loop, serialised into the page. Runs entirely in-page so
 * no CDP round trip sits between frames. */
const PAGE_SHOT_LOOP = async ({ shot, fps, sinkUrl, stall, renderScale, encoder, stills }) => {
  const ease = {
    linear: (u) => u,
    cosine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u),
    // smootherstep: zero velocity AND acceleration at both ends
    smooth: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  };
  // Keep each KEY's frame on the map (storyboard.py's clamp_keys is the same
  // rule): a 4K frame at zoom 0.6 is ~6,400 map px wide, so a key near the
  // edge would otherwise film mostly black padding. Keys, not frames — per-
  // frame clamping would stop the camera dead at the edge mid-move.
  const sr = canvas.dimensions.sceneRect;
  const vpNow = MapShine.capture.status();
  const clampKey = (k) => {
    if (shot.allowOutside) return { ...k };
    const hw = vpNow.width / 2 / k.scale;
    const hh = vpNow.height / 2 / k.scale;
    const x = 2 * hw >= sr.width ? sr.x + sr.width / 2 : Math.min(Math.max(k.x, sr.x + hw), sr.x + sr.width - hw);
    const y = 2 * hh >= sr.height ? sr.y + sr.height / 2 : Math.min(Math.max(k.y, sr.y + hh), sr.y + sr.height - hh);
    return { ...k, x, y };
  };
  const keys = [...shot.keys].sort((a, b) => a.t - b.t).map(clampKey);
  const easing = ease[shot.easing] ?? ease.cosine;
  const camAt = (u) => {
    if (u <= keys[0].t) return keys[0];
    const last = keys[keys.length - 1];
    if (u >= last.t) return last;
    let i = 0;
    while (i < keys.length - 2 && u > keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const s = easing((u - a.t) / Math.max(1e-9, b.t - a.t));
    return {
      x: a.x + (b.x - a.x) * s,
      y: a.y + (b.y - a.y) * s,
      scale: a.scale * Math.pow(b.scale / a.scale, s),
    };
  };
  const total = Math.max(1, Math.round(shot.seconds * fps));
  const dtMs = 1000 / fps;
  const stats = [];
  const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- SHOT SETUP: level, weather, wind, sun — all landed BEFORE capture begins.
  if (shot.level) {
    const lv = canvas.scene.levels.contents.find((l) => l.id === shot.level || l.name === shot.level);
    if (!lv) throw new Error(`shot ${shot.name}: no level "${shot.level}"`);
    if (canvas.level?.id !== lv.id) {
      await canvas.scene.view({ level: lv.id });
      for (let i = 0; i < 480; i++) {
        const st = MapShine.capture.status();
        if (!st.reason && canvas.level?.id === lv.id && MapShine.getSceneSettle?.()?.settled) break;
        await sleep0(250);
      }
    }
  }
  // Weather: a name lands immediately; {from, to} lands on `from` and is then
  // blended per VIDEO frame (frame-exact, unlike the manager's own real-ish ease).
  let weatherBlend = null;
  if (typeof shot.weather === 'string') {
    MapShine.setWeatherArchetype(shot.weather, 'video', { immediate: true });
  } else if (shot.weather?.from && shot.weather?.to) {
    MapShine.setWeatherArchetype(shot.weather.to, 'video', { immediate: true });
    const toState = { ...MapShine.getWeatherState().state };
    MapShine.setWeatherArchetype(shot.weather.from, 'video', { immediate: true });
    const fromState = { ...MapShine.getWeatherState().state };
    const keysW = Object.keys(fromState).filter((k) => Number.isFinite(fromState[k]) && Number.isFinite(toState[k]));
    weatherBlend = {
      fromState,
      toState,
      keysW,
      ease: ease[shot.weather.ease] ?? ease.smooth,
      start: shot.weather.startT ?? 0,
      end: shot.weather.endT ?? 1,
    };
  }
  const applyWeather = (u) => {
    if (!weatherBlend) return;
    const { fromState, toState, keysW, start, end } = weatherBlend;
    const s = weatherBlend.ease(Math.min(1, Math.max(0, (u - start) / Math.max(1e-9, end - start))));
    const patch = {};
    for (const k of keysW) patch[k] = fromState[k] + (toState[k] - fromState[k]) * s;
    MapShine.setWeatherTargets(patch, { immediate: true });
  };
  // Per-axis override on top of the archetype (e.g. a lighter snow than the
  // 'snow' row's 0.6), landed immediately.
  if (shot.weatherAxes) MapShine.setWeatherTargets(shot.weatherAxes, { immediate: true });
  if (shot.wind) await MapShine.setWind(shot.wind);
  // Sun: a number holds; [from, to] is a time-lapse across the shot (linear).
  const sunAt = (u) =>
    Array.isArray(shot.sunHour) ? shot.sunHour[0] + (shot.sunHour[1] - shot.sunHour[0]) * u : shot.sunHour;
  if (shot.sunHour != null) MapShine.setSunHour(sunAt(0));
  if (shot.setup) await new Function('return (async () => {' + shot.setup + '})()')();
  // Frame 0's camera BEFORE capture starts, so the begin-of-shot load happens
  // with the right view and the first frame needs no long wait.
  canvas.pan(camAt(0));
  const status = await MapShine.capture.begin({ renderScale });
  // --- WebCodecs: encode on the GPU in-page, ship only the compressed stream.
  let enc = null;
  let encError = null;
  let pieces = [];
  let piecesBytes = 0;
  let pieceIndex = 0;
  let encoderInfo = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shipPieces = async () => {
    if (!pieces.length) return;
    const body = new Uint8Array(piecesBytes);
    let o = 0;
    for (const p of pieces) {
      body.set(p, o);
      o += p.length;
    }
    pieces = [];
    piecesBytes = 0;
    // A Blob body, not the bytes: DevTools copies a bytes body into every
    // Network.requestWillBeSent it sends Playwright, so at QP 18 (~200 Mbit/s)
    // whole video pieces flowed through the CDP socket (1.4 GB of protocol for a
    // 16 s shot) until Playwright dropped the page: "Target page, context or
    // browser has been closed" at the end of long shots. Blob bodies are not inlined.
    const resp = await fetch(`${sinkUrl}/piece?i=${pieceIndex++}`, {
      method: 'POST',
      body: new Blob([body]),
      headers: { 'Content-Type': 'text/plain' },
    });
    if (!resp.ok) throw new Error(`sink refused a stream piece: ${await resp.text()}`);
  };
  if (encoder) {
    const hevc = encoder.codec.startsWith('hvc1') || encoder.codec.startsWith('hev1');
    const cfg = {
      codec: encoder.codec,
      width: status.width,
      height: status.height,
      // QUANTIZER (constant quality) is the default — found 2026-11-04: in
      // 'variable' mode the hardware encoder starved P-frames while the camera
      // moved (51 Mbps of a 120 Mbps target) so detail drained across each
      // 2 s group and snapped back at the keyframe — a +30% sharpness pulse
      // every 2 s that only shows during pans. A fixed QP per frame has none.
      ...(encoder.qp != null ? { bitrateMode: 'quantizer' } : { bitrate: encoder.bitrate, bitrateMode: 'variable' }),
      framerate: fps,
      latencyMode: 'quality',
      hardwareAcceleration: encoder.hardware ?? 'prefer-hardware',
      ...(hevc ? { hevc: { format: 'annexb' } } : { avc: { format: 'annexb' } }),
    };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup.supported) {
      MapShine.capture.end();
      throw new Error(`this Chrome cannot encode ${JSON.stringify(cfg)}`);
    }
    encoderInfo = cfg;
    enc = new VideoEncoder({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        pieces.push(b);
        piecesBytes += b.length;
      },
      error: (e) => {
        encError = e;
      },
    });
    enc.configure(cfg);
  }
  try {
    // PRE-ROLL (found by the proof runs): the first frames after a load or a
    // cut still had exposure adapting and effects arriving — a visible
    // brightening and one pop by frame 4. Run world time forward at the
    // opening camera without recording, the way a film camera rolls before
    // "action": exposure settles, smoke/rain/particles reach their steady
    // state instead of starting empty.
    const preRoll = Math.round((shot.preRollSec ?? 1.5) * fps);
    for (let k = 0; k < preRoll; k++) {
      canvas.pan(camAt(0));
      await MapShine.capture.frame({ dtMs, readback: false });
    }
    // STILLS (preview): the shot's real setup, a few frames at chosen points,
    // saved as half-size JPEGs — a lit, weathered storyboard in seconds.
    if (stills) {
      const shrink = document.createElement('canvas');
      for (const [j, u] of stills.entries()) {
        const cam = camAt(u);
        canvas.pan({ x: cam.x, y: cam.y, scale: cam.scale });
        if (Array.isArray(shot.sunHour)) MapShine.setSunHour(sunAt(u));
        applyWeather(u);
        // a short settle at the new spot so particles/exposure are not mid-jump
        for (let k = 0; k < 20; k++) await MapShine.capture.frame({ dtMs, readback: false });
        const f = await MapShine.capture.frame({ dtMs, readback: true });
        const full = new ImageData(new Uint8ClampedArray(f.pixels.buffer), f.width, f.height);
        const tmp = document.createElement('canvas');
        tmp.width = f.width;
        tmp.height = f.height;
        tmp.getContext('2d').putImageData(full, 0, 0);
        shrink.width = f.width / 2;
        shrink.height = f.height / 2;
        shrink.getContext('2d').drawImage(tmp, 0, 0, shrink.width, shrink.height);
        const blob = await new Promise((r) => shrink.toBlob(r, 'image/jpeg', 0.9));
        const resp = await fetch(`${sinkUrl}/still?name=${encodeURIComponent(`${shot.name}-${j}`)}`, {
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': 'text/plain' },
        });
        if (!resp.ok) throw new Error(`still sink: ${await resp.text()}`);
      }
      return { status, stats: [], encoderInfo: null };
    }
    for (let i = 0; i < total; i++) {
      const u = total === 1 ? 0 : i / (total - 1);
      const cam = camAt(u);
      canvas.pan({ x: cam.x, y: cam.y, scale: cam.scale });
      if (Array.isArray(shot.sunHour)) MapShine.setSunHour(sunAt(u));
      applyWeather(u);
      const f = await MapShine.capture.frame({
        dtMs,
        readback: 'videoframe',
        timestampUs: Math.round((i * 1e6) / fps),
      });
      if (!enc) {
        // x264 path: RGBA straight out of the VideoFrame (far faster than the
        // 2D-canvas copy the first version used — ~4.7 s/frame).
        f.pixels = new Uint8Array(f.videoFrame.allocationSize({ format: 'RGBA' }));
        await f.videoFrame.copyTo(f.pixels, { format: 'RGBA' });
        f.videoFrame.close();
      }
      if (enc) {
        if (encError) throw encError;
        const isHevc = encoder.codec.startsWith('hvc1') || encoder.codec.startsWith('hev1');
        const qpOpt =
          encoder.qp != null ? (isHevc ? { hevc: { quantizer: encoder.qp } } : { avc: { quantizer: encoder.qp } }) : {};
        enc.encode(f.videoFrame, { keyFrame: i % Math.round(fps * (encoder.keySec ?? 2)) === 0, ...qpOpt });
        f.videoFrame.close();
        while (enc.encodeQueueSize > 3) await sleep(1);
        if (piecesBytes > 8e6) await shipPieces();
      } else {
        const resp = await fetch(`${sinkUrl}/frame?i=${i}`, {
          method: 'POST',
          body: new Blob([f.pixels]), // Blob: kept out of the CDP socket (see shipPieces)
          headers: { 'Content-Type': 'text/plain' },
        });
        if (!resp.ok) throw new Error(`sink refused frame ${i}: ${await resp.text()}`);
      }
      stats.push({
        i,
        tMs: f.tMs,
        dtSec: f.dtSec,
        timeScale: f.timeScale,
        warm: f.warmFrames,
        timedOut: f.timedOut,
        blockers: f.blockers,
        cam,
        sunHour: shot.sunHour != null ? sunAt(u) : null,
        stage: { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x },
      });
      if (stall?.everyFrames > 0 && i % stall.everyFrames === stall.everyFrames - 1) {
        // TEST ONLY: a deliberate main-thread freeze, the shape of a real hitch.
        const until = performance.now() + stall.ms;
        while (performance.now() < until) {
          /* frozen */
        }
      }
    }
    if (enc) {
      await enc.flush();
      if (encError) throw encError;
      await shipPieces();
    }
  } finally {
    try {
      enc?.close();
    } catch {
      /* already closed */
    }
    MapShine.capture.end();
  }
  return { status, stats, encoderInfo };
};

async function run() {
  const planPath = opt('plan');
  if (!planPath) throw new Error('--plan <plan.json> is required');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const out = path.resolve(opt('out', path.join(HERE, 'out')));
  fs.mkdirSync(out, { recursive: true });
  const fps = Number(plan.fps ?? 60);
  const only = opt('only'); // render just one named shot
  const { browser, page } = await connect();
  const size = await page.evaluate(() => MapShine.capture.status());
  if (!size || !size.width) throw new Error(`no MSA viewer running: ${JSON.stringify(size)}`);
  await page.evaluate(() => {
    // A paused world eases its time scale to 0 (frame-clock.js), which would
    // freeze every animation in the video. Capture runs unpaused.
    if (game.paused) game.togglePause(false, { broadcast: true });
  });
  const report = [];
  const stillsMode = argv.includes('--stills');
  if (stillsMode) {
    const dir = path.join(out, 'stills');
    fs.mkdirSync(dir, { recursive: true });
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method !== 'POST') return void res.writeHead(204).end();
      const name = new URL(req.url, 'http://x').searchParams.get('name').replace(/[^\w.-]/g, '_');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(path.join(dir, `${name}.jpg`), Buffer.concat(chunks));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    for (const shot of plan.shots) {
      if (only && shot.name !== only) continue;
      const t0 = Date.now();
      await page.evaluate(PAGE_SHOT_LOOP, {
        shot,
        fps,
        sinkUrl: `http://127.0.0.1:${server.address().port}`,
        stall: null,
        renderScale: plan.renderScale ?? '1',
        encoder: null,
        stills: [0, 0.5, 1],
      });
      log(`stills ${shot.name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    server.close();
    await browser.close().catch(() => {});
    return;
  }
  for (const shot of plan.shots) {
    if (only && shot.name !== only) continue;
    const { width, height } = await page.evaluate(() => MapShine.capture.status());
    const file = path.join(out, `${shot.name}.mp4`);
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      '-',
      '-c:v',
      plan.codec ?? 'libx264',
      '-preset',
      plan.preset ?? 'slow',
      '-crf',
      String(plan.crf ?? 14),
      '-pix_fmt',
      'yuv420p',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-r',
      String(fps),
      '-movflags',
      '+faststart',
      file,
    ];
    // Default: Chrome's hardware encoder, straight off the GPU canvas.
    // "encoder": "x264" reads every frame back as RGBA and encodes with
    // libx264 instead — higher quality per bit, but slow at 4K.
    const encoder =
      plan.encoder === 'x264'
        ? null
        : {
            codec: plan.encoder?.codec ?? 'avc1.640034', // H.264 High @ L5.2 (4K60)
            bitrate: Number(plan.encoder?.bitrate ?? 120e6),
            // constant quality by default; "qp": null in the plan returns to variable bitrate
            qp: plan.encoder?.qp === null ? null : Number(plan.encoder?.qp ?? 16),
            keySec: Number(plan.encoder?.keySec ?? 2),
            hardware: plan.encoder?.hardware ?? 'prefer-hardware',
          };
    const sink = encoder
      ? await startStreamSink({ file, fps, ext: /^(hvc1|hev1)/.test(encoder.codec) ? '265' : '264' })
      : await startFrameSink({ ffmpegArgs, width, height });
    const started = Date.now();
    log(`shot ${shot.name}: ${shot.seconds}s at ${fps} fps, ${width}x${height} -> ${file}`);
    let result;
    try {
      result = await page.evaluate(PAGE_SHOT_LOOP, {
        shot,
        fps,
        sinkUrl: `http://127.0.0.1:${sink.port}`,
        stall: plan.stall ?? null,
        renderScale: plan.renderScale ?? '1',
        encoder,
      });
    } finally {
      const ff = await sink.finish();
      if (ff.code !== 0) log(`ffmpeg exited ${ff.code}: ${ff.stderrTail}`);
    }
    const wallSec = (Date.now() - started) / 1000;
    const stats = result.stats;
    const dts = stats.slice(1).map((s) => s.dtSec);
    const summary = {
      shot: shot.name,
      file,
      frames: stats.length,
      sinkFrames: sink.frames(),
      wallSec: +wallSec.toFixed(1),
      msPerFrame: +((wallSec * 1000) / stats.length).toFixed(1),
      dtMin: Math.min(...dts),
      dtMax: Math.max(...dts),
      timeScaleMin: Math.min(...stats.map((s) => s.timeScale ?? 1)),
      warmFramesTotal: stats.reduce((a, s) => a + s.warm, 0),
      timedOutFrames: stats.filter((s) => s.timedOut).length,
      warmFramesMax: Math.max(...stats.map((s) => s.warm)),
      encoder: result.encoderInfo ?? 'x264',
      status: result.status,
    };
    fs.writeFileSync(path.join(out, `${shot.name}.frames.json`), JSON.stringify({ summary, stats }, null, 1));
    log(JSON.stringify(summary));
    report.push(summary);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  await browser.close().catch(() => {});
}

/** `survey`: the scene facts a shot plan and its storyboard need, as JSON. */
async function survey() {
  const out = path.resolve(opt('out', path.join(HERE, 'out', 'survey.json')));
  const { browser, page } = await connect();
  const data = await page.evaluate(() => {
    const d = canvas.dimensions;
    const st = MapShine.capture.status();
    return {
      scene: { id: canvas.scene.id, name: canvas.scene.name },
      sceneRect: { x: d.sceneRect.x, y: d.sceneRect.y, width: d.sceneRect.width, height: d.sceneRect.height },
      gridSize: d.size,
      viewport: { width: st.width, height: st.height },
      zoom: { min: CONFIG.Canvas.minZoom ?? null, max: CONFIG.Canvas.maxZoom ?? null },
      levels: canvas.scene.levels.contents.map((l) => ({
        id: l.id,
        name: l.name,
        elevation: l.elevation?.bottom ?? null,
        background: l.background?.src ?? null,
        lights: canvas.scene.lights.contents
          .filter((li) => [...(li.levels ?? [])].includes(l.id))
          .map((li) => ({ x: li.x, y: li.y, dim: li.config?.dim ?? 0, color: li.config?.color ?? null })),
      })),
      viewedLevel: canvas.level?.id ?? null,
      weatherArchetypes: MapShine.weatherArchetypes.map((a) => a.id),
    };
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  log(`survey -> ${out}`);
  await browser.close().catch(() => {});
}

async function evalScript() {
  const file = opt('file');
  const script = fs.readFileSync(file, 'utf8');
  const { browser, page } = await connect();
  const res = await page.evaluate(`(async (args) => { ${script} })(${opt('args', 'null')})`);
  console.log(JSON.stringify(res, null, 1));
  await browser.close().catch(() => {});
}

if (mode === 'boot') await boot();
else if (mode === 'run') await run();
else if (mode === 'eval') await evalScript();
else if (mode === 'survey') await survey();
else {
  console.log('usage: record.mjs boot|run|eval [options] — see the header of this file');
  process.exit(2);
}
