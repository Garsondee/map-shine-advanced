# Planned Features

## Mouse-Tethered Personal Specular Light

- **Summary**: A purely visual, client-local dynamic light tied to the player’s mouse cursor that interacts with Map Shine’s PBR/specular pipeline without modifying Foundry’s native lighting or scene data.
- **Behavior**:
  - For players only, the mouse cursor controls a virtual point light that illuminates nearby surfaces, emphasizing specular highlights and normal maps.
  - The light is **tethered to the player’s own character token**: as the cursor moves away from the token beyond a configurable radius, the light gutters and fades out like a dying torch.
  - When the cursor returns within range, the light reignites with a smooth fade-in / flare.
  - Each user sees only their own mouse light; it is **not synchronized** across clients.
- **Technical Notes**:
  - Implemented as a shader-driven point light contribution in the material/specular pass (e.g., extending `SpecularEffect`), not as a Foundry light source.
  - Uses mouse position → world position conversion and distance to the user’s active/owned token to drive intensity and falloff.
  - Driven entirely via the centralized `TimeManager` for animation (flicker, guttering, reignition), with no impact on Foundry’s fog of war or visibility logic.
- **Status**: Concept only — not implemented.
