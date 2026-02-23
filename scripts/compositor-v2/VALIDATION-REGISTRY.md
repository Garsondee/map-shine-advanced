# Compositor V2 — Effect Validation Registry

Single source of truth for which effects have been validated against the v2 alpha contract.

## Validation Status

| Effect | Status | Validated In | Notes |
|---|---|---|---|
| *(none yet)* | — | — | Step 0 scaffold complete. Effects validated starting Step 3. |

## Validation Criteria

An effect is **VALIDATED** when it passes ALL of the following:

1. **Alpha preservation**: `output.a == input.a` at every pixel (checked via readback test).
2. **Premultiplied invariant**: Where `alpha = 0`, `RGB = 0` (no ambient leakage).
3. **No visual regression**: Before/after screenshots match (manual check).
4. **Multi-floor correctness**: Effect renders correctly on floor 0 AND upper floors with transparent gaps.

## Migration Checklist

When an effect passes validation:

1. Copy from `scripts/effects/` to `scripts/compositor-v2/effects/`.
2. Apply any v2 fixes (alpha contract enforcement) to the copy.
3. Update this table.
4. `FloorCompositor` imports from `compositor-v2/effects/`.
