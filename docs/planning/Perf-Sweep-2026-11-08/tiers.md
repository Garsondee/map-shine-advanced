# Performance tiers: how they work, and the ledger

Written 2026-11-08 in the perf sweep (bead mmp-lr2). The ledger at the bottom is checked by
`src/effects/__tests__/tier-ledger.test.mjs`: a registered effect with no row, a row for an effect that does not
exist, or a row whose **Ladder** no longer matches the effect's manifest fails `npm run verify`.

## How tiers work

- **One knob for the player:** the client setting *Map Shine — Performance profile* (`effect-settings.js`), one of
  `low · performance · standard · quality · extreme`. The default is `standard`.
- **Each effect declares a ladder** in its manifest: `tiers: [{ n, cost: { class }, adds, fromProfile }, …]`.
  - Rung 0 is the cheapest look that is still right. Every profile gets it, and it has no `fromProfile`.
  - Each later rung names the lowest profile that buys it. Rungs add up: rung 3 includes rungs 1 and 2.
  - The validator (`effect-manifest.js`) checks that `fromProfile` and the cost class never go down from rung to rung.
- **Resolving the rung:** `resolveEffectTier` (`effect-cascade.js`) takes the highest unbroken rung the profile buys.
  The registry hands that to the effect as `perfTier`. This happens for every effect, automatically.
- **Using the rung:** each effect has a pure `xTierPlan(tier)` that turns the rung into flags and numbers
  (`fireTierPlan`, `lensTierPlan`, `fluidTierPlan` …). Builders branch on the plan in plain JS at build time (Law 4).
  A rung change therefore rebuilds the material, so the rung never changes per frame.
- **Default pin:** `X_DEFAULT_TIER` is the plan's fallback. `effect-tier.test.mjs` pins it to what `standard`
  resolves to, so a ladder change can never quietly restyle every scene.
- **Off below a profile:** `enabledFromProfile` switches a whole effect off under a profile (cloud tops below
  `standard`, prism below `extreme`). This sits on top of the ladder.
- **Measuring:** `MapShine.priceTiers('<id>')` prices each rung against rung 0 at the current view (GPU ms, p50).
  `MapShine.priceEffects()` prices whole effects.
- **Outside the ladder:** four systems read the profile string directly:
  - leaf-shed capacity
  - wind-trail mesh points
  - the render-scale governor's target fps
  - the albedo sharpen (`standard` and up)

  They follow the profile, but they are not in a manifest and `priceTiers` cannot price them.

## Rules (what a good ladder looks like)

1. **The default look is the top look people see.** The rung `standard` resolves to must reproduce the shipped
   look. Lower rungs may degrade, higher rungs may add.
2. **Cheapest look loss first.** Drop from the bottom up whatever costs most and is missed least: extra taps on
   soft data, update rate, resolution of blurred fields, particle counts. Drop the shape of things last.
3. **Every rung must save something measurable.** A rung that changes nothing is a broken rung. Mark it in the
   ledger until it is fixed.
4. **Degrade gracefully.** A lower rung must look like a simpler version of the effect, never a broken one: no
   missing pass, no black hole, no dead texture.
5. **Follow the profile.** No effect reads the profile string on its own when a rung would do. The four direct
   readers above are tolerated legacy.
6. **Same commit:** any substantial change to an effect's cost or look updates its tier plan, its manifest
   `tiers`, and its ledger row (Ladder, rung contents, Reviewed) in the same commit. The drift test catches a
   changed ladder. A changed cost is caught only by re-pricing (`MapShine.priceTiers`).

## Ledger

**Ladder** is the rung list as the drift test reads it: `0` for rung 0, then each rung's `fromProfile`.
**Follows** means the effect takes its rung from the profile automatically. **Cost** is `MapShine.priceTiers` on
the private rig (RTX 3070 Laptop, 1920×1080, render scale 1). The *Measured cost per rung* section below has the
numbers and the conditions. Blank means not measured.

| Effect | Ladder | Follows | What each rung adds (rung 0 = base) | Problems / notes | Reviewed |
|---|---|---|---|---|---|
| `apertureGobo` | `0` | n/a | single rung (cheap, C1) | none | 2026-11-08 @ 8ee2e71f |
| `bloom` | `0,performance` | yes | 0: 4-mip pyramid · 1: 6 mips | fine | 2026-11-08 @ 8ee2e71f |
| `candleFlame` | `0,low,performance,standard,extreme` | yes | 0: plain flame, lights merged ×2 · 1: two-octave flicker · 2: life, wind, snuff · 3: domain-warp sway, breathing light, merge ×0.5 · 4: near one light per candle | fine | 2026-11-08 @ 8ee2e71f |
| `clouds` | `0` | n/a | single rung (the cloud shadow field) | no ladder. The storybook decks' cost (three decks, shadow march) is not tiered: candidate | 2026-11-08 @ 8ee2e71f |
| `cloudTops` | `0` | on/off | single rung (C8), off below `standard` | no ladder | 2026-11-08 @ 8ee2e71f |
| `depthOfField` | `0,performance` | yes | 0: 2 pyramid levels · 1: 4 levels | fine | 2026-11-08 @ 8ee2e71f |
| `doorGraphics` | `0` | n/a | single rung (cheap) | none | 2026-11-08 @ 8ee2e71f |
| `dynamicRange` | `0` | n/a | single rung (16-tap meter, readback every 4th frame) | meter CPU cut 3.4 → 1.3 ms per reading this sweep (no look change). No ladder needed | 2026-11-08 @ 8ee2e71f |
| `fire` | `0,low,performance,standard,quality,extreme` | yes | 0: sprites ×0.35, lights merged ×2 · 1: ×0.6, ×1.5 · 2: ×0.8, ×1, full animation · 3: ×1, ×0.6 · 4: merge ×0.5 · 5: merge ×0.35 | Rungs 3–5 differ only in light merging. Plan fields `sheets, maxSlices, octaveCap, bands, smoke, shear` are dead in the live billow path. Smoke has no rung of its own (rides the sprite scale). Child bead | 2026-11-08 @ 8ee2e71f |
| `fluid` | `0,performance,standard,standard,standard,standard,standard,standard` | yes | 0: tinted mask · 1: cylinder · 2: (nothing, see notes) · 3: film · 4: fill sim · 5: structure · 6: bubbles · 7: light field | **Rung 2 saves nothing** (no flag). `standard` buys every rung at once, so the only real steps are low → performance → standard. Light field draw now skipped while the goo is dark (this sweep). Child bead | 2026-11-08 @ 8ee2e71f |
| `fogOfWar` | `0` | n/a | single rung | no ladder. Explored map up to 3072 px | 2026-11-08 @ 8ee2e71f |
| `grade` | `0` | n/a | single rung (LUT + tone map in the present) | no ladder; the present blit is the biggest single GPU pass on every map (2.0–2.5 ms on Big Bank and Docklands) | 2026-11-08 @ 8ee2e71f |
| `grid` | `0` | n/a | single rung | none | 2026-11-08 @ 8ee2e71f |
| `iridescence` | `0,performance,quality` | yes | 0: mask · 1: flow · 2: light reactivity | off below `extreme` by default (`enabledFromProfile`); stale comment says every upper rung needs `quality` | 2026-11-08 @ 8ee2e71f |
| `leafShed` | `0` | partial | single rung; capacity 512 → 4096 read straight from the profile | direct profile reader (tolerated) | 2026-11-08 @ 8ee2e71f |
| `lens` | `0,performance,quality,extreme` | yes | 0: distortion, **3-tap** fringe, **6-tap** starburst spokes (this sweep) · 1: spectral 5-tap fringe, 12-tap starburst, defocus pulses, motion blur · 2: light-burn buffer · 3: grime overlay | camera glare (bloom PSF + lens terms) rides the lens rung | 2026-11-08 @ 8ee2e71f |
| `lightning` | `0,low,low,performance` | yes | 0: bolts · 1: forks · 2: storm flash, strike shadows, shader quality · 3: strike point light | rungs 1 and 2 both `low`. Per-frame storm work now skipped at axis 0 (this sweep) | 2026-11-08 @ 8ee2e71f |
| `parallax` | `0` | n/a | single rung | off below `extreme` by default | 2026-11-08 @ 8ee2e71f |
| `precipitation` | `0,performance,standard` | yes | live-particle scale 0.4 / 0.7 / 1.0 | duplicate profile→scale function (`precipTierScaleForProfile`). Ground mist (Fog axis) has no rung: 8 noise octaves per pixel at full resolution, candidate | 2026-11-08 @ 8ee2e71f |
| `prism` | `0,performance,quality,extreme` | yes | 0: mask · 1: facets · 2: glint · 3: refraction capture | off below `extreme` by default; stale comment | 2026-11-08 @ 8ee2e71f |
| `specular` | `0,low,low,low,standard,standard` | yes | 0: plain presence · 1–3: shimmer, parallax, drift/life · 4–5: island parallax, sun-sky grain bias | rungs 1, 2 and 4 can't be reached by profile alone (harmless: groups are bought together) | 2026-11-08 @ 8ee2e71f |
| `stylize` | `0` | n/a | single rung | none | 2026-11-08 @ 8ee2e71f |
| `sunShadows` | `0,standard,quality,extreme` | yes | 0: 768² field, 16 steps · 1: 1536², 32 · 2: 2048², 48 · 3: 2048², 64 | off below `performance`; bake-time cost only | 2026-11-08 @ 8ee2e71f |
| `table` | `0` | n/a | single rung | none | 2026-11-08 @ 8ee2e71f |
| `temperatureEffects` | `0` | n/a | single rung | none | 2026-11-08 @ 8ee2e71f |
| `uiWindowShadow` | `0` | n/a | single rung (uniform push only) | none | 2026-11-08 @ 8ee2e71f |
| `vegetation` | `0,low,performance,standard,quality,extreme,extreme` | yes | 0: sway · 1: leaf flutter · 2: ground shadow, 3 taps · 3: 6 taps · 4: 9 · 5–6: 12 taps + lift sim | rung 5 can't be reached by profile; rung change applies on next load only | 2026-11-08 @ 8ee2e71f |
| `water` | `0,low,performance,standard,quality,quality` | yes | 0: mask · 1: depth ramp, wet band · 2: surface noise, foam · 3: GGX specular, sky · 4: shore foam, shoaling, caustics · 5: refraction capture | rung 4 can't be reached by profile; rung 5 falls back to 4 without a capture. **2026-11-11 pricing (perf-ledger/2026-11-10-effect-cost-sweep): the ladder saves nothing** - the wave/caustic pass and the sim tick (3.5-3.9 ms GPU) run at every rung, and rungs 4-5 price below rung 0. Caustic atlas now redraws every 2nd frame while the view is still (-2.4 ms on the dear frame). Needs a ladder for the wave system (atlas resolution, slice count) | 2026-11-11 @ 7975af01 |
| `window` | `0,performance` | yes | 0: no glass · 1: glass thickness field, five noise taps | window rain and snow have no rung (rain field on a worker) | 2026-11-08 @ 8ee2e71f |
| `windTrails` | `0` | partial | single rung; mesh points 24 → 320 read straight from the profile | direct profile reader (tolerated) | 2026-11-08 @ 8ee2e71f |
| `dust` | `0,performance,standard,quality,extreme` | yes | 0: half count, cheapest look · 1: ×0.75, body detail · 2: full count, lit, shadowed, depth of field · 3: sheen/trail extras · 4: ×1.5 count | fine | 2026-11-08 @ 8ee2e71f |
| `fireflies` | `0,performance,standard,quality,extreme` | yes | as dust (4: ×1.25 count), flash detail at 1 | fine | 2026-11-08 @ 8ee2e71f |
| `maggots` | `0,performance,standard,quality,extreme` | yes | reuses the fly ladder | fine | 2026-11-08 @ 8ee2e71f |
| `smellyFlies` | `0,performance,standard,quality,extreme` | yes | 0: half count · 1: ×0.75, legs/body · 2: full, lit, shadowed · 3: extras · 4: ×1.25 | fine | 2026-11-08 @ 8ee2e71f |

## Measured cost per rung

(filled from `MapShine.priceTiers` runs below)
