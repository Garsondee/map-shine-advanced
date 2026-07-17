/**
 * Node verification for graph/pass-impls.js — making `live` a CHECKED FACT,
 * the mirror of what pass-declarations.test.mjs already does for `seam` via
 * pass-seams.js. Found 2026-07-17: `live` had NO check at all — the status
 * that claims real code exists was the one status nothing verified.
 *
 * Because vt-pan-viewer.js imports cleanly under Node (no top-level window/
 * document access; THREE arrives as a parameter — confirmed before writing
 * this file), these assertions import the REAL functions through the REAL
 * door and check REAL references, not string paths or regex text-matching.
 * A rename or deletion of the underlying export breaks this test at import
 * time, not silently.
 */
import { PASSES } from '../passes.js';
import { PASS_IMPLS } from '../pass-impls.js';
import { startVtPanViewer, refreshVtPanViewerItems } from '../../vt/index.js';

export function run(t) {
  const { ok } = t;

  const liveIds = PASSES.filter((p) => p.status === 'live').map((p) => p.id);

  // ---- coverage is EXACT in both directions (mirrors pass-seams' door check) -
  for (const id of liveIds) {
    ok(`live pass '${id}' HAS an entry in PASS_IMPLS`, id in PASS_IMPLS);
  }
  for (const key of Object.keys(PASS_IMPLS)) {
    const pass = PASSES.find((p) => p.id === key);
    ok(`PASS_IMPLS key '${key}' belongs to a live-status pass`, !!pass && pass.status === 'live');
  }
  ok('PASS_IMPLS is not empty (there ARE live passes to check)', Object.keys(PASS_IMPLS).length > 0);

  // ---- every entry points at a REAL function, not a description of one -----
  for (const [id, impl] of Object.entries(PASS_IMPLS)) {
    ok(`'${id}'.fn is an actual function reference`, typeof impl.fn === 'function');
    ok(`'${id}' names its real export`, typeof impl.export === 'string' && impl.export.length > 0);
    ok(`'${id}' names the door it came through`, typeof impl.module === 'string' && impl.module.length > 0);
    ok(`'${id}' explains itself (>40 chars, matches the pass-declaration bar)`, impl.note.length > 40);
  }

  // ---- the SPECIFIC, honestly-checked facts this registry claims -----------
  ok(
    'vt.residency points at the REAL, already-external refreshVtPanViewerItems (not startVtPanViewer)',
    PASS_IMPLS['vt.residency'].fn === refreshVtPanViewerItems
  );
  ok(
    'geometry.world + present.composite still enter through startVtPanViewer (the loop lives inside it)',
    PASS_IMPLS['geometry.world'].fn === startVtPanViewer && PASS_IMPLS['present.composite'].fn === startVtPanViewer
  );

  // THE FUSION IS GONE (2026-07-17). renderFrame now draws into a real
  // buf:scene.color and presents it in a second render() — two passes against
  // two targets. `fusedWith` must NOT linger: a stale honesty-marker is a lie
  // with good manners, and this registry exists to prevent exactly that.
  ok('geometry.world is no longer marked fused', !PASS_IMPLS['geometry.world'].fusedWith);
  ok('present.composite is no longer marked fused', !PASS_IMPLS['present.composite'].fusedWith);
  ok(
    'NOTHING claims fusion any more (the split is real)',
    Object.values(PASS_IMPLS).every((i) => !i.fusedWith)
  );

  // ...but the honest middle state IS still recorded: separate in the frame,
  // not yet separately invocable (setAnimationLoop drives from inside
  // startVtPanViewer). A field a test can check, never prose.
  ok(
    'vt.residency IS separately invocable (boot.js calls it directly today)',
    PASS_IMPLS['vt.residency'].separatelyInvocable === true
  );
  ok(
    'geometry.world honestly declares it is NOT separately invocable yet',
    PASS_IMPLS['geometry.world'].separatelyInvocable === false
  );
  ok('present.composite honestly declares the same', PASS_IMPLS['present.composite'].separatelyInvocable === false);
  ok(
    'every entry states its invocability rather than leaving it implied',
    Object.values(PASS_IMPLS).every((i) => typeof i.separatelyInvocable === 'boolean')
  );

  // ---- fusedWith must be a TRUTH, not a label: symmetric, and only ever
  // claimed between entries that share the literal same fn reference. A
  // fusedWith that drifts out of sync with reality is exactly the kind of
  // claim this whole file exists to prevent.
  for (const [id, impl] of Object.entries(PASS_IMPLS)) {
    for (const otherId of impl.fusedWith ?? []) {
      const other = PASS_IMPLS[otherId];
      ok(`'${id}' fusedWith '${otherId}' points at a real entry`, !!other);
      if (!other) continue;
      ok(`'${id}' <-> '${otherId}' fusion is SYMMETRIC`, (other.fusedWith ?? []).includes(id));
      ok(`'${id}' <-> '${otherId}' actually share the same fn (the claim is true)`, other.fn === impl.fn);
    }
  }
}
