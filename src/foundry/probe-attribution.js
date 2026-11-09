/**
 * foundry/probe-attribution.js — the Foundry half of Probe v2 (mmp-78u.12; v2.1 2026-11-09).
 *
 * For a world point, the Foundry facts that explain its light: Foundry's own darkness level
 * there (Regions included — `EffectsCanvasGroup#getDarknessLevel(ElevatedPoint)`), which
 * Regions cover it and what their behaviours do, and which sources' shapes contain it.
 * The lab found interiors are darkened by an Adjust Darkness Level Region, not by the mask
 * alone (2026-11-08) — that is the kind of answer this puts on the same row as the pixel.
 *
 * PROBE v2.1 (FRICTION #31) splits the sources. `lights` holds only light EMITTERS: ambient lights,
 * token lights, and any other module's point light (MSA's own light reader draws those too, so they
 * light the picture; foundry/scene-lights.js skips only the two below). Everything else Foundry keeps
 * in its source collections goes in `otherSources`, tagged with its `kind`:
 *   - 'msaVision'   — MSA's own vision-only sources (`msa-vision:*`, scene-synthetic-lights.js): a candle,
 *                     fire or carried light's reach for Foundry's door/vision tests, or a daylit doorway's
 *                     12 px marker. Never drawn. `role` names the family (doorDaylight, fire, candle, ...).
 *   - 'globalLight' — Foundry's GlobalLightSource: a scene-wide rectangle that lights only while the
 *                     darkness level sits inside its `darknessWindow`.
 *   - 'darkness'    — darkness sources (negative lights, `canvas.effects.darknessSources`).
 * So a point next to a door, or anywhere under an active global light, no longer reads as lamp-lit.
 *
 * Also `readProbeFoundryContext()`: the scene, viewed level and Foundry camera a probe ran in.
 *
 * Read-only and never throws: anything unreadable is left out and named in `skipped` with its reason.
 *
 * @module foundry/probe-attribution
 */

import { SOURCE_ID_PREFIX as VISION_SOURCE_ID_PREFIX } from './scene-synthetic-lights.js';

/** Foundry v14's sourceId for the scene's GlobalLightSource (client/canvas/groups/environment.mjs). */
const GLOBAL_LIGHT_SOURCE_ID = 'globalLight';

const errText = (err) => String(err?.message ?? err);

/**
 * Which list a Foundry light-collection source belongs in, and its kind. Pure.
 *
 * Foundry v14 (resources/app/client/canvas): PointLightSource has sourceType 'light' and lives in
 * `lightSources`; GlobalLightSource has sourceType 'GlobalLight' and sourceId 'globalLight', also in
 * `lightSources`; PointDarknessSource has sourceType 'darkness' and lives in `darknessSources`. A
 * placeable's sources are id'd `${documentName}.${id}` (AmbientLight.<id>, Token.<id>; '.preview' while
 * dragging).
 *
 * @param {object|null} src
 * @returns {{list:'lights'|'otherSources', kind:'ambientLight'|'tokenLight'|'light'|'msaVision'|'globalLight'|'darkness',
 *   role?:string|null}}
 */
export function classifyProbeSource(src) {
  const id = String(src?.sourceId ?? '');
  const type = String(src?.constructor?.sourceType ?? '');
  if (id.startsWith(VISION_SOURCE_ID_PREFIX)) {
    const role = id.slice(VISION_SOURCE_ID_PREFIX.length).split(':')[0] || null;
    return { list: 'otherSources', kind: 'msaVision', role };
  }
  if (id === GLOBAL_LIGHT_SOURCE_ID || type === 'GlobalLight') return { list: 'otherSources', kind: 'globalLight' };
  if (type === 'darkness') return { list: 'otherSources', kind: 'darkness' };
  if (id.startsWith('AmbientLight.')) return { list: 'lights', kind: 'ambientLight' };
  if (id.startsWith('Token.')) return { list: 'lights', kind: 'tokenLight' };
  return { list: 'lights', kind: 'light' };
}

/** One source's row: where it sits relative to the point and how far it reaches. */
function describeProbeSource(src, x, y, cls) {
  const d = src.data ?? {};
  const global = cls.kind === 'globalLight';
  const sx = Number(d.x);
  const sy = Number(d.y);
  const row = {
    id: src.sourceId ?? src.object?.id ?? null,
    kind: cls.kind,
    // The global light is a scene-wide rectangle: it has no centre to measure from and no radius.
    dist: !global && Number.isFinite(sx) && Number.isFinite(sy) ? Math.round(Math.hypot(x - sx, y - sy)) : null,
    dim: global ? null : (d.dim ?? null),
    bright: global ? null : (d.bright ?? null),
    color: d.color != null ? String(d.color) : null,
  };
  if (cls.role !== undefined) row.role = cls.role;
  if (global) row.darknessWindow = [d.darkness?.min ?? null, d.darkness?.max ?? null];
  return row;
}

/**
 * @param {number} x - canvas px
 * @param {number} y - canvas px
 * @param {number} [elevation] - defaults to the viewed level's bottom + 1
 * @returns {{elevation:number|null, darkness:number|null, regions:object[], lights:object[],
 *   otherSources:object[], skipped:Array<{what:string, id?:string|null, reason:string}>}}
 *   `lights` / `otherSources` rows: `{id, kind, dist, dim, bright, color}` (+ `role` for msaVision,
 *   `darknessWindow` [min, max] for the global light).
 */
export function readProbeAttribution(x, y, elevation) {
  const canvas = globalThis.canvas;
  const out = { elevation: null, darkness: null, regions: [], lights: [], otherSources: [], skipped: [] };
  if (!canvas?.ready) return out;
  const level = canvas.level ?? null;
  const elev = Number.isFinite(elevation) ? elevation : (level?.elevation?.bottom ?? 0) + 1;
  out.elevation = elev;
  const point = { x, y, elevation: elev };
  try {
    out.darkness = canvas.effects?.getDarknessLevel?.(point) ?? null;
  } catch (err) {
    out.darkness = null;
    out.skipped.push({ what: 'darkness', reason: errText(err) });
  }
  try {
    for (const r of canvas.scene?.regions?.contents ?? []) {
      let inside = false;
      try {
        inside = r.testPoint?.(point) === true;
      } catch (err) {
        out.skipped.push({ what: 'region', id: r?.id ?? null, reason: errText(err) });
        continue;
      }
      if (!inside) continue;
      out.regions.push({
        id: r.id,
        name: r.name,
        behaviors: (r.behaviors?.contents ?? [])
          .filter((b) => !b.disabled)
          .map((b) => {
            const sys = b.system ?? {};
            const bits = [b.type];
            if (sys.mode !== undefined) bits.push(`mode=${sys.mode}`);
            if (sys.modifier !== undefined) bits.push(`mod=${sys.modifier}`);
            return bits.join(' ');
          }),
      });
    }
  } catch (err) {
    out.skipped.push({ what: 'regions', reason: errText(err) });
  }
  // Light emitters and the rest, from Foundry's two source collections. `darkness` forces the kind for
  // everything in `darknessSources` (it holds nothing else).
  const visit = (src, darkness) => {
    try {
      if (!src?.active) return;
      if (src.shape?.contains?.(x, y) !== true) return;
      const cls = darkness ? { list: 'otherSources', kind: 'darkness' } : classifyProbeSource(src);
      out[cls.list].push(describeProbeSource(src, x, y, cls));
    } catch (err) {
      out.skipped.push({ what: 'source', id: src?.sourceId ?? null, reason: errText(err) });
    }
  };
  for (const [name, darkness] of [
    ['lightSources', false],
    ['darknessSources', true],
  ]) {
    try {
      for (const src of canvas.effects?.[name] ?? []) visit(src, darkness);
    } catch (err) {
      out.skipped.push({ what: name, reason: errText(err) });
    }
  }
  return out;
}

/**
 * The Foundry state a probe ran in (probe v2.1 `context`): the scene id, the viewed level's id, and
 * Foundry's camera — `canvas.stage.pivot` is the world point at the screen centre, `canvas.stage.scale.x`
 * the screen px per world px. Never throws: a piece it cannot read is null, with the reason in `errors`.
 * @returns {{sceneId:string|null, levelId:string|null,
 *   camera:{x:number, y:number, scale:number, source:'stage'}|null, errors:string[]}}
 */
export function readProbeFoundryContext() {
  const canvas = globalThis.canvas;
  const out = { sceneId: null, levelId: null, camera: null, errors: [] };
  if (!canvas) return out;
  try {
    out.sceneId = canvas.scene?.id ?? null;
  } catch (err) {
    out.errors.push(`sceneId: ${errText(err)}`);
  }
  try {
    out.levelId = canvas.level?.id ?? null;
  } catch (err) {
    out.errors.push(`levelId: ${errText(err)}`);
  }
  try {
    const stage = canvas.stage;
    const cx = Number(stage?.pivot?.x);
    const cy = Number(stage?.pivot?.y);
    const scale = Number(stage?.scale?.x);
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(scale)) {
      out.camera = { x: cx, y: cy, scale, source: 'stage' };
    }
  } catch (err) {
    out.errors.push(`camera: ${errText(err)}`);
  }
  return out;
}
