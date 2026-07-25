/**
 * THE MASK CATALOG — the single source of truth for what world-space content
 * layers EXIST: every authored mask kind (file suffix, channels, packing,
 * absence semantics) and every derived product (sky-reach) the system serves.
 *
 * ============================================================================
 * WHY THIS FILE IS THE ONLY PLACE ALLOWED TO KNOW A MASK SUFFIX
 * ============================================================================
 *
 * V2 held this exact knowledge in at least THREE independent copies —
 * `legacy/assets/loader.js` (`EFFECT_MASKS`, with its own `_Outdoors_0`/`_1`
 * per-level hack), `legacy/masks/mask-catalog.js` (a real catalog, arrived at
 * late, synced to the loader BY COMMENT), and per-effect literals — plus
 * TWELVE hand-listed `?.setOutdoorsMask?.()` push calls fanning the results
 * out (Effects-API.md §2.2). Two mask services ran IN PARALLEL "during
 * rollout" (`_syncOutdoorsMaskConsumers` vs `MaskBindingController`,
 * docs/investigations/module-loading-investigation.md) because neither was
 * ever the only door. The knowledge being copyable is what let the copies
 * drift; the drift is what needed a 4,092-line compositor to reconcile.
 *
 * So in Keyhole this file is load-bearing in both directions:
 *   - Everything that needs a suffix, a channel assignment, a packing rule or
 *     an absence default imports it from here (boot's torture fixture AND the
 *     real-scene discovery both assemble their layer lists through
 *     `assembleLayerDescriptors` below — one assembly, two data sources).
 *   - The `masks/authority-only` tripwire (tools/verify-structure.mjs) FAILS
 *     THE BUILD on a quoted mask suffix anywhere else in src/. Adding a mask
 *     kind is a one-entry change HERE, or it is a build error THERE.
 *
 * THE TAXONOMY is the author-confirmed one (2026-07-16, recorded in
 * tools/make-torture-world.mjs and boot.js): the three SINGLE-CHANNEL masks
 * (_Shadow/_Outdoors/_Fire) channel-pack into one RGBA virtual texture
 * (R/G/B + the shared structural-hole alpha); COLOURED (_Specular/_Window)
 * and RGBA (_Tree/_Bush/_Water) masks each need their own texture. V2's
 * `_Windows`/`_Structural` survive only as DISCOVERY ALIASES of `_Window` so
 * V2-authored map folders keep working without anything else learning the old
 * names.
 *
 * V2 suffixes deliberately NOT declared yet (Stage 6 rethink rule,
 * keyhole-stage6-effects-approach: audit + rethink per effect, never a
 * mechanical port): _Roughness/_Normal/_Iridescence/_Prism/_Fluid/_Dust/_Ash.
 * The wall still reserves their literals — the day an effect needs one, its
 * declaration lands HERE (one line) or the build fails, which is the funnel
 * working as designed.
 *
 * @module scene/mask-catalog
 */

/**
 * @typedef {object} MaskKind
 * @property {string} id - catalog identity, camelCase ('outdoors', 'skyReach').
 * @property {string[]} suffixes - file suffixes, CANONICAL FIRST, discovery
 *   aliases after. A floor's art `path/base.webp` is probed/matched as
 *   `path/base<suffix>.<imageExt>`.
 * @property {'gray'|'color'|'rgba'} channels - what the file carries. 'gray'
 *   kinds are eligible for channel-packing; the others never are.
 * @property {'r'|'g'|'b'|null} packChannel - which channel of the packed trio
 *   this kind rides in, or null for unpacked kinds.
 * @property {number} absentValue - 0..1: the uniform value consumers read
 *   where a floor has NO authored file AND `required` is not set. This is the
 *   catalog owning ABSENCE semantics — V2 left "no mask" to each consumer's
 *   guess, which is why a missing `_Outdoors` meant "fully outdoors" to some
 *   effects and "fully indoors" to others depending on shader defaults.
 * @property {boolean} [required] - author directive (2026-07-21, the wind
 *   indoor/outdoor investigation): for a kind marked `required`, `absentValue`
 *   is NEVER silently served when NO file was discovered for a level —
 *   `sampleWorld`/`getDerived` THROW `RequiredMaskMissingError` instead (see
 *   mask-authority.js). This is deliberately narrower than "the mask hasn't
 *   decoded YET" (a transient streaming state, not a failure — see
 *   `authoredStatus`'s own `source` field, which distinguishes "no file was
 *   ever found" from "a file was found but its content isn't in yet"; only
 *   the FORMER throws). Absent for every OTHER kind — an unpainted `_Fire` or
 *   `_Water` mask staying a harmless default is still correct; only
 *   `outdoors` has been declared a hard content requirement.
 * @property {boolean} [rasterize] - the authority rasterizes this AUTHORED
 *   kind into its own per-floor grid, served by `getDerived(kind.id, floor)`
 *   and extracted at decode time, EVEN IF no `DerivedKind` lists it as an
 *   input.
 *
 *   Before this flag (2026-07-25) the rule was implicit and wrong in one
 *   direction: `extractionPlanForLayer` extracted a kind only if some
 *   `DerivedKind` named it, so `outdoors` rode along purely because `skyReach`
 *   happens to consume it — and `mask-authority.js#getDerived`'s own doc had to
 *   say "currently 'outdoors' only" about a behaviour nothing declared. The
 *   rule that was actually wanted is "some CONSUMER needs this authored grid
 *   directly", and a GPU consumer is a consumer: the water body pack
 *   (docs/planning/Water.md §5.1) bakes its distance field from the raw
 *   `water` grid and feeds no CPU derivation at all. Adding a sham
 *   `DerivedKind` to make the extraction happen would have been a lie in the
 *   catalog; declaring the real property is one word.
 * @property {string} meaning - the polarity, spelled out. White = ?
 */

/**
 * Every AUTHORED mask kind the system knows. Array order is only for stable
 * iteration/reporting; nothing keys on position.
 * @type {ReadonlyArray<MaskKind>}
 */
export const MASK_KINDS = Object.freeze([
  {
    id: 'shadow',
    suffixes: ['_Shadow'],
    channels: 'gray',
    packChannel: 'r',
    absentValue: 1,
    meaning: 'white = lit, black = hand-painted shadow. Absent = nothing painted dark (fully lit).',
  },
  {
    id: 'outdoors',
    suffixes: ['_Outdoors'],
    channels: 'gray',
    packChannel: 'g',
    absentValue: 1,
    required: true,
    // Was already true in behaviour, declared by nothing — see `rasterize`'s
    // own doc. `skyReach` consuming it made the extraction happen by accident.
    rasterize: true,
    meaning:
      'white = outdoors, black = indoors. REQUIRED (2026-07-21, author directive): a level with no ' +
      'discovered `_Outdoors` file no longer silently serves `absentValue` — sampleWorld/getDerived THROW ' +
      '(RequiredMaskMissingError) for `outdoors` and for anything derived from it (skyReach). This reverses ' +
      'the earlier "the whole floor is outdoors" default: that silent fallback is exactly what let a stale ' +
      'wind-exposure snapshot read a genuinely-indoors, correctly-painted room as fully outdoors without ' +
      'anyone finding out. Painting the mask is not optional; a future guided in-app dialogue will walk a ' +
      'GM through painting it when this is thrown (not built yet — fail loud is the interim behaviour).',
  },
  {
    id: 'fire',
    suffixes: ['_Fire'],
    channels: 'gray',
    packChannel: 'b',
    absentValue: 0,
    meaning: 'white = fire-spawn region, black = none. Absent = no fire anywhere.',
  },
  {
    id: 'specular',
    suffixes: ['_Specular'],
    channels: 'color',
    packChannel: null,
    absentValue: 0,
    meaning: 'COLOURED metallic shine tint. Absent = no specular response.',
  },
  {
    id: 'window',
    suffixes: ['_Window', '_Windows', '_Structural'],
    channels: 'color',
    packChannel: null,
    absentValue: 0,
    meaning:
      'COLOURED window-light regions. `_Windows`/`_Structural` are V2 aliases accepted by discovery ' +
      'only — everything downstream knows this kind solely as `window`.',
  },
  {
    id: 'tree',
    suffixes: ['_Tree'],
    channels: 'rgba',
    packChannel: null,
    absentValue: 0,
    meaning: 'RGBA canopy colour + coverage alpha. Absent = no canopy.',
  },
  {
    id: 'bush',
    suffixes: ['_Bush'],
    channels: 'rgba',
    packChannel: null,
    absentValue: 0,
    meaning: 'RGBA bush colour + coverage alpha. Absent = no bushes.',
  },
  {
    id: 'water',
    suffixes: ['_Water'],
    channels: 'rgba',
    packChannel: null,
    absentValue: 0,
    // The water body pack (Water.md §5.1) bakes its jump-flood distance field
    // from this grid on the GPU. It feeds no CPU derivation, which is exactly
    // the case `rasterize` exists to declare.
    rasterize: true,
    meaning:
      'Water DATA mask (docs/planning/Water.md §5.1). R = depth, and R DOUBLES AS PRESENCE — R>0 is ' +
      'water this deep, R=0 is land. That is why one channel is enough for the body pack: the ' +
      'jump-flood seeds its shore from where R crosses zero and reads depth01 from the same fetch. ' +
      "G (authored shore band) is V2's idea and is deliberately NOT read — the SDF gives a shore band " +
      'of any width for free, which is the whole point of storing distance. Absent = no water.',
  },
]);

/**
 * The packed single-channel trio: ONE virtual texture carrying three gray
 * masks in R/G/B + the shared structural-hole alpha (identical across a
 * floor's masks by authoring invariant — see decode-pool.js
 * `acquirePackedPages`). The layer NAME is what the renderer's pack map and
 * the debug panel's layer cycler show.
 */
export const PACKED_TRIO_LAYER_NAME = 'ShadowOutdoorsFire';

/**
 * @typedef {object} DerivedKind
 * @property {string} id
 * @property {string[]} inputs - what it is computed FROM: authored kind ids,
 *   the reserved token 'albedo' (art opacity), or a PREVIOUSLY DECLARED
 *   derived id. Declaration order is evaluation order — same rule as
 *   graph/passes.js, so a cycle is impossible to even write down.
 * @property {number} absentValue - 0..1 read outside the derived grid / before
 *   any input has arrived.
 * @property {string} meaning
 */

/**
 * Every DERIVED product the authority serves. These have no file on disk —
 * they are computed from authored masks + art opacity, per floor, at a fixed
 * small resolution (never world-res; see scene/mask-derive.js).
 *
 * `coverAbove` is the author's literal question ("I'm on the ground floor —
 * are there any opaque art layers above me?"); `skyReach` is V2's proven
 * effect-facing product (`legacy/masks/mask-catalog.js`:
 * `outdoors ∧ ¬union(upper alphas)`), kept with the same polarity.
 *
 * @type {ReadonlyArray<DerivedKind>}
 */
export const DERIVED_KINDS = Object.freeze([
  {
    id: 'coverAbove',
    inputs: ['albedo'],
    absentValue: 0,
    meaning:
      'white = some opaque art at/above this floor’s ceiling elevation covers this texel ' +
      '(upper-floor grounds, this floor’s own roof art, overhead tiles). Black = nothing above.',
  },
  {
    id: 'skyReach',
    inputs: ['outdoors', 'coverAbove'],
    absentValue: 1,
    meaning:
      'white = open sky reaches this texel on this floor: outdoors × (1 − coverAbove). ' +
      'Drives sun visibility, weather spawn, sky ambient. V2: SkyReachShadowsEffectV2, now a served product.',
  },
  {
    id: 'casterHeight',
    inputs: ['outdoors', 'albedo'],
    absentValue: 0,
    meaning:
      'THE OCCLUDER HEIGHT FIELD (docs/planning/Sun-Shadows.md): how tall the thing standing between ' +
      'this texel and the sun is, in world px above THIS floor, packed as three independent producers — ' +
      'R building (the dark of outdoors), G overhead (this floor’s raised tiles), B sky-reach (art above ' +
      'this floor’s ceiling). Black = open to the sky. One field, one march; the three "shadow systems" ' +
      'V2 kept separate are three channels here.',
  },
]);

/**
 * `casterHeight` stores world pixels as a BYTE, so it needs a scale. Every
 * consumer multiplies the 0..255 byte by (this / 255) to get world px.
 *
 * Chosen rather than probed: 2048 px is ~20 grid squares at a default 100px
 * grid — taller than any building anyone paints on a battlemap, and a shadow
 * whose caster is taller than that is off the map anyway. A single fixed
 * constant beats a per-scene max because a per-scene max makes the SAME
 * building quantise differently on two maps (memory:
 * feedback_probed_constants_vs_derived — a voted-at-runtime constant is its own
 * bug class). Quantisation at this scale is 8 px per step, well under the
 * coarse grid's own ~31 px texel.
 */
export const CASTER_HEIGHT_SCALE_PX = 2048;

/** Reserved derivation-input token: art opacity (not a mask file). */
export const ALBEDO_INPUT = 'albedo';

/**
 * Validate the whole catalog as data — the passes.js discipline applied here:
 * a malformed catalog is a BUILD error (the Node suite runs this), never a
 * runtime surprise.
 *
 * @param {ReadonlyArray<MaskKind>} [kinds]
 * @param {ReadonlyArray<DerivedKind>} [derived]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateMaskCatalog(kinds = MASK_KINDS, derived = DERIVED_KINDS) {
  const errors = [];
  const fail = (m) => errors.push(m);

  const ids = new Set();
  const suffixOwners = new Map(); // suffix -> kind id
  const packChannels = new Map(); // 'r'|'g'|'b' -> kind id

  for (const k of kinds) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k.id ?? '')) fail(`kind id '${k.id}' must be camelCase`);
    if (ids.has(k.id)) fail(`duplicate kind id '${k.id}'`);
    ids.add(k.id);

    if (!Array.isArray(k.suffixes) || k.suffixes.length === 0) {
      fail(`${k.id}: needs at least one suffix`);
    } else {
      for (const s of k.suffixes) {
        if (!/^_[A-Z][a-zA-Z]*$/.test(s)) fail(`${k.id}: suffix '${s}' must look like '_PascalCase'`);
        if (suffixOwners.has(s)) fail(`suffix '${s}' claimed by both '${suffixOwners.get(s)}' and '${k.id}'`);
        suffixOwners.set(s, k.id);
      }
    }

    if (!['gray', 'color', 'rgba'].includes(k.channels)) fail(`${k.id}: unknown channels '${k.channels}'`);
    if (k.packChannel != null) {
      if (k.channels !== 'gray') fail(`${k.id}: only 'gray' kinds may channel-pack (author-confirmed taxonomy)`);
      if (!['r', 'g', 'b'].includes(k.packChannel)) fail(`${k.id}: packChannel '${k.packChannel}' invalid`);
      if (packChannels.has(k.packChannel)) {
        fail(`pack channel '${k.packChannel}' claimed by both '${packChannels.get(k.packChannel)}' and '${k.id}'`);
      }
      packChannels.set(k.packChannel, k.id);
    }
    if (!(k.absentValue >= 0 && k.absentValue <= 1)) fail(`${k.id}: absentValue must be 0..1`);
    if (k.required !== undefined && typeof k.required !== 'boolean') fail(`${k.id}: required must be a boolean`);
    if (k.rasterize !== undefined && typeof k.rasterize !== 'boolean') fail(`${k.id}: rasterize must be a boolean`);
    if (!k.meaning || k.meaning.length < 10) fail(`${k.id}: must state its polarity/meaning`);
  }

  // The trio is all-or-nothing as a DECLARATION: either no kind packs, or
  // exactly r+g+b are each claimed once (acquirePackedPages needs all three).
  if (packChannels.size !== 0 && packChannels.size !== 3) {
    fail(`packed trio incomplete: channels declared = [${[...packChannels.keys()].join(',')}] — need r,g,b or none`);
  }

  const known = new Set([ALBEDO_INPUT, ...ids]);
  for (const d of derived) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(d.id ?? '')) fail(`derived id '${d.id}' must be camelCase`);
    if (known.has(d.id)) fail(`derived id '${d.id}' collides with an existing kind/input`);
    if (!Array.isArray(d.inputs) || d.inputs.length === 0) fail(`${d.id}: derived kind must declare inputs`);
    for (const input of d.inputs ?? []) {
      if (!known.has(input)) {
        fail(
          `${d.id}: input '${input}' unknown (must be an authored kind, '${ALBEDO_INPUT}', or an EARLIER derived id)`
        );
      }
    }
    if (!(d.absentValue >= 0 && d.absentValue <= 1)) fail(`${d.id}: absentValue must be 0..1`);
    known.add(d.id);
  }

  return { ok: errors.length === 0, errors };
}

/** @param {string} id @returns {MaskKind|null} */
export function maskKindById(id) {
  return MASK_KINDS.find((k) => k.id === id) ?? null;
}

/** @param {string} id @returns {DerivedKind|null} */
export function derivedKindById(id) {
  return DERIVED_KINDS.find((d) => d.id === id) ?? null;
}

/** The three kinds of the packed trio, keyed by their channel. @returns {{r:MaskKind,g:MaskKind,b:MaskKind}|null} */
export function packedTrioKinds() {
  const r = MASK_KINDS.find((k) => k.packChannel === 'r');
  const g = MASK_KINDS.find((k) => k.packChannel === 'g');
  const b = MASK_KINDS.find((k) => k.packChannel === 'b');
  return r && g && b ? { r, g, b } : null;
}

/**
 * Assemble the renderer's extra-layer descriptors for one floor from "which
 * kinds were found, at which URL" — THE one assembly both the torture fixture
 * and real-scene discovery go through, so packing policy exists exactly once.
 *
 * Packing policy: the trio packs IFF ALL THREE members were found (the
 * compositor needs three real files — there is no way to synthesize an absent
 * channel at decode time without inventing a fake source). A partial trio
 * ships each found member as its own ordinary single-file pack: slightly more
 * packs, exactly correct content, and the absence stays a reportable fact
 * instead of a silently-invented channel.
 *
 * @param {Map<string, string>|Record<string, string>} urlByKindId - kind id -> resolved URL (found kinds only).
 * @returns {Array<{name:string, url:string}|{name:string, channelUrls:{r:string,g:string,b:string}}>}
 */
export function assembleLayerDescriptors(urlByKindId) {
  const get = (id) =>
    urlByKindId instanceof Map
      ? urlByKindId.get(id)
      : Object.prototype.hasOwnProperty.call(urlByKindId, id)
        ? urlByKindId[id]
        : undefined;

  const descriptors = [];
  const trio = packedTrioKinds();
  const packedIds = new Set();

  if (trio) {
    const r = get(trio.r.id);
    const g = get(trio.g.id);
    const b = get(trio.b.id);
    if (r && g && b) {
      descriptors.push({ name: PACKED_TRIO_LAYER_NAME, channelUrls: { r, g, b } });
      packedIds.add(trio.r.id).add(trio.g.id).add(trio.b.id);
    }
  }

  for (const kind of MASK_KINDS) {
    if (packedIds.has(kind.id)) continue;
    const url = get(kind.id);
    if (url) descriptors.push({ name: kind.id, url });
  }
  return descriptors;
}

/**
 * Every authored kind whose own grid some consumer needs — the union of what
 * the CPU derivations read and what `rasterize: true` declares. This IS the
 * extraction set; see `MaskKind.rasterize` for why the two halves are
 * genuinely different questions and why neither subsumes the other.
 *
 * @param {ReadonlyArray<MaskKind>} [kinds] @param {ReadonlyArray<DerivedKind>} [derived]
 * @returns {Set<string>} kind ids, plus possibly the `albedo` input token.
 */
export function wantedContentIds(kinds = MASK_KINDS, derived = DERIVED_KINDS) {
  const wanted = new Set();
  for (const d of derived) for (const input of d.inputs) wanted.add(input);
  for (const k of kinds) if (k.rasterize) wanted.add(k.id);
  return wanted;
}

/**
 * What the authority should EXTRACT from a decoded page of a given layer.
 * Maps the renderer's layer name back to catalog content: the packed trio
 * carries three kinds (one per channel); an unpacked mask's content is its R
 * channel; albedo's coverage is its alpha. Kinds nothing consumes are simply
 * not extracted.
 *
 * ⚠️ **R, for an `rgba` kind too.** `water` is an RGBA file and only its R
 * survives this extraction. That is correct and deliberate rather than a gap:
 * R carries depth AND presence (see the `water` kind's own `meaning`), which
 * is everything the body pack needs. A kind that genuinely needed a second
 * channel on the CPU would extend this plan to return two entries — the shape
 * already supports it (the packed trio returns three).
 *
 * @param {string} layerName - 'albedo', PACKED_TRIO_LAYER_NAME, or a kind id.
 * @returns {Array<{contentId: string, channel: 'r'|'g'|'b'|'a'}>}
 */
export function extractionPlanForLayer(layerName) {
  const wanted = wantedContentIds();

  if (layerName === 'albedo') {
    return wanted.has(ALBEDO_INPUT) ? [{ contentId: ALBEDO_INPUT, channel: 'a' }] : [];
  }
  if (layerName === PACKED_TRIO_LAYER_NAME) {
    const trio = packedTrioKinds();
    if (!trio) return [];
    return ['r', 'g', 'b']
      .filter((ch) => wanted.has(trio[ch].id))
      .map((ch) => ({ contentId: trio[ch].id, channel: /** @type {'r'|'g'|'b'} */ (ch) }));
  }
  const kind = maskKindById(layerName);
  if (kind && wanted.has(kind.id)) {
    return [{ contentId: kind.id, channel: 'r' }];
  }
  return [];
}

/** Every authored kind the authority rasterizes into its own per-floor grid.
 * @param {ReadonlyArray<MaskKind>} [kinds] @returns {ReadonlyArray<MaskKind>} */
export function rasterizedKinds(kinds = MASK_KINDS) {
  return kinds.filter((k) => k.rasterize === true);
}
