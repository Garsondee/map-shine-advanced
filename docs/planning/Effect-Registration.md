# EFFECT REGISTRATION — standing up the FIRST configurable effect

**Status:** PLAN, 2026-07-20 (author directive: "this is technically our first effect… it needs an entry in the graphics settings we eventually have to store for users… make this a separate configurable and optional visual effect… we recommend it only for more powerful systems"). **Rev 2, 2026-07-20** — author decisions incorporated: the Creator→GM→Player **control cascade** + accessibility hard-override (§2), games-industry **performance profiles** Low…Extreme (§2.1), and **provisionally**-off-aspiring-to-always-on (§4). The four delegated calls are resolved: **#1** don't build the reads/writes contract around UI-shadow (§1, keep); **#4** no per-effect quality enum — global quality is the profile (§2.1); **#5** parallax = elevation-scaled throw (§C1); **#6** effect id `uiWindowShadow` (§A2). **Rev 3, 2026-07-20** — a research pass through `legacy/` (author-requested "last chance to improve the plan"): the finding that V2 *already had* this cascade + schemas + central resolver and lost anyway now governs the plan, distilled into **§6 (the V2-corpse → V3-wall safeguards + the velocity test)** — the most important section. Awaiting the author's final "go" before building.

**What this is:** the bridge from the *designed* effect architecture to ONE shipped, registered, user-configurable, optional effect — pioneered by the **UI window shadow** (`docs/planning/Light-and-Shadow.md §5`). It is deliberately smaller than the full architecture: it stands up only the pieces that are universal and needed now, and records the rest as rungs.

**Companions (the target architecture this bootstraps toward):** `Effects-API.md` (the CONTRACT — reads/writes/ctx), `Effects.md` (the TIER ladder + governor), `Effects-UI.md` (the FOH/ROH generated config surface), `core/params-schema.js` (**built**).

---

## 0. The terrain — what is BUILT vs DESIGNED (measured, not assumed)

| Piece | State | Consequence for this plan |
|---|---|---|
| `core/params-schema.js` — types, `validateParamsSchema`, `validateParamValue`, `serializeParams`, `hydrateParams` | **BUILT + Node-tested** | The spine. Config + persistence already exist; we author a schema, not machinery. |
| Scene-flag storage (`foundry/paint-adapter.js` `setFlag`/`getFlag`) | **BUILT** | The per-SCENE store (authored look travels in adventures) already has a pattern to copy. |
| Foundry `init`/`ready` hooks (`boot.js`), Foundry-global-access-is-adapter-only wall | **BUILT** | `game.settings.register` must run in `init`, through a `foundry/` adapter — a home exists. |
| The UI-shadow effect itself | **BUILT** but ad-hoc: a hardcoded `_uiShadowState` object + `setUiShadow` + a debug toggle | It works; it is not yet *declared*. This plan promotes it from an object to a declaration. |
| Effect-declaration CONTRACT (`Effects-API.md`: `reads`/`writes`/`build(ctx)`, graph-derived) | **DESIGNED, not built** | Do **not** build for UI-shadow — see §1. |
| Tier GOVERNOR (`Effects.md` §6) | **DESIGNED, not built** ("built when there are ≥2 tiered effects") | The "tier" is a manual quality setting for now, not auto-measured. |
| FOH/ROH generated config UI (`Effects-UI.md`) | **DESIGNED, not built** | Stage B. The params schema (Stage A) is its prerequisite. |
| Per-client graphics settings (`game.settings.register`) | **ABSENT — zero registered in the whole module** | The one genuinely-missing *universal* piece. Every effect + the graphics-settings surface needs it. Build it now, correctly, once. |

**Reading:** "register the first effect" ≠ "build the effect architecture." It = *use the built schema spine, stand up the one missing universal store (per-client settings), give UI-shadow a declaration (schema + manifest) behind a minimal registry, and record deferrals as rungs.*

> **⚠️ THE FINDING THAT GOVERNS THIS WHOLE PLAN (2026-07-20 research):** V2 **already built every good design below** — the Creator→GM→Player cascade (`legacy/settings/scene-settings.js` line 2, verbatim), per-effect param schemas (48 of them), a central enable resolver (`resolve-effect-enabled.js`). They *lost anyway*. So the plan's real content is not the structure (V2 proves the structure is right and the author wants it) — it is the **enforcement** that makes each piece the *only, validated, decoupled* path. See **§6**, which is the most important section here; the stages exist to satisfy it.

---

## 1. Why UI-shadow is an ATYPICAL template-setter — and why that matters

UI-shadow does not look like the effects `Effects-API.md` was audited for:
- It **reads the DOM** (open window rects), not `vt:`/`buf:` graph resources. Its whole input is outside the frame graph.
- It **folds into the composite shader** (no pass of its own, post-perf-fix) rather than writing a declared buffer.
- It is **screen-space chrome**, not world content.

`Effects-API.md §6` is explicit that **water goes first** precisely because water is the hard case that proves the `reads`/`writes` contract can express real work. Building that contract around UI-shadow — which barely has graph `reads` — would set the template on the *easiest, least representative* effect and risk a contract that fits nothing else. **So this plan does NOT build the reads/writes/graph contract.** It builds the parts that are genuinely universal (params, settings, on/off, tier manifest) and leaves the contract to land with water, which will subsume the minimal registry below.

> The load-bearing lesson from `Effects-API.md §3` still binds: *a good API that is optional loses.* The minimal registry in §3 is therefore the **only** door for the things it owns (an effect's enable state, its params, its tier) — not a recommended one. It is small, but it is not optional.

---

## 2. THE CONTROL MODEL — a cascade, Creator → GM → Player (author-defined, 2026-07-20)

The author defined the control hierarchy precisely, and it is richer than a per-client/per-scene split. **Four layers, each overriding the one above, with the PLAYER always holding final say over their own experience, and ACCESSIBILITY as a hard override that even a GM cannot defeat.**

| Layer | Who | Sets | Foundry store | Travels with |
|---|---|---|---|---|
| **Standard profile** | MSA / the Creator | the baseline look of MSA itself | module-shipped default preset (schema defaults + a named profile) | the module |
| **Scene** | the Creator (artist) | this map's *deviation* from the standard profile | scene flag (`foundry/paint-adapter.js` pattern) | the ADVENTURE (`Authoring-and-Distribution.md`) |
| **World** | the GM | the default for THEIR players on this map/table | `game.settings` `scope: 'world'` | the GM's world |
| **Player** | each player | their own overrides — **final say** | `game.settings` `scope: 'client'` | the USER, across all scenes |

**Precedence for what a given player sees:** standard → scene → world (GM) → player → **accessibility override**. Each layer replaces only the values it *speaks to*; the rest fall through. This is not four stores of machinery — it is **N overlays of the ONE built engine**: each layer is a `serializeParams` diff, and load is `hydrateParams` applied in order (defaults, then each layer's diff on top). The cascade is data, not code.

**Accessibility is a hard override, first-class (author-directed, with a specific nod to photosensitivity).** A player must be able to disable classes of effect for their own safety **regardless of Creator or GM intent** — the named example is **photosensitive effects: lightning strikes, animated lighting**. So:
- every effect **manifest declares a11y class flags** (`photosensitive: boolean`, room for more — `motion`, `flashing`);
- a player-level **"reduce photosensitive effects"** switch force-disables every flagged effect and **wins over every layer above, including a GM who forced it on**. A user's safety outranks a map's look (`feedback_safety_slide_outranks_doctrine` in spirit — reliability/safety is the one thing that always slides).
- **UI-shadow is `photosensitive: false`** (it doesn't flash) — but the framework must carry the flag *now* so the effects that DO flash (lightning, animated lights) inherit the protection for free the day they land. Building the a11y override around the first, safe effect is how it becomes non-optional before the dangerous effects arrive.

## 2.1 PERFORMANCE PROFILES — the games-industry front door (author-directed)

**Two different "profiles" — keep them separate.** The word appears in both author directives with two distinct meanings, on two axes with opposite ownership:
- the **look profile** (§2, "the default profile look of MSA") — an *aesthetic* baseline, authored by the **Creator** and cascading *down* (Creator → GM → Player);
- the **performance profile** (this section, "low/performance/standard/quality/extreme") — a *hardware/quality* budget, owned by the **Player** (it is about *their* machine), with an optional GM default. It flows the opposite way: the player is the authority, because only they know what their GPU can afford.
An effect's *look* comes from the first; whether it *runs at all, and at what tier* comes from the second. Conflating them is how a scene author would end up dictating a player's frame rate — exactly what the split prevents.

The author's UX model for the performance axis, verbatim intent: users pick a **performance profile** — **Low / Performance / Standard / Quality / Extreme** — then reach for **sliders and toggles** to turn individual things down or off. That is exactly `Effects-UI.md`'s FOH/ROH split, in the language players already know:

- **The profile dropdown IS the ultimate front-of-house dial.** One control, five presets, sets the global quality budget every effect reads its tier from. Most users never go deeper — and that is the point (the F3 "intimidating to non-experts" cure).
- **Per-effect toggles + sliders are the rear of house** — turn *this* effect down, or off, regardless of profile.
- **Mapping to the tier ladder (`Effects.md`):** a profile is a global budget target; each effect's `tier` is chosen to fit it. **Until the governor exists (≥2 tiered effects), the profile is a MANUAL global setting effects read directly; when the governor lands it becomes the governor's budget target** — and because the manifests already declare the ladders, nothing is rewritten (`Effects.md §6`).
- **UI-shadow under profiles:** expensive, so by default it is OFF at every profile except **Extreme**, and always available as an explicit per-effect toggle for a player who wants it anyway. That is "optional, expensive, recommended for powerful systems" expressed as a profile rule instead of a lone checkbox — and it is where the "someday always-on" hope (§4) lands: as the effect gets cheaper, it moves *down* the profiles (Extreme → Quality → …), one honest step at a time.

---

## 3. THE STAGED PLAN

### Stage A — MVP: a real registered, optional, stored effect (the "steps to be completed")

**A1. `UI_SHADOW_PARAMS` — the params schema.** Convert the ad-hoc `_uiShadowState` into a declared schema validated by `params-schema.js`, with the `category` presentation field from `Effects-UI.md §2`:
  - *Presence:* `enabled` (bool — this effect's own explicit on/off *override*). Note there is **no per-effect `quality` enum** — global quality is the **performance profile** (§2.1), a framework-level setting, not a knob duplicated into every effect. The effect's *default* on/off comes from the profile via the manifest's `enabledFromProfile` (§A2); `enabled` overrides it.
  - *Look:* `strength01` (float 0..1), `azimuthDeg`, `elevationDeg`, `offsetScale`, `baseSoftnessPx`, `maxOffsetPx`, `heightPx`.
  - *Technical:* `scanEveryNFrames` (int), `flipY` (bool).
  Node-tested (the schema validates; every default is in range). This IS the "ability to start authoring the look" prerequisite — a generated UI needs exactly this.

**A2. The effect MANIFEST** (`Effects.md §2` shape), as data next to the effect:
```
export const UI_WINDOW_SHADOW = {
  id: 'uiWindowShadow',
  visualWeight: 0.3,               // decorative; first to drop under budget
  a11y: { photosensitive: false }, // §2: framework carries the flag now; lightning etc. set it true
  enabledFromProfile: 'extreme',   // §2.1: off by default below Extreme; expensive
  params: UI_SHADOW_PARAMS,
  tiers: [{ n: 0, name: 'soft-offset', cost: { class: 'C1', estMsPerMp: … },
            adds: 'open UI windows cast a soft, offset shadow on the map' }],
  deferredRungs: [ /* §Stage C — the parallax rung etc., recorded, not built */ ],
};
```
Node-checkable (contiguous tiers, tier 0 present, `a11y` present, `enabledFromProfile` a valid profile). The `a11y`/`enabledFromProfile` fields are what let the settings layer (A4) do the profile gate + accessibility override generically, for every future effect, without special-casing.

**A3. The minimal effect REGISTRY** (`effects/registry.js`) — `id → { manifest, paramsSchema, apply(values) }`. The ONE door for an effect's enable/params/tier. Explicitly a *subset* of `Effects-API.md`'s contract (no `reads`/`writes`/graph yet); a `// SUBSUMED BY Effects-API when water lands` marker keeps it honest. UI-shadow is its first (and, for now, only) entry. **This is where §6's `one-enable-resolver` + `registry-is-the-only-door` walls attach** — there is no `['id','_field']` table and no second resolver because there is only this map and only its `apply`.

**A4. The SETTINGS adapter** (`foundry/settings-adapter.js`) — `game.settings.register` in the `init` hook, driven BY the registry so future effects register for free. It stands up the cascade (§2), scoped to what one effect needs now:
  - the **global performance profile** (`scope: 'client'`, enum Low…Extreme, default Standard) — the §2.1 front door;
  - the **player accessibility** switch (`scope: 'client'`, "reduce photosensitive effects") — the hard override;
  - the GM **world** default and the player **client** override for this effect's enable (`scope: 'world'` + `scope: 'client'`);
  - the **scene look** stays a scene flag (Stage B), not a `game.settings`.
  Client settings are marked `config: true` (they appear in Foundry's own Settings dialog); the effect is **off by default** (via `enabledFromProfile: 'extreme'`), and its help text carries the directive verbatim: *"Costs a noticeable amount of FPS — recommended only for more powerful systems."*

**A5. Wire it up — resolve the cascade, then apply.** The cascade resolution is **ONE pure, total, Node-tested function** (`resolveEffective(layers, manifest)` — the antidote to V2's 8-function zoo, §6): overlay, in order, `hydrateParams(UI_SHADOW_PARAMS, …)` over **standard-profile default → scene flag → world (GM) → client (player)**, then apply the **accessibility gate** (player set "reduce photosensitive" ∧ manifest `photosensitive` → force off, wins over all) and the **profile gate** (on only if active profile ≥ `enabledFromProfile`, unless the player's explicit `enabled` override says otherwise). It never throws or swallows — a malformed layer is reported, not silently dropped. Its output → `apply()` → the existing `setUiShadow`/`_uiShadowState`, which becomes the registry's `apply` target, not a parallel path. On `init`: registry → register settings. On `ready`/canvas + on any settings change: re-resolve → apply. The debug-panel toggle and every other writer go THROUGH the registry — the frame loop reads only the applied result, never a settings store or UI state directly (the `ui.saveQueue` coupling that raced in V2 is unreachable by construction). The precedence invariants (player beats GM, a11y beats everyone, absent falls through) are the Node tests that lock the resolver.

**Exit criteria for Stage A:** the effect is off by default (below Extreme); a player can enable it in Foundry's own settings and it persists per-client; a GM can set a table default; the accessibility switch force-disables a `photosensitive` effect over any layer (provable now with a temporarily-flagged test effect); `npm run verify` green; nothing reaches `_uiShadowState` except through the registry's `apply`.

### Stage B — authoring the look (the generated config surface)

**B1.** Generate a config panel from `UI_SHADOW_PARAMS` per `Effects-UI.md` (ROH first: the schema rendered by type→widget; FOH dials later). **B2.** Persist the *Look* params to a per-scene flag (§2), so an authored look travels in adventures. This is where "start authoring the look of the effect" actually lands — and it is cheap because A1 already declared the knobs.

### Stage C — deferred VISUAL rungs (recorded now, built later)

- **C1. Parallax / illusion of height on upper floors** (the author's directive). When the viewer is looking at a higher floor, a floating UI panel sits *further above that floor's surface*, so its shadow should throw **longer and shift** — the parallax that reads as depth. Technical sketch: scale `heightPx`/`offsetScale` (and thus offset length + penumbra) by the **active floor's elevation** (native `scene.levels`, `reference_foundry_v14_layering_law` / `feedback_native_levels_not_thirdparty`); optionally offset per-window by the elevation *delta* between the viewed floor and a nominal ground. A tier rung, gated like any other — never tier 0.
- **C2. Look richness:** tinted/coloured shadow (warm workspace key), per-window-type height (a small tooltip floats lower than a full sheet), a softness ramp with distance. Each a rung with a one-line `adds`.
- **C3. When the governor lands** (`Effects.md §6`, ≥2 tiered effects), the manual performance **profile** (§2.1) becomes the governor's *budget target* rather than a direct tier selector; the profile dropdown stays as the player-facing control, now driving an auto-measured allocation. The manifests already declare the ladders, so this is wiring, not a rewrite.

---

## 4. Default & performance policy (author-directed)

- **Provisionally OFF — "expensive now, aspire to always-on."** The author's decision (2026-07-20): ship it optional and off by default because the measured cost is real (**author measured ≈50 fps lost off their total** — a lot), *and hope to improve performance to the point where it can become always-on.* This is a deliberate, **temporary** reversal of `feedback_default_on_new_features` for this effect — recorded as a decision, not a drift, and explicitly *not* permanent. The mechanism for "someday on" is the profile (§2.1): as the effect gets cheaper, `enabledFromProfile` moves **Extreme → Quality → Standard → …**, one honest measured step at a time, until it reaches the floor and is simply always on. The ambition is baked into the same field that gates it.
- **No governor yet** → global quality is the **manual performance profile** (§2.1), not an auto-measured tier. The governor subsumes the profile later without touching the manifest (§C3).
- The perf cost is still worth chasing further (the effect is a composite-fold now, so the remaining cost is the per-frame DOM scan even when throttled, plus the fullscreen composite ALU) — but that is optimisation, orthogonal to registration, and every fps won there is a step down the profile ladder.

## 5. What this plan deliberately does NOT build (so the MVP cannot quietly become forever)

- The `Effects-API.md` `reads`/`writes`/`build(ctx)` contract + graph derivation — **waits for water** (§1).
- The tier **governor** — waits for ≥2 tiered effects (`Effects.md §6`); the profile is manual until then.
- The **FOH dial layer** and the polished profile/settings *UI* — Stage B does ROH-from-schema first; the profile dropdown ships as a plain `game.settings` enum in Stage A, a proper front-of-house surface later.
- The **full multi-effect cascade framework** — Stage A stands up the cascade *resolution logic* and the scopes for ONE effect (proving the shape end-to-end); it becomes a shared framework as the 2nd+ effects register through the same door, not a speculative system built ahead of them.
- The **parallax** and other visual rungs — recorded in the manifest (§C), not built.

---

## 6. THE HARD-WON SAFEGUARDS — V2 built this EXACT system, and it lost

The most important section, and the reason this plan is mostly about *enforcement*, not structure. Measured in `legacy/`, V2 already had: the **identical Creator→GM→Player cascade** (`settings/scene-settings.js` line 2), per-effect **schemas** (`getControlSchema`, 48×), a **central enable resolver** (`resolve-effect-enabled.js`, docstring: *"every render pass gate MUST call this"*), and generated-settings intent. **Every good design below existed. They lost anyway.** The cascade is therefore not the achievement — making it the *only, validated, decoupled* path is. Each V2 corpse, mapped to the V3 wall that makes it impossible (tripwires queued per covenant rule 4 — added the day the registry lands, **named now so they cannot be forgotten**):

| V2 corpse (measured) | The rot | V3 safeguard | Enforcement |
|---|---|---|---|
| `resolve-effect-enabled.js`: **8 resolver functions**, 3 enable sources, hardcoded `['ascii','_asciiEffect']` ID→private-field tables, `if(effectId==='visionMode')` special-cases | "is it on?" had no single answer; adding an effect meant editing hand tables or it silently never gated | **ONE pure resolver** over the cascade → one boolean + one param set per effect; per-effect behaviour is DATA in the manifest (`enabledFromProfile`, `a11y`, `defaultEnabled`), never code | `effects/one-enable-resolver`: no 2nd resolver, no `['id','_field']` table, no `if(effectId===` outside the manifest; Node tests for the precedence invariants |
| the resolver read `ui.saveQueue`/`ui.dirtyParams` to decide if an effect **draws** | the render gate depended on the UI's debounce internals — a self-described race | resolved state flows **registry → apply → the effect**; the frame loop reads the resolved value, nothing else | `effects/registry-is-the-only-door`: an effect's live state is mutated only by the registry's `apply` (extends `params/one-owner`); a 2nd ad-hoc `_fooState`+setter fails the build |
| `control-state-sanitize.js` (333 lines) + `repairSceneControlStateFlag` + flag-wipe + write-guard + version migration | a **repair shop at the disk boundary** because nothing validated on the way in; whole-blob storage forced migrations | **validate at the write** (`params-schema.js`, built) + **diff-from-default** persistence (`serializeParams`) → nothing invalid is stored, adding a param can't break an old scene → **no repair shop, no migration** | `settings/validate-at-write`: no `sanitize*`/`repair*Flag`-shaped functions; every layer read via `hydrateParams` |
| `scene-settings.js` **imports `LightingDirector` + menu apps**; **44 `game.settings.register` in one file** | settings coupled to effects + UI; every setting hand-registered → 3 hand-mirrored UIs (`UI.md §2`) | settings/registry imports **neither** effects nor UI; effects **declare into** the registry; `game.settings.*` only in `foundry/settings-adapter.js`, driven by the registry | `settings/adapter-only` (extends the Foundry-global wall) + the zone import-fence |
| ~140 hand-written sync/mirror functions over 3 UI surfaces | no single owner + no generator → everyone re-mirrored | **one schema, N generated views** (`UI.md §4`); the profile/settings dialog is generated | `ui/generated-only`: no `ApplicationV2`/Tweakpane control built outside `ui/renderers/` |
| **silent `catch(_) {}`** around every settings read | a failed layer read **silently ungated** the effect — invisible breakage | the resolver is pure + **total** (never throws/swallows); a failed read is announced via the safety slide, never hidden | covered by the resolver being Node-tested (`feedback_instruments_must_not_lie`) |

**THE META-SAFEGUARD — the velocity test** (`Skeleton.md` law 2, the single reason all seven V2 designs lost): *the correct path must be **faster** than the hack, or the next effect bypasses it exactly as 46 effects bypassed EffectComposer (92 importers vs 5).* Concretely: registering the **second** effect must be **one manifest + one schema + one registry line** — strictly less code than a fresh `_fooState` + a hand-written `game.settings.register` + a bespoke resolver. **The plan is only done when the fast path and the only path are the same path — measured against the second effect, not asserted.** This is the honest reason to make atypical UI-shadow the first registrant (§1): it is the *template*, and a template that is available-but-not-enforced is precisely how V2 earned seven good designs and zero survivors.

**One concrete consequence for Stage A, drawn straight from the corpses:** when `_uiShadowState` becomes a schema (A1), its **readouts must not become params.** `lastWindowCount`/`lastStampCount` are computed status (`Params.md §3.6.2`: V2's `HealthEvaluatorService` mutated product params precisely because status had no home but the param system). They stay a derived readout the debug report shows — never a stored, cascaded, persistable value.

---

*The first effect is not the whole effect system. It is the smallest honest slice that is genuinely registered, genuinely optional, genuinely stored — and, because V2 proved good structure is not enough, genuinely **enforced**. Deferrals are rungs, not comments; safeguards are walls, not intentions.*
