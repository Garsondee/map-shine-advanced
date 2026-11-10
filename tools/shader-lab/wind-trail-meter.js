// WIND TRAILS METER (2026-11-10). A lone async function (lints as a module); drive.mjs wants a BODY, so append a call:
//   SHADER_LAB_PORT=8975 node tools/shader-lab/serve.mjs   (+ a Chrome with --remote-debugging-port=9335 --enable-unsafe-webgpu)
//   { cat tools/shader-lab/wind-trail-meter.js; echo 'return meter();'; } > $TMP/m.js
//   node tools/shader-lab/drive.mjs --cdp http://127.0.0.1:9335 --url http://localhost:8975/tools/shader-lab/wind-lab.html --script $TMP/m.js --wait '!!window.windLab'
// reborn in view before its fade-out) and big drops. Wait on window.windLab, never on the status text (the ticker overwrites it).
// eslint-disable-next-line no-unused-vars -- called by the one-line wrapper above
async function meter() {
  const L = window.windLab;
  L.set({ heat: false, arrows: false, candles: false, win: false, paused: true, trails: true });
  const out = {};
  const READ_EVERY = 3; // frames between read-backs (50 ms)
  for (const wind of [0.3, 0.6, 1.0]) {
    L.set({ wind });
    await L.stepSeconds(4); // let the population settle at this wind
    const prev = new Map();
    let reads = 0;
    let visSum = 0;
    let visMax = 0;
    let births = 0;
    let cuts = 0;
    let bigDrops = 0;
    const cutLog = [];
    const lives = [];
    const strengths = [];
    const SECONDS = 12;
    const frames = SECONDS * 60;
    let r0 = null;
    for (let f = 0; f < frames; f += READ_EVERY) {
      for (let k = 0; k < READ_EVERY; k++) await L.stepSeconds(1 / 60);
      const r = await L.readTrails();
      r0 ??= r;
      reads++;
      let vis = 0;
      r.trails.forEach((t, i) => {
        const shown = t.gate * (1 - t.fade);
        const fadeIn = Math.min(1, t.ageMs / r.fadeMs);
        if (shown * fadeIn > 0.05) vis++;
        const p = prev.get(i);
        if (p) {
          const reborn = t.ageMs < p.ageMs;
          if (reborn) {
            if (t.gate > 0) {
              births++;
              strengths.push(t.gate);
            }
            if (p.gate > 0) lives.push(p.ageMs);
            // a living trail reborn before any life could have entered its fade-out, while still showing = a CUT
            if (p.gate * (1 - p.fade) >= 0.2 && p.ageMs < 2600 * 0.65 - r.fadeMs && p.inView) {
              cuts++;
              if (cutLog.length < 5) cutLog.push({ i, prev: p, now: { gate: t.gate, fade: t.fade, ageMs: t.ageMs } });
            }
          } else if (p.gate * (1 - p.fade) - shown > 0.15) {
            bigDrops++;
            if (cutLog.length < 5) cutLog.push({ i, drop: true, prev: p, now: { gate: t.gate, fade: t.fade } });
          }
        }
        const hd = t.pts[t.pts.length - 1];
        prev.set(i, {
          gate: t.gate,
          fade: t.fade,
          ageMs: t.ageMs,
          inView: hd[0] > 0 && hd[0] < 1280 && hd[1] > 0 && hd[1] < 720,
        });
      });
      visSum += vis;
      visMax = Math.max(visMax, vis);
    }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    out['wind_' + String(wind).replace('.', '_')] = {
      activeSlots: r0.activeTrails,
      meanVisible: +(visSum / reads).toFixed(2),
      maxVisible: visMax,
      birthsPerMin: +((births / SECONDS) * 60).toFixed(1),
      meanStrength: +mean(strengths).toFixed(2),
      meanLifeSec: +(mean(lives) / 1000).toFixed(2),
      cuts,
      bigDrops,
      cutLog,
    };
  }
  return out;
}
