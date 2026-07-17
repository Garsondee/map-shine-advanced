# ASCII art

**V2 class:** `AsciiEffectV2` · **Source:** `legacy/compositor-v2/effects/AsciiEffectV2.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## What it did, in the author's words

Turns the map into letters and symbols, like old computer art or a “hacker” screen. It looks at your picture, picks matching characters, and can gently shuffle them over time.

Works on the whole finished image. No special map layers needed.

If letters keep changing, the scene may run a bit more often for smooth motion — turn **Letter shuffle** down to zero for a still image.

Settings save with the scene (not World Based).

## The knobs, in the author's words

- **Grid detail** — How many letter columns you get — higher means smaller letters.
- **Row height** — How tall each row of letters is.
- **Effect strength** — How much you see the letters versus the normal map.
- **Letter shuffle** — How often letters are re-picked (living / glitchy look).
- **Hybrid mode** — A style that mixes shaded blocks with simple text on top.

## Authored presets

`Chunky letters` · `Fine detail` · `Code rain look`

## Controls, grouped as the author grouped them

### Picture

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Grid detail | `resolution` | slider | 0.05 … 0.5 | 0.12 |  |
| | | | | | _How many letter columns across the screen. Higher means smaller letters and more detail._ |
| Row height | `lineHeight` | slider | 0.5 … 4 | 1.5 |  |
| | | | | | _How tall each row is. Higher spreads rows apart and changes the letter shapes._ |
| Effect strength | `opacity` | slider | 0 … 1 | 0.95 |  |
| | | | | | _How strong the letter picture is compared to the normal map underneath._ |

### Letter shape _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Letter width | `glyphScaleX` | slider | 0.25 … 1.5 | 1.15 |  |
| | | | | | _Stretch letters wider or narrower inside each cell._ |
| Letter height | `glyphScaleY` | slider | 0.25 … 1.5 | 0.95 |  |
| | | | | | _Stretch letters taller or shorter inside each cell._ |

### Spacing _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Side padding | `cellPaddingX` | slider | 0 … 0.45 | 0.15 |  |
| | | | | | _Empty space on the left and right inside each letter box._ |
| Top/bottom padding | `cellPaddingY` | slider | 0 … 0.45 | 0.15 |  |
| | | | | | _Empty space above and below inside each letter box._ |

### Look & motion

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Character style | `charSet` | list | Simple / Detailed / Matrix / Blocks / Hybrid (Block+Simple) | detailed |  |
| | | | | | _Which symbols are used to draw the picture. Hybrid mixes blocks and simple letters._ |
| Keep map colors | `color` | boolean |  | true |  |
| | | | | | _On: letters keep your map’s colors. Off: gray shades only._ |
| Invert light/dark | `invert` | boolean |  | false |  |
| | | | | | _Swap bright and dark areas, like a photo negative._ |
| Letter shuffle | `churn` | slider | 0 … 1 | 0.72 |  |
| | | | | | _How much letters keep changing. Zero keeps a steady picture._ |
| Shuffle speed | `churnSpeed` | slider | 0.25 … 30 | 0.75 |  |
| | | | | | _How fast letters change when shuffle is turned up._ |

### Hybrid mode _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Block strength | `blockOpacity` | slider | 0 … 1 | 0.4 |  |
| | | | | | _For Hybrid style: how strong the shaded block layer is behind the letters._ |
| Letter strength | `textOpacity` | slider | 0 … 1 | 1 |  |
| | | | | | _For Hybrid style: how strong the letters are on top of the blocks._ |

### Brightness & contrast _(advanced)_

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| Shadow depth | `blackPoint` | slider | 0 … 1 | 0 |  |
| | | | | | _Treat more of the dark areas as “fully black” before picking letters._ |
| Highlight point | `whitePoint` | slider | 0 … 1 | 0.82 |  |
| | | | | | _How bright something must be before it counts as a full highlight._ |
| Contrast | `contrast` | slider | 0 … 2 | 1.66 |  |
| | | | | | _More contrast: shadows and lights look farther apart. Less: flatter, softer._ |
| Brightness | `brightness` | slider | -0.5 … 0.5 | 0.18 |  |
| | | | | | _Lighten or darken the whole picture before it becomes letters._ |

### Ungrouped

| Control | id | Type | Range | Default | Notes |
|---|---|---|---|---|---|
| enabled | `enabled` | boolean |  | false | hidden |
