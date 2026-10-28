/**
 * ui/rooms/studio/effect-catalog.js — which GROUP every Studio effect lives in.
 *
 * The Effects department is a library: six groups of small tiles, sorted by
 * what kind of thing an effect IS, and one effect open at a time (author,
 * 2026-10-28: "make it easy to find an effect based on the type of thing it is
 * and then open it up by pressing on a button"). This table is the one place
 * that says where each effect goes. It replaced a `filterCategory` string
 * passed separately at each of ~30 registrations in boot.js, which had drifted
 * (Table under Atmosphere, Lightning under Lighting, an empty Gameplay chip).
 *
 * An effect missing from `EFFECT_GROUP` still shows, under OTHER_GROUP, so a
 * newly registered effect can never vanish from the Studio — and
 * `__tests__/effect-catalog.test.mjs` fails until it is filed here.
 *
 * @module ui/rooms/studio/effect-catalog
 */

/**
 * The groups, in the order the library shows them. `accVar` is a LANTERN
 * category token (`ui/tokens.js`); `icon` is an icon-sprite name.
 * @type {ReadonlyArray<{id: string, label: string, icon: string, accVar: string}>}
 */
export const EFFECT_GROUPS = Object.freeze([
  { id: 'light', label: 'Light and shadow', icon: 'sun', accVar: '--c-lighting' },
  { id: 'weather', label: 'Weather and sky', icon: 'cloud', accVar: '--c-atmos' },
  { id: 'surfaces', label: 'Surfaces and water', icon: 'water', accVar: '--c-surface' },
  { id: 'living', label: 'Fire, dust and creatures', icon: 'fire', accVar: '--c-particles' },
  { id: 'camera', label: 'Camera and finish', icon: 'camera', accVar: '--c-post' },
  { id: 'table', label: 'Table and interface', icon: 'frame', accVar: '--c-system' },
]);

/** Where an uncatalogued effect lands — always drawn last, only when non-empty. */
export const OTHER_GROUP = Object.freeze({ id: 'other', label: 'Other', icon: 'gear', accVar: '--shine' });

/** Effect id -> group id. Order within a group is the order listed here. */
export const EFFECT_GROUP = Object.freeze({
  sunShadows: 'light',
  window: 'light',
  apertureGobo: 'light',
  candleFlame: 'light',
  regionDarknessOverride: 'light',

  precipitation: 'weather',
  lightning: 'weather',
  clouds: 'weather',
  cloudTops: 'weather',
  wind: 'weather',
  windTrails: 'weather',
  temperatureEffects: 'weather',

  water: 'surfaces',
  fluid: 'surfaces',
  specular: 'surfaces',
  iridescence: 'surfaces',
  prism: 'surfaces',
  vegetation: 'surfaces',

  fire: 'living',
  dust: 'living',
  fireflies: 'living',
  smellyFlies: 'living',
  maggots: 'living',

  bloom: 'camera',
  lens: 'camera',
  depthOfField: 'camera',
  grade: 'camera',
  stylize: 'camera',

  table: 'table',
  parallax: 'table',
  uiWindowShadow: 'table',
});

const ORDER = Object.keys(EFFECT_GROUP);

/**
 * The group an effect belongs to (OTHER_GROUP when it isn't catalogued).
 * @param {string} effectId
 */
export function groupOf(effectId) {
  const id = EFFECT_GROUP[effectId];
  return EFFECT_GROUPS.find((g) => g.id === id) ?? OTHER_GROUP;
}

/**
 * Sort registered effect ids into the library's groups, in display order.
 * Empty groups are dropped; uncatalogued ids collect under OTHER_GROUP, last,
 * in the order they were registered.
 * @param {string[]} effectIds
 * @returns {Array<{group: {id: string, label: string, icon: string, accVar: string}, ids: string[]}>}
 */
export function groupEffects(effectIds) {
  const rank = (id) => {
    const at = ORDER.indexOf(id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const out = [];
  for (const group of [...EFFECT_GROUPS, OTHER_GROUP]) {
    const ids = effectIds.filter((id) => groupOf(id) === group);
    if (ids.length === 0) continue;
    // Stable sort: uncatalogued ids (equal rank) keep their registration order.
    out.push({ group, ids: ids.sort((a, b) => rank(a) - rank(b)) });
  }
  return out;
}
