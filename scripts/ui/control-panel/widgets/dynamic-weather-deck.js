/**
 * @fileoverview Compact Dynamic Weather deck — range bounds faders + overlay preset picker.
 * Dynamic steps use Environment Fade (min 1 min); no separate evolve speed controls.
 * @module ui/control-panel/widgets/dynamic-weather-deck
 */

import {
  buildEnvironmentPresetSections,
  findEnvironmentPreset,
  lookupBiome,
} from './dynamic-weather-catalog.js';
import { createSplitBoundsFaderBoard, BOUND_FADER_GROUPS } from './split-bounds-fader-board.js';
import { GUSTINESS_LABELS } from './astrolabe-dial.js';
import { applyAshMasterIntensity } from '../../ash-weather-bridge.js';
import {
  applyLightningIntensityToEffect,
  writeLightningIntensityToControlState,
} from '../../landscape-lightning-bridge.js';
import { computePrecipType } from '../../weather-param-bridge.js';

const PRESET_OVERLAY_WIDTH_PX = 720;

/** @type {Record<string, number>} */
const GUSTINESS_TO_VARIABILITY = Object.freeze({
  calm: 0.25,
  light: 0.45,
  moderate: 0.7,
  strong: 0.85,
  extreme: 0.95,
});

/**
 * @param {HTMLElement} mountEl
 * @param {{
 *   controlState: Record<string, unknown>,
 *   getWeatherController: () => import('../../../core/WeatherController.js').WeatherController|null,
 *   isGm: () => boolean,
 *   onApply: () => void | Promise<void>,
 *   onSave: () => void,
 *   onSaveDynamic?: () => void | Promise<void>,
 *   setContextHint: (lines: string[]) => void,
 *   clearContextHint: () => void,
 * }} hooks
 */
export function createDynamicWeatherDeck(mountEl, hooks) {
  const root = document.createElement('div');
  root.className = 'msa-cp-dynamic-deck';
  root.dataset.msWeatherPanelView = 'dynamic';

  const presetSections = buildEnvironmentPresetSections();

  function resolveActivePresetId() {
    const stored = hooks.controlState.dynamicEnvironmentPresetId;
    if (typeof stored === 'string' && stored && findEnvironmentPreset(stored, presetSections)) {
      return stored;
    }
    const biomeId = String(hooks.controlState.dynamicPresetId || 'Temperate Plains');
    const biomeKey = `biome:${biomeId}`;
    if (findEnvironmentPreset(biomeKey, presetSections)) return biomeKey;
    return biomeKey;
  }

  let activePresetId = resolveActivePresetId();

  async function commitDynamicPersistence() {
    hooks.onSave();
    try {
      await hooks.onSaveDynamic?.();
    } catch (_) {}
  }

  const presetBtn = document.createElement('button');
  presetBtn.type = 'button';
  presetBtn.className = 'msa-cp-dynamic-deck__preset-btn';
  presetBtn.setAttribute('aria-haspopup', 'listbox');
  presetBtn.setAttribute('aria-expanded', 'false');

  root.appendChild(presetBtn);

  const presetOverlay = document.createElement('div');
  presetOverlay.className = 'msa-cp-dynamic-preset-overlay';
  presetOverlay.hidden = true;

  const presetBackdrop = document.createElement('div');
  presetBackdrop.className = 'msa-cp-dynamic-preset-overlay__backdrop';

  const presetPanel = document.createElement('div');
  presetPanel.className = 'msa-cp-dynamic-preset-overlay__panel';
  presetPanel.setAttribute('role', 'listbox');

  for (const section of presetSections) {
    const secWrap = document.createElement('div');
    secWrap.className = 'msa-cp-dynamic-preset-overlay__section';

    const secTitle = document.createElement('div');
    secTitle.className = 'msa-cp-dynamic-preset-overlay__section-title';
    secTitle.textContent = section.title;
    secWrap.appendChild(secTitle);

    const optionList = document.createElement('div');
    optionList.className = 'msa-cp-dynamic-preset-overlay__option-list';

    for (const item of section.items) {
      const opt = document.createElement('div');
      opt.className = 'msa-cp-dynamic-preset-overlay__option';
      opt.dataset.presetId = item.id;
      opt.setAttribute('role', 'option');
      opt.tabIndex = 0;

      const optTitle = document.createElement('div');
      optTitle.className = 'msa-cp-dynamic-preset-overlay__option-title';
      optTitle.textContent = `${item.icon} ${item.label}`;

      const optBody = document.createElement('div');
      optBody.className = 'msa-cp-dynamic-preset-overlay__option-body';
      optBody.textContent = item.blurb;

      const optMeta = document.createElement('div');
      optMeta.className = 'msa-cp-dynamic-preset-overlay__option-meta';
      optMeta.textContent = `${lookupBiome(item.biome)?.label || item.biome} · bounds for evolution · Environment Fade sets step length`;

      opt.appendChild(optTitle);
      opt.appendChild(optBody);
      opt.appendChild(optMeta);

      const selectOption = () => {
        applyPreset(item);
        closePresetPanel();
      };

      opt.addEventListener('click', () => selectOption());
      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectOption();
        }
      });

      opt.addEventListener('pointerenter', () => {
        hooks.setContextHint([
          `${item.icon} ${item.label}`,
          item.blurb,
          optMeta.textContent,
        ]);
      });
      opt.addEventListener('pointerleave', () => hooks.clearContextHint());

      optionList.appendChild(opt);
    }

    secWrap.appendChild(optionList);
    presetPanel.appendChild(secWrap);
  }

  presetOverlay.appendChild(presetBackdrop);
  presetOverlay.appendChild(presetPanel);
  document.body.appendChild(presetOverlay);

  const faderMount = document.createElement('div');
  faderMount.className = 'msa-cp-dynamic-deck__bounds-faders';
  root.appendChild(faderMount);

  const readBound = (key) => {
    const wc = hooks.getWeatherController();
    const n = Number(wc?._dynamicBounds?.[key]);
    if (Number.isFinite(n)) return n;
    if (key.endsWith('Max')) {
      if (key.startsWith('gustiness')) return GUSTINESS_LABELS.length - 1;
      return 1;
    }
    return 0;
  };

  const writeBound = (key, value) => {
    const wc = hooks.getWeatherController();
    wc?.setDynamicBound?.(key, value);
    wc?.setDynamicBoundsEnabled?.(true);
  };

  /**
   * @param {string} metaId
   * @param {number} rawValue
   * @param {{ save?: boolean }} [opts]
   */
  function commitDynamicLiveScalar(metaId, rawValue, opts = {}) {
    if (!hooks.isGm()) return;
    const wc = hooks.getWeatherController();
    if (!wc) return;

    const group = BOUND_FADER_GROUPS.find((g) => g.metaId === metaId);
    if (!group) return;

    const lo = Math.min(readBound(group.minKey), readBound(group.maxKey));
    const hi = Math.max(readBound(group.minKey), readBound(group.maxKey));
    let value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    value = Math.max(lo, Math.min(hi, value));
    if (group.step >= 1) value = Math.round(value);

    const applyScalar = (field, v) => {
      const applyTo = (state) => {
        if (!state) return;
        state[field] = v;
      };
      applyTo(wc.targetState);
      applyTo(wc.currentState);
      if (field === 'precipitation' || field === 'freezeLevel') {
        const pt = computePrecipType(wc.targetState?.precipitation, wc.targetState?.freezeLevel);
        if (wc.targetState) wc.targetState.precipType = pt;
        if (wc.currentState) wc.currentState.precipType = pt;
      }
    };

    if (metaId === 'lightning') {
      writeLightningIntensityToControlState(hooks.controlState, value);
      applyLightningIntensityToEffect(value);
    } else if (metaId === 'ashIntensity') {
      applyAshMasterIntensity(value, { syncMainTweakpane: false });
      applyScalar('ashIntensity', value);
    } else if (metaId === 'gustiness') {
      const key = GUSTINESS_LABELS[Math.round(value)] || 'moderate';
      hooks.controlState.gustiness = key;
      const variability = GUSTINESS_TO_VARIABILITY[key] ?? GUSTINESS_TO_VARIABILITY.moderate;
      if (typeof wc.setVariability === 'function') wc.setVariability(variability);
      else wc.variability = variability;
    } else {
      applyScalar(metaId, value);
    }

    wc.isTransitioning = false;
    wc.transitionElapsed = 0;

    if (opts.save) {
      hooks.onSave();
    }
  }

  const boundsBoard = createSplitBoundsFaderBoard(faderMount, {
    readBound,
    writeBound,
    disabled: !hooks.isGm(),
    setContextHint: hooks.setContextHint,
    clearContextHint: hooks.clearContextHint,
    onLiveValueInput: (metaId, value) => commitDynamicLiveScalar(metaId, value, { save: false }),
    onLiveValueCommit: (metaId, value) => commitDynamicLiveScalar(metaId, value, { save: true }),
    onBoundsChange: () => {
      hooks.controlState.dynamicEnvironmentPresetId = null;
      void commitDynamicPersistence();
      highlightActivePresetOption(null);
    },
  });

  mountEl.appendChild(root);

  function updatePresetButtonLabel() {
    const preset = findEnvironmentPreset(activePresetId, presetSections);
    const biomeId = String(hooks.controlState.dynamicPresetId || 'Temperate Plains');
    const biome = lookupBiome(biomeId);
    const label = preset?.label || biome?.label || biomeId;
    const icon = preset?.icon || biome?.icon || '🌦';
    presetBtn.textContent = `${icon} ${label}`;
    highlightActivePresetOption(activePresetId);
  }

  function highlightActivePresetOption(presetId) {
    for (const opt of presetPanel.querySelectorAll('.msa-cp-dynamic-preset-overlay__option')) {
      opt.classList.toggle('is-active', presetId != null && opt.dataset.presetId === presetId);
    }
  }

  /**
   * Write preset bounds to WC and refresh fader visuals.
   * @param {Record<string, number>} bounds
   */
  function applyBoundsToRuntime(bounds) {
    if (!bounds || typeof bounds !== 'object') return;
    const wc = hooks.getWeatherController();
    wc?.setDynamicBoundsEnabled?.(true);
    for (const [key, val] of Object.entries(bounds)) {
      if (Number.isFinite(Number(val))) wc?.setDynamicBound?.(key, Number(val));
    }
    boundsBoard.applyBounds(bounds);
    snapWeatherScalarsToBounds(bounds);
  }

  /**
   * Clamp live weather into new bounds so presets do not inherit stale channel values
   * (e.g. default lightning 1.0 on a calm mood).
   * @param {Record<string, number>} bounds
   */
  function snapWeatherScalarsToBounds(bounds) {
    if (!hooks.isGm()) return;
    const wc = hooks.getWeatherController();
    if (!wc || !bounds) return;

    const clampToBounds = (minKey, maxKey, value) => {
      const lo = Math.min(Number(bounds[minKey] ?? 0), Number(bounds[maxKey] ?? 0));
      const hi = Math.max(Number(bounds[minKey] ?? 0), Number(bounds[maxKey] ?? 0));
      const n = Number(value);
      if (!Number.isFinite(n)) return lo;
      return Math.max(lo, Math.min(hi, n));
    };

    const applyToState = (state) => {
      if (!state) return;
      for (const group of BOUND_FADER_GROUPS) {
        if (group.metaId === 'lightning' || group.metaId === 'gustiness') continue;
        state[group.metaId] = clampToBounds(group.minKey, group.maxKey, state[group.metaId]);
      }
      state.precipType = computePrecipType(state.precipitation, state.freezeLevel);
    };

    applyToState(wc.currentState);
    applyToState(wc.targetState);

    const snappedLightning = clampToBounds(
      'lightningMin',
      'lightningMax',
      Number(hooks.controlState?.landscapeLightning?.lightning),
    );
    writeLightningIntensityToControlState(hooks.controlState, snappedLightning);
    applyLightningIntensityToEffect(snappedLightning);

    const snappedAsh = clampToBounds('ashIntensityMin', 'ashIntensityMax', wc.targetState?.ashIntensity);
    if (wc.currentState) wc.currentState.ashIntensity = snappedAsh;
    if (wc.targetState) wc.targetState.ashIntensity = snappedAsh;
    applyAshMasterIntensity(snappedAsh, { syncMainTweakpane: false });

    const gustKey = String(hooks.controlState?.gustiness || 'moderate');
    let gustIdx = GUSTINESS_LABELS.indexOf(gustKey);
    if (gustIdx < 0) gustIdx = 2;
    const snappedGustIdx = Math.round(clampToBounds('gustinessMin', 'gustinessMax', gustIdx));
    const gustLabel = GUSTINESS_LABELS[snappedGustIdx] || 'moderate';
    hooks.controlState.gustiness = gustLabel;
    const variability = GUSTINESS_TO_VARIABILITY[gustLabel] ?? GUSTINESS_TO_VARIABILITY.moderate;
    if (typeof wc.setVariability === 'function') wc.setVariability(variability);
    else wc.variability = variability;

    if (wc._dynamicLatent && Number.isFinite(Number(wc.targetState?.freezeLevel))) {
      wc._dynamicLatent.temperature = Math.max(0, Math.min(1, 1 - Number(wc.targetState.freezeLevel)));
    }

    wc.isTransitioning = false;
    wc.transitionElapsed = 0;
    mirrorLiveValues();
  }

  /**
   * @param {Record<string, number>|undefined|null} stored
   * @param {Record<string, number>} target
   */
  function boundsDiffer(stored, target) {
    if (!target || typeof target !== 'object') return false;
    for (const [key, val] of Object.entries(target)) {
      if (!Number.isFinite(Number(val))) continue;
      const cur = Number(stored?.[key]);
      if (!Number.isFinite(cur) || Math.abs(cur - Number(val)) > 0.001) return true;
    }
    return false;
  }

  /**
   * Keep vertical bounds aligned with the active catalog preset on load and mirror.
   * @private
   */
  function syncBoundsFromActivePreset() {
    const preset = findEnvironmentPreset(resolveActivePresetId(), presetSections);
    if (!preset?.bounds) {
      boundsBoard.mirrorAllBounds();
      return;
    }

    if (hooks.controlState.dynamicEnvironmentPresetId) {
      const wc = hooks.getWeatherController();
      if (boundsDiffer(wc?._dynamicBounds, preset.bounds)) {
        applyBoundsToRuntime(preset.bounds);
      } else {
        boundsBoard.mirrorAllBounds();
        snapWeatherScalarsToBounds(preset.bounds);
      }
      return;
    }

    boundsBoard.mirrorAllBounds();
  }

  function positionPresetOverlay() {
    const width = PRESET_OVERLAY_WIDTH_PX;
    const margin = 16;
    const maxH = Math.min(760, window.innerHeight - margin * 2);
    const left = Math.max(margin, (window.innerWidth - width) / 2);
    const top = Math.max(margin, (window.innerHeight - maxH) / 2);

    presetPanel.style.width = `${width}px`;
    presetPanel.style.left = `${left}px`;
    presetPanel.style.top = `${top}px`;
    presetPanel.style.maxHeight = `${maxH}px`;
  }

  function closePresetPanel() {
    presetOverlay.hidden = true;
    presetBtn.setAttribute('aria-expanded', 'false');
    presetBtn.classList.remove('is-open');
  }

  function openPresetPanel() {
    positionPresetOverlay();
    presetOverlay.hidden = false;
    presetBtn.setAttribute('aria-expanded', 'true');
    presetBtn.classList.add('is-open');
  }

  presetBtn.addEventListener('click', () => {
    if (presetOverlay.hidden) openPresetPanel();
    else closePresetPanel();
  });

  presetBackdrop.addEventListener('click', () => closePresetPanel());

  const onOverlayKeydown = (e) => {
    if (e.key === 'Escape' && !presetOverlay.hidden) closePresetPanel();
  };

  window.addEventListener('resize', () => {
    if (!presetOverlay.hidden) positionPresetOverlay();
  });
  window.addEventListener('keydown', onOverlayKeydown);

  /**
   * @param {import('./dynamic-weather-catalog.js').EnvironmentPresetItem} item
   */
  function applyPreset(item) {
    activePresetId = item.id;
    hooks.controlState.dynamicEnvironmentPresetId = item.id;
    hooks.controlState.dynamicEnabled = true;
    hooks.controlState.dynamicPresetId = item.biome;
    hooks.controlState.dynamicPaused = false;

    applyBoundsToRuntime(item.bounds);
    updatePresetButtonLabel();
    void hooks.onApply();
    void commitDynamicPersistence();
  }

  function mirrorLiveValues() {
    const wc = hooks.getWeatherController();
    const state = wc?.getCurrentState?.() || wc?.currentState;
    if (!state) return;

    const gustKey = String(hooks.controlState?.gustiness || 'moderate');
    const gustIdx = GUSTINESS_LABELS.indexOf(gustKey);
    const lightning = Number(hooks.controlState?.landscapeLightning?.lightning);

    boundsBoard.setLiveValues({
      precipitation: Number(state.precipitation) || 0,
      cloudCover: Number(state.cloudCover) || 0,
      freezeLevel: Number(state.freezeLevel) || 0,
      fogDensity: Number(state.fogDensity) || 0,
      lightning: Number.isFinite(lightning) ? lightning : 0,
      ashIntensity: Number(state.ashIntensity) || 0,
      gustiness: gustIdx >= 0 ? gustIdx : 2,
    });
  }

  function mirrorAll() {
    activePresetId = resolveActivePresetId();
    syncBoundsFromActivePreset();
    mirrorLiveValues();
    updatePresetButtonLabel();
  }

  mirrorAll();

  return {
    root,
    mirror: mirrorAll,
    mirrorLive: mirrorLiveValues,
    mirrorInfo: updatePresetButtonLabel,
    destroy: () => {
      window.removeEventListener('keydown', onOverlayKeydown);
      presetOverlay.remove();
    },
  };
}
