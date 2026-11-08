/**
 * ui/rooms/guide/guide-actions.js — the buttons inside guide pages.
 *
 * Ingram 2026-11-07: the Quick Fixes half has "buttons which can change the config
 * of a scene so that it can teach something and offer an easy immediate way to
 * change how a scene does something". So every button here:
 *   1. does one clear thing through the SAME public door the Studio and Remote use
 *      (the effects' own setters, handed in by boot.js, and the Remote's weather/time/
 *      Looks closures) — never a private path;
 *   2. reports exactly what it changed, in the Studio's own words (the param's label),
 *      from → to, and where to find that control later (that is the teaching part);
 *   3. can be undone — the previous values are captured before the change.
 *
 * Effect values are read the way the effects themselves read them: the scene's stored
 * value (foundry/effect-param-persistence.js) or, when nothing is stored, the param's
 * declared default. Relative buttons ("a bit brighter") step from there and clamp to
 * the param's own min/max, so pressing twice keeps working and can never leave range.
 *
 * Pure apart from `env`: tests pass a fake env (guide/__tests__/guide-actions.test.mjs).
 *
 * @module ui/rooms/guide/guide-actions
 */

import {
  BLOOM_PARAMS,
  GRADE_LOOK_PARAMS,
  DYNAMIC_RANGE_PARAMS,
  LENS_PARAMS,
  DOF_PARAMS,
  FIRE_PARAMS,
  SUN_SHADOW_PARAMS,
  WINDOW_PARAMS,
  CLOUD_TOPS_PARAMS,
  effectEnableKey,
} from '../../../effects/index.js';

/**
 * The effects a guide button may touch: the scene-params id, the public setter on
 * `MapShine` (boot.js hands the guide that setter by name), the param schema, and where the control lives in the Studio.
 */
export const GUIDE_EFFECTS = Object.freeze({
  bloom: { setter: 'setBloom', params: BLOOM_PARAMS, name: 'Bloom', where: 'Studio → Effects → Bloom' },
  grade: {
    setter: 'setGrade',
    params: GRADE_LOOK_PARAMS,
    name: 'Colour Grade',
    where: 'Studio → Effects → Colour Grade',
  },
  dynamicRange: {
    setter: 'setDynamicRange',
    params: DYNAMIC_RANGE_PARAMS,
    name: 'Dynamic Range',
    where: 'Studio → Effects → Dynamic Range',
  },
  lens: { setter: 'setLens', params: LENS_PARAMS, name: 'Lens', where: 'Studio → Effects → Lens' },
  depthOfField: {
    setter: 'setDof',
    params: DOF_PARAMS,
    name: 'Depth of Field',
    where: 'Studio → Effects → Depth of Field',
  },
  fire: { setter: 'setFire', params: FIRE_PARAMS, name: 'Fire', where: 'Studio → Effects → Fire' },
  sunShadows: {
    setter: 'setSunShadows',
    params: SUN_SHADOW_PARAMS,
    name: 'Sun shadows',
    where: 'Studio → Effects → Sun shadows',
  },
  window: {
    setter: 'setWindowLight',
    params: WINDOW_PARAMS,
    name: 'Window light',
    where: 'Studio → Effects → Window light',
  },
  cloudTops: {
    setter: 'setCloudTops',
    params: CLOUD_TOPS_PARAMS,
    name: 'Cloud tops',
    where: 'Studio → Effects → Cloud Tops',
  },
});

const add = (d) => (v) => v + d;
const mul = (f) => (v) => v * f;
const set = (x) => () => x;

/**
 * Every button a page may name with `[[do: id]]`.
 * kind 'param'   — `{effect, changes: {key: fn(current) → next}}`
 * kind 'enable'  — `{effect, on}` (this computer's switch for the effect)
 * kind 'weather' — `{archetype}` (fades over the Remote's Fade Time)
 * kind 'time'    — `{hour}`
 * kind 'night'   — `{change: fn(current) → next}` (the Mix tab's Night fader)
 * kind 'renderer'— `{mode: 'foundry'|'msa'}`
 * kind 'open'    — `{target}` (opens a tool; nothing to undo)
 */
export const GUIDE_ACTIONS = Object.freeze({
  // ---- light levels ----
  brighten: { label: 'Brighter', icon: 'sun', kind: 'param', effect: 'grade', changes: { exposure: add(0.5) } },
  darken: { label: 'Darker', icon: 'moon', kind: 'param', effect: 'grade', changes: { exposure: add(-0.5) } },
  'brighten-inside': {
    label: 'Brighter indoors',
    icon: 'home',
    kind: 'param',
    effect: 'grade',
    changes: { exposureInside: add(0.5) },
  },
  'brighten-outside': {
    label: 'Brighter outdoors',
    icon: 'sun',
    kind: 'param',
    effect: 'grade',
    changes: { exposureOutside: add(0.5) },
  },
  'lamps-up': {
    label: 'Stronger light',
    icon: 'candle',
    kind: 'param',
    effect: 'grade',
    changes: { lightLevel: mul(1.3) },
  },
  'lamps-down': {
    label: 'Softer light',
    icon: 'candle',
    kind: 'param',
    effect: 'grade',
    changes: { lightLevel: mul(0.75) },
  },
  'night-lighter': { label: 'Lighter night', icon: 'moon', kind: 'night', change: add(-0.2) },
  'night-darker': { label: 'Darker night', icon: 'moon', kind: 'night', change: add(0.2) },
  // ---- glow and shine ----
  'bloom-softer': { label: 'Less glow', icon: 'sun', kind: 'param', effect: 'bloom', changes: { strength: mul(0.6) } },
  'bloom-off': { label: 'Glow off', icon: 'x', kind: 'enable', effect: 'bloom', on: false },
  'bloom-on': { label: 'Glow on', icon: 'check', kind: 'enable', effect: 'bloom', on: true },
  'window-softer': {
    label: 'Softer window light',
    icon: 'frame',
    kind: 'param',
    effect: 'window',
    changes: { strength: mul(0.65) },
  },
  'window-stronger': {
    label: 'Stronger window light',
    icon: 'frame',
    kind: 'param',
    effect: 'window',
    changes: { strength: mul(1.4) },
  },
  // ---- shadows ----
  'shadows-lighter': {
    label: 'Lighter shadows',
    icon: 'layers',
    kind: 'param',
    effect: 'sunShadows',
    changes: { strength01: add(-0.25) },
  },
  'shadows-darker': {
    label: 'Darker shadows',
    icon: 'layers',
    kind: 'param',
    effect: 'sunShadows',
    changes: { strength01: add(0.15) },
  },
  'shadows-shorter': {
    label: 'Shorter shadows',
    icon: 'layers',
    kind: 'param',
    effect: 'sunShadows',
    changes: { lengthScale: mul(0.6) },
  },
  // ---- colour and mood ----
  warmer: { label: 'Warmer', icon: 'fire', kind: 'param', effect: 'grade', changes: { temperature: add(0.2) } },
  cooler: { label: 'Cooler', icon: 'snow', kind: 'param', effect: 'grade', changes: { temperature: add(-0.2) } },
  richer: { label: 'Richer colour', icon: 'gem', kind: 'param', effect: 'grade', changes: { saturation: add(0.2) } },
  muted: { label: 'Muted colour', icon: 'fog', kind: 'param', effect: 'grade', changes: { saturation: add(-0.25) } },
  'more-drama': {
    label: 'More drama',
    icon: 'bolt',
    kind: 'param',
    effect: 'dynamicRange',
    changes: { drama: add(0.2) },
  },
  'less-drama': {
    label: 'Less drama',
    icon: 'eye',
    kind: 'param',
    effect: 'dynamicRange',
    changes: { drama: add(-0.2) },
  },
  vignette: { label: 'Dark edges', icon: 'frame', kind: 'param', effect: 'grade', changes: { vignette: add(0.3) } },
  // ---- the sky ----
  'wx-clear': { label: 'Clear sky', icon: 'sun', kind: 'weather', archetype: 'clear' },
  'wx-overcast': { label: 'Overcast', icon: 'cloud', kind: 'weather', archetype: 'overcast' },
  'wx-fog': { label: 'Fog', icon: 'fog', kind: 'weather', archetype: 'fog' },
  'wx-rain': { label: 'Rain', icon: 'rain', kind: 'weather', archetype: 'steady-rain' },
  'wx-storm': { label: 'Storm', icon: 'bolt', kind: 'weather', archetype: 'thunderstorm' },
  'wx-snow': { label: 'Snow', icon: 'snow', kind: 'weather', archetype: 'snow' },
  'time-dawn': { label: 'Dawn', icon: 'sun', kind: 'time', hour: 6.5 },
  'time-noon': { label: 'Noon', icon: 'sun', kind: 'time', hour: 12 },
  'time-golden': { label: 'Golden hour', icon: 'sun', kind: 'time', hour: 18.25 },
  'time-night': { label: 'Night', icon: 'moon', kind: 'time', hour: 23 },
  // ---- fire ----
  'fire-smaller': {
    label: 'Smaller flames',
    icon: 'fire',
    kind: 'param',
    effect: 'fire',
    changes: { flameSize: mul(0.7) },
  },
  'fire-bigger': {
    label: 'Bigger flames',
    icon: 'fire',
    kind: 'param',
    effect: 'fire',
    changes: { flameSize: mul(1.35) },
  },
  'smoke-less': {
    label: 'Less smoke',
    icon: 'cloud',
    kind: 'param',
    effect: 'fire',
    changes: { smokeDensity: mul(0.5) },
  },
  'fire-off': { label: 'Fire off', icon: 'x', kind: 'enable', effect: 'fire', on: false },
  'fire-on': { label: 'Fire on', icon: 'check', kind: 'enable', effect: 'fire', on: true },
  // ---- the camera ----
  'dof-off': { label: 'Depth blur off', icon: 'eye', kind: 'enable', effect: 'depthOfField', on: false },
  'lens-off': { label: 'Lens effects off', icon: 'eye', kind: 'enable', effect: 'lens', on: false },
  'lens-on': { label: 'Lens effects on', icon: 'eye', kind: 'enable', effect: 'lens', on: true },
  'grain-off': {
    label: 'No film grain',
    icon: 'dust',
    kind: 'param',
    effect: 'lens',
    changes: { grainAmount: set(0) },
  },
  'fringe-off': {
    label: 'No colour fringing',
    icon: 'gem',
    kind: 'param',
    effect: 'lens',
    changes: { chromaticAmountPx: set(0) },
  },
  // ---- speed ----
  'cloudtops-off': { label: 'Cloud tops off', icon: 'cloud', kind: 'enable', effect: 'cloudTops', on: false },
  // ---- emergency ----
  'renderer-foundry': { label: 'Show plain Foundry', icon: 'shield', kind: 'renderer', mode: 'foundry' },
  'renderer-msa': { label: 'Back to Map Shine', icon: 'candle', kind: 'renderer', mode: 'msa' },
  // ---- tools ----
  'open-painter': { label: 'Open the mask painter', icon: 'pin', kind: 'open', target: 'painter' },
  'open-studio': { label: 'Open the Studio', icon: 'gear', kind: 'open', target: 'studio' },
  'open-remote-mix': { label: 'Open the Mix tab', icon: 'gauge', kind: 'open', target: 'remote-mix' },
});

/** Round for display: at most 2 decimals, no trailing zeros. */
export function fmt(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function clampTo(decl, v) {
  let out = v;
  if (typeof decl?.min === 'number') out = Math.max(decl.min, out);
  if (typeof decl?.max === 'number') out = Math.min(decl.max, out);
  return Math.round(out * 1000) / 1000;
}

function hourLabel(h) {
  if (typeof h !== 'number' || !Number.isFinite(h)) return '?';
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Every action id the guide knows (drift tests check pages name only these). */
export const GUIDE_ACTION_IDS = Object.freeze(Object.keys(GUIDE_ACTIONS));

/**
 * The current value of one effect param: the scene's stored value, else its default.
 * @param {object} env
 * @param {string} effectId
 * @param {string} key
 */
export function currentParam(env, effectId, key) {
  const spec = GUIDE_EFFECTS[effectId];
  const stored = env.readSceneEffectParams?.(effectId)?.params ?? null;
  const v = stored && key in stored ? stored[key] : spec?.params?.[key]?.default;
  return v;
}

/**
 * @typedef {{label: string, from: string, to: string}} GuideChange
 * @typedef {{ok: boolean, message: string, changes: GuideChange[], where?: string,
 *   undo: null | (() => Promise<{ok:boolean,message:string}>)}} GuideResult
 */

/**
 * Run one button.
 * @param {string} id
 * @param {object} env - `{effectSetter(name) → fn|null, readSceneEffectParams, readSetting, writeSetting, remote, getHour, open}`
 * @returns {Promise<GuideResult>}
 */
export async function runGuideAction(id, env) {
  const a = GUIDE_ACTIONS[id];
  const fail = (message) => ({ ok: false, message, changes: [], undo: null });
  if (!a) return fail(`Unknown guide button "${id}".`);
  const setterOf = (name) => (typeof env.effectSetter === 'function' ? env.effectSetter(name) : null);
  const remote = env.remote ?? {};
  try {
    if (a.kind === 'param') {
      const spec = GUIDE_EFFECTS[a.effect];
      const setter = setterOf(spec?.setter);
      if (typeof setter !== 'function') return fail(`${spec?.name ?? a.effect} is not running in this scene.`);
      const before = {};
      const after = {};
      const changes = [];
      for (const [key, fn] of Object.entries(a.changes)) {
        const decl = spec.params[key];
        const from = Number(currentParam(env, a.effect, key));
        const to = clampTo(decl, fn(Number.isFinite(from) ? from : Number(decl?.default ?? 0)));
        before[key] = from;
        after[key] = to;
        changes.push({ label: `${spec.name} · ${decl?.label ?? key}`, from: fmt(from), to: fmt(to) });
      }
      if (changes.every((c) => c.from === c.to)) {
        return {
          ok: true,
          message: `Already as far as it goes (${changes.map((c) => `${c.label} ${c.to}`).join(', ')}).`,
          changes,
          where: spec.where,
          undo: null,
        };
      }
      await setter(after);
      return {
        ok: true,
        message: 'Done.',
        changes,
        where: spec.where,
        undo: async () => {
          await setter(before);
          return { ok: true, message: `Put back: ${changes.map((c) => `${c.label} ${c.from}`).join(', ')}.` };
        },
      };
    }
    if (a.kind === 'enable') {
      const spec = GUIDE_EFFECTS[a.effect];
      const setter = setterOf(spec?.setter);
      if (typeof setter !== 'function') return fail(`${spec?.name ?? a.effect} is not running in this scene.`);
      const key = effectEnableKey(a.effect, 'player');
      const prev = env.readSetting?.(key);
      await setter({ enabled: a.on });
      return {
        ok: true,
        message: `${spec.name} switched ${a.on ? 'on' : 'off'} on this computer.`,
        changes: [
          {
            label: `${spec.name}`,
            from: prev === 'on' || prev === 'off' ? prev : 'scene default',
            to: a.on ? 'on' : 'off',
          },
        ],
        where: spec.where,
        undo: async () => {
          if (prev === 'on' || prev === 'off') await setter({ enabled: prev === 'on' });
          else if (typeof env.writeSetting === 'function') await env.writeSetting(key, prev);
          return { ok: true, message: `${spec.name} is back as it was.` };
        },
      };
    }
    if (a.kind === 'weather') {
      const wb = remote.weatherBoard;
      if (typeof wb?.fadeToArchetype !== 'function') return fail('The weather controls are not ready yet.');
      const prev = wb.getWeatherArchetype?.() ?? 'custom';
      const prevAxes = {
        cloudCover01: wb.getAxisValue?.('cloudCover01'),
        precip01: wb.getAxisValue?.('precip01'),
        fogDensity01: wb.getAxisValue?.('fogDensity01'),
      };
      const overMs = remote.getFadeOverMs?.() ?? 0;
      await wb.fadeToArchetype(a.archetype, overMs);
      return {
        ok: true,
        message: overMs > 0 ? `Easing in over ${Math.round(overMs / 1000)} s (the Remote's Fade Time).` : 'Done.',
        changes: [{ label: 'Weather', from: prev, to: a.archetype }],
        where: 'Remote → Mix',
        undo: async () => {
          if (prev && prev !== 'custom') await wb.fadeToArchetype(prev, overMs);
          else {
            for (const [axis, v] of Object.entries(prevAxes)) if (Number.isFinite(v)) await wb.onAxisCommit?.(axis, v);
          }
          return { ok: true, message: 'The sky is going back to how it was.' };
        },
      };
    }
    if (a.kind === 'time') {
      if (typeof remote.onSweepToHour !== 'function') return fail('The clock is not ready yet.');
      const prev = env.getHour?.();
      const overMs = remote.getFadeOverMs?.() ?? 0;
      await remote.onSweepToHour(a.hour, overMs);
      return {
        ok: true,
        message: 'Done.',
        changes: [
          { label: 'Time of day', from: Number.isFinite(prev) ? hourLabel(prev) : 'now', to: hourLabel(a.hour) },
        ],
        where: 'Remote → Play (the dial)',
        undo: Number.isFinite(prev)
          ? async () => {
              await remote.onSweepToHour(prev, overMs);
              return { ok: true, message: `Back to ${hourLabel(prev)}.` };
            }
          : null,
      };
    }
    if (a.kind === 'night') {
      const wb = remote.weatherBoard;
      if (typeof wb?.onNightDarknessCommit !== 'function') return fail('The Night fader is not ready yet.');
      const from = Number(wb.getNightDarkness?.() ?? 0);
      const to = clampTo({ min: 0, max: 1 }, a.change(from));
      await wb.onNightDarknessCommit(to);
      return {
        ok: true,
        message: 'Done.',
        changes: [{ label: 'Night darkness', from: fmt(from), to: fmt(to) }],
        where: 'Remote → Mix → Night',
        undo: async () => {
          await wb.onNightDarknessCommit(from);
          return { ok: true, message: `Night darkness back to ${fmt(from)}.` };
        },
      };
    }
    if (a.kind === 'renderer') {
      if (typeof remote.onRendererOverrideChange !== 'function') return fail('The renderer switch is not available.');
      const prev = remote.getRendererOverride?.() ?? 'msa';
      await remote.onRendererOverrideChange(a.mode);
      return {
        ok: true,
        message:
          a.mode === 'foundry'
            ? "Foundry's own renderer is drawing the scene."
            : 'Map Shine is drawing the scene again.',
        changes: [
          {
            label: 'Renderer',
            from: prev === 'foundry' ? 'Foundry' : 'Map Shine',
            to: a.mode === 'foundry' ? 'Foundry' : 'Map Shine',
          },
        ],
        where: 'Remote → ⋯ menu',
        undo: async () => {
          await remote.onRendererOverrideChange(prev);
          return { ok: true, message: 'Renderer put back.' };
        },
      };
    }
    if (a.kind === 'open') {
      const opened = await env.open?.(a.target);
      return opened === false
        ? fail('That tool is not available right now.')
        : { ok: true, message: 'Opened.', changes: [], undo: null };
    }
    return fail(`Guide button "${id}" has no handler.`);
  } catch (err) {
    return fail(`That did not work: ${err?.message ?? err}`);
  }
}
