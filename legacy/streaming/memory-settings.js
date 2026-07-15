/**
 * @fileoverview Resolve GPU VRAM / system RAM presets from graphics settings.
 * @module streaming/memory-settings
 */

import { getEstimatedGpuVramGB } from '../core/gpu-probe.js';

/** @typedef {'auto'|'4'|'6'|'8'|'12'|'16'|'24'} GpuVramPresetId */
/** @typedef {'auto'|'4'|'8'|'16'|'32'|'64'} SystemRamPresetId */

/** Foundry client setting key — editable before any scene loads (Configure Settings). */
export const CLIENT_GPU_VRAM_PRESET_SETTING = 'clientGpuVramPreset';

/** Foundry client setting key — default render resolution when a scene has no override yet. */
export const CLIENT_RENDER_RESOLUTION_PRESET_SETTING = 'clientRenderResolutionPreset';

/** @type {readonly GpuVramPresetId[]} */
export const GPU_VRAM_PRESET_IDS = Object.freeze(['auto', '4', '6', '8', '12', '16', '24']);

/** @type {readonly SystemRamPresetId[]} */
export const SYSTEM_RAM_PRESET_IDS = Object.freeze(['auto', '4', '8', '16', '32', '64']);

/** GPU VRAM (GB) → base texture budget (MB), before scene adjustments. */
const GPU_VRAM_BUDGET_MB = Object.freeze({
  4: 384,
  6: 512,
  8: 768,
  12: 1024,
  16: 1280,
  24: 1536,
});

/** GPU VRAM (GB) → per-tile effect mask VRAM budget (MB). */
const GPU_VRAM_EFFECT_MASK_MB = Object.freeze({
  4: 384,
  6: 512,
  8: 512,
  12: 768,
  16: 1024,
  24: 1536,
});

/**
 * @typedef {object} SystemRamProfile
 * @property {number} workers - Tile decode worker count
 * @property {number} tileCache - Max decoded tile textures in RAM
 * @property {number} blobCache - Max source image blobs in RAM
 */

/** System RAM (GB) → decode/cache profile (nearest tier at or below effective RAM). */
const SYSTEM_RAM_PROFILE = Object.freeze({
  4: { workers: 1, tileCache: 32, blobCache: 2 },
  8: { workers: 2, tileCache: 64, blobCache: 3 },
  16: { workers: 3, tileCache: 128, blobCache: 4 },
  32: { workers: 3, tileCache: 128, blobCache: 5 },
  64: { workers: 3, tileCache: 128, blobCache: 6 },
});

const GPU_VRAM_PRESET_LABELS = Object.freeze({
  auto: 'Auto',
  4: '4 GB',
  6: '6 GB',
  8: '8 GB',
  12: '12 GB',
  16: '16 GB',
  24: '24 GB',
});

const SYSTEM_RAM_PRESET_LABELS = Object.freeze({
  auto: 'Auto',
  4: '4 GB',
  8: '8 GB',
  16: '16 GB',
  32: '32 GB',
  64: '64 GB',
});

/**
 * @returns {number}
 */
export function getDetectedSystemRamGB() {
  return Number(navigator?.deviceMemory) || 4;
}

/**
 * Read persisted per-scene graphics overrides from localStorage (no manager required).
 * @param {string|null|undefined} [sceneId]
 * @returns {{ gpuVramPreset?: string, systemRamPreset?: string, renderResolutionPreset?: string }}
 */
export function readPersistedGraphicsOverrides(sceneId = null) {
  try {
    const sid = sceneId ?? globalThis.canvas?.scene?.id ?? globalThis.game?.scenes?.active?.id ?? null;
    const userId = globalThis.game?.user?.id || 'no-user';
    if (!sid) return {};
    const raw = globalThis.localStorage?.getItem?.(
      `map-shine-advanced.graphicsOverrides.${sid}.${userId}`,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * @returns {GpuVramPresetId}
 */
export function getClientGpuVramPreset() {
  try {
    const v = globalThis.game?.settings?.get?.('map-shine-advanced', CLIENT_GPU_VRAM_PRESET_SETTING);
    if (v && GPU_VRAM_PRESET_IDS.includes(v)) return v;
  } catch (_) {
  }
  return 'auto';
}

/**
 * @returns {string}
 */
export function getClientRenderResolutionPreset() {
  try {
    const v = globalThis.game?.settings?.get?.('map-shine-advanced', CLIENT_RENDER_RESOLUTION_PRESET_SETTING);
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch (_) {
  }
  return 'native';
}

/**
 * @returns {{ gpuVramPreset: GpuVramPresetId, systemRamPreset: SystemRamPresetId }}
 */
export function getGraphicsMemoryPresets() {
  const gs = window.MapShine?.graphicsSettings;
  const persisted = gs ? {} : readPersistedGraphicsOverrides();
  let gpuVramPreset = gs?.getGpuVramPreset?.()
    ?? persisted.gpuVramPreset
    ?? 'auto';
  let systemRamPreset = gs?.getSystemRamPreset?.()
    ?? persisted.systemRamPreset
    ?? 'auto';

  if (gpuVramPreset === 'auto') {
    const client = getClientGpuVramPreset();
    if (client !== 'auto') gpuVramPreset = client;
  }

  return {
    gpuVramPreset,
    systemRamPreset,
  };
}

/**
 * @param {SystemRamPresetId|null|undefined} [preset]
 * @returns {number}
 */
export function resolveEffectiveSystemRamGB(preset = null) {
  const p = preset ?? getGraphicsMemoryPresets().systemRamPreset;
  if (p && p !== 'auto') return Number(p) || 4;
  return getDetectedSystemRamGB();
}

/**
 * @param {GpuVramPresetId|null|undefined} [preset]
 * @returns {number}
 */
export function resolveEffectiveGpuVramGB(preset = null) {
  const p = preset ?? getGraphicsMemoryPresets().gpuVramPreset;
  if (p && p !== 'auto') return Number(p) || 8;
  return resolveAutoGpuVramGB();
}

/**
 * Resolve the "auto" GPU VRAM budget.
 *
 * Historically this inferred VRAM from system RAM alone (16 GB RAM -> 16 GB
 * VRAM), which is wrong for the common laptop case of 16 GB RAM + an 8 GB
 * discrete GPU and left every crash guardrail disarmed. We now consult the
 * actual GPU (renderer string, via {@link module:core/gpu-probe}) and cap the
 * budget to what the card can hold. When the GPU cannot be identified we refuse
 * to assume more than 8 GB rather than trusting system RAM.
 *
 * @returns {number}
 */
export function resolveAutoGpuVramGB() {
  const ram = resolveEffectiveSystemRamGB();
  const ramInferred = ram >= 16 ? 16 : ram >= 8 ? 8 : 4;

  let gpuEstimate = null;
  try { gpuEstimate = getEstimatedGpuVramGB(); } catch (_) {}

  if (gpuEstimate != null && Number.isFinite(gpuEstimate) && gpuEstimate > 0) {
    // Trust the identified GPU, but never exceed what system RAM can back.
    return Math.max(4, Math.min(ramInferred, gpuEstimate));
  }
  // Unknown GPU: do not assume a discrete card has as much VRAM as system RAM.
  return Math.min(ramInferred, 8);
}

/**
 * @returns {boolean}
 */
export function isGpuVramUserOverride() {
  return getGraphicsMemoryPresets().gpuVramPreset !== 'auto';
}

/**
 * @returns {boolean}
 */
export function isSystemRamUserOverride() {
  return getGraphicsMemoryPresets().systemRamPreset !== 'auto';
}

/**
 * Auto texture budget from RAM + GPU tier (legacy ladder).
 * @param {number} deviceMemGB
 * @param {string} tier
 * @returns {number}
 */
export function resolveAutoBudgetMBFromRam(deviceMemGB, tier) {
  if (tier === 'low') return 256;
  if (deviceMemGB >= 16) return 1024;
  if (deviceMemGB >= 8) return 768;
  if (deviceMemGB >= 4) return 512;
  return 384;
}

/**
 * Base texture budget (MB) before scene-size caps.
 * @param {number} gpuVramGB
 * @param {string} tier
 * @param {boolean} userOverride
 * @param {number} deviceMemGB
 * @returns {number}
 */
export function resolveGpuVramBaseBudgetMB(gpuVramGB, tier, userOverride, deviceMemGB) {
  const autoMb = resolveAutoBudgetMBFromRam(deviceMemGB, tier);
  if (userOverride) {
    const presetMb = GPU_VRAM_BUDGET_MB[gpuVramGB] ?? 512;
    // User override adds headroom over auto-detect, but avoid runaway budgets on mid-size scenes.
    return Math.min(presetMb, autoMb + 512);
  }
  return autoMb;
}

/**
 * Huge-scene (≥130 MP) budget cap (MB).
 * @param {number} gpuVramGB
 * @param {boolean} userOverride
 * @param {boolean} tierHigh
 * @param {number} deviceMemGB
 * @returns {number}
 */
export function resolveHugeSceneCapMB(gpuVramGB, userOverride, tierHigh, deviceMemGB) {
  if (!userOverride) {
    return tierHigh && deviceMemGB >= 8 ? 640 : (tierHigh ? 512 : 384);
  }
  if (gpuVramGB >= 24) return 1536;
  if (gpuVramGB >= 16) return 1280;
  if (gpuVramGB >= 12) return 1024;
  return tierHigh && deviceMemGB >= 8 ? 640 : 512;
}

/**
 * Large-scene (≥90 MP) budget cap (MB).
 * @param {number} gpuVramGB
 * @param {boolean} userOverride
 * @returns {number}
 */
export function resolveLargeSceneCapMB(gpuVramGB, userOverride) {
  if (userOverride && gpuVramGB >= 12) return 1280;
  return 768;
}

/**
 * @param {number} ramGB
 * @returns {SystemRamProfile}
 */
export function resolveSystemRamProfile(ramGB) {
  const tiers = [4, 8, 16, 32, 64];
  let pick = 4;
  for (const k of tiers) {
    if (ramGB >= k) pick = k;
  }
  return SYSTEM_RAM_PROFILE[pick];
}

/**
 * @param {number} gpuVramGB
 * @param {boolean} userOverride
 * @returns {number}
 */
export function resolveEffectMaskVramBudgetMB(gpuVramGB, userOverride) {
  if (userOverride) {
    return GPU_VRAM_EFFECT_MASK_MB[gpuVramGB] ?? 512;
  }
  return 512;
}

/**
 * @returns {Array<{ id: GpuVramPresetId, label: string }>}
 */
export function listGpuVramPresetOptions() {
  return GPU_VRAM_PRESET_IDS.map((id) => ({
    id,
    label: GPU_VRAM_PRESET_LABELS[id] ?? id,
  }));
}

/**
 * @returns {Array<{ id: SystemRamPresetId, label: string }>}
 */
export function listSystemRamPresetOptions() {
  return SYSTEM_RAM_PRESET_IDS.map((id) => ({
    id,
    label: SYSTEM_RAM_PRESET_LABELS[id] ?? id,
  }));
}

/**
 * @param {GpuVramPresetId} id
 * @returns {string}
 */
export function formatGpuVramPresetLabel(id) {
  return GPU_VRAM_PRESET_LABELS[id] ?? String(id);
}

/**
 * @param {SystemRamPresetId} id
 * @returns {string}
 */
export function formatSystemRamPresetLabel(id) {
  return SYSTEM_RAM_PRESET_LABELS[id] ?? String(id);
}

/**
 * Apply RAM-profile side effects (pyramid caches, decode workers) without static
 * imports that participate in the tile-decode-pool ↔ texture-pyramid-builder cycle.
 * @param {SystemRamProfile} ramProfile
 */
export function applyStreamingMemorySideEffects(ramProfile) {
  void import('./texture-pyramid-builder.js')
    .then(({ configurePyramidMemoryCaches }) => configurePyramidMemoryCaches(ramProfile))
    .catch(() => {});
  void import('./tile-decode-pool.js')
    .then(({ resizeDecodePoolIfNeeded }) => resizeDecodePoolIfNeeded(ramProfile.workers))
    .catch(() => {});
}

/**
 * Apply saved graphics memory presets when streaming is about to start.
 * Safe to call from FloorRenderBus.populate (renderer + scene dimensions known).
 */
export function applySavedMemoryPresetsForScene() {
  const effectiveRam = resolveEffectiveSystemRamGB();
  applyStreamingMemorySideEffects(resolveSystemRamProfile(effectiveRam));

  const maskMb = resolveEffectMaskVramBudgetMB(
    resolveEffectiveGpuVramGB(),
    isGpuVramUserOverride(),
  );
  window.MapShine?.tileManager?.setEffectMaskVramBudget?.(maskMb * 1024 * 1024);
}
