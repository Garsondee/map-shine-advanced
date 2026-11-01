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
  { id: 'dark', label: 'Darkness', icon: 'moon', help: 'How black unlit ground gets at night.' },
]);

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
  { key: 'night.darkness01', facet: 'dark', label: 'Night darkness', kind: 'number', min: 0, max: 1 },
]);

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
 * @typedef {{id: string, name: string, v: number, values: Record<string, number|string>}} Look
 */

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
  return {
    look: {
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      v: LOOK_SCHEMA_VERSION,
      values,
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
      else playable[key] = value;
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
export function captureLook({ id, name, facets, read }) {
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
  return { id, name: String(name ?? '').trim(), v: LOOK_SCHEMA_VERSION, values };
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
 * @returns {{looks: Look[], migrated: boolean}}
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
  return { looks, migrated };
}

/** The library as it is stored (a JSON string in a world setting). */
export function serializeLibrary(looks) {
  return JSON.stringify({ v: LOOK_SCHEMA_VERSION, looks });
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
  return { top: hex(top), bottom: hex(bottom) };
}

/**
 * The Looks a new world starts with, so the grid is never empty on day one.
 * Every one is written in channel terms and must reconcile with zero stale keys
 * (looks-schema.test.mjs) — the drift guard for built-ins. They are copied into
 * the library on first use, so a GM can rename, re-capture or delete them.
 * @type {ReadonlyArray<Look>}
 */
export const STARTER_LOOKS = Object.freeze([
  {
    id: 'starter-golden-afternoon',
    name: 'Golden afternoon',
    v: LOOK_SCHEMA_VERSION,
    values: { 'time.hour': 16.5, 'weather.archetype': 'fair-cumulus', 'wind.speed01': 0.15, 'sky.goldenHour01': 1 },
  },
  {
    id: 'starter-grey-morning',
    name: 'Grey morning',
    v: LOOK_SCHEMA_VERSION,
    values: { 'time.hour': 8, 'weather.archetype': 'overcast', 'wind.speed01': 0.2 },
  },
  {
    id: 'starter-fog-bank',
    name: 'Fog bank',
    v: LOOK_SCHEMA_VERSION,
    values: { 'weather.archetype': 'fog', 'wind.speed01': 0.02 },
  },
  {
    id: 'starter-storm',
    name: 'Storm',
    v: LOOK_SCHEMA_VERSION,
    values: { 'weather.archetype': 'thunderstorm', 'wind.speed01': 0.75, 'night.darkness01': 0.35 },
  },
  {
    id: 'starter-moonlit',
    name: 'Moonlit night',
    v: LOOK_SCHEMA_VERSION,
    values: {
      'time.hour': 23,
      'weather.archetype': 'clear',
      'sky.moonlight01': 0.8,
      'night.darkness01': 0.45,
    },
  },
  {
    id: 'starter-pitch-dark',
    name: 'Pitch dark',
    v: LOOK_SCHEMA_VERSION,
    values: { 'time.hour': 1.5, 'weather.archetype': 'overcast', 'sky.moonlight01': 0, 'night.darkness01': 0.95 },
  },
]);

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
