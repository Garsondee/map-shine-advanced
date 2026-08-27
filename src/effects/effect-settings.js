/**
 * EFFECT SETTINGS — deriving the per-client / per-world settings for the control
 * cascade FROM the manifests, as pure data. The Foundry `game.settings` I/O is a
 * thin wrapper in `foundry/settings-adapter.js`; THIS decides *what* settings
 * exist and *how* they map back to cascade layers, so that logic is Node-tested
 * and lives with the effects it describes — not smuggled into the Foundry leaf.
 *
 * Why this split matters (docs/planning/Effect-Registration.md §6): V2's
 * `scene-settings.js` hand-registered 44 settings in one file AND imported
 * effects + UI, coupling all three. Here the descriptors are DERIVED from the
 * registry's manifests (so a new effect gets its settings for free — the
 * velocity test), the adapter knows nothing about effects, and this module knows
 * nothing about Foundry.
 *
 * @module effects/effect-settings
 */

import { PERFORMANCE_PROFILES, ENABLE_OVERRIDES, DEFAULT_PERFORMANCE_PROFILE } from './effect-cascade.js';
// Through graph/'s own door (graph/index.js) — zones/one-door allows this
// exact shape. SCALE_LADDER is the render-scale governor's real ladder
// (graph/v3-perf.js); the render-scale choices below are DERIVED from it,
// never a second, hand-typed list — the same "validate against the real
// ladder, don't keep a parallel one that can drift" discipline
// `vt/render-scale-policy.js#resolveInternalScale` already applies on the
// read side.
import { SCALE_LADDER } from '../graph/index.js';

/** The three GLOBAL (not per-effect) setting keys. */
export const GLOBAL_SETTING_KEYS = Object.freeze({
  /** THE MASTER OFF-SWITCH (client) — Keyhole.md §4.3's "one legitimate switch":
   * MSA fully off, pure Foundry rendering, no proxies, no keyhole. Sits BEFORE
   * the cascade below, not inside it — a player who cannot get MSA working at
   * all has no use for a profile or a11y setting for an effect that isn't
   * running. `requiresReload` (see describeEffectSettings) because flipping it
   * live would mean tearing down or building the entire renderer on a settings
   * write — the reload is what makes that safe. See boot.js#startRealSceneViewer's
   * own read of this key, mirroring its existing "no art on this scene" branch.
   */
  msaEnabled: 'msaEnabled',
  /** The performance profile (client) — the games-industry front door (§2.1). */
  profile: 'performanceProfile',
  /** Accessibility: reduce photosensitive effects (client) — the hard override (§2). */
  reducePhotosensitive: 'reducePhotosensitiveEffects',
  /** Accessibility: reduced motion (client) — drives `html[data-reduce-motion]`,
   * which `ui/tokens.js`'s own injected CSS already has rules for (it also
   * already respects the OS-level `prefers-reduced-motion` media query for
   * free; this is the explicit, in-game opt-in on TOP of that, for a player
   * whose OS setting doesn't reflect what they want inside one game). */
  reducedMotion: 'reducedMotion',
  /** The LANTERN theme (client) — one of `ui/tokens.js#THEMES`. Drives
   * `html[data-theme]`, which every room's own injected CSS already keys off. */
  theme: 'uiTheme',
  /** RENDER-SCALE (client, 2026-08-27) — `'auto'` (the render-scale governor
   * decides, live, frame to frame) or a fixed rung matching one of
   * `SCALE_LADDER`'s own values as a string (e.g. `'0.75'`). See
   * `vt/render-scale-policy.js`'s own header for the present/internal
   * resolution split this feeds, and `MAX_PIXEL_RATIO`'s comment
   * (`vt-pan-viewer.js`) for the incident that made this a client-facing
   * setting in the first place: a per-player Foundry setting that could
   * tank a player's frame rate with zero involvement from MSA's own
   * judgment. A FIXED choice here makes the governor fully inert for that
   * player — a genuine promise, not a suggestion the governor can override —
   * while `MAX_PIXEL_RATIO` still protects them from Foundry's own opaque
   * value regardless of which mode they pick. */
  renderScale: 'renderScale',
});

/**
 * The per-effect enable setting key. Two per effect: the GM's table default
 * (`gm`, world-scoped) and the player's own override (`player`, client-scoped).
 * One convention, in one place, shared by registration AND read-back — so they
 * cannot drift (the drift that needed V2's ~140 sync functions).
 * @param {string} effectId
 * @param {'gm'|'player'} who
 * @returns {string}
 */
export function effectEnableKey(effectId, who) {
  return `${effectId}.${who}Enable`;
}

/** Title-case a lowercase token for a human-facing choice label ('low' → 'Low'). */
function titleCase(s) {
  const str = String(s ?? '');
  return str.length ? str[0].toUpperCase() + str.slice(1) : str;
}

/**
 * The render-scale setting's choices — DERIVED from `SCALE_LADDER`
 * (`graph/v3-perf.js`, the real ladder the governor steps through), never a
 * second, hand-typed list. `choiceLabels()`'s plain `titleCase` can't produce
 * "100% — Native"/"85%" from a bare numeric string, so this is its own small
 * builder rather than a `choiceLabels(SCALE_LADDER)` call.
 * @returns {Record<string, string>}
 */
export function renderScaleChoices() {
  const choices = { auto: 'Auto (recommended)' };
  SCALE_LADDER.forEach((scale, i) => {
    const pct = Math.round(scale * 100);
    const suffix = i === 0 ? ' — Native' : i === SCALE_LADDER.length - 1 ? ' — Lowest' : '';
    choices[String(scale)] = `${pct}%${suffix}`;
  });
  return choices;
}

/**
 * @typedef {object} SettingDescriptor
 * @property {string} key
 * @property {'client'|'world'} scope
 * @property {'enum'|'bool'} kind
 * @property {Record<string, string>} [choices] - for enum: Foundry's `{value: label}` map.
 * @property {unknown} default
 * @property {boolean} config - whether it appears in Foundry's Settings dialog.
 * @property {string} name
 * @property {string} hint
 * @property {boolean} [requiresReload] - Foundry prompts a reload when this commits
 *   (native Settings dialog only — a custom control still has to offer its own
 *   "reload to apply", see settings-panel.js). Reserved for settings a live
 *   re-resolve cannot safely apply (the master off-switch: flipping it live would
 *   mean tearing down or constructing the whole renderer mid-session).
 */

/**
 * Derive every setting the cascade needs from the registered manifests: two
 * global settings once, plus a GM-default + player-override enable per effect.
 * Pure — a plain array the adapter registers verbatim.
 *
 * @param {Array<{id: string, title?: string}>} [manifests]
 * @returns {SettingDescriptor[]}
 */
export function describeEffectSettings(manifests = []) {
  /** @type {SettingDescriptor[]} */
  const out = [
    {
      key: GLOBAL_SETTING_KEYS.msaEnabled,
      scope: 'client',
      kind: 'bool',
      default: true,
      config: true,
      requiresReload: true,
      name: 'Map Shine Advanced — Enable',
      hint:
        "Turn this off to use Foundry's own map rendering instead of Map Shine Advanced. Useful if it " +
        "isn't working well on your device — you always get a working game either way. Requires a reload.",
    },
    {
      key: GLOBAL_SETTING_KEYS.profile,
      scope: 'client',
      kind: 'enum',
      choices: choiceLabels(PERFORMANCE_PROFILES),
      default: DEFAULT_PERFORMANCE_PROFILE,
      config: true,
      name: 'Map Shine — Performance profile',
      hint: 'Overall graphics quality for YOUR machine. Higher looks better and costs more GPU. Individual effects can still be toggled below.',
    },
    {
      key: GLOBAL_SETTING_KEYS.renderScale,
      scope: 'client',
      kind: 'enum',
      choices: renderScaleChoices(),
      default: 'auto',
      config: true,
      name: 'Map Shine — Render resolution',
      hint: 'Auto lets Map Shine automatically balance sharpness against your frame rate — it can never be pushed higher than a safe ceiling, regardless of your own display or Foundry resolution setting. A fixed value locks the render resolution and turns automatic adjustment off.',
    },
    {
      key: GLOBAL_SETTING_KEYS.reducePhotosensitive,
      scope: 'client',
      kind: 'bool',
      default: false,
      config: true,
      name: 'Map Shine — Reduce photosensitive effects',
      hint: 'Turn off flashing / animated-light effects for photosensitivity. This wins over every other setting, including a GM forcing an effect on.',
    },
    {
      key: GLOBAL_SETTING_KEYS.reducedMotion,
      scope: 'client',
      kind: 'bool',
      default: false,
      config: true,
      name: 'Map Shine — Reduced motion',
      hint: "Turn off panel/UI transitions and sweeps (not the map's own effects — this is about the interface around it, not the scene).",
    },
    {
      key: GLOBAL_SETTING_KEYS.theme,
      scope: 'client',
      kind: 'enum',
      // Kept as a literal list rather than importing ui/tokens.js#THEMES —
      // effects/ has no door into ui/ (the dependency runs the other way,
      // same reasoning core/cues-schema.js's own header gives for not
      // importing world/). Four values, rarely added to; if THEMES ever
      // grows, update both.
      choices: choiceLabels(['dark', 'light', 'hc', 'soft']),
      default: 'dark',
      config: true,
      name: 'Map Shine — Theme',
      hint: 'The look of the Remote/Studio/Player panels themselves.',
    },
  ];

  for (const m of Array.isArray(manifests) ? manifests : []) {
    if (!m || typeof m.id !== 'string') continue;
    const title = m.title ?? m.id;
    out.push({
      key: effectEnableKey(m.id, 'gm'),
      scope: 'world',
      kind: 'enum',
      choices: choiceLabels(ENABLE_OVERRIDES),
      default: 'auto',
      config: true,
      name: `Map Shine — ${title}: table default (GM)`,
      hint: 'Auto = follow the performance profile. On/Off sets the default for all players at this table (each player can still override their own).',
    });
    out.push({
      key: effectEnableKey(m.id, 'player'),
      scope: 'client',
      kind: 'enum',
      choices: choiceLabels(ENABLE_OVERRIDES),
      default: 'auto',
      config: true,
      name: `Map Shine — ${title}: my setting`,
      hint: 'Auto = follow the table default / profile. On/Off is your final say — except that "reduce photosensitive effects" can still force it off.',
    });
  }

  return out;
}

/**
 * Human-facing labels for a descriptor's enum choices (`{value: label}`), the
 * shape Foundry's settings dialog wants. Kept beside the descriptor so the
 * adapter stays a dumb wrapper.
 * @param {string[]} choices
 * @returns {Record<string, string>}
 */
export function choiceLabels(choices = []) {
  const map = {};
  for (const c of choices) map[c] = titleCase(c);
  return map;
}

/**
 * Read the cascade layers for one effect back out of storage, via an injected
 * `readSetting(key)`. Pure (the Foundry read is the injected function), so the
 * key convention + layer shape is Node-tested against a fake store. A missing
 * value comes back `undefined`/`false`, which the resolver treats as its neutral
 * default — never a crash, never a silent disable (effect-cascade.js is total).
 *
 * @param {string} effectId
 * @param {(key: string) => unknown} readSetting
 * @returns {{profile: unknown, gmEnable: unknown, playerEnable: unknown, reducePhotosensitive: boolean}}
 */
export function deriveEffectLayers(effectId, readSetting) {
  const read = typeof readSetting === 'function' ? readSetting : () => undefined;
  return {
    profile: read(GLOBAL_SETTING_KEYS.profile),
    reducePhotosensitive: read(GLOBAL_SETTING_KEYS.reducePhotosensitive) === true,
    gmEnable: read(effectEnableKey(effectId, 'gm')),
    playerEnable: read(effectEnableKey(effectId, 'player')),
  };
}
