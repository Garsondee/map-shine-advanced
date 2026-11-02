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
  const settings = game.settings;
  const id = `${namespace}.${key}`;
  const reg = settings.settings instanceof Map ? settings.settings.get(id) : undefined;
  // Unregistered, or a host without the registry (a test double): Foundry's own answer, and its own loud error.
  if (reg === undefined) return settings.get(namespace, key);
  if (reg.scope === 'client') {
    const store = settings.storage?.get?.('client');
    if (typeof store?.getItem !== 'function') return settings.get(namespace, key);
    // Foundry's `get` is `new Setting({key, value: localStorage.getItem(id) ?? default}).value`: the raw string and the
    // default are its only inputs, so a hit on both is exactly the value it would build.
    const raw = store.getItem(id);
    const hit = readCache.get(id);
    if (hit !== undefined && hit.raw === raw && hit.def === reg.default) return hit.value;
    const value = settings.get(namespace, key);
    if (isPlainValue(value)) readCache.set(id, { raw, def: reg.default, value });
    else readCache.delete(id);
    return value;
  }
  // World / user scope: a saved Setting is a cheap lookup in Foundry's own `get`. An UNSAVED one builds a document per call.
  const store = settings.storage?.get?.(reg.scope);
  const user = reg.scope === 'user' ? game.userId : null;
  if (typeof store?.getSetting !== 'function' || store.getSetting(id, user)) return settings.get(namespace, key);
  const hit = readCache.get(id);
  if (hit !== undefined && hit.absent === true && hit.def === reg.default) return hit.value;
  const value = settings.get(namespace, key);
  if (isPlainValue(value)) readCache.set(id, { absent: true, def: reg.default, value });
  return value;
}

/**
 * THE READ CACHE (frame-rate round, 2026-11-02). Foundry v14's `game.settings.get` constructs a `Setting` DataModel
 * (clean + validate) on every call for a client-scope setting, and for a world setting nobody saved. The engine reads
 * settings from the frame loop, so a still Big Bank scene spent ~2% of its main thread building documents to read the same
 * few values (profile, leaf-shed profile, roof reveal radius). Only primitives are cached: for an object Foundry builds a
 * fresh copy per call and a shared one could be mutated by a caller. A stale value is not possible: a client setting is
 * re-checked against the raw localStorage string on every read, an unsaved world setting against "no document yet".
 * @type {Map<string, {raw?: string|null, absent?: boolean, def: unknown, value: unknown}>}
 */
const readCache = new Map();
const isPlainValue = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');

/**
 * Write a setting (persists per its scope: `client` = this browser, `world` =
 * the GM's world). Returns Foundry's set() promise. The registered `onChange`
 * fires when it commits, so callers do NOT also need to re-resolve by hand.
 * @param {string} namespace @param {string} key @param {unknown} value @returns {Promise<unknown>}
 */
export function writeSetting(namespace, key, value) {
  return game.settings.set(namespace, key, value);
}
