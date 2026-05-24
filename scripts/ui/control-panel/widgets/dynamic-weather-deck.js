/**
 * @fileoverview Compact Dynamic Weather deck — range bounds faders + overlay preset picker.
 * @module ui/control-panel/widgets/dynamic-weather-deck
 */

import { createNativeControl } from '../cp-shell.js';
import {
  buildEnvironmentPresetSections,
  findEnvironmentPreset,
  lookupBiome,
} from './dynamic-weather-catalog.js';
import { createSplitBoundsFaderBoard } from './split-bounds-fader-board.js';

const PRESET_OVERLAY_WIDTH_PX = 720;

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

  const evolutionStrip = document.createElement('div');
  evolutionStrip.className = 'msa-cp-dynamic-evolution-strip';

  const evolutionHeader = document.createElement('div');
  evolutionHeader.className = 'msa-cp-dynamic-evolution-strip__header';

  const evolutionTitle = document.createElement('span');
  evolutionTitle.className = 'msa-cp-dynamic-evolution-strip__title';
  evolutionTitle.textContent = 'Evolution';

  const evolutionTag = document.createElement('span');
  evolutionTag.className = 'msa-cp-dynamic-evolution-strip__tag';

  evolutionHeader.appendChild(evolutionTitle);
  evolutionHeader.appendChild(evolutionTag);
  evolutionStrip.appendChild(evolutionHeader);

  const evolutionToggles = document.createElement('div');
  evolutionToggles.className = 'msa-cp-dynamic-evolution-strip__toggles';

  /**
   * @param {string} label
   * @param {() => boolean} read
   * @param {(next: boolean) => void} write
   * @param {() => void} commit
   */
  function createEvolutionToggle(label, read, write, commit) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msa-cp-dynamic-evolution-strip__toggle';
    btn.textContent = label;
    btn.disabled = !hooks.isGm();

    const mirror = () => {
      const on = read();
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };

    btn.addEventListener('click', () => {
      if (!hooks.isGm()) return;
      write(!read());
      mirror();
      commit();
    });

    mirror();
    return { btn, mirror };
  }

  const evolveToggle = createEvolutionToggle(
    'Evolve',
    () => hooks.controlState.dynamicEnabled === true,
    (next) => { hooks.controlState.dynamicEnabled = next; },
    () => {
      void hooks.onApply();
      hooks.onSave();
      updateEvolutionTag();
      updatePresetButtonLabel();
    },
  );

  const pauseToggle = createEvolutionToggle(
    'Pause',
    () => hooks.controlState.dynamicPaused === true,
    (next) => { hooks.controlState.dynamicPaused = next; },
    () => {
      void hooks.onApply();
      hooks.onSave();
      updateEvolutionTag();
    },
  );

  evolutionToggles.appendChild(evolveToggle.btn);
  evolutionToggles.appendChild(pauseToggle.btn);
  evolutionStrip.appendChild(evolutionToggles);

  const speedWrap = document.createElement('div');
  speedWrap.className = 'msa-cp-dynamic-evolution-strip__speed';

  const speed = createNativeControl({
    type: 'range',
    label: 'Speed',
    target: hooks.controlState,
    key: 'dynamicEvolutionSpeed',
    min: 0,
    max: 600,
    step: 1,
    disabled: !hooks.isGm(),
    onChange: () => {
      void hooks.onApply();
      hooks.onSave();
      updateEvolutionTag();
    },
  });
  speed.row.classList.add('msa-cp-dynamic-evolution-strip__speed-row');
  speedWrap.appendChild(speed.row);
  evolutionStrip.appendChild(speedWrap);
  root.appendChild(evolutionStrip);

  function updateEvolutionTag() {
    const speedVal = Math.round(Number(hooks.controlState.dynamicEvolutionSpeed) || 0);
    const paused = hooks.controlState.dynamicPaused === true;
    const evolving = hooks.controlState.dynamicEnabled === true;
    if (!evolving) {
      evolutionTag.textContent = 'Off';
      return;
    }
    evolutionTag.textContent = paused ? `${speedVal}× · Paused` : `${speedVal}×`;
  }

  const presetRow = document.createElement('div');
  presetRow.className = 'msa-cp-dynamic-deck__preset-row';

  const presetBtn = document.createElement('button');
  presetBtn.type = 'button';
  presetBtn.className = 'msa-cp-dynamic-deck__preset-btn';
  presetBtn.setAttribute('aria-haspopup', 'listbox');
  presetBtn.setAttribute('aria-expanded', 'false');

  const presetChevron = document.createElement('span');
  presetChevron.className = 'msa-cp-dynamic-deck__preset-chevron';
  presetChevron.textContent = '▾';
  presetChevron.setAttribute('aria-hidden', 'true');

  presetRow.appendChild(presetBtn);
  presetRow.appendChild(presetChevron);
  root.appendChild(presetRow);

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
      optMeta.textContent = `${lookupBiome(item.biome)?.label || item.biome} · ${item.speed}× evolution · ${item.planMinutes} min steps`;

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
    return key.endsWith('Max') ? 1 : 0;
  };

  const writeBound = (key, value) => {
    const wc = hooks.getWeatherController();
    wc?.setDynamicBound?.(key, value);
    wc?.setDynamicBoundsEnabled?.(true);
  };

  const boundsBoard = createSplitBoundsFaderBoard(faderMount, {
    readBound,
    writeBound,
    disabled: !hooks.isGm(),
    setContextHint: hooks.setContextHint,
    clearContextHint: hooks.clearContextHint,
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
    presetRow.classList.remove('is-open');
  }

  function openPresetPanel() {
    positionPresetOverlay();
    presetOverlay.hidden = false;
    presetBtn.setAttribute('aria-expanded', 'true');
    presetRow.classList.add('is-open');
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
    hooks.controlState.dynamicEvolutionSpeed = item.speed;
    hooks.controlState.dynamicPaused = false;

    const wc = hooks.getWeatherController();
    if (typeof wc?.setDynamicPlanDurationMinutes === 'function') {
      wc.setDynamicPlanDurationMinutes(item.planMinutes);
    }
    wc?.setDynamicBoundsEnabled?.(true);
    if (item.bounds) {
      for (const [key, val] of Object.entries(item.bounds)) {
        wc?.setDynamicBound?.(key, val);
      }
    }

    boundsBoard.applyBounds(item.bounds);
    evolveToggle.mirror();
    pauseToggle.mirror();
    speed.mirror();
    updateEvolutionTag();
    updatePresetButtonLabel();
    void hooks.onApply();
    void commitDynamicPersistence();
  }

  function ensureBoundsFromStoredPreset() {
    const presetId = hooks.controlState.dynamicEnvironmentPresetId;
    if (typeof presetId !== 'string' || !presetId) return;

    const preset = findEnvironmentPreset(presetId, presetSections);
    if (!preset?.bounds) return;

    const scene = canvas?.scene;
    const stored = scene?.getFlag?.('map-shine-advanced', 'weather-dynamic');
    if (stored?.bounds && typeof stored.bounds === 'object') return;

    const wc = hooks.getWeatherController();
    wc?.setDynamicBoundsEnabled?.(true);
    boundsBoard.applyBounds(preset.bounds);
  }

  function mirrorAll() {
    activePresetId = resolveActivePresetId();
    evolveToggle.mirror();
    pauseToggle.mirror();
    speed.mirror();
    updateEvolutionTag();
    ensureBoundsFromStoredPreset();
    boundsBoard.mirrorAllBounds();
    updatePresetButtonLabel();
  }

  mirrorAll();

  return {
    root,
    mirror: mirrorAll,
    mirrorInfo: updatePresetButtonLabel,
    destroy: () => {
      window.removeEventListener('keydown', onOverlayKeydown);
      presetOverlay.remove();
    },
  };
}
