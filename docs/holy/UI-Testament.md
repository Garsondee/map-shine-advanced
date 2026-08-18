# ✠ THE UI TESTAMENT ✠

**This is a holy document.** It lives in `docs/holy/` and is governed by **The Covenant**:

> **RULES OF THIS PLACE**
> 1. Only a **Fable-class or greater** model may create a holy document, restructure this one,
>    edit its Law, its definitions of done, its gates, or resolve a Petition.
> 2. **Any model** may execute tasks and record completion — flip `[ ]` to `[x]` and append an
>    evidence line. That is the full extent of a worker's editing rights here.
> 3. Only a **Fable-class** model may **countersign** (`✠`) — by inspecting the actual work,
>    never the worker's summary.
> 4. A worker who believes the plan is wrong does not edit the plan. It files a **Petition**
>    (§12) and moves on. Fable adjudicates petitions.
> 5. Above everything in this file sits **the author**. Their LIVE verdict on a real scene
>    outranks any countersign; their word rewrites any Law.

**Task notation:** `[ ]` open · `[x]` done + evidence line · `✠` countersigned · `⚑` reopened.

**Created 2026-08-17 by Claude Fable 5, at the author's command.** Authority order: the
author's eyes → this file → `docs/planning/Effects-UI.md` + `docs/planning/Control-Panel.md`
(absorbed; still law wherever §2.3 does not supersede them) → `docs/planning/UI.md` +
`docs/planning/Params.md` → `docs/planning/V2-UI-Featureset.md` (the breadth reference of
what V2 shipped) → the code.

**The author's charge, verbatim, 2026-08-17:**
> *"I want something vibrant, accessible, with a clean fun colour approach and a focus on two
> modes. One, the GM is running an active session and needs the TV Remote of their session…
> They might want to ease a change of atmosphere across a minute, five minutes all the way up
> to an hour or more or have things change dramatically. They need a fun to use, concise but
> graphically attractive interface… Mode two is for configuration of the module in the first
> place, giving access to as many controls as possible to allow real authoring and fine tuning
> of effects. It also has a mode around painting/adding effects into the scene on the fly…
> What would you argue is the best possible UI/UX given that the module will keep expanding
> with more and more effects in lots of different categories? You will write the design bible
> that all future UI/UX sessions will need to consult before doing any of that work."*

**Every future UI/UX session reads this file before touching a panel.** That is what it is for.

---

## 0. The one sentence

> **The UI becomes two rooms over one schema — a REMOTE that plays the world like a lighting
> desk, where every change is a fade with a chosen tempo, and a STUDIO that authors every
> effect through generated, health-wearing controls and a live brush — dressed in one
> vibrant, accessible design language (LANTERN), and grown forever by declaration, never by
> another window.**

The module will keep expanding. The only UI that survives unbounded growth is one with a
**fixed grammar that new effects declare themselves into**. Neither room ever gains a control
by hand; the Remote never gains a control at all — it gains *content* (presets, cues,
impulses). That asymmetry is the whole bible in one breath.

---

## 1. Where the UI stands today — the honest audit

V3 is *not* starting from zero. The audit matters because the plan below re-homes proven
parts rather than rebuilding them.

| Piece | State | Note |
| --- | --- | --- |
| `core/params-schema.js` — the contract | **BUILT, tested** | 10 canonical types incl. `angle` + `action`; validate-at-write; the four-concerns split holds |
| `diag/effect-controls.js` — FOH/ROH generator | **BUILT, in daily use** | Plain DOM; `fohKeys` strip + categorised ROH complement; the partition is pure + sabotage-tested |
| `src/ui/astrolabe.js` — the hero dial | **BUILT, live** | Ring derived from `world/sun.js` (no dead axes); wind arrow + strength; weather shelf attached |
| `src/ui/paint-mode.js` + `scene/paint-mask.js` | **BUILT, live-tested** | Brush + spray + erase + point/line/polygon vector tools, per-floor, undo, embed persistence, unsaved-changes guard |
| `diag/debug-panel.js` — "the MSA Control Panel" | **BUILT — the current home of everything** | Reports/actions/selects registry, accordions, Pixel Probe, perf lab; ~1,250 lines and growing |
| Ease-toward-target writes | **EXISTS ad hoc** | Weather manager targets ease (`boot.js`: "the ease ships it there for real"); no unified engine, tempo, progress UI, or reload survival |
| Fixed ROH category order | **BUILT — and already drifting** | `CATEGORY_ORDER` has grown per-effect surface groups (Flame/Ember/Smoke); §5.2 makes that lawful instead of accidental |
| Design system / tokens / themes | **ABSENT** | Each surface styles itself; colours are hardcoded per file |
| The Remote (session surface) | **ABSENT** | The astrolabe floats alone; no tempo, faders, cues, or Now-Playing |
| The Studio (config shell) | **ABSENT** | The debug panel stands in for it — a dev tool doing a product's job |
| Cues, dials (`drives`), search, scope glyphs, player face, keybindings | **ABSENT** | All specified below |

**The V2 reference corpus** (read, don't re-derive): `V2-UI-Featureset.md` — the full breadth
of what V2's UI covered (three audiences, ~1,880 params, four persistence scopes, eight named
weaknesses). `docs/reference/v2-effect-params/` — per-effect depth in the author's own voice.

---

## 2. THE TWO ROOMS — the shape

```
   ┌─────────────────────────────┐          ┌──────────────────────────────────────┐
   │  THE REMOTE                 │          │  THE STUDIO                          │
   │  (session · GM · compact)   │          │  (config & authoring · GM · deep)    │
   │                             │          │  ┌────┬───────────────────────────┐  │
   │  Now Playing strip          │          │  │ 🎛 │ EFFECTS  (generated cards) │  │
   │  ── the astrolabe ──        │  writes  │  │ 🖌 │ PAINTER  (built, re-homed) │  │
   │  FADE TIME  ◦ ◦ ● ◦ ◦ ◦    │──────────│  │ 🗺 │ SCENE    (baseline·levels) │  │
   │  mood chips  ▭ ▭ ▭ ▭ ▭     │  through │  │ 🎬 │ CUES     (builder)         │  │
   │  channel faders  ▮▮▮▮▮▮    │  ONE     │  │ ⚙ │ SYSTEM   (= player face)   │  │
   │  cue deck   [ GO ▶ ]        │  schema  │  │ 🔬 │ LAB      (dev-gated)       │  │
   │  impulses   ⚡ 🌩 💨        │          │  └────┴───────────────────────────┘  │
   │  ▾ collapse to pill         │          │   + search palette · + pop-out cards │
   └─────────────────────────────┘          └──────────────────────────────────────┘
        always beside the canvas                 opened for prep, closed for play
```

### 2.1 Why two rooms and not one shell with five zones

`Control-Panel.md` proposed ONE shell whose Bridge zone held the live controls. The author's
charge names **two modes**, and the session surface has a property no rail zone can honour:
**it must coexist with the canvas for hours** — small, glanceable, never displaced by opening
the deep panel. A rail that swaps the Bridge away mid-session is a remote you lose down the
sofa. So the Bridge graduates into its own room. Everything else `Control-Panel.md` argued —
zones as generated views, permission as a filter, contribution API, no dialog zoo — survives
intact *inside the Studio*.

### 2.2 The audiences

| Audience | Sees | Never sees |
| --- | --- | --- |
| **GM (play)** | The Remote | — |
| **GM (prep/authoring)** | The Studio, all departments except Lab | Lab |
| **Player** | SYSTEM department only (own window dressing: "Performance & Graphics"), Player-Light picker | Everything else — *not rendered hidden; never built into their DOM* |
| **The author/dev** | Everything + Lab | — |

### 2.3 Supersessions — named honestly, so the older docs stay useful

1. **Five zones → two rooms + departments.** The Bridge becomes the Remote (§2.1). Workshop,
   Toolbox, Settings, Lab become Studio departments. Nothing else in `Control-Panel.md` moves.
2. **ROH renderer: Tweakpane → the house generator.** `Effects-UI.md` §5 recommended
   Tweakpane for the rear of house. Since then the plain-DOM generator shipped, is in daily
   authoring use, and the author's charge demands a *vibrant, branded, accessible* surface —
   which a dev-tool skin fights. **The house widget canon (§8) is the standard renderer for
   both houses.** The `ui/no-handwritten-controls` wall keeps `src/ui/renderers/` as the one
   place Tweakpane may ever live if density demands it later; it is no longer load-bearing.
3. **Emoji → drawn icons on product chrome.** V2 used emoji structurally. Product surfaces
   (Remote, Studio chrome, category marks) use the LANTERN icon sprite (§6.4): tintable,
   crisp, consistent cross-platform. Emoji remain welcome in prose, docs, and the Lab.
4. **`fohKeys` is v1 of the front of house, not its final form.** The authored dial layer
   (`drives` remaps, `Effects-UI.md` §3) remains the destination — staged at U6. Curated
   `fohKeys` stays the cheap path for effects that don't need macro dials.

Everything not listed here stands as written in the older docs.

---

## 3. THE TWELVE LAWS

The part every session rereads. Each law exists because V2 died of its absence.

1. **ONE SCHEMA, MANY ROOMS.** Every control is a generated projection of a declaration —
   params, dials, cues, tiles, impulses, channels. A hand-wired control is a build failure,
   not a code-review nitpick.
2. **THE HOUSES PARTITION.** A param renders in the FOH strip *or* the ROH complement, never
   both. (Two unsynced controls for one value shipped once, 2026-07-26. Never again.)
3. **THE REMOTE GROWS BY CONTENT, NEVER BY CHROME.** Its grammar is fixed: Now Playing ·
   hero dial + wings · fade time · the weather board (Direct/Drift) · channels · cues ·
   impulses · the Director · the debug dress (dev-gated). A new effect joins by *declaring
   into* that grammar (a wing tap, a mood, a climate, an impulse, a cue). If a feature needs
   a new Remote zone, it goes to the Studio instead — or it petitions this Testament.
   *(Grammar list amended by Fable 5, 2026-08-17, at the author's direction: wings, weather
   modes, Director, debug dress added.)*
4. **EVERY REMOTE CHANGE IS A FADE.** All Remote writes pass through the Fade Engine (§4.2);
   "now" is simply `over: 0`. Active fades are visible, cancellable, snappable — and they
   survive a reload.
5. **NOTHING DEAD IS DRAWN; NOTHING BROKEN IS SILENT.** No control renders without a live
   engine behind it (the astrolabe rule, generalised). An unavailable control says *why*.
   Control-health is derived (declared − read), never hand-attested.
6. **SCOPE WEARS A GLYPH.** Where a value persists — scene · world · client — is visible at
   the point of change. "Where did my setting go?" is a design defect, not a support ticket.
7. **MEANING NEVER RIDES ON COLOUR ALONE.** Every colour-coded state pairs with an icon,
   shape, or label. Contrast is CI-gated (§7). Motion is decorative by default and honours
   `prefers-reduced-motion` plus the in-app toggle.
8. **THE CANON IS THE ONLY TOOLKIT.** A new widget enters the component canon (§8) with
   states, an a11y contract, and a test — or it does not exist. Inline one-off widgets are
   the 220-lines-per-control disease V2 died of.
9. **TWO ROOMS, NO ZOO.** New top-level windows and new Studio departments require a
   Testament amendment. Pop-outs are *views* of Studio content, never new homes.
10. **PLAYERS GET THEIR OWN DOOR, AND ONLY THEIRS.** GM chrome is never built into a player
    client's DOM. Secrets stay safe structurally, not by CSS `display:none`.
11. **THE UI PAYS RENT IN FRAMES.** Steady-state panel cost ≤ 0.3 ms; zero per-frame DOM
    writes while idle; fades animate only while running. The UI's own cost is a row in the
    perf report — an instrument that exempts itself is lying.
12. **DECLARING MUST BEAT HAND-BUILDING.** If registering a param/cue/tile/impulse is slower
    than dropping a button somewhere ad hoc, the next feature goes ad hoc and the zoo
    regrows. Velocity is the wall's mortar. (V2's epitaph; `Skeleton.md` law 2.)

---

## 4. THE REMOTE — mode one, the session surface

**Job:** the GM changes the world's mood mid-session without breaking eye contact with the
table. Concise, tactile, beautiful. Everything reachable in one glance, one gesture.

### 4.1 The grammar — seven fixed pieces, top to bottom

| Piece | What it is | Source of truth |
| --- | --- | --- |
| **Now Playing** | One strip: time glyph + weather glyph + active-fade progress ring + drift badge + connection cluster (players watching, Director LIVE dot). The single-glance answer to "what is the world doing, and who sees it?" | derived from world state + Fade Engine + sync bridge |
| **The astrolabe + wings** | The hero. Time ring (sun-model-derived, **noon at the top** — author's call 2026-08-17), wind readout, and a **true moon**: it advances ~50 min later per day on its own lunar cycle and renders its **phase** (crescent → full → crescent), dimming toward new. Flanking the dial, two **wings** of quick-taps reclaim the dead corners: **left wing = time** (play/pause time flow, time speed, Dawn/Noon/Dusk/Midnight — each eased at the tempo), **right wing = moment-shots** (Golden hour, Moonlit, Ominous, … one-tap scene beats). Wings are declared content, capped at ~5 per side. | `src/ui/astrolabe.js` + `world/sun.js` + moon model |
| **Fade Time** | A segmented tempo control, always visible: **Now · 10s · 1m · 5m · 15m · 1h** (+ press-and-hold for custom). Every subsequent gesture — chip tap, fader drag, dial turn — eases over the selected tempo. *This is the author's "ease across a minute…an hour" made structural: tempo is a mode you set once, not a dialog you answer every time.* | Fade Engine default `over` |
| **The weather board — TWO MODES, one grammar** | A `Direct \| Drift` segmented control heads the board, because the two weather aims V2 discovered are different *verbs over the same nouns*: **Direct** — the GM states a destination: mood chips (Clear · Rain · Storm · Snow · …) are *destinations*, faders are *trims*, Fade Time is the journey. **Drift** — the GM states an *envelope*: climate chips (Coastal · Moorland · Alpine · Desert · Jungle · Volcanic · …) set per-channel bounds; the sky wanders inside them on its own; the faders grow **min/max brackets** with the live tick wandering between (V2's split-bounds faders, reborn). Same chips row, same faders, two verbs — never two boards. | preset + climate declarations |
| **Channel faders** | The environment vector, tinted per channel: precipitation · clouds · fog · wind speed · wind direction · freeze · lightning · ash (+ gustiness on the wind fader). **Render only channels whose engine is live** (Law 5). Dragging shows a ghost tick at the target and the fade running toward it — V2's fader preview, kept. In Drift mode each fader wears its climate's bracket. | `world/` engines |
| **Cue deck** | The next staged cue as a card + **GO**. GO fires the cue with *its* authored fade time (overriding the tempo bar). A drawer lists the scene's full cue stack; tap any to jump. §4.3. | cue declarations |
| **Impulses** | One-shot buttons: strike lightning here · thunder · gust. Declared by effects (§4.4), curated to a single row. Impulses are instant by nature — they ignore Fade Time. | impulse declarations |

Footer, always present: **⟲ Baseline** (fade back to the scene's authored resting look — the
undo for everything, obeying Fade Time) · **⛑ Safety** (the safety slide: MSA renderer →
Foundry fallback; confirm-first, the one confirm on the whole Remote) · **▾ collapse**.

**Collapsed pill:** a slim chip — time glyph, weather glyph, fade progress ring, GO. The
Remote never fully leaves the screen during a session; it shrinks.

**Posture rules:** every control ≥ 36 px hit target; no scrolling in the default layout; no
text entry; one action = one control; nothing destructive without the Safety confirm. The
Remote is operated half-blind while narrating — design for the thumb, not the cursor.

### 4.2 THE FADE ENGINE — time as a first-class value

The Remote's soul, and the largest genuinely new mechanism this Testament introduces.

**The record.** A fade is data, not a tween hidden in a widget:

```js
{
  id, label,                     // "Dusk falls", shown on the progress ring hover
  channels: { cloudCover: { from: 0.2, to: 0.9 }, timeOfDay: {…}, … },
  params:   { 'water.waveStrength': { from, to }, … },   // cues may ease effect params too
  startedAtMs,                   // WALL CLOCK, never the sim clock (throttle-latch scar)
  overMs,                        // 0 = cut
  curve: 'linear' | 'ease' | 'smoothstep' | 'hold-snap',
}
```

**The laws of the engine:**
- **One writer, many derivers.** The GM's client writes the fade record to a scene flag; every
  client (GM included) derives the current eased value locally and deterministically from
  `(record, now)`. No per-frame sync spam — the *fade* is synced, never its samples.
- **Reload survival.** A one-hour dusk must outlive an F5. On load, an unexpired record
  resumes mid-curve from wall-clock arithmetic. An expired record applies its `to` and
  retires. (This is why `from` is stored — resumability without history.)
- **Replace, don't queue.** A new fade on a channel captures the *current eased value* as its
  `from` and replaces that channel's entry. Fades on disjoint channels coexist.
- **Cut and snap.** Any active fade can be cancelled (hold at current value) or snapped
  (jump to `to`). The Now Playing ring is the handle for both.
- **Writes flow through the cascade.** The engine's outputs land through the same validated
  param/settings paths as any Studio write (`validateParamValue`; the scene/world/client
  cascade). No `remote → renderer` shortcut — that shortcut is how V2 grew seven homes per
  value.
- **Pure core, thin shell.** Curve math, merge, resume, and expiry are pure Node-tested
  functions (`world/fade-engine.js`); DOM and flags are glue.

### 4.3 CUES — staged moments with a GO button

The theatrical machinery that lets the Remote stay six inches tall while sessions get richer.
A **cue** is a named, authored *moment*: a partial environment target, optional effect-param
targets, a fade time, a curve.

- **Authored in the Studio** (§5.4): set the world how you want it, press *Capture as cue*,
  name it ("Act II — the storm breaks"), set its fade time (10s? 20 minutes?), reorder in the
  stack. Capture-then-name beats form-filling — the scene is the editor.
- **Fired from the Remote:** the deck shows the next cue; **GO** advances. Jumping to any cue
  is legal (sessions are not linear).
- **Cues are validated data** (the preset discipline, `Control-Panel.md` §9): a cue that
  targets a param the schema doesn't declare **fails at author time**, not at the table.
- **Cues travel.** They live in scene flags, so a sold map ships with its authored moments —
  *buy the mansion, get its thunderstorm*. This is a product feature, not a convenience
  (`Authoring-and-Distribution.md`).

### 4.4 IMPULSES — declared one-shots

An effect may declare impulses at registration: `{ id, label, icon, fire() }` — strike
lightning, roll thunder, gust the wind, flare the fire. The Remote renders the curated row;
the Studio lists all of them. Declaration is the only door (Law 3); the row never grows past
one line — curation is a scene-level pick, not a scroll.

**Photosensitivity:** a client a11y override that suppresses flashes (System dept) is a hard
override. The Remote shows a small badge on flash-class impulses when any connected client
suppresses them — the GM should know the strike won't reach everyone.

### 4.5 THE DIRECTOR — cutscene mode *(author's charge, 2026-08-17: its own section)*

> *"The ability to take over everyone's cameras, put letterboxes in front of the scene and
> create cutscenes by taking away the players' UI and forcing them to focus on what you are
> trying to show them."*

The Remote's most theatrical power: for a held moment, every screen at the table becomes
**one screen, and the GM is holding the camera.**

**The model — broadcast the direction, derive the picture** (the Fade Engine doctrine
applied to cameras): the GM's client writes a single **direction record** to the scene —
`{ live, aspect, follow, hideUi, startedAt }` — and every player client *derives* its own
presentation from it. No per-frame camera streaming; a follow target plus local smoothing.

- **Follow sources** (the `follow` field): `my-view` (players track the GM's pan/zoom,
  smoothed), `token:<id>` (camera locks to an actor — the dragon lands, everyone watches
  the dragon), `path:<id>` (an authored camera path plays — the V3 camera-path system is
  the engine; the Director is its stage).
- **Letterbox**: cinema bars slide in to the chosen aspect (2.39:1 default · 2.0:1 · 16:9 ·
  off). The bars are the *signal* — players instantly read "cutscene" with zero text.
- **UI fall-away**: Foundry chrome and MSA panels on player clients fade to black-glass;
  input is suspended for the duration. The GM keeps the Director HUD only.
- **The Director HUD**: when LIVE, the GM's own Remote folds into a slim floating bar —
  ● REC-red LIVE dot · aspect · follow source · watching-count · **GO** (cues fire
  mid-cutscene; a cutscene is usually *made of* cues) · **RELEASE**. Nothing else. The GM
  is directing, not configuring.
- **Arming**: a 🎬 header button opens the Director strip (aspect · follow · hide-UI ·
  TAKE OVER). Take-over is deliberate — one press arms it live; RELEASE returns every
  client smoothly (camera eases home, bars slide out, UI fades back).
- **Safety & agency**: RELEASE is instant and always one press. Player clients regain full
  control on disconnect/timeout of the direction record (fail-open — a crashed GM must
  never hold a table hostage; the gate-polarity law applies to people too). Whether players
  get a hold-Esc opt-out is the author's fork (§11). Reduce-motion clients get cuts, not
  glides; reduce-flash still outranks everything on strike-bearing cutscenes.
- **Cues are the script, the Director is the camera.** A future cue type may carry a
  direction (`cue.direct = {follow, aspect}`) so one GO does both. Declared data, validated
  like everything else.

Stage: **U9**. The mock demonstrates the GM side today: strip, take-over, letterbox, the
ken-burns drift, the HUD, release.

### 4.6 THE DEBUG DRESS — the author's zone, worn openly for now

A dev-gated strip at the Remote's foot (and dev-gated rail entries elsewhere): live FPS ·
frame-ms · VRAM · one-tap Perf HUD / Pixel Probe / Cache report / Export. Styled apart —
monospace, slate, a 🔬 tag — so it always reads as *equipment*, never product. Governed by
one global debug flag: **default ON while the module is the author's instrument; flipped
OFF as a release step (U8) so GMs never meet it.** The flag hides dev chrome everywhere at
once (remote strip, Lab rail slot, extra header tools) — one switch, not a scavenger hunt.

### 4.7 What the Remote will NOT be — signed refusals

- **No per-effect controls.** Not one. Effect tuning is the Studio's job; the Remote speaks
  only the fixed grammar. (The moment "just one water slider" lands here, Law 3 is dead.)
- **No confirmation dialogs** except the Safety slide. Everything else is fade-reversible via
  Baseline.
- **No text input, no scrolling default layout, no tabs.**
- **No dead channels.** A fader for an engine that isn't live yet is not rendered greyed —
  it is not rendered.

---

## 5. THE STUDIO — mode two, authoring and configuration

**Job:** *"access to as many controls as possible — real authoring and fine tuning."* The
Studio is where the module's depth lives: a single window, department rail on the left,
search everywhere, generated everything.

### 5.1 The departments — fixed set, amendment-gated (Law 9)

| Dept | Contents | Lineage |
| --- | --- | --- |
| **🎛 EFFECTS** | The generated effect cards — the crown jewel (§5.2) | `Effects-UI.md`, built generator |
| **🖌 PAINTER** | The built paint mode, re-homed: brush/vector tools, mask kind, floor stepper, undo (§5.3) | `src/ui/paint-mode.js` |
| **🗺 SCENE** | Baseline look ("what Baseline fades back to"), scene presets, levels authoring, mask board (per-suffix status), loading screens, integrations (DSN/Sequencer) | V2 parity features |
| **🎬 CUES** | The cue builder: capture, name, time, curve, reorder, test-fire (§4.3) | new |
| **⚙ SYSTEM** | Graphics profile (Low…Extreme), per-effect enables within GM bounds, a11y (reduce-flash, reduced-motion, text scale, theme), player-light policy. **This department alone, restyled, IS the player face.** | `Effect-Registration.md` cascade |
| **🔬 LAB** | Today's debug panel registry, whole: reports, actions, Pixel Probe, perf lab, widget gallery (§10). Dev-gated; customers never wander in. | `diag/debug-panel.js`, re-homed |

Navigation: the rail switches departments; **accordions live inside departments, never as
top-level nav** (`Control-Panel.md` §3, upheld). Geometry (position, size, last department,
pinned cards) persists per client.

### 5.2 The EFFECTS department — the card, matured

Anatomy of one effect card (all generated):

```
┌──────────────────────────────────────────────────────────────┐
│ ▍water  💧 WATER            [●on] 🩺2 ⬚scene  📌 ⧉ 🖌       │  ← header
│  ▍= category accent bar      health scope  pin popout paint  │
│──────────────────────────────────────────────────────────────│
│  FOH STRIP  — the effect's few honest dials (fohKeys → U6    │
│  authored dials). Plain language. Presets dropdown.          │
│──────────────────────────────────────────────────────────────│
│  ▸ Advanced — the ROH complement, categorised:               │
│    Presence · Look · [surface groups] · Motion · Extent ·    │
│    Response · Technical  (+ Readouts, live, read-only)       │
└──────────────────────────────────────────────────────────────┘
```

- **Search is the scalability answer.** A palette (button + `/` inside the Studio) fuzzy-
  searches every schema label, help string, and glossary term — free, because the schema is a
  database. Typing "wetness" lands on the param, opens its card, flashes the control. At 44
  effects this is convenience; at 100 it is the only navigation that works. Category strips
  and pinned cards are the browsing path; search is the knowing path.
- **Health lives ON the card** (V2 weakness №6: diagnostics were separate destinations).
  The header wears: mask status row (built pattern), control-health count (declared − read,
  once the U6 proxy lands), tier chip. Clicking any badge deep-links to the Lab's relevant
  report. Diagnosis starts where the symptom shows.
- **Scope glyph** (Law 6): ⬚scene / 🌐world / 🖥client on every card header and every
  System row. Click it to see where the value lives and what overrides what.
- **Pop-out** (⧉): any card detaches to a floating mini-panel for side-by-side lookdev
  (water beside lighting). Pop-outs are views — closing the Studio closes its children.
- **Category vocabulary law:** the fixed spine is `Presence · Look · Motion · Extent ·
  Response · Technical` (+ `Light`, + `Readouts`). An effect may additionally declare
  **surface groups** (Flame/Ember/Smoke; Detail/Shape) which render *between* Look and
  Motion in declaration order. The global `CATEGORY_ORDER` list stops accreting per-effect
  entries — the spine is closed, the surface groups are per-effect declared data. (This
  legalises what fire already needed and ends the quiet drift the code comments confess.)

### 5.3 The PAINTER department — the built painter, wrapped

The painter exists and is good. The Studio gives it its product frame:

- **The "need fire" flow is canon** (`Control-Panel.md` §5.2): a friendly tile per paintable
  effect → click → effect enabled through the registry → brush armed with the right mask →
  paint → alive. The tile grid is generated from registrations; a tile's choreography is
  data (`{ effectId, maskId, tools, brushDefaults }`).
- **Per-card shortcut:** every paintable effect's Studio card carries the 🖌 button — tuning
  and painting are one workflow, not two departments' worth of navigation.
- **Painting is modal and honest:** enter through a deliberate click, LEFT paints, RIGHT
  pans (Foundry's own gesture, untouched), Esc exits with the unsaved guard. The painter
  suppresses gameplay input only while active (the input-model decision, upheld).
- **Deferred, still deferred:** retained/editable vector shapes, bake-to-file (Mode B), the
  package gate. The Testament does not advance the painter's scope; it houses it.

### 5.4 The CUES department

Capture-first authoring (§4.3): a big **Capture current look as cue** button, the stack as
reorderable cards (name · fade time · curve · what it touches), test-fire with an instant
revert, and a validity badge per cue (schema-checked). A cue that references a missing
param wears a ⚠ and refuses to arm — never a silent no-op at the table (Law 5).

### 5.5 The SYSTEM department — and the player face

One generated surface, two renderings (the `Control-Panel.md` §8 doctrine, upheld):

- **GM view:** world-default layer + own-client layer, profile, per-effect enables, a11y,
  player-light allowances.
- **Player view:** the same component tree, client scope only, titled "Performance &
  Graphics". Opened from their toolbar button. Nothing else of the Studio ships to them
  (Law 10) — the player face is deliberately small, friendly, and *theirs*.
- Mirrors into Foundry's native Settings via the adapter — two renderings of one store,
  never a third mirror.

---

## 6. LANTERN — the design language

The look: **a dark glass instrument panel, lit by the world it controls.** Vibrancy comes
from light — category accents, state glows, the astrolabe's sky gradient — never from
colouring the furniture. Named so future sessions can say "that's not LANTERN" and mean
something precise.

### 6.1 Tokens — the only source of colour (wall-enforced)

All colour, spacing, radius, type, and motion values live in **`src/ui/tokens.js`** as data,
applied as CSS custom properties. A colour literal anywhere else in `src/ui/` is a build
failure (wall `ui/tokens-only`, §9). Tokens are data so the contrast gate (§7) can *compute*.

**Ground & ink (dark theme, the default):**

| Token | Role | Starting value (author calibrates) |
| --- | --- | --- |
| `bg0` | window ground | `oklch(0.16 0.01 250)` |
| `bg1` | panel | `oklch(0.20 0.012 250)` |
| `bg2` | raised / cards | `oklch(0.24 0.014 250)` |
| `line` | hairlines | `oklch(0.32 0.015 250)` |
| `ink0 / ink1 / ink2` | primary / secondary / muted text | L 0.93 / 0.74 / 0.58 |
| `shine` | brand & focus | `oklch(0.85 0.13 90)` — the lantern's gold |

**The spectrum — one hue per category, equal weight** (L≈0.75, C≈0.13 — vivid, never
shouting; that equality IS the "clean" in "clean fun"):

| Category | Hue | Reads as |
| --- | --- | --- |
| Gameplay & Interaction | h180 | teal |
| Lighting & Shadows | h85 | amber |
| Atmosphere & Weather | h240 | sky |
| Surface & Materials | h300 | violet |
| Particles & VFX | h55 | ember |
| Camera & Post | h345 | magenta |
| System & Debug | low-chroma slate | quiet on purpose |

Accents appear as: the card's edge bar, the department icon tint, fader fills (rain wears
sky, fire wears ember), active-control glow. Semantic colours (`ok` h150 · `warn` h75 ·
`fail` h25 · `info` h250) are a separate set and always pair with an icon or shape (Law 7).

**Themes:** four, as token sets — **Lantern Dark** (default) · **Lantern Light** ·
**High Contrast** · **Soft** (low-stimulus: muted chroma, no glows). All four exist from U0;
a theme is a data file, so a fifth is an afternoon, not a project.

### 6.2 Space, shape, depth

4 px base grid; spacing steps 4/8/12/16/24. Radii: 4 (controls) / 8 (cards) / 12 (rooms).
Three elevation shadows only. Density: Studio offers *Comfortable* (default) and *Compact*
(for the "as many controls as possible" days); the Remote has one density — generous.

### 6.3 Type

One UI face (system stack; no webfont weight for chrome), `tabular-nums` on every readout so
values don't dance. Four sizes (11.5/13/15/18 px at scale 1.0) — all rem-driven by the text
scale setting (§7). Plain-language register in FOH and the Remote; expert register in ROH —
two registers, one truth (`Effects-UI.md`, upheld).

### 6.4 Icons

An inline SVG sprite: category marks, scope glyphs, health glyphs, transport (GO/pause/
snap), tools. Stroke-consistent, tintable by token, always labelled or `aria-label`led.
Emoji retire from product chrome (§2.3.3).

### 6.5 Motion & juice

120 ms micro / 200 ms move / 320 ms room transitions, ease-out; spring only on the astrolabe
snap and the GO press. The fade progress ring is the one always-animated element — it *is*
information. V2's "clunk" lives on as optional, subtle feedback (default on, quiet), and
dies entirely under reduced-motion. Nothing conveys meaning through motion alone.

### 6.6 Voice

Labels are verbs and nouns, not sentences. Tooltips are the schema's help — the author's
voice, already harvested. Errors say what to do next ("Needs a `_Fire` mask — paint one 🖌
or add `Map_Fire.webp`"), never just what failed. No exclamation marks in chrome.

---

## 7. THE ACCESSIBILITY CHARTER — testable, gated

Not aspirations — gates. Each has a check; the checkable ones run in CI.

1. **Contrast is computed, not eyeballed.** `tokens.test.mjs` computes WCAG contrast for
   every sanctioned pair (ink-on-ground, accent-on-ground, state-on-ground) in **all four
   themes**: ≥ 4.5:1 body text, ≥ 3:1 large text/icons/hairline-critical. A theme that
   fails does not build.
2. **Hit targets:** ≥ 28 px Studio, ≥ 36 px Remote. (Fader thumbs, chips, GO — measured.)
3. **Full keyboard:** every panel tab-navigable in visual order; sliders/faders respond to
   arrows (Shift = fine, PgUp/Dn = coarse); the astrolabe ring arrows in 15-min steps; Esc
   backs out of paint/pop-outs/palette; a visible 2 px `shine` focus ring everywhere.
4. **Never colour-only** (Law 7). The reviewer's test: grayscale the panel — is every state
   still legible?
5. **Reduced motion:** OS preference respected AND an in-app toggle; both kill decorative
   motion; progress information survives as static fill.
6. **Reduce flash:** the photosensitivity override suppresses lightning/flash classes on
   that client; it is a hard override outranking the GM (safety outranks doctrine); the
   Remote badges suppressed impulses (§4.4).
7. **Text scale:** 0.9–1.3× client setting; layouts flex, nothing clips at 1.3.
8. **Generated ARIA:** roles/labels/values come from the schema through the widget canon —
   accessibility is a property of the generator, so no control can forget it.
9. **Tooltips on hover AND focus**, dismissible, delay ~400 ms.
10. **The player face is calm:** no dev vocabulary, no red unless something is actionable by
    *them*, availability always explained in plain words.
11. **Fits the smallest table** *(author's law, 2026-08-17)*: every surface renders fully
    inside **1920×1080 at scale 1.0** — panel maximum sizes are chosen for 1080p, drags and
    resizes clamp to the viewport, and nothing ever depends on 4K real estate. 4K gets
    *beauty* (crisp hairlines, generous canvas around the panels), never *necessity*.

---

## 8. THE COMPONENT CANON — the only toolkit (Law 8)

The sanctioned set. Each entry ships with: all states (default/hover/active/focus/disabled/
warn), schema binding, a11y contract, and a gallery row (§10). **Existing** = built today in
some form (re-skin, don't rewrite).

| Widget | Room | Status |
| --- | --- | --- |
| slider + numeric twin, stepper, toggle, segmented, select, text field, color swatch+picker, angle dial, curve editor, vec2 pad, action button | both (the type→widget table) | **existing** in `diag/effect-controls.js` → extract to `src/ui/widgets/` |
| accordion/folder, card shell, department rail, tabs-in-place | Studio | partial (debug panel accordions) |
| tooltip, toast, confirm (Safety only), search palette | both | new |
| mask status row, scope glyph, health badge, tier chip | Studio | status row **existing**; rest new |
| astrolabe | Remote | **existing** |
| channel fader (tinted, ghost-target tick), Fade Time segmented, progress ring, mood chip, cue card + GO, impulse button, Now Playing strip, collapse pill | Remote | new |
| brush/tool strip, floor stepper, mask-kind select | Painter | **existing** |

Adding a widget = adding a canon row + gallery row + test, in the same PR. The canon is
closed between PRs — that closure is what keeps 100 future effects from minting 100 bespoke
controls.

---

## 9. THE CHECKLIST

Stages are independently landable; each ends at the author's eyes. Workers claim with
evidence; Fable countersigns; the author promotes to LIVE. **Order within a stage is
suggested, not sacred; order between stages is.**

**Walls raised across the build** (each a `tools/verify-structure.mjs` failure,
sabotage-tested):
- `ui/tokens-only` — no colour literal in `src/ui/**` outside `tokens.js` *(U0)*
- `ui/canon-only` — widget/DOM-input construction only in `src/ui/widgets/` + the two
  grandfathered diag files until re-homed *(U1, ratchet)*
- `ui/no-dead-axis` — a Remote channel/ring binds to a live engine or fails *(U2)*
- `dials/valid-reference` — every `drives`/cue target exists in schema, in range *(U3/U6,
  from Effects-UI §6)*

### UM — THE MOCK *(author-directed 2026-08-17; blocks U0)*

A fully clickable, zero-dependency HTML mock of both rooms + the player face, so LANTERN and
the two-room feel are tasted **before** a line of product code — and so UI design proceeds
without touching `src/` while other work is in flight there. The mock is the taste artifact;
its token values seed `src/ui/tokens.js` at U0.

- [x] `tools/ui-mock/index.html` — one self-contained file (inline CSS/JS/SVG, no deps,
      opens by double-click): the Remote (astrolabe, Fade Time, mood chips, channel faders,
      cue deck + GO, impulses, Baseline/Safety, collapse pill), the Studio (rail, EFFECTS
      cards generated from a mock schema, search palette, PAINTER tiles, CUES builder,
      SYSTEM, LAB widget gallery), and the player face — over a stylised living backdrop
      (time-of-day tint, weather responds to the faders)
      · done Fable 5 2026-08-17 — built + exercised live in the browser pane: Storm mood
      faded in over the tempo bar (ghost ticks + progress ring seen), GO advanced the cue
      stack, search "ember" jumped into Fire's ROH and flashed the row, painter armed fire
      and stamped 4 living glows on the map, 0 console errors across the whole session
- [x] All four LANTERN themes switchable live; text scale, reduce-motion, reduce-flash
      toggles functional inside the mock
      · done Fable 5 2026-08-17 — scripted self-test: 4 themes yield 4 distinct computed
      grounds; reduce-flash shows the suppression badge on Strike; text scale 1.3× keeps
      the Remote inside a 720-tall viewport via its max-height clamp
- [x] **Containment proof:** a toggleable 1920×1080 frame overlay; every surface fits
      inside it at scale 1.0 (Charter §11); panels clamp to the viewport when dragged
      · done Fable 5 2026-08-17 — measured at 1920×1080: Remote 402×1045 at (1502,16)
      with zero internal scroll (998=998px); Studio 1180×800 at (24,44) — the two rooms
      coexist without overlap; player face centred and inside; no horizontal overflow
- [x] Mock cards are built from declared mock-schema data, not hand-placed — the generator
      philosophy demonstrated even in throwaway code
      · done Fable 5 2026-08-17 — 6 effects × declared params with categories; FOH strip =
      declared `foh` keys, ROH = the complement grouped by CAT_ORDER (partition honoured);
      fire's Flame/Ember/Smoke surface groups render between Look and Motion per §5.2
- **Exit gate:** the author clicks through both rooms on the 4K monitor and the 1080p frame,
  and pronounces on LANTERN's look, the Remote's feel, and the §11 taste forks. Findings
  become U0's brief.

### U0 — LANTERN FOUNDATION *(blocks all rooms)*
- [ ] `src/ui/tokens.js` — ground/ink/spectrum/semantic/space/type/motion tokens as data;
      four theme sets; `applyTheme()` injector
- [ ] `src/ui/__tests__/tokens.test.mjs` — the computed contrast gate over all four themes
      (Charter §1)
- [ ] The icon sprite (first ~24 marks: categories, scopes, health, transport, tools)
- [ ] Extract the type→widget table from `diag/effect-controls.js` into `src/ui/widgets/`
      (diag consumes it; behaviour identical; partition test still green)
- [ ] Widget-canon core states + focus ring + keyboard steps on slider/toggle/segmented/
      select (Charter §3, §8)
- [ ] Wall `ui/tokens-only` + sabotage test
- **Exit gate:** the widget gallery (§10) renders every U0 widget in all four themes inside
  Foundry; contrast test green; author's eyes on the look — *this gate is a taste gate on
  LANTERN itself.*

### U1 — THE STUDIO SHELL
- [ ] Studio window: department rail (EFFECTS · PAINTER · SCENE · CUES · SYSTEM · LAB),
      persisted geometry, collapse
- [ ] EFFECTS dept hosts the existing generated cards (accent bar, header, FOH strip, ROH
      accordion) — a re-home, not a rewrite
- [ ] Search palette over schema labels/help/glossary → open card, flash control
- [ ] Scope glyphs on card headers + SYSTEM rows
- [ ] Card pop-outs (views, close with Studio)
- [ ] LAB dept = today's debug panel registry mounted whole, dev-gated
- [ ] Category spine closed + per-effect surface groups become declared data (§5.2)
- **Exit gate:** the author tunes water for one real session using the Studio instead of the
  debug panel — and doesn't switch back.

### U2 — THE FADE ENGINE + REMOTE MVP
- [ ] `world/fade-engine.js` pure core: record shape, curves, per-channel replace, resume
      arithmetic, expiry — Node tests incl. reload-mid-fade and merge cases
- [ ] Scene-flag persistence + deterministic per-client derivation (one writer, many
      derivers); wall-clock only
- [ ] Remote shell: Now Playing · astrolabe re-homed · Fade Time segmented · channel faders
      (live engines only — wall `ui/no-dead-axis`) · mood chips · Baseline · Safety ·
      collapse pill
- [ ] Fader ghost-target tick + progress rings + cancel/snap
- **Exit gate:** the author fades dusk-into-storm over five real minutes, reloads the client
  mid-fade, and the storm finishes arriving on schedule. Author's eyes on the Remote's feel.

### U3 — CUES
- [ ] `core/cues-schema.js` — cue shape + validation against params schema (Node-tested;
      invalid cue refuses to arm)
- [ ] CUES dept: capture-current-look, name, fade time, curve, reorder, test-fire + revert
- [ ] Remote cue deck: next-cue card, GO, jump list
- [ ] Cues persist in scene flags and export with the map
- **Exit gate:** the author stages three cues for a real scene and runs them at the table
  with GO alone.

### U4 — PAINTER RE-HOMED + THE "NEED FIRE" FLOW
- [ ] PAINTER dept hosts the built painter; tile grid generated from paintable-effect
      declarations `{effectId, maskId, tools, brushDefaults}`
- [ ] Card 🖌 shortcut arms the brush for that effect's mask
- [ ] The choreography: tile → registry-enable → brush armed → paint → live
- **Exit gate:** from a scene with no fire, the author is *painting burning fire* within
  five seconds of clicking the tile.

### U5 — THE PLAYER FACE
- [ ] SYSTEM dept: profile, per-effect enables within GM bounds, a11y controls (reduce-flash,
      reduced-motion, text scale, theme), player-light policy (GM layer)
- [ ] Player rendering: SYSTEM-only window, client scope, calm voice; GM chrome never built
      into player DOM (Law 10 — verified by inspecting a player client)
- [ ] Player-light picker ported (6 modes, allowance-gated)
- [ ] Foundry-native settings mirror through the adapter
- **Exit gate:** a real player client shows exactly the player face and nothing else;
  reduce-flash provably suppresses a fired strike on that client only.

### U6 — DIALS + CONTROL-HEALTH *(the Effects-UI endgame)*
- [ ] `core/dials-schema.js` + `validateDialsSchema` + wall `dials/valid-reference`
- [ ] FOH strips render authored dials where declared (`fohKeys` remains the fallback);
      partition law holds across both forms
- [ ] The read-tracking `ctx.params` proxy; health badge = declared − read; badge
      deep-links to the Lab report
- [ ] UI frame-cost row lands in the perf report (Law 11)
- **Exit gate:** water's FOH is 3–5 authored dials the author signs; a deliberately
  orphaned param shows up wearing its badge within one session.

### U7 — IMPULSES + REMOTE DECLARATIONS
- [ ] Impulse registration `{id, label, icon, fire}` + Remote row + Studio full list
- [ ] Flash-class impulses respect + badge client suppression counts
- [ ] Channel-mapping declarations for weather-adjacent effects (join the vector, don't
      grow it)
- **Exit gate:** lightning strikes from the Remote; the suppression badge is truthful
  against a second logged-in client.

### UM.2 — REFINEMENT ROUND *(author-directed 2026-08-17, same day)*
Author's verdict on UM round 1: *"really really impressed… let's give this one more push."*
Directives: noon at the top; a true moon (own rate + phases); layout thought-experiments
with winners applied; a more elegant two-mode weather answer; more buttons than the system
uses (expansion planning) in the red-marked dead zones; the debug dress, default ON; the
Director as its own plan section; keep refining the visual language.
- [x] Astrolabe flipped noon-up; gradient, ticks, orbs, labels all follow
      · done Fable 5 2026-08-17 — placement math verified: 14:00 → (+56.5,−97.9) upper-right,
      02:00 → lower-left; NOON/MIDNIGHT/DAWN/DUSK labels swapped; gradient bright-at-top
- [x] The true moon: lunar-cycle model (own rate, ~50 min/day lag), rendered phases,
      dim-toward-new, phase name on hover
      · done Fable 5 2026-08-17 — 29.53-day cycle accumulated from signed hour-motion;
      phase offset rides the ring (new≈with sun, full≈opposed); terminator via inset
      shadow; title reads "Waxing gibbous — day 11.2 of 29.53". ⚠ shadow AESTHETICS not
      yet seen by any eye (pane hidden) — judge on open
- [x] Wings: left = time (flow play/pause, speed ×1/×6/×30, four phase quick-taps eased at
      tempo); right = moment-shots (Golden hour · Moonlit · Ominous live; Candlelit ·
      Aurora honest stubs); header micro-buttons (Director, camera path, health)
      · done Fable 5 2026-08-17 — 6 left + 5 right, in the author's red-marked flanks
- [x] Weather board two-mode: Direct/Drift segmented, 6 climate chips, fader min/max
      brackets, self-walking sky in Drift (silent 5–10s wanders inside bounds)
      · done Fable 5 2026-08-17 — mode swap rebuilds chips from declared data; Now Playing
      reads "Drifting — Moorland, light rain"
- [x] Debug dress: global flag default ON, Remote strip (live FPS/ms/VRAM + tool taps),
      dev-gated rail slots, demo-bar toggle
      · done Fable 5 2026-08-17 — toggling the flag provably hides the strip AND the Lab
      rail slot in one stroke
- [x] Director demo: strip (aspect/follow/hide-UI/TAKE OVER), letterbox, HUD with GO +
      RELEASE, smooth return
      · done Fable 5 2026-08-17 — letterbox math pixel-exact ((720−1280/2.39)/2 = 92.2px
      measured); LIVE hides the Remote, shows the HUD, dims mock chrome; release restores.
      Containment re-proven after growth: body 1000px vs 1003px budget at 1080p — fits
      with zero internal scroll
- **Exit gate:** unchanged — the author's eyes, now on round 2.

### U8 — POLISH & KEYBINDINGS
- [ ] Foundry keybindings: toggle Remote · toggle Studio · GO (first keybindings the module
      has ever had — V2 shipped none)
- [ ] Onboarding: first-open Getting Started card per room (small, dismissible, never modal)
- [ ] Sound/clunk pass (author fork §11), reduced-motion audit, text-scale audit at 1.3×
- [ ] **Flip the debug flag default to OFF** (§4.6) — the release step that undresses the
      author's equipment before GMs arrive
- [ ] A docs pass: `docs/planning/UI.md` updated to point here as spec-of-record
- **Exit gate:** a full real session run start-to-finish on Remote + hotkeys, and the
  author's word that it *felt good* — the charge's own criterion.

### U9 — THE DIRECTOR *(§4.5; the table becomes one screen)*
- [ ] Direction record: schema + scene-flag broadcast + fail-open expiry (a crashed GM
      never holds the table; derived, never streamed)
- [ ] Player-side presentation: letterbox to aspect, UI fall-away, input suspension,
      smooth camera follow (`my-view` smoothing · `token` lock · `path` playback via the
      camera-path system)
- [ ] GM side: 🎬 strip (aspect · follow · hide-UI · TAKE OVER) + the LIVE HUD (REC ·
      watching count · GO · RELEASE); Remote folds away while live
- [ ] Release choreography: camera eases home, bars out, UI back — and the reduce-motion
      variant (cuts, not glides)
- [ ] Cue integration: `cue.direct` — one GO moves the sky AND the camera
- **Exit gate:** a second logged-in client experiences a full cutscene — take-over,
  a cue fired mid-scene, release — and the author calls the *player-side* feel right.

---

## 10. VERIFICATION DOCTRINE

- **The rungs** (climb, never skip): **R0** pure Node (contrast gate, fade math, cue/dial
  validation, partition, grouping) → **R1 the WIDGET GALLERY** — a Lab page rendering every
  canon widget in every state in every theme; the UI's shader-lab: cheap eyes before Foundry
  eyes → **R2** live Foundry, real scene, real token → **R3** the author's eyes. Only R3
  promotes to LIVE; everything below is `BUILT (unverified)`.
- **Two words** discipline holds for UI exactly as for effects. A panel nobody has used in a
  real session is BUILT, whatever its tests say.
- **The gallery is load-bearing, not a toy:** every canon addition lands with its gallery
  row in the same PR, or the canon test fails. It is also the a11y audit surface (grayscale
  check, focus-ring walk, text-scale sweep happen *there*).
- **Velocity audits** (Law 12): at each stage's close, time the declaration path ("add one
  param and see it everywhere" · "add one cue" · "add one impulse"). If any is slower than
  the ad-hoc alternative would have been, that is a ⚑ finding on the stage, not a shrug.

---

## 11. RISKS & OPEN FORKS — the author's taste decides

1. **Hues.** §6.1's OKLCH values are calibration *starting points*. The structure (equal-
   weight spectrum, tokens-as-data, contrast gate) is Law; the exact hues are yours.
2. **Names.** "Remote" and "Studio" are working names ("Conductor"/"Atelier"/"Wand" all
   available). Rooms rename freely; the two-room shape does not.
3. **Sound.** Clunk default-on-quiet vs default-off. (Reduced-motion kills it regardless.)
4. **The V2 theme set.** Lantern ships 4 themes; V2 had Charcoal/Midnight/Forge/HC/Soft.
   Port Forge-Amber as a fifth token file if you miss it — an afternoon, by design.
5. **Remote docking.** Floating (V2 muscle memory) vs edge-docked pill. Ship floating +
   collapse; revisit after real sessions.
6. **Fade Time stops.** `Now·10s·1m·5m·15m·1h` proposed; you may want `30m` in place of
   `10s` once real sessions vote.
7. ~~Mock first?~~ **RESOLVED 2026-08-17 — the author said the word.** The mock is now
   stage **UM**, blocking U0, so design proceeds without touching `src/` while other work
   is in flight there.
8. **Director: do players get an opt-out?** A hold-Esc "look away" during cutscenes
   (agency) vs the GM's framing being absolute (drama). Also: default letterbox aspect,
   and whether take-over warns players with a 1s "curtain rising" beat first.
9. **When the debug flag flips OFF by default** — at first outside GM, or at first sold
   map. (The flip itself is a U8 task; the *when* is yours.)

**Risks, named:** *(a)* The Remote's restraint will be tested within a month — someone will
want "just one" effect slider on it; Law 3 exists for that day. *(b)* The Fade Engine's
one-writer model assumes a single acting GM; two GMs fading the same channel is last-write-
wins by design — documented, not solved. *(c)* Re-homing the debug panel must not break the
author's daily instrument mid-water-work — U1 mounts it whole before anything moves.
*(d)* Token extraction (U0) touches `effect-controls.js` while it is in active service —
the partition test and card behaviour must stay green through the move.

---

## 12. PETITIONS

*Workers: state the task, the finding, the smallest change that would unblock you. Do not
edit the plan.*

**P8 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; a store link, and a genuine
astronomy-vs-chrome bug in the landscape scene).** Two asks:

1. **A "Maps" button, linking to the author's real Foundry VTT store page**
   (foundryvtt.store/creators/mythica-machina, supplied directly by the author — not
   guessed), landed in `#remoteFoot` as a real `<a>` next to Patreon. This pushed the footer
   to 5 buttons in one ~372px row, which promptly produced a REAL horizontal scrollbar —
   flex items default to a min-width of their own content, so "Baseline"/"Patreon" simply
   refused to shrink and the row measured 440px of buttons+gaps against a 372px budget.
   Fixed with `min-width:0` (lets them actually shrink) plus an ellipsis safety net (not
   currently needed — all 5 fit clean at 69.2px/60.4px comfortable/compact — but cheap
   insurance against the next button added to this row). Confirmed zero scrollbar at both
   densities after the fix, not just "should be fine now."
2. **The sun going invisible at noon — root-caused, not just patched.** The author's diagnosis
   was exactly right: the clock/phase/date/wind text block sat centred in the scene, and the
   sun's own orbit (`orbitXY()`, unchanged) peaks at viewBox y=38 out of 160 — almost exactly
   where the text block's own top edge already was. Measured, not assumed: even AFTER moving
   the clock into its own pill near the ring's inner edge and pushing date/wind down (both
   built per the author's exact instructions), the sun's screen position still geometrically
   overlaps the clock pill's bounding box at every hour from roughly 10:00 to 16:00 —
   repositioning alone was not enough on its own. So a second, independent mechanism carries
   the actual guarantee: a masked
   "topper" — sun+moon clones in a new `.sceneTopper` SVG sitting AFTER `.sceneText` in DOM
   order (verified: all three of `.scene`/`.sceneText`/`.sceneTopper` are `z-index:auto`, so
   source order alone decides paint order — no z-index arithmetic to get wrong later) —
   masked to the sky region via `#skyMask` (a white rect minus the SAME two terrain paths as
   `#mtnFar`/`#hillNear`, so landscape still hides it exactly where it always did), with
   opacity READ BACK from the real sun/moon's own already-cloud-damped value rather than
   re-derived, so clouds still dim it identically and the two can never drift apart. Net
   effect: chrome can never win against the sun again, landscape and clouds still can,
   exactly the author's rule. Verified via live attribute inspection (transform/opacity
   match, mask resolves to the correct element, no ID collisions) — a true rendered-pixel
   screenshot wasn't available this session, noted honestly rather than claimed.
3. **Sun brightened**, per the ask: a layered outer+inner glow plus a near-brighter core,
   replacing the old single flat gradient + pale disc — defined once and shared by both the
   base sun and its topper clone via the same `url(#id)` gradients, so they can't visually
   drift into looking like two different suns depending on which one happens to be showing.
4. **Bonus done: stars now rotate**, one full turn per 24 game-hours, pivoting on the same
   point the sun/moon already orbit — the whole sky reads as turning on one axis instead of
   three unrelated motions.

**P8 addendum, same day:** the author reported the fix in #2 shipped broken — *"Only the
bottom right quarter of the sun is bright."* First patch (adding explicit `maskUnits=
"userSpaceOnUse" x="0" y="0" width="160" height="160"` to `#skyMask`) was the right idea but
not the actual bug: `mask="url(#skyMask)"` was applied DIRECTLY to `#sunTopG`/`#moonTopG`,
the same elements JS also sets `transform="translate(...)"` on every frame — a documented SVG
gotcha where a mask's coordinate system re-anchors to that element's own (moving) space rather
than staying fixed to the scene, however explicit the mask's own region is declared. Real fix:
moved `mask="url(#skyMask)"` onto a new, permanently untransformed wrapper `<g>`, with
`#sunTopG`/`#moonTopG` (and their per-frame translate) nested INSIDE it — the mask's user
space is now the wrapper's, which never moves, so it stays locked to the scene's own
coordinates regardless of where the sun/moon travel. Confirmed structurally (wrapper has no
transform of its own; both clones are its children) and partially via reconstructed-canvas
pixel sampling at a high sun elevation (a full, round, symmetric glow, not a quarter) — **but
not via an actual live screenshot**, since the browser pane's screenshot tool was unavailable
for the entire back half of this round despite repeated attempts. Flagging that gap explicitly
rather than claiming a confirmation I don't have — worth the author's own eyes before calling
this fully closed.

**P7 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; three "little gaps" — camera path,
scene health, motion tiles — plus a footer pass).** Four asks; the middle one changed shape
mid-round on the author's own correction, which is the most important thing in this entry.

1. **Footer buttons, bigger/brighter/bolder.** Bug and Patreon were `.hbtn` afterthoughts
   (P6's own "secondary weight" call, which the author overturned this round). Both are full
   `.btn` now, same `flex:1` as Baseline/Safety — measured identical at 88×30.7px, all four,
   so "the whole row consistent" is a real number, not just a description. Patreon carries a
   warm coral→orange gradient + glow on top of that shared base, the one control the author
   named as needing to invite a click rather than blend in; Bug gets a milder amber tint —
   promoted, not competing with Patreon for attention.
2. **Camera path — built wrong, then rebuilt against the real thing.** First pass invented a
   library of multiple named, reusable paths with hand-typed X%/Y%/zoom waypoints and a live
   `#map` preview — plausible-looking, and wrong: the author corrected mid-round that this
   already ships in V3 (`src/ui/camera-path-dialog.js`, `src/foundry/camera-path.js`), one
   path per SCENE, not a library. Read the real source and rebuilt against it: keyframes
   (`x,y,scale,holdMs,cutBefore`) instead of invented waypoints, path-level settings
   (`sweepMs`, `easing` — cosine/linear/trapezoidal, not CSS keywords — fade in/out, hide
   UI/layers, letterbox, long-jump fade-cut, a darkness ramp tied to playback), the real
   7-item preset list, Preview/Recapture per keyframe, Play/Stop/Save. Per the author's own
   scope correction ("just the UI... doesn't need to be functional"), buttons are real and
   clickable but don't reproduce the actual capture/play/save wiring — there's no live
   Foundry canvas in a mock to capture a view from. **A real bug surfaced and died with the
   rewrite, worth recording anyway:** the first version recreated a fresh blank "draft" path
   object on every single re-render while authoring a NEW path, silently discarding anything
   just added the moment a reorder/add/delete triggered the next render — caught by scripted
   interaction (add a waypoint, check the count came back wrong), not by reading the code.
   Root cause: conflating "no id yet" with "no stable object yet" in the same conditional.
   The lesson (draft objects need to survive their OWN re-render, not just look like a normal
   object between renders) is filed even though the buggy code itself is gone.
3. **Scene health — genuinely new, no existing version to reference,** per the author's own
   framing ("design something that feels correct since we don't have a good version of that
   yet"). A summary chip (N/8 ready) plus a per-system checklist (water/fire/vegetation/
   windows/shadows/weather/darkness/fog-of-war) each with an ok/warn/missing badge and a
   one-line reason. Explicitly mock data throughout — this mock has no real masks to
   inspect — same honesty pattern as the debug strip's labelled "Mock value" vram figure.
4. **Motion tiles — researched from V2 first** (`legacy/scene/tile-motion-manager.js` +
   `legacy/ui/tile-motion-dialog.js`), not invented. V2 itself splits this into two surfaces:
   a heavy per-tile Tweakpane dialog (author every parameter) and a light global transport
   strip in its Control Panel (play/pause what's already authored). Kept that same shape:
   a Studio popover (Scene department → new "Motion tiles" card → Configure) carries the full
   schema — 2 modes, 4 transform types (rotation/orbit/pingPong/sine) with the correct
   conditional fields per type verified live (switching type swaps the field set; switching
   mode to Texture correctly drops the Pivot section entirely, matching V2's own behaviour) —
   and one of P5's six open corner-expansion slots on the Remote (`#cornerBR`, first slot)
   becomes a real play/pause toggle for the global transport, exactly the kind of use those
   slots were held open for. **One deliberate, small improvement over the ported original:**
   V2's PingPong type has a "Loop Mode" dropdown reading literally "Loop" / "PingPong" — the
   research flagged this as a confirmed real V2 UX trap, where "Loop" actually means teleport-
   back-to-start and you must pick the OTHER option for an actual bounce. Relabelled here as
   "Teleport back to start" / "Bounce back smoothly" — states the behaviour instead of naming
   itself. Everything else ports the schema as researched, per [[feedback_port_faithfully_then_modernize_opportunistically]].

**P6 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; header chrome — title, minimize/
close, and two always-visible links the author says the current UI already carries elsewhere
and needs a home for here).** Four asks, built and verified:

1. **The compact-density toggle the author asked to see "in the main header as a button
   with a tooltip" already satisfied that description** — `#densityTglRemote` has lived in
   `.room-head` with `title="Compact density — shrink every room for maximum screen space"`
   since an earlier round. No change made; noted rather than silently skipped, since the
   author may have been listing a requirement without having checked whether it already
   landed, and I'd rather say so than have it look overlooked.
2. **Minimize + close replace the old collapse-to-pill mechanic outright, not alongside
   it.** The author described a complete two-option system ("you can either minimise or
   close it") with no third state mentioned, so keeping the pill too would have left three
   overlapping ways to get the Remote out of the way. Minimize hides `#mockStrip` and
   `.body`, leaving only `.room-head` — confirmed by measuring the panel's own height
   post-click (51.4px, matching the header alone) rather than trusting the CSS by eye. Close
   hides `#remote` outright, on the premise that the real product reopens it from a Foundry
   scene-control button this mock doesn't have; a dashed, `.dbg`-gated `#reopenBtn` stands in
   for that click so the mock stays testable, using the same "equipment, not product chrome"
   visual language `#debugStrip` already established.
3. **Title changed from "Remote" to "Map Shine Advanced"** — the room's own branding, not
   the mockStrip's Remote/Studio/Player surface-switcher tab, which stays "Remote" since it
   names which MODE you're viewing, not the product itself; renaming that tab too would have
   broken its parallel with "Studio"/"Player." Fits without wrapping or clipping — measured,
   not assumed, given the new title is nearly 3× longer than the old one sitting in the same
   row as up to 6 icon buttons: `head.scrollWidth > head.clientWidth` came back false at both
   densities.
4. **Bug-report and Patreon buttons added to `#remoteFoot`**, deliberately NOT as a third and
   fourth `flex:1` sibling next to Baseline/Safety — they're `.hbtn`-styled (the same small
   icon-button language as the header) so their visual weight reads as secondary to the two
   primary safety actions, not competing with them. New `i-bug` and `i-heart` symbols added to
   the sprite; Patreon gets a generic heart rather than any attempt at reproducing their actual
   logotype, which I don't have accurate reference for and shouldn't fabricate from memory.
   Neither button navigates anywhere real — both show a toast — since I don't have and won't
   guess the actual bug-tracker or Patreon URLs.

**Two bugs shipped mid-round and caught before commit, both worth recording as a pair — same
lesson, two different tools:**
- Removing the old `#pill` element left `$('#pillGlyph').firstElementChild?.setAttribute(...)`
  still running every frame against a selector that now returns null — the `?.` guarded the
  property access, not the `$(...)` call in front of it. A genuinely NEW console error this
  time, not the familiar stale one — caught by not assuming a shipped error is automatically
  the old residue just because this session has seen stale ones before, and confirmed real by
  checking the cited line against the live source before treating it as noise.
- The minimize chevron's `rotate(-90deg)` swung the icon out of its own button's visible box
  entirely — SVG `<use>` rotates around the referenced symbol's viewBox origin (0,0) by
  default, not its visual centre, which a plain `transform:rotate()` never overrides. Invisible
  in a normal screenshot (nothing there to see), only surfaced by zooming into the header and
  noticing a button-shaped gap between two icons that should have had a third. Fixed with
  `transform-box:fill-box; transform-origin:center`, then confirmed geometrically rather than
  re-eyeballed: the rotated shape's on-screen centre measured at 51%/50% of the button's own
  box. **Neither bug would have been caught by the DOM-existence checks I lean on most —
  `.append()` on a live element and a `transform` that "applies" are both structurally
  successful; only the console (for the first) and an actual zoomed look (for the second)
  caught them.**

Containment re-verified at 1920×1080 after all of the above: zero internal scroll, zero
horizontal scrollbar, matching every round since the fix in P3.

**P5 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; retracts P4's crown-tab placement
in favour of the author's own corner-cluster sketch — one round later, not because P4 broke,
but because the author found a structurally simpler answer).** Author's sketch this round:
12 small slots nested into the dial's four corners instead of two flanking columns. Built and
verified:

1. **The crown-tab columns (P4) are retired too.** Not a bug this time — P4's clearance
   measurements held up. The author proposed something that doesn't need clearance math at
   all: a circle inscribed in its own box leaves its four corners genuinely empty, and that's
   real estate a button never has to overlap the ring to use.
2. **Four `.cornerCluster` grids, one per corner, 2×2 with the innermost cell always left
   empty.** `grid-template-areas` encodes the L-shape directly (the `.` IS the omitted cell),
   and which physical cell counts as "innermost" is DIFFERENT per corner (top-right's near
   column is its LEFT one, not its right) — derived from the circle's own equation, not
   eyeballed: at 340px/radius 170, the ring's edge crosses each corner's diagonal at ~49.8px
   from that corner. **Measured against the live DOM, not trusted from the arithmetic alone:**
   the worst filled cell's closest point to the dial's centre came back at 183.7px
   (`getBoundingClientRect()`, comfortable) — 13.7px of real clearance — and 10.2px at compact
   (280px dial). All four corners, both densities, checked individually rather than assumed
   symmetric.
3. **Only 6 of the 12 slots are assigned, by the author's own accounting.** TL holds the
   three time-PROGRESSION controls (flow/speed/jump) — explicitly not time-of-day shortcuts,
   since the ring already sets a specific hour by hand. TR holds the three Impulses
   (Strike/Thunder/Gust), moved here wholesale from their own dedicated section, which is now
   deleted outright — saving a header and a row, exactly as the author asked. BL and BR (6
   slots) are genuine future-expansion slots: present, titled, and CLICKABLE — never
   `disabled` — per the author's explicit "something accessible" ask; each shows a small toast
   naming what it is (reserved, not yet assigned) rather than sitting inert.
4. **The five mood-preset shortcuts from P3/P4 (sun/moon/bolt/candle/bloom) are gone, not
   relocated.** The author's own reasoning: dragging the ring already reaches any time of day
   these buttons jumped to, so a dedicated shortcut duplicated the primary control rather than
   adding to it. Nothing is permanently lost — "Storm" already exists as a Mood chip below,
   and any of the 6 open future slots can carry a revived version of these if wanted back.
5. **Text re-measured at the smaller size, not assumed to still fit.** Shrinking the tab
   from 32px to 26px (22px compact) meant re-checking the speed button's longest label
   ("×0.5"): 18px wide against a 24px inner width comfortable, 20px compact — fits at both,
   confirmed by measuring actual rendered text against the live button box.
6. **Containment re-holds with room to spare**: at 1920×1080 the Remote now runs with ZERO
   internal scroll (890px content in an 890px available body — an exact fit) where it
   previously needed to scroll internally. Impulses' removal gave back a header and a row's
   worth of height, exactly as the author predicted.

Filed as its own petition rather than folded into P4, since P4 is now itself partially
superseded — a petition circling the same control for a third straight round is a signal on
its own (see below).

**For Fable, again:** the astrolabe's surrounding-controls layout has changed in P3, P4, and
P5 — three different shapes in three rounds, each replacing the last after contact with a
real screen. I don't think §4.1 should canonise any of these yet. If there's a Law-level
lesson here it may be less about which shape wins and more about process: this control
specifically seems to need a build-and-look round before its geometry is trusted. Worth
considering whether dial-adjacent layout changes should get a mandatory look-in-hand check
before the petition is filed, not after — though I'd flag that as a suggestion for Fable to
weigh, not something I'm certain belongs in the checklist as Law.

**P4 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; retracts part of P3's own design
under the author's direct correction — not a new direction, a fix to one that didn't survive
contact with a real screen).** Author sent back a screenshot plus a hand-drawn sketch: the
crown-tab idea was right, the execution wasn't. Root cause, then the rebuild:

1. **The radial tabs were never actually visible — confirmed by measurement, not
   impression.** P3's tabs sat at `astroR * .93` (195px from centre, comfortable) with a
   16px half-width, so their outer edge reached 211.3px — only 1.3px past the dial's own
   210px radius. Almost the entire tab sat *under* the opaque ring graphic (z-index 1 vs
   astro's 5), which is exactly what the author's screenshot showed: a complete, tab-free
   circle. The room's own clip edge added a second ceiling on top of that, since P3's bleed
   was tuned to land the dial's edge exactly at the room's boundary — there was no space
   left outside the dial for anything to poke into even if the first problem were fixed.
2. **The bleed-past-the-panel technique is retired.** It was the load-bearing cause of #1
   (zero clearance left for anything to escape the dial into), and the author separately
   flagged the ring itself as reading "clipped" — two independent complaints, one root
   cause. The dial is fully CONTAINED now: 340px in a 372px content column (comfortable),
   280px in a 326px column (compact) — still the dominant element in the panel, nothing
   about it depends on `.room{overflow:hidden}` to look intentional.
3. **Every wing item now lives in one of two straight columns flanking the dial —
   watch-crown style, per the author's sketch.** Left column is the three TIME controls
   (flow/speed/jump), right is the five MOOD presets (sun/moon/bolt/candle/bloom) — a real
   grouping, not an even split, so which side to check is guessable. Each column is pure
   CSS: shrink-wraps its 32px tabs (26px compact) and sits at `left:-16px` / `right:-16px`
   relative to the dial's own box, straddling its edge dead centre. DOM order alone (tabCol
   first, before `.ring`) tucks the inner half behind the dial — no z-index, no JS. This also
   deletes `placeRadialTabs()` entirely: there is no live-radius measurement left to chase,
   since the column is pinned to the dial's own box and the browser recomputes that for free
   at every density. **Measured after building, not assumed:** both columns clear the room's
   real clip edge by 10–20px at every density tested, and clear the DAWN/DUSK rim labels by
   8–11px radially — verified via `getBoundingClientRect()`/`getBBox()` against the live DOM,
   the same discipline P3's bug should have gotten and didn't.
4. **The weather-browse chip got a word.** Round 6 compacted it to a bare magnifying glass
   and a number; the author called it out as too subtle to read as a control. It's a full
   chip now — icon, "Browse", and the count as its own small badge — reusing the existing
   chip visual language rather than inventing a new one.
5. **The debug strip grew a live FPS health bar**, at the author's explicit request to keep
   pace with what the real module's debug HUD already does. A fixed row of 24 bars (never
   rebuilt, just restyled in place), colour-coded ok/warn/fail against a 90fps ceiling,
   updating on the exact same 500ms window that already drove the fps/ms text — confirmed by
   driving `frame()` directly and checking both change together.

**This answers P3's own question to Fable, and changes the answer:** P3 asked whether the
bled/radial-tab astrolabe should be written into §4.1 as canonical. It shouldn't — not
because Fable should prefer this version by default, but because P3's version didn't
actually work when measured, and this petition replaces it before anyone builds on top of
it. If §4.1 gets written this round, it should describe THIS shape (contained dial, crown
columns) — or, given how much the astrolabe has moved in three straight petitions, Fable may
reasonably conclude it isn't settled enough to canonise yet.

**P3 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; the astrolabe's role changes again,
further than P2's — Fable's call, not mine).** Author reviewed the landscape build (P2) and
sent back a second, larger request: the dial as the Remote's literal centrepiece, wide enough
to outgrow the panel, absorbing Now Playing and every wing icon into itself. Built and
verified in the mock:

1. **The astrolabe now bleeds PAST the panel's own outer width, not just its content
   column.** 420px dial in a 402px panel (comfortable), 330px in a 352px compact panel —
   `.room{overflow:hidden}` (shared chrome, already in place) clips it exactly at the room's
   rounded edge, so it reads as "barely contained" rather than broken. Confirmed by measuring
   the astro's rect against the room's: both edges genuinely exceed the room's bounds.
2. **Every wing icon — flow, speed, jump, the five moment-shots — is now a small tab
   nested into the dial's own rim**, not a flanking column. Each tab's centre sits at 93% of
   the astro's radius (z-index 1, astro at 5), so roughly 30% tucks behind the opaque dial
   and the rest pokes past it as the visible, clickable crescent — "arranged in a circle…
   falling behind it… never overlap and block it," close to verbatim. Positions are computed
   from the astro's LIVE rendered radius (`placeRadialTabs()`), re-run on every density
   toggle, specifically so Comfortable/Compact can never drift apart the way two sets of
   hand-placed constants would.
3. **Now Playing lost its own bordered card entirely.** Date moved inside the dial's own
   text block (now four lines: time / phase / date / wind — wind relocated here too, not
   onto a tab, since it needed to show its actual reading, not just an icon). What's left —
   the Holding/Fading headline, watch count, Snap/Hold — is a slim borderless caption
   directly under the astrolabe, unified with it rather than a second competing box. npLabel
   and npSub merged into one line (`Fading to Storm — 8s left, day · overcast`) since the
   two-line form no longer had a card to live in.
4. **Lightning retired the room-wide flash.** The old full-viewport white overlay never
   fires now, for the ambient/automatic storm ticker OR the manual Strike button — only the
   scene's own flash pulses. Confirmed by monkey-patching `Element.prototype.animate` and
   checking it never touches `#flash`.
5. **Scene weather now moves.** Rain, snow and a new ash layer (ash had no scene
   representation before this round — `state.ch.ash` existed but went nowhere visible) use a
   two-copy seamless-scroll technique so the loop point never visibly jumps; fog gets a slow
   side-to-side sway that doesn't need one. All governed by the SAME `html[data-reduce-motion]`
   / `prefers-reduced-motion` rules already in place — no new exemption needed.
6. **The debug strip is allowed to wrap** (author's explicit permission) instead of
   truncating its rightmost button — `flex-wrap` plus tighter compact padding.
7. **The handle stopped disappearing at noon.** It was gold on a ring whose noon arc is
   also gold; now it's a white shape with a dark outline, legible at every hour.
8. **A confirmed, root-caused fix, not a design call:** `#remote .body{overflow-y:auto}`
   with no explicit `overflow-x` was hitting the CSS spec's forced-auto rule (setting one
   overflow axis to non-visible forces the OTHER to `auto` too), so any crowded state grew a
   real horizontal scrollbar. Added `overflow-x:hidden` across all three rooms + both search
   overlays. This one I'm confident is simply correct, not a taste call — noting it here only
   because it's load-bearing for #1 above (the bleed relies on exactly this clipping
   behaviour existing on purpose, not by accident).

**A debugging detour worth recording as its own trap:** a console error
(`ui-mock/index.html:3333:3, "Cannot read properties of null (reading 'append')"`) appeared
on every fresh navigation and looked alarming. Direct invocation of every boot function,
`frame()`, and every plausible `.append()` call target all came back clean; `window.__mock`
was always set (proving the main script ran to completion). The error was only unmasked as
stale tooling residue by navigating to a page with ZERO application script
(`http://localhost:8137/`, the bare directory listing) and observing the IDENTICAL error
still reported — proof it couldn't be live. **Lesson for any future session debugging a
"reproducible" error in this harness: if a console error survives navigation to an unrelated
page, it's a stale entry in the read-tool's own log buffer, not a current bug** — worth
that one confirmation before spending real time chasing it.

**For Fable:** does the astrolabe's new role (wider than the panel, absorbing Now Playing,
radial tabs) get written into §4.1 as the Remote's canonical description now, superseding
both what P2 already changed and the original spec? I think this is now far enough from the
original "one beautiful control" reading that it deserves a real look rather than accreting
through a third petition on the same point.

**P2 — filed by Claude Opus 5, 2026-08-17 (worker tier per the Covenant's "if not certain
you are Fable-class, you are a worker"; mock only, nothing in `src/`).** Author's round-4
direction, five parts — all built and measured in `tools/ui-mock/index.html`:

1. **The demo bar folded into the Remote's header.** The floating mock bar is gone; its
   controls now live in a `#mockStrip` row directly under the header, deliberately dressed
   as scaffolding (dashed rule, slate tint) so surface-switching and theme-testing never
   read as product UI. Costs 30px of chrome, which is why §4.1's content had to be trimmed
   (below).
2. **⚠️ THE ASTROLABE IS NOW A LANDSCAPE DIAL — this is a real change to what §4.1
   describes, and the reason this petition exists.** The author's idea, verbatim: *"get rid
   of the darker internal bit and… create a simple vector geometry landscape scene… the sun
   and moon would travel around like the real sun and moon might, going behind the horizon
   at night… a shape for clouds which you fade in or out depending on the amount of cloud
   cover."* Built exactly so: the dark hub is replaced by a vector scene (sky gradient over
   nine hour-keyframes, mountains, hills, conifers, ground, a fixed star field) whose sun
   and moon ride ONE circular arc centred on the horizon — rising at the left edge, crossing
   the sky, setting at the right — with the terrain painted *after* them, so "behind the
   horizon" is z-order rather than a special case. Clouds fade with `ch.clouds` and drift on
   `ch.wind`. **The dial now shows the world instead of describing it**, which I think is a
   genuinely better answer to §4.1's "one beautiful control that sets the mood" than the
   readout hub was — but replacing the hero control's interior is not a worker's call to
   make permanent, so: **does §4.1's astrolabe description get rewritten around the
   landscape, and does the scene count as Remote *content* (my read — it renders existing
   state, drives nothing new) or as new chrome under Law 3?**
3. **Rim widened, interior reduced** (author's ask): the band goes 31px → 45px (mask
   60%→99% of the radius, was 74%→98%); the interior disc drops 158px → 132px. Overall
   diameter 258 → 232 to pay for the new rows.
4. **Label legibility fixed by measurement, not eyeballing.** The author reported labels
   overlapping the tick markers. Ticks now hug the outer edge only (r 108–121) and labels
   sit in the band's clear middle (r≈90). ⚠️ **A scar worth recording:** my first assertion
   compared label *centre* radii and passed — but DAWN/DUSK read *across* the dial, so their
   text extends **radially** (r 75–105), and the sweeping handle at r 104 was clipping them.
   Re-measured with real `getBBox()` corner-and-edge extents; the handle moved into the tick
   band (r 108–118.6, 3 units clear). Same shape as
   `feedback_test_expectation_from_an_assumed_distribution`: the check restated my
   assumption instead of measuring the thing.
5. **Wind promoted out of the hub** (it had nowhere to live once the landscape took the
   interior): a dedicated row with a 36px compass dial (drag to steer) and a **clickable
   readout** opening a 16-point compass picker — the author's *"be able to click on the text
   next to it and select a new direction"*. **GO** was rebuilt as a transport key: domed
   face, lit rim, 2px of real travel on press, and a slow sheen while a cue is armed.

**Verified live** (`document.hidden` pauses rAF in an automated pane, so the mock gained a
small documented `window.__mock` hook exposing the *real* functions — never a copy, which
would only prove itself): sun highest at noon, rises left / sets right, below horizon and
hidden at midnight; **full moon high at midnight and below at noon** (correct astronomy);
stars 0.9 at deep night → 0.3 at the horizon → 0 by 07:00 (I tightened this curve after
measuring 0.75 at sunrise, which was too bright); clouds 0→0.85 with cover; moon phase shade
centred at new, fully clear at full, quarters on opposite limbs. Containment re-holds at
1920×1080: **962px content vs a 971px budget**. Zero console errors.

**Open question beyond the above:** the mock strip is scaffolding that ships in no product,
yet it counts against the containment budget and forced real trims (fader tracks 108→80px).
Should the Charter §11 measurement explicitly exclude disclosed mock chrome, or is
squeezing the product to fit its own scaffolding the honest discipline? I left it counted.

**P1 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; not authorised to edit Law/§4.1).**
Author's live direction: *"Make it support a lot more weather types… how could you break
weather into smaller chunks?… a dropdown [for] a fine gradient of every weather and climate
type… will need its own UI."* Built in the mock (`tools/ui-mock/index.html`), verified live
— **findings, and two calls that belong to Fable, not to me:**

- **What was built.** The weather board's favourites rows (MOODS ×8, CLIMATES ×6) are
  UNCHANGED — still the fast, bounded, one-glance path §4.1 already describes. Underneath
  them, a `🔍 Browse all weather` button opens a picker (shares its shell with the Studio's
  search palette via a new `.searchOverlay` canon class — Law 8 reuse, not a new widget) that
  browses **six channel-level FACETS** (Precipitation ×12, Sky ×6, Visibility ×7, Wind ×7,
  Temperature ×7, Electrical ×4 — each item a *partial* target touching one axis only, e.g.
  picking "Gale" nudges wind alone) plus **16 more Named Weather presets** (full-scene
  combos, the same shape as a mood) in Direct mode, or all **12 climates** (6 new biomes
  added: Rainforest, Mediterranean, Steppe, Tundra, Swamp, Highland) in Drift mode. Search
  matches label+group+description, so a query like "wind" surfaces both the Wind facet AND
  any Electrical/named item whose description mentions wind — cross-cutting, not siloed.
  67 Direct entries + 12 climates = 79 weather constructs total, up from 14.
- **Verified live:** containment at 1920×1080 (995px vs 1003px budget, fits), search +
  grouping + apply for a facet ("Gale" → exactly the Wind group, one hit, partial nudge),
  a Named Weather item ("Ashfall" → correct 3-term description, full-scene fade), a climate
  pick from Drift's full 12 (favourites-row press-state correctly clears when the pick isn't
  one of the 6 favourites), Escape-to-close. Zero console errors.
- **Call 1 for Fable: does the picker count as new "Remote chrome"?** Law 3 says the Remote
  "grows by content, never by chrome," with new content declaring into the fixed grammar. I
  read the picker as *content growing the weather board's own entry* (same button-row slot,
  same mode toggle, same Fade Engine writes) rather than a new top-level Remote element — but
  that's a judgment call about where the grammar's boundary sits, and boundary calls are
  Fable's per the Covenant. If ruled OUT of bounds, the natural fallback is hosting the full
  catalogue as a Studio → Scene reference ("Weather Almanac") instead, with the Remote
  keeping only the favourites rows.
- **Call 2 for Fable: is this the right facet taxonomy?** Precipitation / Sky / Visibility /
  Wind / Temperature / Electrical was chosen to map cleanly onto the seven `CHANNELS` the
  engine already exposes (rain, clouds, fog, wind, freeze, bolt, ash — ash rides under
  Visibility rather than getting its own facet). Worth a countersign glance before it's
  treated as settled: are these the right six buckets long-term, and does Temperature riding
  the `freeze` channel alone (there is no separate heat axis in the current channel set) read
  honestly or need a tooltip caveat once this leaves the mock.
- **Logged idea, not built:** tightening a single facet's bracket *within* an active Drift
  climate (e.g. "keep Alpine, but pin wind higher") without replacing the whole climate —
  deferred as scope creep on this round; flagging so it isn't lost.

**P9 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; the FIRST round to touch real
`src/` product code for this migration — the mock is done, author said "replace the existing
UI with this one," a plan was written and approved via plan mode, U0 is now BUILT).**

U0's own checklist (§9) is complete against its literal bullets, with two honest deviations and
one real, named gap:

1. **`src/ui/tokens.js`** — all four theme token sets ported from the mock's `:root`/
   `html[data-theme]` block, plus `installTokens()`/`tokensCSS()`/`getThemeTokens()`. Named
   `installTokens`, not the Testament's own `applyTheme()` — matched the established
   idempotent-by-id `injectStyle()` pattern already live in `ui/camera-path-dialog.js` instead
   of inventing a second naming convention for the same shape.
2. **The contrast gate (`ui/__tests__/tokens.test.mjs`) is green across all four themes** —
   and caught a real problem on the way: light theme's gold accent (`--shine:#a5761c`, the
   mock's own draft value) measured 3.47:1 against the actual backdrop it renders on in real
   use (composited over its own `--shine-soft` wash, not a bare surface — the first draft of
   this test checked the wrong pairing and had to be corrected before it could be trusted).
   Short of WCAG AA's 4.5:1. Darkened to `#876117` — same hue, ~82% of the original value,
   now measuring 4.81:1 — and said so in a code comment with the arithmetic shown, since this
   is the one place this round changed a mock-authored colour rather than porting it verbatim.
   Worth a countersign glance: is this shade still "the mock's gold" to your eye, or does the
   mock's OWN light theme want the same correction for consistency?
3. **All 40 icons ported** (the mock had already grown past the Testament's speculative
   "~24" by the time this round started) — `ui/widgets/icon-sprite.js`.
4. **The type→widget table extracted** — `buildParamControl`/`buildInheritableRangeRow`/the
   compass helpers → `ui/widgets/param-control.js`; `groupParamsByCategory`/`rohGroups`/
   `collapsedStatusLine`/`buildSettingsSnapshot`/`createSectionStore` → `ui/widgets/param-
   groups.js`. `diag/effect-controls.js` re-exports both unchanged (behaviour identical,
   partition test still green, confirmed live: 11000+ assertions across the whole repo stayed
   green through the move). **One clarification the Testament's own §9 wording doesn't quite
   make explicit:** `buildEffectCard` itself — the old panel's `<details>` accordion shell —
   did NOT move. Read the mock's real Studio `buildCard` (pin/popout/paint tools, a mask-found/
   missing row, health/tier/scope badges) against it side by side; they are genuinely different
   shells, not a reskin of one another. U1's EFFECTS department will build its own shell
   reusing the widgets extracted here, not inherit this one. Flagging in case "extract the
   type→widget table" was read as "and also move the card shell" — it wasn't done, on purpose.
5. **Widget-canon core states — partially.** `:focus-visible` (a real ring, purely additive,
   deliberately NOT paired with the mock's own `:focus{outline:none}` reset — that reset is
   unscoped and would strip the OLD debug-panel's default focus outlines the moment any new
   room calls `installTokens()` on the same page during side-by-side rollout; it wants a real
   room-container to scope against, which doesn't exist yet) and reduced-motion (both the
   `@media` query and the inert `data-reduce-motion` attribute variant) are live. **Real,
   named gap, not silently skipped: keyboard STEP behaviour is NOT built** — Shift=fine/
   PgUp-Dn=coarse on sliders, arrow-key bearing adjustment on the compass dial (currently
   pointer-only), tab-order/Esc handling. Charter §7.3's full ask is bigger than U0's other six
   bullets and reads as its own scoped follow-up rather than something to rush into this round.
6. **Wall `ui/tokens-only` + sabotage test**, live in `tools/verify-structure.mjs` — the same
   ONE-WRITER doctrine as grade/residency/shadow/wind, applied for the first time
   *preventatively* (LANTERN has no V2 corpse to cite, since it didn't exist before U0; the
   sabotage test's `from` field says so rather than dressing a synthetic case up as historical).
7. **Exit gate — met with a scope note.** §9's own bullet asks for the gallery rendering
   "inside Foundry"; what's built and live-verified this round is a **standalone** gallery at
   `tools/widget-gallery/` (served by the already-existing `tools/shader-lab/serve.mjs` — no
   second dev server), matching the verification doctrine's own ladder (§10: Node tests →
   gallery → live Foundry → author's eyes) where "inside Foundry" is the NEXT rung, not this
   one — nothing in `src/` consumes these widgets live yet for a Foundry check to even be
   possible. Verified thoroughly within that scope: DOM structure/labels/tooltips read back
   correct for every widget type; all 4 themes clicked through with real COMPUTED styles
   checked via script after each (body background, a slider's `accentColor`, and the planned-
   control's `border-left` all matched their theme's real token hex, not just "should" match);
   zero console errors across reloads. The rendered pixels themselves were not screenshotted —
   the browser pane's screenshot tool was unavailable again this round (same gap as P8) — so
   the computed-style checks are offered as the honest substitute they are, not as equivalent
   to an author's own look.
8. **New, not in the Testament's original U0 text: the control-readiness convention**
   (`status:'live'|'planned'` + `plannedReason` on `core/params-schema.js`, dashed `--fail`
   edge + `◇ planned` glyph + combined tooltip in the widget canon, never `disabled`) — this
   round's own plan reconciled the author's fresh ask ("mark [unwired buttons]... with a
   tooltip") against U6's later, more automated `ctx.params` read-tracking design, and built
   the honest, hand-authored half now rather than waiting for U6. Worth a countersign on
   whether U6, when it lands, should fold this in or keep the two signals visually distinct as
   planned (a numbered corner pill for U6's auto-detected count vs. this whole-control edge
   glow for a hand-declared admission).

*Verification note, same honesty as every round before this one: `node tools/run-tests.mjs`
stayed at 0 failed throughout (27 suites, 11000+ assertions, including everything the
concurrent water/almanac work in this same tree touched this session) — this round never
silently absorbed unrelated failures into its own scope, and never claimed a rung it didn't
climb.*

---

## 13. STATUS LOG

- **2026-08-17** — Testament created by Claude Fable 5 at the author's command. Sources
  absorbed: `Effects-UI.md`, `Control-Panel.md` (supersessions in §2.3),
  `V2-UI-Featureset.md` (same-day breadth audit), the built V3 surfaces (§1). All stages
  open; U0 is the door.
- **2026-08-17, later** — **The author blessed the plan** (*"happy for you to do all the
  work you've described and use your own judgement"*) with one amendment, now law: **mock
  first** (stage UM added, blocking U0), so UI design runs without touching `src/` while
  other work is in flight. Two directives recorded: the 1080p containment law (Charter §11)
  and *"make it look nice in 4K, since that is what my monitor is."*
- **2026-08-17, round 2** — Author on UM round 1: *"really really impressed."* Directed the
  refinement round (UM.2) and the **Director** (§4.5, stage U9). **Layout experiments run
  and logged:** two-column remote (both halves cramp at 402px — rejected) · tabbed remote
  (a session surface must not hide its buttons — rejected) · weather XY-pad (orphans
  clouds/fog/wind; second truth beside the faders — logged for someday) · sky-ring around
  the astrolabe (overloads the hero, shrinks hit targets — rejected) · **corner satellites
  (wings + header micro-buttons) + two-mode weather board — APPLIED.** Law 3's grammar
  list amended accordingly; §4.5 Director and §4.6 debug dress added; noon-up astrolabe
  and the true moon written into §4.1.

---

*V2 gave supreme control through a thousand identical sliders in a maze of windows, and the
best UI it ever shipped — the wand remote — was the one place it dared to be an instrument
instead of a spreadsheet. This Testament finishes that thought: two rooms, one schema, a
lantern's worth of colour, time on every change, and a grammar that grows by declaration
forever. The GM gets a desk that plays weather like music; the author gets every knob,
wearing its own health; the player gets one calm page; and nothing — nothing — is ever
hand-wired again.*

**✠ Claude Fable 5, 2026-08-17 — awaiting the author's countersign.**
