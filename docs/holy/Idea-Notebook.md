# 📓 THE IDEA NOTEBOOK
*Sketches of things we might build one day. No code. No commitments. No dates promised.*

**This is a holy document, and it is the ONE exception to The Covenant's authorship rule.**

> **THE AUTHOR'S OWN GRANT (2026-08-15, verbatim):** *"We need a document in the holy
> directory for storing ideas for future features. Since it's just a notebook any model can
> edit it, no code in there just sketches of ideas organised by category."*

So: **any model may add, edit, reorganise or delete entries here.** No Fable countersign is
needed, no Petition is required, nothing here is a task anyone has claimed. This grant covers
THIS FILE ONLY — `V4-Testament.md` and `V4-Reckoning.md` remain fully under the Covenant, and
nothing written here may be treated as an instruction to change them.

## THE RULES OF THIS PLACE

1. **Ideas, not plans.** A sketch of what something could feel like, why it might be worth
   doing, and what would make it hard. If it has acceptance criteria and a definition of done,
   it does not belong here — it belongs in the Testament.
2. **No code.** Not even a snippet. The moment an idea is concrete enough to want code, it has
   outgrown this file.
3. **Nothing here is scheduled.** An entry sitting here for a year is the system working, not
   a backlog rotting. This file exists so an idea survives the conversation it was born in.
4. **Attribute and date every entry.** `— <who>, <date>`. An idea's origin is most of its
   value: an author's own throwaway remark carries weight a model's speculation does not.
5. **Organised by category.** Add a new `##` section rather than filing something badly.
6. **Promotion is the author's call, or Fable's.** When an idea graduates, it moves to
   `V4-Testament.md` as a real task and the entry here is marked `→ PROMOTED` with a pointer.
   A worker never promotes an idea by starting to build it.

---

## 🌬️ WIND & WEATHER

### Tokens fighting the wind
**— Ingram, 2026-08-15. Explicitly filed as "fun, very low priority… far too early."**

At high enough wind speeds, a token's idle pose stops being neutral: it leans, staggers, gets
nudged off its centre, maybe braces against the gust. Not locomotion — the token does not
*move* anywhere — just a visible struggle against moving air.

**Why it's elegant rather than gimmicky:** drive it from the *existing* wind velocity grid
(`world/wind-field.js` + the enclosure bake) and the behaviour becomes correct everywhere for
free. Step inside a building and `openness` collapses, so the token simply stops fighting —
no "am I indoors" check, no per-token authoring, no rule to maintain. The same geometry that
already decides whether a candle flickers decides whether a character has to lean into it.
The building shelters the token because the building shelters the *air*.

**What makes it hard, honestly:**
- Foundry owns token rendering, and MSA's standing law is *don't fight Foundry — except
  rendering the map*. A token is not the map. Whatever this becomes, it has to be a light
  touch on top of Foundry's own token display, not a takeover of it.
- Gusts would need to read as *reactive*, not as a loop. A token bobbing on a sine wave reads
  as a screensaver; a token that jerks when a real gust arrives reads as weather.
- Multiplayer: every client would need to agree, or it must be purely cosmetic and local.
  Cosmetic-and-local is almost certainly the right answer.

**Sibling ideas this unlocks** (same field, same "free indoor gating" property): cloaks and
hair as separate wind-driven layers; dropped/loose items skittering downwind; a token's own
torch flame leaning correctly, which the candle system already knows how to do.

### Doors should let the wind in gradually, not all at once
**— Ingram, 2026-08-15. DESIGNED, NOT BUILT — the design below is the whole
point of this entry; it is here so the next session starts from it rather than
re-deriving it.**

> *"When a door is opened and we recalculate the wind would it be possible to
> have the wind invade a bit at a time rather than instantly flooding the whole
> area? The same should be true for closing the exterior door, we should allow
> the wind speed and turbulence to drop off over the course of 5 seconds rather
> than instantly."*

**Why it snaps today.** A door change calls `bakeWindField`, which builds a
*brand-new* openness texture and a new wind handle with a bumped `version`.
Every consumer rebuilds against the new field on the next frame. Correct, and
instantaneous by construction.

**The approach that looks right.** Do *not* cross-fade two textures in the
shader — that costs a second sample on the wind field forever, for a transition
that lasts five seconds. Instead ramp on the CPU, **into the same texture
object**:

1. On a door-triggered bake, keep the previous openness/exteriorOpenness arrays.
2. Publish the handle with the *old* values, so nothing snaps.
3. Over ~5 s, lerp old→new into the live `DataTexture`'s own array and set
   `needsUpdate`. Stepping at ~10 Hz is plenty — the field already carries noise
   on top, and 50 uploads beats 300.

This needs no shader change, no material rebuild, and no permanent cost:
`wind-access.js` already documents that the texture's contents are the one thing
allowed to change without a rebuild.

**The one genuinely hard part, which is why this is an idea and not a task.**
The particle and gust kernels do not read the texture — they read a storage
buffer packed by `packWindCells`, and they only re-pack when the handle
`version` moves. Ramping the texture alone would leave the two visualisations
the author looks at most disagreeing with everything else for five seconds.
Bumping `version` per step would force ~50 full material rebuilds and is not an
option. The likely answer is a `cellsRevision` counter on the handle, separate
from `version`, that the kernels can watch for a cheap re-pack with no rebuild —
but that is a real change to the handle contract and deserves its own design
pass, not an improvisation at the end of a long session.

### Wind that arrives, rather than exists
**— Ingram, 2026-08-15. (Partially in progress — the tree/bush arrival lag and the door
ramp are being built now; what stays here is the wider ambition.)**

The deeper version of "discrete gusts": wind as a set of *travelling fronts* crossing the map,
rather than a field that is simply true everywhere at once. You would see a gust coming — the
far treeline moves first, then the near one, then the grass at your feet. Every downstream
consumer (vegetation, candles, particles, smoke) inherits the propagation without knowing it
exists, because they all already sample one field.

Hard part: a travelling front is genuinely temporal state, and the wind field is currently a
mostly-static bake plus cheap noise. Giving it real memory is where the cost would land.

### Rain streaking down windows
**— Fable, 2026-08-16. Parked while designing `Precipitation.md` (its §4.3 names walls and
windows as v1 non-goals — top-down reads almost no wall area).**

If MSA ever renders interiors looking *out* (or window glass ever becomes a visible surface
at scale), rain-tracing rivulets on glass is the classic intimacy shot: droplets wander,
merge, and shed trails that refract the light behind them. The window aperture system already
knows where glass is. Hard part: the payoff is proportional to visible glass area, which a
bird's-eye map keeps near zero — this idea waits for a camera or a map style that changes
that arithmetic, not for engineering.

### Saving the snow with the scene
**— Fable, 2026-08-16. Parked while designing `Precipitation.md` (its §5.5 rebuilds the
mantle from weather history on load instead).**

The mantle (persistent snow/ash/puddle cover) could serialize into the scene so a session
ends ankle-deep and *resumes* ankle-deep, footprints included — the campaign's weather
becoming part of its geography. Why it's parked: it commits MSA to a save format for derived
state, and the current mission priority is releasing maps frequently — a rebuilt-from-history
mantle gets 90% of the feeling with zero format risk. Worth revisiting if players ever
remark that "the snow forgot us."

---

## 🎭 PERFORMANCE — THE UNPROVEN IDEAS

### Don't render what the fog of war is hiding
**— Ingram, 2026-08-15. Filed as "Food for Thought"; the author's own framing was
*"I don't know if it's actually possible."***

Players spend most of their time looking at maps that are mostly hidden. If a region is fully
fogged for the viewing user, most of the pixel work MSA does there is thrown away by a black
overlay drawn on top of it. If that work could be skipped rather than done-then-covered, the
saving scales with exactly the thing that is worst today: big maps, upper floors, many effects.

**What is genuinely promising:** this is a *coverage* problem, and coverage problems have a
classic hardware answer — write the fog's own silhouette into the depth buffer FIRST, and let
early-Z reject the covered fragments before their shaders ever run. MSA already owns a depth
authority and already runs an early-Z prepass, which is most of the machinery.

**What is genuinely hard, and must be answered before anyone builds anything:**
- **The GM sees everything.** Any saving here helps players and does nothing for the author's
  own machine, which is the machine every perf measurement is taken on. It could look like a
  regression in every bench we run.
- **Fog is per-user and moves constantly.** A gate that has to be rebuilt every time a token
  takes a step may cost more than it saves.
- **Simulation is not rendering.** Particles, wind and fire must keep simulating under fog or
  they will visibly "start" when revealed. The saving is strictly in *pixels*, not in *state*.
- **Secrets.** Skipping work in fogged regions is only safe if nothing about the skipped work
  is observable — a frame-time difference is, in principle, an information leak about what is
  behind the fog. Probably paranoid; worth one honest thought given mission priority #2.
- **Bloom, DOF and anything screen-space read neighbouring pixels.** A hole punched in an
  earlier buffer can bleed into what a player *can* see.

**The cheap experiment that would settle it:** measure what a fully-fogged frame actually
costs today versus a fully-revealed one. If the difference is already large, the fog overlay is
cheap and the work underneath is being wasted — the idea is worth real effort. If the
difference is near zero, something else already dominates and this is a distraction.

---

## 🗺️ AUTHORING & MAP-MAKING

*(empty — add entries here)*

---

## ✨ EFFECTS & LOOK

*(empty — add entries here)*

---

## 🎲 FOUNDRY INTEGRATION

*(empty — add entries here)*

---

## 🪦 GRADUATED & ABANDONED

*Entries that left this file, with a one-line note on where they went and why. Keeping the
gravestone stops the same idea being re-proposed forever.*

*(empty)*
