# GridRenderer

**V2 class:** `GridRenderer` · **Source:** `legacy/scene/grid-renderer.js`

**Rebuilt in V3 as:** `post.grade`

> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were for, and what they were called. That is what this page is for.

## Controls

| Control                     | id                        | Type       | Range                                                                                     | Default     | Notes |
| --------------------------- | ------------------------- | ---------- | ----------------------------------------------------------------------------------------- | ----------- | ----- |
| Style (Override)            | `style`                   | (inferred) | Solid Lines / Dashed Lines / Dotted Lines / Square Points / Diamond Points / Round Points | dashedLines |       |
| Override Style              | `useStyleOverride`        | (inferred) |                                                                                           | true        |       |
| Thickness (Override)        | `thickness`               | (inferred) | 1 … 10                                                                                    | 2           |       |
| Override Thickness          | `useThicknessOverride`    | (inferred) |                                                                                           | true        |       |
| Color (Override)            | `colorOverride`           | (inferred) |                                                                                           | #000000     |       |
| Override Color              | `useColorOverride`        | (inferred) |                                                                                           | true        |       |
| Opacity (Override)          | `alphaOverride`           | (inferred) | 0 … 1                                                                                     | 0.15        |       |
| Override Opacity            | `useAlphaOverride`        | (inferred) |                                                                                           | true        |       |
| Show Adjacent Floor Grids   | `ghostGridEnabled`        | (inferred) |                                                                                           | true        |       |
| Adjacent Grid Opacity Scale | `ghostGridAlphaScale`     | (inferred) | 0 … 1                                                                                     | 0.22        |       |
| Floor Color Tinting         | `floorTintPresetsEnabled` | (inferred) |                                                                                           | true        |       |
