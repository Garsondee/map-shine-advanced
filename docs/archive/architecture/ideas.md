This is an incredibly impressive and mature architecture. You have essentially built a full custom 2.5D game engine that lives cooperatively inside a VTT, and you've already implemented most of the standard optimizations (frustum streaming, object pooling, idle throttling, lazy init, HDR float buffers).
To push this to the next tier of performance—specifically for massive, multi-floored scenes with hundreds of lights, walls, and effects—you need to look at techniques used in modern AAA engines to decouple scene complexity from render cost.
Here are the "big picture" engine-level features you are currently missing:

1. 2D SDF (Signed Distance Field) GPU Shadows & Vision
   Currently, Foundry relies on CPU-side raycasting to generate 2D polygons for Point Source (light/vision) occlusions. Even with your VisionPolygonComputer object pooling, doing this on the CPU for 100 moving lights and tokens across multiple floors is a hard bottleneck.
   The Idea: Generate a 2D SDF texture of your walls per floor. Whenever walls change, render the wall line segments into an offscreen render target and run a Jump Flooding Algorithm (JFA) shader to create a distance field texture.
   The Benefit: Once you have the SDF, all lights and vision can calculate pixel-perfect soft shadows entirely on the GPU in a single pass via raymarching. You completely bypass Foundry's polygon generation for rendering. A GPU can raymarch an SDF for 200 lights at 4K resolution faster than a CPU can calculate the math for 10 light polygons.
   Application: Inject this into ShadowManagerV2 and LightingEffectV2.
2. Clustered / Tile-Based Deferred Lighting
   Your LightingEffectV2 uses a CPU ambient compose and renders dynamic Foundry lights. If lights are currently rendered as additive quads (or similar forward-shading geometry), your GPU fill-rate will collapse in scenes with 50+ overlapping lights (e.g., a multi-floor tavern with candles everywhere), because every pixel is redrawn for every light covering it, multiplied by the number of active floors.
   The Idea: Move to Tile-Based Forward or Deferred Shading. Divide the screen into a grid (e.g., 16x16 pixel tiles). Compute which lights intersect which tiles on the CPU, upload that list as a DataTexture. In your lighting shader, a fragment only loops through the lights assigned to its specific tile.
   The Benefit: Fill rate becomes completely independent of the number of lights on the screen. 500 lights will perform almost exactly identically to 50 lights.
3. Hi-Z (Hierarchical Z-Buffer) Inter-Floor Occlusion Culling
   You are alpha-blending floors bottom-to-top (LevelCompositePass). If a player is on Floor 5, and the roof is fully opaque except for a single stairwell, your engine is currently still paying the GPU cost to render Floors 1, 2, 3, and 4 (albedo, effects, water) just to cover 95% of them up with Floor 5's pixels.
   The Idea: Create a low-resolution Hierarchical Z-Buffer of the highest active floor's opacity. Before rendering a lower floor in \_renderPerLevelPipeline, evaluate the tile's bounding box against the Hi-Z buffer.
   The Benefit: If the upper floor's geometry completely occludes a lower-floor tile, that tile is culled before it ever hits the FloorRenderBus. In a multi-floor dungeon, this can instantly eliminate 80% of draw calls and pixel shading on lower floors.
4. GPU-Compressed Textures (KTX2 / Basis Universal)
   Your TextureBudgetTracker is fighting a losing battle against VRAM by downscaling standard image formats (PNG/WebP/JPEG) at 80% capacity. An RGBA WebP might be 2MB on disk, but when uncompressed into VRAM for rendering, a 4096x4096px texture consumes 67 MB of VRAM. A multi-floor scene with albedo, specular, normal, and water masks for 5 floors will obliterate integrated GPUs and cause massive GC stutter.
   The Idea: Implement a Web Worker pipeline using Basis Universal / KTX2. When AssetLoader grabs a WebP, hand it to a worker to transcode into a native GPU compression format (DXT, ASTC, ETC2 depending on the user's hardware) before uploading it to Three.js.
   The Benefit: GPU-compressed textures stay compressed in VRAM. That 67 MB texture drops to ~11 MB (a 6x reduction in VRAM footprint and memory bandwidth). You could load 6 times as many floors/masks before the budget tracker ever needs to trigger. Three.js has native support for this via KTX2Loader.
5. Multi-Threaded Heavy Computation (Web Workers + SharedArrayBuffer)
   Your render-loop.js maintains a smooth RAF, but operations like NavMeshBuilder, MultiFloorGraph pathfinding (A*), and FoundryFogBridge data extraction run on the main thread. A complex pathfinding request across 3 floors can easily cause a 20ms+ frame drop.
   The Idea: Offload all math-heavy non-DOM/non-Foundry data to Web Workers. MultiFloorGraph and NavMeshPathfinder are pure math.
   The Benefit: Zero frame stutter during complex interactions. You send the destination coordinates to the worker, the engine renders a "thinking" ghost path, and 3 frames later the worker returns the final A* path. (Note: Due to VTT module constraints, you may not always have SharedArrayBuffer enabled by the host server, but standard Worker postMessage with Transferable Objects for arrays is incredibly fast).
6. BatchedMesh for Static Geometry (Draw Call Reduction)
   Your FloorRenderBus puts every tile, overhead, and effect into layers, and LayerOrderPolicy ensures correct Z-sorting. However, if a map creator builds a scene using 500 individual floor tiles, 300 wall segments, and 200 candle map points, that's 1000 draw calls per floor.
   The Idea: Three.js r159+ introduced THREE.BatchedMesh. Identify static, non-moving assets (like grid textures, stationary map-point particles, modular floor tiles) and merge them into a single BatchedMesh.
   The Benefit: Drops draw calls from hundreds down to 1. WebGL2 is heavily CPU-bound by draw calls; batching identical geometries or materials allows the CPU to sleep more and keeps the GPU fed.
7. Abstracting Toward WebGPU (Compute Pipelines)
   While WebGL2 is your current target, WebGL2 is effectively a dead standard; Apple, Google, and Mozilla are fully focused on WebGPU. WebGPU will immediately solve your multi-floor scaling issues via Compute Shaders and Render Bundles (which cache the exact sequence of V2 compositing steps so the CPU does zero work submitting them).
   The Idea: Start abstracting your stateful WebGL passes (like GpuSceneMaskCompositor and LevelRenderTargetPool) to think in terms of immutable state pipelines. Ensure your V2 shader chunks are structured in a way that can be easily transpiled to WGSL down the line. (Three.js's new WebGPURenderer / NodeMaterial system is already doing this heavily in r170).
   Summary Priority List
   If I were managing this architecture, I would prioritize them in this order:
   KTX2/Basis Texture Compression (Immediate, massive relief for VRAM, fixes crashes on potato laptops).
   SDF Global Illumination / Shadows (Replaces the ugliest CPU bottleneck—LOS polygons—with blazingly fast GPU math).
   Tile-Based Light Culling (Allows GMs to place unlimited lights without destroying fill-rate).
   Hi-Z Inter-Floor Culling (The holy grail for making an 8-floor megadungeon run as fast as a 1-floor map).
