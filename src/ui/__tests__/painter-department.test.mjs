/**
 * painter-department.test.mjs — WHAT THE PAINTER DEPARTMENT IS ALLOWED TO
 * CLAIM. This suite's own directory header states the remit exactly: *"what
 * lives here is every rule about what they are allowed to CLAIM."*
 *
 * The department shipped a false claim (2026-08-18 → 2026-08-31): that every
 * one of its six tiles read painted masks through `maskAuthority.getDerived`,
 * when four of them resolve a discovered FILE url instead and render nothing
 * at all from paint — silently, behind a success toast. These tests exist so
 * that cannot come back.
 *
 * ⚠️ THE FIRST TWO GROUPS DO NOT ASSERT THE UI's BELIEF BACK AT ITSELF. A
 * table of verdicts checked against a copy of itself proves nothing. They
 * check `PAINT_REACH` against the two PRODUCERS that actually decide the
 * answer — `scene/mask-catalog.js`'s own `rasterize` flags, and a real
 * `createMaskAuthority` driven into a painted-only state with no discovery at
 * all. If the catalog changes underneath this UI, these fail.
 */
import { PAINT_REACH, paintReachOf, paintStatusLine } from '../rooms/studio/painter-department.js';
import { MASK_KINDS } from '../../scene/mask-catalog.js';
import { createMaskAuthority } from '../../scene/mask-authority.js';

/** A painted layer exactly as `ui/paint-mode.js` hands it over: one coverage
 * byte per texel, sized over the scene rect. */
function paintedGrid({ x = 0, y = 0, width = 100, height = 100, w = 8, h = 8, value = 255 } = {}) {
  const data = new Uint8Array(w * h);
  // Paint the middle band only, so "some of it is painted" is distinguishable
  // from "the whole grid defaulted to something".
  for (let row = 2; row < h - 2; row++) for (let col = 2; col < w - 2; col++) data[row * w + col] = value;
  return { spec: { x, y, width, height, w, h }, data };
}

/** A two-floor scene with NO discovery ever set — the painted-only case. */
function paintedOnlyAuthority() {
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const items = [
    { id: 'level:L0:background', kind: 'levelBackground', levelId: 'L0', hidden: false, key: { elevation: 0 } },
  ];
  const authority = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
  authority.reset({
    sceneKey: 'painted-only',
    dimensions: { width: 200, height: 200, sceneRect: { x: 0, y: 0, width: 100, height: 100 } },
    floors: [{ index: 0, id: 'L0', name: 'Ground', ceilingElevation: 10 }],
    items,
    resolvePlacement: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  return authority;
}

const anyNonZero = (grid) => !!grid?.data?.some?.((v) => v > 0);

export async function run(t) {
  // =====================================================================
  // 1. THE TABLE IS EXHAUSTIVE AND HONEST AGAINST THE CATALOG
  // =====================================================================
  const catalogIds = MASK_KINDS.map((k) => k.id);

  t.ok(
    'PAINT_REACH covers every catalog mask kind',
    catalogIds.every((id) => !!PAINT_REACH[id])
  );
  t.ok(
    'PAINT_REACH invents no mask kind the catalog does not declare',
    Object.keys(PAINT_REACH).every((id) => catalogIds.includes(id))
  );
  t.ok(
    'every reach value is one of the three declared states',
    Object.values(PAINT_REACH).every((e) => ['renders', 'partial', 'file-only'].includes(e.reach))
  );

  // THE LOAD-BEARING CROSS-CHECK. The authority only composites painted
  // sources for kinds declared `rasterize: true` (`rasterizedKinds()` →
  // `sourcesFor`), so a kind without that flag CANNOT have painted content
  // reach anything, and the UI must never say it does. This is what catches
  // tree/bush/shadow — the three kinds the painter offers and nothing reads.
  for (const kind of MASK_KINDS) {
    if (kind.rasterize === true) continue;
    t.ok(
      `un-rasterized kind '${kind.id}' is never claimed to render from paint`,
      PAINT_REACH[kind.id].reach === 'file-only'
    );
  }

  // =====================================================================
  // 2. A REAL PAINTED-ONLY AUTHORITY — no discovery, a painted grid present
  // =====================================================================
  const authority = paintedOnlyAuthority();

  // The precondition the whole finding rests on: with no file discovered, the
  // URL door every deferred consumer uses (specular/window/fluid) is empty.
  t.ok(
    'painted-only: the file-url door serves default, not authored',
    authority.authoredStatus('L0', 'fire').source === 'default' &&
      authority.authoredStatus('L0', 'specular').source === 'default'
  );

  // FIRE — the kind the UI claims renders from paint. Prove it does.
  authority.ingestPaintedMask(0, 'fire', paintedGrid());
  const firePainted = authority.getDerived('fire', 0);
  t.ok('painted-only: fire serves a derived grid', !!firePainted?.grid);
  t.ok('painted-only: fire’s derived grid actually carries the paint', anyNonZero(firePainted?.grid));
  t.ok(
    'PAINT_REACH agrees: fire renders from paint',
    PAINT_REACH.fire.reach === 'renders' && anyNonZero(firePainted?.grid)
  );

  // SPECULAR — rasterized, so a painted grid IS composited; the reason it
  // still cannot be claimed is the CONSUMER (it resolves a url, and the grid
  // is one channel). Asserted here so a future reader does not "fix" the table
  // by looking only at the authority and concluding specular works.
  authority.ingestPaintedMask(0, 'specular', paintedGrid());
  t.ok(
    'painted-only: specular DOES reach the derived grid (the authority is not the blocker)',
    anyNonZero(authority.getDerived('specular', 0)?.grid)
  );
  t.ok('PAINT_REACH still refuses to claim specular renders', PAINT_REACH.specular.reach === 'file-only');

  // TREE — the total black hole. Ingest succeeds, and nothing composites it.
  authority.ingestPaintedMask(0, 'tree', paintedGrid());
  t.ok('painted-only: a painted canopy reaches NO derived product at all', authority.getDerived('tree', 0) === null);
  t.ok('PAINT_REACH agrees: vegetation cannot render from paint', PAINT_REACH.tree.reach === 'file-only');

  // =====================================================================
  // 3. paintReachOf — the effect-level reduction
  // =====================================================================
  t.ok('single kind passes through', paintReachOf(['fire']).reach === 'renders');
  t.ok('water is partial, not rounded up', paintReachOf(['water']).reach === 'partial');
  t.ok(
    'vegetation takes the weakest of tree+bush',
    paintReachOf(['tree', 'bush']).reach === 'file-only' && paintReachOf(['tree', 'bush']).evaluated === true
  );
  const mixed = paintReachOf(['fire', 'specular']);
  t.ok('a mixed effect reports the WEAKEST kind, never the strongest', mixed.reach === 'file-only');

  const unknown = paintReachOf(['brand-new-kind']);
  t.ok('an unevaluated kind is pessimistic', unknown.reach === 'file-only');
  t.ok('...and says so rather than defaulting silently', unknown.evaluated === false);
  t.ok('...and names the kind in its copy', unknown.why.includes('brand-new-kind'));
  t.ok('no kinds at all is pessimistic too', paintReachOf([]).reach === 'file-only');

  // =====================================================================
  // 4. paintStatusLine — the copy itself may never claim a false success
  // =====================================================================
  const TONES = ['ok', 'warn', 'idle'];
  for (const [id, entry] of Object.entries(PAINT_REACH)) {
    for (const found of [false, true]) {
      for (const painted of [false, true]) {
        const line = paintStatusLine({ found, painted, reach: entry.reach });
        t.ok(`${id} f=${found} p=${painted}: tone is declared`, TONES.includes(line.tone));
        t.ok(`${id} f=${found} p=${painted}: text is non-empty`, typeof line.text === 'string' && line.text.length > 0);
        // THE ONE RULE. Paint laid down on a kind whose consumer ignores paint
        // must never read as success — no green tick over a mask that draws
        // nothing, which is the exact state the audit found shipping.
        if (entry.reach === 'file-only' && painted) {
          t.ok(`${id} f=${found} p=${painted}: painted-but-ignored never reads as ok`, line.tone === 'warn');
        }
      }
    }
  }

  t.ok(
    'painted fire alone reads as a success',
    paintStatusLine({ found: false, painted: true, reach: 'renders' }).tone === 'ok'
  );
  t.ok(
    'painted specular alone reads as a warning',
    paintStatusLine({ found: false, painted: true, reach: 'file-only' }).tone === 'warn'
  );
  t.ok(
    'painted water alone reads as a warning, not a success',
    paintStatusLine({ found: false, painted: true, reach: 'partial' }).tone === 'warn'
  );
  t.ok(
    'an untouched tile is idle, not a warning',
    paintStatusLine({ found: false, painted: false, reach: 'file-only' }).tone === 'idle'
  );
  t.ok(
    'a discovered file still reads as a success on a file-only kind',
    paintStatusLine({ found: true, painted: false, reach: 'file-only' }).tone === 'ok'
  );
  t.ok('called with no arguments at all, it does not throw and stays pessimistic', paintStatusLine().tone === 'idle');
}
