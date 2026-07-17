/**
 * THE HARVEST, CHECKED — not just generated and trusted.
 *
 * `tools/harvest-params.mjs` extracted 45 V2 `getControlSchema()` bodies
 * (2,225 params) into `SCHEMA`/`GROUPS` declarations in `params-harvest/`,
 * mechanically, from real source — the point being that a bad param is a red
 * test, not a value discovered wrong in play six months later
 * (`core/params-schema.js`'s own header). That promise is worth nothing
 * unless something actually RUNS the check. This module is that something:
 * it validates every harvested schema against the real contract
 * (`validateParamsSchema`) every time it is asked, not just at harvest time
 * on one machine.
 *
 * Wired into the `pass-graph-health`-style debug-panel protocol via
 * `effects/index.js` — one click, no re-running the generator script to find
 * out whether the harvest still holds.
 *
 * DELIBERATELY OUTSIDE `params-harvest/`, not a sibling of the generated
 * files inside it — found the hard way, same session: a hand-written file
 * placed INSIDE that directory was silently deleted by `rm -rf
 * src/effects/params-harvest` ahead of a re-harvest (a real command run this
 * session) and had to be recreated. `tools/harvest-params.mjs` only ever
 * writes `<slug>.js` + `manifest.js`; keeping every hand-written file
 * structurally OUTSIDE the generated directory means "wipe and regenerate"
 * can never again eat something it didn't create.
 *
 * @module effects/params-harvest-health
 */

import { validateParamsSchema } from '../core/params-schema.js';
import * as manifest from './params-harvest/manifest.js';

/**
 * @returns {{
 *   effectCount: number,
 *   paramCount: number,
 *   ok: boolean,
 *   perEffect: Array<{className: string, sourceFile: string, paramCount: number, ok: boolean, errors: string[]}>
 * }}
 */
export function checkParamsHarvest() {
  const perEffect = [];
  for (const [className, mod] of Object.entries(manifest)) {
    const r = validateParamsSchema(mod.SCHEMA);
    perEffect.push({
      className,
      sourceFile: mod.SOURCE_FILE,
      paramCount: Object.keys(mod.SCHEMA).length,
      ok: r.ok,
      errors: r.errors,
    });
  }
  perEffect.sort((a, b) => a.className.localeCompare(b.className));
  return {
    effectCount: perEffect.length,
    paramCount: perEffect.reduce((n, e) => n + e.paramCount, 0),
    ok: perEffect.every((e) => e.ok),
    perEffect,
  };
}
