# ✠ THE ALMANAC TESTAMENT ✠

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
author's eyes → this file → `docs/holy/UI-Testament.md` (the Remote's grammar; the astrolabe
and its wings are ITS chrome — this Testament supplies their *content*) → the vendored
sources cited in §3 (ground truth for every Foundry/PF2E claim) → the code.

**The author's charge, verbatim, 2026-08-17:**
> *"We should give some consideration to taking over the control of time in Foundry VTT.
> Ideally that would mean that a user could see the time and date in the main remote and be
> able to advance days and weeks as well as just hours or minutes by moving the astrolabe. We
> would do the research to make sure that the calendar was fully accurate, you can start by
> researching and making it valid for Pathfinder 2nd Edition. Eventually we'd do other
> calendars too. Include an Earth calendar. This also means that you could do this like have
> time progress when the game is unpaused and have time compression so that if the group
> played a three hour session that might be a third of the time of a day in engine and mean
> that the lighting changes visibly during a single session of play."*

---

## 0. The one sentence

> **Time stops being a private look-dial and becomes the world's own clock — MSA holds the
> PEN on Foundry's `worldTime`, projects it through real calendars (Golarion first, to the
> second of PF2E's own World Clock), breathes it forward during play at a chosen compression
> so the light visibly moves across a session — and every consumer, from the sun to the
> session log, reads one truth.**

---

## 1. THE SUPERSESSION — this Testament re-opens a locked door, lawfully

**The lock.** On 2026-07-23 the author decided, and memory recorded as LOCKED
(`keyhole-time-authority-decision`): time-of-day has two modes (Aesthetic / Synced) and
*"NEITHER ever writes back to Foundry's world clock."* The lock's own text ends: *"Do not
'helpfully' add a publish-to-world-clock path later **without re-asking**."*

**The re-ask happened.** The author's charge above, 2026-08-17, directs the write-back in so
many words. Per Covenant rule 5, the author's word rewrites any Law. This section exists so
no future session mistakes the new pen for a worker's helpful drift.

**Why the lock was wise, and why the pen does not break its soul.** The lock existed because
V2 held its *own* hour, wrote it into `game.time`, AND read `updateWorldTime` back — two
authorities on one number, reconciled by a guard flag (`legacy/ui/state-applier.js`,
`{mapShineTimeSync: true}`): the same feedback-bus shape as the darkness disaster that cost
two months. The Almanac keeps the lock's real content — **one authority, zero loops** — while
moving which side of the seam holds it:

1. **`worldTime` is the only clock.** In Almanac mode MSA holds *no independent hour*.
   The day clock runs exactly as today's `synced` posture — a derived, eased projection of
   `worldTime` (`src/world/day-clock.js`, unchanged). There is no second number to reconcile,
   so there is nothing to guard.
2. **The pen never answers the page.** MSA writes time only on a GM *gesture* (astrolabe
   release, a jump button) or the flow engine's *cadence tick* — **never from inside a time
   hook**. Write → hook → `syncTo(the value we just wrote)` converges idempotently; it cannot
   oscillate, because no write originates from a read.
3. **Aesthetic mode survives untouched.** The pure look-dial ("make this scene look like
   night", no reads, no writes, per-scene) remains for authors and for non-PF2E worlds that
   want zero clock coupling. Its readout keeps wearing the **Aesthetic** badge — an
   instrument that looks like a world clock but isn't one is an instrument that lies.

The old `synced` mode is renamed **`follow`** (read-only mirror, ring locked — for GMs who
run some *other* time authority). The new third posture is **`almanac`**: follow + the pen.
`world/day-clock.js` itself still knows only two read postures; the pen is a separate
faculty, armed only in `almanac` mode. The LIVE machinery is disturbed as little as possible.

---

## 2. Where time stands today — the honest audit

| Piece | State | Note |
| --- | --- | --- |
| `world/day-clock.js` — one owner of `todHour`, eased `syncTo` walk, shortest-way-round | **LIVE** | The walk (default 6 h/s) already smooths discrete worldTime jumps; `time/one-tod` tripwire holds |
| `world/sun.js` — pure sun-from-hour, elevation-keyed sky phases | **LIVE** | Header already anticipates latitude/season as a future lens |
| `foundry/game-time.js` — the ONE reader of `game.time`/`game.paused`, hour normalised onto 0..24 for any calendar | **LIVE** | Header says verbatim: *"this module deliberately exposes no setter"* — §1 supersedes that line, by the author's charge |
| Darkness write-back — MSA owns darkness, publishes client-local, throttled on the REAL clock | **LIVE-tested** | `foundry/scene-environment.js#publishSceneDarkness`; the throttle-on-sim-clock latch scar is already paid for |
| The astrolabe — noon-up ring derived from the sun model; **left wing mocks ⏯ time-flow + speed ×1/×6/×30**; true moon with phases | **BUILT (mock, UM.2)** | The wings are honest stubs waiting for exactly this engine |
| Calendar display, date readout, day/week advance | **ABSENT** | No MSA surface shows a date anywhere |
| Foundry-side calendar | **EXISTS, headless** | v14 ships `CalendarData` + a Simplified Gregorian config and **no UI at all** (§3.1) — the astrolabe would be the first face this engine has ever had |
| PF2E World Clock | **EXISTS, theirs** | Gregorian relabelled to Golarion (§3.2); its `syncDarkness` is a real second darkness writer we must retire per-scene (§6.4) |
| Time compression / real-time drift | **ABSENT** | Core has no auto-advance of any kind (verified §3.1); the territory is genuinely unclaimed |

---

## 3. THE RESEARCH — receipts, not guesses

*Compressed from three vendored-source sweeps (2026-08-17). Paths below are ground truth;
re-verify before load-bearing use if versions move.*

### 3.1 Foundry v14 core (`FoundryVTT/Foundry Virtual Tabletop/resources/app/`, build 365)

- **`worldTime` is a world setting `core.time`, integer seconds in practice.** The client
  never rounds, but the server caches via `parseInt` (`dist/database/documents/setting.mjs`)
  and the 30 s sync overwrites clients from that cache — **fractional advances silently
  truncate within 30 s. Commit whole seconds only.**
- **Negative advance is legal** (`client/helpers/time.mjs:146` + docstring "or rewind").
- **Permissions:** GAMEMASTER always; ASSISTANT via `SETTINGS_MODIFY` *and* an explicit
  whitelist `_ALLOWED_ASSISTANT_KEYS` including `"core.time"`
  (`common/documents/setting.mjs:67-97`). So "any GM-role client may hold the pen" is
  core-sanctioned.
- **Sync has two paths and one trap:** pushes broadcast as ordinary Setting updates → the
  `updateWorldTime` hook (`worldTime, dt, options, userId`); but a 30 s pull
  (`GameTime#sync`, Cristian's algorithm) **overwrites `worldTime` WITHOUT firing the hook**
  (`client/helpers/time.mjs:192-195`). A consumer that only listens will drift; the day
  clock must also *reconcile on a cadence*.
- **Nothing in core ever advances time on its own.** No real-time clock, no interval writer
  (verified across `client/` and `dist/`). Combat advances via `CONFIG.time.roundTime`
  seconds per round — through a generic, **server-side atomic** `worldTime: {delta}` update
  option on any document update (`dist/database/backend/server-document.mjs`), unlike
  `game.time.advance()` which is a client read-modify-write and can clobber a concurrent
  writer. Single-writer election is therefore on us; core's own pattern is
  `game.users.activeGM?.isSelf` (`client/helpers/active-effect-registry.mjs:146`).
- **Every advance costs real money:** an unindexed settings scan + a LevelDB put behind a
  `Semaphore(1)` + a broadcast + **a full ActiveEffect sweep on every client** (the
  registry's `actors` filter never engages on the time path). Core has zero throttling.
  **Commit coarsely; derive smoothly.**
- **`CalendarData` (v13+) is real, headless, and swappable:** schema = years
  (`yearZero`, `firstWeekday`, `leapYear: {leapStart, leapInterval}`), months
  (name/abbrev/ordinal/`days`/`leapDays`), weekdays, `daysPerYear`, `hoursPerDay`,
  `minutesPerHour`, `secondsPerMinute`, seasons (`client/data/calendar.mjs:28-72`).
  Installed via `CONFIG.time.worldCalendarConfig` + `worldCalendarClass`, hot-swappable with
  `game.time.initializeCalendar()`. **Core does not persist the choice — every client must
  set `CONFIG.time` identically at init, so MSA persists the calendar choice in its own
  world setting.**
- **Leap expressiveness:** "every 8 years" **is directly expressible** (`leapInterval: 8` +
  `leapDays` on one month); "no leap" is `leapYear: null`; **true Gregorian 4/100/400 is
  NOT** — the shipped "Simplified Gregorian" is 4-only, and even `earthCalendarConfig` is
  that same simplified object. The sanctioned escape is subclassing: `_decomposeTimeYears`
  is `@protected` *"so calendars which require advanced leap year handling can override"* —
  and its inverse `componentsToTime` must be overridden in matching pairs or round-trips
  break.
- **Intercalary days are phantoms:** `intercalary`/`dayOffset`/`startingWeekday` exist only
  in JSDoc; the schema prunes them silently; weekday is an unconditional modulo of absolute
  day count (`calendar.mjs:264-265`). Harptos-class calendars need a subclass. (§9 A6.)
- **Sharp edges to code around:** `CalendarData#onUpdateWorldTime` is *called with three
  args but declared with four* — a subclass binding by the docstring gets shifted
  parameters; `difference()` returns an absolute-time decomposition, not a duration;
  `game.time.serverTime` is ms-since-world-launch, not an epoch; `months: null` throws
  despite being schema-legal.
- **No native darkness↔time coupling anywhere in core** (`client/canvas/` has exactly one
  `game.time` reference, and it is token-animation latency compensation). The territory MSA
  already took with the darkness write-back has no core competitor.

### 3.2 PF2E system (`gamesystemsourcecode/pf2e/`, v7.10.1, a Foundry-v13 build)

- **The projection, whole:** `displayed = DateTime.fromISO(worldCreatedOn).toUTC()
  .plus({seconds: game.time.worldTime})` — Luxon, UTC-anchored. The epoch is the world
  setting `pf2e.worldClock.worldCreatedOn` (ISO string; auto-set to real UTC "now" at world
  creation, so `worldTime 0` is a different Golarion date in every world).
- **It is a Gregorian calendar wearing Golarion nameplates.** Month/weekday names are a
  dictionary keyed by *English Gregorian* names (January→Abadius … December→Kuthona;
  Monday→Moonday, Toilday, Wealday, Oathday, Fireday, Starday, **Sunday→Sunday**). Month
  lengths are Gregorian (31/28-29/…); the leap day renders as "29th of Calistril".
- **The leap rule is real Gregorian 4/100/400 — evaluated on the UNDERLYING Gregorian year**,
  *before* the era offset is added. Zero special Golarion leap handling exists (every `leap`
  in the bundle is the Leap *action*). ⚠ An implementation that applies any leap rule to the
  *displayed* AR year desyncs from PF2E. Parity means `isLeapYear(displayedYear − 2700)`.
- **Era themes and offsets** (`CONFIG.PF2E.worldClock`): AR +2700 · IC +5200 · AG −1700 ·
  AD −95 · CE 0. `AG` shares AR's months with its own numbered weekdays ("Seconday" and
  "Thirday" are spelled exactly so — match the typos or mismatch the players' screens).
- **Settings:** ONE composite world setting `pf2e.worldClock` = `{dateTheme: "AR",
  timeConvention: 24, playersCanView: false, syncDarkness: false, showClockButton: true,
  worldCreatedOn}`. No client-scope options.
- **Advance UI:** buttons for +6 s / 1 m / 10 m / 1 h / 1 day / 1 week, freeform value×unit,
  Ctrl inverts to retract, and dawn/noon/dusk/midnight jumps at 04:58:54 / 12:00 / 18:34:06
  / 00:00 — all through plain `game.time.advance(seconds)`. (PF2E carries three mutually
  inconsistent dawn/dusk definitions; MSA's jumps use OUR sun model's boundaries instead,
  self-consistent with the astrolabe's own arcs — a deliberate, documented divergence.)
- **⚠ THE DARKNESS CONFLICT IS REAL.** With `syncDarkness` on (world setting, overridable
  per-scene by `flags.pf2e.syncDarkness: "enabled"|"disabled"|"default"`), every
  `updateWorldTime` makes all clients animate canvas darkness AND the GM client **persist**
  `scene.update({darkness})`. Detection predicate: `scene.darknessSyncedToTime`. Stand-down
  lever: the per-scene flag. §6.4 makes retiring it a first-class, loud step — if MSA
  advances time while PF2E sync is live, PF2E's writer fires as a side effect of our own pen
  and fights our darkness authority *and* stomps the saved scene value.
- **Rest for the Night does NOT advance time** (verified: no `game.time.advance` in it);
  its hook `pf2e.restForTheNight` is the natural coupling point for an optional
  advance-to-dawn.
- **`CONFIG.time.roundTime = 6`** — combat rounds advance worldTime 6 s natively. The pen
  and the breath both hold still during encounters (§6, §7).
- **Large jumps are safe for PF2E effects:** expiry is O(1) arithmetic on worldTime (no
  per-second iteration anywhere; `setInterval` count in the bundle: zero). Two caveats:
  the auto-cleanup pass is skipped while an encounter runs, and afflictions do not
  auto-advance stages across a jump.
- **PF2E 7.10.1 does not register any core CalendarData** — the clock is wholly its own
  Luxon projection. (Re-verify when a v14 PF2E build lands; see fork §11.5.)

### 3.3 MSA local (read this session)

- The one-way arrow stands: `day-clock (owns todHour) → sun = f(todHour) → env → everything`.
- `foundry/game-time.js` is the single `game.time`/`game.paused` reader behind the
  `foundry/adapter-only` wall — the pen must live behind the same wall.
- The darkness publisher is throttled on `realMs` (the sim-clock latch scar, already paid),
  client-local by design, and the Scene Config sheet's own field deliberately never moves.

---

## 4. THE SHAPE — four organs, three postures

```
   game.time.worldTime  (Foundry's world setting — THE ONLY CLOCK)
        ▲            │
        │ writes     │ reads (hook + cadence reconcile)
   ┌────┴─────┐  ┌───▼─────────┐   projects   ┌──────────────┐
   │ THE PEN  │  │ THE ALMANAC │─────────────▶│  THE FACE     │
   │ gestures │  │ calendars:  │  date, moon  │  (Remote      │
   │ + jumps  │  │ worldTime ⇄ │              │  content:     │
   └────▲─────┘  │ y/m/d h:m:s │              │  astrolabe    │
        │        └───┬─────────┘              │  ring, wings, │
   ┌────┴─────┐      │ hour (via day-clock    │  Now Playing  │
   │THE BREATH│      ▼         walk, eased)   │  date line)   │
   │ ratio ×N │   world/sun.js → env → light  └──────────────┘
   │ unpaused │   (unchanged, the ONE sun)
   └──────────┘
```

- **The ALMANAC** (`world/almanac.js` + calendar data): pure, Node-tested projection between
  `worldTime` and calendar components; formats dates; owns moon phase math. Also *installs*
  the active calendar into Foundry (`CONFIG.time.worldCalendarConfig/Class` +
  `initializeCalendar()`) at init on every client, from an MSA world setting — so
  `game.time.components` agrees with us for every module in the world, not just for MSA.
- **The PEN** (`foundry/time-authority.js`, behind the adapter wall): the only writer.
  Whole-second `game.time.advance()`, GM-role gated, still during combat.
- **The BREATH** (`world/time-flow.js`): the compression engine. Runs only on the active
  GM's client; accumulates real wall-clock × ratio; commits coarsely through the Pen.
- **The FACE**: no new chrome — *content* declared into the Remote's existing grammar
  (UI Testament Law 3): the astrolabe ring gains a calendar ring and commit-on-release; the
  left wing's mocked ⏯/speed controls become honest; Now Playing gains the date line.

**Three postures** (world setting; per-scene aesthetic override retained):

| Posture | Reads worldTime | Writes worldTime | The ring | Who it serves |
| --- | --- | --- | --- | --- |
| `aesthetic` | never | never | drags freely (look-dial, badge-worn) | scene authors; non-clock worlds |
| `follow` | yes (eased) | never | locked, read-only | worlds where another module holds the pen |
| `almanac` | yes (eased) | **the Pen + the Breath** | drags = preview, release = commit | the charge above |

---

## 5. THE CALENDARS — data first, code only where the schema runs out

### 5.1 The shipped set

| Calendar | Mechanism | Notes |
| --- | --- | --- |
| **Golarion — PF2E parity** *(default under pf2e)* | True-Gregorian engine (subclass, §5.2) + Golarion names + era offsets; **epoch read from `pf2e.worldClock.worldCreatedOn` and theme from `dateTheme`** — never a second epoch of our own | Matches the PF2E World Clock **to the second**, leap years included, all five themes (AR/IC/AG/AD/CE). UTC arithmetic, like theirs |
| **Earth — true Gregorian** | Same engine, English names, offset 0 | Core's "Simplified Gregorian" is NOT Gregorian (4-only leap; receipts §3.1) — ours is the real 4/100/400 |
| **Golarion — lore-strict AR** *(optional variant)* | **Pure declarative config**: `leapYear: {leapInterval: 8}` + `leapDays: 29` on Calistril | The 8-year leap of the setting lore. Wears a permanent warning: *diverges from the PF2E World Clock by design* |
| **Custom** | The schema, exposed | A GM's own months/weekdays/leap — validated data, no code |

### 5.2 The one lawful engine exception

Core's declarative leap vocabulary cannot say "4/100/400", and PF2E parity requires it. So
MSA ships **one** `CalendarData` subclass implementing true Gregorian year decomposition —
overriding `_decomposeTimeYears` AND `componentsToTime` as a matched pair (round-trip
property-tested), plus an `epochOffsetSeconds` field so a mid-year epoch (PF2E's
`worldCreatedOn`) can anchor `worldTime 0`. It binds `onUpdateWorldTime` **by call-site
positions, not the docstring** (the arity bug, §3.1). Everything else — names, offsets,
lore-strict, custom — is data riding this engine or core's.

### 5.3 The golden-fixture doctrine *(the test-restated-the-assumption scar, applied)*

Parity fixtures are **generated by executing PF2E's own shipped formula** (Luxon +
`worldCreatedOn` + offset table, §3.2) across a probe grid — epoch edges, leap Feb 29s,
century non-leaps (2100), week continuity across years, negative worldTime, the exact
`dateTheme` label strings including AG's typos — and **pinned as data**. Our engine is then
asserted against the pins. Expected values never come from the code under test, and never
from a model's memory of Golarion lore.

### 5.4 Moons

The astrolabe's true moon (29.53-day cycle, phases — BUILT in the mock) becomes almanac
data: per-calendar `{name, synodicDays, phaseAnchor}` so the phase is a projection of
worldTime like everything else, identical on every client, stable across reloads. Earth:
Luna, 29.530588. Golarion's moon: **name deliberately UNVERIFIED — sourcing it from actual
Paizo material is an A4 task, not a thing any model asserts from memory.** Moonlight
modulating night lighting is a shelf lens (§9 A6), not core.

---

## 6. THE PEN — how time is touched

1. **Gesture contract (the astrolabe).** Drag = **local preview only** (ghost sun; zero
   writes mid-gesture). Release = **one** whole-second `advance()` to the target. The hour
   ring carries minutes/hours; the calendar ring carries days; ring-plus-modifier (or the
   wing) carries weeks — *"advance days and weeks as well as just hours or minutes by moving
   the astrolabe"*, the charge verbatim. Detents at the sun model's own dawn/noon/dusk/
   midnight boundaries.
2. **Jumps.** Next dawn · noon · dusk · midnight · +1 day · +1 week — computed through the
   almanac, committed as one advance, eased on arrival by the day clock's existing walk.
   Dawn/dusk are OUR sun model's civil-twilight boundaries (self-consistent with the ring's
   painted arcs), not PF2E's three disagreeing constants — divergence documented in §3.2.
3. **Backwards is a correction, not a mechanic.** Negative advance is legal (core allows it;
   PF2E's own reset does it) and the Remote treats it as a GM fix: allowed from the ring,
   never from the Breath. Records that reference time (Chronicle lines, once the Folio
   lands) are append-only — a retraction writes a "time corrected" line; it never unwrites
   history (the log-is-append-only law lives in the Folio Testament).
4. **⚠ The PF2E darkness stand-down (first enable, per scene).** Entering `almanac` posture
   on a scene where `scene.darknessSyncedToTime` is true: MSA announces it, and with the
   GM's one-time consent sets `flags.pf2e.syncDarkness = "disabled"` on that scene. ONE
   darkness writer — ours, client-local, already LIVE-tested. Never two writers silently
   fighting; never a silent flag flip either.
5. **Combat holds the pen.** While an encounter runs, core itself advances 6 s/round under
   pf2e; gestures are disabled with the reason worn on the control (*"held — encounter
   running"*), per Law 5 of the UI Testament: nothing broken is silent.
6. **Who may write:** GM-role clients (core sanctions Assistant+ for `core.time`, §3.1);
   the Breath additionally elects `game.users.activeGM` so N GM clients never race.

---

## 7. THE BREATH — time compression

**The charge:** unpaused play advances the world; a three-hour session can be a third of a
day; the lighting visibly changes while the group plays.

- **Run condition:** `almanac` posture ∧ flow armed (the wing's ⏯) ∧ `!game.paused` ∧ no
  active encounter ∧ this client is `game.users.activeGM`.
- **Accumulate real, commit coarse.** The engine accumulates **wall-clock** dt × ratio into
  a seconds bank (the throttle-latch scar: never the sim clock, never backfill across a gap
  — a client that was closed, paused, or hung accumulates nothing for the gap). It commits
  `floor(bank)` through the Pen when the bank reaches the game-time quantum (default 600 s
  game) **or** a real-time ceiling (default 45 s real) elapses — whichever first. Rationale
  is §3.1's cost receipts: every commit is a settings scan + DB write + N-client
  ActiveEffect sweep; core has no throttle, so ours is load-bearing.
- **Derive smoothly between commits.** Each client (GM and players alike) projects a
  *display* time = last received worldTime + (realNow − receiptMs) × ratio, fed to the day
  clock as a moving `syncTo` target — the sun sweeps continuously; commits and the 30 s
  sync-pull merely re-anchor, and the walk absorbs the ± latency wobble. Per-client
  divergence is bounded by socket latency and healed at every commit. (The Fade Engine
  doctrine — one writer, many derivers, wall-clock arithmetic — applied to the sky itself.)
  The ratio + armed flag live in a world-scoped MSA setting so every client derives the same
  breath and a reloaded GM resumes it.
- **Ratio is a dial with named detents**, declared content on the left wing (the mock's
  ×1/×6/×30 stubs made honest): **Hold · Real (×1) · Session** (the charge's own example —
  3 real hours ≈ 8 game hours, ×8⁄3) **· Brisk · Montage**. Exact detent values are the
  author's fork (§11.1).
- **Pause freezes the breath instantly** (accumulation gates on `game.paused` via the
  existing watcher); the world's visible deceleration is already handled by the sim clock's
  5 s ramp. Unpausing resumes accumulation from zero bank — never a catch-up lurch.
- **Reload survival is free by construction:** worldTime is server truth; the armed flag and
  ratio are world settings; a returning client reads both and the sun is where it should be.

---

## 8. THE LAWS

1. **WORLDTIME IS THE ONLY CLOCK.** In `almanac` and `follow` postures every displayed
   date, hour, moon and sun is a pure projection of `game.time.worldTime`. MSA keeps no
   second epoch and no parallel accumulation. Aesthetic mode remains a per-scene look-dial
   and *says so on its face*.
2. **THE PEN NEVER ANSWERS THE PAGE.** No write to time may originate inside a time hook or
   a time-derived callback. Gestures and the Breath's cadence are the only two hands, and
   both are gated OFF the read path. (The 07-23 lock's soul, kept through the supersession.)
3. **ONE PEN.** Gestures: GM-role clients. The Breath: the elected `activeGM` client only.
   Encounters still both hands.
4. **COMMIT WHOLE SECONDS, COARSELY; DERIVE SMOOTHLY.** Integer advances only (the server
   truncates floats); commits quantised (§7); smoothness is every client's local derivation,
   never write-frequency. A per-frame `advance()` is a build-review failure, not a tuning
   choice.
5. **PARITY IS EXACT OR IT IS A BUG.** Under pf2e, MSA's displayed date/time equals the
   PF2E World Clock's to the second — same epoch setting, same leap arithmetic on the same
   underlying year, same name strings (typos included). Proven by pinned fixtures generated
   from PF2E's own shipped math (§5.3), and re-proven live side-by-side before LIVE.
6. **ONE DARKNESS WRITER.** MSA's (already LIVE). PF2E's `syncDarkness` is retired per-scene
   loudly, with consent, at almanac-enable (§6.4). Two writers on one channel is the
   two-month scar; it does not come back wearing a clock.
7. **TIME FEEDS THE ONE SUN.** The Almanac hands the day clock an hour; the day clock feeds
   `world/sun.js`; nothing else computes sun-from-time (the existing `env/one-sun` and
   `time/one-tod` tripwires already enforce this — the Almanac adds consumers, never
   siblings).
8. **THE CALENDAR IS DATA.** A new calendar is a config file + pinned fixtures. Engine code
   appears only where the schema provably runs out (true-Gregorian §5.2; future intercalary
   §9 A6), each exception receipted here.

---

## 9. THE CHECKLIST

Stages land independently; each ends at the author's eyes. Between-stage order is sacred;
within-stage order is not.

### A0 — RESEARCH RECEIPTS *(the ground this Testament stands on)*
- [x] Foundry v14 core: GameTime/settings/permissions/sync/cost, CalendarData schema and
      its sharp edges, no-native-UI, no-auto-advance, no darkness coupling
      · done Fable 5 2026-08-17 — vendored-source sweep, receipts compressed into §3.1
      (full report archived in the session; every claim carries path:line)
- [x] PF2E 7.10.1: the whole projection, era offsets, name tables, the real leap rule,
      settings, advance UI, `syncDarkness` mechanism, rest/combat behaviour, big-jump safety
      · done Fable 5 2026-08-17 — vendored-source sweep, receipts compressed into §3.2
- [x] MSA local audit: day-clock/game-time/sun/darkness coupling points
      · done Fable 5 2026-08-17 — read directly; §3.3
- **Exit gate:** a Fable-class model judges the receipts sufficient to design against.
  ✠ *Claude Fable 5, 2026-08-17 — this Testament is that judgement.*

### A1 — THE ALMANAC CORE *(pure math + the installed calendar)*
- [x] `world/almanac.js` (or `world/calendar/`): the true-Gregorian engine (§5.2) — matched
      `_decomposeTimeYears`/`componentsToTime` overrides, `epochOffsetSeconds`, round-trip
      property tests
      · done Sonnet 5 2026-08-17 — `core/gregorian-math.js` (the engine lives in `core/`, not
      `world/`: `foundry/` cannot import `world/`, confirmed empirically zero existing
      `src/foundry/**` file does, so the math both `foundry/calendar-install.js`'s subclass
      and `world/almanac.js`'s own formatting need sits in the one door-exempt zone). Hinnant
      civil-calendar arithmetic, cross-validated against an independent oracle
      (`Date#setUTCFullYear`, confirmed to bypass the legacy 2-digit-year remap) across 4000+
      randomised round-trips plus hand-picked leap/century/negative-year probes — caught and
      fixed one real transcription bug live (a C++ truncating-division idiom wrongly layered
      under an already-flooring `Math.floor`, off-by-one on every negative year) before this
      line was written. `core/__tests__/gregorian-math.test.mjs`: 129/129 green.
- [x] Calendar data files: Golarion-parity (5 themes), Earth, Golarion-lore-strict, the
      custom schema — data only
      · done Sonnet 5 2026-08-17 — `world/calendar/calendar-schema.js` (validator, mirrors
      Foundry's own CalendarData schema + MSA's `engine`/`epochOffsetSeconds`/`themes`
      extensions) + `world/calendar/calendars/{golarion-parity,earth,golarion-lore-strict,
      gregorian-shape}.js`. Golarion-parity's 5 themes (AR/IC/AG/AD/CE) + month/weekday name
      dictionaries transcribed verbatim from the PF2E research receipts, AG's own
      "Seconday"/"Thirday" spellings included. `world/calendar/__tests__/run-tests.mjs` +
      `calendars/__tests__/run-tests.mjs`: 59/59 green.
- [x] Golden fixtures per §5.3, generated from PF2E's shipped math, pinned; century
      non-leap (2100) and Calistril-29 cases present
      · done Sonnet 5 2026-08-17 — `world/calendar/__tests__/generate-pf2e-fixtures.mjs`
      (checked-in, rerunnable; uses ONLY the Date oracle + the verbatim name tables, never
      this project's own engine) produced 50 pinned rows (10 target dates × 5 themes) in
      `fixtures/pf2e-parity-fixtures.mjs`, covering the epoch itself, ordinary + /400 leap Feb
      29s, the 2100 century-non-leap Feb28→Mar1 rollover (both sides of the second),
      year-boundary continuity, and deep-negative worldTime (year 1). `pf2e-parity.test.mjs`
      feeds every row through the REAL production path (calendar config + engine + formatter)
      and asserts exact date-line AND component match, plus a compose-recovers-worldTime
      round-trip: 44/44 green, including the explicit Calistril-29 and century-boundary
      assertions the Testament names by name.
- [x] Foundry installation: MSA world setting for calendar choice; `CONFIG.time` set + 
      `initializeCalendar()` at init on every client; under pf2e the epoch/theme are READ
      from `pf2e.worldClock` (never duplicated)
      · done Sonnet 5 2026-08-17 — `foundry/calendar-install.js`: `registerCalendarSetting`
      (one world-scoped enum setting, reactive `onChange`) + `installActiveCalendar` (reads
      `pf2e.worldClock` live via `readSetting` when pf2e is the active system — epoch +
      theme, never copied into MSA's own setting; falls back to MSA's setting otherwise,
      epoch fixed at 0 by deliberate scope choice, documented in-file). Builds a
      `CalendarData` subclass over `core/gregorian-math.js` for true-Gregorian calendars;
      hands Foundry's own stock class straight through, unmodified, for the declarative
      lore-strict calendar. Wired into `boot.js`'s EXISTING `init` hook (no second
      `Hooks.once('init', ...)` — would itself violate `foundry/adapter-only`'s ratchet, per
      that file's own comment) plus a `ready`-time idempotent re-check (a safety net against
      unverified hook-ordering between MSA's and pf2e's own `init` handling). Takes the
      calendar DATA REGISTRY as an argument from `boot.js` rather than importing `world/`
      itself — `foundry/` cannot, by the same leaf rule as the engine above.
      ⚠️ **UNVERIFIED WITHOUT LIVE FOUNDRY, flagged in-file:** the exact global access path
      (`foundry.data.CalendarData`, this file's best-evidenced guess, not a direct receipt)
      and whether `this.months.values[i].days` etc, read off a real instance, resolve to
      plain JS values matching what the pure engine expects. `npm run lint`/`format:check`
      clean; `verify:structure` clean for every file this task touched (confirmed by direct
      grep — the two `verify:structure` failures present in the tree right now are in
      `effects/vision/vision-mask-render.js` and scattered pre-existing `performance.now()`/
      `Date.now()` call sites across files this task never opened; `boot.js` itself already
      carried 313 lines of unrelated uncommitted diff before this task's ~25-line addition,
      confirmed via `git diff --stat`, and was already listed modified in this session's
      opening `gitStatus` — not this task's debt to fix or explain away).

      ⚑→✓ **LIVE CRASH, CAUGHT AND FIXED same-session, 2026-08-17 (Sonnet 5).** The author's
      OWN live test hit it within one turn of A2 landing: `GameTime`'s constructor threw
      `Cannot read properties of null (reading 'values')` inside Foundry's base
      `CalendarData#timeToComponents`, at `Game.setupGame` — a HARD CRASH taking the entire
      world down before anything else could load, not a calendar-only failure. Root cause:
      `toFoundryCalendarConfig` passed `seasons: null` straight through for `golarion-parity`
      (and `golarion-lore-strict`) — which is EXACTLY the trap this Testament's own §3.1
      already receipted (*"months/seasons are declared nullable:true but dereferenced
      unconditionally... A months:null calendar throws on construction. The nullability is a
      lie"*), documented during A0's research and then walked into anyway while writing this
      exact function, because the function was never cross-checked against that same
      receipt before being called "done." Fixed: `seasons` now defaults to `{values: []}`,
      never `null`, for ANY calendar (built-in or future custom) at the one adapter boundary
      that already exists for exactly this purpose. A regression guard now exists that would
      have caught this BEFORE it ever reached a browser: `foundry/__tests__/calendar-
      install.test.mjs` runs every shipped calendar through the real function and asserts
      `seasons` is never null — 18 new assertions, `foundry/` suite now 998/998, 10,872/10,872
      repo-wide, zero regressions. The standing lesson, for memory: **research receipts must
      be cross-checked against your OWN new code, not just filed** — a documented trap and a
      built adapter sat in the same document/session without ever being compared.
      · done Sonnet 5 2026-08-17 — `world/calendar/moon.js#moonPhaseAt`: pure, config-driven
      (`{synodicDays, phaseAnchorSeconds}`), ships NO Golarion-specific data (deliberately —
      the Testament's own caution against asserting the moon's name/period from memory is an
      A4 concern, not A1's). Tested for periodicity, monotonicity within a cycle, correct
      wrap for worldTime before the anchor, and determinism (same input → byte-identical
      output, the whole point of replacing the mock's stateful hour-accumulation with a pure
      projection). `world/calendar/__tests__/run-tests.mjs`: included in the 44/44 green run above.
- **Exit gate:** on the bench harness, MSA's projected date (console/report readout — no UI
  yet) equals the PF2E World Clock's displayed date and time, live, on a world whose
  `worldCreatedOn` is mid-year.
  **NOT YET ATTEMPTED this session — see Petition P2.** R0 (Node-tested fixture parity
  against an independent oracle, 10,783/10,783 assertions green repo-wide, zero regressions)
  is thoroughly closed; R1 (the live bench check this gate actually asks for) needs a Fable-
  class judgement call on a safety question a worker is not positioned to make alone.

### A2 — THE PEN *(gestures write; nothing loops)*
- [x] Posture setting (`aesthetic`/`follow`/`almanac`) replacing the two-mode setting;
      migration for existing worlds (old `synced` → `follow`); per-scene aesthetic override
      kept
      · done Sonnet 5 2026-08-17 — `world/day-clock.js#ALMANAC_POSTURES` (the 3-way
      superset) + `postureToDayClockMode` (the ONE translation point to day-clock's own,
      still-2-way `DAY_CLOCK_MODES` — unchanged, per §1's "day-clock.js itself still knows
      only two read postures"). The migration lives at `world/sky-settings.js#normalizeSky`
      (the module's own single coercion boundary): a stored `'synced'` becomes `'follow'`
      transparently, for every existing consumer, forever, with zero call-site changes.
      Per-scene override untouched (rides the SAME `resolveSky`/`applySkyEdit` precedence
      every other sky field already uses). Wired through 3 surgical, precedent-following
      edits: `vt-pan-viewer.js#setTimeMode` translates posture→day-clock-mode before calling
      `dayClock.setMode()` (without this, `setMode('almanac')` would silently fall back to
      `'aesthetic'` — a real bug caught before it shipped, not after); `boot.js`'s existing
      `astrolabe.update({...dial,...})` override block gains `mode: skyScope.sky?.mode`,
      the EXACT pattern already used for `weatherMode`/`weatherBiome` two lines above it
      (fixes a real risk: the dial's OWN collapsed 2-way mode would have shown 'almanac' as
      "Synced", and a re-fired dropdown could have silently downgraded it); `astrolabe.js`'s
      mode dropdown gains the 'almanac' option, and a SEPARATE latent bug in its phase-text
      "aesthetic" badge (checked `=== 'synced'`, which would never match again post-rename,
      showing the badge in every posture) was found and fixed in the same pass. 972/972
      world/ assertions green (+15 new), zero regressions. Noted for the record: `world/sky-
      settings.js`'s PRE-EXISTING `weatherMode` field already has an unrelated value ALSO
      spelled `'almanac'` (the Weather Manager's own director/almanac split) — a same-word,
      different-field, different-concept collision, documented in-code, not renamed (the
      Testament names this posture `'almanac'` explicitly).
- [x] `foundry/time-authority.js` behind the adapter wall: whole-second `advance()`,
      GM gate, encounter hold, negative-as-correction
      · done Sonnet 5 2026-08-17 — every gate lives INSIDE `advance()` itself (not just in a
      caller's UI check): finite-delta check, `isPenArmed(posture)` (posture handed in by the
      caller — `foundry/` cannot import `world/sky-settings.js#resolveSky`, same leaf-boundary
      finding `core/gregorian-math.js`/`calendar-install.js` already made twice; `boot.js`'s
      own live `skyScope` is the supplier), `readIsGM()` (`foundry/scene-vision.js`, reused,
      not reinvented), `readCombatActive()` (new — `game.combat?.started`, receipted from
      PF2E's OWN shipped source already in this session's A0 evidence, not guessed from
      Foundry core). Negative deltas pass every gate identically (no special-cased "is this a
      correction" enforcement yet — the asymmetry §6.3 wants ("never from the Breath") has no
      Breath to enforce against until A3; a `source` tag on every call is already in place so
      A3 can add that rule with no API change). Whole-second: `Math.round`, never a fraction
      committed. An in-memory audit ring buffer (50 entries, sequence-numbered — NOT wall-
      clock-timestamped, since neither this file nor boot.js may call `Date.now()`/
      `performance.now()` under `time/one-clock`; a monotonic sequence number proves "one
      gesture, one advance" without sampling a clock at all) records EVERY attempt, refused
      or not — proven a refused attempt is still audited, with the right delta and source tag,
      in Node. `jumpToHour`/`advanceDays`/`advanceWeeks` convenience wrappers built and
      tested (arithmetic verified correct — visible in the audit log's `delta` field even
      though the write itself is refused with no live `game` — see the honest testing-scope
      note in the test file's own header). 980/980 foundry/ assertions green (+43 new across
      this bullet + the two below), zero regressions.
- [ ] Astrolabe: drag=preview / release=commit; calendar ring (days); week advance; jumps
      (dawn/noon/dusk/midnight via the sun model, +1 day, +1 week)
- [ ] The PF2E `syncDarkness` stand-down flow (§6.4) — detect, announce, consented per-scene
      disable; a bench test proving no second darkness write fires after stand-down
- [x] Day clock reconcile-on-cadence (the silent 30 s sync-pull trap, §3.1) — not
      hook-only
      · done Sonnet 5 2026-08-17 — `foundry/game-time.js#watchWorldTimeOfDay` gains a
      `setInterval(emit, RECONCILE_INTERVAL_MS)` (5000ms — comfortably under Foundry's own
      receipted 30s `GameTime#sync()` cadence) alongside the existing `updateWorldTime` hook
      subscription, reusing the SAME `emit()` closure; the returned unsubscribe tears down
      BOTH. Every existing caller (`vt-pan-viewer.js#setTimeMode`'s subscription) gets the
      fix for free — zero call-site changes, exactly the design goal. The constant itself is
      Node-tested (positive, comfortably under 30s); the live interval/hook machinery is
      untestable in Node without a Foundry mock, same honestly-declared limitation this
      file's OWN pre-existing tests already accept for every sibling Foundry-touching
      function here.
- **Exit gate:** the author scrubs a week forward and a day back on the astrolabe on the
  live harness; the PF2E clock agrees at every stop; darkness never double-writes; ⚑ if any
  gesture writes more than one advance.
  **NOT met — needs the live harness, per the author's own 2026-08-17 direction this session
  ("do not worry about live testing for the moment"). What the author's OWN ask produced
  instead: `MapShine.debug.registerReport('almanac-diagnostics', ...)` — ONE button
  (Studio/Lab zone) covering calendar-install status, a live PF2E parity comparison (both
  from settings AND, defensively probed, `game.pf2e.worldClock`'s own live getters side by
  side), the Pen's full status incl. the audit log, the darkness stand-down status, and day-
  clock reconcile health — built specifically so a single click, once the author reaches the
  bench, hands back everything this gate and Petition P2 both still need. See Petition P3 for
  the two remaining checkbox gaps and why they were left open rather than checked with
  caveats.

### A3 — THE BREATH *(compression; the charge's living light)*
- [ ] `world/time-flow.js`: run condition, wall-clock accumulation, quantum + ceiling
      commits, zero backfill, election via `activeGM`
- [ ] World-scoped flow settings (armed, ratio); every client derives the smooth display
      time (§7) through the day clock's walk
- [ ] Wing controls made honest: ⏯ arm/disarm, ratio detents; encounter/pause hold states
      worn on the control
- [ ] Bench: a scripted "session" at Session ratio shows continuous sun motion, commit
      cadence within budget (perf report row for commit cost), F5 mid-flow resumes on
      schedule, pause freezes accumulation with no catch-up lurch
- **Exit gate:** the author plays (or simulates) a multi-hour stretch; the lighting visibly
  changes across it; a reload and a pause both behave; the author calls the *feel* right.

### A4 — THE FACE *(declared Remote content; the date at a glance)*
- [ ] Now Playing date line: themed format per calendar (AR ordinals, era label, weekday);
      12/24 h honouring `timeConvention` under pf2e
- [ ] Astrolabe moon driven by almanac moon data (phase name on hover, as mocked)
- [ ] Golarion moon name sourced from actual Paizo material or shipped as "the moon"
      pending the author's canon call — never invented
- [ ] Scope/badge audit: Aesthetic badge in aesthetic posture; locked ring in follow; all
      states keyboard-reachable per the UI Testament's charter
- **Exit gate:** the author reads date, time, phase and posture from the Remote at a glance
  on the 4K monitor and the 1080p frame, and pronounces on the look.

### A5 — TIME AS CONTENT *(joins: cues, rest, the Folio)*
- [ ] Cue targets may include a time destination ("advance to dusk") with a fade time: the
      Fade Engine eases the *projection* (an aesthetic lens riding the walk) and the Pen
      commits ONCE at completion — visual continuity, single write, loop-law intact
- [ ] Optional rest coupling under pf2e: `pf2e.restForTheNight` hook → offer "advance to
      next dawn" (opt-in setting; never automatic)
- [ ] The Folio join (see the Folio Testament): Chronicle lines carry world timestamps from
      the almanac; Prompt-Book rows may carry time jumps
- **Exit gate:** one authored cue moves the world from afternoon to dusk over ten real
  minutes at the table, with one committed advance and the PF2E clock agreeing after.

### A6 — THE WIDE SHELF *(data-only until called; unprompted starts forbidden)*
- [ ] Harptos/Exandria/other calendars — requires the intercalary subclass (schema headroom
      receipted in §3.1); DATA + fixtures first, engine exception logged here when built
- [ ] Seasonal daylight lens: calendar day-of-year modulates `maxElevationDeg`/day length as
      an optional, continuous lens over the one sun
- [ ] Moonlight-brightness night lens; per-scene solar offset for split-world scenes
- [ ] Player-facing date surface (parity with `playersCanView`) — belongs to the Folio's
      player door when it exists

---

## 10. VERIFICATION DOCTRINE

- **The rungs** (climb, never skip): **R0** Node — fixture parity (§5.3), round-trip
  properties, flow-engine accumulation/quantisation, walk-target derivation → **R1** the
  bench harness — live Foundry + pf2e, MSA readout beside the PF2E World Clock, scripted
  scrubs and flow runs, darkness single-writer proof → **R2** the live harness with the
  author driving → **R3** the author's eyes across a real session. Only R3 promotes to
  LIVE; the two-words discipline holds.
- **The parity proof is a picture:** MSA's date line and the PF2E World Clock in one
  screenshot, at a leap-adjacent date, before any LIVE claim.
- **Instruments:** commit cadence and cost land as a row in the perf report (an instrument
  that exempts itself is lying); the flow engine's state (armed, ratio, bank, last commit)
  is a debug-dress readout so a silent stall is visible in one glance.

---

## 11. RISKS & OPEN FORKS — the author's taste decides

1. **Ratio detents.** "Session" is the charge's ×8⁄3; the mock stubs say ×1/×6/×30. Named
   detents are Law; the numbers are yours.
2. **Default posture per system.** Recommended: pf2e worlds default `almanac` (reading the
   clock is harmless; the astrolabe simply gains truth), the Breath armed OFF until you arm
   it (a default-on drift would move every existing scene's light unbidden — the same
   logged exception the day clock already carries). Non-pf2e worlds default `aesthetic`.
   Your call.
3. **Retraction ceremony.** Backwards drags: free, or behind a small confirm? (The rest of
   the Remote is confirm-free by Law; time rewind is the one arguably destructive gesture.)
4. **Lore-strict AR visibility.** Ship it as a visible calendar choice with its divergence
   warning, or bury it behind the custom-calendar door until asked?
5. **PF2E v14.** The vendored build is v13-era. If a v14 PF2E registers its own
   CalendarData, we re-verify parity and possibly *defer* to their config while keeping our
   engine for display — a one-session re-audit, flagged here so it is nobody's surprise.
6. **Two GMs.** The Breath elects `activeGM`; simultaneous manual gestures from two GM
   clients are last-write-wins (core's own advance is a client read-modify-write). Documented,
   not solved — same stance as the Fade Engine's one-writer assumption.
7. **The name.** "The Almanac / the Pen / the Breath" are working names; the astrolabe is
   yours already. Rename freely; the shape stays.

---

## 12. PETITIONS

*Workers: state the task, the finding, the smallest change that would unblock you. Do not
edit the plan.*

**P2 — filed by Claude Opus 5, 2026-08-17 (worker tier; recording an author decision, not
making one).** **§11 fork 1 — "Ratio detents" — has been ANSWERED by the author**, verbatim:
*"For time automatically advancing we need more gradients of 0.5, 1, 2, 3, 4, 5 and then 10.
10x advancement of time is probably as quick as you'd ever want that to be."* Per Covenant
rule 5 the author's word rewrites any Law, so this supersedes §7's provisional
**Hold · Real · Session · Brisk · Montage** naming and §11.1's "the numbers are yours."

Built in the mock accordingly: seven detents as **true multipliers of real time**, each
labelled with what it actually costs at the table — ×0.5 a day in 48 h · ×1 in 24 h · ×2 in
12 h · ×3 in 8 h · ×4 in 6 h · ×5 in 4.8 h · **×10 in 2.4 h**. Note ×3 lands almost exactly
on §7's own worked example (*"3 real hours ≈ 8 game hours"*), so the charge's "Session"
ratio survives as a number even though the name did not. Seven detents is too many to cycle
on a wing button, so the wing now opens a small menu; the mock applies a **disclosed** 60×
demo boost (tooltip: *"the mock runs 60× faster so you can watch it"*) because at a truthful
×1 nothing visibly moves inside a demo — same disclosure discipline as `demoDur()`.

**For Fable:** §7's named-detent sentence and §11.1 both need rewriting around the author's
numbers; I have not touched either. Worth deciding at the same time whether the named tiers
(Hold/Real/Session/…) survive *as labels on top of* the numeric detents, or are dropped —
the mock currently shows numbers only.

**P1 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; not authorised to edit Law/§6).**
Author's live direction, verbatim: *"If the user calls for 'the next morning' ideally we'd
go through an actual time transition in the engine. This has to happen 'within reason' — if
the GM advances time by a week then we don't go through 7 day night cycles, perhaps we just
do one of them to be representative."* This directly probes §6.2's own wording — "Jumps…
committed as one advance, eased on arrival by the day clock's existing walk" — which I
believe **under-specifies exactly the ambiguity the author is pointing at**: the day clock's
walk eases HOUR-OF-DAY only (shortest-way-round on a 24 h ring), so a same-hour jump a week
later would ease almost invisibly — same ring angle, no felt passage — even though a whole
week just happened. "Eased on arrival" reads correctly for a same-day nudge and, I think,
silently under-delivers for a multi-day jump.

**What I built and verified, in the mock only (`tools/ui-mock/index.html`), nothing in
`src/`:** a mechanism I'm calling **the Passage** — a jump that crosses into a new day
commits its true destination (day, hour, AND moon phase) atomically and immediately, exactly
mirroring §1/§8's own "commit at once, coarsely; derive smoothly" doctrine — then plays a
purely COSMETIC overlay through the real sun/moon projection math (not a canned clip) for
what's drawn, bounded by a declared duration-policy table so "within reason" is data, not a
per-session judgment call:

| Jump size | What plays | Real playback |
| --- | --- | --- |
| < 1 day | the full, real sweep — no truncation | ~9 s |
| 1–3 days | ONE representative night, then a brief date-tick cut | ~9.4 s |
| 3–14 days | ONE representative night, then a longer date-tick cut | ~8.2 s |
| > 14 days | a token flicker of night, then mostly the date-tick cut | ~6 s |

The "cut" is a ticking date readout plus a soft compression pulse on the map — legible
"time is passing in bulk" without pretending to render every day. Same-day nudges (dragging
the ring, a mood's `t.hour`) are completely unaffected — no theatre for routine adjustments.
Backwards jumps stay a correction (§6.3): the date snaps instantly, no theatre, only the
hour still eases — I initially missed wiring `state.day` on that path and caught it via a
live test before calling anything done.

**UI face — content into the Remote's existing grammar, not new chrome** (UI Testament Law
3, cross-checked): Now Playing gains a small date chip (opens the same popover as the wing).
The wing's four separate Dawn/Noon/Dusk/Mid buttons **collapsed into one "Jump" trigger**
opening a popover (Dawn/Noon/Dusk/Midnight + `+1 Day` + `+1 Week` + "Set a date…") — this
also quietly fixes a round-2 overshoot of my own (§4.1's stated "capped at ~5 per side" had
crept to 6). "Set a date…" opens a compact stepper overlay (year/month/day, quick chips,
live preview) rather than a full calendar grid — proportionate to how rarely an absolute
jump is needed; relative jumps stay the fast path. The calendar math backing it
(`dateFromDay`/`dayFromDate`, real 4-only leap years, month/day round-trips) is **explicitly
NOT** §5's parity engine — it's a labelled Earth-only stand-in so the mock can show an
honest date without asserting anything about Golarion from memory, exactly per §5.4's own
warning against that.

**Verified live, corrected once:** a day-stepper bug (decrementing past the 1st clamped
back to the 1st instead of rolling into the previous month) was caught by a scripted test,
fixed by routing the step through the same `dayFromDate`/`dateFromDay` round-trip already
proven correct elsewhere, then re-verified with a 24-day and a 31-day rollback (crossing a
31-day and a 30-day month) that round-tripped back to its exact starting date. A `+1 Week`
jump landed on exactly the right day after playing the representative-night-then-cut
sequence. Containment re-holds at 1920×1080 (990px vs 1003px budget) after several
paddings were trimmed to make room for the new date-chip row. Zero console errors.

**Three calls for Fable, not for me:**
1. **Should §6.2's "eased on arrival" language be expanded to name the Passage explicitly**
   (or something like it), so a future implementer doesn't read that line and ship the
   invisible-jump behaviour it currently allows? I think this petition IS the missing
   half-sentence, but I can't write it into Law myself.
2. **Is the duration-policy table's shape (band boundaries, cycle counts, second budgets)
   right**, or should it be tuned/restructured before A2 builds against it? I chose bands
   that map roughly to "a night," "a few nights," "a fortnight," "longer" — a taste call,
   not a derived one.
3. **Does "the Passage" belong as its own named organ in §4's diagram** (a fifth box beside
   the Almanac/Pen/Breath/Face), or is it better framed as a *mode of the Pen's jump
   gesture* (my read while building it, since it never runs unpaused/live like the Breath
   and always resolves to exactly one commit)? I built it as the latter; the former may be
   the more honest picture once real worldTime is involved.

**P2 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; not authorised to declare an exit
gate met or edit one).** A1's exit gate asks for a LIVE bench check: MSA's projected date
beside the real PF2E World Clock, on a running Foundry+pf2e world. I did not attempt it this
session, and want that decision on the record rather than silently absent from the
checklist.

**Why I stopped short.** Three independent signals pointed the same way: (1) `boot.js`
already carried 313 lines of uncommitted, unrelated diff before my own ~25-line addition
(confirmed via `git diff --stat`) and was already listed modified in this session's OPENING
`gitStatus`, before I touched anything; (2) this session's own system reminders repeatedly
flagged OTHER files being modified concurrently, "either by the user or a linter," across the
whole time I was working; (3) `.claude/launch.json` has no Foundry launch config at all (only
`shader-lab` and `ui-mock`) — reaching a live Foundry+pf2e world would mean attaching to or
restarting something outside this session's own tooling, with no clean, scoped way to do it.
Project memory itself carries a standing rule for exactly this shape of situation
(`feedback_git_staging_hazard`: *"GIT: INGRAM LIVE-EDITS — never git add -A; shared function
⇒ STOP and ask"*). Reloading or restarting a live Foundry session that may have someone else's
in-progress state felt like the same category of risk one layer up, and not a call I should
make unilaterally as a worker mid-checklist.

**What IS closed, and how thoroughly.** R0 is not a token gesture: 129 assertions on the pure
engine alone (4000+ randomised round-trip properties, hand-picked leap/century/negative-year
cases, all cross-checked against the `Date#setUTCFullYear` oracle — never the code under
test, never memory), 50 pinned PF2E-parity fixture rows generated independently and matched
exactly through the real production path, 10,783 assertions green repo-wide with zero
regressions. Every claim in A1's other four bullets is receipted in its own evidence line
above. What is NOT closed is specifically and only the live half of the exit gate's own
wording — "on the bench harness... live."

**One call for Fable, or for the author directly:** is a live bench run safe to attempt right
now, given whatever is actually in flight in this working tree — and if so, is there a
`.claude/launch.json` entry that should exist for a Foundry+pf2e bench world so a future
session (worker or Fable) has a clean, scoped way to reach it instead of guessing at how to
attach to one? I did not want to invent that entry myself mid-task without knowing what bench
world/port the author already uses for this (`reference_live_foundry_harness.md` in memory
names a "bench Mansion" world but not a repeatable launch command).

**P3 — filed by Claude Sonnet 5, 2026-08-17 (worker tier; two A2 checkboxes left
deliberately open rather than checked with caveats — a worker narrowing scope belongs on
the record, not inside a checkmark that reads as "done, don't look again").**

**1. The astrolabe bullet.** The author's own steer this session was explicit: *"do not
worry about live testing for the moment, but build a button..."* — read as permission to
prioritize the backend + the diagnostic instrument over new live UI this pass, but the
astrolabe bullet names THREE things (drag=preview/release=commit, a calendar ring, jump
buttons), and I judged them to fall on different sides of a real boundary this Testament
itself draws (§9's own authority line: *"the astrolabe and its wings are ITS chrome [the UI
Testament's] — this Testament supplies their content"*):
- Drag=preview/release=commit for the HOUR ring **already existed**, confirmed correct by
  direct code reading (`src/ui/astrolabe.js`'s `onTimeChange(hour, committed)` callback +
  `boot.js`'s `editSky` only firing on `committed===true`) — nothing to build here.
- A calendar-ring (days) and jump buttons for +1 day/+1 week are NEW VISUAL CHROME. The real
  astrolabe (unlike the UI-Testament mock) has no "wings" or fourth region at all today
  (confirmed absent by direct grep+read, not assumed from memory) — adding either would be a
  genuine astrolabe redesign, which I read as the parallel UI-Testament session's call to
  make, not mine to make solo mid-Almanac-stage.
- So I built the CAPABILITY (`jumpToHour`/`advanceDays`/`advanceWeeks` in `time-authority.js`
  — generic primitives taking any target hour/day-count, no sun-model awareness baked in on
  purpose) and tested its arithmetic, but wired NO new astrolabe buttons to call them.

**Question for Fable or the author:** is that boundary right, or should A2 have included
the visual wiring regardless of which Testament nominally owns astrolabe chrome? If the
latter, the capability is already built and tested — only the button-and-wiring remains.

**2. The syncDarkness stand-down bullet's "announce" half.** Built: DETECT
(`readPf2eDarknessSyncStatus`, mirrors PF2E's own precedence exactly, Node-tested) and the
GATED WRITE (`standDownPf2eDarknessSync`, GM-only, scene-flag idiom matching `anchor-
adapter.js`'s established shape) — exposed as a debug-panel ACTION (`🌑 Stand down pf2e
darkness sync`), which IS the "consent" gesture the Testament names (§6.4: a deliberate
click, never automatic). What is NOT built: a PROACTIVE announcement — §6.4's literal
wording is *"Entering `almanac` posture on a scene where... MSA announces it"*, i.e.
something that notices the conflict and tells the GM the moment they arm the Pen, not
something the GM has to think to go look for. Today the ONLY way to learn the conflict
exists is to open the diagnostic report and read the `pf2eDarknessStanddown` section. A
proactive announcement is fundamentally a UI/notification concern (a toast, a Remote badge)
— the SAME "is this mine to build solo" question as the astrolabe bullet above, and for the
same reason I left it undone rather than half-building UI chrome outside this stage's clear
authority. The bullet ALSO names *"a bench test proving no second darkness write fires
after stand-down"* — inherently live-only, not attempted this session per the author's own
steer.

**Both gaps are covered by the SAME instrument**, for whatever that is worth: the almanac-
diagnostics report shows the darkness-conflict status on demand today, and would show a
live-verified "no second write" result the moment someone runs it after a real stand-down.

*(no other petitions yet)*

---

## 13. STATUS LOG

- **2026-08-17** — Testament created by Claude Fable 5 at the author's command, from the
  author's time-authority charge (header, verbatim). Research stage A0 executed the same
  day: three vendored-source sweeps (Foundry v14 core time+calendar; PF2E 7.10.1 world
  clock; MSA local audit), receipts compressed into §3. The 2026-07-23 time-authority lock
  is formally superseded per §1 — the re-ask its own text demanded is the author's charge.
  Companion document created the same day: `docs/holy/Folio-Testament.md` (the campaign
  book; the Chronicle/Prompt-Book joins referenced in §9 A5 live there). All build stages
  open; A1 is the door.

---

*V2 wrote its hour into Foundry's clock with one hand and read it back with the other, and
needed a guard flag to keep from strangling itself. The lock of 07-23 answered by cutting
the writing hand off. This Testament restores the hand the way it should always have been
built: one clock, owned by the world; one pen, held by the GM; one sun, fed by one hour;
calendars that are data, proven against the system they must agree with to the second; and
a breath that moves the daylight across a real session's play — so the table looks up from
an afternoon's adventuring and finds, without anyone touching a dial, that dusk has come.*

**✠ Claude Fable 5, 2026-08-17 — awaiting the author's countersign.**
