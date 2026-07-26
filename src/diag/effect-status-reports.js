/**
 * "WHY IS THIS EFFECT NOT SHOWING?" — the per-effect status reports, as pure
 * builders taking everything they read.
 *
 * Extracted from `boot.js` on 2026-07-26, when adding water's own report
 * pushed `install()` past its frozen budget. Per the standing directive
 * (memory `feedback_ratchet_proactive_not_reactive`) the fix for a god-object
 * blocking a feature is to SPLIT it as prep, never to loosen the cap — and
 * reporting is the same thing that was already the right cut in
 * `scene/mask-authority-report.js` and `vt/vt-pan-viewer-diagnostics.js`. This
 * is the third instance of the same seam, which is a fair sign it is the real
 * one: a report changes when a DEBUGGING need changes, which has nothing to do
 * with why the boot sequence changes.
 *
 * ============================================================================
 * WHAT THESE TWO HAVE IN COMMON, AND WHY THEY SHARE A FILE
 * ============================================================================
 * Both answer the same shaped question about a world-space baked field: *the
 * effect is on, the scene looks wrong, and the screen cannot tell me why.*
 * Both fail in three distinguishable ways that look identical from the
 * outside — the input never arrived, the field baked empty, or the bake never
 * ran — and in both cases the distinguishing evidence is a number nobody can
 * infer by looking. Sun shadows earned that lesson (V2's sky-reach failed
 * silently through five uninspectable stages); water inherits it before it can
 * repeat it.
 *
 * Everything is passed in. Neither builder reaches for a global, and neither
 * knows the debug panel exists — `boot.js` still owns registration, so the
 * report ids and titles stay visible at the one place someone looks for "what
 * reports are there".
 *
 * @module diag/effect-status-reports
 */

/**
 * THE SUN-SHADOW STATUS REPORT — "why is there no shadow?", answerable from a
 * pasted report instead of a guess.
 *
 * This is not optional garnish. Sky-reach's entire V2 history is a system that
 * failed silently through five stages nobody could inspect, and its MSA
 * history until 2026-07-24 was a derivation quietly starved of its input. The
 * three numbers that matter — did the art arrive, does the field have height
 * in it, did the march run — each distinguish a different failure, and none of
 * them can be inferred from looking at the screen.
 *
 * @param {object} args
 * @param {number} args.floorIndex - the currently viewed floor.
 * @param {object} args.status - `skyReachAccess.status(floorIndex)`.
 * @param {object|null} args.viewer - `getVtPanViewerDiagnostics()`, or null.
 * @param {{enabled: boolean, params: object|null}} args.readout - the cascade-resolved effect state.
 * @param {Map<number, any>} args.degradedFloors - floors running without their `_Outdoors` mask.
 * @param {string} args.generatedAt
 * @returns {object}
 */
export function buildSunShadowsReport({ floorIndex, status, viewer, readout, degradedFloors, generatedAt }) {
  return {
    report: 'sun-shadows',
    generatedAt,
    effect: { enabled: readout.enabled, params: readout.params ?? null },
    floor: status,
    // Loud, top-level, never buried: a floor running without its outdoors
    // mask still casts sky-reach/overhead shadows but NO building shadows.
    outdoorsMaskDegraded: degradedFloors.has(floorIndex) ? degradedFloors.get(floorIndex) : false,
    // The art-opacity seam. `delivered: 0` with `requested > 0` is a LOAD
    // problem; `requested: 0` is a WIRING problem; they need different fixes,
    // and before 2026-07-24 the answer was structurally the second one.
    coarseAlpha: viewer?.wholeImage?.coarseAlpha ?? 'viewer not started',
    casterField: viewer?.wholeImage?.sunShadows?.caster ?? 'viewer not started',
    lastBake: viewer?.wholeImage?.sunShadows?.lastBake ?? 'viewer not started',
    interpretation:
      'Read top-down. floor.missingItemCount > 0 means art has not been ingested for items that ' +
      'would cast — check coarseAlpha next. ⚠️ THE DECISIVE PAIR is casterField.coveredPct against ' +
      'casterField.maxCasterHeightPx: coverage PRESENT with a max height of ZERO means the casters ' +
      'exist and are all zero-height, which is what a floor with no declared bottomElevation ' +
      'produces — every item COUNT looks healthy while the field casts nothing, and that is exactly ' +
      'how sky-reach stayed broken through four rounds of tuning. floor.bottomElevation === null is ' +
      'the confirmation. Both zero instead means the field is genuinely EMPTY: an absent shadow is ' +
      'correct and the fault is upstream (nothing painted indoors for building, no raised tiles for ' +
      'overhead, no upper-floor art for sky-reach — floor.overheadItemCount / skyReachItemCount say ' +
      'which). ⚠️ floor.itemBands is the per-item verdict table — band/elevation/ownerFloorIndex/' +
      'hasArt for EVERY item, including the ones that cast nothing. An item you expect overhead ' +
      'sitting at band:"none" is a CLASSIFICATION bug; band:"skyReach" with hasArt:false is an ' +
      'INGEST one. Aggregate counts cannot tell those apart. To SEE any of this, set the effect`s ' +
      '"Debug view" to "occluder coverage" and then ' +
      '"occluder height": the same comparison, by eye, on a white background. lastBake.active:false ' +
      'means the march deliberately wrote a white (no-shadow) field. lastBake.reason names what ' +
      'triggered the most recent march; if it stays "first" while the sun moves, the rebake trigger ' +
      'is not firing.',
  };
}

/**
 * THE WATER BODY-PACK REPORT (docs/planning/Water.md §5.1).
 *
 * Water Phase 2's own exit criterion is a comparison, not a picture: **bake
 * count must not track frame count.** The jump flood is ~11 fullscreen passes
 * and must run only when the mask version or the resolved floor moves; if it
 * ran per frame, nothing on screen would look wrong — the field would be
 * correct every time — and the only symptom would be a silent, permanent
 * framerate tax. That is precisely the class of failure that hid inside a
 * residency-triggered uniform sync for a week
 * (`feedback_residency_sync_vs_render_loop`), so it gets a number rather than
 * a hope.
 *
 * The second thing this answers is "why is there no water": the cross-floor
 * rule's own `resolve.reason` string says which floor was chosen and why,
 * including the `floorIndex: null` case that means no floor in the scene has
 * an authored water mask at all — a content gap, not a code bug, and one
 * that is otherwise indistinguishable from a broken bake.
 *
 * Takes the mask authority itself rather than pre-fetched answers: both
 * queries below are ABOUT the authority, and threading them through the call
 * site meant the caller had to know which of `floorsWithAuthored` and
 * `completeness.authoredSources` answers which half of the same question.
 *
 * @param {object} args
 * @param {number} args.floorIndex - the currently viewed floor.
 * @param {object|null} args.viewer - `getVtPanViewerDiagnostics()`, or null.
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {string} args.generatedAt
 * @returns {object}
 */
export function buildWaterBodyReport({ floorIndex, viewer, maskAuthority, generatedAt }) {
  return {
    report: 'water-body',
    generatedAt,
    viewedFloor: floorIndex,
    // Provenance per floor, straight from the authority — 'authored' vs
    // 'default' is the difference between "painted no water here" and "no
    // mask exists", which are the SAME all-zero grid and different facts.
    authoredWaterFloors: maskAuthority.floorsWithAuthored('water'),
    maskProvenance: maskAuthority.getDerived('water', floorIndex)?.completeness?.authoredSources?.water ?? 'no product',
    body: viewer?.waterBody ?? 'viewer not started',
    interpretation:
      'READ bakes vs polls FIRST. A healthy session shows single-digit `bakes` against thousands of ' +
      '`polls` — the flood runs only when the mask version or the resolved floor moves. If those two ' +
      'numbers TRACK each other, the version poll is broken and every frame is paying for ~11 ' +
      'fullscreen passes; nothing on screen would look wrong, which is exactly why this is measured ' +
      'rather than eyeballed. `pollsSinceLastBake` climbing steadily is the healthy steady state. ' +
      'NEXT, resolve.reason: it names which floor`s mask was baked and why — "the viewed floor has ' +
      'its own water", "borrowed floor N", or floorIndex:null meaning NO floor in this scene has an ' +
      'authored water mask (a content gap, not a bug — cross-check authoredWaterFloors, which is ' +
      'keyed on provenance, not on the grid being non-empty). lastBake.skipped:true with a reason ' +
      'names a bake that was deliberately not run. grid "not allocated" means no bake has ever ' +
      'happened, so the three render targets do not exist yet — correct on a scene with no water. ' +
      'FINALLY `surface` is tier 0`s own state: visible:false alongside a healthy bake means the ' +
      'resolved floor`s mask holds no water at all (nothing to draw — not a failure), and `bounds` ' +
      'is the measured world AABB the quad is cropped to. If bounds ever equals the whole mask ' +
      'rect, the Law 6 crop is not working and water is paying fullscreen cost for a river.',
  };
}

/**
 * "Why can I barely see the shine?" — the report that answers it WITHOUT a
 * screenshot (`keyhole-debug-panel`: name the report, never ask for console
 * logs). Registered by `boot.js` as `specular`.
 *
 * The order of the fields is the order of the questions, and it is deliberate:
 * every one of the four ways this effect can render nothing is silent on
 * screen, and three of them look identical to "it works but is subtle".
 *
 * @param {object} args
 * @param {number} args.floorIndex @param {object|null} args.viewer
 * @param {object} args.maskAuthority @param {object} args.readout
 * @param {string} args.generatedAt
 * @returns {object}
 */
export function buildSpecularReport({ floorIndex, viewer, maskAuthority, readout, generatedAt }) {
  return {
    report: 'specular',
    generatedAt,
    viewedFloor: floorIndex,
    // Provenance, straight from the authority. 'authored' vs 'default' is the
    // difference between "painted no metal here" and "no file exists" — the
    // same empty result, two completely different facts.
    authoredSpecularFloors: maskAuthority.floorsWithAuthored('specular'),
    enabled: readout?.enabled ?? 'unresolved',
    params: readout?.params ?? 'not resolved yet',
    surface: viewer?.specular ?? 'viewer not started',
    interpretation:
      'READ `surface.maskImage` FIRST. "not loaded" means this floor has no authored specular file, ' +
      'so the pass draws literally nothing and every other field is irrelevant — cross-check ' +
      'authoredSpecularFloors, which is keyed on provenance rather than on the mask being non-empty. ' +
      'A loaded mask with `painted: "NOTHING PAINTED"` means the file exists and is entirely black. ' +
      'NEXT `surface.visible`: false with a loaded, painted mask means the AABB crop or the enable ' +
      'flag killed it. THEN the two gates, both of which are SILENT on screen: `outdoorsGate: false` ' +
      'means every pixel takes the INDOOR path regardless of what the map looks like, and indoors ' +
      'needs a lamp within reach — a daylit courtyard would render nothing at all; `floorGate: false` ' +
      'means buf:scene.attr was unavailable, so metal will draw straight over upper-floor roofs. ' +
      'FINALLY the params: `strength` 0 is off, `metalResponse` near 0 turns every metal into a 4% ' +
      'dielectric (correct physics, nearly invisible from directly above — that reading is what made ' +
      'the first build invisible), and `relief` 0 removes the per-pixel normal variation that is the ' +
      'ONLY source of an actual highlight on a flat map. If everything above is healthy and it still ' +
      'reads flat, that is the tier-3 relief rung being starved by low-contrast art, not a bug.',
  };
}
