/**
 * FIXTURE ONE — "town river bridge" (Tower Bridge), the lab's first REAL map.
 *
 * ============================================================================
 * WHY THIS FIXTURE, AND WHY IT IS NOT DECORATION
 * ============================================================================
 * Author, 2026-08-01: *"The goal isn't to make the Shader Lab interesting for
 * me to look at, it's to give you real masks to work with."* Every scenario in
 * this file exists to feed the REAL ingest path real authored bytes. The albedo
 * art is deliberately NOT part of the default scenarios — it is 8-9 MB per
 * floor and proves nothing the masks don't.
 *
 * Three properties make this fixture worth its disk:
 *
 * 1. **It is the exact regime the pipeline was written against.** Every file
 *    here is 10,650 × 4,950 — the same numbers `vt/mask-image.js`'s own header
 *    does its cost arithmetic with ("a 10,650px map", "~13.2 M texels"). A
 *    512² synthetic cannot enter this regime, and
 *    `feedback_measure_the_output_not_the_equation` is the memory that says a
 *    correct formula in the wrong regime returns nothing.
 *
 * 2. **Three floors of real verticality.** Underground / Middle / Roof, each
 *    with its own `_Outdoors`. The live double-shadow that survived every
 *    lab-green march fix was traced to the lab bypassing multi-floor
 *    derivation (`docs/planning/Sun-Shadows-Redesign.md`, "What the lab was
 *    missing"). This is the footage that gap needs.
 *
 * 3. **Real silhouettes.** Crenellations, thin trim, bridge cabling, and the
 *    seams where two pieces of art abut — the things a rectangle cannot have
 *    and which `complexScenario` in `lab.js` was hand-built to approximate.
 *
 * ============================================================================
 * THE THREE TIERS OF EXPECTATION, AND WHY THEY ARE SEPARATED
 * ============================================================================
 * An expectation blessed from a measurement passes forever, including on the
 * day it is wrong — that is `feedback_instruments_must_not_lie` wearing a test
 * harness. So expectations here are tiered by how they were established:
 *
 * - **`structural`** — facts about the FILES, verified independently of any
 *   code under test (dimensions read straight from the WebP headers). Safe to
 *   author, and they catch a resize/cap/scale regression immediately.
 *
 * - **`invariant`** — facts that must hold because of what the mask KIND MEANS
 *   (`scene/mask-catalog.js`), regardless of what is painted. "`_Outdoors` is
 *   declared `channels: 'gray'`, so R≈G≈B" is not a guess about this art; it is
 *   the catalog's own contract. So is bimodality: a hand-painted binary mask
 *   promises that essentially every texel sits near 0 or near 255.
 *
 *   ⚠️ What is NOT an invariant is a guess about what a floor "should" look
 *   like. This file's first version asserted "underground is mostly enclosed,
 *   roof is mostly open" and both FAILED on the real art — the underground is
 *   an open RIVER. Those are now `ratified` facts, below, not invariants.
 *
 * - **`ratified`** — measured here, then confirmed BY THE AUTHOR as true of
 *   their own map (the per-floor `outdoorsFraction`s, the specular coverage
 *   band). The confirmation is what makes them assertable; a measurement that
 *   blesses itself passes forever, including on the day it is wrong. Same
 *   discipline as `BUILT (unverified)` → `LIVE`, one level down.
 *
 * - **`authored`** — specific truths at specific world points ("the bridge deck
 *   at (x,y) is outdoors"). **These are deliberately EMPTY.** Only the author
 *   can establish them, by looking at the map.
 *
 * @module tools/shader-lab/fixtures/tower-bridge
 */

/** URL-encoded once, here, so no consumer has to remember the spaces. */
const DIR = '/example_map/town%20river%20bridge';

/**
 * Native pixel size of every mask in this set, read from the WebP headers
 * (`VP8X`, 2026-08-01). Structural expectation: the ingest must report exactly
 * this as `nativeWidth`/`nativeHeight` before any scaling is applied.
 */
export const NATIVE = Object.freeze({ width: 10650, height: 4950 });

/**
 * The fixture's world rect. This map's masks are authored at map resolution, so
 * one mask texel is one world pixel and the world rect is the native size.
 *
 * ⚠️ This is the fixture's own declaration, NOT a fact recovered from Foundry.
 * A real scene adds `Scene#padding` (default 0.25, grid-snapped —
 * `foundry/scene-geometry.js:83-108`) around this rect, and the art is inset
 * inside the padded canvas. Any bench that starts caring about padding must
 * model it explicitly rather than assuming this rect is the canvas.
 */
export const WORLD_RECT = Object.freeze({
  minX: 0,
  minY: 0,
  maxX: NATIVE.width,
  maxY: NATIVE.height,
});

/**
 * The floors, bottom to top.
 *
 * ✅ AUTHOR-GIVEN 2026-08-01: *"A typical map would have floors being between 10
 * and 20 tall. So the river town map could be described as being Floor 1: 0-20,
 * Floor 2: 20-40, Floor 3 (rooftops) 40 - infinity."*
 *
 * ⚠️ THE `+Infinity` TOP IS NOT A PLACEHOLDER — IT IS THE REAL CASE, and it is
 * a distinct code path this fixture previously never entered. `deriveFloorProducts`
 * treats an infinite `ceilingElevation` as "no ceiling declared: nothing counts
 * as above, and the report says so rather than inventing a number", and the
 * same unbounded band is what makes vegetation fall back to host-relative
 * ordering (`Bug-Tracker.md` #2's escape hatch). A top floor is the natural
 * place for it, so the top floor is where it must be tested.
 */
export const FLOORS = Object.freeze([
  Object.freeze({
    id: 'underground',
    label: 'Underground',
    index: 0,
    elevation: { bottom: 0, top: 20 },
    prefix: 'Tower_Bridge_Underground',
    /** ⚠️ NOT a cellar — this is the RIVER level. Looked at 2026-08-01: a wide
     * open channel of water, eight black cutwater PIER foundations down the
     * middle, town banks black at either edge. Mostly OUTDOORS. */
    outdoorsFraction: 0.587,
  }),
  Object.freeze({
    id: 'middle',
    label: 'Middle',
    index: 1,
    elevation: { bottom: 20, top: 40 },
    prefix: 'Tower_Bridge_Middle',
    /** The deck/town level: the open river channel runs white across the
     * middle, town buildings are black masses top and bottom. A genuine mix. */
    outdoorsFraction: 0.581,
  }),
  Object.freeze({
    id: 'roof',
    label: 'Roof',
    index: 2,
    // ⚠️ UNBOUNDED, deliberately — the author's own description of a rooftop
    // level, and the one band shape that changes how the derivation behaves.
    elevation: { bottom: 40, top: Number.POSITIVE_INFINITY },
    prefix: 'Tower_Bridge_Roof',
    /** A handful of white open-air rooftop terraces; the other ~81% is black =
     * the top-floor INTERIORS of the buildings, fully painted with art. See
     * `BLACK_MEANS_INDOORS` below before re-reading anything into that 81%. */
    outdoorsFraction: 0.194,
  }),
]);

/**
 * ⚠️ A WRONG THEORY, RULED OUT BY THE AUTHOR — recorded ONLY so it is not
 * re-derived by the next reader of the roof mask.
 *
 * On this fixture's first run I proposed that a black `_Outdoors` texel carried
 * two meanings — "indoors" AND "this floor has no art here" — on the evidence
 * that the Roof mask is 80.6% black.
 *
 * **The author ruled it out, 2026-08-01:** *"The black part of _Outdoors just
 * means that this area is indoors. There is absolutely artwork indoors, the
 * inside of buildings for example."*
 *
 * The mask means exactly one thing. A "Roof" level is not a scatter of literal
 * roof slabs in the void — it is the map's TOP LEVEL, and most of its area is
 * the top-floor INTERIORS of the buildings (black, indoors, fully painted with
 * art) with the open-air rooftop terraces bright. Nothing is overloaded, and
 * there is no `feedback_one_byte_two_quantities` here.
 *
 * Left in place because a plausible-but-wrong reading of a picture is exactly
 * what `feedback_plausible_diagnosis_rots` warns about: without this note the
 * same 80.6% invites the same wrong conclusion again.
 */
export const BLACK_MEANS_INDOORS = Object.freeze({
  status: 'AUTHOR-RULED 2026-08-01 — do not relitigate',
  ruling: 'black = indoors, full stop. Indoor areas are fully painted with art.',
  wrongTheoryRejected: 'that black also encoded "this floor has no art here"',
  whyTheRoofLooksThatWay: "a Roof level is the map's top level — mostly top-floor interiors",
});

/**
 * Every mask file in the set, by floor and kind.
 *
 * `kind` values are `scene/mask-catalog.js` ids — the catalog is the ONE place
 * a suffix may be spelled (`masks/authority-only`, enforced by
 * `tools/verify-structure.mjs`), so this table names KINDS and lets the
 * filename carry the suffix rather than re-spelling the mapping.
 *
 * `channels` is the REAL production fork (`vt/mask-image.js`'s `channels`
 * argument): `'r'` uploads RedFormat one byte per texel, `'rgb'` uploads
 * RGBAFormat. Getting this wrong on a colour mask reports a blue-painted steel
 * object as absent — the fork is per-kind semantics, not a quality setting.
 */
export const MASK_FILES = Object.freeze([
  // --- Underground ---------------------------------------------------------
  m('underground', 'outdoors', 'Tower_Bridge_Underground_Outdoors.webp', 'r'),
  m('underground', 'shadow', 'Tower_Bridge_Underground_Shadow.webp', 'r'),
  m('underground', 'specular', 'Tower_Bridge_Underground_Specular.webp', 'rgb'),
  m('underground', 'water', 'Tower_Bridge_Underground_Water.webp', 'r'),
  m('underground', 'window', 'Tower_Bridge_Underground_Windows.webp', 'rgb'),
  m('underground', 'fire', 'Tower_Bridge_Underground_Fire.webp', 'r'),
  // --- Middle --------------------------------------------------------------
  m('middle', 'outdoors', 'Tower_Bridge_Middle_Outdoors.webp', 'r'),
  m('middle', 'shadow', 'Tower_Bridge_Middle_Shadow.webp', 'r'),
  m('middle', 'window', 'Tower_Bridge_Middle_Windows.webp', 'rgb'),
  m('middle', 'fire', 'Tower_Bridge_Middle_Fire.webp', 'r'),
  // --- Roof ----------------------------------------------------------------
  m('roof', 'outdoors', 'Tower_Bridge_Roof_Outdoors.webp', 'r'),
]);

/**
 * ✅ AUTHOR-RULED 2026-08-01 — WHAT `_Overhead` ACTUALLY IS.
 *
 * *"I use `_Overhead` but it's not a formal suffix. It's more for me to
 * remember that a layer belongs to a particular floor and therefore belongs as
 * the highest element on that floor. I use tiles or the foreground image for
 * that scene's level for these textures and I don't expect them to be
 * automatically used the same way as other suffixed textures."*
 *
 * So: **a naming convention for the author's own memory, never a suffix
 * discovery should match.** The real host is either a TILE or the level's
 * FOREGROUND IMAGE — and the author uses both.
 *
 * ⚠️ THOSE TWO BAND COMPLETELY DIFFERENTLY, which is why this fixture now
 * models both rather than picking one (`OVERHEAD_HOST_TYPES` below):
 *
 * | host | `ownerFloorIndex` | band on its OWN floor | band on floors below |
 * | --- | --- | --- | --- |
 * | level foreground | the floor index | `none` (a level's own art is never overhead) | `skyReach` |
 * | tile | `null` | **`overhead`** | `skyReach` |
 *
 * Declaring it as level art alone left the OVERHEAD caster band permanently
 * empty — an entire production code path the bench would have reported green
 * while never once executing it.
 */
export const OVERHEAD_HOST_TYPES = Object.freeze(['levelForeground', 'tile']);

/**
 * ✅ AUTHOR-RULED 2026-08-01 — HOW OVERHEAD CONTENT SHOULD RESOLVE OUTDOORS.
 *
 * *"it's possible that we might need some overhead tile contents to be inside
 * and some to be outside, so we can either use the floors main `_Outdoors` to
 * work that out OR I can author an outdoors mask for overhead items. Ideally
 * outdoors stuff should just use the main albedo's of that floors `_Outdoors`
 * mask to work this stuff out."*
 *
 * **The preferred design is ONE `_Outdoors` per floor**, shared by everything
 * on that floor including overhead tiles. A per-overhead mask is the fallback
 * the author is willing to author if the shared one cannot express a case, not
 * the default.
 *
 * That matters because the authority composites per HOST in draw order, later
 * overwriting earlier — so a discovered `<item>_Outdoors` for an overhead tile
 * would REPLACE the floor's own mask inside that tile's footprint. Whether that
 * is desirable is exactly the question above, and the
 * `overhead-outdoors-composition` scenario exists to show the delta rather than
 * assume an answer.
 */
export const OUTDOORS_RESOLUTION_RULING = Object.freeze({
  preferred: "one _Outdoors per floor; overhead content resolves against the floor's own mask",
  fallback: 'a per-overhead-item _Outdoors, authored only if the shared one cannot express a case',
  openQuestion: 'does a per-item mask overwriting the floor mask inside its footprint help or hurt',
});

/**
 * ⚠️⚠️ `_Overhead` IS ART, NOT A MASK KIND — and this fixture asserted
 * otherwise on its first run, which is how it found out.
 *
 * The first version of this file mapped `Tower_Bridge_*_Overhead.webp` to a
 * mask kind `'overhead'` and listed it as greyscale. The bench's own
 * `gray-channel-contract` scenario then **failed it at maxChannelDelta = 99** —
 * because it is colour ARTWORK, not a greyscale mask.
 *
 * `scene/mask-catalog.js` has no `overhead` kind at all. Its authored kinds are
 * exactly: shadow, outdoors, fire, specular, window, tree, bush, water, fluid.
 * "Overhead" in this codebase names an ITEM ROLE (a floor's raised/roof art —
 * see the `casterHeight` kind's own "G overhead (this floor's raised tiles)"),
 * never a paintable mask.
 *
 * So `<Prefix>_Overhead.webp` is a drawable, and `<Prefix>_Overhead_Outdoors.webp`
 * is that drawable's OWN `_Outdoors` mask — which is the locked
 * "🧩 EVERY MASK ATTACHES TO ANY ITEM" decision showing up in real authored
 * filenames, and the multi-host composition case a one-file-per-floor bench
 * would never exercise.
 *
 * Recorded at length because inventing a producer's shape instead of reading it
 * is a named bug class here (`feedback_read_the_producer_never_invent_its_shape`),
 * and the tool built to catch that class committed it in its own first fixture.
 */
export const ART_LAYERS = Object.freeze([
  Object.freeze({ floorId: 'underground', file: 'Tower_Bridge_Underground_Overhead.webp', role: 'overhead' }),
  Object.freeze({ floorId: 'middle', file: 'Tower_Bridge_Middle_Overhead.webp', role: 'overhead' }),
  Object.freeze({ floorId: 'underground', file: 'Tower_Bridge_Underground.webp', role: 'background' }),
  Object.freeze({ floorId: 'middle', file: 'Tower_Bridge_Middle.webp', role: 'background' }),
  Object.freeze({ floorId: 'roof', file: 'Tower_Bridge_Roof.webp', role: 'background' }),
]);

/**
 * ⚠️ THE TWO FILES THAT ARE NOT PLAIN FLOOR MASKS, recorded so nobody wires
 * them in as if they were.
 *
 * - `Tower_Bridge_Middle_Overhead_Outdoors.webp` — an `_Outdoors` belonging to
 *   the Middle floor's OVERHEAD layer, not to the floor itself. Production
 *   composites a mask from every drawable that hosts one, later host
 *   overwriting earlier (`scene/mask-authority.js`) — so this is a SECOND
 *   outdoors contributor on one floor, and it is exactly the multi-host
 *   composition case a single-file bench would never exercise.
 * - `Tower_Bridge_Underground_WaterHard.webp` — 4.9 MB, no `_WaterHard` kind
 *   exists in the catalog. A V2-era authoring artefact; discovery must NOT
 *   match it as `water` (`feedback_fallback_matcher_self_match` is the class
 *   where a loose matcher grabs a filename it shouldn't).
 */
export const NON_MASK_FILES = Object.freeze([
  Object.freeze({
    file: 'Tower_Bridge_Middle_Overhead_Outdoors.webp',
    why:
      "the _Outdoors mask belonging to the Middle floor's OVERHEAD DRAWABLE, not to the floor itself. " +
      'A suffix matcher sees `_Outdoors` and is right to; the host it resolves to must be the overhead ' +
      'item (base `Tower_Bridge_Middle_Overhead`), NOT `Tower_Bridge_Middle`. Resolving it to the floor ' +
      "would overwrite the floor's own outdoors mask with the overhead layer's.",
    floorId: 'middle',
    kind: 'outdoors',
    hostBase: 'Tower_Bridge_Middle_Overhead',
    layer: 'overhead',
    // The "an exact-base match always wins over a shortened one" assertion —
    // without it, `Tower_Bridge_Middle_Overhead` would adopt the DECK's mask.
    coveredBy: 'src/foundry/__tests__/mask-discovery.test.mjs',
  }),
  Object.freeze({
    /**
     * ⚠️ AN ART VARIANT, NOT A MASK — and an earlier version of this fixture
     * described it wrongly as stray junk.
     *
     * Author-confirmed 2026-08-01: *"there is no planned or existing _WaterHard
     * mask/texture… I never planned for water to have more than just a _Water
     * mask."* Correct — and the 4.9 MB file in this folder is not one. It is an
     * alternative BACKGROUND ARTWORK for the underground floor, and
     * `foundry/mask-discovery.js`'s art-variant fallback exists precisely for
     * it: a tile whose art is `..._Underground_WaterHard.webp` must still find
     * the masks named for the shorter base `..._Underground`. That case has
     * been covered in `mask-discovery.test.mjs` since 2026-07-25, along with
     * the newer assertion that it can never be adopted AS the `_Water` mask
     * (the suffix match ends in a dot, so `_Water.` cannot swallow `_WaterHard`).
     *
     * Kept in this list because "a file in the map folder that is neither a
     * floor mask nor a floor's main art" is a real category an ingest bench
     * should know about, not because anything is wrong with it.
     */
    file: 'Tower_Bridge_Underground_WaterHard.webp',
    why: "an alternative background ARTWORK for the underground floor — the art-variant fallback's own case",
    floorId: 'underground',
    kind: null,
    role: 'art-variant',
    coveredBy: 'src/foundry/__tests__/mask-discovery.test.mjs',
  }),
]);

/** @param {string} floorId @param {string} kind @param {string} file @param {'r'|'rgb'} channels */
function m(floorId, kind, file, channels) {
  return Object.freeze({ floorId, kind, file, channels, url: `${DIR}/${file}` });
}

/**
 * Production's per-kind upload scale. `MASK_IMAGE_SCALE` is 1 for everything
 * except specular, which halves it (`SPECULAR_MASK_IMAGE_SCALE = 0.5`,
 * `effects/specular/specular-render.js:73`). A bench that used one scale for
 * all kinds would silently test a configuration production never runs.
 */
export const PRODUCTION_SCALE = Object.freeze({ specular: 0.5, _default: 1 });

/**
 * ⚠️ AT SCALE 1 THIS FIXTURE IS GENUINELY EXPENSIVE, and the numbers matter
 * because the lab's founding constraint is fast iteration.
 *
 * One 10,650 × 4,950 mask is 52.7 M texels. `'r'` uploads 52.7 MB; `'rgb'`
 * uploads 211 MB, and the transient `getImageData` inside the loader is 211 MB
 * on top, freed immediately. Loading the whole set at scale 1 would ask the
 * browser for well over a gigabyte.
 *
 * So an exploratory scenario runs at `EXPLORE_SCALE` and a fidelity scenario
 * runs at production scale, and every report states which it used. That is a
 * declared trade, not a hidden default — the same reason `bench-specular.js`
 * keeps `MASK_DIM` deliberately unequal to `SCREEN_DIM`.
 */
export const EXPLORE_SCALE = 0.25;

/**
 * Inputs the DERIVATION bench needs that the image files cannot supply.
 *
 * The elevation BANDS are now author-given (see `FLOORS`). What remains a lab
 * declaration is `distancePixels` — the world-px-per-elevation-unit conversion,
 * which lives in the scene's grid settings and not in any image. It is
 * PRINCIPLED rather than arbitrary: Foundry derives it as
 * `grid.size / grid.distance`, and the near-universal default (100 px per
 * square, 5 ft per square) gives exactly 20. That is what is used here.
 *
 * ⚠️ It is still a declaration. The band ORDERING is what every check in this
 * bench actually rests on, so the assertions hold either way; only the absolute
 * world-px heights (400 / 800) are downstream of this number. Stated plainly
 * because a caster field that looks right for the wrong reason is precisely
 * `feedback_instruments_must_not_lie`. Replace with the real scene's grid the
 * day this fixture gains its scene JSON.
 */
export const DERIVE = Object.freeze({
  casterHeights: Object.freeze({
    /**
     * World px the height BYTE spans. With the author's real bands (20 units
     * per floor) and `distancePixels` 20, the middle floor sits 400 world px
     * above the river and the rooftops 800 — bytes 100 and 199 of 255. Both
     * comfortably mid-range, so a reading here is measuring the derivation
     * rather than clipping or quantisation-to-zero.
     */
    scalePx: 1024,
    /** World px per elevation unit — Foundry's `grid.size / grid.distance`. */
    distancePixels: 20,
    include: Object.freeze({ building: true, overhead: true, skyReach: true }),
  }),

  /**
   * Tolerance for "the 512-texel derived outdoors grid agrees with the
   * full-resolution ingest". Deliberately looser than the ingest check's own
   * ±0.02: this is a different code path resampling a 10650 px source down to
   * 512, so a little more drift is honest. Tight enough that a UV/placement or
   * overwrite bug — which moves coverage by tens of percent — cannot hide.
   */
  outdoorsFractionTolerance: 0.05,

  /**
   * How much `coverSkyReach` coverage may drift as `casterGridDim` changes.
   * The 2026-07-30 corruption read a 512-stride buffer with the caster grid's
   * stride: at 1024 every row doubled, at 768 it sheared diagonally. Either
   * moves this far past 0.05.
   */
  casterDimCoverageSpreadMax: 0.05,
});

export const FIXTURE = Object.freeze({
  id: 'tower-bridge',
  title: 'Town River Bridge (Tower Bridge) — 3 floors, 10650×4950',
  dir: DIR,
  native: NATIVE,
  worldRect: WORLD_RECT,
  floors: FLOORS,
  maskFiles: MASK_FILES,
  artLayers: ART_LAYERS,
  nonMaskFiles: NON_MASK_FILES,
  derive: DERIVE,
  overheadHostTypes: OVERHEAD_HOST_TYPES,
  outdoorsResolutionRuling: OUTDOORS_RESOLUTION_RULING,
  productionScale: PRODUCTION_SCALE,
  exploreScale: EXPLORE_SCALE,

  /**
   * Facts about the FILES, established from the WebP headers independently of
   * any code under test.
   */
  structural: Object.freeze({
    everyMaskIsNative: NATIVE,
    maskFileCount: MASK_FILES.length,
    floorsWithOutdoors: ['underground', 'middle', 'roof'],
  }),

  /**
   * Facts that follow from the mask KIND's meaning, not from this art.
   * Falsifiable by a Y-flip, an inverted decode, a channel mix-up, or a
   * swapped file — which is the whole point of asserting them.
   */
  invariant: Object.freeze({
    /** `channels: 'gray'` kinds must decode with R≈G≈B (tolerance absorbs WebP
     * chroma subsampling; a genuine colour mask blows straight past it). */
    // `overhead` is NOT here, and was removed rather than excused — see
    // `ART_LAYERS` above for why it never belonged.
    grayKinds: ['outdoors', 'shadow', 'fire'],
    grayChannelToleranceByte: 12,
    /** A required mask that is entirely one value is not doing its job:
     * `_Outdoors` must contain BOTH indoor and outdoor texels somewhere. */
    outdoorsMustContainBothPolarities: true,
    /** A `required: true` kind must produce a non-null contentBounds. */
    outdoorsMustHaveContentBounds: true,

    /**
     * ⚠️ THE CHECK THAT REPLACED A WRONG ONE (2026-08-01).
     *
     * The first version of this fixture asserted "underground is mostly
     * enclosed, roof is mostly open". Both FAILED on the real art, and both
     * were **my invention, not the catalog's rule** — this map's underground
     * is an open RIVER and its roof is a few small rooftops. The measured
     * fractions were right and the expectation was wrong.
     *
     * The lesson is not "loosen the threshold", it is "assert something the
     * data actually promises". A hand-painted binary mask promises BIMODALITY:
     * essentially every texel sits near 0 or near 255, with very little in
     * between. That is a real authoring contract, it is falsifiable, and it
     * catches what a polarity guess never could — a smeared decode, a wrong
     * colour space, a bad resize filter, an accidental blur.
     *
     * Measured on this set: ≥99.8% of texels in the outermost 2 of 16 buckets.
     * The floor of 0.97 leaves room for genuine antialiasing on a long
     * coastline without admitting a smeared decode.
     */
    bimodalExtremeFractionMin: 0.97,

    /**
     * ✅ AUTHOR-RATIFIED 2026-08-01 ("Yes those floor numbers are right"), so
     * each floor's `outdoorsFraction` is now a REAL expectation rather than an
     * UNMEASURED proposal. That ratification is what makes them assertable —
     * they are the author's statement about their own map, not the lab's
     * measurement of itself.
     *
     * Tolerance DERIVED, not guessed: the same three masks were measured at
     * scales 0.125 / 0.25 / 0.5 and the largest spread was 0.0041 (resample
     * drift on the antialiased coastline). ±0.02 is ~5× that noise floor while
     * still catching everything worth catching — an inverted decode moves
     * underground by 0.174, and a swapped file moves it further.
     */
    outdoorsFractionTolerance: 0.02,

    /**
     * ✅ AUTHOR-RATIFIED 2026-08-01: *"the specular objects of a scene are
     * usually less than 15% of the total space but you should expect less
     * specular surfaces on most maps at varying degrees."*
     *
     * So this is a SANITY BAND, not a target: a `_Specular` mask must have
     * something painted (a fully empty one means the effect has nothing to do
     * and would be indistinguishable from a broken shader — shine's own
     * shipped-invisible history) but must not cover most of the map. This
     * fixture's Underground sits at 0.11%, near the low end and legitimate.
     */
    specularPaintedFractionMax: 0.15,
    specularPaintedFractionMin: 0.0001,

    /**
     * The three floors' `_Outdoors` masks must be genuinely DIFFERENT images.
     * Cheap, and it catches the whole "every floor resolved to the same file"
     * class — a discovery/mapping bug that every per-file check passes happily,
     * because each file loads perfectly. Compared as a coarse 16×8 mean-byte
     * signature; the threshold is mean absolute difference in bytes.
     */
    floorsMustDifferMeanByte: 8,
  }),

  /**
   * ⚠️ EMPTY BY DESIGN — the author fills these in, and until they do, any
   * check that would consume them reports `UNMEASURED`, never `pass`.
   *
   * Shape, when populated:
   *   { world: {x, y}, floorId: 'middle', kind: 'outdoors', expect: 'outdoors' }
   */
  authored: Object.freeze([]),
});

export default FIXTURE;
