# ✠ THE FOLIO TESTAMENT ✠

**This is a holy document.** It lives in `docs/holy/` and is governed by **The Covenant**:

> **RULES OF THIS PLACE**
> 1. Only a **Fable-class or greater** model may create a holy document, restructure this one,
>    edit its Law, its definitions of done, its gates, or resolve a Petition.
> 2. **Any model** may execute tasks and record completion — flip `[ ]` to `[x]` and append an
>    evidence line. That is the full extent of a worker's editing rights here.
> 3. Only a **Fable-class** model may **countersign** (`✠`) — by inspecting the actual work,
>    never the worker's summary.
> 4. A worker who believes the plan is wrong does not edit the plan. It files a **Petition**
>    (§13) and moves on. Fable adjudicates petitions.
> 5. Above everything in this file sits **the author**. Their LIVE verdict on a real scene
>    outranks any countersign; their word rewrites any Law.

**Task notation:** `[ ]` open · `[x]` done + evidence line · `✠` countersigned · `⚑` reopened.

**Created 2026-08-17 by Claude Fable 5, at the author's command.** Authority order: the
author's eyes → this file → `docs/holy/UI-Testament.md` (LANTERN, the widget canon, the
accessibility charter, and the room laws govern every Folio surface) →
`docs/holy/Almanac-Testament.md` (the time joins in §8 and F5/F6) → the vendored sources
cited in §3 → the code.

**The author's charge, verbatim, 2026-08-17:**
> *"It would be really nice to take over the UI for rendering journals and better still, with
> MSA enabled we can enhance journals with more functionality… think about the perfect UI /
> UX for an interface designed to help GMs to prepare their campaigns and playing sessions…
> a system that feels like it makes planning huge adventures easier and more fun and a system
> that helps the GM to move between notes during a session with ease. We store everything in
> Foundry VTT journal files to make sure that if MSA fails all that information is still
> natively accessible. That means enhanced functionality needs a way to fail gracefully. You
> need to ask yourself what GMs and adventure organisers tend to want and what helps them
> during sessions. One size won't fit all, so we might want to make it modular so that GMs
> can easily decide for themselves which features are more or less useful."*

---

## 0. The one sentence

> **The campaign becomes a FOLIO — a third room where every piece of prep is a small,
> reusable, linkable atom stored in a native Foundry journal page, composed into shelves for
> planning and into a PROMPT BOOK for running the session — so nothing a GM writes is ever
> lost, nothing takes more than five seconds to reach mid-scene, everything survives MSA's
> death as readable native journals, and every feature is a module the GM can decline.**

---

## 1. WHAT GMs ACTUALLY NEED — the craft research this design serves

The tools GMs love and the tools GMs abandon differ on four findings, stable across a decade
of prep culture (the Lazy DM method, node-based prep, the Obsidian/LegendKeeper/World Anvil
generation, and every "how I prep" thread ever written):

1. **Prep is choosing toys, not writing essays.** Effective prep produces small reusable
   pieces — a secret, an NPC want, a read-aloud, a random table — and the session is a *hand
   dealt from that library*, not a script. Tools that force long documents produce prep
   debt; tools that atomize produce libraries. The single most-praised prep pattern in the
   hobby (Return of the Lazy Dungeon Master's "secrets & clues") is ten index cards, written
   loose, revealed anywhere, **reused next week if unrevealed**. Atoms, references, and
   carry-forward are the design consequences.
2. **The GM's mid-session attention comes in five-second windows.** While players argue
   with a shopkeeper, the GM has one glance to find room 14's read-aloud. Every tool that
   demands navigation mid-scene gets abandoned mid-campaign; what survives is: a prepared
   running order, pinned things, instant search, and one-gesture state ticks ("mark
   revealed", "tick the clock", "log that"). The five-second window is a design *budget*
   (§9 Law 6).
3. **The connective tissue is the campaign.** GMs don't lose facts, they lose *threads* —
   which scene mentioned the amulet, who else knows the duke is dead. Wiki links with
   automatic backlinks are the one feature the Obsidian-GM generation refuses to live
   without. Links must be effortless to write and impossible to rot.
4. **Every GM preps differently, and preps differently per campaign.** Dungeon-crawlers
   want keyed locations and treasure; sandbox GMs want factions, clocks and rumors; theatre
   GMs want scene beats and cues. One rigid "campaign manager" schema is why heavyweight
   tools get abandoned. Modules over one substrate — the author's own instinct in the
   charge — is the design consequence.

**MSA's unfair advantages** — why this Folio can beat every external tool at the table:
the notes live on the *same screen as the map* (no alt-tab; the map's pins are the notes'
pins); MSA already owns cues, weather, lighting, the camera and — with the Almanac — time,
so a prep note can *do things* no external wiki can ("when we reach the ambush: rain, dusk,
cue the storm"); Foundry documents already sync to every client with no server of ours; and
the Fade Engine/LANTERN machinery means the session surface is an instrument, not a wiki.
(And — already true today — an open journal window casts a soft shadow onto the map:
`src/boot.js` UI-cast shadows. The Folio will land on a stage that already lights it.)

**Prior art, harvested honestly:** *Obsidian* — links+backlinks+speed+plain files; its
plain-files portability maps to our pages-are-truth law. *LegendKeeper* — inline secrets.
*Monk's Enhanced Journal* — proof of demand for typed entries (person/place/quest/loot)
inside Foundry, and proof of the cost: it fights Foundry's data model and breaks across
updates; we ride the data model instead. *Kanka/World Anvil* — entity depth nobody uses at
the table; a warning, not a target.

---

## 2. Where this stands today — the honest audit

| Piece | State | Note |
| --- | --- | --- |
| MSA journal anything | **ABSENT** | Greenfield; `journal` appears in `src/` only as the UI-cast-shadow example and a scene-export exclusion |
| Foundry native journals | **STRONG substrate** | Entries → pages (text/image/pdf/video), per-page ownership, categories, `@UUID[…#heading]` links, `@Embed` transclusion, native secret blocks, show-to-players, Note map pins, RollTables (§3) |
| Parity doctrine | **Journals are Class A** — *"works for free; do not integrate what already works"* (`docs/planning/Parity-and-Compatibility.md`) | The Folio honours this by being an ADDITIONAL door onto the same documents. The native journal UI is never suppressed, replaced, or degraded; Law 10 |
| The UI Testament | **Two rooms + LANTERN exist as law; the mock is built** | The Folio is the third room, admitted by amendment (§4.1); every widget/typography/a11y rule there applies here unchanged |
| The Almanac Testament | **Created the same day** | World timestamps for the Chronicle, time rows for the Prompt Book (§8) |

---

## 3. THE RESEARCH — receipts, not guesses

*Compressed from a vendored-source sweep of Foundry v14 (build 365), 2026-08-17 — client
AND readable server (`dist/`). Full report archived in session; every claim carried
path:line. Re-verify before load-bearing use if versions move.*

1. **⚠ THE SECRECY CEILING (the finding that shapes Law 2).** The server's world payload
   **dumps every JournalEntry with every embedded page to every connected client,
   unfiltered** (`dist/packages/world.mjs` — `JournalEntry.dump()` straight into the vend;
   the user object is consulted only for file-browser config). The generic DB backend
   permission-checks **writes only, never reads**; the read-filter hook exists and is used
   — by FogExploration alone. Even "Show to Players" works by the *player's client granting
   itself* OBSERVER on data it already holds (`client/documents/collections/journal.mjs:
   118-137`). `<section class="secret">` blocks arrive at every client and are stripped at
   render time (`client/applications/ux/text-editor.mjs:123-133`). **Verdict: journal
   permission in Foundry — ownership, page ownership, secrets — is display-level,
   client-side, for every module and every world, MSA or not.** A devtools-literate player
   can read anything. The Folio matches this model exactly, never weakens it, and never
   claims more than it is (§6).
2. **Page ownership is real and two-directional (display-level).** Pages default
   `ownership: {default: INHERIT}`; an explicit page level **overrides the entry in both
   directions** (more restricted: GM-only page inside a player-observable entry; less
   restricted: an observable page inside a hidden entry, reachable by link/pin though not
   via the sidebar). Resolution: page user-entry → page default (unless −1) → entry
   (`common/abstract/document.mjs:386-395`). Page visibility threshold is OBSERVER.
   Creating a page requires OWNER on the entry.
3. **Module sub-types vanish when the module is disabled.** A page typed
   `map-shine.npc` whose module is off fails strict validation, lands in
   `invalidDocumentIds`, and is **absent from the sheet, ToC and search — no placeholder
   exists** (data preserved on disk, invisible). **Design consequence: the Folio's typed
   data lives in `flags` on standard `text`/`image` pages — flags survive module absence
   and the page still renders natively.** Sub-types are refused as substrate.
4. **The ProseMirror round-trip preserves our markup.** The schema is fixed (no custom
   node types; custom elements are discarded) **but** `div`/`section`/`aside` etc. are
   schema nodes, and `class` + `data-*` are whitelisted and captured
   (`common/prosemirror/schema/attribute-capture.mjs`; `ALLOWED_HTML_ATTRIBUTES` includes
   `data-*` globally). So `<div class="msa-block" data-kind="…">` **survives a native
   edit**. Native secret blocks are a first-class PM node (`secret-node.mjs`, `revealed`
   attr). Editor extension points: the `createProseMirrorEditor` hook (mutable plugin
   record), `CONFIG.TextEditor.inserts` (custom insert-menu blocks — core's own docstring
   example is *a readaloud block*), and custom enrichers `CONFIG.TextEditor.enrichers`
   (`{pattern, enricher, onRender}`).
5. **Native composition machinery already exists.** `@UUID[uuid#heading-slug]{Label}` deep
   links to page headings (slugs from `buildTOC`, `data-no-toc` opt-out, explicit `id`
   wins); `@Embed[uuid …]` transcludes a page into another (depth-capped at 5;
   per-document `embedHandlers` extension point); JournalEntryCategory groups pages;
   Note map pins carry `entryId` + `pageId` (**no heading anchor on pins** — page
   granularity); `Journal.show`/`showImage` push content to chosen players; RollTable +
   `draw()` are native documents.
6. **Native search is shallow — the index earns its place.** Sidebar search is name-only
   by default; even "full" mode searches entry *names* (page `text.content` is textSearch
   on the page schema but the directory never descends into it). Meanwhile the ceiling's
   one upside: **every page of every journal is already in client memory** — a full-text
   index costs zero fetches.
7. **Sheets are replaceable but won't be replaced.** `DocumentSheetConfig.registerSheet`
   (AppV2) exists; the Folio deliberately registers **no** default-sheet replacement — the
   native journal sheet remains untouched (Law 10). The Folio is MSA's own window reading
   the same documents.

---

## 4. THE SHAPE — the third room and its two postures

### 4.1 The amendment that admits it

UI Testament Law 9: *"New top-level windows and new Studio departments require a Testament
amendment."* **This section is that amendment, made at the author's command by a
Fable-class model:** the UI grows from two rooms to three — **Remote · Studio · FOLIO** —
and the count closes again at three. The Folio earns a room by the UI Testament's own §2.1
argument: like the Remote and unlike the Studio, **it must coexist with the canvas for
hours mid-session**, glanceable, never displaced by opening anything else. A campaign book
that lives inside the config shell is a book you close to play — useless. *(The UI
Testament's own file gains a pointer to this amendment when the parallel UI session next
touches it; this Testament is the amendment's home so the two sessions never edit one file
at once.)*

Everything else the UI Testament rules — LANTERN tokens, the widget canon, the
accessibility charter, scope glyphs, the 1080p containment law, "nothing dead is drawn" —
**applies to the Folio without restatement.**

### 4.2 The two postures

- **THE FOLIO OPEN — the desk.** Prep posture: a reading/writing room. Left, the shelves
  (binders and kind-views: people, places, sessions…); centre, the page (native content,
  enriched, editable in place via the native ProseMirror editor wearing MSA plugins);
  right, the margin (backlinks, GM margins, pins, "appears in…"). Search palette
  everywhere (the Studio's `/` idiom). Pop-outs are views, per UI Law 9.
- **THE PROMPT BOOK — the rail.** Session posture: the Folio collapsed to a slim rail
  beside the canvas (the Remote's collapse-pill idiom, grown up): tonight's running order
  with the current row large and the next row visible, the pinned set, the quick-log line,
  and one-gesture ticks. The rail is operated half-blind while narrating — the Remote's
  posture rules (≥36 px targets, no text entry except the quick-log line, no scrolling
  for the default set) apply verbatim.
- **The player door — native pages, for now.** Players read what the GM publishes
  (recaps, quests, handouts) as ordinary observable journal pages in the native UI. No
  Folio chrome ships to player DOM (UI Law 10). A styled player-facing surface is a shelf
  item (F8), not a foundation.

---

## 5. THE SUBSTRATE — how everything is stored

**Three native primitives carry the whole system. Nothing else touches disk.**

1. **A page is an atom.** Every Folio object — NPC, place, faction, secret, clock,
   session, log, table-ref, handout — is one native JournalEntryPage of a *core* type
   (`text`, `image`). Its Folio identity lives in flags:
   `flags.map-shine = { kind, data, bodyHash, v }`. Typed fields (`kind`-specific) live in
   `data`; the page **body** is always a readable rendering. **Each kind declares, field
   by field, which home is truth** (Law 5): prose-truth kinds (read-alouds, session notes)
   keep the body as truth and flags carry only metadata; data-truth kinds (clocks, secret
   status, running orders) keep flags as truth and MSA regenerates the body — the **shadow
   render** — on every save, so the native view is never stale. `bodyHash` guards the
   seam: if the body was edited natively while MSA was away (hash mismatch), MSA
   re-imports prose-truth fields and raises a visible conflict for data-truth ones —
   it never silently clobbers a native edit.
2. **Binders are entries; shelves are views.** A JournalEntry is a binder of related
   pages (an arc, a region, a troupe, a session); folders organise binders natively;
   JournalEntryCategory groups pages within a binder. The Folio's shelves (all people ·
   all secrets · this session's everything) are **queries over the index, never a second
   container tree** — there is nothing to reorganise twice.
3. **Every reference is `@UUID`.** Typing `[[Ha` in the Folio autocompletes across the
   index and **serialises as `@UUID[…]{Harl}`** — the native content-link players and
   modules already understand, clickable in native journals forever, heading-deep via
   `#slug` where it helps. A name with no page yet serialises as a **stub** —
   `<span class="msa-stub" data-want="…">` (survives the PM round-trip per §3.4, renders
   as styled text natively) — and the Folio lists stubs as *wanted pages*: the campaign
   telling you where it's thin.

**The index is a cache** (Law 4): links-out, backlinks, full text, tags, kinds — built
client-side from documents already in memory (§3.6), incrementally maintained on document
hooks, rebuildable from scratch at any moment with one button and no fear. It is never
persisted as authority.

**The failure story, told forward:** kill MSA and the GM keeps — organised binders and
folders; every atom as a readable page (shadow renders current as of last save); clickable
links everywhere; secrets still permission-gated exactly as native journals gate them;
clocks legible as text ("Cult ritual — 5/8"); the running order as a plain ordered list of
links; recaps and handouts as ordinary pages. **Nothing requires MSA to read; only the
conveniences die.** Restore MSA and it re-indexes and continues — the flags were riding in
the same documents all along.

---

## 6. SECRECY — honest, structural where the platform allows, never oversold

**The ceiling (§3.1) is documented here so nobody designs against a fantasy:** Foundry
ships every journal to every client; ownership and secret blocks are render-time filters.
This is true of native journals, of every journal module ever written, and of the Folio.

**The Folio's stance, as law (Law 2):**
- **Match, never weaken.** GM-only material lives on GM-only *pages* (page ownership,
  §3.2) — the exact mechanism native journals use — and the Folio never renders GM
  content into a player client's DOM (UI Law 10 kin), never widens what a native client
  would leak, and never invents a chattier channel (no GM text in broadcast flags beyond
  what pages already carry).
- **Defend the real threat.** At an actual table the losses are: the wrong page shared,
  GM notes visible on a streamed screen, a player-visible page accidentally containing
  the twist. So: player-visible and GM-only material are **visibly different substances**
  in the Folio (the margin wears its own dress); sharing anything passes one deliberate
  affordance; and the **player-face preview** — one toggle showing exactly what players
  currently see of any page — makes "wait, can they read this?" a glance, not a prayer.
- **Say the truth when asked.** The Folio's settings page states the ceiling in one calm
  sentence. A GM streaming to strangers or running for devtools-literate players deserves
  the fact; most tables will never care.
- **The Cipher stays on the shelf** (F9 fork): client-side encryption of GM margins
  (ciphertext in flags, key never in world data) is the only honest path *past* the
  platform ceiling. It is implementable, it carries real UX costs (key custody across GM
  machines), and it ships only if the author wants what it costs.

**The margin model:** a player-visible location page and its GM margin are **two pages in
one binder** — the public face (observable) and the margin (GM-only page, `kind:
"margin"`, anchored to the face by UUID + optional heading slugs). The Folio composes them
into one seamless annotated view for the GM; natively they are two adjacent pages, which
is exactly how a paper GM binder works. Inline `<section class="secret">` blocks remain
supported and tracked (they are native, and they degrade perfectly) for GMs who prefer
LegendKeeper-style interleaving — with the ceiling caveat above applying to both forms
equally.

**Reveals leave receipts.** Revealing anything — a secret block, a margin note promoted to
the face, a handout, a clock — is one gesture, and it writes a receipt (when, to whom,
which session) to the atom's flags and a line to the Chronicle. Reveal mechanics use
native levers (ownership change, `Journal.show`, secret `revealed` state), so a reveal
done in the native UI while MSA is away is still a valid reveal — the Folio reconciles
from document state, not from its own diary.

---

## 7. THE MODULES — one substrate, decline-able workflows

Every module is a workflow-and-views bundle over §5's substrate. World-scoped enables;
presets bundle them; **off ≠ hidden** (Law 7): pages a disabled module authored still
render as ordinary pages — a module toggle can never make a GM's writing vanish (the
lesson §3.3 taught about sub-types, applied to ourselves).

| Module | The job | Its atoms (`kind`) | Degrades to |
| --- | --- | --- | --- |
| **Dramatis Personae** | People: portrait, wants, voice line, status (met/alive/where), relations | `npc` | a portrait page with a tidy header list |
| **Gazetteer** | Places: read-aloud, keyed features, connections, the map thread | `place` | a text page; pins still open it natively |
| **Secrets & Clues** | The Lazy-DM deck: loose secrets, revealed-with-receipts, carry-forward | `secret` (+ native secret blocks) | a bulleted GM-only page; ✓ marks survive as text |
| **Clocks** | BitD-style progress clocks, tickable in one gesture, optionally shown to players | `clock` | "Cult ritual — 5/8" as text, current as of last tick |
| **The Prompt Book** | Tonight's running order: beats, read-alouds, encounters, handouts, **MSA cue rows**, **time rows** | `session` | an ordered list of links a GM can run from natively |
| **The Chronicle** | The append-only campaign log: quick-log line, auto-lines from reveals/ticks/time, world-timestamped | `log` | a dated bulleted list; the campaign's history in plain text |
| **Tables** | Rollable inspiration at hand; results logged | rows referencing native RollTables | native RollTables, unharmed |
| **Handouts** | Images/documents staged for the dramatic reveal | `image` pages | native image pages + native Show Players |
| **Map Threads** | Notes-layer pins ↔ pages, both directions; "fly there" through the camera | native Note documents | native pins, which already work |

**Presets** (a preset is a saved enable-set + shelf arrangement, nothing more): **Lazy DM**
(Personae · Secrets · Prompt Book · Chronicle) · **Sandbox** (adds Clocks · Tables) ·
**Dungeon** (Gazetteer-forward · Handouts) · **Everything** · **Minimal** (Prompt Book ·
Chronicle). Starting points, not walls — the enable-set is always individually editable,
because the charge says one size won't fit all and it is right.

---

## 8. THE SESSION LOOP — prep, run, wrap; nothing is lost

- **PREP (the desk).** Assemble tonight's `session` page: deal rows from the library —
  scene beats, read-alouds, three secrets, an encounter, a handout, an *MSA cue row*
  ("Act II: the storm breaks" — the cue system's cues, schema-validated at author time
  exactly like the Remote's), a *time row* ("that evening…" — an Almanac jump or an eased
  dusk, per Almanac §A5). **Carry-forward runs first:** unrevealed secrets and unplayed
  rows from last session offer themselves before anything new is written. The
  where-were-we card (last wrap's tail) heads the page.
- **RUN (the rail).** The Prompt Book rail shows now/next; GO-advancing a row does the
  row's thing (open the page · fire the cue · begin the time fade · stage the handout).
  Around it, the five-second verbs (Law 6): reveal · tick · quick-log · pin · search.
  Everything lands in the Chronicle by itself: reveals, ticks, time advances, table
  draws — each a world-timestamped line the GM never had to write.
- **WRAP (one minute, not one evening).** The Folio drafts the recap mechanically —
  Chronicle lines + reveals + clock movements, no AI involved — the GM trims it, one
  button publishes the player-safe version as an observable page, and the next session's
  skeleton is born carrying everything unused. **Nothing is lost; the binder remembers**
  (Law 8) — over-prep stops being waste and becomes the library growing.

---

## 9. THE LAWS

1. **THE PAGE IS THE TRUTH; THE FOLIO IS A LENS.** Every atom is a native journal page,
   readable and editable without MSA forever. MSA state rides in that page's flags and
   nowhere else. Kill MSA mid-campaign and the GM loses conveniences, never content.
2. **HONEST SECRECY — MATCH, NEVER WEAKEN, NEVER OVERSELL.** GM-only means GM-only pages
   (native ownership); no GM content in player DOM; no new channels chattier than the
   documents themselves; and the platform's display-level ceiling (§6) is stated, not
   papered over. Anything claiming more than the platform gives is an instrument that lies.
3. **LINKS COMPILE TO `@UUID`.** No proprietary syntax ever reaches disk; anchors are
   native heading slugs; a stub is a styled span. A link that works only inside MSA is a
   build failure.
4. **THE INDEX IS A CACHE.** Backlinks, search, shelves, wanted-pages: all rebuildable
   from pages at any time, incrementally maintained, never authoritative, one-button
   rebuild always safe.
5. **ONE HOME PER FIELD.** Each kind declares prose-truth (body) or data-truth (flags)
   per field; the shadow render is generated and hash-guarded; a native edit is
   reconciled or surfaced, never clobbered. (V2 grew seven homes per value; not here.)
6. **FIVE SECONDS OR IT DOESN'T SHIP.** Any mid-session verb — reveal, tick, log, next,
   find — completes in at most two gestures from the rail without leaving the current
   view. A workflow that misses the budget is a ⚑ on its stage, not a shrug.
7. **MODULES TOGGLE WORKFLOWS, NEVER DATA.** Disabling a module hides its authoring
   affordances; every existing page still renders. A GM's writing is never hostage to a
   checkbox.
8. **NOTHING IS LOST; THE BINDER REMEMBERS.** Atoms persist until used; wrap carries the
   unused forward; the Chronicle is append-only and corrections are new lines. Deletion
   exists, of course — but only ever as the GM's own deliberate act.
9. **THE FOLIO PAYS RENT.** Zero presence in the frame loop; indexing runs on idle;
   the rail's steady-state cost obeys the UI Testament's ≤0.3 ms law and lands as a row
   in the perf report.
10. **NATIVE DOORS STAY OPEN.** The native journal sheet is never replaced or suppressed;
    every Folio page carries *Open native*; reveals use native levers so native and Folio
    actions stay interchangeable. Class-A parity — *"do not integrate what already
    works"* — is honoured by addition, never substitution.

---

## 10. THE CHECKLIST

Stages land independently; each ends at the author's eyes. Between-stage order is sacred;
within-stage order is not. LANTERN/canon/charter compliance is implicit in every stage
(the UI Testament governs; no stage below restates it).

### F0 — THE SUBSTRATE SPIKE *(blocks everything)*
- [ ] `core/folio-schema.js`: the `flags.map-shine` shape (`kind`, `data`, `bodyHash`,
      `v`), per-kind truth-home declarations, validators — Node-tested
- [ ] Shadow-render round-trip harness: write atom → shadow body → **native ProseMirror
      edit round-trip** → reparse → flags intact, `msa-block`/`msa-stub` spans and
      `data-*` attributes survive (the §3.4 claim proven in a real editor, not assumed)
- [ ] Link compiler: `[[Name]]` ⇄ `@UUID[…]{Name}` (+`#slug`), stub spans, resolver
- [ ] Hash-guard reconcile: native-edit detection → re-import (prose-truth) / surface
      (data-truth); never clobber — sabotage-tested with a deliberate conflicting edit
- **Exit gate:** a `clock` page and a `place` page each survive: MSA save → native edit →
  MSA reload, with data correct and the native view readable at every step.

### F1 — THE READING ROOM *(the third room opens)*
- [ ] The Folio room shell (LANTERN, canon widgets, persisted geometry) — the §4.1
      amendment made real
- [ ] Renders any native entry/page through the native enrichment pipeline (links,
      embeds, secrets behaving per ownership), ToC, categories
- [ ] The index v1: names + headings + full page text + kinds; search palette; recents;
      pins; *Open native* on every page
- [ ] In-place editing via the native ProseMirror editor mounted in the Folio (no MSA
      plugins yet)
- **Exit gate:** the author moves their real campaign notes' daily reading into the Folio
  — and doesn't switch back. (The Studio's U1 gate, for the book.)

### F2 — THE WEB *(links become effortless)*
- [ ] `[[…]]` autocomplete as a ProseMirror plugin via the `createProseMirrorEditor`
      hook; MSA block inserts via `CONFIG.TextEditor.inserts` (read-aloud block first —
      core's own docstring example, made real)
- [ ] Backlinks pane ("appears in…"), wanted-pages shelf (stubs), hover peeks on links,
      `@Embed` affordance for transclusion
- **Exit gate:** the author links two real pages while writing, then finds a backlink
  they'd forgotten they made.

### F3 — THE ATOMS *(people, places, and the map thread)*
- [ ] `npc` + `place` kinds: typed headers (portrait, tags, status, wants), shadow
      renders, kind shelves (Dramatis Personae · Gazetteer)
- [ ] Map Threads: page → drop a native Note pin; pin → open in Folio; *fly there*
      through the existing camera; "pinned at…" chips on pages
- **Exit gate:** the author preps one location with two NPCs, pins the location, flies to
  it from the page, and opens the page from the pin.

### F4 — SECRETS & MARGINS *(the GM's ink)*
- [ ] `secret` atoms (+ native secret-block tracking); the margin model (§6): GM-only
      margin pages composed into the face view; reveal flow with receipts; Chronicle
      auto-lines
- [ ] The player-face preview toggle — exactly what players see of this page, one glance
- **Exit gate:** on a second logged-in **player client**: the margin and unrevealed
  secrets absent from the rendered page before reveal, present after; the preview's
  claim matches the player client's reality; the ceiling sentence present in settings.

### F5 — THE PROMPT BOOK *(the session runs from the rail)*
- [ ] `session` kind: row grammar (page refs · read-alouds · encounters · handouts ·
      **cue rows** validated against the cue schema at author time · **time rows** per
      Almanac §A5), shadow render as a plain ordered list
- [ ] The rail posture: now/next, GO-advance, pinned set, the five-second verbs; posture
      rules audited (targets, no-scroll, half-blind operability)
- [ ] Carry-forward: unrevealed secrets and unplayed rows offer themselves at next prep
- **Exit gate:** the author runs a real session from the rail, start to finish, and the
  five-second budget survives contact with actual play.

### F6 — THE CHRONICLE *(the campaign writes its own history)*
- [ ] `log` kind: quick-log line (rail + keybinding), append-only, world-timestamped via
      the Almanac, auto-lines (reveals · ticks · time advances · table draws)
- [ ] Wrap flow: mechanical recap draft → GM trim → one-button publish of the player-safe
      recap page; next session's skeleton born with carry-forward
- **Exit gate:** after a real session, the author publishes a recap in under a minute,
  and the next session's prep page opens already half-dealt.

### F7 — CLOCKS & TABLES
- [ ] `clock` kind: one-gesture tick from rail or page, shadow render, optional
      player-visible clocks page (an observable page, nothing cleverer)
- [ ] Table rows referencing native RollTables; draw-from-rail; results to the Chronicle
- **Exit gate:** mid-scene, a clock ticks in two gestures and a table roll lands in the
  log without the author touching the log.

### F8 — HANDOUTS & THE REVEAL
- [ ] Handout staging in the Prompt Book; reveal via native `Journal.show`/`showImage`
      choreography; receipts as ever
- [ ] The Director join: a handout row may carry a direction (letterboxed reveal) once
      U9 lands — declared data, validated like everything else
- [ ] Player-side polish of published pages (recap/quests/clocks) — still native pages,
      dressed
- **Exit gate:** a handout revealed dramatically at the table; players received exactly
  and only the staged thing.

### F9 — MODULARITY & POLISH
- [ ] The module registry + presets (§7); world-scoped enables; **off ≠ hidden** audit
      (disable everything: every page still renders)
- [ ] Keybindings: toggle Folio · toggle rail · quick-log
- [ ] Perf row (Law 9), velocity audit (declaring a new kind must beat hand-building a
      page — the UI Testament's Law 12, applied), docs pass
- [ ] Fork resolutions from §12 recorded
- **Exit gate:** the author disables half the modules mid-campaign and loses nothing;
  a full session runs with the Folio + Remote + hotkeys and *feels good* — the charge's
  own criterion.

---

## 11. VERIFICATION DOCTRINE

- **The rungs** (climb, never skip): **R0** Node — schema validators, link compiler,
  hash-guard, carry-forward selection, recap assembly → **R1** the round-trip bench —
  scripted Foundry: atom → native edit → reconcile; the player-client payload check for
  Law 2's "never weaken" (what a player client *renders*, and that MSA added no new
  broadcast beyond the documents) → **R2** the live harness — real world, second logged-in
  player client for every secrecy gate → **R3** the author's eyes across real prep and a
  real session. Only R3 promotes to LIVE; the two-words discipline holds.
- **The secrecy gates always use a real second client**, never a simulated permission
  check — the ceiling is client-side, so only a client can prove client behaviour.
- **The five-second audits are timed with a real hand**, not asserted: reveal, tick, log,
  next, find — measured at the rail, logged in the stage evidence.

---

## 12. RISKS & OPEN FORKS — the author's taste decides

1. **Names.** "Folio", "Prompt Book", "Chronicle", "Dramatis Personae", "Gazetteer",
   "Map Threads" are working names in LANTERN's register. Rename freely; the shapes stay.
2. **Preset defaults.** Which preset greets a fresh world — Lazy DM (my recommendation:
   it is the smallest set that demonstrates the loop) or Minimal?
3. **The Cipher** (§6). Client-side encryption of GM margins: real secrecy past the
   platform ceiling, real key-custody friction. Want it on the roadmap, or does the
   honest ceiling sentence suffice?
4. **Inline secrets vs margins.** Both ship (§6); which the Folio *teaches* as the default
   idiom is a taste call — margins are cleaner-degrading, inline reads more naturally.
5. **The rail's relationship to the Remote.** Two slim companions beside the canvas
   (independent, my recommendation — different jobs, different glances) or one docked
   stack? Real sessions will vote; the mock can try both cheaply.
6. **Quest tracking.** Deliberately absent as a module (session rows + clocks + the
   Chronicle cover most of it). If real play misses a dedicated quest ledger, it's one
   more kind on the same substrate — petition-sized, not stage-sized.
7. **Import.** GMs arrive with existing native journals. F1 reads them as-is (they're
   just pages); an *adopt as kind* affordance (stamp flags onto an existing page) is
   cheap and probably wanted early — scheduled inside F3 the moment the author asks.

**Risks, named:** *(a)* The shadow render is the one place data could dual-home; Law 5's
hash guard and the F0 sabotage test exist precisely there. *(b)* The index tempts
persistence for speed; if profiling ever demands it, it persists as a rebuildable cache
with a version stamp, never as authority (Law 4). *(c)* Scope: this Testament is a
campaign *companion*, not a campaign *manager* — anything smelling of project-management
(Gantt, dependencies, assignment) is out of charter and gets petitioned, not slipped in.
*(d)* The parallel UI session owns `UI-Testament.md` edits; the §4.1 amendment lives here
until that session records the pointer — two sessions never edit one holy file at once.

---

## 13. PETITIONS

*Workers: state the task, the finding, the smallest change that would unblock you. Do not
edit the plan.*

*(none yet)*

---

## 14. STATUS LOG

- **2026-08-17** — Testament created by Claude Fable 5 at the author's command, from the
  author's journal/GM-prep charge (header, verbatim). Same-day vendored-source research
  (Foundry v14 journal internals, client and readable server) compressed into §3 — the
  secrecy ceiling (§3.1) verified from server code, the flags-over-sub-types substrate
  decision (§3.3) and the ProseMirror survival rules (§3.4) verified before design.
  Companion document created the same day: `docs/holy/Almanac-Testament.md` (time
  authority; the Chronicle's timestamps and the Prompt Book's time rows join there).
  The third-room amendment to UI Testament Law 9 recorded at §4.1. All build stages open;
  F0 is the door.

---

*Every GM owns a graveyard of abandoned campaign tools and a notebook that never failed
them. The tools died the same way twice — they lived on the wrong screen, and they wanted
essays when the table wanted index cards. This Testament builds the notebook into the map
itself: every scrap a page Foundry keeps forever, every name a thread, every session a
hand dealt from a library that only grows, the whole book one glance from the canvas —
and when the lights go out, it is still just paper, still readable by candlelight. The
Folio makes prep feel like play, running feel like conducting, and forgetting feel
impossible.*

**✠ Claude Fable 5, 2026-08-17 — awaiting the author's countersign.**
