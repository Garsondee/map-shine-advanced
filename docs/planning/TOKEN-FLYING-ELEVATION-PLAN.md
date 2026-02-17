# Token Flying + Elevation Visualization Plan

## Status
- Phase: Planning Draft (Session 1)
- Priority: High (readability + tactical correctness)
- Scope: Flying movement families, elevation visualization, and tile/surface indicators

---

## 1) Goals

1. Keep token movement highly characterful while preserving tactical readability.
2. Add flying styles that feel distinct from walking.
3. Represent token elevation clearly in-world and in UI.
4. Show which tile/surface a token is currently standing on (or nearest support surface).
5. Keep Foundry token document as the source of truth (`tokenDoc.elevation`).

---

## 2) Current System Baseline

### 2.1 What we already have
- Tokens are rendered as `THREE.Sprite` objects (billboarded).
- Token world Z currently maps to `groundZ + token.elevation` in both TokenManager and TokenMovementManager transform helpers.
- One flying style exists: `flying-glide` (placeholder) with hover rocking.
- Walk system now has multi-style profiles and style-driven motion channels.

### 2.2 Key constraints
- Sprite billboards do not support true mesh pitch/roll in the same way as planes/meshes.
- We can still create strong 3D-chip illusions via:
  - scale pulse/skew-like modulation,
  - lateral/vertical offsets,
  - rotational sway,
  - shadow + tether cues.

---

## 3) Elevation Model (Authoritative)

## 3.1 Data authority
- `tokenDoc.elevation` remains authoritative.
- Rendering should never invent persistent elevation values not reflected in Foundry docs.

## 3.2 Render mapping
- Keep world mapping deterministic:
  - `worldZ = groundZ + TOKEN_BASE_Z + tokenDoc.elevation`
- Any flying bob/hover must be visual-only offsets on top of that base.

## 3.3 Surface resolution model
To determine "stood on tile" indicators:
1. Gather candidate tiles whose XY bounds contain the token center.
2. Use displayed bounds (scale, rotation aware).
3. Pick support surface by elevation proximity rules:
   - Prefer tile with highest elevation <= token elevation.
   - If none qualify, mark support as "ground".
4. Expose support metadata:
   - `supportType`: ground | tile | overhead-tile
   - `supportTileId`
   - `supportElevation`

---

## 4) Flying Style Family Roadmap

## 4.1 Initial flying styles
1. **Flying - Hover Glide**
   - Smooth forward easing, small sinusoidal vertical drift.
2. **Flying - Banking Arc**
   - Strong lateral bank illusion in turns, wider turn settle.
3. **Flying - Flutter Burst**
   - Pulse-based short accelerations + lift pops.
4. **Flying - Soaring Float**
   - Long ease-in/out with gentle altitude wave.
5. **Flying - Chaotic Drift**
   - Controlled noise offsets with strict max displacement clamps.

## 4.2 Flying profile channels
- forward progress easing
- hover offset (Z)
- bank sway (rotation + scale illusion)
- drift noise
- settle at destination
- per-track deterministic random seed

---

## 5) Elevation UX + Indicators

## 5.1 Token elevation badge
- Small badge near token (or in HUD overlay) with:
  - current elevation value
  - support surface label (`Ground`, tile name, or tile id fallback)

## 5.2 In-world support cues
- Optional vertical tether line from token to support surface.
- Optional contact ring at support Z plane.
- Shadow softness/intensity can vary by height delta.

## 5.3 Clarity policy
- Keep indicators minimal by default.
- Expand details on hover/selection.
- Respect reduced-motion / reduced-clutter settings.

---

## 6) Implementation Phases

## Phase FE-1: Flying style expansion
- Add 4+ flying style IDs to style registry.
- Implement profile-driven flying sampler (parallel to walk profiles).
- Add deterministic per-track randomization controls.

## Phase FE-2: Elevation support resolver
- Add support-surface resolver service using tile bounds + elevation.
- Cache per-token support metadata and refresh on:
  - token move,
  - tile create/update/delete,
  - elevation changes.

## Phase FE-3: UI indicators
- Add lightweight elevation badge overlay for selected/hovered tokens.
- Add optional tether/contact visuals in-world.
- Add user settings toggles for indicator verbosity.

## Phase FE-4: Integration + hardening
- Integrate flying styles into actor-sheet style picker (or mode segmented picker).
- Add diagnostics for support selection and elevation deltas.
- QA in dense tile stacks + overhead scenes.

---

## 7) Acceptance Criteria

1. Flying styles are visibly distinct and readable.
2. Elevation representation is unambiguous in gameplay.
3. Users can identify what tile/surface a token is standing on.
4. Final token elevation always matches authoritative Foundry data.
5. Performance remains stable with multiple animated tokens.

---

## 8) Risks and Mitigations

1. **Ambiguous support tile in stacked tile scenes**
   - Mitigation: deterministic tie-breaks (elevation, sort key, overhead preference).
2. **Visual overload from indicators**
   - Mitigation: default-minimal overlays, hover/selection expansion.
3. **Billboard limitations for true 3D feel**
   - Mitigation: controlled pseudo-3D channels + future optional plane-mesh token mode.
4. **Cross-module elevation conflicts**
   - Mitigation: isolate support resolver, keep token docs authoritative, add debug traces.
