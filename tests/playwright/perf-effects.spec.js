const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const { FoundryLauncher } = require('./foundry-launcher');
const { bestEffortLogin, waitForGameReady, ensureActiveScene, waitForCanvasReady, waitForMapShineReady, unpauseIfPaused } = require('./map-shine-utils');
const { sampleRafFrameTimes } = require('./perf-utils');

const PERF_MODE = process.env.PERF_MODE || 'idle';

const PERF_EFFECT_ID = process.env.PERF_EFFECT_ID || '';
const PERF_EFFECT_FILTER = process.env.PERF_EFFECT_FILTER || '';

const PERF_SOLO_MIN_EFFECTS = process.env.PERF_SOLO_MIN_EFFECTS || 'specular,colorCorrection,lighting';
const PERF_SOLO_SKIP_EFFECTS = process.env.PERF_SOLO_SKIP_EFFECTS || 'mask-debug,debug-layer';

const PERF_SAMPLE_MS = Number(process.env.PERF_EFFECT_SAMPLE_MS || process.env.PERF_SAMPLE_MS || 15000);
const PERF_WARMUP_MS = Number(process.env.PERF_EFFECT_WARMUP_MS || process.env.PERF_WARMUP_MS || 5000);
const PERF_TOGGLE_SETTLE_MS = Number(process.env.PERF_EFFECT_TOGGLE_SETTLE_MS || 2000);

const PERF_SOLO_SAMPLE_MS = Number(process.env.PERF_SOLO_SAMPLE_MS || PERF_SAMPLE_MS);
const PERF_SOLO_WARMUP_MS = Number(process.env.PERF_SOLO_WARMUP_MS || PERF_WARMUP_MS);

function logStep(msg) {
  try {
    console.log(`[perf] ${msg}`);
  } catch (_) {
  }
}

async function getEffectsSnapshot(page) {
  return await page.evaluate(() => {
    try {
      const ec = window.canvas?.mapShine?.effectComposer;
      const effects = ec?.effects;
      if (!effects) return { ok: false, reason: 'no-effectComposer-effects', effects: [] };

      const out = [];

      if (effects instanceof Map) {
        for (const [id, eff] of effects.entries()) {
          out.push({
            id: String(id),
            enabled: !!eff?.enabled,
            hasApply: typeof eff?.applyParamChange === 'function'
          });
        }
      } else if (Array.isArray(effects)) {
        for (const eff of effects) {
          const id = eff?.id;
          if (!id) continue;
          out.push({ id: String(id), enabled: !!eff?.enabled, hasApply: typeof eff?.applyParamChange === 'function' });
        }
      } else if (typeof effects === 'object') {
        for (const [id, eff] of Object.entries(effects)) {
          out.push({ id: String(id), enabled: !!eff?.enabled, hasApply: typeof eff?.applyParamChange === 'function' });
        }
      }

      return { ok: true, effects: out };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e), effects: [] };
    }
  });
}

async function setEffectEnabled(page, effectId, enabled) {
  return await page.evaluate(({ effectId, enabled }) => {
    try {
      const ec = window.canvas?.mapShine?.effectComposer;
      const effects = ec?.effects;
      if (!effects) return { ok: false, reason: 'no-effectComposer-effects' };

      let eff = null;
      if (effects instanceof Map) eff = effects.get(effectId) || null;
      else if (Array.isArray(effects)) eff = effects.find((x) => x?.id === effectId) || null;
      else if (typeof effects === 'object') eff = effects[effectId] || null;

      if (!eff) return { ok: false, reason: 'effect-not-found' };

      const prev = !!eff.enabled;

      if (typeof eff.applyParamChange === 'function') {
        try {
          eff.applyParamChange('enabled', !!enabled);
        } catch (_) {
          eff.enabled = !!enabled;
        }
      } else {
        eff.enabled = !!enabled;
      }

      const next = !!eff.enabled;
      return { ok: true, prev, next };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }, { effectId, enabled });
}

async function restoreSnapshot(page, snapshot) {
  await page.evaluate((snapshot) => {
    try {
      const ec = window.canvas?.mapShine?.effectComposer;
      const effects = ec?.effects;
      if (!effects) return;

      const getEffect = (id) => {
        try {
          if (effects instanceof Map) return effects.get(id) || null;
          if (Array.isArray(effects)) return effects.find((x) => x?.id === id) || null;
          if (typeof effects === 'object') return effects[id] || null;
          return null;
        } catch (_) {
          return null;
        }
      };

      for (const s of snapshot || []) {
        const id = s?.id;
        if (!id) continue;
        const eff = getEffect(id);
        if (!eff) continue;

        const enabled = !!s.enabled;
        if (typeof eff.applyParamChange === 'function') {
          try {
            eff.applyParamChange('enabled', enabled);
          } catch (_) {
            eff.enabled = enabled;
          }
        } else {
          eff.enabled = enabled;
        }
      }
    } catch (_) {
    }
  }, snapshot);
}

async function startLoadingProfilerBestEffort(page) {
  return await page.evaluate(() => {
    try {
      const p = window.MapShine?.perf?.loading;
      if (!p) return { ok: false, reason: 'no-MapShine.perf.loading' };
      if (typeof p.clear === 'function') p.clear();
      if (typeof p.start === 'function') p.start();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  });
}

async function exportLoadingProfilerBestEffort(page) {
  return await page.evaluate(() => {
    try {
      return window.MapShine?.perf?.loading?.exportJson?.() ?? null;
    } catch (_) {
      return null;
    }
  });
}

async function applyEnabledSet(page, enabledIds) {
  return await page.evaluate(({ enabledIds }) => {
    try {
      const ec = window.canvas?.mapShine?.effectComposer;
      const effects = ec?.effects;
      if (!effects) return { ok: false, reason: 'no-effectComposer-effects' };
      const set = new Set(Array.isArray(enabledIds) ? enabledIds : []);

      const apply = (eff, enabled) => {
        if (!eff) return;
        if (typeof eff.applyParamChange === 'function') {
          try {
            eff.applyParamChange('enabled', !!enabled);
            return;
          } catch (_) {
          }
        }
        try {
          eff.enabled = !!enabled;
        } catch (_) {
        }
      };

      if (effects instanceof Map) {
        for (const [id, eff] of effects.entries()) {
          apply(eff, set.has(String(id)));
        }
      } else if (Array.isArray(effects)) {
        for (const eff of effects) {
          const id = String(eff?.id || '');
          if (!id) continue;
          apply(eff, set.has(id));
        }
      } else if (typeof effects === 'object') {
        for (const [id, eff] of Object.entries(effects)) {
          apply(eff, set.has(String(id)));
        }
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }, { enabledIds });
}

function parseCsvList(s) {
  const raw = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return Array.from(new Set(raw));
}

function computeEffectInitMs(loadingJson) {
  const spans = loadingJson && Array.isArray(loadingJson.spans) ? loadingJson.spans : [];
  const out = {};
  for (const s of spans) {
    const id = s?.id;
    if (typeof id !== 'string') continue;
    if (!id.startsWith('effect:')) continue;
    if (!id.endsWith(':initialize')) continue;
    const effectId = id.slice('effect:'.length, id.length - ':initialize'.length);
    if (!effectId) continue;
    const ms = Number(s?.durationMs || 0);
    if (!Number.isFinite(ms) || ms < 0) continue;
    out[effectId] = (out[effectId] || 0) + ms;
  }
  return out;
}

function computeDelta(baseline, variant) {
  const safe = (v) => (Number.isFinite(v) ? v : null);
  const b = baseline || {};
  const v = variant || {};

  const bFrame = b.frameMs || {};
  const vFrame = v.frameMs || {};

  const delta = {
    fpsAvg: safe((v.fpsAvg || 0) - (b.fpsAvg || 0)),
    p50: safe((vFrame.p50 || 0) - (bFrame.p50 || 0)),
    p95: safe((vFrame.p95 || 0) - (bFrame.p95 || 0)),
    p99: safe((vFrame.p99 || 0) - (bFrame.p99 || 0)),
    max: safe((vFrame.max || 0) - (bFrame.max || 0)),
    hitches33: safe((v.hitches?.['>33ms'] || 0) - (b.hitches?.['>33ms'] || 0)),
    hitches50: safe((v.hitches?.['>50ms'] || 0) - (b.hitches?.['>50ms'] || 0)),
    hitches100: safe((v.hitches?.['>100ms'] || 0) - (b.hitches?.['>100ms'] || 0))
  };

  return delta;
}

test.describe('MapShine Perf Effects', () => {
  let foundry = null;

  test.beforeAll(async () => {
    const isEffectsMode = (PERF_MODE === 'effects' || PERF_MODE === 'effect' || PERF_MODE === 'solo' || PERF_MODE === 'soloeffect' || PERF_MODE === 'full');
    if (!isEffectsMode) return;

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

  test('effects disable-one matrix', async ({ page, browserName }, testInfo) => {
    test.skip(!(PERF_MODE === 'effects' || PERF_MODE === 'effect' || PERF_MODE === 'solo' || PERF_MODE === 'soloeffect' || PERF_MODE === 'full'));

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

    // Best-effort: start load profiler early so effect initialization spans are captured.
    await startLoadingProfilerBestEffort(page);

    logStep('login');
    await bestEffortLogin(page);
    const tAfterAuth = Date.now();

    logStep('waitForGameReady');
    await waitForGameReady(page);

    // Try again after Foundry/game is ready.
    await startLoadingProfilerBestEffort(page);

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

    const loadingProfile = await exportLoadingProfilerBestEffort(page);
    const effectInitMs = computeEffectInitMs(loadingProfile);

    const snap = await getEffectsSnapshot(page);
    if (!snap?.ok) throw new Error(`Failed to enumerate effects: ${snap?.reason || ''}`);

    let effects = snap.effects || [];

    if (PERF_EFFECT_FILTER) {
      let re = null;
      try { re = new RegExp(PERF_EFFECT_FILTER, 'i'); } catch (_) { re = null; }
      if (re) effects = effects.filter((e) => re.test(e.id));
    }

    if (PERF_MODE === 'effect' || PERF_MODE === 'soloeffect') {
      if (!PERF_EFFECT_ID) throw new Error('PERF_MODE=effect requires PERF_EFFECT_ID');
      effects = effects.filter((e) => e.id === PERF_EFFECT_ID);
      if (!effects.length) throw new Error(`Effect not found: ${PERF_EFFECT_ID}`);
    }

    const baselineSnapshot = snap.effects;

    let baseline = null;
    let results = [];
    let solo = null;

    const doDisableOne = (PERF_MODE === 'effects' || PERF_MODE === 'effect' || PERF_MODE === 'full');
    const doSolo = (PERF_MODE === 'solo' || PERF_MODE === 'soloeffect' || PERF_MODE === 'full');

    if (doDisableOne) {
      logStep(`warmup ${PERF_WARMUP_MS}ms`);
      await page.waitForTimeout(PERF_WARMUP_MS);

      logStep(`sample baseline ${PERF_SAMPLE_MS}ms`);
      baseline = await sampleRafFrameTimes(page, PERF_SAMPLE_MS);

      results = [];

      for (const e of effects) {
        const effectId = e.id;
        const baselineEnabled = !!e.enabled;

        logStep(`effect ${effectId}: restore baseline`);
        await restoreSnapshot(page, baselineSnapshot);
        await page.waitForTimeout(PERF_TOGGLE_SETTLE_MS);

        if (!baselineEnabled) {
          results.push({
            effectId,
            baselineEnabled,
            skipped: true,
            reason: 'effect-disabled-in-baseline'
          });
          continue;
        }

        logStep(`effect ${effectId}: disable`);
        const toggle = await setEffectEnabled(page, effectId, false);
        if (!toggle?.ok) {
          results.push({
            effectId,
            baselineEnabled,
            skipped: true,
            reason: `toggle-failed:${toggle?.reason || ''}`
          });
          continue;
        }

        await page.waitForTimeout(PERF_TOGGLE_SETTLE_MS);

        logStep(`effect ${effectId}: sample disabled ${PERF_SAMPLE_MS}ms`);
        const disabled = await sampleRafFrameTimes(page, PERF_SAMPLE_MS);

        results.push({
          effectId,
          baselineEnabled,
          disabled,
          deltaDisabledVsBaseline: computeDelta(baseline, disabled)
        });
      }
    }

    if (doSolo) {
      const minIds = parseCsvList(PERF_SOLO_MIN_EFFECTS);
      const skipIds = new Set(parseCsvList(PERF_SOLO_SKIP_EFFECTS));

      // Hard-coded dependency hints (extend as needed)
      const deps = {
        'fire-sparks': ['particles'],
        'smellyFlies': ['particles'],
        'dust': ['particles'],
        'candle-flames': ['lighting']
      };

      const soloTargets = effects
        .map((e) => String(e.id))
        .filter((id) => id && !skipIds.has(id) && !minIds.includes(id));

      logStep(`solo: apply minimal set (${minIds.join(',')})`);
      const applied = await applyEnabledSet(page, minIds);
      if (!applied?.ok) throw new Error(`Failed to apply solo minimal set: ${applied?.reason || ''}`);
      await page.waitForTimeout(PERF_TOGGLE_SETTLE_MS);

      logStep(`solo: warmup minimal ${PERF_SOLO_WARMUP_MS}ms`);
      await page.waitForTimeout(PERF_SOLO_WARMUP_MS);

      logStep(`solo: sample minimal ${PERF_SOLO_SAMPLE_MS}ms`);
      const minimalBaseline = await sampleRafFrameTimes(page, PERF_SOLO_SAMPLE_MS);

      const soloResults = [];

      for (const effectId of soloTargets) {
        // Return to minimal baseline before each variant.
        await applyEnabledSet(page, minIds);
        await page.waitForTimeout(PERF_TOGGLE_SETTLE_MS);

        const extra = deps[effectId] || [];
        const variantIds = Array.from(new Set([...minIds, ...extra, effectId]));

        logStep(`solo: effect ${effectId}: enable (deps=${extra.join(',') || 'none'})`);
        const ok = await applyEnabledSet(page, variantIds);
        if (!ok?.ok) {
          soloResults.push({ effectId, skipped: true, reason: `apply-failed:${ok?.reason || ''}` });
          continue;
        }

        await page.waitForTimeout(PERF_TOGGLE_SETTLE_MS);
        await page.waitForTimeout(PERF_SOLO_WARMUP_MS);

        logStep(`solo: effect ${effectId}: sample ${PERF_SOLO_SAMPLE_MS}ms`);
        const variant = await sampleRafFrameTimes(page, PERF_SOLO_SAMPLE_MS);

        soloResults.push({
          effectId,
          variantEnabledIds: variantIds,
          variant,
          deltaVariantVsMinimal: computeDelta(minimalBaseline, variant)
        });
      }

      solo = {
        minimalEnabledIds: minIds,
        baseline: minimalBaseline,
        effects: soloResults
      };
    }

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
        effectId: PERF_EFFECT_ID || null,
        effectFilter: PERF_EFFECT_FILTER || null,
        warmupMs: PERF_WARMUP_MS,
        sampleMs: PERF_SAMPLE_MS,
        soloWarmupMs: PERF_SOLO_WARMUP_MS,
        soloSampleMs: PERF_SOLO_SAMPLE_MS,
        toggleSettleMs: PERF_TOGGLE_SETTLE_MS
      },
      load,
      loading: {
        profile: loadingProfile,
        effectInitMs
      },
      baseline,
      effects: results,
      solo
    };

    const outPath = path.join(outDir, `perf-effects-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    logStep(`wrote ${outPath}`);
  });
});
