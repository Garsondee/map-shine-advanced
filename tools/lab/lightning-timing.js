/**
 * tools/lab/lightning-timing.js — measure storm flashes frame by frame (MSA Lab, weather family, WX-50).
 * cdp `eval --file` body; args = {seconds: 40}. Samples MapShine.getStormLightning().frame every animation
 * frame and reports, per strike: duration of visible light, number of separate peaks (strokes), the gaps
 * between them, peak brightness and kind. Real flashes: 0.2-0.5 s, 1-4 return strokes 40-80 ms apart.
 */
/* global MapShine */
const a = typeof args === 'object' && args ? args : {};
const seconds = a.seconds ?? 40;
const samples = [];
const t0 = performance.now();
await new Promise((resolve) => {
  const tick = () => {
    const t = performance.now() - t0;
    const f = MapShine.getStormLightning()?.frame ?? {};
    samples.push({ t, f: f.flash01 ?? 0, id: f.strikeId ?? null, kind: f.kind ?? null });
    if (t < seconds * 1000) requestAnimationFrame(tick);
    else resolve();
  };
  requestAnimationFrame(tick);
});
const frameMs = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1) : null;
const strikes = new Map();
for (const s of samples) {
  if (!s.id || !(s.f > 0.02)) continue;
  if (!strikes.has(s.id)) strikes.set(s.id, { kind: s.kind, pts: [] });
  strikes.get(s.id).pts.push(s);
}
const out = [];
for (const [id, st] of strikes) {
  const p = st.pts;
  const dur = p[p.length - 1].t - p[0].t;
  // strokes: local maxima above 35% of the strike's own peak, separated by a dip below 60% of the smaller peak
  const peak = Math.max(...p.map((q) => q.f));
  const peaks = [];
  for (let i = 1; i < p.length - 1; i++) {
    if (p[i].f >= p[i - 1].f && p[i].f > p[i + 1].f && p[i].f > 0.35 * peak) peaks.push(p[i]);
  }
  const strokes = [];
  for (const q of peaks) {
    const last = strokes[strokes.length - 1];
    if (!last) strokes.push(q);
    else {
      const between = p.filter((r) => r.t > last.t && r.t < q.t);
      const dip = between.length ? Math.min(...between.map((r) => r.f)) : q.f;
      if (dip < 0.6 * Math.min(last.f, q.f)) strokes.push(q);
      else if (q.f > last.f) strokes[strokes.length - 1] = q;
    }
  }
  const gaps = strokes.slice(1).map((q, i) => Math.round(q.t - strokes[i].t));
  out.push({ id, kind: st.kind, durMs: Math.round(dur), strokes: strokes.length, gapsMs: gaps, peak: +peak.toFixed(2) });
}
return { seconds, frames: samples.length, frameMs: frameMs && +frameMs.toFixed(1), strikes: out };
