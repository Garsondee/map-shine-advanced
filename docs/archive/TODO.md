# Map Shine Advanced — TODO

Items that should be considered at the end of a successfully resolved task. Add anything that is important to revisit but is not strictly required to complete the active task.

---

### Section 0: HIGHEST PRIORITY

00. Small bug found. When copying a door wall it will also duplicate a normal wall when I paste. So I'm trying to just copy a door, I select the door wall section, I copy, then I paste and when I do I've pasted a normal wall and also pasted a door of the correct data.

0. **Fire particles are broken on higher floors than the ground floor**

0b. **Water thinks it's indoors** - When I start on a map with a lot of water but I start on a higher floor than the ground floor (where the valid _Water mask is) then all the water believe it's indoors rather than outdoors.

0c. **Consider some of the ideas in this document** - @ideas.md

0d. **Window Light Time of Day Effects** - How about we add an optional effect which is enabled by default which brightens or darkens the window light depending on the suns current angle so that eastern windows are lit by an eastern sun and western windows would be darker. Will add some time of day animation by having the amount of window light vary depending on time of day.

0e. **Specular Revamp** - Consider how to create the best looking, most interesting or fun effect for specular. Consider bringing in reflection map colours or other concepts. How do we make the richest most satisfying, evolving and passively animating effect?











### Section 1: Workspace & Development Environment
1. **Foundry VTT Install Directory (INGRAM HIGHEST PRIORITY):** You must add the Foundry VTT install location as a folder for this workspace. This will allow the use of the most recent, up-to-date version of Foundry and all modules. This is a user task, not an LLM task.

### Section 2: Multi-Level & Elevation Issues
2. **Light Floor Bleeding & Elevation:** Lights configured/created on one floor are bleeding into others. Specifically, lights on floors ABOVE sometimes appear on levels/floors below, and lights with visibility set to only one floor still appear on the floor below. Lights created on basement floors do *not* appear on upper floors. 
    *   *Context:* Ground floor is elevation 0 to 20; basement is -20 to 0. Lights default to elevation 0 (registering to both). We are currently ignoring the dropdown list used to assign lights to specific floors. Strangely, this is only happening on one map.
3. **Floor Transition Performance:** Improve the speed and efficiency of moving between floors/levels in a scene. This is a CRITICAL usability improvement. 
    *   *Questions/Fixes:* Do we actually need to recompile shaders between floors? What can be done to speed this up? It sometimes gets stuck on "Warming Up" — can we make this autorecovering? Also, fix the timer meant to show how long the loading process takes, as it currently doesn't work.

### Section 3: Core Lighting Mechanics & Config
4. **Scene Darkness Automation:** Lights designed to turn on/off based on scene darkness are failing. A light set to turn on between 0 and 0.9 darkness is always off, but between 0 and 1 it stays on. 
    *   *Action:* Conduct a full audit of 'Scene Darkness' and its interactions. Make this system more robust. (Theory: scene darkness 1 might be occurring a long time before midnight).
5. **Copy-Pasted Light Rendering:** Lights copied and pasted into a scene do not render with their true final config immediately. They look different (and BETTER) only after refreshing Foundry. Ensure lights render correctly upon pasting.
6. **Token 'Player Light' Persistence:** Tokens are currently failing to remember their 'Player Light' settings between play sessions.

### Section 4: Fog of War (FoW)
8. **FoW State Saving:** Fog of War is not saving correctly. Explored regions not currently in view are completely black and obscured, so tokens lose the record of where they've been. 
    *   *Action:* Reintroduce the 500ms cadence Foundry VTT system that saved the FoW state, or build a custom FoW saving machine. Either way we need to be mindful of performance.
9. **FoW Layering with Foliage:** Bushes and trees are rendering incorrectly above the Fog of War. When walking a token past a one-way terrain wall, the bushes remain visible in the solid FoW behind the token. Unselecting and reselecting the token fixes it. Check foliage layering/timing interactions with FoW.

### Section 5: Map Points (Fires/Candles) & UI
10. **Map Point Optimization (No Global Refresh):** Using the Map Point Control to turn off a single candle causes *all* candles and fires to pause and rebuild. Find a way to toggle a single part of this effect without forcing a global refresh.
11. **Map Point Ring UI Bugs & Size:** ~~Fix Map Point creation/editing bugs: If you create a map point group and hit Enter, the rings disappear. If you *edit* a group, add a point, and hit Enter, the rings stay visible. Additionally, make the map point ring symbols smaller and simpler, as clustered candles cause overlapping rings that make placing the next point difficult.~~ *(2026-06: smaller shared marker geometry + Enter-on-create now restores visual helpers.)*

### Section 6: Foliage, Weather, Environment & Sky
13. **Cloud Scene-Swap Bug:** Swapping from one scene to another via activation turns clouds into black meshes with no texture. Resetting clouds to default doesn't fix it; only a full refresh of the Foundry web page resolves it.
14. **Cloud Performance / Indoors Culling:** If a scene level is entirely black for the `_Outdoors` mask (meaning the whole level is indoors or underground), stop rendering cloud tops and stop simulating clouds entirely to save performance.
15. **Tree/Bush Wind Physics & Distortion:** Foliage looks too "liquid". They look good at full wind but suffer from too high-frequency distortion at lower wind values. There is also a "boiling" animation bug: changing the vertical wind slider causes bushes/trees to rapidly distort before finally settling down.
16. **Foliage Lighting Physics:** The 'Light Physics: Day Ambient - Outdoors' setting is not currently affecting trees and bushes as expected.
17. **Weather Fragment Shaders:** Foundry VTT has native fragment shader approaches for blizzard, snow, and rain. Include copies of these that run when these effects are toggled on to provide cheap, efficient weather effects.
19. **Dust Particle Optimization:** Optimize dust spawns by focusing spawning heavily where the camera is currently looking, and cull dust particles that are off-screen.

### Section 7: Masking & Layers
20. **Fire Glow Overhead Masking:** Fire glows are currently appearing ABOVE overhead tiles incorrectly. This is also true of heat distortion from flames, they appear to be effecting rooftops above the fire which isn't correct.
    *   *Action:* If the `_Fire` mask is on an overhead layer, it should appear above. However, if the `_Fire` texture is on a ground/background image/tile (not set to overhead), ensure the glow is properly masked by the objects/tiles above it.

### Section 8: PIXI Graphics

21. **PIXI Token Selection Border** Sometimes I can see two orange selection boxes for tokens. I think this might be a result of tokens being on floors which are negative in terms of elevation or things like that. Worth a full audit, we only want a single selection orange box around tokens.

### Section 9: Performance Issues

22. **Fire Performance Issues** Fire remains the worst offender for lower scene performance.

23. **Roof Drips** This system is a VERY painful performance reducer. We need a new approach.

24. **Performance Issues** - Investigate the following in depth.

There is a WEBGL_Crash.md report which shows a failure of the rendering in a very large scene. We needs to make the system more robust. Memory is almost exhausted currently.

water.postMerge.occluderBuild - This system is causing a HUGE performance drop on a map with no _Water textures.

Roof drips is painfully performance destroying.

Look at performance_issues.md and performance_issues_02.md - this file contains a full record of performance issues on a very large map, including irregular pacing.

Tree and bush shadows cause performance loss on very large maps.

25. **Tile Streaming**

Breaking large tiles/background images/foreground images into tiles and then only rendering the tiles which are currently in the camera fustrum.

Add a 'mini-map' during develop of this texture streaming system. The goal is to use the mini-map as a debugging tool initially, it would show the whole scene + padded region, the camera fustrum and it would have a low resolution version of the textures for the background/foreground of the scene on it. It would be designed to layer these in the same way that they do in the scene to create an accurate mini-map based on the current scene. Then the idea would be to use it as a debug tool, have it split up into a grid to show where the textures are being shown, which ones are active, which ones are culled and anything in between. Even after the debugging work is done the mini-map (without debugging information) may turn out to be a nice to have feature if it's made optional for players and GMs seperately.

We'd also need a system for intelligently lowering the resolution of textures once you zoom the camera out to accomodate for zoomed out performance. This would have to happen in a way that didn't look bad or didn't visibly lower the scene resolution.

Also investigate 'Channel Packing' for more efficient mask use. Remember that things like window light needs RGB for it to work but _Fire and things like that are just black, white and transparency pixels.

KTX2/Basis - Investigate this for producing GPU compressed textures. Investigate ETC1S for masks.

26. **Untracked mask-bundle source texture cache (VRAM monitoring)** - `loader.js` `textureCache` retains raw mask/albedo source images (keyed by path) for cross-scene/floor reuse. On the RTX 3070 (8 GB) crash investigation these showed as ~31 alive, disposed 0 — real VRAM that is NOT counted in the software texture budget (shows up as `untrackedEstimate` in crash reports). It is not the primary crash cause (scene-space masks were, now VRAM-capped in `texture-budget-policy.js`), and disposing them naively would force reloads. Follow-up: consider (a) an LRU cap / idle eviction on this cache for large multi-scene sessions, or (b) registering these source textures in the budget tracker so total resident VRAM is fully accounted. Revisit if crash reports still show a large untracked-texture gap after the mask cap ships.

27. **Reduce compositor render-target VRAM so 4K fits on 8 GB (raise the resolution cap)** - The 4K crash on the RTX 3070 was caused by the full-screen render-target stack (~2.3 GB single-floor at native 4K), which is untracked by the texture budget. We now bound it with a persistent VRAM-driven drawing-buffer cap (`resolveMaxDrawingBufferMp` in `texture-budget-policy.js`, applied in `GraphicsSettingsManager._applyVramPixelRatioCap`). This caps an 8 GB card to ~3.5 MP (roughly 1440p) which is a real quality reduction vs native 4K. To let 8 GB cards render closer to true 4K, reduce the per-MP RT cost on constrained GPUs, then relax `resolveCompositorRtBudgetMB` / `RT_MB_PER_DRAWING_BUFFER_MP_BASE`. Highest-impact, from the RT audit: (a) `OverheadStampEffectV2` holds ~19 full-screen RGBA8 targets (~458 MB at 4K) — many are mask/projection buffers that could run at 0.5x; (b) `LightingEffectV2.internalLightResolutionScale` defaults to 1.0 — lighting is low-frequency, 0.75/0.5 on <=8 GB saves ~200-290 MB with per-floor snapshots; (c) `FloorDepthBlurEffect` (~193 MB) and replica/vegetation occlusion passes (~241 MB) could be half-res on constrained GPUs. Each reduction lets the drawing-buffer cap rise. Also consider surfacing the effective (capped) render resolution in the in-scene Performance graphics panel so users understand why "native" may render below 4K on their card.

NEVER render/composite at map resolution. Your render targets should be viewport-sized, not 12000 x 12000.

My practical recommendation for MSA would be:

Add a preprocessing/export step that creates tiled pyramids per floor.
Render the active floor from visible tiles only.
Keep a low-res fallback whole-floor texture for loading and zoomed-out views.
Pack masks into RGBA atlases by tile.
Use KTX2 for mask/normal/material layers where acceptable.
Add a texture budget manager: “max active tile memory”, with LRU eviction.
Detect renderer.capabilities.maxTextureSize and GPU tier, then choose tile size / quality automatically.

27. **Vegetation streaming cell overlays (Tree/Bush):** Per-cell background overlays were attempted but `upgradeWindDisplacedGeometry` rebuilds UVs 0–1 against the full 12k mask, duplicating canopies on every tile. Future approach: either crop clump/mask bake per cell before wind mesh upgrade, or shader discard by streaming cell world bounds — keep single full-scene overlay + streaming gate until then.


28. **Loading screen stage labels:** Audit `createThreeCanvas` overlay messages and stage lozenges — user reports confusing text (`Loading Animated Tree Canopy`, `loading FireEffectV2`, `effect / wiring skipped`) that may reflect stale V1 init order rather than actual V2 load phases. See `Docs/investigations/module-loading-investigation.md` Part 4 pending list.


### Section 9: Default Settings

26. **Default Settings** When enabling a scene for Map Shine Advanced it's currently not applying very good scene settings AND it doesn't seem to reload with the correct scene settings. If I refresh the browser again after setting a scene to use Map Shine Advanced then the next time it reloads the scene has better config.

---

# LLM Generated TODOs must go below this line for clarity. Please don't give me testing tasks here, just leave them in your output conversation.

- **Tweakpane UX reorganization:** Strategy in `Docs/tweakpane-ux-reorganization-strategy.md`; baseline inventory in `Docs/tweakpane-main-config-controls-report.md`. Phased rollout — start with Quick Actions grouping + label/prefix cleanup (Phase 1–2) before shadow/vegetation merges.

- **Streaming speed overhaul (2026-06):** After confirming cold/warm pan behaviour on a 12000² scene, bump `module.json` version. If workers fail in some browsers, check console for `TileDecodePool worker error` and verify legacy fallback still loads tiles (slower).

- **Scene-switch texture leak (`loadTextureAsync`):** Customer crash report (2026-06) showed WebGL context loss with ~350 climbing GPU textures; leak probe top site was `loadTextureAsync` (31 alive / 0 disposed) during scene fade-in while populate incomplete. Investigate disposing probe/base-texture loads on `destroyThreeCanvas` / scene teardown without nuking the intentional asset-bundle cache.
