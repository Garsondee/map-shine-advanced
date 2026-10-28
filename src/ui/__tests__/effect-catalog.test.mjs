/**
 * effect-catalog.js — every Studio effect has a group, and grouping is stable.
 *
 * The Effects library files each effect under a group by id. A newly
 * registered effect that nobody files still shows (under "Other"), but this
 * test goes red until it is given a real group — read straight from boot.js's
 * own registration calls, so nothing has to remember to update a list here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EFFECT_GROUPS, EFFECT_GROUP, OTHER_GROUP, groupOf, groupEffects } from '../rooms/studio/effect-catalog.js';

const BOOT_PATH = fileURLToPath(new URL('../../boot.js', import.meta.url));

export function run(t) {
  const { ok } = t;
  const boot = readFileSync(BOOT_PATH, 'utf8');
  const registered = [...boot.matchAll(/register(?:Simple)?EffectCard(?:Safe)?\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

  ok('boot.js registers a plausible number of Studio effects (the scan found them)', registered.length >= 25);
  const unfiled = registered.filter((id) => !(id in EFFECT_GROUP));
  ok(`every registered effect has a group (unfiled: ${unfiled.join(', ') || 'none'})`, unfiled.length === 0);
  const stale = Object.keys(EFFECT_GROUP).filter((id) => !registered.includes(id));
  ok(
    `no group entry names an effect that is no longer registered (stale: ${stale.join(', ') || 'none'})`,
    stale.length === 0
  );

  const groupIds = new Set(EFFECT_GROUPS.map((g) => g.id));
  ok(
    'every catalog entry points at a real group',
    Object.values(EFFECT_GROUP).every((g) => groupIds.has(g))
  );
  ok(
    'no group is empty',
    EFFECT_GROUPS.every((g) => Object.values(EFFECT_GROUP).includes(g.id))
  );
  ok('no card carries its own category any more (one table, not 30 strings)', !/filterCategory/.test(boot));

  ok('an unknown effect lands in Other, never nowhere', groupOf('notAnEffect') === OTHER_GROUP);
  const grouped = groupEffects(['bloom', 'mystery', 'water', 'sunShadows', 'lens']);
  ok(
    'groups come out in catalog order, effects in catalog order, Other last',
    JSON.stringify(grouped.map((g) => [g.group.id, g.ids])) ===
      JSON.stringify([
        ['light', ['sunShadows']],
        ['surfaces', ['water']],
        ['camera', ['bloom', 'lens']],
        ['other', ['mystery']],
      ])
  );
  ok('empty groups are left out', groupEffects([]).length === 0);
}
