function computeFrameStats(deltasMs) {
  const arr = deltasMs.slice().filter((n) => Number.isFinite(n) && n > 0);
  arr.sort((a, b) => a - b);

  const sum = arr.reduce((a, b) => a + b, 0);
  const avg = arr.length ? sum / arr.length : 0;
  const min = arr.length ? arr[0] : 0;
  const max = arr.length ? arr[arr.length - 1] : 0;

  const p = (q) => {
    if (!arr.length) return 0;
    const idx = Math.min(arr.length - 1, Math.floor(arr.length * q));
    return arr[idx] || 0;
  };

  const hitches = {
    '>33ms': arr.filter((n) => n > 33).length,
    '>50ms': arr.filter((n) => n > 50).length,
    '>100ms': arr.filter((n) => n > 100).length
  };

  const fpsAvg = avg > 0 ? 1000 / avg : 0;

  return {
    frames: arr.length,
    totalMs: sum,
    fpsAvg,
    frameMs: {
      avg,
      min,
      p50: p(0.50),
      p95: p(0.95),
      p99: p(0.99),
      max
    },
    hitches
  };
}

async function sampleRafFrameTimes(page, durationMs) {
  const deltas = await page.evaluate((ms) => {
    return new Promise((resolve) => {
      const out = [];
      let last = performance.now();
      const start = last;

      function tick(now) {
        const dt = now - last;
        last = now;
        if (now !== start) out.push(dt);

        if (now - start >= ms) {
          resolve(out);
          return;
        }
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
    });
  }, durationMs);

  return computeFrameStats(deltas);
}

module.exports = {
  sampleRafFrameTimes,
  computeFrameStats
};
