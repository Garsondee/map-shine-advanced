/**
 * foundry/probe-attribution.js — the Foundry half of Probe v2 (mmp-78u.12).
 *
 * For a world point, the Foundry facts that explain its light: Foundry's own darkness level
 * there (Regions included — `EffectsCanvasGroup#getDarknessLevel(ElevatedPoint)`), which
 * Regions cover it and what their behaviours do, and which light sources' shapes contain it.
 * The lab found interiors are darkened by an Adjust Darkness Level Region, not by the mask
 * alone (2026-11-08) — that is the kind of answer this puts on the same row as the pixel.
 *
 * Read-only; never throws (a missing piece reads as null).
 *
 * @module foundry/probe-attribution
 */

/**
 * @param {number} x - canvas px
 * @param {number} y - canvas px
 * @param {number} [elevation] - defaults to the viewed level's bottom + 1
 * @returns {{elevation:number|null, darkness:number|null, regions:object[], lights:object[]}}
 */
export function readProbeAttribution(x, y, elevation) {
  const canvas = globalThis.canvas;
  const out = { elevation: null, darkness: null, regions: [], lights: [] };
  if (!canvas?.ready) return out;
  const level = canvas.level ?? null;
  const elev = Number.isFinite(elevation) ? elevation : (level?.elevation?.bottom ?? 0) + 1;
  out.elevation = elev;
  const point = { x, y, elevation: elev };
  try {
    out.darkness = canvas.effects?.getDarknessLevel?.(point) ?? null;
  } catch {
    out.darkness = null;
  }
  try {
    for (const r of canvas.scene?.regions?.contents ?? []) {
      let inside = false;
      try {
        inside = r.testPoint?.(point) === true;
      } catch {
        inside = false;
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
  } catch {
    // regions unreadable: leave the list empty rather than fail the probe
  }
  try {
    for (const src of canvas.effects?.lightSources ?? []) {
      if (!src?.active) continue;
      const shape = src.shape;
      let inside = false;
      try {
        inside = shape?.contains?.(x, y) === true;
      } catch {
        inside = false;
      }
      if (!inside) continue;
      const d = src.data ?? {};
      out.lights.push({
        id: src.sourceId ?? src.object?.id ?? null,
        kind: src.constructor?.sourceType ?? src.constructor?.name ?? null,
        dist: Math.round(Math.hypot(x - (d.x ?? 0), y - (d.y ?? 0))),
        dim: d.dim ?? null,
        bright: d.bright ?? null,
        color: d.color != null ? String(d.color) : null,
      });
    }
  } catch {
    // light sources unreadable
  }
  return out;
}
