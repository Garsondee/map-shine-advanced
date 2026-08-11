/**
 * POINT-LIGHT CENSUS — Stage 2's S2.0 (docs/holy/V4-Testament.md): bucket the
 * REAL map's lights by the compiled-material key BEFORE any batching code is
 * written, so the batch design is scoped by measured content, not guesses.
 *
 * Runs OFFLINE against a scene-export JSON (the export/import bridge's own
 * payload — src/foundry/scene-export.js), never against a live server:
 *
 *   node tools/point-light-census.mjs tests/playwright-artifacts/look/mansion-redux-remapped.json
 *
 * WHAT IT MIRRORS, AND FROM WHERE (read-the-producer, never invent shapes):
 *   - The bucket key is `point-light-pool.js#update()`'s own rebuild key:
 *     (animationType, animationQuality, falloffModel, windPresent,
 *     apertureCount) — cols/rows excluded here because they derive from
 *     aperture geometry and only matter once apertureCount > 0, which this
 *     census already splits on.
 *   - `hasColor` = `config.color != null` — `foundry/scene-lights.js#
 *     deriveLightSnapshot`'s own rule (`hasColor = colorRgb !== null`).
 *   - Coloration-channel membership = `hasColor || forceDefaultColor` —
 *     Foundry's own `AdaptiveColorationShader#isRequired` shape, with
 *     `forceDefaultColor` read from the REAL animations registry
 *     (`effects/lighting/animations/registry.js`), not a hand copy.
 *   - Aperture walls: `move !== NONE(0) && light === PROXIMITY(30)` —
 *     `foundry/scene-walls.js#deriveWallAperture`'s exact rule, then the REAL
 *     `findAperturesForLight` (effects/lighting/aperture-gobo.js, pure) at
 *     its real defaults, so "aperture-lit" here means exactly what the pool
 *     would compute, not an approximation.
 *   - Radius px: max(dim, bright) distance-units → px via the exported
 *     scene's own grid (`units / grid.distance * grid.size`) — Foundry's own
 *     conversion.
 *
 * WHAT IT CANNOT KNOW OFFLINE, stated rather than fudged:
 *   - Live darkness01 (which lights' darkness {min,max} windows are active
 *     right now) — reported as a separate count, not silently included or
 *     excluded.
 *   - Runtime-authored lights (candles/fire/lightning arrive via anchors +
 *     subsystems, clustered by perfTier at runtime) — anchor counts are
 *     reported from msaFlags where recognizable, with their bucket impact
 *     stated qualitatively (each anchor KIND is one more bucket pair, not
 *     one more bucket per anchor).
 *
 * @module tools/point-light-census
 */

import fs from 'node:fs';
import { findAperturesForLight, APERTURE_GOBO_DEFAULTS } from '../src/effects/lighting/aperture-gobo.js';
import { resolveLightAnimation } from '../src/effects/lighting/animations/registry.js';

const WALL_MOVEMENT_NONE = 0; // CONST.WALL_MOVEMENT_TYPES.NONE — scene-walls.js's own constant
const WALL_LIGHT_PROXIMITY = 30; // CONST.EDGE_SENSE_TYPES.PROXIMITY — the authored-window convention

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/point-light-census.mjs <scene-export.json>');
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!Array.isArray(payload.lights)) {
  console.error(`not a scene export (no lights[]): ${path}`);
  process.exit(1);
}

const grid = payload.scene?.grid ?? {};
const gridSize = Number.isFinite(grid.size) ? grid.size : 100;
const gridDistance = Number.isFinite(grid.distance) ? grid.distance : 5;
const unitsToPx = (u) => (Number(u) / gridDistance) * gridSize;

// Aperture-flagged wall segments, exactly scene-walls.js's derivation off the
// raw wall docs (c: [x1,y1,x2,y2]).
const apertureSegments = (payload.walls ?? [])
  .filter((w) => {
    const move = Number.isFinite(w?.move) ? w.move : 20;
    const light = Number.isFinite(w?.light) ? w.light : 20;
    return move !== WALL_MOVEMENT_NONE && light === WALL_LIGHT_PROXIMITY;
  })
  .map((w) => ({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3], aperture: true }));

const lights = [];
let hidden = 0;
let zeroRadius = 0;
for (const doc of payload.lights) {
  if (doc.hidden) {
    hidden++;
    continue;
  }
  const cfg = doc.config ?? {};
  const radiusPx = unitsToPx(Math.max(Number(cfg.dim) || 0, Number(cfg.bright) || 0));
  if (!(radiusPx > 0)) {
    zeroRadius++;
    continue;
  }
  const animationType = cfg.animation?.type || null;
  // `resolveLightAnimation` returns the registry entry or null — null means
  // "no animation OR unported type", either way the un-animated default
  // material (the registry's own safety-slide rule), i.e. the SAME bucket.
  const entry = resolveLightAnimation(animationType);
  const { apertures } = findAperturesForLight(
    { x: doc.x, y: doc.y, radius: radiusPx },
    apertureSegments,
    APERTURE_GOBO_DEFAULTS.maxAperturesPerLight,
    APERTURE_GOBO_DEFAULTS.maxApertureDistancePx
  );
  lights.push({
    animationType,
    animationPorted: entry !== null,
    hasColor: cfg.color !== null && cfg.color !== undefined,
    forceDefaultColor: entry?.forceDefaultColor === true,
    apertureCount: apertures.length,
    darknessGated: !!(cfg.darkness && (Number(cfg.darkness.min) > 0 || Number(cfg.darkness.max) < 1)),
    elevation: Number.isFinite(doc.elevation) ? doc.elevation : 0,
  });
}

// Bucket key: the COMPILED-MATERIAL identity, which is what batching cares
// about — an unported animation type bakes the identical un-animated material
// as no animation at all (registry safety-slide), so both key as 'none' here
// even though the pool's own per-entry rebuild check compares raw strings.
// Foundry docs carry no `animation.quality` (deriveAnimationSnapshot never
// emits one), so quality is the pool's own `?? 0` for every document light.
const keyOf = (l) =>
  [
    l.animationPorted ? l.animationType : 'none',
    'q0',
    'foundry',
    'noWind',
    l.apertureCount > 0 ? `ap${l.apertureCount}` : 'ap0',
  ].join('|');

const buckets = new Map();
for (const l of lights) {
  const k = keyOf(l);
  if (!buckets.has(k)) buckets.set(k, { count: 0, coloration: 0, apertured: l.apertureCount > 0 });
  const b = buckets.get(k);
  b.count++;
  if (l.hasColor || l.forceDefaultColor) b.coloration++;
}

const apertured = lights.filter((l) => l.apertureCount > 0);
const batchableBuckets = [...buckets.entries()].filter(([, b]) => !b.apertured);
const illumDraws = batchableBuckets.length;
const colorDraws = batchableBuckets.filter(([, b]) => b.coloration > 0).length;
const aperturedDraws = apertured.reduce((n, l) => {
  const snap = { hasColor: l.hasColor, forceDefaultColor: l.forceDefaultColor };
  return n + 1 + (snap.hasColor || snap.forceDefaultColor ? 1 : 0);
}, 0);

// Anchor kinds from msaFlags, best-effort (runtime lights: candle/fire/
// lightning — each KIND is one more bucket pair at runtime, clustered by
// perfTier before reaching the pool).
const anchorKinds = new Map();
const walk = (v) => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') {
    if (typeof v.kind === 'string') anchorKinds.set(v.kind, (anchorKinds.get(v.kind) ?? 0) + 1);
    for (const x of Object.values(v)) walk(x);
  }
};
walk(payload.msaFlags ?? {});

console.log(`\n== POINT-LIGHT CENSUS — ${path} ==`);
console.log(`scene: ${payload.scene?.name ?? '(unnamed)'}  grid ${gridSize}px / ${gridDistance} units`);
console.log(
  `document lights: ${payload.lights.length} total · ${lights.length} active-configured · ${hidden} hidden · ${zeroRadius} zero-radius`
);
console.log(
  `darkness-window-gated (may be off depending on live darkness01): ${lights.filter((l) => l.darknessGated).length}`
);
console.log(`aperture walls on scene: ${apertureSegments.length} · aperture-lit lights: ${apertured.length}`);
console.log(
  `coloration-eligible (hasColor || forceDefaultColor): ${lights.filter((l) => l.hasColor || l.forceDefaultColor).length}`
);
console.log(`\nbuckets (pool rebuild key, quality=0, falloff=foundry, no wind — document lights only):`);
for (const [k, b] of [...buckets.entries()].sort((a, z) => z[1].count - a[1].count)) {
  console.log(`  ${String(b.count).padStart(4)}  ${k}  (coloration members: ${b.coloration})`);
}
console.log(`\nanchor kinds in msaFlags (runtime lights, clustered at runtime):`);
if (anchorKinds.size === 0) console.log('  (none recognized)');
for (const [k, n] of anchorKinds) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\nprojected v1 draws for DOCUMENT lights (batched buckets + per-light apertured):`);
console.log(`  illumination: ${illumDraws} bucket draw(s) + ${apertured.length} per-light apertured`);
console.log(`  coloration:   ${colorDraws} bucket draw(s) + apertured coloration per-light`);
console.log(
  `  total document-light draws: ${illumDraws + colorDraws + aperturedDraws} (today: ${lights.length * 2} if all colorations drawn)`
);
console.log(
  `  (+ runtime anchor-kind bucket pairs at runtime; + regions/window/composite/illum/flame zones unchanged)\n`
);
