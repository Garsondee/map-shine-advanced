/**
 * THE LOOKS CONTRACT — a Look is one button that changes the whole feel of a
 * scene: time of day, weather, wind, light and darkness, faded from wherever the
 * scene is now to wherever the Look says, over the Remote's Fade Time
 * (author, 2026-11-01: "a single button to change the whole look of a scene and
 * fade it from the current settings to those settings is a very powerful thing").
 *
 * Looks replace the Remote's old mood chips + cue deck as ONE system: a world-wide
 * library (so "a general atmosphere" recorded on one map plays on every map), and
 * a per-scene running order (the GO button) that refers to Looks by id.
 *
 * ============================================================================
 * FACETS — WHY A LOOK CAN BE "TIME AGNOSTIC"
 * ============================================================================
 *
 * Every channel belongs to exactly one facet (time / weather / wind / light /
 * darkness). A Look stores values only for the facets it was saved with, and
 * playing it touches only those: a "Storm" saved without the Time facet plays at
 * whatever hour the scene is already at; a "Midnight" saved with only Time and
 * Darkness keeps the weather. The facets ARE the agnosticism — there is no
 * separate "agnostic" flag to keep in step with the values.
 *
 * ============================================================================
 * HOW LOOKS STAY IN STEP WITH THE ENGINE (the author's open question)
 * ============================================================================
 *
 * "If we add a new feature to an effect or remove a slider does our Looks system
 * become stale?" — answered by design, five ways, each enforced somewhere real:
 *
 *  1. A LOOK IS A DELTA, NOT A SNAPSHOT. It names only the channels it sets, and
 *     anything it does not name is left alone when it plays. A channel added to
 *     the engine later therefore cannot break an old Look — the old Look simply
 *     does not touch it — and every Look captured after that includes it,
 *     because capture walks {@link LOOK_CHANNELS}, never a hand-kept list.
 *  2. ONE CHANNEL TABLE. {@link LOOK_CHANNELS} is the only list of what a Look can
 *     hold. boot.js must supply a read/apply adapter for every entry, and
 *     `looks-schema.test.mjs` reads boot.js's adapter table and fails the build
 *     when a channel has no adapter (or an adapter has no channel). Adding a
 *     slider to Looks is one row here plus one adapter there — the test will not
 *     let the two disagree.
 *  3. RECONCILE ON EVERY PLAY. {@link reconcileLook} checks a stored Look against
 *     the live channel table: values are clamped into the channel's current
 *     range (a range that shrank cannot push garbage into the engine), a value of
 *     the wrong kind is skipped, and a key that no longer exists is reported as
 *     STALE — skipped, kept in storage (a module switched off for a session must
 *     not destroy anybody's Looks), and shown in Prep with a one-click Tidy.
 *  4. RENAMES ARE MIGRATIONS. A channel that is renamed gets one line in
 *     {@link LOOK_KEY_RENAMES}; {@link migrateLook} rewrites old keys on load and
 *     the stored schema version ({@link LOOK_SCHEMA_VERSION}) says which rules
 *     have run. Nothing ever has to re-save a Look by hand.
 *  5. BUILT-INS ARE TESTED AGAINST THE TABLE. {@link STARTER_LOOKS} must reconcile
 *     with zero stale keys and name only real weather archetypes — so removing a
 *     slider or a weather type fails the tests until the starters are updated.
 *
 * Pure: no Foundry, no DOM, no clock. Ids and live values come in as arguments
 * (the same "pure core, injected resolver" shape `cues-schema.js` uses).
 *
 * @module core/looks-schema
 */

/** Bump when a stored Look's SHAPE changes and add the rule to {@link migrateLook}. */
export const LOOK_SCHEMA_VERSION = 1;

/**
 * The facets, in the order the Remote shows them.
 * @type {ReadonlyArray<{id: string, label: string, icon: string, help: string}>}
 */
export const LOOK_FACETS = Object.freeze([
  { id: 'time', label: 'Time', icon: 'clock', help: 'The hour of day. Ignored while the World clock drives time.' },
  { id: 'weather', label: 'Weather', icon: 'cloud', help: 'The sky type, cloud, rain or snow, and temperature.' },
  { id: 'wind', label: 'Wind', icon: 'wind', help: 'How hard the wind blows, and from where.' },
  { id: 'light', label: 'Light', icon: 'sun', help: 'Sky light, golden hour, moonlight and atmosphere.' },
  {
    id: 'colour',
    label: 'Colour',
    icon: 'palette',
    help: 'The colour grade: exposure, contrast, saturation, warmth, and the styles — one colour, a tinted wash, a vignette.',
  },
  {
    id: 'lens',
    label: 'Lens',
    icon: 'camera',
    help: 'The camera: vignette, film grain, colour fringing and lens curvature.',
  },
  { id: 'dark', label: 'Darkness', icon: 'moon', help: 'How black unlit ground gets at night.' },
]);

/**
 * THE GROUPS (round 3, author: "display the buttons in groups that theme well together
 * or which make it easier for GMs to find a look quickly"). The Remote shows one group
 * at a time under a row of group chips. 'mine' is every Look a GM saved themselves.
 * @type {ReadonlyArray<{id: string, label: string, icon: string, help: string}>}
 */
export const LOOK_GROUPS = Object.freeze([
  { id: 'day', label: 'Day', icon: 'sun', help: 'Dawn to dusk, clear and bright.' },
  { id: 'night', label: 'Night', icon: 'moon', help: 'Twilight to the dead of night.' },
  { id: 'weather', label: 'Weather', icon: 'cloud', help: 'Rain, storm, snow, sand and ash, at any hour.' },
  { id: 'dread', label: 'Dread', icon: 'warn', help: 'Horror and menace: fog, plague, the eldritch, the infernal.' },
  { id: 'wonder', label: 'Wonder', icon: 'gem', help: 'Magic and the uncanny: fey, arcane, divine, dreams.' },
  { id: 'style', label: 'Style', icon: 'palette', help: 'Film styles: noir, one colour, an old photograph.' },
  { id: 'mine', label: 'Mine', icon: 'user', help: 'Looks you saved yourself.' },
]);

/** The group a Look belongs to ('mine' when it names none we know). @param {Look} look */
export function lookGroup(look) {
  return LOOK_GROUPS.some((g) => g.id === look?.group) ? look.group : 'mine';
}

/** Facet ids, for quick membership checks. */
export const LOOK_FACET_IDS = Object.freeze(LOOK_FACETS.map((f) => f.id));

/**
 * EVERY channel a Look can hold — the one list (see "one channel table" above).
 * `kind: 'number'` channels clamp into [min, max]; `wrap` channels (an hour, a
 * compass bearing) wrap instead. `kind: 'id'` channels hold a string id.
 * @type {ReadonlyArray<{key: string, facet: string, label: string, kind: 'number'|'id',
 *   min?: number, max?: number, wrap?: boolean}>}
 */
export const LOOK_CHANNELS = Object.freeze([
  { key: 'time.hour', facet: 'time', label: 'Hour', kind: 'number', min: 0, max: 24, wrap: true },
  { key: 'weather.archetype', facet: 'weather', label: 'Sky type', kind: 'id' },
  { key: 'weather.cloudCover01', facet: 'weather', label: 'Clouds', kind: 'number', min: 0, max: 1 },
  { key: 'weather.precip01', facet: 'weather', label: 'Rain', kind: 'number', min: 0, max: 1 },
  { key: 'weather.temperature01', facet: 'weather', label: 'Temperature', kind: 'number', min: 0, max: 1 },
  { key: 'wind.speed01', facet: 'wind', label: 'Wind', kind: 'number', min: 0, max: 1 },
  { key: 'wind.directionDeg', facet: 'wind', label: 'Wind direction', kind: 'number', min: 0, max: 360, wrap: true },
  { key: 'sky.realism01', facet: 'light', label: 'Sky light', kind: 'number', min: 0, max: 1 },
  { key: 'sky.goldenHour01', facet: 'light', label: 'Golden hour', kind: 'number', min: 0, max: 1 },
  { key: 'sky.moonlight01', facet: 'light', label: 'Moonlight', kind: 'number', min: 0, max: 1 },
  { key: 'sky.gradeEnvStrength', facet: 'light', label: 'Atmosphere', kind: 'number', min: 0, max: 1 },
  // THE LIGHT LOOK (2026-11-01) — the Colour Grade's Light group: CC for the lighting itself.
  { key: 'grade.lightLevel', facet: 'light', label: 'Light level', kind: 'number', min: 0, max: 2 },
  { key: 'grade.lightSaturation', facet: 'light', label: 'Light colour', kind: 'number', min: 0, max: 2 },
  { key: 'grade.lightTint', facet: 'light', label: 'Light tint', kind: 'color' },
  { key: 'grade.lightGlow', facet: 'light', label: 'Lamp glow', kind: 'number', min: 0, max: 2 },
  { key: 'grade.lightGlowDay', facet: 'light', label: 'Lamp glow in daylight', kind: 'number', min: 0, max: 1 },
  { key: 'grade.lightSoftness', facet: 'light', label: 'Light shape', kind: 'number', min: 0, max: 1 },
  // BLOOM (2026-11-01, author: "the key thing is actually around Bloom which may need
  // to be carefully changed per Look") — how bright a thing must be to glow, how hard
  // it glows, the wide haze, and the haze's colour.
  { key: 'bloom.threshold', facet: 'light', label: 'Glow from', kind: 'number', min: 0, max: 4 },
  { key: 'bloom.dayThreshold', facet: 'light', label: 'Glow from, in daylight', kind: 'number', min: 0, max: 3 },
  { key: 'bloom.strength', facet: 'light', label: 'Glow', kind: 'number', min: 0, max: 3 },
  { key: 'bloom.atmoStrength', facet: 'light', label: 'Haze', kind: 'number', min: 0, max: 3 },
  { key: 'bloom.atmoTint', facet: 'light', label: 'Haze colour', kind: 'color' },
  // THE COLOUR FACET (2026-11-01) — the artistic Colour Grade (effects/grade), whole frame.
  { key: 'grade.exposure', facet: 'colour', label: 'Exposure', kind: 'number', min: -3, max: 3 },
  { key: 'grade.exposureInside', facet: 'colour', label: 'Exposure: interiors', kind: 'number', min: -2, max: 2 },
  { key: 'grade.exposureOutside', facet: 'colour', label: 'Exposure: exteriors', kind: 'number', min: -2, max: 2 },
  { key: 'grade.contrast', facet: 'colour', label: 'Contrast', kind: 'number', min: 0.5, max: 2 },
  { key: 'grade.saturation', facet: 'colour', label: 'Saturation', kind: 'number', min: 0, max: 2 },
  { key: 'grade.temperature', facet: 'colour', label: 'Warmth', kind: 'number', min: -1, max: 1 },
  // Range control (author 2026-11-01: no crushed interiors, no blown-out whites):
  // a soft highlight roll-off and a floor under the shadows.
  {
    key: 'grade.toneMapping',
    facet: 'colour',
    label: 'Film response',
    kind: 'id',
    values: ['none', 'agx', 'aces', 'neutral', 'reinhard', 'cineon', 'rolloff'],
  },
  { key: 'grade.shadows', facet: 'colour', label: 'Shadow lift', kind: 'color' },
  { key: 'grade.highlights', facet: 'colour', label: 'Highlight tint', kind: 'color' },
  { key: 'grade.tint', facet: 'colour', label: 'Green / magenta', kind: 'number', min: -1, max: 1 },
  { key: 'grade.vibrance', facet: 'colour', label: 'Vibrance', kind: 'number', min: -1, max: 1 },
  { key: 'grade.spotAmount', facet: 'colour', label: 'One colour', kind: 'number', min: 0, max: 1 },
  { key: 'grade.spotHue', facet: 'colour', label: 'Colour kept', kind: 'number', min: 0, max: 360, wrap: true },
  { key: 'grade.spotWidth', facet: 'colour', label: 'Colour kept: width', kind: 'number', min: 10, max: 120 },
  { key: 'grade.colourise', facet: 'colour', label: 'Colourise', kind: 'number', min: 0, max: 1 },
  { key: 'grade.colouriseColor', facet: 'colour', label: 'Colourise tint', kind: 'color' },
  { key: 'grade.colouriseHold', facet: 'colour', label: 'Tint holds to', kind: 'number', min: 0.05, max: 1.5 },
  {
    key: 'grade.colouriseKeepLamps',
    facet: 'colour',
    label: 'Lamps keep their colour',
    kind: 'number',
    min: 0,
    max: 1,
  },
  { key: 'grade.vignette', facet: 'colour', label: 'Vignette', kind: 'number', min: 0, max: 1 },
  // THE LENS (round 3) — the Lens effect's camera character, per Look.
  { key: 'lens.vignetteIntensity', facet: 'lens', label: 'Lens vignette', kind: 'number', min: 0, max: 1 },
  { key: 'lens.vignetteSoftness', facet: 'lens', label: 'Vignette softness', kind: 'number', min: 0.02, max: 0.9 },
  { key: 'lens.grainAmount', facet: 'lens', label: 'Film grain', kind: 'number', min: 0, max: 0.15 },
  { key: 'lens.chromaticAmountPx', facet: 'lens', label: 'Colour fringing', kind: 'number', min: 0, max: 12 },
  { key: 'lens.distortion', facet: 'lens', label: 'Lens curvature', kind: 'number', min: -0.3, max: 0.3 },
  { key: 'night.darkness01', facet: 'dark', label: 'Night darkness', kind: 'number', min: 0, max: 1 },
]);

/** A colour channel's value: a 6-digit hex string. */
const HEX_RE = /^#[0-9a-f]{6}$/i;

const CHANNEL_BY_KEY = new Map(LOOK_CHANNELS.map((c) => [c.key, c]));

/** The channel declaration for a key, or undefined. */
export function lookChannel(key) {
  return CHANNEL_BY_KEY.get(key);
}

/**
 * Old key -> new key. One line per rename; {@link migrateLook} applies these on
 * every load, so a stored Look never needs re-saving by hand. Empty today.
 * @type {Readonly<Record<string, string>>}
 */
export const LOOK_KEY_RENAMES = Object.freeze({});

/** A sky type of 'custom' means "hand-set numbers", which the cloud/rain values carry instead. */
const CUSTOM_ARCHETYPE = 'custom';

/**
 * @typedef {{key: string, label: string}} LookOption - a value on a Look the GM can
 *   re-pick from {@link LOOK_PALETTE} with one click (the kept colour, the tint).
 * @typedef {{id: string, name: string, v: number, values: Record<string, number|string>,
 *   options?: LookOption[]}} Look
 */

/** Keep only well-formed options. @param {unknown} raw @returns {LookOption[]} */
function cleanOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => o && typeof o.key === 'string' && o.key.length > 0)
    .map((o) => ({ key: o.key, label: typeof o.label === 'string' && o.label ? o.label : 'Colour' }));
}

/**
 * Bring a stored Look up to the current shape: rename old keys, stamp the
 * schema version. Never throws; returns what it changed so a caller can decide
 * whether to write the library back.
 * @param {unknown} raw
 * @param {Readonly<Record<string, string>>} [renames]
 * @returns {{look: Look|null, changed: string[]}}
 */
export function migrateLook(raw, renames = LOOK_KEY_RENAMES) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { look: null, changed: [] };
  const changed = [];
  const values = {};
  for (const [key, value] of Object.entries(raw.values ?? {})) {
    const next = renames[key] ?? key;
    if (next !== key) changed.push(`${key} -> ${next}`);
    // A rename onto a key the Look ALSO already holds keeps the newer key's value.
    if (next !== key && Object.hasOwn(raw.values, next)) continue;
    values[next] = value;
  }
  const v = Number.isFinite(raw.v) ? raw.v : 0;
  if (v < LOOK_SCHEMA_VERSION) changed.push(`schema v${v} -> v${LOOK_SCHEMA_VERSION}`);
  const options = cleanOptions(raw.options).map((o) => ({ ...o, key: renames[o.key] ?? o.key }));
  return {
    look: {
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      v: LOOK_SCHEMA_VERSION,
      values,
      ...(options.length > 0 ? { options } : {}),
      ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    },
    changed,
  };
}

/** Wrap a number into [min, max). */
function wrapInto(value, min, max) {
  const span = max - min;
  return ((((value - min) % span) + span) % span) + min;
}

/**
 * Check a Look against the live channel table — what can play, what cannot and why.
 * See "reconcile on every play" in this module's header.
 * @param {Look} look
 * @param {{channels?: ReadonlyArray<object>, isKnownArchetype?: (id: string) => boolean}} [opts]
 * @returns {{playable: Record<string, number|string>, stale: string[], invalid: string[], facets: string[]}}
 *   `stale` = keys no channel declares any more; `invalid` = keys whose value is the wrong kind.
 */
export function reconcileLook(look, { channels = LOOK_CHANNELS, isKnownArchetype } = {}) {
  const byKey = channels === LOOK_CHANNELS ? CHANNEL_BY_KEY : new Map(channels.map((c) => [c.key, c]));
  const playable = {};
  const stale = [];
  const invalid = [];
  for (const [key, value] of Object.entries(look?.values ?? {})) {
    const channel = byKey.get(key);
    if (!channel) {
      stale.push(key);
      continue;
    }
    if (channel.kind === 'id') {
      if (typeof value !== 'string' || value.length === 0) invalid.push(key);
      else if (key === 'weather.archetype' && isKnownArchetype && !isKnownArchetype(value)) invalid.push(key);
      else if (Array.isArray(channel.values) && !channel.values.includes(value)) invalid.push(key);
      else playable[key] = value;
      continue;
    }
    if (channel.kind === 'color') {
      if (typeof value === 'string' && HEX_RE.test(value)) playable[key] = value.toLowerCase();
      else invalid.push(key);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      invalid.push(key);
      continue;
    }
    playable[key] = channel.wrap
      ? wrapInto(value, channel.min, channel.max)
      : Math.min(channel.max, Math.max(channel.min, value));
  }
  // A named sky type already decides cloud and rain; a Look holding both would ask
  // the engine for two different skies at once. The sky type wins.
  if (typeof playable['weather.archetype'] === 'string') {
    delete playable['weather.cloudCover01'];
    delete playable['weather.precip01'];
  }
  const facets = LOOK_FACET_IDS.filter((f) => Object.keys(playable).some((k) => byKey.get(k)?.facet === f));
  return { playable, stale, invalid, facets };
}

/**
 * The facets a stored Look covers (whatever its keys belong to today).
 * @param {Look} look @returns {string[]}
 */
export function lookFacets(look) {
  return reconcileLook(look).facets;
}

/**
 * Validate the parts of a Look that are not channel values.
 * @param {Look} look @returns {{ok: boolean, errors: string[]}}
 */
export function validateLook(look) {
  const errors = [];
  if (!look || typeof look !== 'object') return { ok: false, errors: ['a look must be an object'] };
  if (typeof look.id !== 'string' || look.id.length === 0) errors.push('needs a stable, non-empty id');
  if (typeof look.name !== 'string' || look.name.trim().length === 0) errors.push('needs a name');
  if (!look.values || typeof look.values !== 'object' || Object.keys(look.values).length === 0) {
    errors.push('needs at least one value — a look that changes nothing is not a look');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * "Capture-then-name": read the live value of every channel in the chosen
 * facets. A channel whose reader returns nothing usable is left out (so a Look
 * saved on a client with no wind still saves its weather).
 * @param {{id: string, name: string, facets: string[], read: (key: string) => unknown}} args
 * @returns {Look}
 */
export function captureLook({ id, name, facets, read, group = 'mine' }) {
  const wanted = new Set(facets ?? LOOK_FACET_IDS);
  const values = {};
  for (const channel of LOOK_CHANNELS) {
    if (!wanted.has(channel.facet)) continue;
    let value;
    try {
      value = read(channel.key);
    } catch (_) {
      value = undefined;
    }
    if (channel.kind === 'id') {
      if (typeof value === 'string' && value.length > 0) values[channel.key] = value;
    } else if (channel.kind === 'color') {
      if (typeof value === 'string' && HEX_RE.test(value)) values[channel.key] = value.toLowerCase();
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      values[channel.key] = Math.round(value * 1000) / 1000;
    }
  }
  // A hand-set sky is described by its numbers; a named one by its id alone.
  if (values['weather.archetype'] === CUSTOM_ARCHETYPE) delete values['weather.archetype'];
  if (typeof values['weather.archetype'] === 'string') {
    delete values['weather.cloudCover01'];
    delete values['weather.precip01'];
  }
  // A captured style keeps its one-click colour button: a GM who saved a
  // one-colour or tinted look can re-pick the colour from the tile, like a starter.
  const options = [];
  if ((values['grade.spotAmount'] ?? 0) > 0.05) options.push({ key: 'grade.spotHue', label: 'Colour kept' });
  if ((values['grade.colourise'] ?? 0) > 0.05) options.push({ key: 'grade.colouriseColor', label: 'Tint' });
  return {
    id,
    name: String(name ?? '').trim(),
    v: LOOK_SCHEMA_VERSION,
    values,
    ...(options.length > 0 ? { options } : {}),
    group,
  };
}

/**
 * Keep only the chosen facets of a Look (the "Facets" editor on a tile).
 * @param {Look} look @param {string[]} facets @returns {Look}
 */
export function withFacets(look, facets) {
  const keep = new Set(facets);
  const values = {};
  for (const [key, value] of Object.entries(look.values ?? {})) {
    const channel = CHANNEL_BY_KEY.get(key);
    // A stale key is not ours to drop here — only Tidy removes those.
    if (!channel || keep.has(channel.facet)) values[key] = value;
  }
  return { ...look, values };
}

/**
 * Drop the stale keys of a Look (Prep's Tidy button).
 * @param {Look} look @returns {Look}
 */
export function tidyLook(look) {
  const values = {};
  for (const [key, value] of Object.entries(look.values ?? {})) if (CHANNEL_BY_KEY.has(key)) values[key] = value;
  return { ...look, values };
}

/**
 * Split a reconciled Look into what to apply now and what to skip — the one
 * place the "World clock owns the hour" rule lives.
 * @param {Look} look
 * @param {{worldClock?: boolean, isKnownArchetype?: (id: string) => boolean}} [opts]
 * @returns {{apply: Array<{key: string, value: number|string}>, skipped: Array<{key: string, reason: string}>}}
 */
export function planLookApply(look, { worldClock = false, isKnownArchetype } = {}) {
  const { playable, stale, invalid } = reconcileLook(look, { isKnownArchetype });
  const apply = [];
  const skipped = [];
  for (const key of stale) skipped.push({ key, reason: 'this setting no longer exists' });
  for (const key of invalid) skipped.push({ key, reason: 'the saved value is not usable' });
  for (const channel of LOOK_CHANNELS) {
    if (!Object.hasOwn(playable, channel.key)) continue;
    if (channel.facet === 'time' && worldClock) {
      skipped.push({ key: channel.key, reason: 'the World clock owns the hour — switch to Free clock to set it' });
      continue;
    }
    apply.push({ key: channel.key, value: playable[channel.key] });
  }
  return { apply, skipped };
}

/**
 * Normalise whatever is stored in the library setting into a clean list.
 * Accepts the JSON string, the parsed object, or a bare array (older drafts);
 * drops entries without an id, de-duplicates ids, and migrates every Look.
 * @param {unknown} raw
 * @returns {{looks: Look[], migrated: boolean, starters: number}} `starters` — which
 *   starter set this library was last brought up to (see {@link upgradeStarters}).
 */
export function normalizeLibrary(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.looks) ? parsed.looks : [];
  const seen = new Set();
  const looks = [];
  let migrated = false;
  for (const entry of list) {
    const { look, changed } = migrateLook(entry);
    if (!look || look.id.length === 0 || seen.has(look.id)) {
      migrated = true;
      continue;
    }
    if (changed.length > 0) migrated = true;
    seen.add(look.id);
    looks.push(look);
  }
  const starters = Number.isFinite(parsed?.starters) ? parsed.starters : 1;
  return { looks, migrated, starters };
}

/** The library as it is stored (a JSON string in a world setting). */
export function serializeLibrary(looks, starters = STARTER_SET_VERSION) {
  return JSON.stringify({ v: LOOK_SCHEMA_VERSION, starters, looks });
}

// ---- options: a small, safe amount of GM configuration on a Look ----------------------

/**
 * The colours a Look's option button offers — hand-picked to read well as a kept
 * colour, a tinted wash and a blood moon alike. `hue` is the hex's own hue on the
 * same opponent axes the grade shader measures (see {@link hexHue}).
 * @type {ReadonlyArray<{id: string, label: string, hex: string}>}
 */
export const LOOK_PALETTE = Object.freeze([
  { id: 'blood', label: 'Blood', hex: '#d0101c' },
  { id: 'ember', label: 'Ember', hex: '#f0921a' },
  { id: 'gold', label: 'Gold', hex: '#e2b128' },
  { id: 'venom', label: 'Venom', hex: '#47b83a' },
  { id: 'spectral', label: 'Spectral', hex: '#22b8c9' },
  { id: 'sapphire', label: 'Sapphire', hex: '#2f5fd6' },
  { id: 'witchlight', label: 'Witchlight', hex: '#8e46d8' },
  { id: 'rose', label: 'Rose', hex: '#d8408f' },
  { id: 'sepia', label: 'Sepia', hex: '#b5864f' },
]);

/** A hex colour's hue in degrees, measured the way the grade shader measures a pixel
 * (opponent axes, in linear light), so a picked swatch keeps exactly that colour. */
export function hexHue(hexColor) {
  const n = parseInt(String(hexColor).slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2));
  const a = lin[0] - 0.5 * (lin[1] + lin[2]);
  const b = 0.8660254 * (lin[1] - lin[2]);
  return Math.round((((Math.atan2(b, a) * 180) / Math.PI + 360) % 360) * 10) / 10;
}

/** The options a Look offers whose key is still a live channel. @param {Look} look */
export function lookOptions(look) {
  return cleanOptions(look?.options).filter((o) => CHANNEL_BY_KEY.has(o.key));
}

/**
 * Which palette entry an option currently shows (the nearest one), or null.
 * @param {Look} look @param {string} key @returns {string|null} a {@link LOOK_PALETTE} id
 */
export function optionPaletteId(look, key) {
  const value = look?.values?.[key];
  const channel = CHANNEL_BY_KEY.get(key);
  if (value === undefined || !channel) return null;
  if (channel.kind === 'color') return LOOK_PALETTE.find((p) => p.hex === String(value).toLowerCase())?.id ?? null;
  let best = null;
  let bestD = Infinity;
  for (const p of LOOK_PALETTE) {
    const d = Math.abs(((((hexHue(p.hex) - Number(value)) % 360) + 540) % 360) - 180);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return bestD <= 12 ? best : null;
}

/**
 * Set one option of a Look to a palette colour: a hue channel takes the colour's
 * hue, a colour channel its hex. Returns a NEW Look; an unknown option or colour
 * returns the Look unchanged.
 * @param {Look} look @param {string} key @param {string} paletteId @returns {Look}
 */
export function setLookOption(look, key, paletteId) {
  const swatch = LOOK_PALETTE.find((p) => p.id === paletteId);
  const channel = CHANNEL_BY_KEY.get(key);
  if (!swatch || !channel || !lookOptions(look).some((o) => o.key === key)) return look;
  const value = channel.kind === 'color' ? swatch.hex : hexHue(swatch.hex);
  return { ...look, values: { ...look.values, [key]: value } };
}

// ---- presentation helpers (pure, so the preview harness and tests share them) ----

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

/** "14:00", "06:30". */
export function formatHour(hour) {
  const h = wrapInto(hour, 0, 24);
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  const hh = minutes === 60 ? (whole + 1) % 24 : whole;
  const mm = minutes === 60 ? 0 : minutes;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * A short line for a tile's tooltip: "16:30 · Fair · wind 20% · dark 60%".
 * @param {Look} look @param {(id: string) => string|undefined} [archetypeLabel]
 */
export function describeLook(look, archetypeLabel) {
  const { playable } = reconcileLook(look);
  const parts = [];
  if (Number.isFinite(playable['time.hour'])) parts.push(formatHour(playable['time.hour']));
  if (typeof playable['weather.archetype'] === 'string') {
    parts.push(archetypeLabel?.(playable['weather.archetype']) ?? playable['weather.archetype']);
  } else if (Number.isFinite(playable['weather.cloudCover01'])) {
    parts.push(`cloud ${pct(playable['weather.cloudCover01'])}`);
    if ((playable['weather.precip01'] ?? 0) > 0.02) parts.push(`rain ${pct(playable['weather.precip01'])}`);
  }
  if (Number.isFinite(playable['wind.speed01'])) parts.push(`wind ${pct(playable['wind.speed01'])}`);
  if (Number.isFinite(playable['night.darkness01'])) parts.push(`dark ${pct(playable['night.darkness01'])}`);
  if ((playable['grade.spotAmount'] ?? 0) > 0.05) parts.push('one colour');
  else if ((playable['grade.colourise'] ?? 0) > 0.05) parts.push('tinted');
  else if (playable['grade.saturation'] !== undefined && playable['grade.saturation'] < 0.1)
    parts.push('black & white');
  return parts.length > 0 ? parts.join(' · ') : 'Light only';
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}
function hex(rgb) {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** Sky colours through the day, [hour, top, bottom]. */
const SKY_STOPS = [
  [0, [16, 22, 46], [8, 10, 22]],
  [5, [52, 50, 92], [24, 26, 48]],
  [6.5, [236, 160, 112], [120, 92, 120]],
  [9, [120, 176, 228], [86, 132, 190]],
  [14, [110, 170, 230], [80, 128, 192]],
  [17.5, [244, 196, 120], [196, 120, 92]],
  [19.5, [120, 84, 128], [52, 44, 82]],
  [21, [30, 36, 72], [14, 16, 34]],
  [24, [16, 22, 46], [8, 10, 22]],
];

function skyAt(hour) {
  const h = wrapInto(hour, 0, 24);
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [h0, t0, b0] = SKY_STOPS[i];
    const [h1, t1, b1] = SKY_STOPS[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return [mix(t0, t1, t), mix(b0, b1, t)];
    }
  }
  return [SKY_STOPS[0][1], SKY_STOPS[0][2]];
}

/**
 * Two colours for a Look's tile — its own little sky, so a row of Looks reads at
 * a glance. Time sets the hue; cloud and rain grey it; darkness sinks it. A Look
 * with no Time facet gets a neutral slate sky (it plays at whatever hour it is).
 * @param {Look} look @param {{cloudOf?: (archetypeId: string) => number|undefined}} [opts]
 * @returns {{top: string, bottom: string}}
 */
export function lookSwatch(look, { cloudOf } = {}) {
  const { playable } = reconcileLook(look);
  let [top, bottom] = Number.isFinite(playable['time.hour'])
    ? skyAt(playable['time.hour'])
    : [
        [92, 104, 128],
        [52, 60, 78],
      ];
  const archetype = playable['weather.archetype'];
  const cloud = typeof archetype === 'string' ? (cloudOf?.(archetype) ?? 0.4) : (playable['weather.cloudCover01'] ?? 0);
  const rain = playable['weather.precip01'] ?? 0;
  const grey = Math.min(1, cloud * 0.7 + rain * 0.4);
  const greyTop = [(top[0] + top[1] + top[2]) / 3, (top[0] + top[1] + top[2]) / 3, (top[0] + top[1] + top[2]) / 3 + 6];
  const greyBottom = [
    (bottom[0] + bottom[1] + bottom[2]) / 3,
    (bottom[0] + bottom[1] + bottom[2]) / 3,
    (bottom[0] + bottom[1] + bottom[2]) / 3 + 6,
  ];
  top = mix(top, greyTop, grey * 0.8);
  bottom = mix(bottom, greyBottom, grey * 0.8);
  const dark = playable['night.darkness01'] ?? 0;
  top = mix(top, [4, 5, 10], dark * 0.45);
  bottom = mix(bottom, [2, 2, 6], dark * 0.6);
  // The Colour facet shows on the tile too: black & white drains it, a tinted wash
  // washes it, one colour keeps a band of that colour across the middle.
  const lum = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  const sat = playable['grade.saturation'];
  if (sat !== undefined && sat < 1) {
    top = mix([lum(top), lum(top), lum(top)], top, Math.max(0, sat));
    bottom = mix([lum(bottom), lum(bottom), lum(bottom)], bottom, Math.max(0, sat));
  }
  const wash = playable['grade.colourise'] ?? 0;
  if (wash > 0 && typeof playable['grade.colouriseColor'] === 'string') {
    const n = parseInt(playable['grade.colouriseColor'].slice(1), 16);
    const tc = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const peak = Math.max(1, ...tc);
    const tint = (c) => {
      const v = Math.max(...c) * 1.2;
      return tc.map((x) => (x / peak) * v);
    };
    top = mix(top, tint(top), wash);
    bottom = mix(bottom, tint(bottom), wash);
  }
  let band = null;
  if ((playable['grade.spotAmount'] ?? 0) > 0.05) {
    top = [lum(top), lum(top), lum(top)];
    bottom = [lum(bottom), lum(bottom), lum(bottom)];
    const hue = Number(playable['grade.spotHue'] ?? 0);
    band = `hsl(${Math.round(hue)}, 85%, 45%)`;
  }
  return { top: hex(top), bottom: hex(bottom), band };
}

/** The light model's shipped values, which every starter returns to (tests pin them to the params). */
export const LOOK_REST_GLOW_DAY = 0.25;
export const LOOK_REST_SOFTNESS = 1;

/**
 * A full Colour facet: the grade at neutral with `o` on top (keys without the
 * 'grade.' prefix). Every starter carries one, so moving from a styled Look
 * (Noir, Blood fog) to a natural one always lifts the style off again.
 * @param {Record<string, number|string>} [o]
 */
function colour(o = {}) {
  // Every starter rolls its highlights off (neutral) and keeps a small floor under
  // its shadows, so no Look blows lamps out or crushes interiors to black.
  const base = {
    exposure: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    vibrance: 0,
    // round 3 (2026-11-01): the highlight roll-off, not the Khronos neutral curve — neutral
    // bleached hot orange lamp cores to pink-white under the soft light shape; roll-off keeps
    // their colour and burns them toward yellow-white the way film does
    toneMapping: 'rolloff',
    shadows: '#262626',
    highlights: '#ffffff',
    tint: 0,
  };
  const styles = { spotAmount: 0, colourise: 0, colouriseKeepLamps: 0, vignette: 0 };
  // ...and the light look at rest, so white lamps or a tint never outlive their Look.
  // (lightGlowDay / lightSoftness at their shipped defaults: grade.js, point-light-illumination.js)
  const light = {
    lightLevel: 1,
    lightSaturation: 1,
    lightTint: '#ffffff',
    lightGlow: 1,
    lightGlowDay: LOOK_REST_GLOW_DAY,
    lightSoftness: LOOK_REST_SOFTNESS,
  };
  Object.assign(base, light, { exposureInside: 0, exposureOutside: 0 });
  // Bloom keys are written `glow*` here (glowFrom/glow/haze/hazeTint) and land on the
  // 'bloom.' channels; its at-rest values are the bloom effect's own shipped defaults.
  const bloom = { threshold: 0.51, dayThreshold: 1.1, strength: 0.96, atmoStrength: 0.43, atmoTint: '#fff0dc' };
  const glowKeys = {
    glowFrom: 'threshold',
    glowDay: 'dayThreshold',
    glow: 'strength',
    haze: 'atmoStrength',
    hazeTint: 'atmoTint',
  };
  const out = {};
  const rest = {};
  for (const [k, v] of Object.entries(o)) {
    if (glowKeys[k]) bloom[glowKeys[k]] = v;
    else rest[k] = v;
  }
  for (const [k, v] of Object.entries({ ...base, ...styles, ...rest })) out[`grade.${k}`] = v;
  for (const [k, v] of Object.entries(bloom)) out[`bloom.${k}`] = v;
  // The lens at its shipped defaults unless the Look says otherwise (keys lens*).
  const lens = {
    vignetteIntensity: 1,
    vignetteSoftness: 0.02,
    grainAmount: 0.003,
    chromaticAmountPx: 1.2,
    distortion: -0.1,
  };
  const lensKeys = {
    lensVignette: 'vignetteIntensity',
    lensSoftness: 'vignetteSoftness',
    grain: 'grainAmount',
    fringe: 'chromaticAmountPx',
    curve: 'distortion',
  };
  for (const [k, v] of Object.entries(o)) if (lensKeys[k]) lens[lensKeys[k]] = v;
  for (const k of Object.keys(lensKeys)) delete out[`grade.${k}`];
  for (const [k, v] of Object.entries(lens)) out[`lens.${k}`] = v;
  return out;
}

/** Which group each starter shows under (see LOOK_GROUPS). */
const STARTER_GROUPS = Object.freeze({
  'first-light': 'day',
  'bright-morning': 'day',
  'high-noon': 'day',
  'golden-hour': 'day',
  celestial: 'wonder',
  feywild: 'wonder',
  'blue-hour': 'night',
  'moonlit-night': 'night',
  'pitch-black': 'night',
  'blood-moon': 'night',
  drizzle: 'weather',
  thunderstorm: 'weather',
  blizzard: 'weather',
  ashfall: 'weather',
  sandstorm: 'weather',
  frozen: 'weather',
  'blood-fog': 'dread',
  haunted: 'dread',
  plague: 'dread',
  eldritch: 'dread',
  crypt: 'dread',
  ashen: 'dread',
  infernal: 'dread',
  arcane: 'wonder',
  underdark: 'wonder',
  dreamlike: 'wonder',
  noir: 'style',
  'one-colour': 'style',
  'old-photograph': 'style',
  vivid: 'style',
});

/** One starter: id, name, values, optional options. */
function starter(id, name, values, options) {
  return Object.freeze({
    id: `look-${id}`,
    name,
    v: LOOK_SCHEMA_VERSION,
    values,
    group: STARTER_GROUPS[id] ?? 'mine',
    ...(options ? { options } : {}),
  });
}

/**
 * THE STARTER SET (2026-11-01, round 2 — author: "double the number of looks ...
 * accurate, interesting and covers the full spectrum of time, style and weather").
 * Four rows of four on the Remote, the last cell being Save look:
 *
 *   the day       First light · Bright morning · High noon · Golden hour
 *   the night     Blue hour · Moonlit night · Pitch black · Blood moon
 *   the weather   Drizzle · Thunderstorm · Blizzard · Ashfall
 *   the styles    Blood fog · Noir · One colour · [Save look]
 *
 * The weather and style rows carry no hour, so they play at whatever time the
 * scene is at. Each starter is written in channel terms and must reconcile with
 * zero stale keys and real weather types (looks-schema.test.mjs). Values follow the
 * real thing: dawn is cool and misty with little wind; noon is hot, still and hard
 * shadowed; golden hour is low warm sun under high wisps; blue hour is the cool
 * glow after sunset; a blizzard is freezing, gale-driven and bright; ashfall is a
 * hot, dim, ochre volcanic sky. Blood fog is the author's red-fog reference: dense
 * fog, the frame washed blood red right up to the lights, which alone burn white.
 * @type {ReadonlyArray<Look>}
 */
export const STARTER_LOOKS = Object.freeze([
  // ---- the day ----
  starter('first-light', 'First light', {
    'time.hour': 6.2,
    'weather.archetype': 'fog',
    'weather.temperature01': 0.35,
    'wind.speed01': 0.03,
    'sky.goldenHour01': 0.8,
    ...colour({
      exposureInside: 0.4,
      haze: 0.35,
      exposure: -0.1,
      temperature: -0.18,
      saturation: 0.85,
      contrast: 0.94,
      vignette: 0.1,
      lightTint: '#e2e6ff',
    }),
    'night.darkness01': 0.15,
  }),
  starter('bright-morning', 'Bright morning', {
    'time.hour': 9,
    'weather.archetype': 'fair-cumulus',
    'weather.temperature01': 0.5,
    'wind.speed01': 0.2,
    ...colour({
      exposureInside: 0.3,
      exposureOutside: -0.1,
      glowFrom: 0.75,
      glow: 0.7,
      haze: 0.22,
      exposure: 0,
      contrast: 1.06,
      saturation: 0.98,
      temperature: -0.06,
      vibrance: 0.12,
    }),
  }),
  starter('high-noon', 'High noon', {
    'time.hour': 12.75,
    'weather.archetype': 'clear',
    // hot, but under the Temperature effect's heat-shimmer cast (0.75): the lab showed
    // 0.9 + a warm grade blowing the whole map out to yellow
    'weather.temperature01': 0.66,
    'wind.speed01': 0.04,
    ...colour({
      exposureInside: 0.25,
      exposureOutside: -0.3,
      glowFrom: 0.95,
      glow: 0.55,
      haze: 0.15,
      hazeTint: '#fff6e8',
      exposure: 0,
      contrast: 1.1,
      saturation: 0.95,
      temperature: -0.04,
    }),
  }),
  starter('golden-hour', 'Golden hour', {
    'time.hour': 17.6,
    'weather.archetype': 'streaks',
    'weather.temperature01': 0.6,
    'wind.speed01': 0.12,
    'sky.goldenHour01': 1,
    ...colour({
      exposureInside: 0.45,
      exposureOutside: -0.15,
      glowFrom: 0.7,
      glow: 0.8,
      haze: 0.3,
      hazeTint: '#ffd9ae',
      contrast: 1.05,
      exposure: -0.1,
      saturation: 1.0,
      temperature: 0.14,
      vibrance: 0.1,
      vignette: 0.15,
      lightTint: '#ffe8c8',
    }),
  }),
  // ---- the night ----
  starter('blue-hour', 'Blue hour', {
    'time.hour': 19.9,
    'weather.archetype': 'clear',
    'weather.temperature01': 0.42,
    'wind.speed01': 0.05,
    ...colour({
      exposureInside: 0.3,
      lightLevel: 0.8,
      haze: 0.5,
      hazeTint: '#c8d4ff',
      shadows: '#283044',
      temperature: -0.3,
      saturation: 0.9,
      vibrance: 0.1,
      vignette: 0.15,
    }),
    'night.darkness01': 0.2,
  }),
  starter('moonlit-night', 'Moonlit night', {
    'time.hour': 23.5,
    'weather.archetype': 'clear',
    'weather.temperature01': 0.35,
    'wind.speed01': 0.08,
    'sky.moonlight01': 0.9,
    ...colour({
      exposureInside: 0.3,
      haze: 0.45,
      hazeTint: '#c4d2ff',
      shadows: '#2a3044',
      exposure: 0.2,
      temperature: -0.3,
      saturation: 0.75,
      contrast: 1.05,
      vignette: 0.2,
      lightTint: '#bcd0ff',
      lightGlow: 0.8,
    }),
    // dark enough to need a torch, light enough to read the yard by moonlight
    'night.darkness01': 0.15,
  }),
  starter('pitch-black', 'Pitch black', {
    'time.hour': 2,
    'weather.archetype': 'overcast',
    'weather.temperature01': 0.3,
    'wind.speed01': 0.06,
    'sky.moonlight01': 0,
    ...colour({
      // round 3 lab: under the soft light shape the street lamps pooled peach-white and the
      // docks read brighter than a pitch-black night should (mean 111) — dimmer lamps
      exposureInside: 0.6,
      exposureOutside: 0,
      glow: 1.1,
      haze: 0.55,
      shadows: '#3c3c4e',
      saturation: 0.6,
      contrast: 1.1,
      vignette: 0.35,
      lightLevel: 0.65,
    }),
    'night.darkness01': 0.35,
  }),
  starter(
    'blood-moon',
    'Blood moon',
    {
      'time.hour': 0.5,
      'weather.archetype': 'clear',
      'wind.speed01': 0.04,
      'sky.moonlight01': 0.9,
      ...colour({
        // round 3 lab: interiors 51-78% near-black under the soft light shape — lift them
        exposureInside: 1.4,
        exposureOutside: 0.3,
        lightLevel: 0.85,
        haze: 0.6,
        hazeTint: '#ff9a8a',
        shadows: '#7c2830',
        contrast: 1.1,
        colourise: 0.75,
        colouriseColor: '#d0101c',
        colouriseHold: 0.5,
        vignette: 0.3,
        lightTint: '#ffb4aa',
      }),
      'night.darkness01': 0.2,
    },
    [{ key: 'grade.colouriseColor', label: 'Moon colour' }]
  ),
  // ---- the weather (no hour: they play at whatever time it is) ----
  starter('drizzle', 'Drizzle', {
    'weather.archetype': 'drizzle',
    'weather.temperature01': 0.45,
    'wind.speed01': 0.3,
    ...colour({ exposureInside: 0.35, glowFrom: 0.7, haze: 0.3, saturation: 0.8, contrast: 0.95, temperature: -0.1 }),
  }),
  starter('thunderstorm', 'Thunderstorm', {
    'weather.archetype': 'thunderstorm',
    'weather.temperature01': 0.5,
    'wind.speed01': 0.8,
    ...colour({
      exposureInside: 0.7,
      glowFrom: 0.7,
      haze: 0.3,
      saturation: 0.7,
      contrast: 1.08,
      shadows: '#2e2e34',
      temperature: -0.15,
      vignette: 0.25,
    }),
    'night.darkness01': 0.2,
  }),
  starter('blizzard', 'Blizzard', {
    'weather.archetype': 'snow',
    'weather.temperature01': 0.03,
    'wind.speed01': 0.9,
    ...colour({
      exposureInside: 0.3,
      exposureOutside: -0.15,
      glowFrom: 0.8,
      haze: 0.35,
      hazeTint: '#eef4ff',
      exposure: 0.15,
      contrast: 0.9,
      saturation: 0.7,
      temperature: -0.35,
      lightTint: '#e6f0ff',
    }),
  }),
  starter('ashfall', 'Ashfall', {
    'weather.archetype': 'ashfall',
    'weather.temperature01': 0.75,
    'wind.speed01': 0.35,
    ...colour({
      exposureInside: 0.7,
      haze: 0.45,
      hazeTint: '#ffc890',
      exposure: -0.2,
      contrast: 1.1,
      colourise: 0.45,
      colouriseColor: '#c0843a',
      colouriseHold: 0.6,
      vignette: 0.35,
      lightTint: '#ffc890',
    }),
    'night.darkness01': 0.15,
  }),
  // ---- the styles ----
  starter(
    'blood-fog',
    'Blood fog',
    {
      // An afternoon hour: the reference is a BRIGHT red world, which needs daylight
      // in the fog for the red to have anything to colour (at night it is just black).
      'time.hour': 16,
      'weather.archetype': 'fog',
      'wind.speed01': 0.04,
      ...colour({
        // round 3 lab: interiors 22-32% near-black on Docklands / Snowbound — deep red, not black
        exposureInside: 1.4,
        haze: 0.7,
        hazeTint: '#ff5050',
        shadows: '#9a3036',
        exposure: 0.25,
        contrast: 1.12,
        colourise: 1,
        colouriseColor: '#d0101c',
        colouriseHold: 1.2,
        colouriseKeepLamps: 0.4,
        vignette: 0.3,
        // the reference's one white lamp: every light burns clean white
        lightSaturation: 0,
        lightGlow: 0.4,
        lightLevel: 1.1,
      }),
      'night.darkness01': 0.2,
    },
    [{ key: 'grade.colouriseColor', label: 'Fog colour' }]
  ),
  starter(
    'noir',
    'Noir',
    colour({
      exposureInside: 0.35,
      exposureOutside: -0.15,
      glowFrom: 0.7,
      haze: 0.2,
      toneMapping: 'aces',
      shadows: '#4c4c4c',
      saturation: 0,
      contrast: 1.2,
      exposure: -0.05,
      vignette: 0.45,
      lightSaturation: 0,
      lightGlow: 0,
    })
  ),
  starter(
    'one-colour',
    'One colour',
    colour({
      exposureInside: 0.35,
      exposureOutside: -0.2,
      glowFrom: 0.8,
      haze: 0.2,
      spotAmount: 1,
      spotHue: hexHue('#d0101c'),
      spotWidth: 24,
      contrast: 1.05,
      shadows: '#303030',
      vignette: 0.2,
    }),
    [{ key: 'grade.spotHue', label: 'Colour kept' }]
  ),
  // ==== ROUND 3 (2026-11-01, author: "double the number of looks ... a wonderful wide
  // range of possible moods and themes", shown in groups). First drafts; every one is
  // refined in the Look lab across four maps, three spots each. ====
  // ---- weather, more ----
  starter('sandstorm', 'Sandstorm', {
    'weather.archetype': 'gale',
    'weather.temperature01': 0.72,
    'wind.speed01': 0.9,
    ...colour({
      colourise: 0.4,
      colouriseColor: '#d8a050',
      colouriseHold: 0.7,
      saturation: 0.75,
      exposure: 0.1,
      contrast: 0.92,
      shadows: '#3a2a18',
      exposureInside: 0.4,
      glowFrom: 0.5,
      haze: 1,
      hazeTint: '#e8b070',
      grain: 0.04,
      fringe: 2,
    }),
  }),
  starter('frozen', 'Frozen', {
    'time.hour': 10,
    'weather.archetype': 'clear',
    'weather.temperature01': 0.02,
    'wind.speed01': 0.15,
    ...colour({
      temperature: -0.45,
      saturation: 0.8,
      exposure: 0,
      highlights: '#e8f4ff',
      shadows: '#1a2a40',
      contrast: 1.05,
      exposureInside: 0.4,
      exposureOutside: -0.1,
      lightTint: '#d8ecff',
      glowFrom: 0.6,
      haze: 0.6,
      hazeTint: '#cfe6ff',
    }),
  }),
  // ---- dread ----
  starter('haunted', 'Haunted', {
    'time.hour': 21.5,
    'weather.archetype': 'fog',
    'wind.speed01': 0.05,
    ...colour({
      saturation: 0.45,
      temperature: -0.35,
      tint: -0.15,
      shadows: '#1e3a3a',
      highlights: '#d8f0ec',
      contrast: 1.1,
      exposureInside: 0.5,
      lightSaturation: 0.4,
      lightTint: '#bfe8e0',
      lightLevel: 0.9,
      glow: 1.1,
      haze: 0.6,
      hazeTint: '#a8e0d8',
      lensSoftness: 0.45,
      grain: 0.03,
      fringe: 2.5,
    }),
    'night.darkness01': 0.25,
  }),
  starter(
    'plague',
    'Plague',
    {
      'weather.archetype': 'overcast',
      'wind.speed01': 0.1,
      ...colour({
        colourise: 0.35,
        colouriseColor: '#9aa03a',
        colouriseHold: 0.5,
        saturation: 0.6,
        tint: -0.3,
        temperature: 0.15,
        contrast: 1.05,
        shadows: '#2a2c14',
        exposureInside: 0.45,
        lightTint: '#d8e0a0',
        haze: 0.5,
        hazeTint: '#c8d080',
        grain: 0.04,
        fringe: 2,
      }),
      'night.darkness01': 0.2,
    },
    [{ key: 'grade.colouriseColor', label: 'Sickness colour' }]
  ),
  starter('eldritch', 'Eldritch', {
    'time.hour': 23,
    'weather.archetype': 'overcast',
    'wind.speed01': 0.2,
    'sky.moonlight01': 0.5,
    ...colour({
      shadows: '#2a1438',
      highlights: '#a0ffe8',
      saturation: 0.8,
      contrast: 1.15,
      temperature: -0.2,
      // round 3 lab: interiors unreadable (mean 28) — white the lamps before the tint, lift
      exposure: 0.1,
      exposureInside: 0.6,
      exposureOutside: 0.3,
      lightTint: '#c0a8ff',
      lightSaturation: 0.35,
      lightGlow: 1,
      glow: 0.9,
      haze: 0.5,
      hazeTint: '#7a50ff',
      fringe: 5,
      curve: -0.2,
      grain: 0.02,
      lensSoftness: 0.4,
    }),
    'night.darkness01': 0.3,
  }),
  starter('crypt', 'Crypt', {
    ...colour({
      saturation: 0.5,
      temperature: -0.4,
      contrast: 1.15,
      exposureInside: 0.35,
      shadows: '#1a2230',
      vignette: 0.4,
      lightLevel: 0.8,
      lightTint: '#d0dcff',
      lightSaturation: 0.6,
      haze: 0.3,
      grain: 0.025,
      lensSoftness: 0.35,
    }),
    'night.darkness01': 0.4,
  }),
  starter('ashen', 'Ashen', {
    'weather.archetype': 'ashfall',
    'weather.temperature01': 0.3,
    'wind.speed01': 0.08,
    ...colour({
      saturation: 0.15,
      contrast: 0.9,
      exposure: 0.2,
      shadows: '#3a3a3a',
      temperature: -0.05,
      colourise: 0.2,
      colouriseColor: '#bbb2a0',
      colouriseHold: 0.8,
      exposureInside: 0.4,
      lightSaturation: 0.2,
      glowFrom: 0.4,
      haze: 0.9,
      hazeTint: '#e0dcd4',
      grain: 0.05,
      lensSoftness: 0.6,
    }),
    'night.darkness01': 0.1,
  }),
  starter(
    'infernal',
    'Infernal',
    {
      'weather.archetype': 'ashfall',
      'weather.temperature01': 0.95,
      'wind.speed01': 0.3,
      ...colour({
        colourise: 0.55,
        colouriseColor: '#ff4a12',
        colouriseHold: 0.6,
        contrast: 1.2,
        // round 3 lab: Snowbound's fortress interior 45-58% near-black — lift it
        shadows: '#4a1608',
        exposureInside: 0.9,
        lightTint: '#ffb070',
        lightGlow: 1.4,
        glowFrom: 0.4,
        glow: 1.4,
        haze: 1,
        hazeTint: '#ff6a20',
        fringe: 3,
        grain: 0.02,
      }),
      'night.darkness01': 0.15,
    },
    [{ key: 'grade.colouriseColor', label: 'Fire colour' }]
  ),
  // ---- wonder ----
  starter('feywild', 'Feywild', {
    'time.hour': 16.8,
    'weather.archetype': 'fair-cumulus',
    'weather.temperature01': 0.62,
    'wind.speed01': 0.12,
    'sky.goldenHour01': 1,
    ...colour({
      saturation: 1.35,
      vibrance: 0.45,
      tint: 0.15,
      temperature: 0.05,
      shadows: '#2a1a40',
      highlights: '#ffe8ff',
      contrast: 1.05,
      exposureInside: 0.45,
      lightSaturation: 1.5,
      lightTint: '#ffd8ff',
      glowFrom: 0.45,
      glow: 1.4,
      haze: 0.9,
      hazeTint: '#ffb0f0',
      fringe: 2.5,
      lensSoftness: 0.5,
      lensVignette: 0.8,
    }),
  }),
  starter(
    'arcane',
    'Arcane',
    {
      'time.hour': 21,
      'weather.archetype': 'clear',
      'sky.moonlight01': 0.6,
      ...colour({
        saturation: 0.9,
        temperature: -0.15,
        shadows: '#1a1040',
        highlights: '#d8c8ff',
        contrast: 1.1,
        // round 3 lab (2026-11-01): a violet tint over saturated orange lamps multiplied them
        // to black (Docklands 99.8% near-black) — white the lamps first, then tint them
        exposure: 0.3,
        exposureInside: 0.8,
        exposureOutside: 0.5,
        lightTint: '#c0aaff',
        lightSaturation: 0.25,
        lightGlow: 1.1,
        glowFrom: 0.4,
        glow: 1,
        haze: 0.6,
        hazeTint: '#8a6aff',
        fringe: 4,
      }),
      'night.darkness01': 0.25,
    },
    [{ key: 'grade.lightTint', label: 'Magic colour' }]
  ),
  starter('celestial', 'Celestial', {
    'time.hour': 11.5,
    'weather.archetype': 'high-veil',
    'weather.temperature01': 0.55,
    'sky.goldenHour01': 0.6,
    ...colour({
      exposure: 0,
      saturation: 1.05,
      temperature: 0.15,
      highlights: '#fff4d0',
      shadows: '#2a2420',
      contrast: 0.95,
      exposureInside: 0.2,
      lightTint: '#fff0c8',
      lightLevel: 1.15,
      glowFrom: 0.5,
      glow: 1.6,
      haze: 1.2,
      hazeTint: '#fff0b0',
      lensSoftness: 0.7,
      lensVignette: 0.6,
      fringe: 1.5,
    }),
  }),
  starter('underdark', 'Underdark', {
    'time.hour': 1,
    'weather.archetype': 'overcast',
    'sky.moonlight01': 0,
    ...colour({
      saturation: 1.2,
      temperature: -0.3,
      tint: -0.1,
      shadows: '#081820',
      exposureInside: 0.5,
      contrast: 1.1,
      // round 3 lab: teal over orange lamps went to a flat teal void (mean 28) — white the
      // lamps, then tint; lift the floor so caverns read
      lightTint: '#80ffe0',
      lightSaturation: 0.25,
      lightGlow: 1.1,
      lightLevel: 0.95,
      exposure: 0.15,
      exposureOutside: 0.75,
      glowFrom: 0.35,
      glow: 1.6,
      haze: 1.1,
      hazeTint: '#40e0c0',
      fringe: 3,
    }),
    'night.darkness01': 0.3,
  }),
  starter('dreamlike', 'Dreamlike', {
    'weather.archetype': 'high-veil',
    ...colour({
      exposure: 0.05,
      contrast: 0.82,
      saturation: 0.85,
      vibrance: 0.15,
      temperature: 0.05,
      shadows: '#3a3048',
      highlights: '#fff0f8',
      exposureInside: 0.15,
      lightSaturation: 0.8,
      glowFrom: 0.35,
      glow: 1.5,
      haze: 1.4,
      hazeTint: '#ffe0f0',
      lensSoftness: 0.8,
      lensVignette: 0.7,
      fringe: 3.5,
      curve: -0.15,
    }),
  }),
  // ---- style ----
  starter(
    'old-photograph',
    'Old photograph',
    colour({
      colourise: 0.9,
      colouriseColor: '#b5864f',
      colouriseHold: 0.6,
      contrast: 1.15,
      exposure: 0.05,
      vignette: 0.3,
      shadows: '#2a2018',
      exposureInside: 0.15,
      lightSaturation: 0,
      glow: 0.6,
      haze: 0.3,
      hazeTint: '#e0c8a0',
      grain: 0.09,
      lensSoftness: 0.35,
      curve: -0.15,
      fringe: 0.5,
    }),
    [{ key: 'grade.colouriseColor', label: 'Print tone' }]
  ),
  starter(
    'vivid',
    'Storybook',
    colour({
      saturation: 1.35,
      vibrance: 0.4,
      contrast: 1.12,
      exposure: 0.05,
      exposureInside: 0.35,
      lightSaturation: 1.3,
      grain: 0,
      fringe: 0,
      lensSoftness: 0.3,
      lensVignette: 0.5,
    })
  ),
]);

/** Bump when {@link STARTER_LOOKS} is replaced; {@link upgradeStarters} brings a stored library up once. */
export const STARTER_SET_VERSION = 3;

/** Starter ids of earlier sets, retired by {@link upgradeStarters}. */
export const RETIRED_STARTER_IDS = Object.freeze([
  'starter-golden-afternoon',
  'starter-grey-morning',
  'starter-fog-bank',
  'starter-storm',
  'starter-moonlit',
  'starter-pitch-dark',
]);

/**
 * Bring a stored library up to the current starter set, ONCE: drop the retired
 * starters, put the current ones first (in their designed order), keep every Look
 * the GM made. A library already at {@link STARTER_SET_VERSION} is returned as is,
 * so a starter the GM deleted afterwards never comes back.
 * @param {Look[]} looks @param {number} from @returns {{looks: Look[], changed: boolean}}
 */
export function upgradeStarters(looks, from) {
  if (from >= STARTER_SET_VERSION) return { looks, changed: false };
  const retired = new Set(RETIRED_STARTER_IDS);
  const stored = new Map(looks.map((l) => [l.id, l]));
  const starterIds = new Set(STARTER_LOOKS.map((l) => l.id));
  // Every current starter, in its designed order, as the code has it now (a starter
  // carries the lab's latest tuning) — but a colour the GM picked on its option
  // button is kept: that choice was theirs.
  const fresh = STARTER_LOOKS.map((l) => {
    const copy = structuredCloneLook(l);
    const old = stored.get(l.id);
    if (old)
      for (const o of lookOptions(copy)) if (old.values?.[o.key] !== undefined) copy.values[o.key] = old.values[o.key];
    return copy;
  });
  const mine = looks.filter((l) => !retired.has(l.id) && !starterIds.has(l.id));
  return { looks: [...fresh, ...mine], changed: true };
}

/** A mutable copy of a (frozen) Look. */
export function structuredCloneLook(look) {
  return {
    ...look,
    values: { ...look.values },
    ...(look.options ? { options: look.options.map((o) => ({ ...o })) } : {}),
  };
}

/**
 * Which of the library's Looks a running-order entry points at, in order; ids
 * that no longer exist are skipped (a deleted Look must not break GO).
 * @param {string[]} sequence @param {Look[]} looks @returns {Look[]}
 */
export function resolveSequence(sequence, looks) {
  const byId = new Map(looks.map((l) => [l.id, l]));
  return (Array.isArray(sequence) ? sequence : []).map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Turn an old scene's cue stack (core/cues-schema.js) into Looks, once, so the
 * GM's staged cues are not lost when the Remote moves to Looks. A cue's fade
 * keys that a Look also knows are kept; anything else is dropped (a cue could
 * only ever hold the weather axes, so in practice nothing is).
 * @param {Array<{id: string, name: string, order: number, targets: Record<string, {to: unknown}>}>} cues
 * @returns {{looks: Look[], sequence: string[]}}
 */
export function looksFromCues(cues) {
  const ordered = [...(Array.isArray(cues) ? cues : [])].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
  const looks = [];
  for (const cue of ordered) {
    if (!cue || typeof cue.id !== 'string') continue;
    const values = {};
    for (const [key, target] of Object.entries(cue.targets ?? {})) {
      if (CHANNEL_BY_KEY.has(key) && typeof target?.to === 'number' && Number.isFinite(target.to)) {
        values[key] = target.to;
      }
    }
    if (Object.keys(values).length === 0) continue;
    looks.push({
      id: `look-from-${cue.id}`,
      name: typeof cue.name === 'string' && cue.name ? cue.name : 'Cue',
      v: LOOK_SCHEMA_VERSION,
      values,
    });
  }
  return { looks, sequence: looks.map((l) => l.id) };
}
