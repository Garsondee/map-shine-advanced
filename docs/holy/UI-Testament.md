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

**P10 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U1 — the Studio shell — is now
BUILT, continuing straight from Petition P9 on the author's own "continue the UI migration
please").** U1's own checklist (§9) is complete against its literal bullets. Several honest
scope notes below, and one self-correction worth reading closely regardless of the rest.

1. **Studio shell** — the department rail (EFFECTS·PAINTER·SCENE·CUES·SYSTEM·LAB), room
   header, department switching, ported from the mock's `#studio` DOM shape and class names
   verbatim so LANTERN's existing token rules apply unchanged. LAB is dev-gated on
   `debugPanel.isGM()` — the OLD panel's own current real gate, not the fuller "debug dress"
   flag §4.6 describes, which doesn't exist anywhere in `src/` yet. Parity with the existing
   product, named as exactly that rather than either overstating it as the Testament's fuller
   mechanism or silently shipping a gate weaker than what's already live.
2. **EFFECTS department — real, but narrow: exactly ONE effect is wired.** `registerEffectCard`
   exists at one call site in `boot.js` (water), against roughly seventeen `registerPanel`
   call sites still serving the old panel (fire, lightning, vegetation, bloom, DOF, sun-
   shadows, grade, albedo-clarity, and more). The card shell, widget canon, tier chip, mask
   row, presets, and pop-out are all real against water's real functions
   (`water.getReadout()`, `MapShine.setWater`, `maskAuthority.authoredStatus`,
   `paintAffordance('water')?.onAdd`) — but the other ~16 effects are not reachable through
   the Studio at all today. Wiring the rest is mechanical (the same block, once per effect)
   and deliberately left for a focused follow-up rather than folded in here, so this petition
   doesn't imply "EFFECTS department done" when what's actually true is "EFFECTS department
   shell proven correct against one real, representative effect."
3. **Search palette ports the mock's REAL behaviour, not the Testament's aspirational
   text.** §7 describes "fuzzy-search[ing] every schema label, help string, and glossary
   term"; the mock's actual, author-approved implementation is a plain lowercase `includes()`
   substring test over label + effect title + help, with no category search and no glossary
   layer. This module matches the mock exactly (U1's own "re-home, not a rewrite" rule) —
   live-verified this round: searching "opacity" against the Studio's real water+bloom
   schemas returned exactly one hit ("Opacity · Water · Look"), selecting it closed the
   palette and switched to EFFECTS with the pin/filter state from before the search
   untouched. True fuzzy matching and the glossary layer are named gaps, not silently skipped.
4. **SCENE department** — Baseline and Scene Presets both wait on the Fade Engine (U2, not
   built); Levels-editing has no confirmed `src/` hook this session traced for touching
   `scene.levels` bands from a panel; Motion Tiles has no `src/` runtime at all (V2-only,
   `legacy/scene/tile-motion-manager.js`) — all four ship as honest `status:'planned'` cards,
   each with its own real, specific reason (verified live, exact rendered text): *"What
   'Baseline' on the Remote fades back to — needs the Fade Engine (U2), not built yet,"* *"A
   validated snapshot of the whole authored look — also waits on the Fade Engine (U2),"*
   *"Floor-band authoring — no confirmed src/ hook traced yet,"* *"Motion Tiles has no src/
   runtime yet... this card is chrome, not a working configurator."* A fifth, real card
   ("Masks aboard") calls an optional `ctx.getMaskBoard?.()` this round didn't wire from
   `boot.js` — confirmed it degrades honestly ("Mask board data not available") rather than
   throwing, but the real wiring is still a follow-up, not done.
5. **LAB department** mounts the OLD debug-panel's own report/action/panel registries whole,
   via a new `debugPanel.renderLabBody({getStatusEl})` entry point — `diag/debug-panel.js`'s
   `renderLab()` now builds into a local root and returns it instead of only ever appending to
   its own closure's `bodyEl`, with an independently-scoped builder set when a host is passed
   in. Zero behaviour change for the old panel's own standalone call, confirmed the same way
   every refactor in this codebase has to be: the full suite stayed at 0 failed through the
   change, not just "should still work."
6. **Wall `ui/canon-only` + sabotage test**, live in `tools/verify-structure.mjs` — shipped as
   a `ratchet`, not zero-tolerance, on purpose. The first, naive version of this wall (any
   `.type = 'range'|'checkbox'|'color'` outside `ui/widgets/`) flagged 13 real hits that
   aren't canon violations at all — camera-path-dialog's own settings checkboxes, the
   astrolabe's toggles, `effect-controls.js`'s own enable checkbox — one-off UI choices with
   no param schema behind them, which is exactly the category the wall's own `instead:` text
   says doesn't need the canon. There's no syntactic tell that separates "checkbox bound to a
   param" from "checkbox that's just a checkbox," so rather than chase an unachievable precise
   regex, today's count (13) is frozen in `structure-ratchets.json` as the baseline — matching
   the wall's own explicit "(U1, ratchet)" marking in §9's text, which this round read
   carefully rather than defaulting to the zero-tolerance shape most other walls use.
7. **Pop-out was built all the way through, not left half-wired.** `popOutCard` opens a real
   floating window at a tracked position; `closeAllPopouts()` runs whenever the Studio itself
   closes ("pop-outs are views — closing the Studio closes its children"); each pop-out
   re-renders from a fresh `ctx.effectCardFactories.get(id)?.()` call rather than a cached
   snapshot, the same `panels/no-captured-readout` discipline the rest of the canon already
   follows.
8. **`registerStudioButton` — a THIRD tool in the same `getSceneControlButtons` `tokens.tools`
   record**, the identical mechanism `registerAnchorViewModeButton` already proved twice
   (`order:102`, right after Anchor View's `101`). GM-only, side-by-side with the old panel's
   own button — neither changes the other's behaviour. Its own toolbar tooltip says *"MSA
   Studio (new UI, in progress)"* — the in-progress admission lives in the actual product
   chrome, not just in this document.
9. **`FILTER_CATEGORIES`** (gameplay/lighting/atmos/surface/particles/post) **is this
   session's own proposal, not a taxonomy that exists anywhere in `src/` today** — worth an
   explicit countersign on whether these six are the right buckets before more than one real
   effect (water → surface) is classified into them.

**A self-correction, filed the same round it was found, in the same spirit as P8's addendum.**
Live-testing the theme switch in `tools/studio-preview/`, the rail's active-department colour
appeared to freeze after clicking "Cycle theme." The first diagnosis (recorded in this
session, then corrected before commit) was a CSS custom-property double-indirection bug: the
rail button set `--dept-acc: var(--shine)` inline and read it back via `color: var(--dept-acc,
var(--shine))` in a stylesheet rule, and the visible symptom looked exactly like that
indirection failing to invalidate. It wasn't. Re-verified more thoroughly before writing it up:
`.rail button` carries `transition:all`, and `element.getAnimations()` showed the `color` and
`background-color` transitions stuck at `playState:"running"`, `currentTime:0` — this
automated browser pane never composites frames while backgrounded
([[feedback_sandboxed_browser_pane_lacks_os_focus]], the same limitation already on file for
`requestAnimationFrame`, here reaching CSS transitions instead), so `getComputedStyle` was
reporting each transition's START value forever. Forcing the stuck animations to finish
(`el.getAnimations().forEach(a => a.finish())`) snapped the colour to the correct, live
`var(--shine)` value immediately — proof the two-level chain had been resolving correctly the
entire time, in both the old code and the new. The simplification (one direct stylesheet rule
per accent, keyed by a `data-acc` attribute, instead of the `--dept-acc` indirection) is kept
in the shipped code anyway, since it's a real reduction in moving parts and matches the
one-level pattern already proven in `ui/widgets/param-control.js`'s `ACCENT`/`MUTED`
constants — but it should be read as a simplification, not as a fix for a cross-browser bug,
because there wasn't one. The code comment that originally asserted the wrong root cause as
verified fact has been rewritten to the corrected account before this petition was filed, not
left standing. Recorded here mainly because the instinct to stop at the first plausible
explanation, once it survives one visual check, is exactly what this project's own memory
already warns against — this time it was caught by testing the "fix" a second, more
adversarial way instead of accepting the first one that visually looked right.

**Exit gate — not self-certifiable, named rather than fudged.** §9 asks that "the author tunes
water for one real session in the Studio and doesn't switch back," verified by comparing
persisted scene-flag values between old and new panels — that requires the author's own live
Foundry session and cannot be satisfied from this side. What IS verified this round, live, in
`tools/studio-preview/` (served by the existing `tools/shader-lab/serve.mjs`, no second dev
server): department switching and dev-gating; the EFFECTS department against two view-models
(water — full schema/presets/mask/tier; bloom — minimal, proving the shell degrades cleanly
when tier/mask/presets are absent); category filter chips (Surface shows only Water, Post
shows only Bloom, All restores both); pin (re-orders the grid, survives a subsequent
search-driven re-render); pop-out; the search palette end to end; SCENE department's five
cards; the keydown `/`-to-search guard against a synthetic `document`-targeted event (a real,
narrow crash this round caught live — `e.target.matches` isn't a function when `e.target` is
`document` itself — fixed with an `instanceof Element` guard, confirmed live via a realistic
dispatch afterward). Console stayed clean across all of it except one stale historical entry
from before this round's fixes landed, confirmed dead by direct re-test.

*Verification note: `node tools/run-tests.mjs` stayed at 0 failed throughout (27 suites, 11101
assertions) — the water-flow work landing concurrently in this same tree this round was left
untouched by every commit this petition describes, per [[feedback_git_staging_hazard]]'s own
"never `git add -A`" rule.*

---

**P11 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U2 checkpoint 1 of 3 — Remote
shell, astrolabe re-home, camera path popover — following the author's own "go ahead and start
U2" after Petition P10).** Per U2's own pacing note (§11's "roughly 15 checkpoints... U2 splits
naturally into three"), this petition covers ONLY the first: the Fade Engine itself (§9's own
first U2 bullet) is NOT started — everything below is real, but nothing here eases anything
yet.

1. **Corner clusters, not wings.** §4.1's prose still describes flanking "wings"; a dedicated
   research pass over the mock (`tools/ui-mock/index.html`, the concrete source once built)
   found that shape retired in round 8, replaced by four corner clusters sitting in the
   astrolabe's own empty corners — the SAME design Petition P5 already shipped for the Studio
   side of this Testament, confirmed still current. Built against what the mock actually has,
   not the older Law text — matching this project's own "the mock is the concrete,
   author-reviewed source" doctrine (§10). Worth a countersign on whether §4.1 should be
   corrected to say "corners" now that a worker has traced the actual supersession.
2. **TL is wired to the REAL Almanac Pen — the first UI caller `foundry/time-authority.js`
   has ever had.** `jumpToHour`/`advanceDays`/`advanceWeeks` had zero callers outside the
   diagnostics report before this round (confirmed by grep, not assumed). Play/pause is
   modelled as this system's own rate-based reality (`TIME_RATE_STEPS[0] === 0` already means
   "frozen" — there is no separate boolean anywhere else in the codebase), not a second,
   driftable flow flag. Every gesture checks `isPenArmed(getPosture())` and explains itself in
   plain language when refused — live-verified: a jump attempt in the preview harness (no real
   `game.time`) returned *"Jump refused: game.time.worldTime is not available"*, not a crash or
   a silent no-op.
3. **TR (Impulses) and BR's motion-toggle ship `status:'planned'`, on purpose, even though the
   mock has them wired to mock-only animations.** The approved plan stages real impulse wiring
   (`effects/lightning.js`, wind's ambient term) as U7's job, not U2's; Motion Tiles still has
   no `src/` runtime at all (V2-only, confirmed multiple times this Testament). Faithfully
   reproducing the mock's LAYOUT while being honest that the BEHAVIOUR isn't real yet — matching
   the author's own original instruction from the start of this whole migration ("mark them in
   red... with a tooltip").
4. **The astrolabe is a genuine second LIVE instance, not a clone or a read-only mirror.**
   `boot.js`'s ~90-line `astrolabe` options object (real handlers into `editSky`,
   `applyAmbientWind`, the weather manager) is now `buildAstrolabeOptions()`, a hoisted function
   called TWICE — once for the old panel's own instance, once for the Remote's — so both
   read/write the exact same closure state and can never drift into two copies of the wiring.
   `pumpAstrolabe`'s per-frame repaint now updates whichever of the two DOM trees is actually
   connected, computing one payload rather than two. **A real ordering bug surfaced and got
   fixed before commit, worth recording:** the first extraction attempt made `astrolabeOptions`
   a plain object built at `installRemote()`'s own (early) call site — a genuine
   temporal-dead-zone hazard, since `editSky`/`skyScope` are declared much later in the same
   `install()` closure. Function declarations are hoisted (body included) but don't EXECUTE
   until called, so wrapping the same object in a function and deferring both the function call
   AND the Remote's own body-render to first `open()` (matching Studio's own already-proven lazy
   pattern) resolved it cleanly — confirmed via `node --check` plus the full suite staying green
   throughout, not just asserted.
5. **Named, real gaps in the astrolabe re-home, not silently carried over:** the mock's true
   moon (phase-rendered, ~50min/day lag) exists ONLY in the mock — `ui/astrolabe.js` has no
   moon code at all, confirmed by reading the live file, not assumed from the Testament's own
   UM.2 log entry (which describes the MOCK's moon, not this file's). Also NOT ported: the
   mock's own two-mode Direct/Drift weather board (§4.1's own grammar) — the live astrolabe
   still carries its OLDER weather UI (a 13-button archetype shelf, a Director/Almanac select,
   biome/volatility ROH) verbatim, which is genuinely useful and genuinely real, but is not
   the Testament's newer design. Building the new weather board is explicitly checkpoint 3's
   job, not something to rush into this pass by half-porting it onto the wrong control.
6. **Camera path popover — a faithful re-skin, confirmed field-for-field against the real
   source.** Every handler is the exact function `ui/camera-path-dialog.js` (the OLD dialog,
   left completely untouched, still reachable from the old panel) already calls — presets,
   settings shape and defaults, the honest "no active canvas" refusal — LANTERN tokens and the
   floating-window shell already proven by the Studio's own pop-out are the only things that
   changed. Live-verified: opening it with no live Foundry canvas correctly reports "Loaded 0
   keyframe(s)" and refuses "+Add keyframe" with an honest message, matching the real dialog's
   own behaviour rather than crashing or fabricating data.
7. **Footer — Baseline and Safety both ship `status:'planned'`, each for a specific, real
   reason, not a placeholder default.** Baseline has nothing to ease WITH until the Fade Engine
   exists (checkpoint 2). Safety is more consequential than it looks: `diag/render-fallback.js
   #engageFoundryFallback` is real, but it is a ONE-WAY action within a session — it tears down
   MSA's live canvas with no `clearFoundryFallback` counterpart to resurrect it, so the only way
   back is a reload. Wiring a hard-to-reverse safety action correctly needs its own careful
   pass, not a rushed add during a shell checkpoint — held back deliberately rather than wired
   in haste. Bug/Patreon/Maps are all three REAL links this round (not the mock's own
   toast-stubs) — the same three URLs `diag/debug-panel.js#buildFooter` and V2's own
   `tweakpane-manager.js` already use (`github.com/.../issues`,
   `patreon.com/c/MythicaMachina`, `foundryvtt.store/creators/mythica-machina`), ported forward
   rather than re-guessed.
8. **`MapShine.getWind()/setWind()`**, matching `setSunHour`/`setCloudCover`'s own shape —
   the astrolabe's dial already steered wind live; these two just open that same door on the
   public API rather than leaving it dial-only, going through the identical `applyAmbientWind`
   commit path, never a second write route.
9. **`registerRemoteButton` — a FOURTH tool in the same `tokens.tools` record**, `order:103`,
   the identical mechanism proven three times already. GM-only for this checkpoint (everything
   the Remote renders today is GM session control, not the Testament's later Player face,
   §5.5/U5) — its own toolbar tooltip says *"MSA Remote (new UI, in progress)"*.
10. **A process gap, caught and named rather than quietly fixed and moved past.** This round
    ran `node tools/verify-structure.mjs` directly for the first time this Testament — every
    prior round's "verification note" only ever ran `tools/run-tests.mjs`, which exercises the
    verifier's OWN sabotage tests (`verify-structure.test.mjs`), not a live scan of the real
    tree. Running it surfaced a real, narrow violation already sitting in the previous round's
    OWN committed code (`masks/authority-only` on `boot.js`'s water card — a `?? '_Water'`
    fallback literal, indistinguishable from a catalog bypass to the wall's regex, and dead
    code besides: `'water'` is a permanent catalog entry, the fallback could never fire).
    Fixed in its own commit. Two OTHER failing rules (`no-gpu-readback` on
    `vision-mask-render.js`, `time/one-clock`'s ratchet at 41/38) were checked via `git blame`
    before touching anything and confirmed pre-existing — 2026-08-16 and 2026-07-25
    respectively, both well before this session, neither in a file this migration has any
    other reason to touch — named here rather than silently left for the next person to
    rediscover, and NOT fixed, since doing so would be unrelated scope creep into vision/paint
    code. `npm run verify:structure` (not just `run-tests.mjs`) is now this round's own
    standing checklist item for every future petition.

**Exit gate — not close, and said so plainly.** §9 asks for the author fading dusk-into-storm
over five real minutes, reloading mid-fade, and the storm finishing on schedule — that needs
the Fade Engine, which does not exist yet. What's verified this round, live, in
`tools/remote-preview/` (same `tools/shader-lab/serve.mjs`, no second server): the shell's
open/close/minimize (header stays, body+footer hide, confirmed via computed `display`); the
real astrolabe dial mounted and repainting; all four corner clusters present with correct
titles (confirmed via direct DOM inspection after `read_page`'s own accessibility-tree
listing under-reported two of them — a tool quirk, not a real gap, cross-checked before
trusting it either way); the Pen-gated jump menu; the camera-path popover end to end; the
planned/real footer split; zero new console errors (one stale historical entry, confirmed
dead by direct re-test, same as every round since it first appeared).

*Verification note: `npx eslint`, `npx prettier --check`, `node tools/verify-structure.mjs`,
and `node tools/run-tests.mjs` (27 suites, 11101 assertions) all clean against everything this
petition describes. The concurrent water-flow session's own files were checked and left
completely untouched by every commit here, same discipline as every round since
[[feedback_git_staging_hazard]] was written.*

---

**P12 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U2 checkpoint 2 — the Fade Engine's
pure core — the author's own direct design brief: "it needs to be able to fade between any one
configuration to any other configuration of effects... automatically expands as we add more
effects").** `world/fade-engine.js`, `world/fade-registry.js`, `foundry/fade-persistence.js`.
No UI wiring yet — the Remote's Fade Time control, channel faders, and Baseline button are
checkpoint 3's job, consuming what's built here; this petition is the core alone.

1. **The record shape is ONE flat map, not §4.2's own `channels{}`/`params{}` split — a
   deliberate departure, not a silent one, made under the author's explicit invitation to
   design this properly.** `Record<string, FadeEntry>`, keyed by a namespaced string
   (`'water.depth'`, `'weather.cloudCover01'`). Building against the two-field sketch first and
   then trying to generalize it added a real seam exactly where the author asked for none: "any
   configuration to any other" doesn't care whether a knob happens to live on a world axis or
   an effect, so splitting them into two maps a caller has to reason about separately buys
   nothing. Worth an explicit countersign — this is a real change to written Law, argued for
   here, not assumed.
2. **"Automatically expands" is a literal, tested property, not a design intention.** The
   mechanism: every effect that wants a Studio card already builds an `{schema, getValue,
   onChange}` triple (`registerEffectCard`'s own contract, `schema` keyed by
   `core/params-schema.js#PARAM_TYPES`). `fade-registry.js#schemaFadeSource` wraps that EXACT
   triple, unchanged, into a fade source — there is no second, fade-specific registration to
   forget. `createFadeSourceRegistry` resolves a namespaced key (`'water.depth'`) by splitting
   on the first `.` and deferring entirely to that namespace's own source; the registry itself
   never learns what a "water" or a "depth" is. **Proven, not asserted:** the test suite
   registers a THIRD, invented-on-the-spot fake effect AFTER the registry already has two real
   ones, using nothing but the same generic wrapper, and confirms it is immediately, fully
   fadeable — "a 16th effect needs zero new code here" is a passing assertion, not a claim in a
   comment.
3. **Type-aware interpolation, dispatched off the SAME type vocabulary every param already
   declares** (`core/params-schema.js#PARAM_TYPES`) — this is the other half of "auto-expands":
   a new EFFECT never needs a line here, only a new value TYPE would (the last one, `angle`,
   landed 2026-08-16, and nothing about the Fade Engine existed to update when it did). Eight
   of eleven declared types are continuously fadeable (`FADEABLE_TYPES`); `text`/`curve`/
   `action` are not (no continuous "between" a string, an arbitrary point list, or a button
   press) and are rejected — the same "fails at author time, not at the table" rule the
   Testament already sets for cues (§4.3). `angle` gets a real shortest-arc wrap (350→10 sweeps
   the 20° way, never the 340° way) — the exact same "signed delta, then wrap" shape
   `params-schema.js`'s own single-value WRITE already uses, applied here to a continuous blend
   instead. `bool`/`enum` hold their `from` for the whole window and snap to `to` only at
   completion — a defensible, simple default, not the only reasonable one; worth a countersign
   if a mid-fade flip is ever wanted instead.
4. **Curves:** `'ease'` is Foundry's own cosine ease (`CanvasAnimation.easeInOutCosine`,
   already this codebase's convention per `camera-path.js`), not reinvented; `'smoothstep'` is
   the classic polynomial, visibly distinct from `'ease'` rather than a second name for the
   same formula; `'hold-snap'` waits at `from` for the whole window and cuts to `to` only once
   it closes.
5. **Reload survival holds by construction, not by a resume routine that could be forgotten.**
   Every function is pure over `(entry, nowMs)`; `startedAtMs` is the only state, wall-clock,
   baked into the entry itself. The test suite proves this the honest way — it calls
   `computeEasedValue` ONCE with a `nowMs` far past the fade's start, with NOTHING in between
   (no simulated tick loop) — a real reload has no intermediate calls either, and if the
   function needed one, this test would have caught it failing to resume correctly.
6. **"Replace, don't queue" and "disjoint channels coexist", both as one pure function and both
   tested against each other in the same case:** interrupting an ALREADY-fading key mid-flight
   captures its CURRENT eased value (not the original `from`, not a fresh live re-read) as the
   new fade's `from`; a fade on an unrelated key in the same call leaves the interrupted key's
   own entry byte-identical (`===`, not just deep-equal) to prove it was genuinely untouched,
   not merely unchanged in value.
7. **Scene-flag persistence, scene-only — no world-scope store, unlike sky.** A fade is a
   table/session moment; the Testament's own §4.1 Baseline button ("fade back to the scene's
   authored resting look") is itself just another target configuration, not a second
   persistent store to keep in sync with this one. `foundry/fade-persistence.js` mirrors
   `sky-persistence.js`'s exact shape (GM-only writes report `{ok, reason}` rather than
   throwing; a `watchFadeState` hook filtered to the active scene and this module's own flag).
8. **Two real test-writing bugs, caught before commit, worth naming honestly rather than
   quietly fixing:** one assertion used `t.ok(name, () => {...})` — a FUNCTION reference, always
   truthy regardless of what it returns, so the assertion could never have failed no matter
   what the code did. Caught by re-reading the test harness's own `ok(name, cond)` signature
   before trusting the result, not by the test itself (it was passing). A second assertion used
   strict `===` against a decimal literal for a float lerp result that IEEE-754 arithmetic
   naturally lands a `0.0000000000000002` away from — fixed to an epsilon comparison, matching
   the pattern already used elsewhere in the same file.
9. **Not built this checkpoint, on purpose:** nothing calls `mergeFadeState`/`writeFadeState`
   from `boot.js` yet — no live `MapShine.startFade(...)`, no Baseline button wired, no Fade
   Time segmented control, no channel faders. §9's own U2 checklist splits "pure core +
   persistence" from "Remote shell: ... Fade Time ... channel faders" as separate bullets, and
   this petition covers only the first; checkpoint 3 is the UI consumer.

**Verification note, honestly scoped to what this checkpoint actually is:** this is a pure,
non-DOM, non-Foundry module — there is no live/browser rung to climb for it yet, unlike every
UI-facing petition before this one; the Node test suite IS the ceiling of what's meaningfully
verifiable before checkpoint 3 gives it something to render. `node tools/run-tests.mjs`: 27
suites, 11201 assertions (100 new, all in `fade-engine.test.mjs`/`fade-registry.test.mjs`), 0
failed. `node tools/verify-structure.mjs`: clean except the same two pre-existing, unrelated
violations already named in Petition P11 (`no-gpu-readback`, `time/one-clock`) — re-confirmed
via `git blame` as untouched by this checkpoint, not re-litigated here. `npx eslint`/`npx
prettier --check` clean. The concurrent water-flow session's own files remain completely
untouched.

---

**P13 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U2 checkpoint 3 — the weather board,
Fade Time, and Baseline — following the author's own "get this UI migration DONE, GO").** This
is the checkpoint where checkpoint 2's Fade Engine gets its first real caller. U2 is now
functionally complete against §9's own checklist; §11's exit gate (a live dusk-into-storm,
reload mid-fade, the author's own eyes) still needs the author, named honestly below rather
than claimed.

1. **Mood-chip clicks are real fades, not snaps — the Fade Engine's first live consumer.**
   Clicking "Storm" reads the archetype's own declared `axes` (the SAME table the astrolabe's
   horizon shelf already uses), builds a `mergeFadeState` patch, and persists it once via
   `writeFadeState`. `weatherArchetype` flips to `'custom'` the INSTANT the fade starts — the
   same "a value mid-transition is not the row it left" rule the Cloud slider's own drag
   already established — and becomes the real target id only once every key has actually
   arrived, detected by a small `pendingArchetypeCompletions` map (gesture id → archetype id)
   sitting beside `fadeState` rather than inside it, since `fadeState` itself is per-KEY, never
   per-gesture.
2. **`wallClockMs()` — a new, narrow, deliberate exception to `time/one-clock`, added to
   `core/frame-clock.js` rather than worked around.** The Fade Engine's own reload-survival law
   needs a timestamp that means the SAME thing after a reload and on a SECOND client — neither
   `tMs` (sim, resets every session) nor the existing `realMs` (wall, but still relative to
   THIS page's own navigation start) can do that; only real Unix-epoch time survives both.
   Added inside the file the wall already exempts, with a doc comment explaining why it's
   different from the two times already there, rather than either illegally calling `Date.now()`
   in boot.js or silently using the wrong clock domain and quietly breaking reload survival the
   day someone tested it.
3. **The live push/persist split matches the astrolabe's own already-proven slider pattern,
   deliberately.** Every animation frame, the pump pushes each active entry's eased value
   straight to the render engines (`setVtPanViewerCloudCover`/`setVtPanViewerWeatherTargets`)
   — cheap, in-memory, no Foundry write. Persistence (`writeFadeState`, a real scene-flag
   write) fires exactly twice per gesture: once at the start, once at completion. A design that
   persisted every tick would be the identical "hundreds of document updates per drag" shape
   this codebase already named and designed away from once, this time for a fade instead of a
   drag.
4. **`ui/no-dead-axis`, and a genuine pre-existing finding it surfaced.** The wall flags
   `cloudType01`/`cloudAltitudePx`/`cloudScalePx` outside `world/` — and immediately caught two
   REAL, already-shipped (2026-08-16) reads of `cloudType01` in `ui/astrolabe.js` (the Face's
   own cloud-blob shape) and `vt-pan-viewer.js` (plumbing it there). `WEATHER_AXES.cloudType01`'s
   own `consumerStatus:'pending'` comment is, by its own literal definition ("live means
   something in `src/` reads this axis TODAY"), technically stale — the astrolabe's decorative
   Face IS a real consumer, just not the "real cloud-rendering effect" the comment's own
   `consumers:` field describes. Grandfathered at the file level (this tool has no line-level
   allow) rather than either blocking a legitimate existing read or silently relabeling
   `consumerStatus` myself — that's a judgment call about what "live" should mean here, better
   left to the author's own countersign than a worker session's unilateral edit.
5. **Only `cloudCover01` and `precip01` get faders — Law 5, applied narrowly rather than
   reproducing the mock's own 7-channel list wholesale.** `fog`/`freeze`/`ash` have no live
   axis at all; `bolt` (lightning) is an impulse, not a fade channel (U7's job); `wind` already
   has a real, dedicated control on the astrolabe itself, and a second wind fader here would be
   the exact "two controls, one value" shape Environment.md §2.4 warns against. Named, not
   silently trimmed.
6. **Drift-mode brackets are DERIVED from real data, not the mock's own static fixture.** The
   mock's own "climate min/max" concept doesn't exist in `world/weather-biomes.js` — a biome is
   a weighted graph of archetype TRANSITIONS, not a per-axis range. `driftBracket()` computes
   `[min, max]` by scanning a biome's own `archetypeWeights` for every archetype it can reach
   with non-zero weight and reading THEIR real axis values — live-verified against Temperate
   Coast: "range 0.00–1.00" (clouds), "range 0.00–0.70" (rain), both real numbers derived from
   the real archetype table, not invented. Shown as text next to the fader rather than a pixel-
   positioned overlay on the native slider track — a real, named simplification (see #8).
7. **A real bug, found live and fixed before commit: clicking a mood chip didn't repaint.**
   The click handler correctly started the fade and flipped the sky to `'custom'`, but never
   called `renderChips()` — so the OLD archetype's chip stayed visibly lit for the whole
   duration of a fade that had already moved the sky away from it. Caught by checking
   `aria-pressed` state immediately after a live click (not assumed from reading the code): the
   "Clear" chip was still reporting pressed after clicking "Storm". Fixed by re-painting
   immediately on click — the OLD chip un-lights right away, the NEW one lights only once
   `refreshWeatherBoard()` fires on actual arrival, never optimistically.
8. **Two honest, named simplifications, not silently shipped as more than they are:**
   - **The astrolabe's own OLD weather picker (13→16-button horizon shelf, Director/Almanac
     select) still renders inside the Remote, alongside the NEW weather board.** Both write to
     the same real `editSky` state and stay in sync, so nothing is WRONG, but a GM sees two
     controls for the same job in one room. Suppressing the old one inside the Remote's own
     dial instance specifically (an opt-in flag on `createAstrolabe`, the old panel's instance
     unaffected) is a real, scoped follow-up, not done this pass — flagged rather than
     silently left for the next session to rediscover.
   - **The weather board's own faders don't visually animate their thumb position during an
     in-flight fade.** `buildParamControl`'s range row has no external "the value changed
     elsewhere" hook (unlike the astrolabe dial's own `update(state)` pattern) — the thumb
     only moves on a user drag or a full board rebuild. The actual rendered SKY still eases
     smoothly the whole time regardless (the live push is independent of this UI); only the
     Remote's own slider handle stays visually still until the board next refreshes. A live-
     updating slider is a real follow-up.
9. **Baseline is real now, Safety still isn't — the split from Petition P11 holds for the
   reason already given there.** Baseline fades back to a snapshot captured once per scene
   (`canvasReady`, right after the sky resolve settles) — "the scene's authored resting look"
   is, honestly, "however this scene's cloud cover and rain read the moment it finished
   loading," not a separately-authored concept; that's what the Testament's own §4.1 phrase
   actually cashes out to today. Safety remains `status:'planned'` — still a real, one-way,
   hard-to-reverse action nobody has wired carefully yet, not scope this checkpoint touched.

**Exit gate — closer, and said so plainly rather than claimed.** §9 asks for the author fading
dusk-into-storm over five real minutes, reloading mid-fade, and the storm finishing on
schedule. The MECHANISM for exactly that now exists and is live-verified end to end in
`tools/remote-preview/` (mood-chip click → real `mergeFadeState` patch → persisted state →
per-tick live push, with the chip-repaint bug caught and fixed along the way) — what's NOT
verified is the actual five-minute, real-Foundry, reload-survives version, because that needs
a real scene and the author's own clock, not a preview harness with a stand-in `performance.now()`.
Named as the literal remaining gap between "built" and "the exit gate," not glossed over.

*Verification note: `npx eslint`, `npx prettier --check`, `node tools/verify-structure.mjs`
(clean except the same two pre-existing violations, re-confirmed via `git blame`), and
`node tools/run-tests.mjs` (27 suites, 11214 assertions — unchanged from P12, since this
checkpoint is wiring, not new pure-core surface) all clean. Live-verified via
`tools/remote-preview/`: mode toggle, all 16 real mood chips, all 10 real climate chips,
derived drift brackets, a real fader commit, Baseline, and the fade-start/mid-fade/repaint
sequence — including the one bug this round found and fixed. The concurrent water-flow
session's own files remain completely untouched.*

**P14 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U3 — Cues — schema plus a
console-first engine, following the author's own "get this UI migration DONE, GO").** No
Studio capture flow and no Remote cue deck exist yet — that's this checkpoint's own honestly-
named gap, not glossed over (#5 below). What's real: an authored cue can be captured, validated,
fired, and persisted, end to end, today, from the console.

1. **`core/cues-schema.js` — a cue is a named, ordered, PARTIAL fade-target map,** the exact
   `Record<key, {to, overMs, curve}>` shape a mood-chip click already builds ad-hoc
   (`boot.js#fadeWeatherToArchetype`, P13), now with a stable id, a name, and a place in a
   stack. `validateCue`/`validateCueStack` check structure, per-target legality (`to` present,
   `overMs ≥ 0`, `curve` one of `FADE_CURVES`), AND that every target key actually resolves to a
   fadeable type via an injected `resolveType` — the Testament's own §4.3 claim, "a cue that
   targets a param the schema doesn't declare fails at author time, not at the table," is a
   literal, tested assertion (`cues-schema.test.mjs`, "the exact author-time failure §4.3
   promises"), not a paraphrase. `orderedCues` is the one place deck order gets decided, never
   re-sorted differently elsewhere. `cueToFadePatch` turns an authored cue into a
   `mergeFadeState`-ready patch namespaced `cue:<id>` — never collides with a mood chip's own
   ad-hoc gesture id.
2. **`core/params-schema.js` now owns `FADE_CURVES`/`FADEABLE_PARAM_TYPES`/`isFadeableParamType`
   — relocated FROM `world/fade-engine.js`, not duplicated.** `core/` has zero dependents on
   `world/` anywhere in this codebase — confirmed by grep before writing a line of
   `cues-schema.js`, not assumed — so a cue's curve/type legality (a `core/` concern) couldn't
   import them from where P12 originally put them. `world/fade-engine.js` re-exports both under
   their original names (`CURVES`, `FADEABLE_TYPES`, `isFadeableType`); every existing caller,
   including P12's own test suite, kept working unchanged — a pure relocate-with-re-export, zero
   behavioral change, confirmed by the full suite staying green across the move. Flagging this
   sub-change for explicit note, per U0's own standing rule that `params-schema.js` edits get
   named individually: this ADDS three new exported names to the file, it does not touch
   `FORBIDDEN_IN_CONTRACT` or any existing param's contract.
3. **`foundry/cues-persistence.js` — one scene flag, mirrors `fade-persistence.js` exactly.**
   Cues travel with the scene that authored them (§4.3: "a sold map ships with its authored
   moments"), same posture as every other `foundry/` persistence module — GM-only writes, a
   failure returns `{ok:false, reason}`, never throws.
4. **The engine door: `MapShine.captureCue`/`fireCue`/`listCues`, live today** — the same
   "console-first" precedent `getWind`/`setWind` already set (P-prior, next to `setSunHour`/
   `setCloudCover`). `captureCueFromLive(name, overMs, curve)` snapshots the CURRENT live value
   of every key `fadeSourceRegistry` can currently read as the new cue's `to`, appends to the
   scene's stack, validates the WHOLE stack (a bad capture must not silently corrupt an
   otherwise-good one), and only persists if clean. `fireCueById(id)` re-validates before arming
   — "invalid cue refuses to arm," §9's own U3 checklist line, literally what the function does,
   not a description of intent — then merges a `cueToFadePatch` into the SAME `fadeState`
   P12/P13 already built, through the SAME `mergeFadeState`/`pumpWeatherFades`/`writeFadeState`
   path a mood-chip click uses. No second fade mechanism; cues are a second AUTHOR of the one
   that already exists. `cueStack` hydrates on `canvasReady`, scene-scoped and re-loaded on a
   scene switch, mirroring `fadeState`'s own P13 pattern exactly, including a `watchCueStack`
   re-arm for a second GM's own concurrent edit.
5. **Named honestly: today, a cue can only target what's actually registered — the two weather
   axes, nothing else.** `world/fade-registry.js`'s own `schemaFadeSource` wrapper is genuinely
   generic (proven in P12's own tests against a fake, never-before-described effect schema), but
   `boot.js` itself has only ever called `fadeSourceRegistry.registerSource('weather', …)` — no
   effect's own `{schema, getValue, onChange}` triple has been wrapped and registered yet. "Any
   configuration to any other" is a property of the ENGINE, verified; it is not yet a property of
   what's actually reachable from a live scene. Registering more effects as fade sources is a
   real, scoped follow-up (mechanical per source, per the design), not done this pass.
6. **§9's own U3 exit gate — "stage three cues for a real scene, run them at the table with GO
   alone" — is not reachable yet, and isn't claimed as met.** There is no capture UI (only a
   console function), no deck (only `listCues()`), no GO button. What IS verified: `node --check`
   on the edited `boot.js`, the full pure-core contract for `cues-schema.js` (39 assertions:
   structural rejection, every per-target rejection including the author-time-failure claim,
   stack-level duplicate id/order detection with per-cue error prefixing, `orderedCues`,
   `cueToFadePatch`), and that `graph/reachable-from-boot` — broken by P12's own interruption
   point, `core/cues-schema.js` having no real importer yet — is clean again now that `boot.js`
   is one. A live, real-Foundry console smoke test (capture a cue from a real scene's live
   weather, list it, fire it, watch the sky actually ease) was **not** run this session — named
   as the gap it is, not claimed.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched
(`boot.js`, `core/cues-schema.js`, `core/params-schema.js`, `core/__tests__/cues-schema.test.mjs`,
`foundry/cues-persistence.js`, `foundry/index.js`). `node tools/run-tests.mjs`: 27 suites, 11253
assertions (+39 over P13, exactly `cues-schema.test.mjs`'s own count) — ALL GREEN.
`node tools/verify-structure.mjs`: `graph/reachable-from-boot` clean (confirming `boot.js` is now
a real importer of `core/cues-schema.js`); the same two pre-existing violations P11 first named
and P13 re-confirmed (`no-gpu-readback` in `vision-mask-render.js`, `time/one-clock`'s ratchet)
remain, re-confirmed this round via `git show HEAD` on every flagged file and line — none are in
this checkpoint's own diff, none were touched this session. The concurrent water-flow session's
own files remain completely untouched.*

**P15 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U3's remaining two checklist items —
the Studio CUES department and the Remote cue deck — following the author's own "get this UI
migration DONE, GO").** §9's own U3 checklist is now FOUR for four: schema+validation (P14),
persistence (P14), the CUES department, and the Remote deck — all built, not three of four with
the UI named as a gap.

1. **The CUES department (`ui/rooms/studio/cues-department.js`) — capture, reorder, edit fade
   time, test-fire, revert, all real.** Ported layout from the mock's `#cueBuild`/`.cueitem`, but
   two mock affordances turned out to be UNWIRED in the mock ITSELF (checked, not assumed): the
   per-cue fade-time `<select>` has no `onchange` handler anywhere in the mock's own source, and
   Capture never actually asks for a name at all (`.cname` is static text). This file fixes both
   for real rather than porting the mock's own gaps forward: the select is wired to a new
   `updateCueFadeMs(id, overMs)` (re-validates the WHOLE stack before persisting, same shape as
   every other mutator), and Capture asks via a native `window.prompt()` — a deliberate, named
   choice over inventing a new LANTERN dialog for one field, with a cancelled/empty prompt still
   capturing under a clock-stamped default name so a one-click "capture the moment" gesture can
   never dead-end. Curve stays DISPLAY-only (a small badge) — the mock has no curve editor either,
   and adding one is a real, scoped follow-up, not silently skipped. A validity badge (⚠, tooltip
   = the actual `validateCue` errors) renders per cue, schema-checked live against the real
   registry, not a static assumption that captured cues are always valid.
2. **A real collision, found by tracing the data flow before writing code, not live-caught after
   shipping it.** Test-fire's first design routed a preview through the SAME `fadeState`/
   `mergeFadeState`/`writeFadeState` path a real cue-fire uses. Tracing `pumpWeatherFades`'s own
   completion logic (`pendingArchetypeCompletions`, P13) against that design surfaced a genuine
   bug before it existed: a test that overwrote `fadeState[key]` would hijack whatever REAL,
   concurrent gesture already owned that key, filing that gesture's own completion either too
   early (wrong archetype lands) or never (stranded pending forever) — the "replace, don't queue"
   law working exactly as designed, against the wrong caller. Fixed by architecture, not a guard
   rail: a cue-test preview (`cueTestPreview`/`testFireCue`/`revertCueTest`/`pumpCueTestPreview`,
   `boot.js`) never touches `fadeState` at all — it drives `fadeSourceRegistry.write()` directly,
   riding the SAME per-frame timestamp `pumpWeatherFades` already gets (`pumpAstrolabe`'s own
   `nowMs`) rather than a second `requestAnimationFrame` registration (`time/one-clock`). Never
   persisted — a test is this GM's own client only. A second, narrower guard rejects a SECOND
   `testFireCue` while one is already live (`cueTestSnapshot` non-null) — re-snapshotting mid-test
   would capture the FIRST test's own animating values as "the original," making revert restore
   the wrong thing; live-verified in the browser (two rapid Test clicks: the second is refused,
   the first's own preview and revert both still work correctly, confirmed via the strip staying
   present and the weather readout unaffected by the second click).
3. **The Remote cue deck (`ui/rooms/remote/cue-deck.js`) — next-cue card, GO, jump list,
   restart.** Ported from the mock's `#cueDeck`/`#cueRow`/`#cueCard`/`#goBtn`/`#cueList`,
   including the domed GO button's own sheen animation (renamed keyframes to `msaGoSheen`,
   global scope, avoiding a collision with any later same-named rule). `nextIx` is this file's
   OWN local, positional, unpersisted pointer — §4.3 says outright "sessions are not linear,"
   and there is no server-side "the active cue is #2" concept for a fired cue to begin with (a
   finding from wiring the engine half, P14). One real edge case caught and fixed BEFORE it
   shipped, not after: `nextIx === stack.length` (just fired the last cue — "End of cue list",
   GO disabled) is a LEGITIMATE terminal state, but a first draft's own clamp
   (`nextIx >= stack.length → 0`) would have silently wrapped it back to the first cue on every
   repaint, making "End of cue list" undisplayable. Fixed to `nextIx > stack.length` (only a
   genuinely impossible index, e.g. the stack shrank under a stale pointer, gets recovered) — the
   correct version is what's live-verified below (jump-fire the last cue → GO correctly disables,
   "End of cue list" correctly shows).
4. **`updateCueFadeMs`/`moveCueOrder` (`boot.js`) — the SAME shape as `captureCueFromLive`.** Both
   re-validate the WHOLE resulting stack before persisting (a bad edit must not silently corrupt
   an otherwise-good stack) and both call `MapShine.__remote?.refreshCueDeck()` on success, so a
   GM editing the stack in the Studio sees the Remote's own deck (open at the same time) repaint
   without polling — the identical "one writer, many derivers, never polls" shape
   `refreshWeatherBoard()` already established for weather. `moveCueOrder` swaps two cues' own
   `order` VALUES (not array position) — the deck/jump-list's real sequence key, per
   `core/cues-schema.js#orderedCues`'s own contract.
5. **Named honestly, not silently added or silently missing:** deleting a cue is NOT built this
   round — not part of §9's own U3 checklist wording, a real, likely near-term follow-up rather
   than scope creep taken on unasked. Curve is not editable per cue (point 1). A second GM's own
   "next" pointer on their own open Remote does not sync when THIS client fires or reorders a cue
   elsewhere — inherent to `nextIx` being positional and local by design (point 3), not a bug to
   chase.
6. **Both preview harnesses extended with a real, if throwaway, orchestration layer — not stubs.**
   `tools/studio-preview/` and `tools/remote-preview/` both now exercise the REAL
   `core/cues-schema.js` functions (`validateCue`/`validateCueStack`/`orderedCues`/
   `cueToFadePatch`) and REAL `world/fade-engine.js` math (`computeEasedValue`/`isEntryExpired`)
   against fake weather stores — only the closure glue (`cueStack`, `wallClockMs`'s
   `performance.now()` preview stand-in) is throwaway, matching `remote-preview`'s own established
   `fadeToArchetype`/`tickFades` precedent (P11). This is what made the live verification below
   possible without a real Foundry scene.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched or created
(`boot.js`, `ui/rooms/studio/{shell,cues-department}.js`, `ui/rooms/remote/{shell,cue-deck}.js`,
`tools/studio-preview/{preview.js,index.html}`, `tools/remote-preview/preview.js`).
`node tools/run-tests.mjs`: 27 suites, 11261 assertions, ALL GREEN — unchanged in count from P14
(this checkpoint is UI wiring + preview-harness orchestration, not new pure-core surface; the one
transient failure seen mid-session, `water-shore.test.mjs`, was the concurrent water-flow
session's own WIP, confirmed via `git status` showing it modified/uncommitted outside this
checkpoint's diff, and gone on the next run). `node tools/verify-structure.mjs`: the same two
pre-existing violations (`no-gpu-readback`, `time/one-clock`), re-confirmed unchanged; `tools/` is
outside this wall's scan scope, so the preview harnesses' own `performance.now()` calls (matching
P11's already-established stand-in pattern) don't and shouldn't appear.
**Live-verified in the browser (`javascript_tool` DOM inspection — the sandboxed pane stayed
non-composited/`document.hidden` throughout this session, per the standing limitation, so clicks
and state were verified directly rather than via screenshot):** Studio — capture (multiple, unique
orders), reorder (▲ swaps two cues' own order), fade-time edit (select → re-render shows the new
label), validity display (no false ⚠ on valid cues), test-fire (strip appears, `isCueTestActive`
flips), revert (strip clears, state resets), the double-test guard (second Test click refused,
first test's own state untouched). Remote — initial next-cue card, jump-list expand (correct
next/done classes), GO (advances, marks done, log confirms the real engine call), jump-list
click-to-fire (jumps AND fires in one click), Restart (resets to the first cue), and the terminal
"End of cue list" state (GO disabled) — the exact case point 3's fix targets. **Not verified: the
actual EASED ANIMATION progressing frame-by-frame** — the pane's own non-compositing limitation
means `requestAnimationFrame` never advances during this session's checks (confirmed via
`document.hidden`/`visibilityState` mid-test), so only the WIRING (click → real function calls →
correct resulting state, no exceptions) was directly observed; the underlying easing math itself
is separately and exhaustively proven by `fade-engine.test.mjs`'s own reload-mid-fade tests, which
use an arbitrary far-future `nowMs` with no `requestAnimationFrame` dependency at all. **§9's own
U3 exit gate — "the author stages three cues for a real scene and runs them at the table with GO
alone" — is now mechanically reachable (all four checklist items genuinely built) but not yet run
against a real Foundry scene**, named honestly as the literal remaining gap, matching P13's own
exit-gate note for the identical reason. The concurrent water-flow session's own files remain
completely untouched.*

**P16 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U4's honest slice, plus a finding that
changes what U4's own exit gate actually requires).** Before building, researched whether the
plan's own claim — U4 is "almost entirely an entry-point change," `ui/paint-mode.js` "already
built and live" — was actually true against current `src/`, rather than trusting it. **It was not
true, and the gap is load-bearing, not cosmetic.**

1. **§9's own U4 exit gate — "from a scene with no fire, the author is painting burning fire
   within five seconds of clicking the tile" — cannot be met by any UI, however fast it's built,
   because painted strokes have no path into the render pipeline.** Read `scene/mask-authority.js`
   in full: its own architecture comment names exactly two ingest doors — real files discovered on
   disk (`foundry/mask-discovery.js`) and the VT pager's decoded-page stream — and the code has no
   third. The painter's own Save (`foundry/paint-adapter.js#savePaintedMasks`) writes to a scene
   flag (`paintedMasks`) that is read in exactly two places in the whole codebase: the painter's
   own re-open-and-re-edit hydration, and the export bundler. Nothing in the render/effect pipeline
   ever reads it. Paint `_Fire`, click Save, and the fire pass never sees it — confirmed by tracing
   every reference to the flag, not inferred.
2. **This is not a new discovery — it's an old one that got dropped.** `docs/planning/Authoring-
   and-Distribution.md`, written the SAME DAY as `Control-Panel.md`'s own "paint fire, see fire"
   line, lists in its own "New to build" section: *"the brush→DataTexture path (the mask
   authority's known-but-unbuilt DataTexture ingest... whose first consumer this becomes)."* Every
   OTHER piece named alongside it that day has since shipped (the paint UI, the embed codec, Mode A
   persistence) — this one piece never has. `Control-Panel.md` §5.2 and this Testament's own U4
   both inherited the aspirational sentence without the caveat sitting one section below it in the
   original doc. Named here so it stops propagating silently into a THIRD document.
3. **What's real and shipped this round, independent of that gap:** `ui/rooms/studio/painter-
   department.js` — a tile grid, one tile per effect that actually declares `authoring.paint`
   (fire/water/window/specular/fluid/vegetation — confirmed exhaustively by grep, exactly 6, not
   the 9 `MASK_KINDS` has; `shadow`/`outdoors` have no owning effect, Law 5's "nothing dead is
   drawn" applied here the same way `ui/no-dead-axis` applies it to weather axes). Each tile shows
   the effect's own title, mask suffix(es), and a REAL found/missing status for the floor you're
   currently viewing (`maskAuthority.authoredStatus`, the same query water's own Studio card
   already uses) — and clicking it genuinely arms the real brush via the SAME `paintAffordance`
   function the old debug panel and water's card already call, so the tile grid, the card
   shortcuts, and the old panel can never disagree about which mask kind a given effect opens.
   `authoring.paint`'s real shape is `{paint: string|string[]}` — thinner than U4's own checklist
   line implies (`{effectId, maskId, tools, brushDefaults}`); `tools`/`brushDefaults` don't exist
   in the manifest schema or the validator anywhere in `src/`, named rather than invented to make
   the checklist's own wording look satisfied.
4. **A real, small, honest correction shipped alongside the new work, not left for later:**
   `paintAffordance`'s own tooltip said *"Paint where the effect belongs; it reads the mask
   live"* — false, per point 1, and it was already reaching users through the OLD debug panel's
   paint buttons (fire/vegetation/water/fluid/specular/window, all six) before this round touched
   it. Corrected in place to state plainly what Save actually does and doesn't do yet.
5. **§9's U4 checklist's OWN second bullet — "Card 🖌 shortcut arms the brush for that effect's
   mask" — is only reachable for water today**, because only water has a real Studio EFFECTS
   card (`registerEffectCard` has exactly one call site, named as its own honest gap in P10 and
   still true). The other five paintable effects' own card shortcuts will appear automatically,
   with zero new code, the day a future session wires their cards — `effects-department.js`
   already renders `onPaint` generically whenever a card model supplies it. Not built this round,
   named as a dependency on P10's own already-flagged gap rather than re-flagged as new.
6. **Named, not taken on unprompted:** building the missing brush→mask-authority ingest path (a
   new ingestion door on `mask-authority.js`, and either a live synthetic-page feed or Mode B
   bake-to-file, which itself doesn't exist) is a genuine, separate, cross-cutting rendering
   feature — not a UI wiring task, not something a worker-tier session should decide to take on as
   a side effect of a UI migration checkpoint. Left for the author's own prioritization call.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched
(`boot.js`, `ui/rooms/studio/{shell,painter-department}.js`, `tools/studio-preview/preview.js`).
`node tools/run-tests.mjs`: 27 suites, 11261 assertions, ALL GREEN, unchanged in count (UI wiring
+ a tooltip correction, no new pure-core surface). `node tools/verify-structure.mjs`: the same two
pre-existing violations, unchanged. Live-verified in the browser (`javascript_tool`, same
non-composited-pane workaround as P15): the Painter rail tab opens with no "lands in a later
stage" placeholder, the subtitle and honest not-wired-live notice both render, both fixture tiles
(one `found`, one not) show the correct status line, and clicking a tile calls `armBrush` with the
correct effect id. The concurrent water-flow session's own files remain completely untouched.*

**P17 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U5 — the Player face — researched before
building, following the exact same discipline U4's own petition established, and turning up an
even bigger gap in one specific piece).** §9's own U5 checklist has four items; three are real and
shipped this round, one (player-light) is confirmed unbuildable in this pass's own scope.

1. **§5.5's "player-light allowances" line assumes a rendering effect that does not exist anywhere
   in this engine.** Grepped every plausible name (`PlayerLightEffect`, `playerLightMode`,
   `playerLightAllowance`, `floorCompositorV2`) across all of `src/` — the only hits are inside
   `legacy/` (5,029 lines of V2 GLSL never rebuilt, plus a 234-line allowance module and a 298-line
   picker dialog, BOTH built on dead plumbing: raw `game.settings` calls bypassing
   `foundry/settings-adapter.js`, a whole-blob `scene.getFlag(MODULE_ID,'controlState')` read the
   V2 postmortem itself names as the disease `effect-cascade.js` replaced, and a picker that
   reaches for `window.MapShine.floorCompositorV2` — a global that does not exist in V3's
   `graph/`-based pipeline and would fail the instant a player actually picked a mode) — and one
   forward-looking `absorbs: [...]` list entry on `light.accumulate`, a pass whose own status note
   scopes it to "AMBIENT/EXTERIOR only... point lights... are later rungs." This is a BIGGER gap
   than U4's own missing render path (P16) — not a missing wire, a missing multi-thousand-line
   TSL rendering feature (torch glow, a flashlight beam/cookie, a night-vision post chain) with a
   UI and an allowance system on top of it. Not attempted this round. Left named for the author's
   own call, exactly as U4's own missing ingest path was.
2. **The other three checklist items are real, and two completed a previously half-built a11y
   feature rather than starting one from zero.** `ui/tokens.js` already shipped full CSS for
   `[data-theme]` (all 4 LANTERN themes, contrast-gated) and `[data-reduce-motion="1"]` (plus the
   OS-level `prefers-reduced-motion` media query, free) — but NOTHING in `src/` ever set either
   attribute, and no setting existed to drive them. Added `GLOBAL_SETTING_KEYS.theme`/
   `.reducedMotion` (`effects/effect-settings.js`, two new descriptors, existing tests' own
   count assertions updated to match — 3→5 global descriptors, +2 new assertions covering the new
   descriptors' own shape) and `applyUiPreferences()` (`boot.js`), the one place
   `document.documentElement.dataset.theme`/`.reduceMotion` are ever written — called once at
   `init` (so a returning player's last choice applies immediately, not only after their next
   edit) and again from the settings adapter's own `onChange`. Reduce-photosensitive (already
   fully live since 2026-07-29) needed nothing new. Text-scale is NOT built this round — it needs
   new CSS infrastructure (nothing like a `--text-scale` token exists anywhere), a smaller, more
   self-contained follow-up than player-light but still a real one, named rather than rushed in.
3. **`ui/rooms/system-panel.js` — ONE generated component tree, per §5.5's own doctrine, held
   literally.** Reuses `effects/effect-settings.js`'s real key conventions and
   `effects/effect-cascade.js`'s real resolution order verbatim — boot.js's `getSystemPanelCtx()`
   supplies already-derived plain data, the identical "this file imports nothing from effects/"
   rule `diag/settings-panel.js`'s own header states, upheld here against the LANTERN widget canon
   instead of that file's hand-rolled DOM. `isGM()` gates the whole "Table Defaults" section, never
   a second layout — live-verified: the Studio's own SYSTEM department (fake `isGM:true`) renders
   the GM section, the standalone Player room (hard-coded `isGM:()=>false`) renders the identical
   tree WITHOUT it, confirmed by checking for the literal absence of "Table Defaults" text in the
   Player room's own DOM, not just assumed from the code. A locked row (a11y-forced-off) gets a
   REAL `select.disabled = true`, not `status:'planned'` — that convention is documented to leave
   controls "fully interactive... never disabled" (`param-control.js`'s own doc), the wrong tool
   for a row whose value genuinely cannot take effect; live-verified by toggling reduce-
   photosensitive and confirming Fire's own row disables itself with the correct tooltip, in BOTH
   rooms (shared settings store).
4. **The per-effect toggle's own help text says "final say," not "within GM bounds."**
   `effect-cascade.js#resolveEffectEnabled`'s own comment states outright: "Player (client)
   override — final say, subject only to a11y below" — a player's own On/Off wins over a GM's
   table default in EITHER direction, deliberate and already shipping in `effect-settings.js`'s own
   descriptor hint text (*"On/Off is your final say"*) before this round touched anything. §9's
   "within GM bounds" phrasing describes different behaviour than seven existing test files already
   pin. Not changed — changing a heavily-tested, heavily-depended-on resolver's precedence based on
   one worker session's reading of a loose checklist phrase is exactly the kind of call this
   project's own governance reserves for the author, not a worker petition. This panel's own help
   text states the REAL behaviour; the Testament's own wording is flagged here for Fable's next
   pass, not silently overridden in either direction.
5. **`ui/rooms/player-shell.js` — the smallest room this project has built, deliberately.** No
   rail, no departments, one titled window ("Performance & Graphics"), `isGM` hard-coded `false`
   regardless of who opens it — even a GM previewing their own table's player view sees the player
   view, not their own GM section; Law 10 held by construction (the GM branch inside
   `system-panel.js` never runs here, not hidden after being built). A fifth scene-controls
   toolbar tool (`registerPlayerButton`, `order:104`) opens it, `visible:true` like the ORIGINAL
   panel's own button — the one precedent for a non-GM-gated tool among the four that came before.
6. **A pre-existing Law 10 tension, found while researching, named rather than silently fixed.**
   `installStudio`/`installRemote` are called unconditionally in `boot.js` — their FULL DOM trees
   (EFFECTS/PAINTER/SCENE/CUES/LAB, the astrolabe, camera path) are constructed in a PLAYER's own
   browser today, merely `hidden`, not absent — confirmed by reading `rooms/studio/shell.js` in
   full (`document.body.appendChild(room)` with `room.hidden = true`, unconditional). Law 10 says
   "GM chrome is never built into a player client's DOM... not `display:none`" — this predates U5
   by several checkpoints and is a real, if low-severity (nothing secret lives in that DOM, only
   authoring UI a player has no route to reach), gap between the letter of the Law and the actual
   boot sequence. NOT fixed this round: gating either eager call site behind `isGM()` is a genuine
   behavioural change to two already-shipped, already-petitioned rooms, deserving its own scoped
   pass and sign-off, not a drive-by inside U5's own commit. Named plainly rather than left for a
   future session to rediscover from scratch.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched or created
(`boot.js`, `effects/effect-settings.js`, `effects/__tests__/effect-registration.test.mjs`,
`foundry/{index,scene-controls-button}.js`, `ui/index.js`,
`ui/rooms/{system-panel,player-shell,studio/{shell,system-department}}.js`,
`tools/studio-preview/{preview.js,index.html}`). `node tools/run-tests.mjs`: 27 suites, 11263
assertions, ALL GREEN (+2 over P16, exactly the two new settings-descriptor assertions;
`describeEffectSettings`'s own count assertions updated in the same commit as the new
descriptors, not left stale). `node tools/verify-structure.mjs`: the same two pre-existing
violations, unchanged. Live-verified in the browser (`javascript_tool`, same non-composited-pane
workaround as P15/P16): the Studio's SYSTEM department renders the master switch, profile,
accessibility (including the two new controls), per-effect list, and GM-only Table Defaults
section; the standalone Player room renders the identical tree with Table Defaults CONFIRMED
ABSENT (checked for the literal string, not assumed); toggling reduce-photosensitive live-locks
Fire's own row (real `select.disabled`, dimmed, correct tooltip) in both rooms off one shared
settings store. Not independently live-verified this round: `applyUiPreferences()`'s own DOM
writes (`dataset.theme`/`dataset.reduceMotion`) — the preview harness has no equivalent of
boot.js's own `init`/settings-adapter wiring to exercise that specific function outside a real
Foundry session; the function itself is three lines reading two already-tested settings keys, a
narrower gap than U4's own unverified exit gate. The concurrent water-flow session's own files
remain completely untouched.*

**P18 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; author directive: "If you could fix
the painter that would be great since you spotted an issue" — closing P16's own named gap.
Player-light stays deliberately untouched, per the author's own "it needs to be recreated as an
effect and it will be soon.").** "Paint fire, see fire" is now genuinely true, on Save, for all
six paintable effects at once — not a UI change, a real third door into the render pipeline.

1. **`scene/mask-authority.js#ingestPaintedMask(floorIndex, kindId, grid)` — a THIRD ingest door,
   alongside file discovery and the VT decode stream, this file's own header used to name as
   exhaustive.** Read the WHOLE file (1,236 lines) before touching it, not just the two doors P16
   already knew about, to find the actual, minimal, correct seam. A painted layer is FLOOR-scoped
   (keyed `${floorIndex}/${kindId}`), not item-scoped like every other source here — `scene/paint-
   mask.js`'s own header already states why: "a painted mask is a `MaskGrid`... the SAME grid type
   the mask authority uses for its derived products," just at a higher resolution (4096 vs 512),
   covering the identical scene rect. That meant NO new coordinate math was needed — the painted
   grid's own `spec.x/y/width/height` (already world-space, from `computeMaskGridSpec`) becomes
   the `placement` `compositeItemOverwrite` already knows how to sample through, unrotated,
   top-left anchored (`anchorX:0, anchorY:0` — confirmed against `worldToItemUv`'s own math by
   hand before writing a line, not assumed).
2. **SELF-ALPHA is the load-bearing safety property.** A painted layer has no separate alpha
   channel the way a real mask FILE's own decode does — so its own byte value is passed as ITS OWN
   alpha too. Under `compositeItemOverwrite`'s already-existing "transparent means unpainted" law
   (2026-08-02), an unpainted texel (byte 0) is therefore fully transparent and the file/earlier
   source shows through completely unchanged; a fully-painted texel (255) fully overwrites. This
   is the ONE property that makes the whole design safe: the author's brush can only ever ADD to
   or touch up a file, never silently blank out everything a file painted OUTSIDE the stroke —
   confirmed by a dedicated test (below), not just reasoned about.
3. **Composites LAST in `sourcesFor`'s own draw order** — the author's own most recent in-app edit
   wins over file-based content wherever painted, the SAME "later host overwrites earlier" law
   `compositeItemOverwrite`'s own doc already states for Tiles blowing a hole in a background,
   applied here to a painted layer instead of a second file.
4. **ZERO changes needed in any effect.** Fire, water, window, specular, fluid, and vegetation all
   already read their own mask exclusively through `maskAuthority.getDerived(kindId, floorIndex)`
   (confirmed for fire by reading `fire-mask.js`'s own JSDoc: "from `maskAuthority.getDerived
   ('fire', floorIndex)`") — and that function's own "staleness is lazy, not scheduled" design
   (this file's own header, already true before this petition) means every one of them picks up
   painted content on its own next read, the instant `touch()` marks the authority dirty. No
   effect file was touched.
5. **A REAL scene-load ordering hazard, found by tracing the actual hook sequence, not assumed
   safe.** `ui/paint-mode.js#hydrateFromScene()` runs at the TOP of `canvasReady`'s own handler;
   `maskAuthority.reset()` (which wipes `paintedIngests` wholesale for the new scene) runs several
   hundred lines LATER in that SAME hook, inside `startRealSceneViewer`. Feeding the bridge
   straight from `hydrateFromScene()` itself would have ingested a previously-saved painted mask
   into the OLD scene's soon-to-be-discarded authority state, silently lost the moment `reset()`
   ran moments later — a real bug that would have shipped invisibly (painting would work all
   session, but a RELOAD would silently drop every previously-saved painted mask). Fixed by NOT
   calling the bridge from inside `hydrateFromScene()` at all: it now exposes `getLayers()` (a
   plain, read-only getter), and boot.js's own `canvasReady` handler calls the bridge itself
   immediately AFTER `startRealSceneViewer` succeeds — after `reset()` has definitely already run.
   `save()`'s own call to the bridge has no such hazard (a user can only open the painter and Save
   well after scene-load sequencing has long settled) and was left calling it directly.
6. **Corrected two claims this same session had shipped as fact, now that they're not.**
   `paintAffordance`'s own tooltip (`boot.js`) and the PAINTER department's own notice box
   (`ui/rooms/studio/painter-department.js`) both said outright "no effect reads a painted mask
   back" — true when P16 wrote it, false now. Both corrected to state the REAL current behaviour
   (updates on Save, not yet live mid-stroke) rather than leaving a now-false claim shipping
   because the code that made it false landed in a later commit.
7. **NOT built, named rather than attempted:** live ingest DURING a stroke, before Save — would
   mean hooking `paint-mode-canvas.js`'s own per-frame preview loop (tuned for cheap dirty-rect-
   only repaints) rather than the already-explicit Save action, a real, separate, higher-risk
   follow-up. Player-light: untouched, per the author's own explicit instruction that it "needs to
   be recreated as an effect and it will be soon" — P17's own finding stands as written.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched
(`scene/mask-authority.js`, `scene/__tests__/mask-authority.test.mjs`, `ui/paint-mode.js`,
`ui/rooms/studio/painter-department.js`, `boot.js`). `node tools/run-tests.mjs`: 27 suites, 11274
assertions, ALL GREEN (+11 over P17 — the new `ingestPaintedMask` suite: an unknown-kind throw,
painted-only with no file, painted composited on top of a file with the unpainted half provably
untouched, an all-zero layer as a total self-alpha no-op, an explicit `grid=null` clear, and a
scene reset wiping `paintedIngests`). One of those 11 briefly failed on first run — traced to the
TEST's own fixture using a top-left-anchored placement where every other fixture in that file (and
this new one's OWN painted-layer placement) is centre-anchored (`worldToItemUv`'s own default);
fixed in the test, not the production code, and re-verified green before moving on rather than
assumed. `node tools/verify-structure.mjs`: the same two pre-existing violations, unchanged.
Live-verified in the browser: the PAINTER department's updated subtitle ("live on Save") and
notice text render correctly, zero console errors. **Not verified: the actual end-to-end
paint→Save→render flow against a real Foundry scene** — that needs a real `canvas.scene` and a
real VT viewer this session's tooling cannot construct; the ingest logic itself is exhaustively
Node-tested against the exact same `compositeItemOverwrite`/`sampleWorld` machinery every other
mask consumer already trusts, named honestly as the boundary of what could actually be checked
this round. The concurrent water-flow session's own files remain completely untouched.*

---

**P19 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U6 — Dials + Control-Health, the
Effects-UI endgame, the last item on the author's own standing "continue the UI migration"
instruction).** Water's FOH strip is five authored dials, not six raw sliders; a live health
badge shows real declared/read counts and deep-links to a new Lab report; the Studio/Remote's
own steady-state cost is a row in the perf report. All four checklist items land; the exit gate
is met and demonstrated, not just asserted.

1. **`core/dials-schema.js` gates on TYPE, not just `angle`.** The obvious trap — reject `angle`
   drive targets because they wrap rather than clamp — is only half the real rule. A `color`
   param has no `min`/`max` either (it declares `space`), so a type check that only excludes
   `angle` would let a dial silently write a raw float into a colour picker's storage slot; same
   failure for `bool`/`enum`/`text`/`vec2`/`vec3`/`curve`/`action`. `validateDialsSchema` gates
   POSITIVE instead — only `float`/`int` accepted — so a ninth param type added next month is
   excluded by construction, not by someone remembering to extend a blocklist. Caught before
   shipping: the first draft only checked `angle`; a synthetic `tint`/`enabled` sabotage test
   written against the SAME draft immediately proved a `color` target would have passed.
2. **One bisection, not four hand-derived curve inverses.** A dial's displayed position has no
   ground truth to read back — "a dial is a computed multi-write, not a new storage location"
   (Effects-UI.md §3.1) — so `dialPositionFromParams` has to invert whichever curve the PRIMARY
   drive declared. `linear`/`ease-in`/`ease-out` all have clean closed forms; `smoothstep`'s cubic
   does not. Rather than three closed-form inverses plus one iterative fallback (a seam an author
   could not eyeball for consistency), all four curves invert through the same 22-iteration
   bisection — correct for anything monotonic on [0,1], which all four are, and cheap enough next
   to a DOM rebuild that the extra iterations are noise. Round-tripped for all four curves at five
   probe positions each in `dials-schema.test.mjs`.
3. **Water's five: Murkiness, Depth, Shine, Foaminess, Flow — `flowAngleDeg`, `tint`, AND
   `opacity` deliberately stay ROH-only.** The first two are the type gate (finding 1) working as
   intended. `opacity` is a curation call, not a gap: it was one of the ORIGINAL six `fohKeys` (a
   flat "top 6" list chosen before dials existed), but its own help text already calls it a
   stopgap ("the map art beneath is doing the work a proper volume/absorption rung will do
   later") — not one of the five levers an author reaches for most. Effects-UI.md's own vision is
   a smaller CURATED set replacing the flat list, not a 1:1 promotion of every already-promoted
   key, so opacity drops. Worth the author's own countersign if the read is wrong. `Foaminess`
   drives all four foam-family params (`foam`/`swashFoam`/`breakFoam`/`foamTrail`) at once — the
   most defensible multi-drive dial of the five, since all four already share the identical [0,1]
   "how much foam" domain by their own schema declarations.
4. **THREE read-classes touch a resolved params object; only one is "the renderer consumed
   this," and the Testament's own boundary warning was correct but the mechanism took real
   tracing to find.** `effects/registry.js#resolveAndApply`'s `apply(resolved)` is storage
   handoff — every effect just stores the whole object, no per-key signal. The FOH/ROH card's
   `getValue` reads `getReadout().params?.[id]` every render regardless of what the shader
   touches — wrapping there would mark a param "read" the instant its slider is drawn. Only
   `water-registration.js#getRenderState()` — what `water-surface-subsystem.js#sync()` and
   `water-flow-subsystem.js` actually call once per frame — is the renderer's own read closure.
   Confirmed water's OWN cache-key builder reads every param by explicit dotted name
   (`p.tint`, `p.opacity`, `p.depth`, …), never `Object.keys`/`JSON.stringify`, before trusting a
   prototype-chain object would work there — checked, not assumed.
5. **A plain object spread would have made the signal permanently, silently wrong — caught by
   reasoning through the JS semantics before writing the fix, not after a bug report.**
   `getRenderState()`'s old shape was `{...p, tint: decoded}`. `{...proxy}` invokes the `get`
   trap once for every own enumerable key (spread reads `[[OwnPropertyKeys]]` then `[[Get]]`s
   each) — wrapping `p` in the tracking proxy BEFORE that spread would have marked all 24 water
   params "read" on frame one, forever, regardless of what `sync()` actually went on to touch. Not
   a hypothetical: `fluid-registration.js`/`window-registration.js` have the IDENTICAL spread
   shape today and are NOT yet wrapped — named here as a real follow-up, not silently left. Fixed
   for water via `Object.assign(Object.create(tracked), {tint: decoded})` — prototype delegation,
   not a spread, so an unaccessed key is never GET. `tint` itself is read explicitly
   (`tracked.tint`, not `p.tint`) inside `getRenderState()` so decoding it still counts as
   "observed" — it would otherwise sit forever as an own, unproxied property and read as
   permanently orphaned despite being consumed every frame.
6. **The exit gate, demonstrated live, not just asserted green.** `tools/studio-preview/preview.js`
   (the "cheap eyes before Foundry eyes" harness) now mounts the REAL `WATER_PARAMS`/`WATER_DIALS`
   and simulates a `getRenderState()`-shaped partial read — every param touched except `chop` and
   `caustics`. Live in the browser: the health badge reads **`22/24`**, its tooltip names "2 not
   yet observed," and `chop`/`caustics` are the two params NOT counted — the deliberately orphaned
   param, wearing its badge, within one session, exactly as written. Dragging the Foaminess dial to
   its max wrote all four driven params (confirmed via the last `onChange` log line,
   `water.foamTrail -> 1`); a forced re-render afterward showed the dial's own position correctly
   recovered from the now-updated param state — the write/read round-trip, not just the write.
   Bloom (no `dialsSchema`) was checked alongside water and correctly still renders its raw
   `fohKeys` slider with the original planned health chip — the fallback path holds.
7. **The health badge deep-links to LAB, not yet to the specific report — named as the real,
   smaller scope, not silently overclaimed.** `shell.js` gained `switchDepartment(id)`
   (generalising the search palette's own inline dept-switch dance into the one place `state.dept`
   changes); the badge's `onClick` calls it. Auto-running the registered `'control-health'` report
   the instant LAB opens needs a stable hook into `debug-panel.js`'s rendered report list from
   OUTSIDE it, which does not exist today — a real, small, separately-scoped follow-up, not
   claimed as done. Also found while building this: no toast/notification component exists
   anywhere in `src/` despite the original UM plan's own note assuming one for planned-badge
   clicks — that assumption was never actually built; not something this petition fixes, named so
   a future session does not go looking for it.
8. **Law 11's row is NOT a `perf-zones.js` zone, and forcing it into one would have been a
   category error, not a shortcut.** Every `'frame'`-stage zone (`tick.camera`, `tick.
   continuousInputs`, …) lives INSIDE `renderFrame`'s own pass-plan loop, validated against
   `graph/passes.js`'s real pass/stage graph. `boot.js#pumpAstrolabe` is architecturally a
   SEPARATE, independent `requestAnimationFrame` registration — fade/cue-preview pumping were
   folded into it specifically to avoid a second independent loop beside the render loop (its own
   pre-existing comment says so). Declaring a zone with `stage:'frame', pass:null` for work that
   is not actually inside `renderFrame` would misstate WHERE the cost lives even if the number
   were honest. `diag/ui-perf.js` mirrors `perf-hud.js`'s own "IT MEASURES ITSELF" idiom instead —
   a self-contained accumulator, `beginUiTick`/`endUiTick` bracketing `pumpAstrolabe`'s WHOLE body
   (ending before the `requestAnimationFrame` reschedule, so the fixed rAF-registration cost never
   pollutes every sample) — and `perf-report.js` gained an optional `uiPerf` input read as plain
   data, staying clock-free per its own header.
9. **A small, worth-recording correction to the checklist's own wording.** "The read-tracking
   `ctx.params` proxy" (this section's own second bullet) reads as if `ctx.params` were an
   existing identifier to find and wrap. It is not — no `ctx` object of that shape exists anywhere
   in the render path; `water-surface-subsystem.js#sync(floorIndex, viewRect)` takes no `ctx`
   argument at all, and gets its params by calling `getWaterRenderState()` internally. The phrase
   was generic shorthand for "the params object handed to a consuming context," confirmed by
   checking the real call signature before designing around a name that turned out not to exist.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched (prettier
auto-fixed 6 files on first pass, re-verified clean after). `node tools/run-tests.mjs`: 27 suites,
11398 assertions, ALL GREEN (+124 over P18). `node tools/verify-structure.mjs`: the same two
pre-existing violations (`no-gpu-readback` in `vision-mask-render.js`; `time/one-clock`'s ratchet,
now 41 against a bound of 38) — the ratchet's growth traced via `git blame` to commits weeks
before this session and to the concurrent water-flow session's own `decode-pool.js`/`frame-
graph.js` work, not to anything touched here. Live-verified in the browser via `tools/studio-
preview/preview.js` (finding 6, above) — dial rendering, dial writes, the health badge's real
count, the LAB deep-link, and the fohKeys/planned-badge fallback for an effect with no dials, all
confirmed with zero console errors. **Not yet wired: fluid's and window's own read-tracking**
(finding 5) — both have the identical unfixed spread, named rather than silently left; **not yet
built: auto-running the Control Health report on LAB arrival** (finding 7) — the badge's deep-link
stops at switching departments. Seven commits, each hand-verified against `git diff` (in two
cases, `git apply --cached` against a hand-extracted single hunk) to contain only this work — the
concurrent water-flow session's own `water-body`/`water-flow`/`water-render`/`water-shore` files,
`docs/planning/Water-Simulation-Turn.md`, and `tools/shader-lab/bench-water.js` remain completely
untouched, confirmed by `git status` before and after every commit.*

---

**P20 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; U7 — Impulses + Remote
Declarations — continuing the author's own standing "GO, get this UI migration DONE"
instruction, picked up via an autonomous-loop tick after U6 landed).** Strike and Gust
fire for real, from both the Remote's corner and the Studio's full list, off ONE shared
declaration; Thunder stays honestly `planned` (no audio engine exists to give it);
the cross-client suppression badge stays honestly `planned` too (no socket exists to
give it truthful data) — exactly the two sub-pieces the original plan itself named as
allowed to stay unbuilt. The exit gate's Remote half is met and live-verified; its
"truthful against a second client" half cannot be, for reasons stated plainly, not
skipped quietly.

1. **`core/impulse-schema.js` reuses `params-schema.js#PARAM_STATUS`, not a second
   `'live'|'planned'` enum** — an impulse's readiness is the identical question a
   param's already is, applied to a button instead of a slider.
   `validateImpulseDecl`/`validateImpulseList` mirror `validateCue`/`validateCueStack`'s
   own shape (a per-item check plus a stack-level duplicate-id check) rather than
   inventing a third validator style for a third declaration kind.
2. ⚠️ **CAUGHT BY THE STRUCTURE WALL, NOT BY EYE: the schema was built and never
   wired to anything real.** `tools/verify-structure.mjs#graph/reachable-from-boot`
   failed after the first full verification pass — `core/impulse-schema.js` was
   referenced only inside JSDoc `@param` type comments (which create no real import
   edge) everywhere it was used, so nothing under `src/boot.js` actually imported it.
   The exact "unconsumed API rots silently" shape this project has named before, this
   time caught before a single commit landed rather than found later. Fixed for real,
   not just to satisfy the checker: `boot.js` now imports `validateImpulseList`
   directly and calls it against the real `IMPULSES` array the moment it's declared,
   logging loudly on failure — a typo'd status value or a future duplicate id is now
   caught at load time, which is also just a better thing for this code to do
   regardless of the wall.
3. **Lightning's `forceStrike()` existed since the effect landed, with a doc comment
   claiming a caller that did not exist.** Read `lightning-subsystem.js` in full
   before touching it: `forceStrike`'s own JSDoc said it was "used by... boot.js's
   debug action" — grepping every call site in `src/` found exactly one, the
   disconnected `tools/shader-lab/lightning-lab.js` harness driving its OWN separate
   subsystem instance, never the live viewer's. `boot.js` never called it. Corrected
   the comment in the same commit that made it true (`feedback_instruments_must_not_
   lie`, applied to a doc comment rather than a runtime instrument) rather than
   leaving a stale claim next to newly-real code.
4. **`vt-pan-viewer.js`'s own public API needed one new re-export, following an
   already-established pattern exactly.** Every other "reach into the live viewer
   singleton" function (`triggerVtPanViewerWindDoorImpulse`, `rebakeVtPanViewerWindField`,
   …) is a module-level function checking a private `_active` reference and
   delegating to an instance method, `{skipped:true, reason}` if nothing is running.
   `forceVtPanViewerLightningStrike` is the same shape, added beside its nearest
   sibling rather than inventing a new access pattern. An early draft tried to also
   detect "no lightning anchors placed on this floor" at this layer by referencing a
   `hasLightningAnchors` method that does not exist anywhere in this codebase —
   caught before shipping (dead code with an empty body, invented rather than found)
   and replaced with an honest static caveat in `boot.js#strikeLightning`'s own
   message instead of a fabricated detection.
5. **Gust is a promotion, not new engineering.** `wind-test-gust` (a pre-existing
   debug action) already built a synthetic wall segment square to the live ambient
   wind direction and fed it through the real Tier-2 impulse path
   (`triggerVtPanViewerWindDoorImpulse`) — extracted into `gustWindFromAmbient()` so
   the debug action and `MapShine.gustWind()` (the Remote's real impulse) call
   exactly one implementation, never two that could quietly drift.
6. ⚠️ **The suppression badge needs genuine new plumbing, confirmed by grep, not
   assumed unbuilt.** No `game.socket` channel is open anywhere in `src/`
   (`module.json` permits one; none exists). `reducePhotosensitiveEffects` is a
   Foundry `scope:'client'` setting — architecturally invisible to any OTHER
   client's `game.settings.get()`, not merely unbuilt by choice. A truthful
   cross-client count needs either a real socket broadcast or each client mirroring
   its setting onto its own User document for others to aggregate — real, scoped,
   named work, not attempted this round. `ui/widgets/impulse-button.js` renders an
   honestly-`planned` glyph on flash-class impulses instead. Suppression ITSELF
   needs no new work: `effect-cascade.js#resolveEffectEnabled`'s existing a11y gate
   already keeps a flash from rendering on a suppressed client regardless of what
   this widget knows — the gap is narrower than "does it work", it is only "can the
   GM see that it worked".
7. **Thunder stays `planned` for a reason confirmed by grep, not assumed:** zero
   audio infrastructure (`AudioContext`, any sound-playing call) exists anywhere in
   `src/` — `lightning.js`'s own header already documents that V2's strike-audio
   hook was "a literal empty stub." Built as a second real visual effect instead
   (re-triggering the origin flash) would be dishonest — two buttons that do the
   identical thing is not two impulses.
8. **The "channel-mapping... join the vector, don't grow it" bullet was already
   satisfied before this round, confirmed rather than assumed.** `weather-board.js`'s
   own comment and Petition P13 already exclude `bolt` from the fader vector as "an
   impulse, not a fade channel (U7's job)" — no second taxonomy needed inventing;
   this round makes that comment's forward reference true rather than aspirational.
9. **The Studio's full list lives in CUES, a worker-tier placement call, not a
   Testament directive** — worth the author's own countersign if wrong. Impulses
   and cues share only "something the GM fires from the Remote"; cues fade,
   impulses explicitly do not (§4.1). Kept in a visually separate section (its own
   heading, its own status line) rather than blended into the cue list, so the
   distinction reads even though they share a department.
10. **Both `tools/remote-preview/` and `tools/studio-preview/` prove the SAME real
    widget (`ui/widgets/impulse-button.js`) in both hosts** — live-verified: 3
    impulses render in each with correct live/planned states, the suppression glyph
    renders only on Strike (`flashClass:true`), clicking Strike/Gust fires their
    (preview-stand-in) handlers and shows the resulting status message, clicking
    Thunder shows its honest reason, and the Studio's list additionally confirms
    `showLabel:true` renders visible text ("Strike"/"Gust"/"Thunder") the Remote's
    icon-only corner correctly omits.

*Verification note: `npx eslint`, `npx prettier --check` clean on every file touched
(prettier auto-fixed 3 files on first pass, re-verified clean after).
`node tools/run-tests.mjs`: 27 suites, 11422 assertions, ALL GREEN (+24 over P19).
`node tools/verify-structure.mjs`: FAILED on first run (finding 2, above —
`graph/reachable-from-boot` ratchet broken 3-vs-2) — fixed for real, re-verified: the
same two pre-existing violations only (`no-gpu-readback`, `time/one-clock`'s ratchet,
41 against a bound of 38 — both confirmed via `git blame`/clean working-tree status to
predate this round and this project entirely, unrelated to this work). Live-verified
in the browser via both preview harnesses (finding 10, above) — zero console errors
on either. **Not verified, and cannot be from this session's tooling: the exit gate's
own "truthful against a second logged-in client" half** — that needs the socket/user-
flag plumbing finding 6 names as real, un-built follow-up work, not something to fake
a demonstration of. The concurrent water-flow session's own files
(`water-body*`/`water-flow*`/`water-render.js`/`water-shore.js`/`water.js`'s own
further edits since P19, their new `water-flow-subsystem.test.mjs`,
`docs/planning/Water-Simulation-Turn.md`, `tools/shader-lab/bench-water.js`) remain
completely untouched, confirmed by hunk-count diffing before every commit.*

---

**P21 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; the astrolabe visual-parity
fix — a live author bug report against U2's own re-home decision, filed the same session
as P19/P20).** The author's report, verbatim: *"The new remote still looks very very
different to the one that we built as a mock up. The astrolabe looks completely
different. The CSS and layout are not the same yet. Keep working on the problem."* Root-
caused, not patched: U2 re-homed `createAstrolabe()` on the premise that it only needed
re-skinning (Petition P11: "already live, already wired... the least-new-code highest-
payoff item"), true of its DATA wiring, false of its VISUAL DESIGN. DOM inspection
confirmed the actual gap — every internal div carried `cls:"(none)"` (zero LANTERN
classes), overall footprint 547×436px against the mock's 340×340px — because
`createAstrolabe()` was built for `Control-Panel.md`'s older "Bridge" doctrine: a flat
SVG ring bundled with a full legacy control block (wind/cloud/sky-light/atmosphere
sliders, a 13-button weather shelf, a mode `<select>`, a tuning drawer) that LANTERN
already rebuilt separately as `weather-board.js`. Not a CSS bug — the wrong paradigm,
requiring a new dedicated component, not a patch.

1. **`ui/rooms/remote/astrolabe-dial.js` (new) is the real re-skin**, reproducing the
   mock's actual instrument: a static `conic-gradient` ring (not per-band SVG arcs) with
   a rotating handle, a landscape scene (multi-keyframe sky gradient, an orbiting sun/moon
   with glow, a rotating star field, terrain silhouettes), and a masked "topper" layer
   guaranteeing the sun/moon stay visible over UI text — the exact fix already named in
   memory as `feedback_svg_mask_on_transformed_element_trap` (mask on a static wrapper,
   never a transformed element), applied here rather than rediscovered the hard way.
2. **The mock's own hand-tuned math (`SKY_KEYS`, `orbitXY`, `TERRAIN`, `skyFor`) is
   ported VERBATIM, not reinterpreted through `world/sun.js`'s differently-calibrated
   elevation model.** A deliberate risk call: matching art the author has already approved
   across many logged mock-refinement rounds exactly is safer than an independently
   "improved" version that risks becoming a SECOND mismatch. Node-tested against known
   keyframe outputs (`skyFor(12).top` = `[42,111,188]`, etc.) rather than only eyeballed.
3. **The old debug panel's own `createAstrolabe()` call is completely untouched**,
   confirmed by grep before and after — this round is a genuine side-by-side addition
   (only the Remote's `mountAstrolabeDial` callback changed), not a blind replacement,
   matching this whole migration's standing discipline. Because both components can now
   be mounted simultaneously, `astrolabe-dial.js` mints its own per-instance `nextUid()`
   suffix for every gradient/mask `id` — without it, two live instances' `url(#id)`
   references would resolve against whichever instance's element happened to render last.
4. ⚠️ **CAUGHT DURING VERIFICATION, NOT BY EYE: a second, independent mismatch.** Live DOM
   measurement showed the corner clusters sitting 36px outside the dial's own edge instead
   of flush with it, because `.msa-astro-dial-host` still carried a `padding:36px` left
   over from the old component's larger, differently-proportioned footprint — the mock's
   own `#astro` has zero surrounding padding. Fixed by removing the padding entirely;
   re-measured at (0,0) relative to the dial's own edge, not assumed fixed from the CSS
   change alone.
5. **Explicitly NOT ported this round, named rather than silently dropped** (full
   reasoning lives in the file's own header): the scene's animated weather overlays
   (rain/snow/ash streaks, fog haze), cloud SHAPE variation (opacity still reacts to real
   cover; shape stays fixed), real lunar phase (`moonAge` fixed at 0.4 — `world/calendar/
   moon.js#moonPhaseAt` exists and is real, but wiring it needs the Almanac's own live
   moon config, not reached for here), and wind's mock-only decorative "auto-drift" (the
   mock's own demo-keeps-moving flourish, never a real engine behind it in either place).
   Date text shows an honest `—` — no real date-formatting source exists in `boot.js` to
   read from yet.
6. **The preview harness needed its own small, honest fix, separate from the production
   bug.** `tools/remote-preview/preview.js`'s simulated drag correctly computed the right
   hour and `committed` flag, but the handle/clock didn't visually move, because the
   harness — unlike production's real `pumpAstrolabe`, which repaints continuously at
   ~10Hz off the live viewer's own env snapshot — only called `.update()` at mount time.
   Added a `pushUpdate()` helper invoked synchronously inside `onTimeChange`; a harness
   limitation, not evidence of a second production bug.

*Verification note: `npx eslint` clean (exit 0, zero output) on every file touched.
`npx prettier --check` flagged `astrolabe-dial.js` alone on first pass; `--write` fixed it,
re-verified clean. `node tools/run-tests.mjs`: 27 suites, 11446 passed, 0 failed, ALL GREEN
(+24 over P20 — the new `astrolabe-dial.test.mjs` suite: `skyFor`/`orbitXY`/
`terrainColorFor`/`elevationFactors`/`rgb` against known keyframe values). `node tools/
verify-structure.mjs`: the same two pre-existing violations only (`no-gpu-readback`,
`time/one-clock`'s ratchet at 41 against a bound of 38), no new violation — confirmed
`astrolabe-dial.js` reaches `boot.js` cleanly through `ui/index.js`'s barrel, unlike U7's
own first-pass miss (P20, finding 2). Confirmed by grep: `tools/studio-preview/preview.js`
has no astrolabe dial to update (Studio never had one). Live-verified against the standalone
preview harness only — DOM/CSS inspection (exact box-shadow strings, exact gradient stop
RGB values cross-checked against the ported `skyFor` math, exact 340×340px sizing) plus a
simulated drag interaction, since `computer{action:"screenshot"}` continues to fail with
"the Browser pane is not displayed" in this environment regardless of whether the tick is
autonomous or the author is actively engaged — this round confirms that limitation is not
specific to backgrounded contexts, as previously assumed. **Not verified, and cannot be
from this session's tooling: the fix's appearance inside the author's own real, live
Foundry session** — the author's own report was against that live surface, this round's
proof is against the standalone harness plus exact numeric CSS/SVG cross-checks against the
mock, and per this project's own standing rule, the author's live eyes are what promotes
this from `BUILT` to `LIVE`, not this note. The concurrent water-flow session's own files
(`water-body*`/`water-flow*`/`water-render.js`/`water-shore.js`/`water-surface-subsystem.js`/
`water.js`, `vt-pan-viewer.js`'s own further edits, their new
`water-flow-subsystem.test.mjs`, `docs/planning/Water-Simulation-Turn.md`,
`tools/shader-lab/bench-water.js`) remain completely untouched, confirmed by diffing every
touched file individually before staging.*

---

**P22 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; the corner-cluster
fix — a second live author bug report, same session, after seeing P21's own
fix render).** The author's report, verbatim, alongside a screenshot of the
live Remote and a second labelled "NEW" of the mock: *"Not bad, but the
buttons around the astrolabe are wrongly positioned... you should look at the
NEW and compare it to the current so that you can see what is different and
keep moving towards a perfect reproduction (even if you have to make sliders
and buttons that don't work yet)."* P21 fixed the dial itself; this is a
genuinely separate component and a genuinely separate bug — `astrolabe-
panel.js`'s four corner clusters, wrapping the dial, never actually ported
from the mock at all, confirmed by reading its own CSS: `.msa-corner{display:
grid; grid-auto-flow:column}` has no template whatsoever, so the grid just
auto-placed each button into a new implicit column — a flat ~86px-wide 1×3
strip, not the mock's compact 56×56px 2×2 L-shape tucked into the dial's own
empty corner triangle. The file's own header already correctly cited Petition
P5's real design (four corner clusters, one cell each left empty); the CSS
implementing that citation was never actually written.

1. **Ported the mock's own `.cornerCluster` rule verbatim** — `grid-
   template-columns/rows:repeat(2,26px)` plus a per-corner `grid-template-
   areas` L-shape (`"a b" "c ."` for TL, mirrored per corner) and `nth-
   child`→`grid-area` mapping, replacing the untemplated stub. Live-measured
   via the standalone preview harness (screenshot tooling still unavailable
   in this environment, same gap P21 named): all four corners render at
   exactly 56×56px, `grid-template-areas` matches the mock string-for-string
   per corner, and the dial-host/dial-slot both measure exactly 340×340px —
   confirming the existing `.msa-astro-dial-host` wrapper (audited, not
   assumed, since it wraps the corners AND the dial rather than the mock's
   flatter `#astro`-holds-everything structure) introduces zero extra sizing,
   so the same absolute `top:0/left:0` etc. lands exactly where the mock's
   own math already proved clear of the ring (Round 8's 49.8px diagonal
   clearance, cited directly in the new CSS comment rather than re-derived).
2. ⚠️ **The TL corner's speed button was silently dead — found by grep, not
   assumed working.** `ctx.onScrollToRateControl?.()` was referenced only in
   `astrolabe-panel.js` itself; boot.js never supplied it. Every click did
   nothing, no error, no explanation — a live-styled (non-`planned`) control
   silently failing Law 5. `feedback_unconsumed_api_rots_silently`'s exact
   shape, the same class of bug P20 caught in `core/impulse-schema.js`.
   Rebuilt as a real popover over `TIME_RATE_STEPS` (already the old debug
   panel's own rate vocabulary — no second one invented), wired through a new
   `ctx.onSetFlowRate` to the SAME `editSky({rateHoursPerMinute})` path the
   old panel's rate slider already writes through.
3. **The TL corner's other two icons were simply wrong**, not just
   unstyled: `flowBtn` used a `sun` icon with no `aria-pressed` at all
   (mock: `play`/`pause`, toggling, `aria-pressed` reflecting state);
   `jumpBtn` used `clock` (mock: `calendar`). Both corrected; `flowBtn` now
   swaps icon and `aria-pressed` on every toggle, and a new `syncFlowState()`
   handle — returned by `renderAstrolabePanel`, exposed as `shell.js`'s
   `syncAstrolabePanel()`, called every tick from `pumpAstrolabe` — keeps
   both TL buttons honest against a rate change from elsewhere (the old
   panel's own slider, another client), the same "never polls, told" shape
   `refreshWeatherBoard`/`refreshCueDeck` already use.
4. **The speed badge reads a REMEMBERED rate, not the raw live one, by
   deliberate design** — production's single-field model uses
   `rateHoursPerMinute:0` itself to mean "paused" (unlike the mock's own two-
   field `state.flow`/`state.speedIx`, fully independent). Showing the live
   value verbatim would flash the badge to a meaningless fallback on every
   pause; `getFlowRate` now returns the live rate if playing, else
   `lastNonZeroRateHoursPerMinute` (already the toggle's own remembered
   value) — the badge always shows what flow will actually resume at.
5. **`IMPULSES` reordered to `[strike, thunder, gust]`**, matching the
   mock's own `#cornerTR` append order (bolt, cloud, wind) exactly —
   production had shipped `[strike, gust, thunder]` since U7. One shared
   declaration (§9, P20's own point) means reordering it once reorders both
   the Remote's corner and the Studio's CUES list identically, not a per-
   surface patch.
6. ⚠️⚠️ **CAUGHT LIVE, NOT BY EYE: a menu-item click silently reopened its
   own parent popover.** Selecting a speed left a stray `<div class="msa-
   jump-menu">` still attached as a SECOND child of the button, sitting
   alongside the freshly-synced label — found via `childNodes` inspection
   showing 2 entries where 1 was expected, not a visual glance. Root cause:
   a menu item's own click handler never called `stopPropagation()`, so the
   click bubbled item→menu→button and re-triggered the BUTTON's own "open a
   fresh menu" listener — DOM event propagation paths are computed at
   dispatch time and don't change when a handler removes an ancestor
   mid-bubble, so `menu.remove()` succeeding didn't stop the stale path from
   still reaching the button. This is not a new bug this round introduced in
   isolation — the identical unguarded pattern already existed in the jump-
   to popover (present since U2, P11), just never noticed, plausibly because
   a silently-reopened menu that a user's next unrelated click immediately
   dismisses again reads as "huh, weird" rather than a reproducible bug.
   Fixed in both popovers' item handlers, not just the new one.
7. **Both preview harnesses' own separate impulse fixtures reordered to
   match** — `tools/remote-preview/` and `tools/studio-preview/` each carry
   their OWN hardcoded `IMPULSES` array (deliberately, per Petition P11's own
   "cheap eyes, no live Foundry" design), not a shared import from boot.js —
   left unreordered, the harnesses would have quietly stopped matching the
   very production order this round just fixed.

*Verification note: `npx eslint` clean on every file touched — ONE real
mistake caught by it first, not assumed clean: a code comment used inline
backticks around `grid-auto-flow:column` while itself sitting inside
`shell.js`'s own backtick-delimited CSS template string, prematurely
terminating it and turning the rest of the stylesheet into unparseable JS
("Unexpected token grid"). Fixed by dropping the inner backticks; the
cascading "installRemote not found" errors in two OTHER files vanished with
it, confirming they were symptoms of the same parse failure, not separate
bugs. `npx prettier --check` flagged `astrolabe-panel.js` alone; `--write`
fixed it. `node tools/run-tests.mjs`: 27 suites, ALL GREEN throughout (count
kept climbing across re-runs from the concurrent water session's own
unrelated commits, not this round's doing — cross-checked by file scope on
every jump). `node tools/verify-structure.mjs`: mid-round, a THIRD finding
appeared — `graph/reachable-from-boot`'s ratchet broke 3-vs-2, naming
`src/effects/water/water-sim.js` (among two already-known-tolerated files).
Confirmed via `git status` as the concurrent water session's own brand-new,
untracked, in-progress file (`water-sim.js` + `water-sim.test.mjs`, neither
staged nor touched by any commit this round) — not this work's to fix,
named rather than silently absorbed or silently ignored. Live-verified in
the browser via `tools/remote-preview/`: all four corners' computed
`grid-template-areas`/sizing match the mock exactly; `flowBtn`'s box-shadow,
`speedBtn`'s font-size/weight, and `.msa-ghost-slot`'s transparent/dashed
treatment all match the mock's own computed values exactly; clicking
`flowBtn` correctly swaps icon+`aria-pressed`; the speed popover opens with
all 5 real `TIME_RATE_STEPS`, the current rate correctly marked
`aria-pressed`, and picking a different one updates the badge cleanly with
no stray menu left behind, post-fix. **Not verified, same standing gap as
P21: the author's own live Foundry session** — this round's proof is the
preview harness plus exact computed-style cross-checks against the mock,
not a look inside the real Remote. The concurrent water-flow session's own
files (everything under `src/effects/water/`, `vt-pan-viewer.js`,
`docs/planning/Water-Simulation-Turn.md`, `tools/shader-lab/bench-water.js`,
plus this round's newly-observed `water-sim.js`/`water-sim.test.mjs`) remain
completely untouched, confirmed by diffing every touched file individually
before staging.*

---

**P23 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; the drag +
DEBUG-row round — a third live look the same session, both a mock and a
"WIP" screenshot labelled explicitly this time).** The author's report,
verbatim: *"Buttons around the astrolabe are still misplaced, no
performance section, I can't drag the header around to move it, lots of UI
elements aren't in place yet. Keep working."* Three distinct threads:

1. ⚠️ **The corner-cluster complaint was RE-INVESTIGATED, not re-assumed
   fixed.** Confirmed P22's own commits are still the latest touch to
   `shell.js`/`astrolabe-panel.js` (not reverted), confirmed no second,
   conflicting `.msa-corner` rule exists anywhere in `src/` (grepped), and
   re-derived the WIP screenshot's own geometry by hand: the TL cluster's
   measured footprint and its offset from the ring's own bounding-box corner
   both matched the mock's design within normal screenshot-measurement
   tolerance. No code defect found this round to explain "still misplaced."
   Named honestly rather than claimed fixed a second time: the likely
   explanations are a stale build on the author's own client, or a
   proportion/framing difference this environment's continuing lack of a
   working screenshot tool can't resolve with confidence — not a re-guess
   at a fix with nothing new to test against.
2. **`ui/widgets/draggable.js` (new)** ports the mock's own `makeDraggable()`
   verbatim — one shared implementation for Remote, Studio, AND Player
   rather than three copies that could drift, following this session's own
   established "one implementation, not a second that could disagree"
   discipline (P20's Gust promotion, P11's Baseline/Safety split). ⚠️ **Found
   in the process, not assumed: Studio's own `.room-head` already shipped
   the mock's `cursor:grab`/`:active{cursor:grabbing}` CSS with ZERO
   listener behind it** — looked draggable, silently did nothing, the exact
   "looks live, does nothing" shape Law 5 exists to catch. Player had
   neither the cursor nor the listener. Both wired for real now, off the
   same shared function. Ignores pointerdown on the header's own interactive
   children so minimize/close/camera-path/etc. stay clickable — verified
   live, not assumed from reading the mock's own equivalent guard.
3. **`ui/rooms/remote/debug-strip.js` (new)** ports the mock's own
   `#debugStrip` — whose OWN tooltips already read "(planned)" on HUD/probe/
   export and "Mock value — the real strip reads the VRAM ledger" on its
   vram figure, an explicit acknowledgment this round only had to act on,
   not discover. fps/ms/vram/the 24-bar sparkline are REAL:
   `diag/perf-strip.js#buildPerfStripModel` — already the old panel's own
   model builder — reshapes the SAME heartbeat stats object boot.js already
   computes every ~250ms, never a second, independently-tuned health
   computation. `probe`/`export` call real, already-shipping
   `MapShine.armPixelProbe`/`MapShine.flight.export`. `HUD` stays honestly
   `planned`: `diag/perf-hud.js#createPerfHud` is real but reachable only
   through the old panel's `registerPanel` mechanism today — matching the
   mock's own tooltip rather than overreaching past it.
4. ⚠️⚠️ **CAUGHT BY ESLINT, NOT BY EYE: the first wiring attempt referenced a
   variable with no real scope to live in.** `bootHeartbeat()` is a
   standalone top-level function, textually separate from `install()` and
   with NO lexical access to its locals — unlike `lastNonZeroRateHoursPerMinute`
   and every other closure-safety pattern this session has relied on so far,
   which all live INSIDE `install()`'s own body. A first draft declared
   `debugStripSnapshot` beside `lastNonZeroRateHoursPerMinute` assuming the
   identical safety applied; `no-undef` at the heartbeat's own usage site
   caught it before a single commit landed. Redesigned to PUSH a fresh
   snapshot as `updateDebugStrip(snapshot)`'s own argument each tick,
   matching `remoteAstrolabe.update(payload)`'s already-established shape,
   rather than a pull through a shared variable that was never actually
   shared.
5. **Both the Remote and Studio preview harnesses' own drag wiring, and the
   Remote's own fake ~250ms DEBUG tick, verified live** — `pointerdown`/
   `pointermove`/`pointerup` dispatched programmatically moved each room by
   exactly the simulated pointer delta, `right`/`bottom` correctly cleared
   in favour of `left`/`top`; the minimize button still fired correctly
   afterward (the interactive-child guard holds); all 24 spark bars filled
   with real varying heights within two ticks; probe/export both logged
   their stand-in confirmations on click.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
touched (one real `no-undef` caught and fixed pre-commit, finding 4 above).
`node tools/run-tests.mjs`: 27 suites, 11508 passed, 0 failed, ALL GREEN.
`node tools/verify-structure.mjs`: the same two pre-existing violations only
— the water session's own transient `graph/reachable-from-boot` break (seen
mid-round in the prior petition) had already resolved itself by this round's
own final check, confirmed as that session's own progress via `git diff`,
not this work's to fix either way. Live-verified in the browser via both
`tools/remote-preview/` and `tools/studio-preview/` (finding 5, above), zero
console errors on either. **Not verified: the author's own live Foundry
session**, same standing gap named in P21/P22 — and per finding 1 above,
specifically NOT re-claimed fixed for the corner-cluster complaint this
round without something new to point at. The concurrent water-flow
session's own files (everything under `src/effects/water/`, `src/diag/
perf-zones.js`'s new water-sim zone, `src/effects/index.js`'s new
`createWaterSimSubsystem` export, `vt-pan-viewer.js`, `docs/planning/
Water-Simulation-Turn.md`, `tools/shader-lab/bench-water.js`) remain
completely untouched, confirmed by diffing every touched file individually
before staging.*

---

**P24 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; a FOURTH live
look, same session — this time a genuine root-cause on the corner
complaint, not another "no defect found").** The author's report, verbatim,
with a hand-annotated screenshot pointing at the TR corner: *"Top right
section of three buttons isn't currently correct and we're still missing
some sliders... The 'remote/studio/player' bar isn't in yet... Fade time
isn't added yet. Lots of header stuff isn't there yet... give a small but
reliable amount of space between elements. We want concise but currently
buttons/sections are touching each other which is ugly."*

1. ⚠️⚠️ **THE TR CORNER BUG, FOUND FOR REAL THIS TIME.** P22/P23's own
   re-checks measured the CONTAINER geometry (56×56px, correct
   `grid-template-areas` string) and stopped there — never checking that
   every corner's actual CHILDREN matched the `button:nth-child(N)`
   selector's own assumption. They didn't: `ui/widgets/impulse-button.js`
   wraps its `<button>` in a `<span class="wrap">` (needed so the
   suppression badge can `position:absolute` against it) — TR's three
   DIRECT children are spans, never bare buttons. The selector required the
   child ITSELF to be a `<button>`, so it silently never matched TR at all;
   its three items fell through to the grid's own auto-placement, which
   fills cells in DOM order INCLUDING the area's own `.` gap — landing wind
   at bottom-left instead of the intended bottom-right. TL/BL/BR never
   showed this because every button there is built directly via `iconBtn()`.
   Confirmed live before fixing (`getComputedStyle(el).gridArea` read
   `"auto"` on every TR child, not `a`/`b`/`c`), confirmed live after
   (`"a"`/`"b"`/`"c"` correctly, wind now bottom-right). Fixed by widening
   the selector to `.msa-corner > :nth-child(N)` — matches whatever element
   is actually the direct child, button or span.
2. **The "touching" complaint was checked systematically, not patched by
   guessing.** Read the mock's own gap values for mood chips (`#moods{gap:
   5px}`), the debug strip (`gap:11px; row-gap:4px`), and the fade-time row
   (`#tempo{gap:4px}`) directly from `tools/ui-mock/index.html` — all three
   ALREADY matched production exactly. The real gaps were structural, not
   numeric: no `.msa-remote-sep` divider ever separated the DEBUG row from
   CUES above it (weather and cues both get one; debug never did), and
   THREE section headers the mock uses to give each block its own visual
   rhythm — Fade Time, Moods/Climates, Channels — didn't exist in production
   at all, so sections ran together with nothing but a bare 12px flex gap
   between them.
3. **The weather board's block-label headers (`ui/rooms/remote/weather-
   board.js`)**, ported from the mock's own `.blocklabel`, close finding 2
   AND the author's separate "Fade time isn't added yet" report at once —
   same missing piece, two different symptoms. Fixed the DOM order to match
   the mock exactly in the same pass: Fade Time first, THEN Moods, THEN
   Channels (production had Moods/the mode toggle first — a real ordering
   miss found while reading the mock's own markup, not assumed same as
   before). The Direct/Drift toggle now lives INSIDE the Moods/Climates
   label's own row (mock: title + `.modeseg` share one line via
   `margin-left:auto`), a compact pill instead of its own full-width row —
   and the title itself now swaps "Moods"/"Climates" with the mode, matching
   `#wxTitle`'s own behavior, live-verified via a simulated Drift click.
4. **Explicitly NOT attempted this round, named rather than rushed:** the
   Remote/Studio/Player switcher bar the author named directly ("isn't in
   yet") — a real, clearly-wanted feature, not a question needing the
   author's confirmation, but architecturally bigger than this round's other
   items (it would mean each room's own switcher opening the OTHER two real
   room controllers, not the mock's own single-page client-side toggle — a
   cross-room wiring question worth its own scoped pass) — and the mock's
   remaining 5 CHANNELS sliders (Fog/Wind/Freeze/Lightning/Ash), which have
   no live axis to read from today (confirmed against `WEATHER_AXES`' own
   `consumerStatus`, same finding P11/U2 already made) — building them
   honestly needs either real backing work or a deliberate `planned` slider
   design, neither attempted here rather than rushed into this pass.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
touched. `node tools/run-tests.mjs`: 27 suites, 11508 passed, 0 failed, ALL
GREEN (unchanged from P23 — this round touched no test-covered logic, pure
UI). `node tools/verify-structure.mjs`: the same two pre-existing violations
only. Live-verified in the browser via `tools/remote-preview/`: TR's three
children resolve to the correct `grid-area`s and correct on-screen
positions post-fix; all three block-labels render in the correct order with
correct text; the Fade Time hint updates live on a simulated click; the
Moods/Climates title swaps correctly on a simulated Direct/Drift toggle.
⚠️ **A stale-console-residue false alarm hit TWICE this round** — the exact
"error survives navigation to an unrelated page" trap named in Round 6/7 of
this Testament's own memory record — confirmed both times by checking that
the page's own DOM/controls actually worked before trusting the reported
error at all, not by re-theorizing from the error text. **Not verified: the
author's own live Foundry session**, same standing gap as P21–P23. The
concurrent water-flow session's own files remain completely untouched,
confirmed by diffing every touched file individually before staging.*

---

**P25 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; the parity audit
— the author set a new, explicit end state).** Verbatim: *"continue with the
next most critical pieces of the UI. The goal is to get to the point where
all the original remote's controls are wired in correctly so that we can
remove the old one and replace it entirely with the new one."* This is the
first round with a NAMED FINISH LINE, not an open-ended "keep working" —
worth recording as its own kind of instruction. Ran a full old-vs-new
control inventory first (`ui/astrolabe.js` + `buildAstrolabeOptions` in
`boot.js` against every file in `ui/rooms/remote/`), then verified the
single most consequential finding directly against `world/day-clock.js`
before building anything, rather than trusting the audit's own claim on
faith.

1. ⚠️⚠️ **THE MOST CRITICAL FINDING: Play/Pause and Speed were non-
   functional in EVERY reachable state.** `astrolabe-panel.js` gated both
   on `isPenArmed()` (posture `'almanac'` only) — but `world/day-clock.js`'s
   own rate branch and `canSetHour` both gate on `currentMode==='aesthetic'`
   exclusively (confirmed by reading the file directly, not assumed from
   the audit). Net effect: blocked in Aesthetic (the default) by a check
   that shouldn't apply to them, inert-even-if-reachable in Almanac (where
   rate drives nothing). Root cause: the new Remote never ported the old
   astrolabe.js's own real Clock-mode selector (Aesthetic/Follow/Almanac,
   `modeSelect` → `onTimeModeChange` → `editSky({mode})`) — there was no way
   to even SEE or reach Aesthetic from the new Remote, let alone gate
   correctly against it.
2. **Built the Clock-mode control** — a 3-way segmented pill (matching the
   Direct/Drift precedent in `weather-board.js`, not the old system's native
   `<select>`) sitting above the dial, wired to the SAME `editSky({mode})`
   one-liner the old panel's own select already calls. Re-gated flow/speed
   on `posture==='aesthetic'` instead of `isPenArmed()`; Jump-to's own
   `isPenArmed()`/'almanac' gate is correct as-is and stays untouched.
   Live-verified end to end: blocked with the correct new message in
   Almanac, switching to Aesthetic un-blocks it for real (`aria-pressed`
   correctly flips false→true, icon swaps play→pause).
3. **The wind pill's own speed was silently dropped** —
   `astrolabe-dial.js#update()`'s JSDoc documented `windSpeed01` as an
   accepted field, boot.js's real pump passed it every tick, but the
   function body never read it. Fixed to match the old panel's own
   `wind-panel` status format exactly ("NE · 30%" / "calm") — read-only for
   now; editing wind is separate, bigger work (Gap below).
4. **Four more real controls, previously entirely absent from the new
   Remote, now live:** Sky Light and Atmosphere join the Channels section
   (their OWN commit path, not `LIVE_CHANNELS`/`onAxisCommit`, which also
   stamps `weatherArchetype:'custom'` — correct for weather axes, wrong for
   these two); Pace joins the Moods/Climates block, rendering ONLY in
   Drift/Almanac mode (meaningless in Direct, matching the old panel's own
   grouping beside Climate); Scene override ("this scene has its own sky")
   is a real bool param through the same `buildParamControl` door every
   other row already uses. All four wired to the exact same real functions
   (`editSky`/`setSceneSkyOverride`) the old astrolabe instance already
   calls — one path, never a second one that could disagree.
5. **Explicitly NOT attempted this round, named from the audit rather than
   silently dropped:** wind direction/speed EDITING (the old dial's hub-drag
   gesture has no equivalent surface on the new dial — its hub is now
   covered by the landscape art; needs either a repurposed gesture or a new
   popover, real follow-up work); the 8 ring time-stops (dawn/noon/dusk/etc.
   quick-snap, `sweepVtPanViewerTimeOfDay`); ring-lock protection (the old
   dial refuses drag and dims when `canSetHour===false`; the new one drags
   unconditionally — latent until Follow mode sees real use, since Gap 1
   made it effectively unreachable before this round); the Almanac forecast
   readout + "surprise me" toggle; the Clouds fader's pin/unpin glyph; and
   richer sticky-status text. All real, all scoped, none rushed into this
   pass.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
touched. `node tools/run-tests.mjs`: 27 suites, 11512 passed, 0 failed, ALL
GREEN. `node tools/verify-structure.mjs`: the same two pre-existing
violations only. Live-verified in the browser via `tools/remote-preview/`:
the clock-mode pill's `aria-pressed` state and the flow-gate's actual
blocked/unblocked behavior both confirmed before AND after the fix (not
just after); all 5 Channels rows render with correct labels/values; Pace
confirmed absent in Direct and present with the correct value in Drift,
checked from a clean Direct state specifically after an earlier check's own
click ordering produced a misleading result (caught by re-testing from a
known state, not by trusting the first number); the scene-override checkbox
and a Sky Light slider both commit and log correctly. **Not verified: the
author's own live Foundry session**, same standing gap as P21–P24 — and
per §9's own two-word rule, that is what actually promotes any of this from
`BUILT` to `LIVE`, not this note. The concurrent water-flow session's own
files remain completely untouched, confirmed by diffing every touched file
individually before staging.*

---

**P26 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; continuing P25's
own gap list — Gap 12, ring-lock protection, which P25's own finding 5
already named as "latent until Follow mode sees real use, since Gap 1 made
it effectively unreachable before this round" — Gap 1 is now fixed, so this
stopped being latent the moment P25 shipped).** Not a cosmetic follow-up:
reading `world/day-clock.js` directly (not assumed from the old panel's own
lock) showed dragging the new dial's ring in Follow/Almanac mode silently
persisted a stale `todHour` into the resolved sky scope even though the
visible sun correctly never moved — a real, if quiet, correctness bug in
the exact shape this Testament keeps finding: a control that LOOKS inert
but isn't.

1. ⚠️ **THE MECHANISM, TRACED END TO END BEFORE WRITING ANY FIX.**
   `day-clock.js#setHour` already rejects outright outside `'aesthetic'`
   (`if (currentMode !== 'aesthetic') return false`), and
   `boot.js#applyLookToEngines` only calls `setVtPanViewerSunHour` when
   `sky.mode === 'aesthetic'` — so the visible sun was always safe. But
   `editSky`'s own merge (`applySkyEdit`) has no such guard: a drag's
   `editSky({todHour: hour})` on release still overwrote the PERSISTED
   `todHour` in world/scene sky settings regardless of posture, with no
   visible sign anything had happened. A GM dragging what looked like a
   dead dial in Follow mode would later switch to Aesthetic and watch the
   sun jump to wherever they last absent-mindedly dragged, not where they
   left it — silent now, confusing later.
2. **Built the lock, matching `ui/astrolabe.js`'s own `ringLocked` fidelity
   level exactly.** `astrolabe-dial.js#update()` gained a `canSetHour`
   field (already computed by day-clock, already threaded to the OLD
   panel's own `update(payload)` call via its `...dial` spread — the
   Remote's own `remoteAstrolabe.update()` call in `pumpAstrolabe` simply
   wasn't reading the same field yet). Gated at gesture-START only
   (`pointerdown`/`keydown`), not re-polled mid-drag — the old file's own
   `onDown`/`onMove` split does the same, not a lower bar invented here.
   Visual match: `rimArt` opacity 0.55, `cursor:not-allowed`,
   `aria-disabled` — same values the old ring already uses.
3. **The explanation, routed through the existing status line, not a new
   one.** `mountAstrolabeDial`'s call signature widened to
   `(el, {onLockedAttempt})`; boot.js and the remote-preview fixture both
   pass it straight to `buildAstrolabeDial`; `astrolabe-panel.js` supplies
   a ring-specific `explainRingLocked` reading the live posture. Kept
   deliberately SEPARATE from `buildCornerTL`'s own `explainNotAesthetic`
   despite both keying off the identical `currentMode==='aesthetic'` gate
   — the two verbs differ ("drag the hour" vs. "run the flow"), and a
   shared string would leave one of the two contexts saying the wrong
   thing. Two small purpose-built closures, not one premature shared one.
4. **Caught a three-site fixture gap before calling the harness fixed.**
   `tools/remote-preview/preview.js` re-declares the dial's update payload
   at three separate call sites (initial mount, the Clock-mode handler,
   the flow-toggle handler) — grepped for every `remoteDialInstance.update(`
   call before considering the fixture done, not just the one or two sites
   touched first, and found the flow-toggle site had been missed on the
   first pass. Left uncorrected it would have silently flickered the ring
   back to "unlocked" on every play/pause click while actually locked —
   the exact one-field-forgotten-at-some-call-sites shape this project's
   own memory keeps naming, caught here before it shipped rather than
   after.
5. **Explicitly NOT touched this round:** every other item on P25's own
   Tier-2 list — wind direction/speed editing, the 8 ring time-stops, the
   Almanac forecast readout, the Clouds fader's pin/unpin glyph, richer
   sticky-status text — and the separately-deferred Remote/Studio/Player
   switcher bar from P24. No scope crept beyond the one gap this petition
   names.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
touched. `node tools/run-tests.mjs`: 27 suites, 11512 passed, 0 failed, ALL
GREEN — unchanged from P25; no new test file was added, matching this
project's own established boundary (`src/ui/__tests__/run-tests.mjs`'s own
header: "Pure logic — no DOM... browser-only and verified live" —
confirmed `ui/astrolabe.js`'s own identical `ringLocked` feature carries
zero Node coverage today either, by reading its test file directly rather
than assuming). `node tools/verify-structure.mjs`: the same two
pre-existing violations only, confirmed by `git diff`-ing this round's own
changes against every flagged line — none belong to this round. Live-
verified in the browser via `tools/remote-preview/`, all four transitions
checked by dispatching real `PointerEvent`s against the live DOM rather
than asserted from source alone: the harness's default Almanac posture
starts the ring locked (cursor/opacity/`aria-disabled` all correct) before
any interaction; switching to Aesthetic unlocks it INSTANTLY (no drag
needed first) and a real drag then succeeds (hour 14→12, logged);
switching to Follow re-locks it instantly and a real drag attempt is
refused (hour unchanged, the live posture named correctly in the status
line, the refusal logged); console clean throughout, no stale-residue false
alarm this round. **Not verified: the author's own live Foundry session**,
same standing gap as P21–P25. The concurrent water-flow session's own files
remain completely untouched, confirmed via `git status --porcelain` before
staging.*

---

**P27 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; an autonomous-loop
tick continuing the parity audit — no new author message since P26, acting
on the standing "continue with the next most critical pieces" instruction
against the remaining Tier-2 gap list P25 itself named).** Investigated Gap
11 (ring time-stops) first and stopped short of building it: the mock never
depicted this control at all (grepped `tools/ui-mock/index.html`, zero
hits), so unlike every other item this migration has ported, there is no
author-approved visual precedent to build against — and the one obvious
placement (folding it into the TL corner's existing "Jump to…" menu) would
wrongly conflate two genuinely different mechanisms under one button (Jump
uses the Almanac Pen, server-authoritative, `'almanac'`-only; time-stops use
`sweepTimeOfDay`, a local aesthetic sweep, deliberately ungated in every
mode). Left named, not guessed at. Two smaller, unambiguous items got built
instead, both found by reading the OLD system's real source before writing
anything:

1. ⚠️ **A REAL BUG IN ALREADY-SHIPPING CODE, not a new-Remote gap** — found
   while researching Gap 11. `boot.js`'s shared `buildAstrolabeOptions()`
   (used by BOTH the old panel and, per its own header comment, the new
   Remote's dial) has an `onTimeStop` handler that calls
   `editSky({todHour: hour})` unconditionally, exactly the same shape
   Petition P26 already fixed for the ring drag — and `applyLookToEngines`
   only ever reads `sky.todHour` back out in `'aesthetic'` mode, so the
   write silently corrupts the persisted value in Follow/Almanac until the
   next Aesthetic switch. Unlike the ring drag, this one was never
   caller-guarded: the OLD SVG dial's time-stop dots have no `ringLocked`
   check at all (confirmed by reading `astrolabe.js` directly — they're
   deliberately always-clickable, matching `sweepTimeOfDay`'s own "always
   accepted" semantics, since that same function is also how synced mode
   catches up to Foundry's real time). Fixed by gating only the `editSky`
   call on `sky.mode==='aesthetic'`, leaving the visible sweep itself
   unconditional — no loss of the real, intended behaviour, just the
   silent corruption removed. **Could not be live-verified**: neither
   `tools/remote-preview/` nor `tools/studio-preview/` constructs the OLD
   panel's own `createAstrolabe(buildAstrolabeOptions())` instance (grepped
   both, zero hits) — this fix is traced by precise code reading and the
   full Node suite staying green, not by a DOM click test. Named honestly
   rather than claimed.
2. **The cloud pin/unpin glyph, ported for real** (Gap 10 — old:
   `astrolabe.js:358-373` → `onUnpinCloudCover` → `boot.js`). Attached to
   the Clouds row inside `weather-board.js#renderFaders()`'s `LIVE_CHANNELS`
   loop, the exact same `row.appendChild()` shape the Drift-bracket note
   already uses there — no new attachment mechanism invented. Visible only
   in Drift mode while `weather.read().pinnedAxes` genuinely contains
   `cloudCover01` (the real field the dial-state snapshot already carries
   every tick), click calls the SAME `unpinVtPanViewerWeatherAxis` the old
   panel's own glyph already calls.
3. ⚠️⚠️ **CAUGHT LIVE, NOT BY EYE: the Direct/Drift mode buttons never
   called `renderFaders()` at all.** First live test of the pin glyph
   (force-pin via a new `window.__preview` debug door in the harness — see
   below — then click Drift) showed the glyph simply never appearing;
   clicking Direct afterward left it VISIBLE, still showing pinned. Traced
   to `directBtn`/`driftBtn`'s own click handlers, which call
   `paintMode()`/`renderChips()`/`renderPace()` but never `renderFaders()` —
   a pre-existing gap since whichever round first split those functions
   apart, invisible until now because nothing before this glyph depended on
   the fader rows repainting on the MODE click itself (the Drift-bracket
   note only ever needed a biome-CHIP click, which already calls
   `renderFaders()` inside its own handler). Fixed by adding the one missing
   call to both mode handlers. This is a strict improvement for the
   pre-existing bracket note too, not just the new glyph — re-tested from a
   clean reload after the fix, both directions, before trusting the result
   (P25's own "re-test from a known state" lesson applied again).
4. **`tools/remote-preview/preview.js` gained a small `window.__preview`
   debug door** (`{fakeSky, remote}`), same spirit as the UI mock's own
   documented `window.__mock` hook — `weatherPinnedAxes` has no real UI
   trigger in this harness at all (nothing simulates the Almanac's own
   autonomous weather walk that would pin/unpin it for real), so testing it
   needed a way to poke the fixture's module-private state directly. Useful
   beyond this one field for future rounds.
5. **Explicitly NOT touched:** ring time-stops (named above), wind
   direction/speed editing, the Almanac forecast readout, richer status
   text, the Remote/Studio/Player switcher bar.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
touched (re-checked after each of the two rounds of edits this petition
made, not just the first). `node tools/run-tests.mjs`: 27 suites, 11512
passed, 0 failed, unchanged from P26 — no test-covered logic in either fix.
`node tools/verify-structure.mjs`: the same two pre-existing violations
only, confirmed by `git diff` against every flagged line, checked again
after the mode-toggle fix specifically. Live-verified in the browser via
`tools/remote-preview/`: the pin glyph's presence/title/text/parent-row all
confirmed correct on first showing; unpin click confirmed to clear the
underlying state, log the action, and remove the glyph; the mode-toggle
fix re-tested from a fresh reload in both directions (Drift→shows,
Direct→hides) rather than trusting the first, misleading result; console
clean throughout, no stale-residue false alarm this round. The `onTimeStop`
fix is NOT live-verified (see finding 1) — named, not hidden. **Not
verified: the author's own live Foundry session**, same standing gap as
P21–P26. The concurrent water-flow session's own files remain completely
untouched, confirmed via `git status --porcelain` before staging.*

---

**P28 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; a live author
report with a side-by-side WIP/mock comparison, not an audit finding).**
Verbatim: *"Climate buttons need to be better organised. We need the extra
opening room of climate choices."* The screenshot showed the Moods section
as a flat, unstructured wall of all 16 real archetypes wrapping raggedly
(final row: one lone chip) — the mock's own screenshot showed a small
favourites row plus a "🔍 Browse 67" button opening a searchable overlay for
everything else. Read the mock's real `#wxPicker` implementation
(`openWxPicker`/`drawWxHits`/`wxIndexFor`) before building anything.

1. ⚠️ **NOT A 1:1 PORT — the mock's own catalog doesn't exist in
   production.** The mock's 67-item Browse catalog is `FACETS` (6
   channel-facet partial presets) + `WX_NAMED_ALL`, a dimension never built
   into `world/` (grepped — zero hits, same finding P11/U2 already made for
   the channel faders). What's real today is exactly `WEATHER_ARCHETYPES`
   (16) and `WEATHER_BIOMES` (10). Built the overlay against THOSE, honestly
   smaller than the mock's own, rather than padding it out to match.
2. **`ui/widgets/search-overlay.js` (new)** — the shared `.searchOverlay`
   shell, promoted out of `ui/rooms/studio/search-palette.js`, whose own
   header already flagged this exact deferral at U1 time ("shared shell
   shape; only this module's own consumer exists in src/ so far"). The
   weather picker is the second real consumer the comment was written for —
   Law 8 applies now, not before. Hit-rendering logic stays per-consumer
   (a Studio param row and a weather archetype share nothing generic left to
   factor out); only DOM/CSS shell + open/close/escape/focus plumbing moved.
   `search-palette.js` refactored to call it, external signature unchanged,
   its own `.hl` flash-animation CSS (a Studio-specific concept the shell
   knows nothing about) stayed put.
3. **`ui/rooms/remote/weather-picker.js` (new)** — searches the real 16/10
   flat (no group headers: the mock grouped by facet, but no real facet axis
   exists on `WEATHER_ARCHETYPES`/`WEATHER_BIOMES` to group by honestly;
   inventing one would be a second, UI-only taxonomy with nothing behind
   it). Archetype hits show the real emoji icon; biome hits show none —
   matching `weather-board.js`'s own existing chip rendering for each,
   which already treats them differently for the same reason (biomes carry
   no icon field). Applies through `ctx.fadeToArchetype`/
   `ctx.onWeatherBiomeChange` — the SAME two functions the favourites chips
   already call, never a second path.
4. ⚠️ **THE FAVOURITES SPLIT IS A WORKER-TIER CURATION CALL, named as one.**
   `WEATHER_ARCHETYPES`/`WEATHER_BIOMES` carry no favourite/featured flag —
   there is no data-level source of truth for "which 8 (of 16) / 6 (of 10)
   go inline." Chose clear/fair/overcast/fog/rain/snow/gale/storm (spans the
   severity gradient the archetype table's own shelf order already encodes)
   and temperate-coast/continental-plains/desert/boreal-tundra/
   tropical-monsoon/high-mountain (the "useful in almost any campaign"
   subset, leaving the four more setting-specific biomes for Browse). Worth
   the author's countersign if the read is wrong — same posture P19 already
   took for water's own FOH dial curation.
5. **`.msa-wx-chips` is a real 4-column grid now**, not a wrapping flex row
   — the author's own "better organised" complaint had a second, structural
   half beyond the favourites split: an uneven trailing row reads as
   unorganised regardless of item count. `.msa-wx-header-right` groups
   Browse + the Direct/Drift pill into one flex cluster occupying the
   blockLabel's single trailing slot (mock: both share one header line).
6. **Zero boot.js or `tools/remote-preview/preview.js` changes needed.**
   `weather-board.js` constructs `installWeatherPicker` directly (same
   pattern as `fadeTime = createFadeTimeControl()` a few lines above it, not
   `mountAstrolabeDial`'s boot.js-owned-engine-mount pattern — this file
   already reaches `world/index.js` directly for the same two tables), and
   its callbacks route through ctx fields (`fadeToArchetype`/
   `onWeatherBiomeChange`) that both boot.js and the preview fixture already
   supplied for the existing chips. Confirmed live rather than assumed.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
(one round of the session's own recurring backtick-inside-CSS-comment trap
hit and fixed before this note — `shell.js`'s new header-right comment).
`node tools/run-tests.mjs`: 27 suites, 11512 passed, 0 failed, unchanged —
no test-covered logic touched (this is all DOM, same established boundary
as every other Remote UI round). `node tools/verify-structure.mjs`: the
same two pre-existing violations only, confirmed via `git diff` against
every flagged line across all five touched/new files. Live-verified in the
browser via `tools/remote-preview/` AND `tools/studio-preview/` (a real
regression check on the shared-widget extraction, not just the new
feature): Direct mode shows the exact 8 favourite chips in order, Browse
shows "16"/"Browse all 16 weather types", opens the full 16-item list,
search-filters correctly ("ash" → 1 hit), a click applies via the real
fixture (`fading -> Ashfall over 0ms` logged) and closes; Drift mode shows
the exact 6 favourite chips, Browse shows "10 climates" with the correct
placeholder swap, a biome click applies (`biome -> shadowfell-verge`
logged); Escape closes from either mode. Studio's own search-palette
(`/` key) still opens with the correct aria-label/placeholder/8-item
default browse, still filters correctly ("foam" → 5 real water-param hits),
still closes on click — the shell survived the extraction intact. **One
piece honestly NOT verifiable here**: `flashParam`'s own
`requestAnimationFrame`-gated card-scroll/highlight — blocked by this
pane's own previously-documented limitation (rAF does not reliably fire
without OS focus, `feedback_sandboxed_browser_pane_lacks_os_focus`), not a
new gap this round introduced; that method's body was not touched by the
refactor at all. **Not verified: the author's own live Foundry session**,
same standing gap as P21–P27. The concurrent water-flow session's own files
remain completely untouched, confirmed via `git status --porcelain` before
staging.*

---

**P29 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; an autonomous-loop
tick continuing the parity work — no new author message since P28, acting
on the standing "continue with the next most critical pieces" instruction,
picking a well-scoped item off the open gap list rather than the one
genuinely needing the author's own design call, wind editing).** Went
looking at Gap 13 (richer sticky-status text) and found the real gap was one
level up from where the audit pointed.

1. ⚠️⚠️ **TWO UNCONSUMED APIS, BOTH ALREADY BUILT, NEITHER EVER CALLED.**
   `shell.js#updateNowPlaying({glyph, label})` has existed since U2, fully
   wired to repaint the Remote's own "Now Playing" line — grepped `boot.js`
   for every call site: zero. The label has sat frozen at its hardcoded
   `"Steady"` default forever, live, in production, since the Remote first
   shipped. Separately, `world/fade-engine.js`'s own `FadeEntry.label` field
   doc already named this exact destination — *"shown on the Now Playing
   ring's hover"* — written at U2 time, never actually wired to it either.
   Two names for the same unfinished thread, found by reading one after the
   other rather than stopping at the first.
2. **Built `boot.js#buildNowPlayingLabel(dial, nowMs)`** — two real states,
   both from data the engine already carries: a weather archetype fade
   genuinely in flight (`fadeState`'s own `label`/`startedAtMs`/`overMs`,
   the exact fields the doc comment above already promised) renders
   `"Fading to {label} — {N}s left"`; the settled default renders
   `"Holding — {phase}"`, using a newly-`export`ed `phaseDisplayName`
   (`ui/astrolabe.js`, threaded through `ui/index.js`'s own door — it was
   already a correct, tested, private helper, just never reachable from
   outside that file). Called from `pumpAstrolabe`'s existing ~10Hz
   throttled block, no new timer.
3. ⚠️ **Deliberately NOT the mock's own full composition.** Read the mock's
   real `#npLabel` logic before writing anything (`"Holding — Afternoon,
   light rain"`, and three OTHER states: a whole-day "Passage" sweep, a
   Drift-mode climate phrase, a `weatherWord` precip-description taxonomy).
   `state.passage` has no production equivalent at all (grepped, zero hits)
   — a real, separate feature, not a text-formatting gap. The `weatherWord`
   phrase taxonomy and the Drift-mode phrasing are their own scoped
   follow-up, not invented here under time pressure. Two states shipped
   honestly beat four states with two of them faked.
4. **`tools/remote-preview/preview.js` mirrors the same two-state logic**,
   plus two synchronous calls (fade-start, and right after `remote.open()`)
   for the same reason `fadeToArchetype`'s own existing calls already need
   them: this pane's `requestAnimationFrame` doesn't reliably fire without
   OS focus, so a gesture giving itself immediate feedback is what actually
   makes a change observable here. ⚠️ Caught my own test-methodology miss
   mid-round: first tried triggering a fade with Fade Time still on its
   "Now" (0ms) default and read "Holding — Day" right back — not a bug, a
   0ms fade has no window to observe as "in flight" at all. Re-tested with a
   real duration (1m) before concluding anything, per this project's own
   standing "re-test from a known state" lesson.

*Verification note: `npx eslint`/`npx prettier --check` clean on every file
(prettier's own `--write` reflowed one long line in `boot.js`, re-verified
after). `node tools/run-tests.mjs`: 27 suites, 11512 passed, 0 failed,
unchanged — no test-covered logic touched. `node tools/verify-structure.mjs`:
the same two pre-existing violations only; the new `performance.now()` call
added to `tools/remote-preview/preview.js` was checked explicitly against
the `time/one-clock` wall's own violation list (grepped for
`preview.js`/`remote-preview`, zero hits) — confirmed `tools/` sits outside
that wall's scope entirely, not just unlucky to dodge it. Live-verified in
the browser via `tools/remote-preview/`: fresh load shows "Holding — Day"
immediately (not the stale "Steady" default); a real-duration archetype
fade shows "Fading to Clear — 60s left" and the countdown genuinely
advances in real time (watched it read 37s left later in the same session,
not just asserted from source); console clean throughout. **Not verified:
the author's own live Foundry session**, same standing gap as P21–P28. The
concurrent water-flow session's own files remain completely untouched,
confirmed via `git status --porcelain` before staging.*

---

**P30 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; a live author
report with an annotated screenshot, seven distinct asks in one message).**
Verbatim: *"Mood buttons don't work yet. We're still missing a lot of
sliders. The FPS tracker is nice, green should be anything above 60 fps.
Yellow should be anything above 35 fps. Anything below 25 fps should be red.
Blend between these. Sun is in front of the pill and time text. 'This scene
has it's own sky' is... well that's just down right esoteric. What the hell
do you mean by that? Maybe that control needs to go. Go button needs a lot
of work too, throw away the current go button concept and just make
something nicer. No animation on the go button it's distracting."*

1. ⚠️ **"Mood buttons don't work" was real, but not where it looked.**
   Live-tested `fadeToArchetype` directly first rather than assuming the
   report was right or wrong — it fires and logs correctly (`fading ->
   Storm over 0ms`). Traced further: `fadeWeatherToArchetype()` in
   `boot.js` calls `void editSky({ weatherArchetype: 'custom' })`
   synchronously the INSTANT a fade starts, not on arrival — so
   `activeArchetype === archetype.id` (`renderChips`' own highlight check)
   goes false for every chip, including the one just clicked. The author's
   own screenshot showed Fade Time = 10s selected: clicking any mood chip
   made the entire row go dark for the full 10 seconds with zero sign the
   click registered. A real, understandable "doesn't work," from a real
   mechanism working correctly underneath.
2. **Added `data-pending="true"`** to `weather-board.js#renderChips()` — a
   new state, deliberately distinct from `aria-pressed` (reserved for what
   the sky actually IS, per the file's own existing comment), sourced from
   `ctx.getFadingArchetypeId()` (new, in both `boot.js` and
   `tools/remote-preview/preview.js`), which reuses the SAME
   `fadeState`/`pendingArchetypeCompletions` P29's Now Playing label
   already reads — no second tracking mechanism. Dashed gold border + tint
   (`shell.js`'s new `[data-pending="true"]` rule) while a fade is in
   flight toward that chip; clears on arrival or mode switch. Live-verified:
   click Storm at a 10s fade → `data-pending` appears on Storm alone,
   `aria-pressed` stays false on all eight chips → after the fade,
   `data-pending` clears and `aria-pressed="true"` lands on Storm, matching
   a real `arrived -> thunderstorm` log line.
3. **FPS sparkline recoloured to the author's own exact spec** (green
   ≥60fps, yellow ≥35fps, red <25fps, continuous blend between). Built as
   `debug-strip.js#fpsBlendColor` — deliberately a SEPARATE model from
   `perf-strip.js`'s shared `healthLevel(ratio, ...)`, which grades fps as a
   fraction of THIS DISPLAY's own detected refresh rate (right for the old
   panel's one summary bar, wrong for a fixed author-specified absolute
   scale across 24 samples). Reads the LIVE `--ok`/`--warn`/`--fail`
   LANTERN tokens via `getComputedStyle` (new `hexToRgb` helper) rather than
   hardcoding RGB, so the sparkline stays theme-correct across all four
   themes like everything else in this room. `boot.js` now pushes raw
   `stats.fps` alongside the existing `ratio`/`level` fields into
   `fpsSparkHistory` — two legitimate consumers off one sample, not a
   second sampling path. Live-verified: bars read `rgb(75,212,140)` (green)
   at high fps, sweeping down through `rgb(212,187,88)`/`rgb(237,168,81)`
   (amber) to `rgb(239,109,90)` (red) at low fps across the harness's sweep
   fixture — a genuine blend, not discrete jumps.
4. **Sun z-order fixed.** `astrolabe-dial.js` was calling
   `root.appendChild(sceneText)` immediately after building it, BEFORE
   `sceneTopper` (the sun/moon "guarantee" masked layer) was built and
   appended afterward — later-appended siblings paint on top in the shared
   stacking context, so the topper painted over the clock pill. Moved
   `sceneText`'s append to after `topper`'s. Live-verified via a DOM-order
   query: `scene → scenetopper (svg) → scenetext`, topper strictly before
   text now.
5. **"This scene has its own sky" rewritten, not removed** — the author's
   complaint was clarity, not the control's existence (a real, working
   `sceneOverride` flag; no reason to delete a working toggle over confusing
   copy). New label: *"Scene overrides the world sky."* New help text
   explains the CONSEQUENCE of each state (*"On: changes you make here only
   affect this scene. Off: they change the shared sky every scene uses by
   default"*) rather than just re-naming the state. ⚠️ A wording/clarity
   judgment call, named as one — same worker-tier curation posture P19/P28
   already took, worth the author's countersign if the read is wrong.
6. **GO button fully redesigned, no animation.** The entire prior CSS
   (6-layer box-shadow stack, gradient-on-gradient background, an infinite
   4.6s `@keyframes msaGoSheen` sheen loop) deleted, not muted — the
   author's own instruction was to throw the concept away, not soften it.
   Replaced with a flat solid-tint button
   (`color-mix(in oklab, var(--shine) 20%, var(--bg2))`), a lighter tint on
   hover, a 1px press-down on `:active`, no animation anywhere across
   idle/hover/active/disabled. Live-verified via computed style:
   `animationName: 'none'`, `animationDuration: '0s'`,
   `backgroundImage: 'none'`.
7. **Missing sliders — re-audited `WEATHER_AXES` fresh rather than
   repeating the prior round's finding unverified.** `cloudType01`/
   `cloudAltitudePx`/`cloudScalePx` remain genuinely
   `consumerStatus:'pending'` (re-grepped, `world/cloud-field.js` still
   doesn't exist — governed by wall `ui/no-dead-axis`, correctly absent,
   not a gap). But `temperature01` — `consumerStatus:'live'` (drives
   precipKind derivation and wetness dry-rate) yet
   `MapShine.setTemperature`-console-only since it shipped — had zero UI
   slider anywhere. Shipped as a new Temperature slider in `ENV_CHANNELS`
   (its own commit path via `boot.js#onTemperatureCommit`, NOT
   `LIVE_CHANNELS`'s shared stamping path) after tracing
   `ARCHETYPE_OWNED_AXES`'s own deliberate exclusion of temperature (*"a
   sky is not a climate"*) — a temperature drag must not stamp
   `weatherArchetype:'custom'` and wrongly un-light an active mood chip
   over an edit unrelated to which archetype is active.

*Verification note: `npx eslint`/`npx prettier --check` clean on all six
touched files (two more rounds of this session's own recurring
backtick-inside-CSS-comment trap hit and fixed — `shell.js`'s
header-right/chip-grid comment and its GO-button redesign comment, both
re-checked via a full-file backtick grep against the template literal's
span). `node tools/run-tests.mjs`: 27 suites, 11512 passed, 0 failed,
unchanged — no test-covered logic touched, this round is DOM/CSS plus two
new ctx passthroughs. `node tools/verify-structure.mjs`: the same two
pre-existing violations only (`no-gpu-readback` in
`vision-mask-render.js`, `time/one-clock` at 41/38); confirmed via `git
diff` that every new `boot.js` line this round is a comment or an addition,
none matching either violation. Live-verified in the browser via
`tools/remote-preview/`: mood-chip pending/arrival cycle, sun-behind-pill
DOM order, FPS blend across the harness's sine-sweep fixture, the GO
button's zero-animation computed style, the rewritten checkbox copy, and
the new Temperature slider all confirmed as described above. **Not
verified: the author's own live Foundry session**, same standing gap as
P21–P29. The concurrent water-flow session's own files remain completely
untouched, confirmed via `git status --porcelain` before staging.*

---

**P31 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; an autonomous-loop
tick continuing the parity work — no new author message since P30, acting
on the standing "keep working on the UI, keep pushing things forwards"
instruction, picking a well-scoped item off the open gap list rather than
wind editing/ring time-stops, both of which explicitly need the author's
own design call per P29/P30's own notes).** Went looking at the old
astrolabe.js's own real, already-working Almanac forecast — a
`forecastRow` + `surpriseRow` pair, never ported to the new Remote at all.

1. ⚠️ **A NAMING COLLISION THIS TESTAMENT ALREADY WARNED ABOUT, confirmed
   the hard way.** The old panel's own visibility gate reads
   `s.weatherMode !== 'almanac'` — and `almanac` here is `world/weather.js`'s
   WALK-mode string (Director/Almanac, i.e. this session's own Direct/Drift),
   completely unrelated to `astrolabe-panel.js`'s OWN `CLOCK_MODES`
   `'almanac'` posture (Aesthetic/Follow/Almanac). Almost gated the new
   forecast row on the Clock-mode control before tracing `weatherMode`'s
   real origin through `weather-board.js`'s own header comment (*"NAMING:
   the persisted value is `weatherMode: 'director'|'almanac'`... unrelated
   to the Testament's OWN later cutscene 'Director'"*) and confirming
   `world/weather.js#forecast()`'s own first line-of-code gate is
   `currentMode !== 'almanac'` — the SAME weather-walk mode, not the clock.
   Gated correctly on `ctx.getWeatherMode() === 'almanac'` (Drift), the
   file's own established `renderPace()` gate.
2. **`ctx.getForecast()` (boot.js) is a zero-new-engine-work read** —
   `weather.forecast()` (world/weather.js) already projects the walk
   forward for free by cloning the live RNG, and
   `getVtPanViewerTimeDialState()` already surfaces its next transition as
   `weatherForecastNext` (`vt-pan-viewer.js`, built for the OLD panel's
   Almanac slice) — the SAME door `getCloudPinned` already reaches through
   for a different field. No new plumbing between the engine and boot.js at
   all, only a UI surface that was never built.
3. **`weather-board.js#renderForecast()`** — a faithful port of the old
   panel's own `paintForecast` wording (*"Forecast: → {icon} {label} in
   {eta}"*, `"steady for now"` when null, the <1h-vs-hours ETA split),
   deliberately preserving its one small imprecision rather than silently
   "fixing" it: `forecast()` returns the identical `null` for "genuinely
   steady" and for "not available at all" (e.g. no climate chosen yet) — the
   old panel never distinguished the two either, so this doesn't invent a
   distinction the underlying data can't back.
4. ⚠️ **THE SURPRISE-ME TOGGLE TRIPPED `ui/canon-only`'s OWN RATCHET ON
   FIRST BUILD, caught by the verification pass, not shipped blind.** First
   built as a hand-rolled `input.type='checkbox'` (matching the old panel's
   own vanilla-DOM code almost verbatim) — `node tools/verify-structure.mjs`
   immediately flagged it: 14 violations against a bound of 13. Re-read the
   wall's own carve-out (*"a one-off UI choice... is not a param and does
   not need it"*) and judged "surprise me" does NOT qualify — it is a
   persistent-looking toggle a GM revisits every session, not a filter or a
   preset pick. Rebuilt through the SAME `buildParamControl` door the
   Scene-override checkbox already uses. Its own `row()` is a full-width
   flex element with several properties set as INLINE styles (`styled()`'s
   own `Object.assign(el.style, ...)`) — fighting those from a stylesheet
   class would need `!important`; stacked it as its own line below the
   forecast text instead, the same one-control-per-row shape every other
   control in this file already uses, not a special case squeezed inline.
5. ⚠️ **TWO MISSED CALL SITES, caught live, not by reading the diff.** The
   first live test showed "Forecast: steady for now" even after clicking a
   real climate chip — `renderForecast()` had only been wired into
   `directBtn`/`driftBtn`/`refresh()`, not either of the two places a biome
   selection itself happens (the favourites chip's own click handler, and
   the weather-picker's `onPickBiome`). Exactly the shape P27's own
   Direct/Drift `renderFaders()` gap took — the mode toggle isn't the only
   thing that changes what should be on screen. Both sites now call
   `renderForecast()` too.
6. **`tools/remote-preview/preview.js`'s own fixture caught itself failing
   quietly.** First fixture used `archetypeId: 'storm'` — not a real id
   (`world/weather-data.js`'s table uses `'thunderstorm'`) — so the archetype
   lookup silently fell through to its own raw-id fallback, rendering
   `"Forecast: → storm in ~3.5h"` with no icon and the wrong case instead of
   `"⛈ Storm"`. Caught by reading the live DOM text after clicking a climate
   chip, not assumed correct because the code looked right. Fixed to a real
   id, honestly commented as a static demo (this harness doesn't run the
   real RNG walk).

*Verification note: `npx eslint`/`npx prettier --check` clean on all four
touched files. `node tools/run-tests.mjs`: 27 suites, 11512 passed, 0
failed, unchanged — no test-covered logic touched, this is DOM plus one
read-only ctx passthrough. `node tools/verify-structure.mjs`: the same two
pre-existing violations only — `ui/canon-only` confirmed back at its
existing bound (13) after the buildParamControl rebuild, not silently left
broken. Live-verified in the browser via `tools/remote-preview/`: Direct
mode shows no forecast row at all; Drift mode with no climate chosen reads
"Forecast: steady for now"; picking a climate (either the favourites chip
or the Browse picker) updates it to "Forecast: → ⛈ Storm in ~3.5h" real
icon+label formatting confirmed via DOM read, not screenshot guessing;
Surprise me toggles the text to "🎲 —" and back; switching back to Direct
removes the whole block cleanly (confirmed `.msa-wx-forecast-text` is
`null` in the DOM, not just visually hidden). Console clean throughout.
**Not verified: the author's own live Foundry session**, same standing gap
as P21–P30. The concurrent water-flow session's own files remain
completely untouched, confirmed via `git status --porcelain` before
staging.*

---

**P32 — filed by Claude Sonnet 5, 2026-08-18 (worker tier; a live author
report, and the biggest single gap this whole campaign has found).**
Verbatim: *"I'm happy for you to make the calls and continue the work. We
need to get rid of the old UI and replace it entirely with the new one.
That's the goal, work towards that. Ideally the vertical sliders would
appear soon. Still no studio for editing effects. That's something very
important to get right."* This petition covers the Studio half; vertical
sliders is a separate, smaller, still-open ask (see the report to the
author for the honest split).

1. ⚠️⚠️ **"STILL NO STUDIO FOR EDITING EFFECTS" WAS LITERALLY TRUE.**
   `MapShine.__studio.registerEffectCard` — the ONLY door
   `effects-department.js`'s real, working, schema-driven card renderer has
   — had exactly ONE call site in the whole of `boot.js`: water. Every
   other one of the 15 registered effects had ZERO cards in the Studio.
   The toolbar button, the room shell, the department rail, the card
   renderer itself — all real, all already shipped across U0–U1 — but the
   one thing that actually needed to happen every effect, one at a time,
   never did past the single effect (water) that doubled as U6's own
   worked example. Confirmed by grep before writing a line of new code, not
   assumed from the author's report.
2. **A dedicated research pass** (general-purpose agent, full read of
   `effect-controls.js`, `effects-department.js`, all 15
   `effectRegistry.register(...)` sites, all 20 `registerPanel(...)` sites,
   every manifest's `authoring.paint`) mapped the real shape of every
   effect's existing OLD-panel wiring before any new code was written.
   Headline finding: **all 12 missing panels are schema-driven via the
   exact same `buildEffectCard({...})` water itself uses — there is no
   bespoke panel among the 15 registered effects**, only small add-ons
   (presets, debug-channel selects, specular's 3 shimmer-layer strips) and
   candle/lightning's anchor-placement flow, which sits structurally
   outside `buildEffectCard` entirely.
3. **`registerSimpleEffectCard(id, opts)` (boot.js, new)** — a shared
   factory for the common shape (schema + getValue/onChange off one live
   readout + an enable toggle + a mask row/paint button DERIVED from the
   same manifest `paintAffordance` already reads, never a second lookup
   that could disagree with it + optional presets), written once so ~10
   near-identical ~15-line blocks can't drift the moment one gets a fix the
   others don't. Registered: candleFlame, lightning, fire, vegetation,
   bloom, depthOfField, sunShadows, grade, fluid, specular, window,
   apertureGobo — 12 real, working, live-editable cards, joining water for
   **13 of 15** registered effects now genuinely editable in the Studio.
4. ⚠️ **CAUGHT BY THE WALL, NOT BY EYE: the helper's first draft
   reintroduced the exact captured-readout bug `panels/no-captured-readout`
   exists to catch** (`const readout = opts.getReadout(); ... getValue: (k)
   => readout.params?.[k]`) — a real regression, not a false positive: the
   Studio's own department only re-renders on department-switch/filter/
   pin/pop-out, not on every external change, so a param edited from
   elsewhere (the old panel, the console) while a Studio card sat open
   un-rerendered would have gone stale in `getValue` exactly the way the
   wall's own history describes. Fixed to the wall's own prescribed shape:
   `readLive` stays a live accessor, called fresh at `getValue`'s own call
   site, never captured into a shared local first.
5. **Two effects declared in `effectRegistry` have NO old-panel presence
   at all — `uiWindowShadow` and `doorGraphics`** — confirmed by the same
   research pass (exhaustive `registerPanel`/`registerSelect` search, zero
   hits for either). Both are otherwise fully wired (real schemas, real
   `MapShine.setUiShadow`/`setDoors` console setters) — genuinely NEW UI,
   not a port, and deliberately NOT built this round: the author's own
   words named this round "editing effects," and inventing two brand-new
   cards with no prior UI to port risks a real design decision (fields,
   defaults, whether either even wants FOH exposure) nobody asked for yet.
   Left named, not silently dropped.
6. ⚠️ **Three honest omissions, named rather than silently shipped:**
   - **`health` is absent from all 12** — `getParamHealth(id, schema)`
     only means something once `wrapForReadTracking` marks that effect's
     params read at its real render seam; today only water's does.
     Passing it here would show a false 100%-orphaned reading for effects
     that render correctly every frame — worse than the badge's own honest
     "planned" default this omission leaves standing.
   - **`tier` is partial (bare `perfTier` only) for the effects that
     capture it at all (candle/lightning/fire/vegetation/sunShadows), and
     absent for the rest** — `maxPerfTier`/`perfTierSource` are captured
     nowhere today, including water's own already-shipped card. A real,
     scoped follow-up (touches each readout's own capture site), not a
     blocker for shipping real param editing now.
   - **Specular's own 3 independent shimmer-layer strips
     (`SPECULAR_LAYER_PARAMS` applied against `specular.getLayers()[0..2]`
     via `MapShine.setSpecularLayer(i, ...)`) are NOT ported** — one schema
     applied to three live value sets doesn't reduce to this card's flat
     shape, and `EffectCardModel` has no repeated-group field to hold it.
     Its 5 core `fohKeys` shipped; the layer strips are a named, scoped
     follow-up. Same story for window/specular/apertureGobo's own
     debug-channel `<select>` add-ons — no `EffectCardModel` field exists
     for them yet, deferred rather than forced into an ill-fitting one.
7. **`enterCandlePlacement`/`enterLightningPlacement` hoisted** out of
   `buildCandlesPanel`/`buildLightningPanel` (the old panel's own builders)
   to shared, `install()`-level closures — every reference inside either
   function (`anchorAuthority`, `activeFloorContext`,
   `addCandle`/`updateCandleAnchor`/`removeCandleAnchor`,
   `buildCandleEditForm`, and lightning's own equivalents) was ALREADY a
   shared closure, not local to the old panel's builder, so this changes
   nothing about the old panel's own behaviour — it just gives the new
   Studio cards' own `onPaint` a real function to point at instead of a
   second, drifting reimplementation. Candle/lightning declare no
   `authoring.paint` at all (anchor-placed, not painted), so
   `registerSimpleEffectCard`'s own generic mask-derived `onPaint` would
   silently do nothing for them — both supply `onPaint` explicitly instead.
8. **`effects-department.js` gained one real field: `paintVerb`** — the
   paint button's tooltip was hardcoded `"Paint {title} on the map"`
   regardless of what `onPaint` actually does; correct for every mask-brush
   effect, actively wrong for candle/lightning's click-to-place anchors.
   `model.paintVerb` (default `'Paint'`, candle/lightning pass `'Place'`)
   fixes the wording without touching any already-shipped card's own
   behaviour — water's own button is untouched (`paintVerb` absent →
   defaults to the original text), confirmed via live DOM read, not
   assumed from the diff.
9. **`tools/studio-preview/preview.js` gained a third synthetic card**
   (candleFlame-shaped: schema + an anchor-style `onPaint` + `paintVerb:
   'Place'`) specifically to exercise the ONE new rendering path this round
   actually touched in `effects-department.js` — the existing water/bloom
   fakes already covered mask/presets/tier/plain-status rendering, so this
   was the one genuinely uncovered case, not a blanket re-test of
   everything.

*Verification note: `npx eslint`/`npx prettier --check` clean on all four
touched files (`boot.js`, `effects-department.js`,
`tools/studio-preview/preview.js`, plus the prettier auto-format the
preview harness needed after its own edit). `node tools/run-tests.mjs`: 27
suites, 11510 passed, 0 failed — the −2 versus the prior round's 11512 is
the CONCURRENT water-flow session's own uncommitted test-count drift,
confirmed via `git status --porcelain` showing those test files dirty
under a session that never touched `boot.js`/`effects-department.js`, not
anything this round did. `node tools/verify-structure.mjs`: two rounds —
first caught `panels/no-captured-readout` (item 4 above) as a genuine new
violation, fixed, re-ran clean back to the same two pre-existing
violations only (`no-gpu-readback`, `time/one-clock` at 41/38).
Live-verified via `tools/studio-preview/` (`node tools/shader-lab/serve.mjs`
→ `http://localhost:8934/tools/studio-preview/index.html`, DOM-read
verification throughout — this pane's own screenshot tool timed out again,
same standing limitation as prior rounds; one CONSOLE ERROR appeared and
was confirmed STALE by the session's own established test (navigating to a
bare directory listing still showed the identical error, alongside an
unrelated 404, proving it survives navigation and is tooling residue, not
current): all three studio-preview cards (water, bloom, candleFlame)
render; candleFlame's paint button reads "Place Candle flames on the map"
while water's unchanged button still reads "Paint Water on the map"; the
candleFlame slider commits a dragged value end to end through the same
`buildParamControl`/`buildRangeRow` widget every other card already uses;
water's own mask row (`_Water`) and preset list
(CalmLake/RagingRiver) render unchanged, confirming the `effects-
department.js` edit didn't regress the two already-shipped fakes. **What
this rung structurally CANNOT verify: boot.js's own 12 new
`registerSimpleEffectCard` registrations themselves** — the studio-preview
harness mounts `installStudio()` directly with its own synthetic models,
never boot.js's real `install()`, so the actual closures
(`candleReadout`, `MapShine.setFire`, `maskAuthority.authoredStatus`,
etc.) have not run anywhere outside a careful manual re-read against the
research pass's own findings. **Not verified: the author's own live
Foundry session** — the standing gap for this entire campaign, P21–P31,
and the one that matters most for this specific round given point above.
The concurrent water-flow session's own files remain completely untouched,
confirmed via `git status --porcelain` before staging.*

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
