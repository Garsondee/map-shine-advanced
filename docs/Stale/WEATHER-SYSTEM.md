WEATHER-SYSTEM.MD
1. Core Philosophy

"Cinematic Plausibility over Physical Simulation."
We are not simulating thermodynamics; we are compositing layers of visual effects to sell the feeling of weather. The system operates on a "Global State" pushed to GPU uniforms, ensuring all shaders (terrain, particles, sky, water) react synchronously to the changing conditions.
2. Architecture: The WeatherController

A singleton class that manages the state of the simulation.
Data Model

The weather is defined by a WeatherState object, which interpolates between two states: Current and Target.
code JavaScript

    
struct WeatherState {
    precipitation: float; // 0.0 (dry) to 1.0 (monsoon)
    precipType: enum;     // RAIN, SNOW, HAIL, ASH
    cloudCover: float;    // 0.0 (clear) to 1.0 (overcast)
    windSpeed: float;     // 0.0 to 1.0 (hurricane)
    windDirection: vec2;  // Normalized 2D vector
    fogDensity: float;    // 0.0 to 1.0
    wetness: float;       // Accumulation logic (lagging behind precipitation)
    freezeLevel: float;   // Determines if accumulation is puddles or snow
}

  

The "Wanderer" Loop

To prevent static weather, the controller uses 1D Simplex Noise sampled over Time to add micro-variations to the Current state.

    GM Control: Variability (float). High variability increases the amplitude of the noise added to the wind speed and direction.

Transition System

    GM Control: setWeather(preset, duration).

    The engine runs a tween Current -> Target over duration.

    Color Grading Integration: Weather presets include Look Up Tables (LUTs) for post-processing (e.g., "Storm" desaturates and adds blue tint; "Heatwave" blooms and shifts orange).

3. The Indoor/Outdoor Mask (The "Roof Map")

This is critical for 2.5D logic. We cannot use CPU raycasting for thousands of rain particles.

Implementation:

    Generation: An Orthographic Camera renders the scene from top-down into a low-resolution R8 Texture (e.g., 1024x1024).

        Layering: Render only "Roof" and "Cover" layers white. Render "Ground" and "Interiors" black.

        This texture covers the playable bounds.

    Usage: This texture is passed to all weather shaders (Rain, Snow, Ground Puddles).

        Logic: float roofCover = texture(tRoofMap, worldPos.xz).r;

        If roofCover > 0.5, rain particles die/fade, and puddles do not accumulate.

4. Volumetrics: Clouds & Fog (The "Sandwich" Approach)

We use a dual-layer approach to handle the camera zoom requirements.
Layer A: The Raymarched Sky (High Altitude)

    Geometry: A large plane or flattened cube floating significantly above the map.

    Technique: Limited Raymarching (steps < 16) through a 3D Noise Texture.

    Performance Hack: We do not raymarch the whole scene. We raymarch a "slab".

    Zoom Interaction:

        Uniform: uZoomLevel (0.0 = Zoomed In, 1.0 = Zoomed Out).

        Cloud Opacity = smoothstep(0.2, 0.8, uZoomLevel).

        When zoomed in, the clouds physically disappear to prevent obscuring gameplay tokens.

Layer B: The Shadow Projector (Ground Level)

    Concept: When clouds disappear on Zoom In, we shouldn't lose the feeling of clouds. We replace them with their shadows.

    Technique: We do not use shadow maps for clouds (too expensive). We project the same 2D noise texture used for the cloud generation onto the ground plane shader.

    Blurring: The noise texture is sampled with a lower mipmap level or a box blur in the shader to simulate soft shadows from high-up clouds.

    Wind Offset: uv += uTime * uWindVector.

Layer C: Dynamic Fog

    Height-Based Fog: Standard distance fog looks bad in top-down. We use a custom EXP2 fog that considers WorldPosition.y.

    Volumetric Feel: We mix the fog color with the ambient light color and a "scatter" color (based on Sun direction) to simulate light punching through mist.

5. Precipitation (Rain & Snow)

We use GPU Instancing with a double-buffer approach to simulate millions of drops cheaply.
The Particle System

    Geometry: A single InstancedBufferGeometry.

    Emitter: The emitter is a box attached to the Camera. As the camera moves, the box moves.

    Shader Logic (The "Infinite Wrap"):

        vec3 relativePos = mod(instancePos + uCameraPos, bounds) - bounds/2.0;

        This keeps rain always around the camera without spawning/despawning on CPU.

    Wind Interaction:

        Rain: pos += uWindVector * dropSpeed.

        Snow: pos.x += sin(uTime + instanceId) * uWindSpeed. (flutter effect).

    Depth Softening: Read the Scene Depth buffer. If a particle is "behind" geometry, discard. If it is about to hit geometry, fade opacity (prevents hard clipping).

    Roof Mask Interaction: Sample the Roof Map. If white, set opacity to 0 (rain effectively hits the roof and vanishes).

6. Surface Effects (Puddles & Accumulation)

We inject custom shader chunks into Three.js Standard Materials (onBeforeCompile).
Puddle Logic

    Inputs: uWetness (Global), vNormal, tRoofMap.

    Noise Mask: A tiling "grunge" noise texture defines low spots in the terrain.

    Algorithm:

        Check if surface is flat-ish (dot(vNormal, vec3(0,1,0)) > 0.9).

        Check if outdoors (texture(tRoofMap).r < 0.1).

        float puddleFactor = smoothstep(1.0 - uWetness, 1.0, noiseValue);

    Rendering:

        Mix Albedo towards Dark Grey.

        Mix Roughness towards 0.05 (Watery).

        Mix Normal towards vec3(0,0,1) (Flatten normals for reflection).

Snow Accumulation

Similar to puddles, but:

    dot(vNormal, vec3(0,1,0)) threshold is more lenient (snow sticks to slopes).

    Mix Albedo towards White.

    Displace vertices slightly along Normal if using displacement maps (fluffiness).

Dripping (The "Eaves" Effect)

We cannot simulate fluid dynamics.

    Trick: Create a "Drip Particle System".

    Placement: This is the only manual setup or pre-computed step. We scan the Roof Map for edges (pixels where White meets Black) and spawn particles there.

    Logic: Only active when uWetness > 0.5.

7. Wind & Vegetation (Vertex Animation)

Vegetation (Grass, Bushes, Trees) uses a custom shader.
The "Gust" Texture

A grayscale noise texture that scrolls across the world based on uWindDirection and uTime.

    float gustStrength = texture(tGustNoise, worldPos.xz + uWindOffset).r;

Vertex Shader Logic

    Base Wind: Constant gentle sway based on uWindSpeed.

    Gust Modifier: Multiply sway amplitude by gustStrength.

    Direction: Displace vertices along uWindDirection.

    Height Mask: Multiply displacement by uv.y (bottom of tree is pinned, top moves).

8. Lighting & Reflections (Time of Day Integration)
The Sun

    Position: Calculated via spherical coordinates (Elevation/Azimuth) based on GameTime.

    Color Temperature:

        Noon: White/Yellow (6500K).

        Sunset: Orange/Red (2000K).

        Night: Blue/Purple (8000K - fake moonlight).

    Shadows: Softness increases as cloud density increases.

Dynamic Environment Probe

To handle reflections of the changing sky:

    Problem: Rendering a real-time CubeCamera every frame is too heavy (6 renders).

    Solution: "Time-Sliced" Updates.

        Render 1 face of the CubeMap every 2 frames. The reflection map updates fully every 12 frames.

        During transitions (Clear -> Storm), force update rate higher if performance allows.

        Render the Sky/Clouds/Sun into this probe. Use this probe for PBR materials.

9. Summary of Controls (The GM Interface)

The UI exposes these high-level hooks:

    transitionTo(weatherID, duration):

        Example: transitionTo('HEAVY_STORM', 10.0)

        Interpolates wind, precip, cloud density, lighting LUTs.

    setVariability(0.0 - 1.0):

        0.0: Weather is locked.

        1.0: Wind gusts are violent, rain starts and stops intermittently.

    setTime(hour):

        Moves Sun/Moon.

        Updates Sky gradient.

    setSeason(seasonID):

        Changes the texture palette (e.g., Green grass -> Brown grass) and changes precipType defaults (Rain -> Snow).

10. Implementation Priority

    Global Uniform System & WeatherController: Establish the data flow.

    Roof Mask Generation: Essential for any 2.5D depth logic.

    Precipitation Particles: High visual impact, relatively easy.

    Puddle/Wetness Shader Chunks: crucial for grounding the weather.

    Wind Vertex Displacement: Makes the world feel alive.

    Cloud/Shadow Layering: The complex "hero" visual.

    Dynamic Reflections: The polish pass.