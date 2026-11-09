/**
 * tools/lab/interiors-claims.mjs — what Lab · Interiors & Regions SHOULD show, written down before measuring
 * (mmp-78u "expectations first"; Ingram 2026-11-08: "Build a wide set of expectations and then compare what
 * you find"). The prose, sources and conflicts are tools/lab/claims/interiors-regions.md (IR-01..IR-62); this
 * file is the same claims as checks against the scene interiors-spec.mjs builds. Where the scene's geometry
 * differs from the plot the prose imagined, the check follows the scene and the claim carries a `note`.
 *
 * SOURCES, most trusted first: foundry (v14 source, resources/app/...), msa (a module declaration: header,
 * param help, guide page), author (Ingram's rants, by date), physics. `cite` keeps the prose's citation.
 *
 * NUMBERS. Foundry's ambient ladder: daylight 0xEE = 0.933, darkness 0x30 = 0.188; at darkness d and Night
 * fader r, A(d) = 0.933 (1 - d) + 0.188 (1 - r) d (client/config.mjs:641-642, environment.mjs:218; MSA
 * environmental-light.js:98-122). Lamp ladder: bright 1.0, dim A + 0.25 (1 - A) (environment.mjs:221-228).
 * MSA's darkness by the clock: d = 1 - smoothstep((elevation + 18) / 18), elevation 60 cos(2 pi (h - 12) / 24)
 * (world/sun.js computeSun; the prose's linear 18:35 ~ 0.5 is corrected to the smoothstep: d = 0.500 at
 * 18.575). Probe `illum` is Foundry-space light (saturates at 1.0, excludes coloration); `presented` is the
 * screen byte. The composite is gamma-space (FRICTION #22).
 *
 * CONDITIONS. Each claim names the conditions it is measured under; lab-check (interiors-check.mjs) sets
 * each condition on the lab scene (hour via MapShine.setTimeOfDay, sky/wind flags, scene darkness, Global
 * Illumination, Night fader, transient effect overrides) and restores everything after.
 *
 * THE REGION DARKNESS OVERRIDE. MSA has a world setting (regionDarknessOverrideEnabled; ON by default when this
 * was measured, value 0.9 on the rig; the manager decided 2026-11-09 that it defaults OFF from now on, mmp-6pc.3)
 * that REWRITES every darkening behaviour of the viewed scene to OVERRIDE <value> on view
 * (src/foundry/region-darkness-override.js). With it on, the lab's authored modes cannot survive a view, so
 * the region-math claims are measured with it OFF (the checker switches it off on the private rig if needed
 * and repairs the lab Regions from the spec), and IR-63 measures the override itself, switched on just for it.
 *
 * Pure: data and small functions, no IO.
 *
 * @module tools/lab/interiors-claims
 */
import { interiorsGroups, interiorsScene } from './interiors-spec.mjs';
import { IDS } from './lab-spec.mjs';
import { WALLS_IDS } from './walls-spec.mjs';

// --------------------------------------------------------------------------------------------- model
export const DAYLIGHT = 0xee / 255;
export const DARKNESS = 0x30 / 255;
/** Foundry's ambient at darkness d with MSA's Night fader r. */
export const ambientAt = (d, r = 0) => DAYLIGHT * (1 - d) + DARKNESS * (1 - r) * d;
/** Foundry's dim lamp colour over that ambient. */
export const dimAt = (d, r = 0) => {
  const A = ambientAt(d, r);
  return A + 0.25 * (1 - A);
};
const smooth01 = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
export const elevationAt = (h) => 60 * Math.cos((2 * Math.PI * (h - 12)) / 24);
/** MSA's darkness at hour h (world/sun.js skyFactor01, world/environment.js). */
export const darknessAt = (h) => 1 - smooth01((elevationAt(h) + 18) / 18);
/** Foundry's three modes (adjust-darkness-level.mjs:29-44). */
export function adjust(d, mode, m) {
  if (mode === 0) return m;
  if (mode === 1) return d * (1 - m);
  if (mode === 2) return 1 - (1 - d) * (1 - m);
  return d;
}
/** Normal CDF, for MSA's Gaussian region edge (sigma 7.5 px). */
export function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p =
    0.3989423 *
    Math.exp((-x * x) / 2) *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
export const EDGE_SIGMA = 7.5;

// --------------------------------------------------------------------------------------------- conditions
/** The hour at which MSA's darkness is 0.500 (elevation -9 deg on the lab's 60 deg sun). */
export const HALF_DARK_HOUR = 18.575;

/**
 * Every condition the claims need, in run order. `hour` is applied with MapShine.setTimeOfDay; `sky`/`wind`
 * patch the lab scene's own flags; `env` patches the scene's environment by document update (lab scene only);
 * `realism` is MapShine.setDarknessRealism; `force` are transient forceEffect overrides; `level` views another
 * floor; `samples`/`intervalMs` read each point several times; `series` reads presented N times quickly;
 * `strike` forces a lightning strike at a scene point and reads during the flash; `edit` updates one lab
 * Region's modifier; `override` switches MSA's Region darkness override ON for the measurement; `external`
 * marks groups in other lab scenes; `settleMs` waits longer than the default 3 s after applying (weather).
 */
export const CONDITIONS = Object.freeze([
  { key: 'noon', hour: 12 },
  { key: 'noShadow', hour: 12, force: { sunShadows: false } },
  { key: 'upper', hour: 12, level: 'upper' },
  { key: 'basement', hour: 12, level: 'basement' },
  { key: 'edit', hour: 12, edit: { region: 'R1.b', modifier: 0.2, waitMs: 2000 } },
  { key: 'sceneD05', hour: 12, env: { darknessLevel: 0.5 } },
  { key: 'sceneD1', hour: 12, env: { darknessLevel: 1 } },
  // `live`: MSA's world clock only runs while Foundry is unpaused, and the lab world sits paused; these
  // conditions unpause this client for their reads (clouds drift, rain falls, the storm steps).
  {
    key: 'cloud',
    hour: 12,
    sky: { cloudCover01: 0.7 },
    wind: { speed01: 0.5 },
    samples: 4,
    intervalMs: 7000,
    settleMs: 8000,
    live: true,
  },
  {
    key: 'basementCloud',
    hour: 12,
    level: 'basement',
    sky: { cloudCover01: 0.7 },
    wind: { speed01: 0.5 },
    samples: 3,
    intervalMs: 7000,
    settleMs: 8000,
    live: true,
  },
  // rain spawns over several seconds (the drop field is built in a worker): give it time before the series
  { key: 'rain', hour: 12, sky: { precip01: 1 }, wind: { speed01: 0.3 }, series: 40, settleMs: 15000, live: true },
  { key: 'golden', hour: 17.75 },
  { key: 'basementGolden', hour: 17.75, level: 'basement' },
  { key: 'sunset', hour: 18 },
  { key: 'half', hour: HALF_DARK_HOUR },
  { key: 'dusk', hour: 19.5 },
  { key: 'duskMoonOff', hour: 19.5, sky: { moonlight01: 0 } },
  { key: 'night', hour: 0 },
  { key: 'nightMoonOff', hour: 0, sky: { moonlight01: 0 } },
  { key: 'nightR1', hour: 0, sky: { moonlight01: 0 }, realism: 1 },
  {
    key: 'strike',
    hour: 0,
    sky: { moonlight01: 0 },
    strike: { group: 'R3', point: 'dk.open', reads: 16 },
    live: true,
  },
  {
    key: 'giDim',
    hour: 0,
    sky: { moonlight01: 0 },
    env: { globalLight: { enabled: true, bright: false, luminosity: 0.5, darkness: { min: 0, max: 1 } } },
  },
  {
    key: 'giBright',
    hour: 0,
    sky: { moonlight01: 0 },
    env: { globalLight: { enabled: true, bright: true, luminosity: 0.5, darkness: { min: 0, max: 1 } } },
  },
  { key: 'external', hour: 12, force: { sunShadows: false }, external: true },
  { key: 'override', hour: 12, override: true },
]);
export const CONDITION = Object.fromEntries(CONDITIONS.map((c) => [c.key, c]));
/** MSA darkness a condition sets on open ground (scene darkness folds in as max). */
export const conditionDarkness = (c) => Math.max(darknessAt(c.hour ?? 12), c.env?.darknessLevel ?? 0);

/**
 * Probe groups in OTHER lab scenes (IR-16: the fade width must not depend on the region field's size).
 * Effects C3's west edge (a small field, 4 px texels) and the walls lab's top Region edge (a 12900 px field).
 */
export const EXTERNAL_GROUPS = Object.freeze({
  'X.C3edge': {
    key: 'X.C3edge',
    sceneId: IDS.effectsScene,
    levelId: IDS.levelGround,
    cx: 3200,
    cy: 700,
    scale: 2,
    pts: [-30, -20, -10, -5, 0, 5, 10, 20, 30]
      .map((d) => ({ name: `e${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, x: 3150 + d, y: 750 }))
      .concat([
        { name: 'in', x: 3280, y: 750 },
        { name: 'out', x: 3020, y: 750 },
      ]),
  },
  'X.wallsEdge': {
    key: 'X.wallsEdge',
    sceneId: WALLS_IDS.scene,
    levelId: WALLS_IDS.level,
    cx: 800,
    cy: 150,
    scale: 2,
    pts: [-30, -20, -10, -5, 0, 5, 10, 20, 30]
      .map((d) => ({ name: `e${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, x: 750, y: 150 + d }))
      .concat([
        // 230, not deeper: the cell's lampNear (630, 600) reaches 360 px, and (750, 280) is 342 px from it
        { name: 'in', x: 750, y: 230 },
        { name: 'out', x: 750, y: 110 },
      ]),
  },
});

/** Every group a claim can name: the scene's own plus the external ones. */
export function allGroups() {
  return { ...interiorsGroups(), ...EXTERNAL_GROUPS };
}

/** The spec's darkness behaviours per lab Region key, for repairing what the override rewrote. */
export function specRegionBehaviours() {
  const out = {};
  for (const r of interiorsScene('x').regions) {
    const key = r.flags['map-shine-advanced'].lab.replace(/^region:/, '');
    out[key] = r.behaviors.map((b) => ({
      type: b.type,
      mode: b.system?.mode ?? null,
      modifier: b.system?.modifier ?? null,
      disabled: b.disabled === true,
    }));
  }
  return out;
}

// --------------------------------------------------------------------------------------------- reading
const mean3 = (a) => (Array.isArray(a) && a.length >= 3 ? (a[0] + a[1] + a[2]) / 3 : NaN);
export const ill = (r) => mean3(r?.illum);
const greyness = (r) => (Array.isArray(r?.illum) ? Math.max(...r.illum) - Math.min(...r.illum) : NaN);
const fdk = (r) => (Number.isFinite(r?.foundry?.darkness) ? r.foundry.darkness : NaN);
const pres = (r) => mean3(r?.presented);
const toSrgb = (lin) => {
  const c = Math.max(0, Math.min(1, lin));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};
/**
 * Foundry light emitters at the point. Probe v2.1 lists only emitters in `lights` (FRICTION #31); runs saved
 * before it also carried MSA's vision-only door lights and the global light there, so those are still dropped.
 */
const lamps = (r) => (r?.foundry?.lights ?? []).filter((l) => !/^(msa-vision|globalLight)/.test(String(l.id)));
/** Foundry's global light covers the point: probe v2.1 files it in `otherSources`; runs saved before it, in `lights`. */
const hasGlobal = (r) => {
  const f = r?.foundry;
  if (Array.isArray(f?.otherSources)) return f.otherSources.some((s) => s.kind === 'globalLight');
  return (f?.lights ?? []).some((l) => /global/i.test(`${l.id} ${l.kind}`));
};
const seriesOf = (r, key = 'illum') => (r?.series ?? []).map((s) => mean3(s?.[key])).filter(Number.isFinite);
const range = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : NaN);

const f3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : String(v));
const res = (pass, got, want) => ({ pass: Boolean(pass), got: String(got), want: String(want) });
const every = (...rs) => ({
  pass: rs.every((r) => r.pass),
  got: rs.map((r) => r.got).join('; '),
  want: rs.map((r) => r.want).join('; '),
});
const approx = (label, v, t, tol) => res(Math.abs(v - t) <= tol, `${label} ${f3(v)}`, `${label} ${f3(t)}±${tol}`);
const atMost = (label, v, t) => res(v <= t, `${label} ${f3(v)}`, `${label} <= ${f3(t)}`);
const atLeast = (label, v, t) => res(v >= t, `${label} ${f3(v)}`, `${label} >= ${f3(t)}`);
/** Normalised soft-edge coverage at `r` between an outside and an inside reference (1 = fully inside). */
const coverage = (r, rIn, rOut) => (ill(rOut) - ill(r)) / (ill(rOut) - ill(rIn));
/** Where a profile (offset -> coverage, rising) crosses `level`, by linear interpolation; NaN if it never does. */
export function crossing(profile, level) {
  const pts = [...profile].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, c0] = pts[i - 1];
    const [x1, c1] = pts[i];
    if ((c0 - level) * (c1 - level) <= 0 && c1 !== c0) return x0 + ((level - c0) * (x1 - x0)) / (c1 - c0);
  }
  return NaN;
}
/** 10-90% width of a profile (offsets -> coverage). */
const width1090 = (profile) => crossing(profile, 0.9) - crossing(profile, 0.1);
/** The Region field's texel size when the group was read (half a texel is how far MSA's edge may sit off). */
const texelOf = (r) => r?.env?.regionField?.texelPx ?? 4;
const luma = (r) => (Array.isArray(r?.illum) ? 0.2126 * r.illum[0] + 0.7152 * r.illum[1] + 0.0722 * r.illum[2] : NaN);
const PROFILE_OFFSETS = [-30, -20, -10, -5, 0, 5, 10, 20, 30];
const profName = (d) => `e${d < 0 ? 'm' : 'p'}${Math.abs(d)}`;

/** Missing data makes a claim SKIP, never read garbage (off-screen probe buffers are nonsense, FRICTION #19). */
class Missing extends Error {}
/** Point reader for one evaluation: P(cond, group, point) -> row; records which (cond, group) were read. */
function reader(D) {
  const refs = new Set();
  const P = (cond, group, point) => {
    refs.add(`${cond}|${group}`);
    const row = D?.[cond]?.[group]?.[point];
    if (!row) throw new Missing(`no ${cond}/${group}.${point}`);
    if (row.onScreen === false) throw new Missing(`off-screen ${cond}/${group}.${point}`);
    // buffers read below render scale 1 come from the wrong pixel (mmp-78u.41): never judge them
    if (row.env?.renderScale != null && row.env.renderScale < 1) {
      throw new Missing(`${cond}/${group} read at render scale ${row.env.renderScale} (probe bug mmp-78u.41)`);
    }
    return row;
  };
  return { P, refs };
}

// --------------------------------------------------------------------------------------------- claims
const FD = 'client/data/region-behaviors/adjust-darkness-level.mjs';
/** needs('noon half', 'R1', 'R2') -> [['noon','R1'], ...] */
const needs = (conds, ...groups) => conds.split(' ').flatMap((c) => groups.map((g) => [c, g]));

/**
 * @typedef {object} InteriorsClaim
 * @property {string} id
 * @property {'foundry'|'msa'|'author'|'physics'} source
 * @property {string} cite
 * @property {string} claim
 * @property {Array<[string,string]>} needs - (condition, group) pairs read
 * @property {string[]} [views] - default both
 * @property {string} [known] - an existing bead this claim is expected to fail on
 * @property {string} [untestable] - measured and reported, never judged
 * @property {string} [note] - why a claim was corrected (method: keep the note)
 * @property {(P: Function) => {pass:boolean, got:string, want:string}} check
 */
/** @type {InteriorsClaim[]} */
export const INTERIORS_CLAIMS = [
  // ------------------------------------------------------------------ modes (R1)
  {
    id: 'IR-01',
    source: 'foundry',
    cite: `${FD}:29-34; shader getter client/canvas/rendering/shaders/region/adjust-darkness-level.mjs:42-50`,
    claim:
      'OVERRIDE sets the darkness to the modifier at any hour: Foundry darkness 0.90 in R1.a at noon, d 0.5 and night.',
    needs: needs('noon half night', 'R1'),
    check: (P) => every(...['noon', 'half', 'night'].map((c) => approx(`${c} a`, fdk(P(c, 'R1', 'a')), 0.9, 0.01))),
  },
  {
    id: 'IR-02',
    source: 'foundry',
    cite: `${FD}:35-38`,
    claim: 'BRIGHTEN is d(1-m): R1.d Foundry darkness 0 at noon, 0.25 at d 0.5, 0.50 at night.',
    needs: needs('noon half night', 'R1'),
    check: (P) =>
      every(
        approx('noon d', fdk(P('noon', 'R1', 'd')), 0, 0.02),
        approx('half d', fdk(P('half', 'R1', 'd')), 0.25, 0.02),
        approx('night d', fdk(P('night', 'R1', 'd')), 0.5, 0.02)
      ),
  },
  {
    id: 'IR-03',
    source: 'foundry',
    cite: `${FD}:40-43`,
    claim: 'DARKEN is 1-(1-d)(1-m): R1.e 0.50 / 0.75 / 1.00 at noon / d 0.5 / night; R1.f (DARKEN 1) 1.00 always.',
    needs: needs('noon half night', 'R1'),
    check: (P) =>
      every(
        approx('noon e', fdk(P('noon', 'R1', 'e')), 0.5, 0.02),
        approx('half e', fdk(P('half', 'R1', 'e')), 0.75, 0.02),
        approx('night e', fdk(P('night', 'R1', 'e')), 1, 0.02),
        ...['noon', 'half', 'night'].map((c) => approx(`${c} f`, fdk(P(c, 'R1', 'f')), 1, 0.02))
      ),
  },
  {
    id: 'IR-04',
    source: 'foundry',
    cite: 'client/canvas/rendering/shaders/samplers/baseline-illumination.mjs:22-23; MSA region-darkness.js (overlay), vt-pan-viewer.js (Night fader)',
    claim:
      "Fully inside a Region MSA illum is Foundry's baseline for the adjusted darkness, grey: a 0.264, b 0.561, c 0.933, f 0.188 at noon (r = 0).",
    needs: needs('noon', 'R1'),
    check: (P) =>
      every(
        ...[
          ['a', 0.9],
          ['b', 0.5],
          ['c', 0],
          ['f', 1],
        ].flatMap(([k, d]) => [
          approx(k, ill(P('noon', 'R1', k)), ambientAt(d), 0.02),
          atMost(`${k} grey`, greyness(P('noon', 'R1', k)), 0.01),
        ])
      ),
  },
  {
    id: 'IR-05',
    source: 'foundry',
    cite: `${FD}:29-34 (constant); MSA region-geometry.js:840-852 (a = m, b = 0)`,
    claim: 'An OVERRIDE interior ignores the clock: R1.a illum equal at noon, d 0.5 and night (within 0.01).',
    needs: needs('noon half night', 'R1'),
    check: (P) => {
      const v = ['noon', 'half', 'night'].map((c) => ill(P(c, 'R1', 'a')));
      return res(range(v) <= 0.01, `a ${v.map(f3).join(' / ')}`, 'range <= 0.01');
    },
  },
  {
    id: 'IR-06',
    source: 'foundry',
    cite: `${FD}:40-43; Memory scene-environment.js header (bench Mansion uses DARKEN 0.5)`,
    claim: 'DARKEN 0.5 tracks the clock: R1.e illum 0.561 / 0.374 / 0.188 at noon / d 0.5 / night.',
    note: '(c) 2026-11-09: d 0.5 is now 18.575 (MSA darkness is a smoothstep of elevation, not linear), expected A(0.75) = 0.374.',
    needs: needs('noon half night', 'R1'),
    check: (P) =>
      every(
        approx('noon e', ill(P('noon', 'R1', 'e')), ambientAt(0.5), 0.02),
        approx('half e', ill(P('half', 'R1', 'e')), ambientAt(0.75), 0.03),
        approx('night e', ill(P('night', 'R1', 'e')), ambientAt(1), 0.02)
      ),
  },
  {
    id: 'IR-07',
    source: 'foundry',
    cite: `${FD}:35-38`,
    claim: 'BRIGHTEN 0.5 lifts the night only: R1.d illum 0.933 at noon, 0.561 at night.',
    needs: needs('noon night', 'R1'),
    check: (P) =>
      every(
        approx('noon d', ill(P('noon', 'R1', 'd')), ambientAt(0), 0.02),
        approx('night d', ill(P('night', 'R1', 'd')), ambientAt(0.5), 0.02)
      ),
  },
  {
    id: 'IR-08',
    source: 'foundry',
    cite: `${FD}:29-34; MSA region-geometry.js:635-646 (names the courtyard case)`,
    claim: 'OVERRIDE 0 is "full daylight here" even at night: R1.c illum 0.933 and Foundry darkness 0.',
    needs: needs('night', 'R1'),
    check: (P) =>
      every(
        approx('night c', ill(P('night', 'R1', 'c')), ambientAt(0), 0.02),
        approx('night c dark', fdk(P('night', 'R1', 'c')), 0, 0.01)
      ),
  },
  {
    id: 'IR-09',
    source: 'foundry',
    cite: 'client/config.mjs:641; MSA environmental-light.js:98-111',
    claim: 'DARKEN 1 never goes black at r = 0 (0.188); at Night fader r = 1 it is 0.',
    needs: [...needs('noon', 'R1'), ...needs('nightR1', 'R1')],
    check: (P) =>
      every(
        approx('noon f', ill(P('noon', 'R1', 'f')), DARKNESS, 0.015),
        approx('r=1 f', ill(P('nightR1', 'R1', 'f')), 0, 0.01)
      ),
  },

  // ------------------------------------------------------------------ overlaps, seams, holes (R2, R2b)
  {
    id: 'IR-10',
    source: 'foundry',
    cite: 'client/canvas/layers/effects/illumination-effects.mjs:105-108; client/canvas/groups/effects.mjs:390-397; MSA region-geometry.js:732-772',
    claim:
      'Overlapping Regions: the minimum (brightest) adjusted darkness wins: overlap 0.30 / illum 0.709; only-0.9 0.264; only-0.3 0.709.',
    needs: needs('noon', 'R2'),
    check: (P) =>
      every(
        approx('ov dark', fdk(P('noon', 'R2', 'ov')), 0.3, 0.01),
        approx('ov', ill(P('noon', 'R2', 'ov')), ambientAt(0.3), 0.02),
        approx('only9', ill(P('noon', 'R2', 'only9')), ambientAt(0.9), 0.02),
        approx('only3', ill(P('noon', 'R2', 'only3')), ambientAt(0.3), 0.02)
      ),
  },
  {
    id: 'IR-11',
    source: 'foundry',
    cite: 'illumination-effects.mjs:107 (sort by value, not order); MSA vt-pan-viewer.js:7223-7232',
    claim: 'Creation order does not matter: the pair made 0.9-first reads like the pair made 0.3-first.',
    needs: needs('noon', 'R2'),
    check: (P) =>
      every(
        approx('ovB-ov', ill(P('noon', 'R2', 'ovB')) - ill(P('noon', 'R2', 'ov')), 0, 0.01),
        approx('ovB dark-ov dark', fdk(P('noon', 'R2', 'ovB')) - fdk(P('noon', 'R2', 'ov')), 0, 0.01)
      ),
  },
  {
    id: 'IR-12',
    source: 'foundry',
    cite: 'each mesh computes from canvas.environment.darknessLevel (shader :44-48); MSA region-geometry.js:759-772',
    claim:
      'Overlapping Regions each adjust the SAME base darkness, never chained: DARKEN .5 over BRIGHTEN .5 reads min(0.5, 0) = 0 at noon and min(0.75, 0.25) = 0.25 at d 0.5 (chained would read 0.25 / 0.375).',
    note: '(c) 2026-11-09: the prose checked the overlap at h=21, where independent (min(1, .5)) and chained (BRIGHTEN after DARKEN, 1 x .5) both give 0.5, so it could not tell them apart; noon and d 0.5 can. Built into the scene (R2b chain) instead of a temporary Region.',
    needs: needs('noon half night', 'R2b'),
    check: (P) =>
      every(
        approx('noon chainOv dark', fdk(P('noon', 'R2b', 'chainOv')), 0, 0.02),
        approx('noon chainOv', ill(P('noon', 'R2b', 'chainOv')), ambientAt(0), 0.02),
        approx('half chainOv dark', fdk(P('half', 'R2b', 'chainOv')), 0.25, 0.02),
        approx('half chainOv', ill(P('half', 'R2b', 'chainOv')), ambientAt(0.25), 0.03),
        approx('night chainOv', ill(P('night', 'R2b', 'chainOv')), ambientAt(0.5), 0.02)
      ),
  },
  {
    id: 'IR-13',
    source: 'author',
    cite: 'rants 2026-11-04 "don\'t end up leaving bright areas between region shapes which are touching"; MSA region-geometry.js:783-791',
    claim:
      'Two shapes of one Region that share an edge leave no bright seam (seam and 10/40 px off it within 0.01 of the shape centres).',
    needs: [...needs('noon', 'R2'), ...needs('noon', 'R2.zoom')],
    check: (P) => {
      const ref = ill(P('noon', 'R2', 'seamL'));
      return every(
        approx('seam-L', ill(P('noon', 'R2', 'seam')) - ref, 0, 0.01),
        approx('seam+40-L', ill(P('noon', 'R2', 'seamP40')) - ref, 0, 0.01),
        approx('seam-10-L', ill(P('noon', 'R2.zoom', 'seamM10')) - ref, 0, 0.01),
        approx('seam+10-L', ill(P('noon', 'R2.zoom', 'seamP10')) - ref, 0, 0.01)
      );
    },
  },
  {
    id: 'IR-14',
    source: 'msa',
    cite: 'region-geometry.js:783-801 (the field is blurred after the union)',
    claim: 'Two separate Regions of equal darkness that touch leave no seam either.',
    needs: [...needs('noon', 'R2'), ...needs('noon', 'R2.zoom')],
    check: (P) => {
      const ref = ill(P('noon', 'R2', 'touchL'));
      return every(
        approx('touch-L', ill(P('noon', 'R2', 'touch')) - ref, 0, 0.01),
        approx('touchR-L', ill(P('noon', 'R2', 'touchR')) - ref, 0, 0.01),
        approx('touch-10-L', ill(P('noon', 'R2.zoom', 'touchM10')) - ref, 0, 0.01),
        approx('touch+10-L', ill(P('noon', 'R2.zoom', 'touchP10')) - ref, 0, 0.01)
      );
    },
  },
  {
    id: 'IR-15',
    source: 'author',
    cite: 'rants 2026-11-04 "fade the darkness across something like 30px"; MSA region-geometry.js:803-828 (Gaussian sigma 7.5 px centred on the edge)',
    claim:
      "A Region's darkness fades in over ~30 px, half inside and half outside the authored edge: the fade's centre sits on the edge (within half a Region-field texel + 1 px), and it is complete 20 px either side (coverage <= 0.05 outside, >= 0.95 inside).",
    note: '(c) 2026-11-09, after the first run: the fade is the designed Gaussian (10-90% 21.5 px) but its centre sat 1.2 px outside the edge, because MSA draws the hard field at texel resolution (5.7 px on this scene) and an edge snaps to a texel boundary. The fixed coverages Phi(x/7.5) +-0.07 only held by luck at that phase; the check now reads the centre position and the containment.',
    needs: needs('noon', 'R1.edge'),
    check: (P) => {
      const rIn = P('noon', 'R1.edge', 'a');
      const rOut = P('noon', 'R1.edge', 'gapW');
      const prof = PROFILE_OFFSETS.map((d) => [d, coverage(P('noon', 'R1.edge', profName(d)), rIn, rOut)]);
      const at = (d) => prof.find((p) => p[0] === d)[1];
      return every(
        approx('centre px off the edge', crossing(prof, 0.5), 0, texelOf(rIn) / 2 + 1),
        atMost('c(-20)', at(-20), 0.05),
        atLeast('c(+20)', at(20), 0.95)
      );
    },
  },
  {
    id: 'IR-16',
    source: 'msa',
    cite: 'region-geometry.js:943-982 (texels grow past 6144 px, sigma stays 7.5 px); planRegionField',
    claim:
      'The fade width does not depend on the field size: 10-90% width 19 +-6 px on R1.a, on I1 (both this scene), on Effects C3 (a small field) and on the walls lab Region (a 12900 px field).',
    note: "(c) 2026-11-09: edges on a black/white boundary (I1, C3) are read with sun shadows forced off (noShadow / external), because the building-shadow blur (mmp-78u.11) darkens the outside of exactly that edge. Width = 10-90% crossing of the normalised profile. Shipped view only: it reads illum (view-independent), and visiting the other lab scenes in Measure view stalls MSA's ready signal (FRICTION #41).",
    views: ['shipped'],
    needs: [
      ...needs('noon', 'R1.edge'),
      ...needs('noShadow', 'I1.edge'),
      ...needs('external', 'X.C3edge', 'X.wallsEdge'),
    ],
    check: (P) => {
      const w = (c, g, inName, outName) => {
        const rIn = P(c, g, inName);
        const rOut = P(c, g, outName);
        return width1090(PROFILE_OFFSETS.map((d) => [d, coverage(P(c, g, profName(d)), rIn, rOut)]));
      };
      return every(
        approx('R1.a', w('noon', 'R1.edge', 'a', 'gapW'), 19, 6),
        approx('I1', w('noShadow', 'I1.edge', 'in', 'out'), 19, 6),
        approx('C3', w('external', 'X.C3edge', 'in', 'out'), 19, 6),
        approx('walls', w('external', 'X.wallsEdge', 'in', 'out'), 19, 6)
      );
    },
  },
  {
    id: 'IR-17',
    source: 'author',
    cite: 'rants 2026-11-08 "I believe that\'s an intentional fade"; MSA soft field (Gaussian product)',
    claim:
      "A convex outer corner is rounded (intended): the corner reads the product of the two edges' coverage (within 0.05), about 0.25 (0.10..0.40).",
    note: "(c) 2026-11-09: read at R1.a's north-west corner (black without Region on both sides) instead of R2's seam Region. After the first run: the corner read 0.332 for 0.25, because each edge sits up to half a texel off (west edge c(0) 0.564, so 0.564^2 = 0.318); checked against the measured product of the west and north edges (point n0 added).",
    needs: needs('noon', 'R1.edge'),
    check: (P) => {
      const rIn = P('noon', 'R1.edge', 'a');
      const rOut = P('noon', 'R1.edge', 'gapW');
      const cx = coverage(P('noon', 'R1.edge', 'ep0'), rIn, rOut);
      const cy = coverage(P('noon', 'R1.edge', 'n0'), rIn, rOut);
      const cc = coverage(P('noon', 'R1.edge', 'corner'), rIn, rOut);
      return every(
        approx(`corner-west*north (${f3(cx)}*${f3(cy)})`, cc - cx * cy, 0, 0.05),
        approx('corner', cc, 0.25, 0.15)
      );
    },
  },
  {
    id: 'IR-18',
    source: 'msa',
    cite: 'region-geometry.js:788-791',
    claim:
      'The step between touching 0.9 and 0.5 Regions is softened by the same fade, centred on the boundary (within half a texel + 1 px), 10-90% width 19 +-6 px.',
    note: '(c) 2026-11-09, after the first run: the boundary value read 0.376 for the plateau mean 0.412 because the step sat 2.35 px into the 0.5 Region (texel snapping, 5.7 px texels); the width and the 9%/91% points were right. Checked by centre position and width instead of the fixed values.',
    needs: needs('noon', 'R2.zoom'),
    check: (P) => {
      const a = ill(P('noon', 'R2.zoom', 'plat9'));
      const b = ill(P('noon', 'R2.zoom', 'plat5'));
      const prof = [-20, -10, -5, 0, 5, 10, 20].map((d) => [
        d,
        (ill(P('noon', 'R2.zoom', `step${d < 0 ? 'm' : 'p'}${Math.abs(d)}`)) - a) / (b - a),
      ]);
      return every(
        approx('centre px off the boundary', crossing(prof, 0.5), 0, texelOf(P('noon', 'R2.zoom', 'plat9')) / 2 + 1),
        approx('10-90% width', width1090(prof), 19, 6)
      );
    },
  },
  {
    id: 'IR-19',
    source: 'foundry',
    cite: 'common/data/data.mjs:124, :183 (hole shapes); MSA region-darkness.js:203-207, region-geometry.js:430',
    claim: 'A hole shape removes the Region inside it: the hole reads like black without a Region, Foundry darkness 0.',
    needs: needs('noon', 'R2'),
    check: (P) =>
      every(
        approx('hole-gap', ill(P('noon', 'R2', 'hole')) - ill(P('noon', 'R2', 'gap')), 0, 0.02),
        approx('hole dark', fdk(P('noon', 'R2', 'hole')), 0, 0.01)
      ),
  },
  {
    id: 'IR-20',
    source: 'foundry',
    cite: 'client/documents/region.mjs:228-230 (testPoint); MSA region-geometry.js:803-828',
    claim:
      "Foundry's darkness fact is hard-edged while MSA's pixel is soft: 5-10 px outside the edge Foundry says 0, 5-10 px inside 0.9, while the pixel coverage is partial. Not a bug; the probe must not flag it.",
    needs: needs('noon', 'R1.edge'),
    check: (P) => {
      const rIn = P('noon', 'R1.edge', 'a');
      const rOut = P('noon', 'R1.edge', 'gapW');
      const c = (n) => coverage(P('noon', 'R1.edge', n), rIn, rOut);
      return every(
        approx('dark(-10)', fdk(P('noon', 'R1.edge', 'em10')), 0, 0.01),
        approx('dark(-5)', fdk(P('noon', 'R1.edge', 'em5')), 0, 0.01),
        approx('dark(+5)', fdk(P('noon', 'R1.edge', 'ep5')), 0.9, 0.01),
        approx('dark(+10)', fdk(P('noon', 'R1.edge', 'ep10')), 0.9, 0.01),
        res(c('em10') > 0.02 && c('ep10') < 0.98, `c(-10) ${f3(c('em10'))} c(+10) ${f3(c('ep10'))}`, 'partial')
      );
    },
  },

  // ------------------------------------------------------------------ floors and Levels (R4, I1 slab, basement, stairwell)
  {
    id: 'IR-21',
    source: 'foundry',
    cite: 'shader depth gate adjust-darkness-level.mjs (shader):55-62; MSA region-geometry.js:690-730, vt-pan-viewer.js:7165-7181',
    claim:
      "A Region only darkens the floors its elevation band overlaps: from Upper, I1's Region ([0,20)) does not darken the Upper slab; from the Basement, R4's ground block without a Region reads the basement's own 0.264.",
    needs: [...needs('upper', 'U.slab'), ...needs('basement', 'R4@basement')],
    check: (P) =>
      every(
        atLeast('upper slab', ill(P('upper', 'U.slab', 'slab')), 0.5),
        approx('basement C', ill(P('basement', 'R4@basement', 'C')), ambientAt(0.9), 0.02)
      ),
  },
  {
    id: 'IR-22',
    source: 'foundry',
    cite: 'client/canvas/board.mjs:1377-1382; client/documents/abstract/canvas-document.mjs:97-104',
    claim:
      'A Region scoped to one Level (levels [Ground]) is only active while that Level is viewed: from the Basement, R4.A reads the basement value 0.264.',
    note: 'SUSPECT in the prose: MSA never reads region.levels, only elevation (scene-regions.js:99-120); A has an open elevation, so the min rule would give 0.561.',
    needs: needs('basement', 'R4@basement'),
    check: (P) => approx('basement A', ill(P('basement', 'R4@basement', 'A')), ambientAt(0.9), 0.02),
  },
  {
    id: 'IR-23',
    source: 'foundry',
    cite: 'board.mjs:1381; shader depth test (shader):86-89',
    claim:
      'Seen from Upper through transparent art, ground pixels follow Foundry: A (levels [Ground]) is not viewed, so it reads like C (no Region); B (levels [], elevation [0,20)) darkens them (0.561).',
    note: 'SUSPECT in the prose: MSA gates per viewed floor, so it does the opposite (A applies, B does not).',
    needs: needs('upper', 'R4@upper'),
    check: (P) =>
      every(
        approx('upper A-C', ill(P('upper', 'R4@upper', 'A')) - ill(P('upper', 'R4@upper', 'C')), 0, 0.02),
        approx('upper B', ill(P('upper', 'R4@upper', 'B')), ambientAt(0.5), 0.03)
      ),
  },
  {
    id: 'IR-24',
    source: 'foundry',
    cite: 'canvas-document.mjs:98 (empty levels = all); MSA region-geometry.js:712-717',
    claim:
      'A Region with no levels and no elevation (R4.D) applies on every floor: 0.561 from Ground, Upper and the Basement.',
    note: '(c) 2026-11-09: built into the scene (R4.D) instead of a temporary copy of A.',
    needs: [...needs('noon', 'R4'), ...needs('upper', 'R4@upper'), ...needs('basement', 'R4@basement')],
    check: (P) =>
      every(
        approx('ground D', ill(P('noon', 'R4', 'D')), ambientAt(0.5), 0.03),
        approx('upper D', ill(P('upper', 'R4@upper', 'D')), ambientAt(0.5), 0.03),
        approx('basement D', ill(P('basement', 'R4@basement', 'D')), ambientAt(0.5), 0.03)
      ),
  },
  {
    id: 'IR-25',
    source: 'foundry',
    cite: 'behaviour events only when enabled; MSA scene-regions.js:58',
    claim:
      'A disabled darkness behaviour does nothing: R2b.off reads like black without a Region and Foundry lists no active darkness behaviour there.',
    needs: needs('noon', 'R2b'),
    check: (P) => {
      const r = P('noon', 'R2b', 'off');
      const active = (r.foundry?.regions ?? []).some((g) => /adjustDarknessLevel/.test(g));
      return every(
        approx('off-gap', ill(r) - ill(P('noon', 'R2b', 'gap')), 0, 0.02),
        res(!active, active ? 'active darkness behaviour listed' : 'none listed', 'none listed')
      );
    },
  },
  {
    id: 'IR-26',
    source: 'foundry',
    cite: `${FD}:65-90 (one mesh per behaviour) + min sort`,
    claim:
      'Two darkness behaviours on one Region: Foundry makes a mesh for each, so the lower adjusted value (0.4) wins whatever their order: R2b.dual (.9 then .4) and R2b.dual2 (.4 then .9) both read Foundry darkness 0.40 and illum 0.635.',
    note: 'SUSPECT, documented: MSA reads only the FIRST active behaviour (scene-regions.js deriveRegionDarknessAdjuster, a named rare-edge-case simplification). dual2 added 2026-11-09 to show the order dependence.',
    needs: needs('noon', 'R2b'),
    check: (P) =>
      every(
        approx('dual dark', fdk(P('noon', 'R2b', 'dual')), 0.4, 0.01),
        approx('dual', ill(P('noon', 'R2b', 'dual')), ambientAt(0.4), 0.02),
        approx('dual2 dark', fdk(P('noon', 'R2b', 'dual2')), 0.4, 0.01),
        approx('dual2', ill(P('noon', 'R2b', 'dual2')), ambientAt(0.4), 0.02)
      ),
  },

  // ------------------------------------------------------------------ weather and Regions over open ground (R3)
  {
    id: 'IR-27',
    source: 'foundry',
    cite: "client/data/region-behaviors/suppress-weather.mjs:31-36; Physics (the author's interiors carry it for a reason)",
    claim:
      "Suppress Weather stops weather inside the Region even where _Outdoors is white: under rain the presented pixels round R3.sw.open flicker no more than the author's interior (I1) +1 level, and well under the open ground round R3.ref.open.",
    note: 'SUSPECT, documented: MSA Suppress Weather is a deliberate stub (scene-regions.js header, readSuppressWeatherStub). (c) 2026-11-09 method: flicker = RMS of frame-to-frame differences of the presented pixel (a plain std also caught the camera exposure creeping, 1.5 levels at the interior); and rain must be visible at the reference (flicker >= 1 level) or nothing was measured. First run was invalid: the world was paused, so the drops stood still. Second run: one pixel per place gave sw 15.2 / ref 6.5 in one run and 5.6 / 47.6 in the next (streaks hit a pixel or not), so flicker is now the mean over a 3 x 3 patch, 40 px apart, over 40 frames.',
    needs: needs('rain', 'R3', 'I1'),
    check: (P) => {
      const flick1 = (g, n) => {
        const s = seriesOf(P('rain', g, n), 'presented');
        if (s.length < 3) return NaN;
        let acc = 0;
        for (let i = 1; i < s.length; i++) acc += (s[i] - s[i - 1]) ** 2;
        return Math.sqrt(acc / (s.length - 1));
      };
      // patch mean over 9 points 40 px apart (one pixel depends on whether a streak crossed it)
      const flick = (g, prefix) => {
        const v = [...Array(9).keys()].map((i) => flick1(g, `${prefix}.r${i}`));
        return v.reduce((s, x) => s + x, 0) / v.length;
      };
      const sw = flick('R3', 'sw');
      const ref = flick('R3', 'ref');
      const ctl = flick('I1', 'c');
      const got = `flicker sw ${f3(sw)} ref ${f3(ref)} interior ${f3(ctl)} (levels)`;
      if (!(ref >= 1)) return { pass: null, got: `no visible rain at the reference; ${got}`, want: 'ref flicker >= 1' };
      return res(sw <= ctl + 1 && sw < 0.5 * ref, got, 'sw <= interior+1 and sw < 0.5 ref');
    },
  },
  {
    id: 'IR-28',
    source: 'foundry',
    cite: 'suppress-weather has no darkness mesh; MSA does not read the behaviour',
    claim: 'Suppress Weather alone changes no light: R3.sw.open reads like R3.ref.open (within 0.01).',
    needs: needs('noon', 'R3'),
    check: (P) => approx('sw-ref', ill(P('noon', 'R3', 'sw.open')) - ill(P('noon', 'R3', 'ref.open')), 0, 0.01),
  },
  {
    id: 'IR-29',
    source: 'author',
    cite: 'rants 2026-11-08 "Obviously not."; guide/pages/mask-outdoors.md:11 ("the light inside them is kept apart from the daylight outside")',
    claim:
      'A black-_Outdoors area with no Region is NOT lit like open ground at noon: BLK.centre <= 0.9 x open ground.',
    known: 'mmp-78u.10',
    needs: [...needs('noon', 'BLK'), ...needs('noon', 'OPEN')],
    check: (P) => atMost('BLK/open', ill(P('noon', 'BLK', 'centre')) / ill(P('noon', 'OPEN', 'open')), 0.9),
  },
  {
    id: 'IR-30',
    source: 'msa',
    cite: 'src/effects/lighting/layer-smear-render.js:284-289 (receiver gate)',
    claim:
      "Indoors never receives a sun shadow: inside BLK's big block, 15 and 40 px from its south edge (a second block 45 px south would shadow them), the light equals the block's centre (within 0.01); the gap between the blocks is shadowed.",
    note: '(c) 2026-11-09: a dedicated catcher block replaces "C5\'s north edge" (nothing casts onto that edge).',
    needs: needs('noon', 'BLK'),
    check: (P) => {
      const c = ill(P('noon', 'BLK', 'centre'));
      return every(
        approx('in15-centre', ill(P('noon', 'BLK', 'in15')) - c, 0, 0.01),
        approx('in40-centre', ill(P('noon', 'BLK', 'in40')) - c, 0, 0.01),
        atMost('gap/open', ill(P('noon', 'BLK', 'gap')) / ill(P('noon', 'BLK', 'open')), 0.95)
      );
    },
  },
  {
    id: 'IR-31',
    source: 'author',
    cite: 'rants 2026-11-07 "Clouds shadows shouldn\'t block all light indoors during noon"; MSA environmental-light.js:857-913 (cloud gate = outdoors x (1 - coverAbove))',
    claim:
      'Cloud shadows never darken an interior: under cloud 0.7 the interior (I1) and black-without-Region (BLK) readings stay within 0.01 of clear noon and of each other over the samples, while some open-ground point drops by more than 0.05.',
    note: '(c) 2026-11-09 method: four reads 7 s apart plus the clear-noon reading instead of one point over 30 s. After the first run: the nine OPEN points all sat in one cloud gap (and the clouds stood still, the world being paused), so the outdoor side now takes the largest drop over every open-ground point read under cloud.',
    needs: [...needs('cloud', 'I1', 'BLK', 'OPEN', 'R3'), ...needs('noon', 'I1', 'BLK', 'OPEN', 'R3')],
    check: (P) => {
      const inside = (g, n) => {
        const s = seriesOf(P('cloud', g, n));
        const base = ill(P('noon', g, n));
        return Math.max(range(s), ...s.map((v) => Math.abs(v - base)));
      };
      const opens = [
        ...['o00', 'o01', 'o02', 'o10', 'o11', 'o12', 'o20', 'o21', 'o22', 'open'].map((n) => ['OPEN', n]),
        ...['ref.open', 'sw.open', 'br.outN', 'dk.outN', 'sw.outN', 'ref.outN'].map((n) => ['R3', n]),
        ['BLK', 'open'],
      ].map(([g, n]) => [`${g}.${n}`, ill(P('noon', g, n)) - Math.min(...seriesOf(P('cloud', g, n)))]);
      const best = opens.reduce((m, x) => (x[1] > m[1] ? x : m));
      return every(
        atMost('I1 drift', inside('I1', 'centre'), 0.01),
        atMost('BLK drift', inside('BLK', 'centre'), 0.01),
        atLeast(`open max drop (${best[0]})`, best[1], 0.05)
      );
    },
  },
  {
    id: 'IR-32',
    source: 'msa',
    cite: 'environmental-light.js:769-774 ("indoors keeps the untouched Foundry ambient")',
    claim:
      'Interiors get no sky or golden-hour tint, outdoors does: at 17:45 I1 is grey (within 0.01) and open ground R/B > 1.1.',
    needs: needs('golden', 'I1', 'OPEN'),
    check: (P) => {
      const o = P('golden', 'OPEN', 'open').illum;
      return every(
        atMost('I1 grey', greyness(P('golden', 'I1', 'centre')), 0.01),
        atLeast('open R/B', o[0] / o[2], 1.1)
      );
    },
  },
  {
    id: 'IR-33',
    source: 'msa',
    cite: 'environmental-light.js:983-987',
    claim:
      'Moonlight is added outdoors only: at night (moon on) BLK reads A(1) = 0.188 and open ground at least 0.08 more.',
    needs: needs('night', 'BLK', 'OPEN'),
    check: (P) => {
      const b = ill(P('night', 'BLK', 'centre'));
      return every(
        approx('BLK', b, ambientAt(1), 0.02),
        atLeast('open-BLK', ill(P('night', 'OPEN', 'open')) - b, 0.08)
      );
    },
  },
  {
    id: 'IR-34',
    source: 'foundry',
    cite: `${FD}:29-34; Physics disagrees (Conflicts 2)`,
    claim:
      "The author's OVERRIDE 0.9 interior is brighter than unlit open ground at midnight with the moon off (0.264 > ~0.188). Foundry's rule, so expected.",
    needs: needs('nightMoonOff', 'I1', 'OPEN'),
    check: (P) =>
      every(
        approx('I1', ill(P('nightMoonOff', 'I1', 'centre')), ambientAt(0.9), 0.02),
        res(
          ill(P('nightMoonOff', 'I1', 'centre')) > ill(P('nightMoonOff', 'OPEN', 'open')),
          `I1 ${f3(ill(P('nightMoonOff', 'I1', 'centre')))} vs open ${f3(ill(P('nightMoonOff', 'OPEN', 'open')))}`,
          'I1 > open'
        )
      ),
  },
  {
    id: 'IR-35',
    source: 'physics',
    cite: 'Physics; Author 2026-11-07 (regions as "implied darker regions", applied on top)',
    claim:
      "A building inside an outdoor BRIGHTEN or DARKEN Region still casts its sun shadow: 40 px north of the block, north/open matches the reference block outside any Region (+-0.06), in both br and dk; the tree's shadow likewise.",
    note: 'SUSPECT (manager review, code-confirmed): the overlay replaces the whole ambient fill inside its footprint, sun visibility included, and is drawn BEFORE the tree/bush shadows, so building shadows vanish while vegetation shadows survive. Tree points added 2026-11-09.',
    needs: needs('noon', 'R3'),
    check: (P) => {
      const q = (k, n) => ill(P('noon', 'R3', `${k}.${n}`)) / ill(P('noon', 'R3', `${k}.open`));
      return every(
        approx('br building 40px', q('br', 'north') - q('ref', 'north'), 0, 0.06),
        approx('dk building 40px', q('dk', 'north') - q('ref', 'north'), 0, 0.06),
        approx('br building 20px', q('br', 'north20') - q('ref', 'north20'), 0, 0.06),
        approx('dk building 20px', q('dk', 'north20') - q('ref', 'north20'), 0, 0.06),
        approx('br tree', q('br', 'treeN15') - q('ref', 'treeN15'), 0, 0.06),
        approx('dk tree', q('dk', 'treeN15') - q('ref', 'treeN15'), 0, 0.06)
      );
    },
  },
  {
    id: 'IR-36',
    source: 'physics',
    cite: 'Physics; MSA cloud doctrine environmental-light.js:857-861',
    claim:
      'Cloud shadows still cross the open ground inside an outdoor Region: under cloud 0.7, R3.dk.open (or br.open) drops from clear noon at least half as much as the open ground just north of its Region.',
    note: 'SUSPECT: the same overwrite. (c) 2026-11-09 method: relative drop from clear noon over the samples, against the LOCAL control 110 px north of the same Region (points outN added after the first run, when the far reference ref.open was the only control); a pair whose control saw no cloud is not judged.',
    needs: [...needs('cloud', 'R3'), ...needs('noon', 'R3')],
    check: (P) => {
      const drop = (n) => {
        const s = seriesOf(P('cloud', 'R3', n));
        return (ill(P('noon', 'R3', n)) - Math.min(...s)) / ill(P('noon', 'R3', n));
      };
      const pairs = ['dk', 'br'].map((k) => [k, drop(`${k}.open`), drop(`${k}.outN`)]);
      const judged = pairs.filter(([, , out]) => out > 0.03);
      const got =
        pairs.map(([k, inn, out]) => `${k} in ${f3(inn)} out ${f3(out)}`).join('; ') +
        `; ref.open ${f3(drop('ref.open'))}`;
      if (!judged.length)
        return { pass: null, got: `no cloud crossed either local control; ${got}`, want: 'a control drop > 0.03' };
      return res(
        judged.every(([, inn, out]) => inn >= 0.5 * out),
        got,
        'inside drop >= 0.5 x local control drop'
      );
    },
  },
  {
    id: 'IR-37',
    source: 'physics',
    cite: 'Physics; MSA environmental-light.js:983-987',
    claim:
      'Moonlight and the golden tint survive inside an outdoor Region: at night (moon on) R3.br.open sits at least 0.08 above A(0.5); at 17:45 its R/B > 1.05.',
    note: 'SUSPECT: the same overwrite. (c) 2026-11-09: the moon added just outside the Region (br.outN - A(1)) is recorded beside the inside value as the control.',
    needs: needs('night golden', 'R3'),
    check: (P) => {
      const g = P('golden', 'R3', 'br.open').illum;
      const go = P('golden', 'R3', 'br.outN').illum;
      const moonOut = ill(P('night', 'R3', 'br.outN')) - ambientAt(1);
      return every(
        atLeast(
          `night br-A(.5) (outside adds ${f3(moonOut)})`,
          ill(P('night', 'R3', 'br.open')) - ambientAt(0.5),
          0.08
        ),
        atLeast(`golden R/B (outside ${f3(go[0] / go[2])})`, g[0] / g[2], 1.05)
      );
    },
  },
  {
    id: 'IR-38',
    source: 'msa',
    cite: 'guide learn-weather.md:28 ("the land lights up"); environmental-light.js:988-997',
    claim:
      'A storm flash lights the open ground inside an outdoor Region: during a forced strike at night R3.dk.open rises by at least 0.2 (as R3.ref.open does).',
    note: "SUSPECT: the same overwrite. (c) 2026-11-09: the storm's own flash01 is recorded with every read; a run where no flash was ever reported is not judged (first run: the world was paused, no strike landed).",
    needs: needs('strike', 'R3'),
    check: (P) => {
      const rise = (n) => {
        const r = P('strike', 'R3', n);
        return Math.max(...seriesOf(r)) - ill(r);
      };
      const flashes = (P('strike', 'R3', 'ref.open').series ?? []).map((s) => s.flash ?? 0);
      const peak = Math.max(0, ...flashes);
      const got = `peak flash01 ${f3(peak)}; rise ref ${f3(rise('ref.open'))} dk ${f3(rise('dk.open'))} outN ${f3(rise('dk.outN'))}`;
      if (!(peak > 0)) return { pass: null, got: `no strike landed during the reads; ${got}`, want: 'a flash' };
      return every(
        res(rise('ref.open') >= 0.2 || rise('dk.outN') >= 0.2, got, 'open ground rises >= 0.2 (control)'),
        atLeast('dk rise', rise('dk.open'), 0.2)
      );
    },
  },

  // ------------------------------------------------------------------ scene darkness, clock, Night fader (D1, OPEN, I1)
  {
    id: 'IR-39',
    source: 'msa',
    cite: 'guide fix-too-dark.md:32-34; learn-light.md:23; world/environment.js:167-168',
    claim:
      'A scene saved at darkness 0.5 is never brighter than that at noon: D1.open Foundry darkness 0.50, illum 0.561.',
    needs: needs('sceneD05', 'D1'),
    check: (P) =>
      every(
        approx('dark', fdk(P('sceneD05', 'D1', 'open')), 0.5, 0.02),
        approx('open', ill(P('sceneD05', 'D1', 'open')), ambientAt(0.5), 0.03)
      ),
  },
  {
    id: 'IR-40',
    source: 'physics',
    cite: 'Physics; Memory parity-scene-darkness (open bead mmp-ynr.9 "sun effects on a dark-saved scene")',
    claim:
      'A scene saved at darkness 1 has no sun: no sun shadow north of the D1 building at noon (north/open = 1.00 +-0.02).',
    known: 'mmp-ynr.9',
    needs: needs('sceneD1', 'D1'),
    check: (P) => approx('north/open', ill(P('sceneD1', 'D1', 'north')) / ill(P('sceneD1', 'D1', 'open')), 1, 0.02),
  },
  {
    id: 'IR-41',
    source: 'msa',
    cite: 'src/foundry/scene-environment.js:256-311 (publish, step 1/64, 250 ms); Memory parity-scene-darkness',
    claim:
      "MSA publishes its own darkness to Foundry, so Foundry's darkness outdoors follows the clock: 0 at 12:00 and 18:00, 0.50 at d 0.5, 1 at 19:30 and 00:00.",
    note: '(c) 2026-11-09: 19:15 / 21:00 read at 19:30 / 00:00 (both d = 1); d 0.5 at 18.575.',
    needs: needs('noon sunset half dusk night', 'OPEN'),
    check: (P) =>
      every(
        approx('12:00', fdk(P('noon', 'OPEN', 'open')), 0, 0.02),
        approx('18:00', fdk(P('sunset', 'OPEN', 'open')), 0, 0.02),
        approx('18:35', fdk(P('half', 'OPEN', 'open')), 0.5, 0.03),
        approx('19:30', fdk(P('dusk', 'OPEN', 'open')), 1, 0.02),
        approx('00:00', fdk(P('night', 'OPEN', 'open')), 1, 0.02)
      ),
  },
  {
    id: 'IR-42',
    source: 'author',
    cite: 'Author 2026-07-23 via src/world/sun.js:38-48 ("darkness to hit 1 at a point after dusk and before dawn"); sun.js:120',
    claim:
      'Darkness is 0 at sunset and reaches 1 only when the sun is 18 deg down: at 18:00 Foundry darkness 0 and the open ground still in daylight (luma >= 0.6, over 3x the night floor); at 19:30, moon off, A(1) = 0.188.',
    note: "(c) 2026-11-09, after the first run: open ground at 18:00 read luma 0.76 (illum 1.20 / 0.65 / 0.46, strongly golden) against the prose's 0.85. The lab sky runs Sky light (realism01) 1 and golden hour 1, which dim and tint the sunset fill by design (Author 2026-10-27 on the afterglow); the claim is the darkness curve, which holds. Threshold 0.6 = clearly day.",
    needs: [...needs('sunset', 'OPEN'), ...needs('duskMoonOff', 'OPEN')],
    check: (P) =>
      every(
        approx('18:00 dark', fdk(P('sunset', 'OPEN', 'open')), 0, 0.02),
        atLeast('18:00 luma', luma(P('sunset', 'OPEN', 'open')), 0.6),
        approx('19:30', ill(P('duskMoonOff', 'OPEN', 'open')), ambientAt(1), 0.02)
      ),
  },
  {
    id: 'IR-43',
    source: 'msa',
    cite: 'vt-pan-viewer.js:11240-11253; guide fix-too-dark.md:26-28',
    claim:
      'The Night fader pulls darkness toward black and interiors follow it: at r = 1, night, moon off: open ground 0.00, I1 0.093 (0.1 x 0.933).',
    needs: needs('nightR1', 'OPEN', 'I1'),
    check: (P) =>
      every(
        approx('open', ill(P('nightR1', 'OPEN', 'open')), 0, 0.01),
        approx('I1', ill(P('nightR1', 'I1', 'centre')), ambientAt(0.9, 1), 0.02)
      ),
  },
  {
    id: 'IR-44',
    source: 'foundry',
    cite: 'common/documents/scene.mjs:133 (dark luminosity -0.25); MSA src/effects/lighting/ambience-filter.js:10-11',
    claim:
      "Foundry's default Environment (dark luminosity -0.25) dims the art at night: Measure view, night, moon off, open ground presents ~19 +-3 (x0.8 of ~24).",
    views: ['measure'],
    needs: needs('nightMoonOff', 'OPEN'),
    check: (P) => approx('presented', pres(P('nightMoonOff', 'OPEN', 'open')), 19, 3),
  },
  {
    id: 'IR-45',
    source: 'foundry',
    cite: 'client/canvas/groups/environment.mjs:306-307 (darknessLevelTexture into the ambience filter)',
    claim:
      "Inside a darkness Region the Environment dark filter applies by the Region's darkness: Measure view, noon, I1 presents ~28 +-3 (native), not ~34.",
    known: 'mmp-ynr.11',
    views: ['measure'],
    needs: needs('noon', 'I1'),
    check: (P) => approx('presented', pres(P('noon', 'I1', 'centre')), 28, 3),
  },

  // ------------------------------------------------------------------ Global Illumination (OPEN, I1, D1)
  {
    id: 'IR-46',
    source: 'msa',
    cite: 'scene-environment.js:437, :482-500; Author 2026-10-27 "Tokens ... always believe they are in a dark place even when they are outside at noon"',
    claim:
      "With the scene's Global Illumination off, MSA publishes a GI window so outdoor ground sees by day and interiors never qualify: at noon open ground lists the global light source (darkness 0), I1 sits at 0.9 (outside the window).",
    note: '(c) 2026-11-09, after the first run: the rig world runs PF2e 8.2, which owns Global Illumination; MSA detects it (globalLightSystemOwned) and by design publishes darkness only, so no window lands. The claim applies to worlds whose system leaves GI to MSA (core, dnd5e) and is not judged on a system-owned world.',
    needs: needs('noon', 'OPEN', 'I1'),
    check: (P) => {
      const o = P('noon', 'OPEN', 'open');
      if (o.env?.giOwned) {
        return {
          pass: null,
          got: `NOT TESTABLE here: the game system owns GI (MSA publishes darkness only); open dark ${f3(fdk(o))}, I1 dark ${f3(fdk(P('noon', 'I1', 'centre')))}`,
          want: 'a world where MSA owns the GI window',
        };
      }
      return every(
        res(hasGlobal(o), hasGlobal(o) ? 'global light at open' : 'no global light at open', 'global light at open'),
        approx('open dark', fdk(o), 0, 0.01),
        approx('I1 dark', fdk(P('noon', 'I1', 'centre')), 0.9, 0.01),
        res(
          !hasGlobal(P('noon', 'I1', 'centre')),
          hasGlobal(P('noon', 'I1', 'centre')) ? 'global light in I1' : 'none in I1',
          'none in I1'
        )
      );
    },
  },
  {
    id: 'IR-47',
    source: 'msa',
    cite: 'scene-environment.js:487-489 (deriveGlobalLightWindow: a GM-enabled GI uses the GM window, unclamped)',
    claim:
      "A GM-enabled GI uses the GM's own window, unclamped: the published window equals the scene's {min 0, max 1}.",
    needs: needs('giDim giBright', 'OPEN'),
    check: (P) =>
      every(
        ...['giDim', 'giBright'].map((c) => {
          const w = P(c, 'OPEN', 'open').env?.giWindow;
          return res(w && w.min === 0 && w.max === 1, `${c} window ${JSON.stringify(w)}`, `${c} window {min 0, max 1}`);
        })
      ),
  },
  {
    id: 'IR-48',
    source: 'foundry',
    cite: 'Memory parity-scene-darkness (mmp-ynr.12 open: "GI floor is far too bright in MSA")',
    claim:
      "GI's floor at night matches native Foundry's (native barely lifts the ambient): GI on (bright false, luminosity 0.5), night, moon off.",
    known: 'mmp-ynr.12',
    untestable:
      'needs a native-Foundry reference (tools/test-world/foundry-parity-darkness.mjs on its own rig); MSA alone is measured here. The prose predicts MSA raises to the dim colour, 0.39 at r = 0.',
    needs: needs('giDim', 'OPEN', 'D1'),
    check: (P) => approx('open', ill(P('giDim', 'OPEN', 'open')), dimAt(1), 0.03),
  },
  {
    id: 'IR-49',
    source: 'foundry',
    cite: 'client/canvas/groups/effects.mjs:330-337; MSA documents the gap region-darkness.js:121-137',
    claim:
      "Where a Region's own darkness sits inside the GI window, GI still lifts it: GI on (bright), night, D1's OVERRIDE 0.1 Region reads max(0.858, GI bright floor) ~1.0.",
    note: 'SUSPECT, documented (undecided interaction). (c) 2026-11-09: built into the scene (D1.ov01) instead of a temporary Region.',
    needs: needs('giBright', 'D1'),
    check: (P) => atLeast('ov01', ill(P('giBright', 'D1', 'ov01')), 0.95),
  },

  // ------------------------------------------------------------------ lamps (R5)
  {
    id: 'IR-50',
    source: 'foundry',
    cite: 'environment.mjs:221-228; MSA point-light-pool.js:1402-1411, :2312',
    claim:
      'A lamp inside an OVERRIDE 0.9 room: bright core 1.0, dim zone 0.448 (the Region-adjusted ladder), unlit floor 0.264.',
    needs: needs('noon', 'R5'),
    check: (P) =>
      every(
        approx('L1b', ill(P('noon', 'R5', 'L1b')), 1, 0.04),
        approx('L1d', ill(P('noon', 'R5', 'L1d')), dimAt(0.9), 0.08),
        approx('ref', ill(P('noon', 'R5', 'ref')), ambientAt(0.9), 0.02)
      ),
  },
  {
    id: 'IR-51',
    source: 'foundry',
    cite: 'Foundry ladder (dim = 0.95 at d = 0); MSA light-visibility.js:207-233',
    claim: 'The same lamp on open ground at noon barely shows: core 1.0, 240 px <= 0.96, far away ~0.933.',
    needs: needs('noon', 'R5'),
    check: (P) =>
      every(
        approx('L3b', ill(P('noon', 'R5', 'L3b')), 1, 0.03),
        atMost('L3d', ill(P('noon', 'R5', 'L3d')), 0.96),
        approx('L3ref', ill(P('noon', 'R5', 'L3ref')), DAYLIGHT, 0.03)
      ),
  },
  {
    id: 'IR-52',
    source: 'msa',
    cite: 'environmental-light.js:589-605 (lights MAX on top)',
    claim: "A lamp's core in a dark room equals a lamp's core in open night (+-0.03).",
    needs: needs('noon night', 'R5'),
    check: (P) => approx('L1b(noon)-L3b(night)', ill(P('noon', 'R5', 'L1b')) - ill(P('night', 'R5', 'L3b')), 0, 0.03),
  },
  {
    id: 'IR-53',
    source: 'foundry',
    cite: 'client/canvas/placeables/light.mjs:158-160; MSA src/foundry/scene-lights.js:52-80',
    claim:
      "A light's darkness activation uses the SCENE darkness, not the Region's: the night-only lamp L2 in the dark room stays off at noon (its floor reads like the room's, Foundry lists no lamp there).",
    needs: needs('noon', 'R5'),
    check: (P) => {
      const r = P('noon', 'R5', 'L2b');
      return every(
        approx('L2b-ref', ill(r) - ill(P('noon', 'R5', 'ref')), 0, 0.02),
        res(lamps(r).length === 0, `${lamps(r).length} lamps at L2b`, 'no lamp at L2b')
      );
    },
  },
  {
    id: 'IR-54',
    source: 'msa',
    cite: 'scene-lights.js:52-80',
    claim: "That lamp turns on once MSA's own darkness passes 0.5: at night L2's core >= 0.95.",
    needs: needs('night', 'R5'),
    check: (P) => atLeast('L2b', ill(P('night', 'R5', 'L2b')), 0.95),
  },
  {
    id: 'IR-55',
    source: 'foundry',
    cite: 'per-pixel darkness (base-light-source.mjs:239, darknessLevelTexture)',
    claim:
      "A lamp just outside a Region (no wall between) lights the Region's floor with the Region's ladder, not daylight's: 240 px into the Region, L4's light is at most the d' 0.9 dim colour (0.448) +0.05.",
    note: "SUSPECT: MSA computes the ladder at the light's ORIGIN with hard containment (point-light-pool.js:1409-1411). (c) 2026-11-09: L4in moved from 100 px (inside the 120 px BRIGHT radius, where both ladders read 1.0, so the prose's check could never pass) to 240 px (dim zone).",
    needs: needs('noon', 'R5'),
    check: (P) => atMost('L4in', ill(P('noon', 'R5', 'L4in')), dimAt(0.9) + 0.05),
  },

  // ------------------------------------------------------------------ basement and stairwell
  {
    id: 'IR-56',
    source: 'msa',
    cite: 'lab-spec.mjs:300-305, :376-381; guide mask-outdoors.md:31-33',
    claim:
      'The basement (black _Outdoors, whole-floor Region) is uniformly Region-dark, sunless and untinted: 7 spread points read 0.264 and grey at noon and at 17:45.',
    needs: needs('basement basementGolden', 'B.west', 'B.east'),
    check: (P) => {
      const pts = [
        ['B.west', 'p1'],
        ['B.west', 'p3'],
        ['B.west', 'p4'],
        ['B.west', 'p7'],
        ['B.east', 'p2'],
        ['B.east', 'p5'],
        ['B.east', 'p6'],
      ];
      const parts = [];
      for (const c of ['basement', 'basementGolden']) {
        const v = pts.map(([g, n]) => ill(P(c, g, n)));
        const gr = Math.max(...pts.map(([g, n]) => greyness(P(c, g, n))));
        parts.push(
          res(
            v.every((x) => Math.abs(x - ambientAt(0.9)) <= 0.02),
            `${c} ${f3(Math.min(...v))}..${f3(Math.max(...v))}`,
            `${c} all ${f3(ambientAt(0.9))}±0.02`
          ),
          atMost(`${c} grey`, gr, 0.01)
        );
      }
      return every(...parts);
    },
  },
  {
    id: 'IR-57',
    source: 'author',
    cite: 'Author 2026-10-28 "When underground ... I can see clouds across the whole map"; MSA environmental-light.js:903-913',
    claim:
      "No cloud shadow reaches the opaque floor's underground level: under cloud 0.7 basement points vary <= 0.01 over the samples.",
    needs: needs('basementCloud', 'B.west', 'B.east'),
    check: (P) => {
      const worst = Math.max(
        ...[
          ['B.west', 'p1'],
          ['B.west', 'p3'],
          ['B.east', 'p2'],
          ['B.east', 'p6'],
        ].map(([g, n]) => range(seriesOf(P('basementCloud', g, n))))
      );
      return atMost('worst range', worst, 0.01);
    },
  },
  {
    id: 'IR-58',
    source: 'foundry',
    cite: 'board.mjs:1381; shader depth test; Physics says dark either way',
    claim:
      "Seen from Ground down the stairwell, the basement is dark when a Region active for that view covers it: STAIR.below (levels [], elevation [-20,0)) darkens the basement pixel by Foundry's depth test (0.264); Foundry's darkness for the basement elevation there is 0.9.",
    note: "SUSPECT: MSA's per-floor band gate cannot darken a lower floor seen through a hole (region-darkness.js:92-108). (c) 2026-11-09, after the first run: the attribute's floor index is not an absolute floor (it read 0 for every point seen from Upper, the Upper slab included), so 'the hole shows the basement' is proved by the basement art's albedo signature (opaque art reads 0.2303/0.2235/0.2303, the Ground's 0.2197) instead.",
    needs: [...needs('noon', 'STAIR'), ...needs('basement', 'B.west')],
    check: (P) => {
      const r = P('noon', 'STAIR', 'hole');
      const basementArt = P('basement', 'B.west', 'p1');
      return every(
        approx('hole albedo-basement art', mean3(r.albedo) - mean3(basementArt.albedo), 0, 0.004),
        approx('Foundry basement dark', r.fd?.b, 0.9, 0.01),
        approx('hole', ill(r), ambientAt(0.9), 0.03)
      );
    },
  },
  {
    id: 'IR-59',
    source: 'author',
    cite: 'Author 2026-11-08 + memory level-visibility; lab-spec.mjs:357-363; guide fix-wrong-floor.md:8-15',
    claim:
      "The basement view never shows a floor above drawn over it: under I1 (Ground room + Upper slab) the basement view reads the basement's own floor index and the basement art's own albedo (as at p1, far from anything above).",
    note: "(c) 2026-11-09, after the first run: albedo 0.228 failed the prose's 128 (0.216), but the whole basement reads 0.2303/0.2235/0.2303: opaque art is BC1-compressed in MSA (5-6-5 endpoints turn 128 into 132/130/132) while the Ground art (RGBA, BC7) reads 0.2197. Comparing with the basement's own albedo elsewhere both fixes the check and tells the two floors apart.",
    needs: needs('basement', 'B.east', 'B.west'),
    check: (P) => {
      const r = P('basement', 'B.east', 'p6');
      const ref = P('basement', 'B.west', 'p1');
      return every(
        res(r.floorIndex === ref.floorIndex, `floor ${r.floorIndex} (p1 ${ref.floorIndex})`, 'same floor as p1'),
        approx(`albedo-basement albedo (${r.albedo?.map(f3).join('/')})`, mean3(r.albedo) - mean3(ref.albedo), 0, 0.004)
      );
    },
  },
  {
    id: 'IR-60',
    source: 'msa',
    cite: 'Memory region-darkness-soft-edge (bake-retry trap); MSA region-geometry.js:1040 (hash)',
    claim:
      'Editing a Region updates the picture promptly: R1.b set from 0.5 to 0.2 reads A(0.2) = 0.784 within 2 s (then reverted).',
    needs: needs('edit', 'R1'),
    check: (P) => approx('b', ill(P('edit', 'R1', 'b')), ambientAt(0.2), 0.02),
  },
  {
    id: 'IR-61',
    source: 'msa',
    cite: 'region-geometry.js:930-962 (the field is clipped to the canvas)',
    claim:
      "A Region drawn partly off the scene works inside it and affects nothing beyond its own edge's fade: inside 0.264; 20, 40, 100 px south and 20 px west/east of it read like the far control (within 0.01).",
    note: '(c) 2026-11-09: built into the scene (EDGE) instead of a temporary Region.',
    needs: needs('noon', 'EDGE'),
    check: (P) => {
      const ctrl = ill(P('noon', 'EDGE', 'ctrl'));
      const ctrlN = ill(P('noon', 'EDGE', 'ctrlN'));
      return every(
        approx('in', ill(P('noon', 'EDGE', 'in')), ambientAt(0.9), 0.02),
        ...['s20', 's40', 's100'].map((n) => approx(`${n}-ctrl`, ill(P('noon', 'EDGE', n)) - ctrl, 0, 0.01)),
        ...['w20', 'e20'].map((n) => approx(`${n}-ctrlN`, ill(P('noon', 'EDGE', n)) - ctrlN, 0, 0.01))
      );
    },
  },
  {
    id: 'IR-62',
    source: 'msa',
    cite: 'environmental-light.js:16-41 (illum multiplies albedo)',
    claim:
      "Regions change light, never albedo: every R1, R2, R2b and R3 floor point reads the same albedo as its plot's no-Region reference (+-1 sRGB level).",
    note: '(c) 2026-11-09, after the first run: every Ground point read 129.4 for the painted 128 (the RGBA art is BC7-compressed; see IR-59), failing an absolute +-1 that had nothing to do with Regions. Compared within each plot against its no-Region reference instead; the absolute value is reported.',
    needs: needs('noon', 'R1', 'R2', 'R2b', 'R3', 'R1.edge', 'R2.zoom'),
    check: (P) => {
      const REF = { R1: 'gap', R2: 'gap', R2b: 'gap', R3: 'ref.open', 'R1.edge': 'gapW', 'R2.zoom': 'gap' };
      const bad = [];
      let n = 0;
      let abs = NaN;
      for (const g of Object.keys(REF)) {
        const ref = P('noon', g, REF[g]);
        abs = toSrgb(mean3(ref.albedo));
        for (const p of allGroups()[g].pts) {
          // a point added to the spec after this run was taken is simply not judged here
          let r;
          try {
            r = P('noon', g, p.name);
          } catch {
            continue;
          }
          if (!Array.isArray(r.albedo)) continue;
          n++;
          const worst = Math.max(...r.albedo.map((v, i) => Math.abs(toSrgb(v) - toSrgb(ref.albedo[i]))));
          if (worst > 1.01) bad.push(`${g}.${p.name} ${r.albedo.map((v) => toSrgb(v).toFixed(1)).join('/')}`);
        }
      }
      return res(
        bad.length === 0,
        bad.length ? bad.slice(0, 6).join('; ') : `${n} points match their reference (absolute ${f3(abs)} for art 128)`,
        'albedo = plot reference ±1'
      );
    },
  },

  // ------------------------------------------------------------------ added 2026-11-09 by the lab run
  {
    id: 'IR-63',
    source: 'msa',
    cite: 'src/foundry/region-darkness-override.js header (world setting regionDarknessOverrideEnabled; ON by default since author 2026-09-09, OFF by default per the manager 2026-11-09, mmp-6pc.3)',
    claim:
      "When a GM switches MSA's Region darkness override ON (value v), viewing the scene rewrites every darkening behaviour (DARKEN, OVERRIDE > 0) to OVERRIDE v and keeps the original in a flag; BRIGHTEN and OVERRIDE 0 are untouched. R1.e (DARKEN .5) and D1.ov01 (OVERRIDE .1) then read A(v); R1.d and R1.c keep 0.933.",
    note: '(c) 2026-11-09: worded for the new default (OFF, mmp-6pc.3); the checker switches it on only for this measurement and restores what it found. Its scope (outdoor, OVERRIDE 0.1 and Level-scoped Regions, first behaviour only) is decision mmp-78u.23.',
    needs: needs('override', 'R1', 'D1'),
    check: (P) => {
      const env = P('override', 'R1', 'e').env ?? {};
      const v = Number(env.overrideValue);
      const docs = env.overrideDocs ?? {};
      const doc = (k) => docs[k] ?? 'missing';
      return every(
        res(Number.isFinite(v), `override value ${v}`, 'override value read'),
        res(doc('R1.e') === `0 ${v}`, `R1.e doc ${doc('R1.e')}`, `R1.e doc 0 ${v}`),
        res(doc('D1.ov01') === `0 ${v}`, `D1.ov01 doc ${doc('D1.ov01')}`, `D1.ov01 doc 0 ${v}`),
        res(doc('R1.d') === '1 0.5', `R1.d doc ${doc('R1.d')}`, 'R1.d doc 1 0.5'),
        res(doc('R1.c') === '0 0', `R1.c doc ${doc('R1.c')}`, 'R1.c doc 0 0'),
        approx('R1.e', ill(P('override', 'R1', 'e')), ambientAt(v), 0.02),
        approx('D1.ov01', ill(P('override', 'D1', 'ov01')), ambientAt(v), 0.02),
        approx('R1.d', ill(P('override', 'R1', 'd')), DAYLIGHT, 0.02),
        approx('R1.c', ill(P('override', 'R1', 'c')), DAYLIGHT, 0.02)
      );
    },
  },
  {
    id: 'IR-64',
    source: 'msa',
    cite: 'src/diag/pixel-probe.js#judgePresentedDrift (luma of presented vs OETF(lit); ok < 32); walls G02',
    claim:
      'With the post effects off, the presented pixel matches the lit buffer (probe drift ok) at every noon point of the scene.',
    views: ['measure'],
    needs: needs('noon', 'OPEN', 'R1', 'R2', 'R2b', 'R3', 'R4', 'R5', 'D1', 'I1', 'BLK', 'STAIR', 'EDGE'),
    check: (P) => {
      const bad = [];
      for (const g of ['OPEN', 'R1', 'R2', 'R2b', 'R3', 'R4', 'R5', 'D1', 'I1', 'BLK', 'STAIR', 'EDGE']) {
        for (const p of allGroups()[g].pts) {
          const r = P('noon', g, p.name);
          // Probe v2.1 judges on luma (lumaDrift); runs saved before it carry v2's worst-channel maxAbs.
          if (r.drift && r.drift.verdict !== 'ok') bad.push(`${g}.${p.name}:${r.drift.lumaDrift ?? r.drift.maxAbs}`);
        }
      }
      return res(bad.length === 0, bad.length ? bad.slice(0, 8).join(', ') : 'all ok', 'drift ok (<32)');
    },
  },
];

/** Counts by source, for the report. */
export function claimSourceCounts(claims = INTERIORS_CLAIMS) {
  return claims.reduce((m, c) => ((m[c.source] = (m[c.source] ?? 0) + 1), m), {});
}

/** Which groups each condition must probe for these claims, in CONDITIONS order. */
export function interiorsPlan(claims = INTERIORS_CLAIMS, { conditions = null, groups = null } = {}) {
  const want = new Map();
  for (const c of claims) {
    for (const [cond, g] of c.needs) {
      if (conditions && !conditions.includes(cond)) continue;
      if (groups && !groups.includes(g)) continue;
      if (!want.has(cond)) want.set(cond, new Set());
      want.get(cond).add(g);
    }
  }
  const all = allGroups();
  return CONDITIONS.filter((c) => want.has(c.key)).map((c) => ({
    cond: c,
    groups: [...want.get(c.key)].map((k) => {
      if (!all[k]) throw new Error(`claim names unknown group ${k}`);
      return all[k];
    }),
  }));
}

/**
 * Evaluate every claim on probe data `D[cond][group][point]`. Missing or off-screen data SKIPS a claim.
 * @returns {Array<{id:string, source:string, known:string|null, pass:boolean|null, got:string, want:string, refs:string[]}>}
 */
export function evaluateInteriorsClaims(D, view, claims = INTERIORS_CLAIMS) {
  const out = [];
  for (const c of claims) {
    if (c.views && !c.views.includes(view)) continue;
    const base = { id: c.id, source: c.source, known: c.known ?? null };
    const { P, refs } = reader(D);
    let r;
    try {
      r = c.check(P);
    } catch (err) {
      r =
        err instanceof Missing
          ? { pass: null, got: `SKIP: ${err.message}`, want: '' }
          : { pass: false, got: `check threw: ${err.message}`, want: '' };
    }
    if (c.untestable && r.pass !== null)
      r = { ...r, pass: null, got: `NOT TESTABLE (${c.untestable}); measured: ${r.got}` };
    out.push({ ...base, ...r, refs: [...refs] });
  }
  return out;
}
