export class LoadingProfiler {
  constructor() {
    this.enabled = false;
    this.startedAt = 0;
    this.marks = [];
    this._openSpans = new Map();
    this.spans = [];
  }

  start() {
    this.clear();
    this.enabled = true;
    this.startedAt = performance.now();
  }

  stop() {
    this.enabled = false;
  }

  clear() {
    this.startedAt = 0;
    this.marks.length = 0;
    this._openSpans.clear();
    this.spans.length = 0;
  }

  mark(id, meta = null) {
    if (!this.enabled) return;
    this.marks.push({ id, ts: performance.now(), meta });
  }

  begin(id, meta = null) {
    if (!this.enabled) return;
    this._openSpans.set(id, { id, ts: performance.now(), meta });
  }

  end(id, meta = null) {
    if (!this.enabled) return;
    const s = this._openSpans.get(id);
    if (!s) return;
    const end = performance.now();
    this._openSpans.delete(id);
    this.spans.push({
      id,
      start: s.ts,
      end,
      durationMs: end - s.ts,
      meta: meta == null && s.meta == null ? null : { ...(s.meta || {}), ...(meta || {}) }
    });
  }

  getReport() {
    return {
      version: 1,
      startedAt: this.startedAt,
      marks: this.marks.slice(),
      spans: this.spans.slice()
    };
  }

  getSummary() {
    const spans = this.spans;
    if (!spans.length) {
      return {
        spans: 0,
        totalMs: 0,
        maxSpanMs: 0
      };
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;
    let maxSpan = 0;
    for (const s of spans) {
      if (!s) continue;
      if (typeof s.start === 'number') minStart = Math.min(minStart, s.start);
      if (typeof s.end === 'number') maxEnd = Math.max(maxEnd, s.end);
      if (typeof s.durationMs === 'number') maxSpan = Math.max(maxSpan, s.durationMs);
    }

    const total = isFinite(minStart) && isFinite(maxEnd) ? (maxEnd - minStart) : 0;
    return {
      spans: spans.length,
      totalMs: total,
      maxSpanMs: maxSpan
    };
  }

  getTopSpans(n = 20, prefix = null) {
    const out = [];
    for (const s of this.spans) {
      if (!s) continue;
      if (prefix && typeof s.id === 'string' && !s.id.startsWith(prefix)) continue;
      out.push(s);
    }

    out.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
    return out.slice(0, Math.max(1, n));
  }

  exportJson() {
    return this.getReport();
  }

  exportCsv() {
    const header = ['id', 'start', 'end', 'durationMs', 'meta'].join(',');
    const lines = [header];

    for (const s of this.spans) {
      const meta = (() => {
        try {
          return s?.meta ? JSON.stringify(s.meta) : '';
        } catch (e) {
          return '';
        }
      })();

      lines.push([
        s?.id ?? '',
        s?.start ?? '',
        s?.end ?? '',
        s?.durationMs ?? 0,
        meta
      ].join(','));
    }

    return lines.join('\n');
  }
}

export const globalLoadingProfiler = new LoadingProfiler();
