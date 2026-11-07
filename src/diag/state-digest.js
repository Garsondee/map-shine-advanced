/**
 * STATE DIGEST — one comparable fingerprint of "the world MSA is showing", per client
 * (mmp-f0k.2, the basis of the multiplayer parity suite mmp-463.2).
 *
 * WHY: two players looking at the same scene should see the same sky, the same time, the
 * same weather, the same lights. Comparing their SCREENSHOTS cannot say that cleanly: the
 * cameras differ, vision differs, render scale differs. Comparing the shared STATE can: if
 * the digests match, the clients agree on everything that must match; if they differ, the
 * digest says exactly which field.
 *
 * Split by what is ALLOWED to differ between users (mmp-463.1):
 *   shared    must match on every client (scene, level, world time, sun, darkness, weather
 *             axes and eased state, wind, cloud drift, light set, effects the GM enabled).
 *   perClient may differ (user, GM or not, performance profile, render scale, camera).
 * Only `shared` feeds the hash.
 *
 * Numbers are ROUNDED before hashing to a per-field grain, so float noise and a frame of
 * easing do not count as a mismatch while a real disagreement does. Cloud drift is
 * integrated per client from frame time, so it gets a coarse grain (a few world px).
 *
 * PURE: plain objects in, plain objects out. The live adapter that gathers the raw input
 * lives in boot.js (`MapShine.test.digest`).
 *
 * @module diag/state-digest
 */

/** Rounding grain per kind of number. */
export const DIGEST_GRAIN = Object.freeze({
  unit: 0.01, // 0..1 axes, darkness
  hour: 0.05, // time of day in hours (3 minutes)
  degrees: 0.5,
  px: 1,
  driftPx: 8,
  // Pixel-sized weather axes (cloud altitude/scale) ease over tens of seconds per client; a
  // client a frame behind is a few px off mid-ease, which is not a desync.
  weatherPx: 25,
  seconds: 1,
});

/** @param {unknown} v @param {number} grain @returns {number|null} */
export function roundTo(v, grain) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n / grain) * grain;
  // Fix the float tail (0.1 + 0.2 style) so the canonical JSON is stable.
  const decimals = Math.max(0, Math.ceil(-Math.log10(grain)));
  return Number(r.toFixed(decimals));
}

/**
 * Canonical JSON: object keys sorted at every depth, so two equal states always produce
 * the same string regardless of insertion order.
 * @param {unknown} v @returns {string}
 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit, hex. Not cryptographic: a fingerprint for equality, nothing more. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const unit = (v) => roundTo(v, DIGEST_GRAIN.unit);

/**
 * One light document, reduced to what decides how it looks. Sorted by id by the caller.
 * @param {object} l
 */
export function digestLight(l) {
  const c = l?.config ?? {};
  return {
    id: l?.id ?? null,
    x: roundTo(l?.x, DIGEST_GRAIN.px),
    y: roundTo(l?.y, DIGEST_GRAIN.px),
    hidden: l?.hidden === true,
    dim: roundTo(c.dim, 0.01),
    bright: roundTo(c.bright, 0.01),
    color: c.color ?? null,
    alpha: unit(c.alpha),
    luminosity: unit(c.luminosity),
    attenuation: unit(c.attenuation),
    animation: c.animation?.type ?? null,
  };
}

/** The 0..1 weather axes plus the pixel-sized cloud ones, rounded. */
function digestAxes(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== 'number') continue;
    out[k] = k.endsWith('Px') ? roundTo(v, DIGEST_GRAIN.weatherPx) : unit(v);
  }
  return out;
}

/**
 * Build the digest from a raw gather (see boot.js). Missing pieces come out as null, never
 * throw: a client whose viewer has not started still produces a digest that SAYS so.
 * @param {object} raw
 * @returns {{shared: object, perClient: object, hash: string}}
 */
export function buildStateDigest(raw = {}) {
  const env = raw.env ?? {};
  const sun = env.sun ?? {};
  const wind = env.wind ?? {};
  const w = raw.weather ?? {};
  const lights = Array.isArray(raw.lights) ? raw.lights.map(digestLight) : [];
  lights.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const effects = raw.effectsEnabled && typeof raw.effectsEnabled === 'object' ? { ...raw.effectsEnabled } : null;
  const shared = {
    msaVersion: raw.msaVersion ?? null,
    viewerStarted: raw.viewerStarted === true,
    sceneId: raw.sceneId ?? null,
    levelId: raw.levelId ?? null,
    worldTime: roundTo(raw.worldTime, DIGEST_GRAIN.seconds),
    paused: raw.paused ?? null,
    todHour: roundTo(env.time?.todHour ?? raw.todHour, DIGEST_GRAIN.hour),
    sun: {
      azimuthDeg: roundTo(sun.azimuthDeg, DIGEST_GRAIN.degrees),
      elevationDeg: roundTo(sun.elevationDeg, DIGEST_GRAIN.degrees),
    },
    darkness: unit(raw.darkness?.darkness01 ?? raw.darkness ?? env.darkness01),
    weather: {
      mode: w.mode ?? null,
      preset: w.preset ?? null,
      targets: digestAxes(w.targets),
      state: digestAxes(w.state),
    },
    wind: {
      directionDeg: roundTo(wind.directionDeg, DIGEST_GRAIN.degrees),
      speed01: unit(wind.speed01),
      gustiness01: unit(wind.gustiness01),
    },
    lights,
    effectsEnabled: effects,
    look: raw.look ?? null,
  };
  const perClient = {
    user: raw.user ?? null,
    isGM: raw.isGM ?? null,
    profile: raw.profile ?? null,
    renderScale: raw.renderScale ?? null,
    camera: raw.camera ?? null,
    // Per client BY DESIGN (Ingram, 2026-09-06: clouds are only an effect; each client drifts its own deck,
    // world/cloud-field.js header). Measured 2026-11-07: GM and players' decks sit at different offsets.
    cloudDrift: raw.cloudDrift
      ? { x: roundTo(raw.cloudDrift.x, DIGEST_GRAIN.driftPx), y: roundTo(raw.cloudDrift.y, DIGEST_GRAIN.driftPx) }
      : null,
  };
  return { shared, perClient, hash: fnv1a(canonicalJson(shared)) };
}

/**
 * Compare digests from several clients. Returns the dotted paths where `shared` differs,
 * with each client's value, so a mismatch report reads as a list of facts.
 * @param {Record<string, {shared: object}>} byClient
 * @returns {{match: boolean, differences: {path: string, values: Record<string, unknown>}[]}}
 */
export function compareDigests(byClient) {
  const names = Object.keys(byClient);
  const differences = [];
  const walk = (path, values) => {
    const firstJson = canonicalJson(values[names[0]]);
    if (names.every((n) => canonicalJson(values[n]) === firstJson)) return;
    const sample = values[names[0]];
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (names.every((n) => isObj(values[n]))) {
      const keys = new Set(names.flatMap((n) => Object.keys(values[n])));
      for (const k of [...keys].sort())
        walk(path ? `${path}.${k}` : k, Object.fromEntries(names.map((n) => [n, values[n][k]])));
      return;
    }
    void sample;
    differences.push({ path, values });
  };
  walk('', Object.fromEntries(names.map((n) => [n, byClient[n]?.shared ?? null])));
  return { match: differences.length === 0, differences };
}
