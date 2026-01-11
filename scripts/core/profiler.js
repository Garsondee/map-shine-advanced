export class Profiler {
  constructor(options = {}) {
    this.enabled = false;
    this.maxFrames = Math.max(60, options.maxFrames ?? 600);
    this.frames = new Array(this.maxFrames);
    this._writeIndex = 0;
    this._count = 0;

    this.resourceSampleEveryMs = Math.max(100, options.resourceSampleEveryMs ?? 1000);
    this.maxResourceSamples = Math.max(10, options.maxResourceSamples ?? 180);
    this.resourceSamples = new Array(this.maxResourceSamples);
    this._resourceWriteIndex = 0;
    this._resourceCount = 0;
    this._lastResourceSampleTime = 0;

    this._frame = null;
    this._frameStart = 0;
  }

  start(options = {}) {
    if (typeof options.maxFrames === 'number' && isFinite(options.maxFrames) && options.maxFrames > 0) {
      const nextMax = Math.max(60, Math.floor(options.maxFrames));
      if (nextMax !== this.maxFrames) {
        this.maxFrames = nextMax;
        this.frames = new Array(this.maxFrames);
        this._writeIndex = 0;
        this._count = 0;
      }
    }

    this.enabled = true;

    if (typeof options.resourceSampleEveryMs === 'number' && isFinite(options.resourceSampleEveryMs)) {
      this.resourceSampleEveryMs = Math.max(100, Math.floor(options.resourceSampleEveryMs));
    }
    if (typeof options.maxResourceSamples === 'number' && isFinite(options.maxResourceSamples) && options.maxResourceSamples > 0) {
      const nextMax = Math.max(10, Math.floor(options.maxResourceSamples));
      if (nextMax !== this.maxResourceSamples) {
        this.maxResourceSamples = nextMax;
        this.resourceSamples = new Array(this.maxResourceSamples);
        this._resourceWriteIndex = 0;
        this._resourceCount = 0;
      }
    }
  }

  stop() {
    this.enabled = false;
    this._frame = null;
    this._lastResourceSampleTime = 0;
  }

  shouldRecordResourceSample(now = performance.now()) {
    if (!this.enabled) return false;
    if (!this.resourceSampleEveryMs) return false;
    if (!this._lastResourceSampleTime) return true;
    return (now - this._lastResourceSampleTime) >= this.resourceSampleEveryMs;
  }

  maybeRecordResourceSample(data, now = performance.now()) {
    if (!this.enabled) return;
    if (!this.shouldRecordResourceSample(now)) return;
    this._lastResourceSampleTime = now;

    const sample = {
      ts: now,
      data: data ?? null
    };

    this.resourceSamples[this._resourceWriteIndex] = sample;
    this._resourceWriteIndex = (this._resourceWriteIndex + 1) % this.maxResourceSamples;
    this._resourceCount = Math.min(this._resourceCount + 1, this.maxResourceSamples);
  }

  getResourceSamples() {
    const out = [];
    if (this._resourceCount === 0) return out;

    const start = (this._resourceWriteIndex - this._resourceCount + this.maxResourceSamples) % this.maxResourceSamples;
    for (let i = 0; i < this._resourceCount; i++) {
      out.push(this.resourceSamples[(start + i) % this.maxResourceSamples]);
    }
    return out;
  }

  clear() {
    this.frames = new Array(this.maxFrames);
    this._writeIndex = 0;
    this._count = 0;
    this._frame = null;

    this.resourceSamples = new Array(this.maxResourceSamples);
    this._resourceWriteIndex = 0;
    this._resourceCount = 0;
    this._lastResourceSampleTime = 0;
  }

  beginFrame(timeInfo) {
    if (!this.enabled) return;

    this._frameStart = performance.now();
    this._frame = {
      ts: this._frameStart,
      frame: timeInfo?.frameCount ?? null,
      dt: timeInfo?.delta ?? null,
      elapsed: timeInfo?.elapsed ?? null,

      totalMs: 0,
      updatablesMs: 0,
      effectsUpdateMs: 0,
      effectsRenderMs: 0,

      updatables: Object.create(null),
      effectsUpdate: Object.create(null),
      effectsRender: Object.create(null)
    };
  }

  recordUpdatable(name, ms) {
    if (!this.enabled || !this._frame) return;
    if (!name) name = 'unknown';

    this._frame.updatablesMs += ms;
    const prev = this._frame.updatables[name] ?? 0;
    this._frame.updatables[name] = prev + ms;
  }

  recordEffectUpdate(effectId, ms) {
    if (!this.enabled || !this._frame) return;
    if (!effectId) effectId = 'unknown';

    this._frame.effectsUpdateMs += ms;
    const prev = this._frame.effectsUpdate[effectId] ?? 0;
    this._frame.effectsUpdate[effectId] = prev + ms;
  }

  recordEffectRender(effectId, ms) {
    if (!this.enabled || !this._frame) return;
    if (!effectId) effectId = 'unknown';

    this._frame.effectsRenderMs += ms;
    const prev = this._frame.effectsRender[effectId] ?? 0;
    this._frame.effectsRender[effectId] = prev + ms;
  }

  endFrame() {
    if (!this.enabled || !this._frame) return;

    const end = performance.now();
    this._frame.totalMs = end - this._frameStart;

    this.frames[this._writeIndex] = this._frame;
    this._writeIndex = (this._writeIndex + 1) % this.maxFrames;
    this._count = Math.min(this._count + 1, this.maxFrames);

    this._frame = null;
  }

  getFrameSamples() {
    const out = [];
    if (this._count === 0) return out;

    const start = (this._writeIndex - this._count + this.maxFrames) % this.maxFrames;
    for (let i = 0; i < this._count; i++) {
      out.push(this.frames[(start + i) % this.maxFrames]);
    }
    return out;
  }

  getSummary() {
    const frames = this.getFrameSamples();
    if (!frames.length) {
      return {
        frames: 0,
        avgMs: 0,
        p95Ms: 0,
        maxMs: 0,
        avgUpdatablesMs: 0,
        avgEffectsUpdateMs: 0,
        avgEffectsRenderMs: 0
      };
    }

    let sum = 0;
    let max = 0;
    let sumUp = 0;
    let sumEU = 0;
    let sumER = 0;

    const totals = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const t = frames[i]?.totalMs ?? 0;
      totals[i] = t;
      sum += t;
      max = Math.max(max, t);
      sumUp += frames[i]?.updatablesMs ?? 0;
      sumEU += frames[i]?.effectsUpdateMs ?? 0;
      sumER += frames[i]?.effectsRenderMs ?? 0;
    }

    totals.sort((a, b) => a - b);
    const p95Index = Math.min(totals.length - 1, Math.floor(totals.length * 0.95));
    const p95 = totals[p95Index] ?? 0;

    return {
      frames: frames.length,
      avgMs: sum / frames.length,
      p95Ms: p95,
      maxMs: max,
      avgUpdatablesMs: sumUp / frames.length,
      avgEffectsUpdateMs: sumEU / frames.length,
      avgEffectsRenderMs: sumER / frames.length
    };
  }

  getTopContributors(kind, n = 10) {
    const frames = this.getFrameSamples();
    const agg = new Map();

    const pick = (f) => {
      if (kind === 'updatables') return f?.updatables;
      if (kind === 'effectsUpdate') return f?.effectsUpdate;
      if (kind === 'effectsRender') return f?.effectsRender;
      return null;
    };

    for (const f of frames) {
      const bag = pick(f);
      if (!bag) continue;
      for (const k of Object.keys(bag)) {
        agg.set(k, (agg.get(k) ?? 0) + (bag[k] ?? 0));
      }
    }

    return Array.from(agg.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, n))
      .map(([id, totalMs]) => ({ id, totalMs }));
  }

  exportJson() {
    return {
      version: 1,
      maxFrames: this.maxFrames,
      resourceSampleEveryMs: this.resourceSampleEveryMs,
      samples: this.getFrameSamples(),
      resources: this.getResourceSamples(),
      summary: this.getSummary()
    };
  }

  exportCsv() {
    const frames = this.getFrameSamples();
    const header = ['ts', 'frame', 'dt', 'elapsed', 'totalMs', 'updatablesMs', 'effectsUpdateMs', 'effectsRenderMs'].join(',');
    const lines = [header];

    for (const f of frames) {
      lines.push([
        f?.ts ?? '',
        f?.frame ?? '',
        f?.dt ?? '',
        f?.elapsed ?? '',
        f?.totalMs ?? 0,
        f?.updatablesMs ?? 0,
        f?.effectsUpdateMs ?? 0,
        f?.effectsRenderMs ?? 0
      ].join(','));
    }

    return lines.join('\n');
  }
}

export const globalProfiler = new Profiler();
