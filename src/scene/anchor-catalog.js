/**
 * THE ANCHOR CATALOG — the single source of truth for what DISCRETE point
 * effects exist: every anchor KIND (its consuming effect, the per-anchor knobs
 * a single placed instance carries, and the V2 map-point `effectTarget`
 * string(s) it imports from).
 *
 * ============================================================================
 * WHAT AN ANCHOR IS (the author's mental model)
 * ============================================================================
 *
 * "Paint for regions, place for anchors" (docs/planning/Authoring-and-
 * Distribution.md §2). Most of what V2's Map Points did — "this hearth is on
 * fire" — is really a PAINTED region and belongs to the mask authority. What is
 * left is the genuinely DISCRETE: a single candle flame, one lightning strike
 * point, the endpoints of a rope. Those are ANCHORS — locators you place, that
 * an effect parents itself to. This catalog is the "place" sibling of
 * scene/mask-catalog.js's "paint".
 *
 * ============================================================================
 * WHY THIS IS THE ONLY PLACE ALLOWED TO KNOW AN ANCHOR KIND ↔ V2 STRING
 * ============================================================================
 *
 * The V2 → V3 importer (foundry/v2-anchor-import.js) must translate the old
 * `effectTarget: 'candleFlame'` string into a V3 anchor kind. If that mapping
 * lived in the importer, and the effect knew its own default intensity, and the
 * UI knew the label, we would have three copies of one fact — exactly the drift
 * the mask catalog's own header catalogues (V2 held mask-suffix knowledge in
 * THREE places and needed a 4,092-line compositor to reconcile the copies). So
 * the mapping is DATA here, validated in Node, and `foundry/` (a leaf that may
 * not import `scene/`) receives the translation from boot rather than knowing
 * the strings itself.
 *
 * TAXONOMY, TIER 0: `candleFlame` — the canonical discrete anchor (one spot,
 * one flame) and the first V2 effect brought across (author directive,
 * 2026-07-20). Rope spans and the rest land as one entry each here the day
 * their effect is ported — or the importer cannot map them, which is the
 * funnel working as designed.
 *
 * TIER 1: `lightning` — a forked-bolt SOURCE is two LINKED anchors (one
 * `role:'start'`, one `role:'end'`, sharing a `params.linkId`), not a single
 * point. The core anchor schema (scene/anchor-authority.js) stays untouched
 * on purpose — `ui/anchor-mode.js`'s own header promises a future lightning
 * tool "reuses this file verbatim, with its own icon," which only holds if a
 * bolt endpoint is an ordinary single-point anchor like any other. Pairing
 * is done ENTIRELY above this layer (boot.js's two-click placement wrapper;
 * effects/lightning-geometry.js#groupLightningAnchorsIntoSources on the read
 * side) — this catalog only adds the `role`/`linkId` per-anchor params a
 * `lightning` anchor carries.
 *
 * @module scene/anchor-catalog
 */

import { validateParamsSchema } from '../core/params-schema.js';

/**
 * @typedef {object} AnchorKind
 * @property {string} id - catalog identity, camelCase ('candleFlame').
 * @property {string} effectId - the registry effect id (effects/registry.js)
 *   that renders anchors of this kind. Its own manifest id.
 * @property {string} label - human name (UI + reports).
 * @property {string} [icon] - a single glyph (emoji) representing this kind's
 *   placed instances on the map — the click/drag handle `ui/anchor-mode.js`
 *   renders per anchor (2026-07-22, author: "a unique icon for every effect,
 *   use that as a way to select them"). Optional so a future kind that forgets
 *   one still works — the renderer falls back to a generic pin, never breaks.
 * @property {string[]} v2EffectTargets - the V2 map-point `effectTarget`
 *   strings that import INTO this kind. THE only place the old strings live;
 *   a target string belongs to exactly one kind (checked below).
 * @property {string} [importStrategy] - how `foundry/v2-anchor-import.js`
 *   turns one V2 map-point GROUP into anchors of this kind. Absent (the
 *   default) flattens every point in the group into its own independent
 *   anchor (candle's own behaviour). `'linkedEndpoints'` instead emits a
 *   `role:'start'`/`role:'end'` pair sharing one `linkId` from the group's
 *   first/last point (a `lightning` bolt's two endpoints); any interior
 *   points import as inert `role:'waypoint'` anchors on the same `linkId` —
 *   preserved, not acted on (the deferred `wandering-source` rung,
 *   effects/lightning.js). Per-kind DATA, not a shared-code branch — see
 *   this file's own header for why that split matters.
 * @property {Record<string, object>} params - the per-anchor param schema
 *   (core/params-schema.js): what a single placed instance carries BEYOND its
 *   position. Validated at ingest, so nothing invalid is ever served — the
 *   authored-content twin of the effect-param write-path check (Params.md §2).
 * @property {string} meaning - what this kind is, one line.
 */

/**
 * Every anchor KIND the system knows. Array order is only for stable
 * iteration/reporting; nothing keys on position.
 * @type {ReadonlyArray<AnchorKind>}
 */
export const ANCHOR_KINDS = Object.freeze([
  {
    id: 'fire',
    effectId: 'fire',
    label: 'Fire',
    icon: '🔥',
    v2EffectTargets: [],
    noV2Ancestor:
      "V2's `fire` map-point target (legacy/scene/map-points-manager.js:48) is OVERLOADED and cannot be " +
      'imported as a point anchor. It did two unrelated jobs: it GATED painted mask regions on/off ' +
      '(FireEffectV2#filterFirePointsByMapPointGates) and it placed authored world/area/line fire ' +
      'sources. Claiming it here would turn every region gate an author ever set into a spurious point ' +
      'fire. The painted mask carries V2 fire across instead, which is where V2 kept nearly all of it.',
    params: {
      // ⚠️ THE ONLY SIZE KNOB, AND EVERYTHING FOLLOWS FROM IT.
      // Puff frequency (1.5/√D), plume height, laminar-vs-turbulent silhouette,
      // smoke production, light radius and flicker depth are all DERIVED from
      // this one number in `effects/fire/fire-geometry.js#fireScaleChain`. That
      // is why there is no "flicker speed" slider here: a control that let you
      // give a bonfire a candle's flicker rate would only ever be a way to stop
      // it reading as a fire.
      //
      // The pixel values are not intuitive. At 100 px per 5 ft, ONE PIXEL IS
      // 15 mm — so a 1 m campfire is ~66 px, a 3 m bonfire ~200 px, and a 10 m
      // burning building ~660 px. (A real candle flame is 8 mm ≈ half a pixel,
      // which is exactly why the candle stays its own effect.)
      diameterPx: {
        type: 'float',
        min: 4,
        max: 2000,
        step: 2,
        default: 120,
        label: 'Fire size',
        help: 'How wide the fire is, in canvas pixels. Everything else follows from this — a small fire flickers fast, stands tall and burns clean; a big one pulses slowly, sits squat and breaks into many billowing lobes.',
      },
      intensity: {
        type: 'float',
        min: 0,
        max: 2,
        step: 0.05,
        default: 1,
        label: 'Intensity',
        help: 'How hard this particular fire burns, on top of its size. Below 1 banks it toward embers.',
      },
      fuel: {
        type: 'enum',
        values: ['wood', 'coal', 'oil', 'magical'],
        default: 'wood',
        label: 'Fuel',
        help: 'What this fire is burning. Overrides the effect-wide default for this one fire.',
      },
      // Same shape and same reasoning as the candle's own `elevation` below —
      // world units above this anchor's floor band, never a replacement for it.
      elevation: {
        type: 'float',
        min: 0,
        max: 50,
        step: 1,
        default: 0,
        label: 'Height off floor',
        help: 'How far above its floor this fire sits — a brazier on a table rather than a fire on the ground. Feeds the depth authority, so a fire on a table is occluded by what a fire on the floor would be.',
      },
      useCustomColor: {
        type: 'bool',
        default: false,
        label: 'Custom colour',
        help: 'Give this one fire its own flame tint instead of the effect-wide one.',
      },
      customColor: {
        type: 'color',
        space: 'srgb',
        default: '#fdba35',
        label: 'Flame colour',
        help: 'This fire’s own tint. Only used when “Custom colour” is on.',
      },
      floorVisibility: {
        type: 'enum',
        values: ['own-floor', 'own-and-above', 'all-floors'],
        default: 'own-and-above',
        label: 'Seen from',
        help: 'Which floors this fire is considered on. A hearth is usually visible from the floor above through a stairwell; a sealed furnace is not.',
      },
    },
    meaning:
      'A discrete fire: a brazier, a hearth, a campfire, a burning wagon. The painted fire mask is the ' +
      'other source — it derives each blob’s size from the painted region itself — and the two feed the ' +
      'same shader. Use an anchor when you want an exact size in an exact spot.',
  },
  {
    id: 'candleFlame',
    effectId: 'candleFlame',
    label: 'Candle flame',
    icon: '🕯️',
    // V2's EFFECT_SOURCE_OPTIONS key (legacy/scene/map-points-manager.js:49).
    v2EffectTargets: ['candleFlame'],
    params: {
      intensity: {
        type: 'float',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1,
        label: 'Flame intensity',
        help: 'How strongly this candle burns (0 = out, 1 = full). Imported from a V2 group’s emission.intensity.',
      },
      // HEIGHT OFF THE FLOOR (2026-08-05, author-reported: depth-authority
      // occlusion revealed that no candle has ever authored a real z-height —
      // its flame and the light it casts both silently assumed "sits right on
      // its own floor's ground", which a candle on an upper floor's own art
      // could then occlude). World/scene elevation units — same units as a
      // real Foundry AmbientLight's own `elevation` field — ADDED to this
      // candle's `floorBinding.bottom` (see effects/candle-flame-geometry.js's
      // `resolveAnchorElevationWorldUnits`), never a replacement for it: a
      // candle still belongs to its floor's band, this just says how far
      // above that band's own ground it sits. Always its own value, no
      // `useCustomX` gate — unlike colour/size/light-reach there is no
      // effect-wide shared "candle height" to inherit from (every candle's
      // honest default is 0, matching `intensity`'s own always-own-value
      // shape, not the inheritable pairs below).
      elevation: {
        type: 'float',
        min: 0,
        max: 50,
        step: 1,
        default: 0,
        label: 'Height off floor',
        help: 'How far above its own floor’s ground this candle’s flame and light sit. 0 = right on the floor. Affects which floors can see or occlude it.',
      },
      // PER-CANDLE OVERRIDES (2026-07-22, author directive via the debug-panel
      // FOH/ROH build: "can we individually recolour candles? things like
      // that" — answered yes, and extended to size + light reach on the
      // author's own pick). Each is a `useCustomX`/`customX` PAIR rather than
      // a nullable value: `core/params-schema.js` has no "unset" sentinel (a
      // color must always be a valid #rrggbb), so "inherit the effect-wide
      // value" is expressed as an explicit bool gate, never an implied one.
      // The renderer (effects/candle-flame-render.js#resolveAnchorColorHex
      // et al.) reads the pair; when the gate is off the effect-wide
      // CANDLE_FLAME_PARAMS value wins, so a scene with zero customised
      // candles renders byte-identical to today.
      useCustomColor: {
        type: 'bool',
        default: false,
        label: 'Custom colour',
        help: 'Give this one candle its own flame colour instead of the shared one every candle uses.',
      },
      customColor: {
        type: 'color',
        space: 'srgb',
        default: '#ffaa00',
        label: 'This candle’s colour',
        help: 'Only used when "Custom colour" is on.',
      },
      useCustomSize: {
        type: 'bool',
        default: false,
        label: 'Custom size',
        help: 'Give this one candle its own flame size instead of the shared one every candle uses.',
      },
      customSizePx: {
        type: 'float',
        min: 1,
        max: 400,
        step: 1,
        default: 24,
        label: 'This candle’s flame size',
        help: 'Only used when "Custom size" is on. Same units as the shared "Flame size" control.',
      },
      useCustomLightRadius: {
        type: 'bool',
        default: false,
        label: 'Custom light reach',
        help: 'Give this one candle its own light radius instead of the shared one every candle uses.',
      },
      customLightRadiusPx: {
        type: 'float',
        min: 0,
        max: 2000,
        step: 1,
        default: 400,
        label: 'This candle’s light reach',
        help: 'Only used when "Custom light reach" is on. Same units as the shared "Light reach" control.',
      },
      // CROSS-FLOOR VISIBILITY (2026-08-01, author-reported: candles on a
      // ground-floor element vanish entirely — light AND shape — the moment you
      // move up a floor, even where a hole in the upper floor should expose
      // them). The machinery to keep them was already here (`floorBinding`,
      // ported from V2's LevelBinding) but NOTHING author-facing drove it: the
      // binding arrives from the V2 importer and the edit UI only ever reached
      // `params`. So a candle bound to the ground floor was unfixable by hand.
      //
      // ⚠️ WHY THIS IS A CONTROL AND NOT AUTOMATIC, IN THE AUTHOR'S OWN WORDS:
      // *"we put the onus on getting this right into the user hand rather than
      // complex code."* Deciding automatically would mean asking "is there a
      // hole in the floor above this candle, and can it be seen through from
      // here" — real occlusion geometry, for a handful of decorative flames.
      // The flame also draws in its OWN scene (`candleFlameScene`), outside the
      // draw list's sort law, so a candle shown from another floor is NOT
      // occluded by that floor's art — it would shine straight through solid
      // stone. That is precisely why the DEFAULT below must stay 'own-floor':
      // any other default would trade a missing candle for a candle visible
      // through a floor, on every existing scene, unasked.
      floorVisibility: {
        type: 'enum',
        values: ['own-floor', 'own-and-above', 'all-floors'],
        default: 'own-floor',
        label: 'Visible from',
        help: 'Which floors this candle can be seen from. "Own floor" shows it only on the floor it belongs to. "Own and above" also shows it when you are looking down from a higher floor — use this for a candle meant to be seen through a stairwell or a hole in the floor above. "All floors" always shows it. Note that a candle seen from another floor is not hidden by that floor\'s artwork, so only enable it where the candle really should be visible.',
      },
      // AUTO-IGNITE OPT-OUT (2026-08-06, author's own choice between two
      // offered designs: "yes, per-candle opt-out" over "no exceptions") —
      // this candle's own participation in the effect-wide day/night dice
      // roll (effects/candle-flame.js's `autoIgniteEnabled` and its two
      // chance sliders). Default TRUE: once a GM turns the effect-wide
      // switch on, the whole point is "some candles turn on and off
      // automatically" for the room as a lived-in whole — a candle should
      // have to be singled out to be EXCLUDED, not the other way round.
      // Purely a gate on whether the SYSTEM may touch `enabled` — with this
      // off (or the effect-wide switch off), this candle's own `enabled` is
      // exactly what the "Lit" checkbox above says and nothing else ever
      // moves it, letting a GM pin one story-important candle on or off
      // while the rest of the room still flickers to life on its own.
      autoIgnite: {
        type: 'bool',
        default: true,
        label: 'Auto-ignite',
        help: 'Let the effect-wide day/night chances (Candle flames panel → Advanced → Presence) decide whether THIS candle is lit. Turn off to pin this one candle to whatever "Lit" above says, ignoring the roll — for a candle that matters to the story and should never flicker on its own.',
      },
    },
    meaning: 'A single placed candle flame — the canonical discrete anchor, successor to a V2 candleFlame map point.',
  },
  {
    id: 'lightning',
    effectId: 'lightning',
    label: 'Lightning bolt',
    icon: '⚡',
    // V2's EFFECT_SOURCE_OPTIONS key (legacy/scene/map-points-manager.js:49).
    v2EffectTargets: ['lightning'],
    importStrategy: 'linkedEndpoints',
    params: {
      role: {
        type: 'enum',
        values: ['start', 'end', 'waypoint'],
        default: 'start',
        label: 'Endpoint role',
        help: 'Which end of the bolt this point is. Two endpoints sharing the same link id form one lightning source.',
      },
      linkId: {
        type: 'text',
        default: '',
        maxLength: 128,
        label: 'Bolt link id',
        help: 'Ties this point to its partner endpoint. Set automatically when you place a bolt.',
      },
      intensity: {
        type: 'float',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1,
        label: 'Strike intensity',
        help: 'How strongly this source strikes (0 = never fires, 1 = full). Imported from a V2 group’s emission.intensity.',
      },
      // HEIGHT OFF THE FLOOR (2026-08-05) — the SAME depth-authority field
      // candle's own `elevation` above just added, on the SAME "world/scene
      // elevation units, ADDED to floorBinding.bottom" convention
      // (effects/lightning-geometry.js's resolveAnchorElevationWorldUnits
      // caller). Declared on the anchor KIND (both endpoints can technically
      // carry a value, matching the schema shape every other per-anchor
      // param uses), but only the START endpoint's value is what the bolt
      // actually strikes at — `groupLightningAnchorsIntoSources`'s own doc
      // explains why (a strike travels start→end, so the origin's own floor
      // is the more honest single answer when the two anchors would
      // disagree). `boot.js#buildLightningEditForm` shows this SAME control
      // (reading/writing the start anchor's value) from EITHER endpoint's own
      // popup, so an author never has to remember which end "really" owns it.
      //
      // ⚠️ DEFAULT IS NOT 0 (2026-08-05, author's own ask, after a live bolt
      // sitting at elevation 0 turned out to be indistinguishable from "never
      // configured" and was hard to reason about) — `boot.js#
      // addLightningEndpoint` computes a real, whole-number, roughly-half-
      // of-the-floor's-own-band default at placement time
      // (`lightning-geometry.js#defaultLightningElevation`), never zero. The
      // flat `default` below is only the FALLBACK for a path that skips that
      // computation entirely (a V2-imported bolt, which never had this
      // concept to begin with) — still a modest, clearly-nonzero guess, for
      // the exact same reason.
      elevation: {
        type: 'float',
        min: 0,
        max: 50,
        step: 1,
        default: 10,
        label: 'Height off floor',
        help: 'How far above its own floor’s ground this bolt sits — one shared height for the whole bolt, editable from either endpoint’s menu. Affects which floors can see or occlude this bolt.',
      },
      // CROSS-FLOOR VISIBILITY (2026-08-05, author-reported: a bolt placed on
      // one floor disappeared completely the moment they moved the view up a
      // floor). Mirrors candle's OWN identical fix just above — same param,
      // same three-way enum, same generic read side (`anchor-authority.js#
      // floorMatches`, unchanged, already reads `a.params?.floorVisibility`
      // for ANY kind).
      //
      // ⚠️ ELIGIBILITY ONLY — this does NOT bypass occlusion, on any floor,
      // including a "wrong" one. A ROUND-1 fix here tried to also bypass the
      // render-side rank gate whenever the viewed floor differed from the
      // bolt's own (reasoning: the depth-authority draw list is scoped to
      // the viewed floor, so a lower-floor bolt would always rank beneath
      // it). Author caught this immediately, live: *"A lightning bolt on the
      // ground floor is fully visible when viewing an upper floor, even if
      // it should be occluded by the ground below."* That bypass was WRONG,
      // not just incomplete: the un-special-cased rank gate ALREADY answers
      // this correctly on its own — real content on the viewed floor
      // legitimately outranks a lower bolt (correctly occludes it), and an
      // unwritten texel (a hole, a courtyard, a gap) correctly falls open
      // and lets it through, the SAME fail-open guarantee point lights
      // already rely on with zero special-casing. `vt-pan-viewer.js`'s
      // lightning `resolveExpectedDepth` closure is now byte-identical in
      // shape to pointLights' own — see that file's own "ROUND 2" comment.
      //
      // ⚠️ ROUND 3, SAME DAY — the DEFAULT was 'all-floors' and that was
      // ALSO wrong, for a THIRD, distinct reason (not a repeat of ROUND 1):
      // `floorMatches` treats 'all-floors' as a full opt-out — it returns
      // `true` BEFORE the `e < binding.bottom` check runs at all, so a bolt
      // was offered to the renderer even on a floor genuinely BELOW its own.
      // Once offered there, the depth-authority query is scoped to ONLY that
      // floor's own (all-lower) items, so the bolt's real elevation reads as
      // higher than everything in the local list and ranks above all of it —
      // visible from underground, looking "up" through solid floors, exactly
      // what [[keyhole-orthographic-hole-stack-model]] says can never happen
      // (the camera looks straight down; there is no seeing UP through a
      // floor by construction). Author: *"we need to make sure candles,
      // lightning and everything else that is 'ABOVE' the camera's POV isn't
      // visible."* **Fix: the default is now `'own-and-above'`**, not
      // `'all-floors'` — it still reaches every floor ABOVE the bolt's own
      // (the ORIGINAL ask this param exists for, "storm visible looking down
      // from anywhere"), but it goes through the SAME `e < binding.bottom`
      // check candle already relies on, so a floor below is excluded before
      // the anchor ever reaches the renderer — no render-side change needed
      // this round, the existing, already-tested `floorMatches` logic was
      // already correct, lightning just wasn't using the right value of it.
      // `'all-floors'` remains a real, available option (matching candle's
      // own contract) for an author who explicitly wants zero vertical
      // containment on one specific bolt — just no longer the default.
      floorVisibility: {
        type: 'enum',
        values: ['own-floor', 'own-and-above', 'all-floors'],
        default: 'own-and-above',
        label: 'Visible from',
        help: 'Which floors this bolt can be considered on at all. "Own floor" only considers it on the floor it was placed on, like an ordinary local light. "Own and above" (default) also considers it looking down from any higher floor, but never from a floor below — matching a storm happening somewhere above the whole building, never visible looking up through solid floors underground. "All floors" considers it from literally anywhere, including underground, for an author who wants that specific look on one bolt. On every floor it IS considered on, it is still genuinely occluded by whatever real artwork actually covers it there; this only controls where it is eligible to be seen at all.',
      },
    },
    meaning:
      'One endpoint of a forked-lightning bolt source; two linked endpoints sharing a link id form one bolt, successor to a V2 lightning map-point group.',
  },
]);

/**
 * Validate the whole catalog as data — the mask-catalog discipline applied
 * here: a malformed anchor kind is a BUILD error (the Node suite runs this),
 * never a runtime surprise. Returns every problem at once.
 *
 * @param {ReadonlyArray<AnchorKind>} [kinds]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateAnchorCatalog(kinds = ANCHOR_KINDS) {
  const errors = [];
  const fail = (m) => errors.push(m);

  const ids = new Set();
  const v2TargetOwners = new Map(); // v2 effectTarget -> kind id

  for (const k of kinds) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k.id ?? '')) fail(`kind id '${k.id}' must be camelCase`);
    if (ids.has(k.id)) fail(`duplicate kind id '${k.id}'`);
    ids.add(k.id);

    if (!/^[a-z][a-zA-Z0-9]*$/.test(k.effectId ?? '')) {
      fail(`${k.id}: effectId '${k.effectId}' must be camelCase (it is the registry/settings key)`);
    }
    if (typeof k.label !== 'string' || k.label.length === 0) fail(`${k.id}: needs a human label`);
    // icon is OPTIONAL (a future kind that forgets one still validates —
    // ui/anchor-mode.js falls back to a generic pin), but if declared it must
    // be a real glyph, not an accidentally-empty string.
    if ('icon' in k && (typeof k.icon !== 'string' || k.icon.length === 0)) {
      fail(`${k.id}: icon, if declared, must be a non-empty string`);
    }
    if (!k.meaning || k.meaning.length < 10) fail(`${k.id}: must state its meaning`);

    // ⚠️ THE "NO V2 ANCESTOR" ESCAPE HATCH, implemented 2026-08-08 because this
    // very message already promised it and the code did not honour it — the
    // first kind that genuinely had no importable ancestor (fire) hit a
    // failure whose own text told it what to do.
    //
    // A kind may declare an EMPTY `v2EffectTargets` only alongside a
    // `noV2Ancestor` string saying why, so "nothing to import" stays a stated
    // decision rather than an omission. Fire is the case it exists for: V2's
    // `fire` map-point target was OVERLOADED — it gated painted mask regions
    // AND placed authored point sources — so importing it as a point anchor
    // would scatter spurious fires across every region gate an author ever set.
    if (!Array.isArray(k.v2EffectTargets)) {
      fail(`${k.id}: v2EffectTargets must be an array`);
    } else if (k.v2EffectTargets.length === 0) {
      if (typeof k.noV2Ancestor !== 'string' || k.noV2Ancestor.length < 20) {
        fail(
          `${k.id}: an empty v2EffectTargets needs a 'noV2Ancestor' string explaining why nothing imports ` +
            '(a missing ancestor must be a decision, not an omission)'
        );
      }
    } else {
      for (const target of k.v2EffectTargets) {
        if (typeof target !== 'string' || target.length === 0) {
          fail(`${k.id}: v2EffectTargets entries must be non-empty strings`);
          continue;
        }
        if (v2TargetOwners.has(target)) {
          fail(`V2 effectTarget '${target}' claimed by both '${v2TargetOwners.get(target)}' and '${k.id}'`);
        }
        v2TargetOwners.set(target, k.id);
      }
    }

    // Per-anchor knobs must be a real params schema — validated exactly like an
    // effect's, because they persist and travel in an adventure the same way.
    const ps = validateParamsSchema(k.params);
    if (!ps.ok) for (const e of ps.errors) fail(`${k.id}: params.${e}`);
  }

  return { ok: errors.length === 0, errors };
}

/** @param {string} id @returns {AnchorKind|null} */
export function anchorKindById(id) {
  return ANCHOR_KINDS.find((k) => k.id === id) ?? null;
}

/** @param {string} effectId @returns {AnchorKind[]} every kind a given effect consumes. */
export function anchorKindsForEffect(effectId) {
  return ANCHOR_KINDS.filter((k) => k.effectId === effectId);
}

/**
 * Translate a V2 map-point `effectTarget` string into the V3 anchor kind it
 * imports into — the importer's one lookup. Boot hands this to `foundry/`
 * (a leaf that cannot import this module) so the old strings stay known in
 * exactly one place.
 * @param {string} target @returns {AnchorKind|null}
 */
export function anchorKindByV2EffectTarget(target) {
  return ANCHOR_KINDS.find((k) => k.v2EffectTargets.includes(target)) ?? null;
}
