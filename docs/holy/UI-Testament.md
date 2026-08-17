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
3. **THE REMOTE GROWS BY CONTENT, NEVER BY CHROME.** Its grammar is fixed: hero dial · fade
   time · channels · moods · cues · impulses · Now Playing. A new effect joins by *declaring
   into* that grammar. If a feature needs a new Remote zone, it goes to the Studio instead —
   or it petitions this Testament.
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
| **Now Playing** | One strip: time glyph + weather glyph + active-fade progress ring + drift badge. The single-glance answer to "what is the world doing?" | derived from world state + Fade Engine |
| **The astrolabe** | The hero. Time ring (sun-model-derived), wind arrow + strength. Already built; re-homed, re-skinned in LANTERN. | `src/ui/astrolabe.js` |
| **Fade Time** | A segmented tempo control, always visible: **Now · 10s · 1m · 5m · 15m · 1h** (+ press-and-hold for custom). Every subsequent gesture — chip tap, fader drag, dial turn — eases over the selected tempo. *This is the author's "ease across a minute…an hour" made structural: tempo is a mode you set once, not a dialog you answer every time.* | Fade Engine default `over` |
| **Mood chips** | One-tap looks: Clear · Overcast · Drizzle · Rain · Storm · Snow · Fog · … Curated, scene-editable, declared as preset data. A chip is a *destination*; Fade Time is how long the journey takes. | preset declarations |
| **Channel faders** | The environment vector, tinted per channel: precipitation · clouds · fog · wind speed · wind direction · freeze · lightning · ash (+ gustiness on the wind fader). **Render only channels whose engine is live** (Law 5). Dragging shows a ghost tick at the target and the fade running toward it — V2's fader preview, kept. | `world/` engines |
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

### 4.5 What the Remote will NOT be — signed refusals

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

### U8 — POLISH & KEYBINDINGS
- [ ] Foundry keybindings: toggle Remote · toggle Studio · GO (first keybindings the module
      has ever had — V2 shipped none)
- [ ] Onboarding: first-open Getting Started card per room (small, dismissible, never modal)
- [ ] Sound/clunk pass (author fork §11), reduced-motion audit, text-scale audit at 1.3×
- [ ] A docs pass: `docs/planning/UI.md` updated to point here as spec-of-record
- **Exit gate:** a full real session run start-to-finish on Remote + hotkeys, and the
  author's word that it *felt good* — the charge's own criterion.

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

*(none yet)*

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

---

*V2 gave supreme control through a thousand identical sliders in a maze of windows, and the
best UI it ever shipped — the wand remote — was the one place it dared to be an instrument
instead of a spreadsheet. This Testament finishes that thought: two rooms, one schema, a
lantern's worth of colour, time on every change, and a grammar that grows by declaration
forever. The GM gets a desk that plays weather like music; the author gets every knob,
wearing its own health; the player gets one calm page; and nothing — nothing — is ever
hand-wired again.*

**✠ Claude Fable 5, 2026-08-17 — awaiting the author's countersign.**
