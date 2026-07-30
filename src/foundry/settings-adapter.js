/**
 * THE SETTINGS ADAPTER — the ONE place `game.settings` is touched.
 *
 * A thin, dumb wrapper: it registers/reads/writes whatever descriptors it is
 * handed and knows NOTHING about effects, the cascade, or the profile. That
 * domain logic lives in `effects/effect-settings.js` (pure, Node-tested); this
 * is the Foundry leaf that turns a descriptor into a `game.settings.register`
 * call and back. Keeping the split means the effects zone never imports Foundry
 * and this file never imports an effect — the inversion `legacy/foundry/` got
 * backwards (`canvas-replacement.js` importing `SpecularEffectV2` by name).
 *
 * `game.settings` appears NOWHERE else in `src/` — the `foundry/adapter-only`
 * wall makes that a build failure. This is the module that earns the exception,
 * and V2 is the reason it must be the only one: `legacy/settings/scene-settings
 * .js` hand-registered 44 settings AND imported effects + UI, and that coupling
 * is a third of what made V2 unpluggable (Effect-Registration.md §6).
 *
 * @module foundry/settings-adapter
 */

/**
 * Register a batch of settings under a module namespace. Idempotent per Foundry
 * (call once, in the `init` hook). Each descriptor's `onChange` is wired to the
 * shared callback with its own key, so a caller can re-resolve exactly what
 * changed.
 *
 * @param {string} namespace - the module id.
 * @param {Array<{key: string, scope: 'client'|'world', kind: 'enum'|'bool', choices?: Record<string,string>, default: unknown, config?: boolean, name?: string, hint?: string, requiresReload?: boolean}>} descriptors
 * @param {{onChange?: (key: string) => void}} [options]
 * @returns {void}
 */
export function registerSettings(namespace, descriptors, options = {}) {
  const onChange = typeof options?.onChange === 'function' ? options.onChange : null;
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    if (!d || typeof d.key !== 'string') continue;
    /** @type {Record<string, unknown>} */
    const data = {
      scope: d.scope === 'world' ? 'world' : 'client',
      config: d.config !== false,
      name: d.name ?? d.key,
      hint: d.hint ?? '',
      default: d.default,
      type: d.kind === 'bool' ? Boolean : String,
    };
    if (d.kind === 'enum' && d.choices && typeof d.choices === 'object') {
      data.choices = d.choices;
    }
    // Verified against the vendored v14 source (client-settings.mjs): Foundry's
    // OWN Settings dialog prompts a reload when a `requiresReload` setting
    // commits THROUGH ITS FORM. A write via `writeSetting` below (this module's
    // other export) does not go through that form, so a custom control still
    // has to offer its own "reload to apply" — this field only buys the free
    // prompt for whoever opens Foundry's native dialog instead.
    if (d.requiresReload === true) data.requiresReload = true;
    // Foundry fires this after the value is committed, so a read inside it sees
    // the new value — the caller re-resolves the cascade from truth, not a guess.
    if (onChange) data.onChange = () => onChange(d.key);
    game.settings.register(namespace, d.key, data);
  }
}

/**
 * Read a registered setting's current value. Throws (loudly) if the key was
 * never registered — that is a wiring bug (a read before `registerSettings`),
 * not something to paper over with a silent default the way V2 did.
 * @param {string} namespace @param {string} key @returns {unknown}
 */
export function readSetting(namespace, key) {
  return game.settings.get(namespace, key);
}

/**
 * Write a setting (persists per its scope: `client` = this browser, `world` =
 * the GM's world). Returns Foundry's set() promise. The registered `onChange`
 * fires when it commits, so callers do NOT also need to re-resolve by hand.
 * @param {string} namespace @param {string} key @param {unknown} value @returns {Promise<unknown>}
 */
export function writeSetting(namespace, key, value) {
  return game.settings.set(namespace, key, value);
}
