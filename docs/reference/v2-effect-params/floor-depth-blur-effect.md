# Floor depth blur

**V2 class:** `FloorDepthBlurEffect` · **Source:** `legacy/compositor-v2/effects/FloorDepthBlurEffect.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

When you are on an upper floor, the floors **below** you can be drawn softer (more blurred the further down they are), like a camera focused on your level. Your current floor stays sharp.

Only matters in **multi-floor** scenes. On the ground floor nothing changes.

Uses several fullscreen blur steps per lower level — **stronger blur or more repeats** can cost more GPU time. The **safety cap** keeps worst-case work bounded.

Settings save with the scene (not World Based).

## The knobs, in the author's words

- **Blur per level** — How strong the blur is for each step down (adds up for deeper floors).
- **Smoothness passes** — How many blur passes run per level — higher looks smoother, costs more.
- **Work limit** — Upper limit on total blur passes so performance stays under control.

## Authored presets

`Subtle` · `Moderate` · `Heavy`

## Controls, grouped as the author grouped them

### Look

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Blur per level (px) | `blurRadiusPx` | slider | 1 … 30 | 6 |  |
| | | | | | _How blurry each lower floor looks. Each floor down adds the same amount again._ |
| Smoothness passes | `itersPerDepth` | slider | 1 … 4 | 2 |  |
| | | | | | _More passes make the blur softer and less blocky; each pass is extra drawing work._ |
| Work limit | `maxIters` | slider | 2 … 12 | 6 |  |
| | | | | | _Stops the blur from running too many passes total, to protect frame rate._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | false | hidden |
