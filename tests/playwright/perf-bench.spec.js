const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { FoundryLauncher } = require('./foundry-launcher');
const { bestEffortLogin, waitForGameReady, ensureActiveScene, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } = require('./map-shine-utils');
const { sampleRafFrameTimes, computeFrameStats } = require('./perf-utils');

const PERF_MODE = process.env.PERF_MODE || 'idle';
const PERF_SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS || 15000);
const PERF_WARMUP_MS = Number(process.env.PERF_WARMUP_MS || 5000);

const PERF_COMPLEX_SAMPLE_MS = Number(process.env.PERF_COMPLEX_SAMPLE_MS || 120000);
const PERF_COMPLEX_SNAPSHOT_EVERY_MS = Number(process.env.PERF_COMPLEX_SNAPSHOT_EVERY_MS || 5000);

async function sampleRafWithSnapshots(page, durationMs, snapshotEveryMs) {
  const result = await page.evaluate(({ durationMs, snapshotEveryMs }) => {
    return new Promise((resolve) => {
      const deltas = [];
      const snapshots = [];

      const safeSnapshot = () => {
        try {
          const mem = performance && performance.memory ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
          } : null;

          const r = window.canvas?.mapShine?.renderer;
          const info = r && r.info ? {
            programs: r.info.programs ? r.info.programs.length : null,
            geometries: r.info.memory?.geometries ?? null,
            textures: r.info.memory?.textures ?? null,
            calls: r.info.render?.calls ?? null,
            triangles: r.info.render?.triangles ?? null,
            points: r.info.render?.points ?? null,
            lines: r.info.render?.lines ?? null
          } : null;

          snapshots.push({
            t: performance.now(),
            paused: window.game?.paused === true,
            mem,
            rendererInfo: info
          });
        } catch (_) {
        }
      };

      let last = performance.now();
      const start = last;

      safeSnapshot();
      const interval = (Number.isFinite(snapshotEveryMs) && snapshotEveryMs > 0)
        ? setInterval(safeSnapshot, snapshotEveryMs)
        : null;

      function tick(now) {
        const dt = now - last;
        last = now;
        if (now !== start) deltas.push(dt);

        if (now - start >= durationMs) {
          if (interval) clearInterval(interval);
          safeSnapshot();
          resolve({ deltas, snapshots, totalMs: now - start });
          return;
        }
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
    });
  }, { durationMs, snapshotEveryMs });

  return {
    ...computeFrameStats(result?.deltas || []),
    snapshots: result?.snapshots || []
  };
}

function logStep(msg) {
  try {
    console.log(`[perf] ${msg}`);
  } catch (_) {
  }
}

test.describe('MapShine Perf Bench', () => {
  let foundry = null;

  test.beforeAll(async () => {
    const isBenchMode = (PERF_MODE === 'idle' || PERF_MODE === 'panzoom' || PERF_MODE === 'complex' || PERF_MODE === 'smoke' || PERF_MODE === 'full');
    if (!isBenchMode) return;

    const attachUrl = process.env.FOUNDRY_BASE_URL || '';
    if (!attachUrl) {
      foundry = new FoundryLauncher();
      await foundry.start();
    }
  });

  test.afterAll(async () => {
    if (foundry) await foundry.stop();
    foundry = null;
  });

  test('idle baseline', async ({ page, browserName }, testInfo) => {
    test.skip(!(PERF_MODE === 'idle' || PERF_MODE === 'full' || PERF_MODE === 'smoke'));

    const isHeadless = !!testInfo?.project?.use?.headless;

    page.on('console', (msg) => {
      try {
        console.log(`[browser:${msg.type()}] ${msg.text()}`);
      } catch (_) {
      }
    });

    const baseUrl = foundry ? foundry.getBaseUrl() : (process.env.FOUNDRY_BASE_URL || 'http://localhost:30000');

    const outDir = path.resolve(process.cwd(), 'tests', 'playwright-artifacts');
    fs.mkdirSync(outDir, { recursive: true });

    logStep(`goto ${baseUrl}`);

    const tGotoStart = Date.now();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const tAfterGoto = Date.now();

    try {
      await page.screenshot({ path: path.join(outDir, `step-${Date.now()}-01-goto.png`), fullPage: true });
    } catch (_) {
    }

    logStep('login');
    await bestEffortLogin(page);
    const tAfterAuth = Date.now();

    try {
      await page.screenshot({ path: path.join(outDir, `step-${Date.now()}-02-after-login.png`), fullPage: true });
    } catch (_) {
    }

    logStep('waitForGameReady');
    await waitForGameReady(page);

    logStep('ensureActiveScene');
    await ensureActiveScene(page);

    try {
      await page.screenshot({ path: path.join(outDir, `step-${Date.now()}-03-game-ready.png`), fullPage: true });
    } catch (_) {
    }

    logStep('waitForCanvasReady');
    await waitForCanvasReady(page);
    const tCanvasReady = Date.now();

    logStep('unpause');
    const pausedBefore = await page.evaluate(() => {
      try { return window.game?.paused === true; } catch (_) { return null; }
    });
    await unpauseIfPaused(page);
    const pausedAfter = await page.evaluate(() => {
      try { return window.game?.paused === true; } catch (_) { return null; }
    });
    logStep(`pause state before=${pausedBefore} after=${pausedAfter}`);

    try {
      await page.screenshot({ path: path.join(outDir, `step-${Date.now()}-04-after-unpause.png`), fullPage: true });
    } catch (_) {
    }

    logStep('waitForMapShineReady');
    await waitForMapShineReady(page);
    const tMapShineReady = Date.now();

    try {
      await page.screenshot({ path: path.join(outDir, `step-${Date.now()}-05-mapshine-ready.png`), fullPage: true });
    } catch (_) {
    }

    await page.evaluate(() => {
      try {
        window.MapShine?.perf?.start?.({ maxFrames: 600, resourceSampleEveryMs: 1000 });
      } catch (_) {
      }
    });

    logStep(`warmup ${Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : 5000}ms`);
    await page.waitForTimeout(Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : 5000);

    const sampleMs = Number.isFinite(PERF_SAMPLE_MS) ? PERF_SAMPLE_MS : 15000;

    logStep(`sample idle ${sampleMs}ms`);
    const idle = await sampleRafFrameTimes(page, sampleMs);

    logStep('export MapShine perf');
    const msPerf = await page.evaluate(() => {
      try {
        return window.MapShine?.perf?.exportAllJson?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineFps = await page.evaluate(() => {
      try {
        return window.canvas?.mapShine?.renderLoop?.getFPS?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineSnapshot = await page.evaluate(() => {
      try {
        const ms = window.MapShine;
        const cm = window.canvas?.mapShine;
        const ec = cm?.effectComposer;
        return {
          initialized: !!ms?.initialized,
          hasCanvasMapShine: !!cm,
          hasRenderLoop: !!cm?.renderLoop,
          hasPerf: !!ms?.perf,
          hasExportAllJson: !!ms?.perf?.exportAllJson,
          effectCount: Array.isArray(ec?.effects) ? ec.effects.length : null,
          updatableCount: (typeof ec?.updatables?.size === 'number') ? ec.updatables.size : null
        };
      } catch (_) {
        return null;
      }
    });

    const load = {
      serverMs: foundry ? (foundry.serverReadyTs - foundry.serverStartTs) : null,
      gotoMs: tAfterGoto - tGotoStart,
      authMs: tAfterAuth - tAfterGoto,
      canvasReadyMs: tCanvasReady - tGotoStart,
      mapShineReadyMs: tMapShineReady - tGotoStart
    };

    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        browser: browserName,
        headless: isHeadless,
        viewport: {
          width: page.viewportSize()?.width ?? null,
          height: page.viewportSize()?.height ?? null
        },
        baseUrl,
        mode: PERF_MODE,
        warmupMs: Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : null,
        sampleMs
      },
      load,
      benchmarks: {
        idle: {
          durationMs: sampleMs,
          ...idle
        }
      },
      mapShine: {
        fps: mapShineFps,
        export: msPerf,
        snapshot: mapShineSnapshot
      }
    };

    const outPath = path.join(outDir, `perf-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    logStep(`wrote ${outPath}`);
  });

  test('complex idle soak', async ({ page, browserName }, testInfo) => {
    test.skip(!(PERF_MODE === 'complex' || PERF_MODE === 'full'));

    const isHeadless = !!testInfo?.project?.use?.headless;

    page.on('console', (msg) => {
      try {
        console.log(`[browser:${msg.type()}] ${msg.text()}`);
      } catch (_) {
      }
    });

    const baseUrl = foundry ? foundry.getBaseUrl() : (process.env.FOUNDRY_BASE_URL || 'http://localhost:30000');

    const outDir = path.resolve(process.cwd(), 'tests', 'playwright-artifacts');
    fs.mkdirSync(outDir, { recursive: true });

    logStep(`goto ${baseUrl}`);
    const tGotoStart = Date.now();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const tAfterGoto = Date.now();

    logStep('login');
    await bestEffortLogin(page);
    const tAfterAuth = Date.now();

    logStep('waitForGameReady');
    await waitForGameReady(page);

    logStep('ensureActiveScene');
    await ensureActiveScene(page);

    logStep('waitForCanvasReady');
    await waitForCanvasReady(page);
    const tCanvasReady = Date.now();

    logStep('unpause');
    await unpauseIfPaused(page);

    logStep('waitForMapShineReady');
    await waitForMapShineReady(page);
    const tMapShineReady = Date.now();

    await page.evaluate(() => {
      try {
        window.MapShine?.perf?.start?.({ maxFrames: 999999, resourceSampleEveryMs: 1000 });
      } catch (_) {
      }
    });

    const warmupMs = Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : 5000;
    logStep(`warmup ${warmupMs}ms`);
    await page.waitForTimeout(warmupMs);

    const sampleMs = Number.isFinite(PERF_COMPLEX_SAMPLE_MS) ? PERF_COMPLEX_SAMPLE_MS : 120000;
    const snapEveryMs = Number.isFinite(PERF_COMPLEX_SNAPSHOT_EVERY_MS) ? PERF_COMPLEX_SNAPSHOT_EVERY_MS : 5000;

    logStep(`sample complex idle ${sampleMs}ms snapshotsEvery=${snapEveryMs}ms`);
    const complex = await sampleRafWithSnapshots(page, sampleMs, snapEveryMs);

    logStep('export MapShine perf');
    const msPerf = await page.evaluate(() => {
      try {
        return window.MapShine?.perf?.exportAllJson?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineFps = await page.evaluate(() => {
      try {
        return window.canvas?.mapShine?.renderLoop?.getFPS?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineSnapshot = await page.evaluate(() => {
      try {
        const ms = window.MapShine;
        const cm = window.canvas?.mapShine;
        const ec = cm?.effectComposer;
        return {
          initialized: !!ms?.initialized,
          hasCanvasMapShine: !!cm,
          hasRenderLoop: !!cm?.renderLoop,
          hasPerf: !!ms?.perf,
          hasExportAllJson: !!ms?.perf?.exportAllJson,
          effectCount: Array.isArray(ec?.effects) ? ec.effects.length : null,
          updatableCount: (typeof ec?.updatables?.size === 'number') ? ec.updatables.size : null
        };
      } catch (_) {
        return null;
      }
    });

    const load = {
      serverMs: foundry ? (foundry.serverReadyTs - foundry.serverStartTs) : null,
      gotoMs: tAfterGoto - tGotoStart,
      authMs: tAfterAuth - tAfterGoto,
      canvasReadyMs: tCanvasReady - tGotoStart,
      mapShineReadyMs: tMapShineReady - tGotoStart
    };

    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        browser: browserName,
        headless: isHeadless,
        viewport: {
          width: page.viewportSize()?.width ?? null,
          height: page.viewportSize()?.height ?? null
        },
        baseUrl,
        mode: PERF_MODE,
        warmupMs,
        sampleMs,
        snapshotEveryMs: snapEveryMs
      },
      load,
      benchmarks: {
        complexIdle: {
          durationMs: sampleMs,
          ...complex
        }
      },
      mapShine: {
        fps: mapShineFps,
        export: msPerf,
        snapshot: mapShineSnapshot
      }
    };

    const outPath = path.join(outDir, `perf-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    logStep(`wrote ${outPath}`);
  });

  test('panzoom', async ({ page, browserName }, testInfo) => {
    test.skip(!(PERF_MODE === 'panzoom' || PERF_MODE === 'full' || PERF_MODE === 'smoke'));

    const isHeadless = !!testInfo?.project?.use?.headless;

    const baseUrl = foundry ? foundry.getBaseUrl() : (process.env.FOUNDRY_BASE_URL || 'http://localhost:30000');

    logStep(`goto ${baseUrl}`);

    const tGotoStart = Date.now();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const tAfterGoto = Date.now();

    logStep('login');
    await bestEffortLogin(page);
    const tAfterAuth = Date.now();

    logStep('waitForGameReady');
    await waitForGameReady(page);

    logStep('ensureActiveScene');
    await ensureActiveScene(page);

    logStep('waitForCanvasReady');
    await waitForCanvasReady(page);
    const tCanvasReady = Date.now();

    logStep('unpause');
    await unpauseIfPaused(page);

    logStep('waitForMapShineReady');
    await waitForMapShineReady(page);
    const tMapShineReady = Date.now();

    await page.evaluate(() => {
      try {
        window.MapShine?.perf?.start?.({ maxFrames: 600, resourceSampleEveryMs: 1000 });
      } catch (_) {
      }
    });

    logStep(`warmup ${Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : 5000}ms`);
    await page.waitForTimeout(Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : 5000);

    const sampleMs = Number.isFinite(PERF_SAMPLE_MS) ? PERF_SAMPLE_MS : 15000;

    logStep(`sample panzoom ${sampleMs}ms`);
    const [panzoom] = await Promise.all([
      sampleRafFrameTimes(page, sampleMs),
      page.evaluate(async (durationMs) => {
        const canvas = window.canvas;
        if (!canvas || typeof canvas.animatePan !== 'function') return false;

        const start = performance.now();

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        let dir = 1;
        let zoomDir = 1;
        while ((performance.now() - start) < durationMs) {
          const pivot = canvas.stage?.pivot;
          const scale = canvas.stage?.scale?.x ?? 1;
          const x = (pivot?.x ?? 0) + dir * 400;
          const y = (pivot?.y ?? 0) + dir * 250;
          const nextScale = clamp(scale * (zoomDir > 0 ? 1.15 : (1 / 1.15)), 0.25, 4.0);

          dir = -dir;
          zoomDir = -zoomDir;

          try {
            await canvas.animatePan({ x, y, scale: nextScale, duration: 250 });
          } catch (_) {
          }
        }

        return true;
      }, sampleMs)
    ]);

    logStep('export MapShine perf');
    const msPerf = await page.evaluate(() => {
      try {
        return window.MapShine?.perf?.exportAllJson?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineFps = await page.evaluate(() => {
      try {
        return window.canvas?.mapShine?.renderLoop?.getFPS?.() ?? null;
      } catch (_) {
        return null;
      }
    });

    const mapShineSnapshot = await page.evaluate(() => {
      try {
        const ms = window.MapShine;
        const cm = window.canvas?.mapShine;
        const ec = cm?.effectComposer;
        return {
          initialized: !!ms?.initialized,
          hasCanvasMapShine: !!cm,
          hasRenderLoop: !!cm?.renderLoop,
          hasPerf: !!ms?.perf,
          hasExportAllJson: !!ms?.perf?.exportAllJson,
          effectCount: Array.isArray(ec?.effects) ? ec.effects.length : null,
          updatableCount: (typeof ec?.updatables?.size === 'number') ? ec.updatables.size : null
        };
      } catch (_) {
        return null;
      }
    });

    const load = {
      serverMs: foundry ? (foundry.serverReadyTs - foundry.serverStartTs) : null,
      gotoMs: tAfterGoto - tGotoStart,
      authMs: tAfterAuth - tAfterGoto,
      canvasReadyMs: tCanvasReady - tGotoStart,
      mapShineReadyMs: tMapShineReady - tGotoStart
    };

    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        browser: browserName,
        headless: isHeadless,
        viewport: {
          width: page.viewportSize()?.width ?? null,
          height: page.viewportSize()?.height ?? null
        },
        baseUrl,
        mode: PERF_MODE,
        warmupMs: Number.isFinite(PERF_WARMUP_MS) ? PERF_WARMUP_MS : null,
        sampleMs
      },
      load,
      benchmarks: {
        panzoom: {
          durationMs: sampleMs,
          ...panzoom
        }
      },
      mapShine: {
        fps: mapShineFps,
        export: msPerf,
        snapshot: mapShineSnapshot
      }
    };

    const outDir = path.resolve(process.cwd(), 'tests', 'playwright-artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `perf-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    logStep(`wrote ${outPath}`);
  });
});
