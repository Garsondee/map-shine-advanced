/**
 * tier-ledger.test.mjs — THE TIER LEDGER STAYS TRUE (perf sweep 2026-11-08, mmp-lr2).
 *
 * `docs/planning/Perf-Sweep-2026-11-08/tiers.md` keeps one row per registered effect: its ladder, what each rung
 * adds, its problems, when it was last reviewed. The project rule (CLAUDE.md "Performance tiers") is that a
 * substantial effect change updates its tier plan and its row in the same commit. This test is the half of that
 * rule a machine can check: every registered effect has a row, no row names an effect that is gone, and each row's
 * `Ladder` (rung 0, then every rung's `fromProfile`) equals the manifest's — so a changed ladder with a stale row,
 * or a new effect with none, turns `npm run verify` red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APERTURE_GOBO } from '../aperture-gobo.js';
import { BLOOM } from '../bloom.js';
import { CANDLE_FLAME } from '../candle-flame.js';
import { CLOUD_LOOK } from '../clouds/clouds.js';
import { CLOUD_TOPS } from '../clouds/cloud-tops.js';
import { DEPTH_OF_FIELD } from '../depth-of-field.js';
import { DOOR_GRAPHICS } from '../door-graphics.js';
import { DYNAMIC_RANGE } from '../dynamic-range.js';
import { FIRE } from '../fire/fire.js';
import { FLUID } from '../fluid/fluid.js';
import { FOG_OF_WAR } from '../vision/fog-of-war.js';
import { GRADE } from '../grade/grade.js';
import { GRID } from '../grid/grid.js';
import { IRIDESCENCE } from '../iridescence/iridescence.js';
import { LEAF_SHED } from '../leaf-shed.js';
import { LENS } from '../lens.js';
import { LIGHTNING } from '../lightning.js';
import { PARALLAX } from '../parallax/parallax.js';
import { PRECIPITATION } from '../precipitation/precipitation.js';
import { PRISM } from '../prism/prism.js';
import { SPECULAR } from '../specular/specular.js';
import { STYLIZE } from '../stylize.js';
import { SUN_SHADOWS } from '../sun-shadows.js';
import { TABLE } from '../table/table.js';
import { TEMPERATURE_EFFECTS } from '../temperature/temperature.js';
import { UI_WINDOW_SHADOW } from '../ui-window-shadow.js';
import { VEGETATION } from '../vegetation.js';
import { WATER } from '../water/water.js';
import { WINDOW } from '../window/window.js';
import { WIND_TRAILS } from '../wind-trails.js';
import { DUST } from '../critters/dust.js';
import { FIREFLIES } from '../critters/fireflies.js';
import { MAGGOTS } from '../critters/maggots.js';
import { SMELLY_FLIES } from '../critters/smelly-flies.js';

/** Every manifest boot.js registers (`effectRegistry.register(...)`, plus the critter factory's four). */
export const REGISTERED_MANIFESTS = Object.freeze([
  APERTURE_GOBO,
  BLOOM,
  CANDLE_FLAME,
  CLOUD_LOOK,
  CLOUD_TOPS,
  DEPTH_OF_FIELD,
  DOOR_GRAPHICS,
  DYNAMIC_RANGE,
  FIRE,
  FLUID,
  FOG_OF_WAR,
  GRADE,
  GRID,
  IRIDESCENCE,
  LEAF_SHED,
  LENS,
  LIGHTNING,
  PARALLAX,
  PRECIPITATION,
  PRISM,
  SPECULAR,
  STYLIZE,
  SUN_SHADOWS,
  TABLE,
  TEMPERATURE_EFFECTS,
  UI_WINDOW_SHADOW,
  VEGETATION,
  WATER,
  WINDOW,
  WIND_TRAILS,
  DUST,
  FIREFLIES,
  MAGGOTS,
  SMELLY_FLIES,
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = path.resolve(HERE, '../../../docs/planning/Perf-Sweep-2026-11-08/tiers.md');

/** The manifest's ladder as the ledger writes it: `0`, then each later rung's `fromProfile`. */
export function ladderSignature(manifest) {
  const tiers = manifest?.tiers ?? [];
  return tiers.map((t, i) => (i === 0 ? '0' : String(t.fromProfile ?? '?'))).join(',');
}

/** Ledger rows: `| \`id\` | \`ladder\` | … | reviewed |` → {id, ladder, reviewed}. */
export function parseLedger(markdown) {
  const rows = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = /^\|\s*`([A-Za-z0-9]+)`\s*\|\s*`([^`]*)`\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[3].split('|').map((c) => c.trim());
    rows.push({ id: m[1], ladder: m[2], reviewed: cells[cells.length - 1] ?? '' });
  }
  return rows;
}

export function run(t) {
  const { ok } = t;
  let md = '';
  try {
    md = fs.readFileSync(LEDGER_PATH, 'utf8');
  } catch {
    md = '';
  }
  ok('the tier ledger exists (docs/planning/Perf-Sweep-2026-11-08/tiers.md)', md.length > 0);
  const rows = parseLedger(md);
  const byId = new Map(rows.map((r) => [r.id, r]));
  ok('the ledger has no duplicate rows', byId.size === rows.length);

  const ids = new Set(REGISTERED_MANIFESTS.map((m) => m.id));
  const missing = [...ids].filter((id) => !byId.has(id));
  ok(
    `every registered effect has a ledger row${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    !missing.length
  );
  const unknown = rows.filter((r) => !ids.has(r.id)).map((r) => r.id);
  ok(`no ledger row names an unregistered effect${unknown.length ? ` (${unknown.join(', ')})` : ''}`, !unknown.length);

  const stale = REGISTERED_MANIFESTS.filter((m) => byId.has(m.id) && byId.get(m.id).ladder !== ladderSignature(m)).map(
    (m) => `${m.id}: ledger \`${byId.get(m.id).ladder}\` vs manifest \`${ladderSignature(m)}\``
  );
  ok(
    `every ledger Ladder matches its manifest — update the row with the ladder${stale.length ? ` (${stale.join('; ')})` : ''}`,
    !stale.length
  );
  const undated = rows.filter((r) => !/^\d{4}-\d{2}-\d{2}\b/.test(r.reviewed)).map((r) => r.id);
  ok(
    `every ledger row says when it was last reviewed${undated.length ? ` (${undated.join(', ')})` : ''}`,
    !undated.length
  );

  // The parser itself, on a fixture (so a markdown reshuffle cannot make every check above vacuously pass).
  const fx = parseLedger('| `a` | `0,low` | yes | x | y | 2026-01-01 @ abc |\n| not a row |');
  ok(
    'parseLedger reads id, ladder and reviewed',
    fx.length === 1 && fx[0].ladder === '0,low' && fx[0].reviewed.startsWith('2026-01-01')
  );
}
