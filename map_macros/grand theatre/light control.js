/* This script controls virtual lights in Foundry VTT on a virtual stage, it also takes care of the main hall house lights for a virtual theatre. */

/* Toggle Lights by Location Macro (Stage/House) V2.6.7 (Stage & House driven by UUID allowlists)
 * Features:
 * - Groups lights into 'Stage' and 'House' using STAGE_LIGHT_UUID_ALLOWLIST and HOUSE_LIGHT_UUID_ALLOWLIST only (no polygon or color matching for grouping).
 * - Provides quick color/luminosity swatches to instantly set ALL Stage light color AND luminosity (MANUAL animation).
 * - Provides quick animation type buttons to instantly set ALL Stage light animation types.
 * - Adds sliders to control animation Speed and Intensity for ALL Stage lights simultaneously.
 * - Adds a slider to control Focus (Attenuation) for ALL Stage lights simultaneously.
 * - Adds a 'Master Brightness' slider to control Luminosity for ALL Stage lights simultaneously (with alpha for subtle lows).
 * - Adds a 'Color Intensity' slider mapping UI 0..1 to Foundry saturation -1..+1.
 * - Adds 'Bright' and 'Dim' sliders to set bright/dim radii (grid units) for ALL Stage lights at once (dim >= bright).
 * - Provides 'Environment' buttons to instantly set ALL Stage lights randomly to one of theme colors (MANUAL animation).
 * - Provides large buttons to turn ALL Stage Lights OFF or ON (White).
 * - Provides large buttons to turn house allowlist lights OFF or ON (luminosity only; updates do not set config.color).
 * - Toggles lights On/Off using MANUAL animation (stage: luminosity and colour; house UUID list: luminosity only).
 * - Displays '[Stage]' or '[House]' labels next to light names (Stage takes priority).
 * - Adds individual Focus (Attenuation) sliders for each light in the list.
 * - Adds individual X and Y position sliders for STAGE lights ONLY, constrained to the stage boundaries.
 * - Adds a Spotlight section:
 *     - Lists PC/NPC tokens currently within the Stage area.
 *     - Allows creating/removing a dedicated spotlight light source per token via checkbox.
 *     - Spotlights automatically follow token movement.
 *     - Uses Flags for persistence and Hooks for reactivity.
 *     - Spotlight defaults changed (Bright: 2, Dim: 5, Focus: 0.8).
 *     - Spotlight token list uses two columns for better visibility.
 * - Groups lights visually into Stage and House sections with expand/collapse.
 * - Refactored for maintainability & uses async/await.
 * - Interrupts any currently running manual light transition (fade, color set, environment) and starts the new one immediately.
 * - Changed permission check to game.user.isGM.
 * - Updated labels for theatre terminology (Fade Time).
 * - Moved Fade Time input to the main button row.
 */

(async () => {
    // --- Configuration ---
    const FADE_TIME_DEFAULT_MS = 5000;
    const ANIMATION_STEPS = 30;
    const COLLAPSE_DELAY_MS = 500;
    /** Used for UI accents only (e.g. House ON button styling; grouping uses HOUSE_LIGHT_UUID_ALLOWLIST). */
    const HOUSE_LIGHT_COLOR = "#fff1ad";
    const OFF_LUMINOSITY = 0;
    const TARGET_ON_LUMINOSITY = 0.5;
    const OFF_INTENSITY = 0.0;
    const TARGET_ON_INTENSITY = 1.0;
    const OFF_COLOR = "#000000";
    const DEFAULT_ON_COLOR = "#ffffff";
    /** If bright and dim are both 0, the light barely illuminates; apply these (grid units) when turning on. Tune to your map. */
    const DEFAULT_AMBIENT_BRIGHT = 12;
    const DEFAULT_AMBIENT_DIM = 25;
    const DEFAULT_ANIMATION_INTENSITY = 5;
    const DEFAULT_ANIMATION_SPEED = 5;
    const MAX_SWATCH_LUMINOSITY = 0.5;
    const ANIM_SLIDER_MIN = 1;
    const ANIM_SLIDER_MAX = 10;
    const ANIM_SLIDER_STEP = 1;
    const FOCUS_SLIDER_MIN = 0.0;
    const FOCUS_SLIDER_MAX = 1.0;
    const FOCUS_SLIDER_STEP = 0.05;
    const DEFAULT_FOCUS_VALUE = 0.5;
    const LUMINOSITY_SLIDER_MIN = 0.0;
    const LUMINOSITY_SLIDER_MAX = 1.0;
    const LUMINOSITY_SLIDER_STEP = 0.05;
    const DEFAULT_LUMINOSITY_VALUE = 0.5;
    /** UI slider 0..1 maps to Foundry `config.saturation` -1 (muted) .. +1 (vivid); 0.5 = neutral (0). */
    const COLOR_INTENSITY_SLIDER_MIN = 0.0;
    const COLOR_INTENSITY_SLIDER_MAX = 1.0;
    const COLOR_INTENSITY_SLIDER_STEP = 0.05;
    const DEFAULT_COLOR_INTENSITY_VALUE = 0.5;
    /** Master stage radius sliders (grid distance units, same as light config bright/dim). */
    const STAGE_BRIGHT_SLIDER_MIN = 0;
    const STAGE_BRIGHT_SLIDER_MAX = 60;
    const STAGE_DIM_SLIDER_MIN = 0;
    const STAGE_DIM_SLIDER_MAX = 100;
    const STAGE_BRIGHT_DIM_SLIDER_STEP = 1;
    const POSITION_SLIDER_STEP = 1;
    const ANIMATION_INTERRUPT_WAIT_TIMEOUT_MS = 500;
    const ANIMATION_INTERRUPT_CHECK_INTERVAL_MS = 20;
    const SPOTLIGHT_FLAG_MODULE = 'location-light-controller-macro';
    const SPOTLIGHT_FLAG_KEY = 'spotlightTokenId';
    const SPOTLIGHT_COLOR = "#FFFFFF";
    const SPOTLIGHT_ALPHA = 0.6;
    const SPOTLIGHT_BRIGHT_RADIUS = 2;
    const SPOTLIGHT_DIM_RADIUS = 5;
    const SPOTLIGHT_ATTENUATION = 0.8;
    const SPOTLIGHT_LUMINOSITY = 0;
    const SPOTLIGHT_COLORATION_TECHNIQUE = 1; // 1 = Color Dodge
    const SPOTLIGHT_ANIMATION_TYPE = null;
    const SPOTLIGHT_REFRESH_DEBOUNCE_MS = 25;
    const SPOTLIGHT_MOVE_DEBOUNCE_MS = 25;
    let tokenRefreshDebounceMap = new Map();

    // Define the Stage Area using polygon vertices (Scene coordinates)
    const STAGE_VERTICES = [{
            x: 7650,
            y: 2850
        },
        {
            x: 10500,
            y: 2850
        },
        {
            x: 10500,
            y: 4200
        },
        {
            x: 7650,
            y: 4200
        }
    ]; // IMPORTANT: Must have at least 3 vertices. Order matters (clockwise or counter-clockwise).

    /**
     * Stage lights: only documents whose `uuid` is listed here. Paste from the lighting-layer console snippet.
     * Leave empty `[]` if you have no stage lights to control.
     */
    const STAGE_LIGHT_UUID_ALLOWLIST = [
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.VbvkgL8V956H9BFa",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.sUsIdlnPk3aqJHLa",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.MtfGDllcgKIHCTnE",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.eVMTYV0fZeYG7peA",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.59TnJHD866dY1r5J",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.9tof3OD9LBjnbqY4",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.AldVW0L3rbGUfAAc",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.DWYOnZkEEwXSILuL"
    ];

    const stageLightUuidAllowSet = new Set(
        STAGE_LIGHT_UUID_ALLOWLIST.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
    );
    /**
     * House lights: only documents whose `uuid` is listed here (bulk House OFF/ON and [House] label).
     * Leave empty `[]` if you have no house lights to control.
     * 
     */
    const HOUSE_LIGHT_UUID_ALLOWLIST = [
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.WkkQNhITHyQmvlKN",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.tlEWANUTidGVVmla",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.97SaarvlNEAYBtE0",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.JFUoIE1dquMdXQ2H",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.hNaS8CID33ym1O0F",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.tt6cX7vkpbi5xOFx",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.GorQoYmvlMxCUla0",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.qrRtKDaJ30J4bTDH",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.KtA4AXoEAyi6lFZH",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.b5gjRiekAXXfYkeY",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.zSpCLUS40GqspxLk",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.MQwNrLTjbpGzhaXW",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.QyhJsbUb6uVhO259",

        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.7KGgzXY455SBEJRn",
        "Scene.8RsHB8sH1p6RWy0i.AmbientLight.ggwwqBpB6W35XkyO"
    ];

    const houseLightUuidAllowSet = new Set(
        HOUSE_LIGHT_UUID_ALLOWLIST.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
    );

    // --- Calculate Stage Boundaries ---
    let minStageX = Infinity,
        maxStageX = -Infinity,
        minStageY = Infinity,
        maxStageY = -Infinity;
    if (STAGE_VERTICES.length >= 3) {
        STAGE_VERTICES.forEach(v => {
            minStageX = Math.min(minStageX, v.x);
            maxStageX = Math.max(maxStageX, v.x);
            minStageY = Math.min(minStageY, v.y);
            maxStageY = Math.max(maxStageY, v.y);
        });
    } else {
        console.warn("Stage Controller | STAGE_VERTICES invalid. Position/Spotlight features might be inaccurate.");
        minStageX = 0;
        maxStageX = canvas.dimensions.width;
        minStageY = 0;
        maxStageY = canvas.dimensions.height;
    }
    const stageBoundsDefined = isFinite(minStageX) && isFinite(maxStageX) && isFinite(minStageY) && isFinite(maxStageY);

    // --- Color/Luminosity/Environment/Animation Palettes ---
    const BASE_PALETTE_COLORS = ["#ffffff", "#ff5050", "#ff8000", "#ffff00", "#80ff00", "#00ff00", "#00ffff", "#0080ff", "#0000ff", "#8000ff", "#ff00ff", "#ff8080", "#f0f8ff", "#faebd7", "#ffdead", "#ffe4c4", "#d2b48c", "#daa520", "#adff2f", "#20b2aa", "#4682b4", "#1e90ff", "#9370db", "#c71585"].filter((v, i, a) => a.indexOf(v?.toLowerCase()) === i);
    const LUMINOSITY_STEPS = [0.5, 0.35, 0.20, 0.10, 0.05, 0.0];
    const ENVIRONMENT_PALETTES = [{
            name: "Fire & Ice",
            colors: ["#ff8000", "#0080ff"],
            description: "Classic contrast: Warm Orange vs. Cool Blue"
        },
        {
            name: "Sunset",
            colors: ["#ff5050", "#daa520"],
            description: "Warm evening sky: Red and Goldenrod"
        },
        {
            name: "Ocean Deep",
            colors: ["#0000ff", "#20b2aa"],
            description: "Depths: Deep Blue and Light Sea Green"
        },
        {
            name: "Cyberpunk",
            colors: ["#ff00ff", "#00ffff"],
            description: "Neon vibes: Magenta and Cyan"
        },
        {
            name: "Cotton Candy",
            colors: ["#ff8080", "#add8e6"],
            description: "Sweet pastels: Pink and Light Blue"
        },
        {
            name: "Royal",
            colors: ["#8000ff", "#daa520"],
            description: "Regal tones: Purple and Gold"
        },
        {
            name: "Toxic Glow",
            colors: ["#adff2f", "#c71585"],
            description: "Unsettling combo: Green Yellow and Violet Red"
        },
        {
            name: "Monochrome",
            colors: ["#ffffff", "#404040"],
            description: "Black and White film style: White and Dark Grey"
        },
        {
            name: "Desert Sun",
            colors: ["#d2b48c", "#ffdead"],
            description: "Arid landscape: Tan and Navajo White"
        },
        {
            name: "Volcano",
            colors: ["#ff5050", "#400000"],
            description: "Molten rock: Bright Red and Very Dark Red/Brown"
        },
        {
            name: "Twilight",
            colors: ["#4682b4", "#9370db"],
            description: "Evening transition: Steel Blue and Medium Purple"
        },
        {
            name: "Forest Contrast",
            colors: ["#00ff00", "#006400"],
            description: "High contrast woods: Bright Green and Dark Green"
        },
        {
            name: "Rainbow",
            colors: ["#ff5050", "#ff8000", "#ffff00", "#00ff00", "#0080ff", "#8000ff"],
            description: "Full spectrum burst"
        },
        {
            name: "Autumn Leaves",
            colors: ["#ff8000", "#daa520", "#c0392b", "#a0522d"],
            description: "Fall colors: Orange, Gold, Red, Sienna"
        },
        {
            name: "Spring Meadow",
            colors: ["#80ff00", "#ffff00", "#ff8080", "#f0f8ff"],
            description: "Fresh bloom: Lime, Yellow, Pink, Alice Blue"
        },
        {
            name: "Galaxy",
            colors: ["#0000ff", "#8000ff", "#1e90ff", "#404040", "#ffffff"],
            description: "Deep space: Blue, Purple, Dodger Blue, Grey, White (stars)"
        },
        {
            name: "Coral Reef",
            colors: ["#00ffff", "#ff8080", "#ffff00", "#20b2aa", "#ff8000"],
            description: "Underwater life: Cyan, Pink, Yellow, Sea Green, Orange"
        },
        {
            name: "Sunrise",
            colors: ["#ffb6c1", "#ffa07a", "#fffacd"],
            description: "Gentle morning light: Pink, Salmon, Pale Yellow"
        },
        {
            name: "Arctic Chill",
            colors: ["#e0f2f7", "#b3e5fc", "#ffffff"],
            description: "Frigid expanse: Pale Blues and Pure White"
        },
        {
            name: "Jungle Canopy",
            colors: ["#006400", "#228b22", "#8b4513"],
            description: "Dense foliage: Deep Greens and Earthy Brown"
        },
        {
            name: "Stormy Sky",
            colors: ["#696969", "#778899", "#2f4f4f", "#e6e6fa"],
            description: "Ominous weather: Dark Greys and a hint of Lavender"
        },
        {
            name: "Molten Gold",
            colors: ["#ffd700", "#ff8c00", "#b8860b"],
            description: "Liquid precious metal: Bright Gold and Orange Tones"
        },
        {
            name: "Vintage Film",
            colors: ["#704214", "#c3b091", "#808080"],
            description: "Old photograph look: Sepia, Khaki, and Grey"
        },
        {
            name: "Emerald City",
            colors: ["#00ff7f", "#ffd700", "#3cb371"],
            description: "Magical metropolis: Bright Greens and Gold"
        },
        {
            name: "Candy Store",
            colors: ["#ff69b4", "#00ffff", "#ffff00", "#32cd32"],
            description: "Sweet & bright mix: Pink, Cyan, Yellow, Lime"
        },
        {
            name: "Plasma Energy",
            colors: ["#00ff00", "#ff00ff", "#0000ff"],
            description: "High energy fields: Green, Magenta, Blue"
        },
        {
            name: "Rose Gold",
            colors: ["#b76e79", "#daa520", "#f4a460"],
            description: "Modern metallic blend: Pinkish Gold and Copper Tones"
        },
        {
            name: "Misty Morning",
            colors: ["#dcdcdc", "#b0c4de", "#f0fff0"],
            description: "Hazy dawn atmosphere: Soft Greys and Pale Blue/Green"
        },
        {
            name: "Northern Lights",
            colors: ["#98fb98", "#9400d3", "#191970", "#00ced1"],
            description: "Aurora borealis: Green, Violet, Dark Blue, Turquoise"
        },
        {
            name: "Sakura Blossom",
            colors: ["#ffb6c1", "#ffe4e1", "#ffffff", "#8b4513"],
            description: "Cherry blossoms: Pinks, White, and Brown"
        },
        {
            name: "Deep Sea Abyss",
            colors: ["#000033", "#00001a", "#0fffff"],
            description: "Unfathomable depths: Darkest Blues with Cyan Glow"
        },
        {
            name: "Savannah Sunset",
            colors: ["#f4a460", "#ffcc33", "#a0522d"],
            description: "African plains evening: Warm Oranges, Yellows, Browns"
        },
        {
            name: "Industrial Grit",
            colors: ["#808080", "#a9a9a9", "#d2691e", "#4682b4"],
            description: "Urban decay: Greys, Rust Brown, Steel Blue"
        },
        {
            name: "Peacock Feathers",
            colors: ["#008080", "#483d8b", "#ffd700", "#2e8b57"],
            description: "Iridescent beauty: Teal, Blue-Purple, Gold, Green"
        }
    ];
    const COLOR_LUMINOSITY_INTENSITY_PALETTE = BASE_PALETTE_COLORS.map(baseHex => {
        const baseRgb = hexToRgb(baseHex);
        if (!baseRgb) return null;
        const steps = LUMINOSITY_STEPS.map(lum => {
            const isOff = lum <= OFF_LUMINOSITY;
            const targetColor = isOff ? OFF_COLOR : baseHex;
            const targetIntensity = isOff ? OFF_INTENSITY : TARGET_ON_INTENSITY;
            let visualHex = OFF_COLOR;
            if (!isOff) {
                const visualDimFactor = Math.min(1, Math.max(0, lum / MAX_SWATCH_LUMINOSITY));
                const visualR = Math.round(baseRgb[0] * visualDimFactor);
                const visualG = Math.round(baseRgb[1] * visualDimFactor);
                const visualB = Math.round(baseRgb[2] * visualDimFactor);
                visualHex = rgbToHex(visualR, visualG, visualB);
            }
            return {
                targetColor,
                luminosity: lum,
                intensity: targetIntensity,
                visualColor: visualHex
            };
        });
        return {
            baseColor: baseHex,
            steps: steps
        };
    }).filter(group => group !== null);
    const LIGHT_ANIMATIONS = CONFIG.Canvas.lightAnimations ?? {};
    const sortedAnimationTypes = Object.entries(LIGHT_ANIMATIONS)
        .map(([key, data]) => ({
            key: key,
            label: game.i18n.localize(data.label) || key
        }))
        .sort((a, b) => {
            if (a.key === "none") return -1;
            if (b.key === "none") return 1;
            return a.label.localeCompare(b.label);
        });
    if (!sortedAnimationTypes.some(anim => anim.key === "none")) {
        sortedAnimationTypes.unshift({
            key: "none",
            label: game.i18n.localize("None") || "None"
        });
    }

    // --- Internal Constants ---
    const DIALOG_ID = "grouped-light-controller-dialog";
    const LIGHT_ITEM_CLASS = "light-item-interactive";
    const DATA_LIGHT_UUID = "data-light-uuid";
    const DATA_INITIAL_COLOR = "data-initial-color";
    const DATA_INITIAL_LUMINOSITY = "data-initial-luminosity";
    const DEFAULT_ON_COLOR_RGB = hexToRgb(DEFAULT_ON_COLOR);
    const OFF_COLOR_RGB = hexToRgb(OFF_COLOR);

    // --- State Variables ---
    let isAnimatingManually = false;
    let cancelCurrentAnimation = false;
    let activeSpotlights = new Map(); // Maps tokenId -> lightId
    let spotlightHookIds = [];
    let debounceTimer = null;

    // --- Helper Functions ---
    function lerp(start, end, t) { return start * (1 - t) + end * t; }
    function hexToRgb(hex) { if (!hex || typeof hex !== 'string') return null; const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : null; }
    function rgbToHex(r, g, b) { r = Math.max(0, Math.min(255, Math.round(r))); g = Math.max(0, Math.min(255, Math.round(g))); b = Math.max(0, Math.min(255, Math.round(b))); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toLowerCase(); }
    function interpolateRgb(rgb1, rgb2, t) { const startRgb = Array.isArray(rgb1) && rgb1.length === 3 ? rgb1 : DEFAULT_ON_COLOR_RGB; const endRgb = Array.isArray(rgb2) && rgb2.length === 3 ? rgb2 : DEFAULT_ON_COLOR_RGB; const r = lerp(startRgb[0], endRgb[0], t); const g = lerp(startRgb[1], endRgb[1], t); const b = lerp(startRgb[2], endRgb[2], t); return [r, g, b]; }
    function normalizeColorToString(color) { if (color === null || color === undefined) return null; if (typeof color === 'string' && /^#?([a-f\d]{3}){1,2}$/i.test(color)) { let hex = color.startsWith('#') ? color : '#' + color; if (hex.length === 4) { hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]; } return hex.toLowerCase(); } if (typeof color === 'object' && color !== null) { if (typeof color.toHex === 'function') { return color.toHex().toLowerCase(); } if (typeof color.toString === 'function') { let strColor = color.toString(); if (/^#?([a-f\d]{3}){1,2}$/i.test(strColor)) { let hex = strColor.startsWith('#') ? strColor : '#' + strColor; if (hex.length === 4) { hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]; } return hex.toLowerCase(); } } } console.warn("[ColorUtil] Could not normalize color to string:", color); return DEFAULT_ON_COLOR; }
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    /** Resolves `data-light-uuid` reliably (dataset uses camelCase `lightUuid`, not `light-uuid`). */
    function getLightUuidFromElement(el) {
        if (!el) return undefined;
        return el.getAttribute?.("data-light-uuid") ?? el.dataset?.lightUuid ?? undefined;
    }
    function isPointInPolygon(point, polygonVertices) { const x = point.x, y = point.y; let isInside = false; const numVertices = polygonVertices.length; if (numVertices < 3) return false; for (let i = 0, j = numVertices - 1; i < numVertices; j = i++) { const xi = polygonVertices[i].x, yi = polygonVertices[i].y; const xj = polygonVertices[j].x, yj = polygonVertices[j].y; if (yi === y && yj === y && ((xi <= x && x <= xj) || (xj <= x && x <= xi))) { return true; } const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi); if (intersect) isInside = !isInside; } return isInside; }

    /**
     * Mutates embedded update objects: if the light still has no bright/dim radii and this update turns it on, set defaults.
     */
    function augmentAmbientUpdatesWithDefaultRadii(updates, docMap) {
        const scene = canvas?.scene;
        if (!updates?.length || !docMap || !scene) return;
        for (const u of updates) {
            const id = u._id;
            if (!id) continue;
            const lum = u["config.luminosity"];
            if (lum !== undefined && lum <= OFF_LUMINOSITY) continue;
            const doc = docMap.get(`${scene.uuid}.AmbientLight.${id}`);
            if (!doc?.config) continue;
            const b = Number(doc.config.bright) || 0;
            const di = Number(doc.config.dim) || 0;
            if (b > 0 || di > 0) continue;
            u["config.bright"] = DEFAULT_AMBIENT_BRIGHT;
            u["config.dim"] = DEFAULT_AMBIENT_DIM;
        }
    }

    async function bulkAnimateLightsManually(lightTransitions, duration, steps, docMap, luminosityOnly = false) {
        if (!lightTransitions || lightTransitions.length === 0) return;
        if (duration <= 0 || steps <= 0) {
            if (cancelCurrentAnimation) {
                console.log("[ManualAnim] Instant animation cancelled before execution.");
                return;
            }
            const finalUpdates = lightTransitions.map((t) => {
                const u = { _id: t.uuid.split(".").pop(), "config.luminosity": t.endState.luminosity ?? OFF_LUMINOSITY };
                if (!luminosityOnly) {
                    u["config.color"] = normalizeColorToString(t.endState.color) ?? OFF_COLOR;
                } else {
                    u["config.color"] = null;
                }
                return u;
            });
            augmentAmbientUpdatesWithDefaultRadii(finalUpdates, docMap);
            if (finalUpdates.length > 0) {
                try {
                    await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalUpdates);
                } catch (err) {
                    console.error(`[ManualAnim] Error applying instant update:`, err);
                    ui.notifications.error(`Failed to apply instant light update. See console (F12).`);
                }
            }
            return;
        }
        const stepDuration = duration / steps;
        let animationCompletedNaturally = true;

        if (luminosityOnly) {
            const transitionsLum = lightTransitions.map((t) => ({
                ...t,
                startLuminosity: t.startState.luminosity ?? OFF_LUMINOSITY,
                endLuminosity: t.endState.luminosity ?? OFF_LUMINOSITY,
            }));
            for (let i = 1; i <= steps; i++) {
                if (cancelCurrentAnimation) {
                    console.log("[ManualAnim] Animation loop interrupted by cancellation flag.");
                    animationCompletedNaturally = false;
                    break;
                }
                const t = i / steps;
                const updates = [];
                for (const tr of transitionsLum) {
                    const currentLuminosity = lerp(tr.startLuminosity, tr.endLuminosity, t);
                    updates.push({ _id: tr.uuid.split(".").pop(), "config.luminosity": currentLuminosity });
                }
                augmentAmbientUpdatesWithDefaultRadii(updates, docMap);
                if (updates.length > 0) {
                    try {
                        await canvas.scene.updateEmbeddedDocuments("AmbientLight", updates, { noHook: true });
                    } catch (err) {
                        console.error(`[ManualAnim] Error during step ${i} update:`, err);
                        ui.notifications.error(`Animation step failed. See console (F12).`);
                        animationCompletedNaturally = false;
                        return;
                    }
                }
                if (i < steps && !cancelCurrentAnimation) await sleep(stepDuration);
            }
            if (animationCompletedNaturally) {
                const finalUpdatesOnComplete = transitionsLum.map((tr) => ({
                    _id: tr.uuid.split(".").pop(),
                    "config.luminosity": tr.endLuminosity ?? OFF_LUMINOSITY,
                }));
                augmentAmbientUpdatesWithDefaultRadii(finalUpdatesOnComplete, docMap);
                if (finalUpdatesOnComplete.length > 0) {
                    try {
                        await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalUpdatesOnComplete);
                    } catch (err) {
                        console.error(`[ManualAnim] Error applying final state update after successful animation:`, err);
                    }
                }
            } else {
                console.log("[ManualAnim] Skipping final state application due to interruption or error.");
            }
            return;
        }

        const transitionsWithRgb = lightTransitions.map((t) => {
            const startColorStr = normalizeColorToString(t.startState.color);
            const endColorStr = normalizeColorToString(t.endState.color);
            const startRgbVal = startColorStr ? hexToRgb(startColorStr) : (t.startState.luminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);
            const endRgbVal = endColorStr ? hexToRgb(endColorStr) : (t.endState.luminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);
            const finalStartRgb = startRgbVal || (t.startState.luminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);
            const finalEndRgb = endRgbVal || (t.endState.luminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);
            const startLumi = t.startState.luminosity ?? (finalStartRgb === OFF_COLOR_RGB ? OFF_LUMINOSITY : TARGET_ON_LUMINOSITY);
            const endLumi = t.endState.luminosity ?? (finalEndRgb === OFF_COLOR_RGB ? OFF_LUMINOSITY : TARGET_ON_LUMINOSITY);
            return { ...t, startRgb: finalStartRgb, endRgb: finalEndRgb, startLuminosity: startLumi, endLuminosity: endLumi };
        });
        for (let i = 1; i <= steps; i++) {
            if (cancelCurrentAnimation) {
                console.log("[ManualAnim] Animation loop interrupted by cancellation flag.");
                animationCompletedNaturally = false;
                break;
            }
            const t = i / steps;
            const updates = [];
            for (const transition of transitionsWithRgb) {
                const { uuid, startLuminosity, endLuminosity, startRgb, endRgb } = transition;
                const currentLuminosity = lerp(startLuminosity, endLuminosity, t);
                const currentRgb = interpolateRgb(startRgb, endRgb, t);
                const currentHex = rgbToHex(currentRgb[0], currentRgb[1], currentRgb[2]);
                updates.push({ _id: uuid.split(".").pop(), "config.color": currentHex, "config.luminosity": currentLuminosity });
            }
            augmentAmbientUpdatesWithDefaultRadii(updates, docMap);
            if (updates.length > 0) {
                try {
                    await canvas.scene.updateEmbeddedDocuments("AmbientLight", updates, { noHook: true });
                } catch (err) {
                    console.error(`[ManualAnim] Error during step ${i} update:`, err);
                    ui.notifications.error(`Animation step failed. See console (F12).`);
                    animationCompletedNaturally = false;
                    return;
                }
            }
            if (i < steps && !cancelCurrentAnimation) await sleep(stepDuration);
        }
        if (animationCompletedNaturally) {
            const finalUpdatesOnComplete = transitionsWithRgb.map((tr) => ({
                _id: tr.uuid.split(".").pop(),
                "config.color": normalizeColorToString(tr.endState.color) ?? OFF_COLOR,
                "config.luminosity": tr.endState.luminosity ?? OFF_LUMINOSITY,
            }));
            augmentAmbientUpdatesWithDefaultRadii(finalUpdatesOnComplete, docMap);
            if (finalUpdatesOnComplete.length > 0) {
                try {
                    await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalUpdatesOnComplete);
                } catch (err) {
                    console.error(`[ManualAnim] Error applying final state update after successful animation:`, err);
                }
            }
        } else {
            console.log("[ManualAnim] Skipping final state application due to interruption or error.");
        }
    }

    // --- Main Logic ---
    if (!canvas?.scene) { ui.notifications.warn("No active scene selected."); return; }
    const canControlSpotlights = game.user.isGM;
    if (!canControlSpotlights) { ui.notifications.warn("You do not appear to be a GM, Spotlight feature will be disabled."); }

    const currentScene = canvas.scene;
    const normalizedHouseColor = normalizeColorToString(HOUSE_LIGHT_COLOR);
    const houseControlsEnabled = houseLightUuidAllowSet.size > 0;

    // Data Structures for Lights
    const lightGroups = { stage: [], house: [] };
    const lightDocMap = new Map();
    const stageLightUUIDs = [];
    const houseLightUUIDs = [];

    let totalLightCount = 0;
    // Process all lights in the current scene
    for (const lightDoc of currentScene.lights) {
        if (!lightDoc) continue;

        const isSpotlight = foundry.utils.getProperty(lightDoc, `flags.${SPOTLIGHT_FLAG_MODULE}.${SPOTLIGHT_FLAG_KEY}`);
        if (isSpotlight) continue;

        totalLightCount++;
        const lightConfig = lightDoc.config;
        lightDocMap.set(lightDoc.uuid, lightDoc);

        const currentColorNormalized = normalizeColorToString(lightConfig.color);
        const currentLuminosity = lightConfig.luminosity ?? 0.0;
        const currentAttenuation = lightConfig.attenuation ?? DEFAULT_FOCUS_VALUE;
        const currentSaturation = lightConfig.saturation ?? DEFAULT_COLOR_INTENSITY_VALUE; // Capture saturation
        const isOn = currentLuminosity > OFF_LUMINOSITY;

        const isStage = stageLightUuidAllowSet.has(lightDoc.uuid);
        const isListedHouse = houseLightUuidAllowSet.has(lightDoc.uuid);

        const label = isStage ? "[Stage]" : (isListedHouse ? "[House]" : "");

        let initialColorForAttr;
        if (isStage) {
            initialColorForAttr = isOn ? (currentColorNormalized ?? DEFAULT_ON_COLOR) : DEFAULT_ON_COLOR;
        } else if (isListedHouse) {
            initialColorForAttr = "";
        } else {
            initialColorForAttr = isOn ? (currentColorNormalized ?? DEFAULT_ON_COLOR) : DEFAULT_ON_COLOR;
        }
        const initialLuminosityForAttr = isOn ? currentLuminosity : TARGET_ON_LUMINOSITY;

        const lightData = {
            uuid: lightDoc.uuid,
            id: lightDoc.id,
            name: lightDoc.name || `(Unnamed Light ${lightDoc.id})`,
            x: lightDoc.x,
            y: lightDoc.y,
            color: isListedHouse ? null : currentColorNormalized,
            luminosity: currentLuminosity,
            attenuation: currentAttenuation,
            saturation: currentSaturation, // Store initial saturation
            statusClass: isOn ? 'green' : 'red',
            initialLuminosity: initialLuminosityForAttr,
            initialColorForAttr: initialColorForAttr,
            isStageLight: isStage,
            isHouseLight: isListedHouse,
            label: label
        };

        if (isStage) {
            lightGroups.stage.push(lightData);
            stageLightUUIDs.push(lightDoc.uuid);
        }
        if (isListedHouse) {
            if (!isStage) {
                 lightGroups.house.push(lightData);
            }
            houseLightUUIDs.push(lightDoc.uuid);
        }
    }

    if (stageLightUuidAllowSet.size > 0) {
        const nStage = stageLightUUIDs.length;
        console.log(`Stage Controller | Stage UUIDs: ${stageLightUuidAllowSet.size} configured, ${nStage} matched in scene.`);
        if (nStage < stageLightUuidAllowSet.size) {
            ui.notifications.warn(
                `Stage light UUID list: ${stageLightUuidAllowSet.size} entr${stageLightUuidAllowSet.size === 1 ? "y" : "ies"}, only ${nStage} found in this scene. Re-paste UUIDs after duplicating the scene.`
            );
        }
    }

    if (houseLightUuidAllowSet.size > 0) {
        const nHouse = houseLightUUIDs.length;
        console.log(`Stage Controller | House UUIDs: ${houseLightUuidAllowSet.size} configured, ${nHouse} matched in scene.`);
        if (nHouse < houseLightUuidAllowSet.size) {
            ui.notifications.warn(
                `House light UUID list: ${houseLightUuidAllowSet.size} entr${houseLightUuidAllowSet.size === 1 ? "y" : "ies"}, only ${nHouse} found in this scene. Re-paste UUIDs after duplicating the scene.`
            );
        }
    }

    if (totalLightCount === 0 && !stageBoundsDefined && !canControlSpotlights) {
        ui.notifications.info(`No controllable lights found, no Stage Area defined, and Spotlight control disabled.`);
        return;
    }

    // --- HTML Generation Functions ---
    function generateLightListItemHtml(lightData) {
        const isHouse = !!lightData.isHouseLight;
        const initialColorAttr = isHouse ? '' : (lightData.initialColorForAttr || DEFAULT_ON_COLOR);
        const initialLuminosityStr = String(lightData.initialLuminosity);
        const labelHtml = lightData.label ? `<span class="light-label ${lightData.isStageLight ? 'stage' : (lightData.isHouseLight ? 'house' : '')}">${lightData.label}</span>` : '';
        const isOnLoad = lightData.statusClass === 'green';

        let currentDisplayColor = OFF_COLOR;
        if (isHouse) {
            currentDisplayColor = isOnLoad ? '#a8a8a8' : OFF_COLOR;
        } else if (isOnLoad) {
            currentDisplayColor = lightData.color || (lightData.isStageLight ? DEFAULT_ON_COLOR : '#808080');
        }
        const currentInputValue = isOnLoad ? (lightData.color || (lightData.isStageLight ? DEFAULT_ON_COLOR : OFF_COLOR)) : OFF_COLOR;

        const colorControlsHtml = isHouse
            ? `<span class="house-no-color-controls" title="House UUID lights: only brightness is controlled; this macro does not set colour."><i class="fas fa-lightbulb"></i> Lum only</span>`
            : `<span class="current-color-wrapper" title="Set Light Color (Uses Manual Animation)"> <i class="fas fa-palette"></i> <input type="color" class="light-current-color-input" value="${currentInputValue}" title="Choose target color for this light"> <button type="button" class="set-single-color-button action-button" title="Apply Chosen Color"><i class="fas fa-check"></i></button> </span>`;

        const swatchTitle = isHouse
            ? (isOnLoad ? `On (luminosity ${lightData.luminosity.toFixed(2)}); colour not controlled by this macro` : `Off (luminosity ${OFF_LUMINOSITY})`)
            : (isOnLoad ? `Current light colour: ${lightData.color ?? 'default'}` : `Off`);

        const statusTitle = isOnLoad ? `Visible (Luminosity ${lightData.luminosity.toFixed(2)})` : `Off (Luminosity ${OFF_LUMINOSITY})`;
        const currentFocus = lightData.attenuation?.toFixed(2) ?? DEFAULT_FOCUS_VALUE.toFixed(2);
        const currentX = Math.round(lightData.x);
        const currentY = Math.round(lightData.y);

        let positionSlidersHtml = '';
        if (lightData.isStageLight && stageBoundsDefined) {
            positionSlidersHtml = `
            <div class="individual-position-controls">
                <div class="individual-pos-control individual-x-control" title="Set X Position (${minStageX} to ${maxStageX})"> <i class="fas fa-arrows-alt-h"></i> <input type="range" class="individual-pos-slider individual-x-slider" data-axis="x" min="${minStageX}" max="${maxStageX}" step="${POSITION_SLIDER_STEP}" value="${currentX}" /> <span class="individual-pos-value individual-x-value">${currentX}</span> </div>
                <div class="individual-pos-control individual-y-control" title="Set Y Position (${minStageY} to ${maxStageY})"> <i class="fas fa-arrows-alt-v"></i> <input type="range" class="individual-pos-slider individual-y-slider" data-axis="y" min="${minStageY}" max="${maxStageY}" step="${POSITION_SLIDER_STEP}" value="${currentY}" /> <span class="individual-pos-value individual-y-value">${currentY}</span> </div>
            </div>`;
        }

        return `<li class="${LIGHT_ITEM_CLASS}" ${DATA_LIGHT_UUID}="${lightData.uuid}" ${DATA_INITIAL_LUMINOSITY}="${initialLuminosityStr}" ${DATA_INITIAL_COLOR}="${initialColorAttr}">
            <div class="light-selector"><input type="checkbox" class="light-select-checkbox" name="light_select_${lightData.id}" title="Select this light"/></div>
            <div class="light-status-color"> <span class="light-status ${lightData.statusClass}" title="${statusTitle}"></span> <span class="color-swatch" style="background-color: ${currentDisplayColor};" title="${swatchTitle}"></span> </div>
            <div class="light-name-details"> ${labelHtml} <span class="light-name" title="${lightData.name} (ID: ${lightData.id})">${lightData.name}</span> </div>
            <div class="light-actions">
                ${colorControlsHtml}
                <button type="button" class="toggle-single-button action-button" title="Toggle On/Off (Uses Manual Animation)"><i class="fas fa-power-off"></i></button>
                <button type="button" class="reset-single-button action-button" title="Reset Light to Initial State (Uses Manual Animation)"><i class="fas fa-undo"></i></button>
                <div class="individual-focus-control" title="Set Focus (Attenuation: 0=Wide, 1=Narrow)"> <i class="fas fa-crosshairs"></i> <input type="range" class="individual-focus-slider" min="${FOCUS_SLIDER_MIN}" max="${FOCUS_SLIDER_MAX}" step="${FOCUS_SLIDER_STEP}" value="${currentFocus}" /> <span class="individual-focus-value">${currentFocus}</span> </div>
                ${positionSlidersHtml}
                <button type="button" class="copy-uuid-button action-button" title="Copy UUID: ${lightData.uuid}"><i class="fas fa-copy"></i></button>
            </div>
        </li>`;
    }
    function generateLightListHtml(lights) { return lights.sort((a, b) => a.name.localeCompare(b.name)).map(generateLightListItemHtml).join(''); }
    function generateGroupHtml(groupType, groupName, lightsInGroup) { const groupIsEmpty = lightsInGroup.length === 0; let groupHtml = `<div class="light-group-parent collapsed" data-group-type="${groupType}"> <div class="group-header"> <div class="group-toggle-vis"><button type="button" class="toggle-group-visibility-button" title="Expand/Collapse Group" ${groupIsEmpty ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button></div> <div class="group-selector"><input type="checkbox" class="group-select-checkbox" title="Select/Deselect All in Group" ${groupIsEmpty ? 'disabled' : ''} /></div> <div class="group-name-details"><span class="group-name">${groupName} (${lightsInGroup.length})</span></div> <div class="group-actions"> <button type="button" class="group-toggle-button action-button" title="Toggle Group On/Off (Uses Manual Animation)" ${groupIsEmpty ? 'disabled' : ''}><i class="fas fa-power-off"></i></button> <button type="button" class="group-reset-button action-button" title="Reset Group Lights to Initial State (Uses Manual Animation)" ${groupIsEmpty ? 'disabled' : ''}><i class="fas fa-undo"></i></button> </div> </div> <ul class="light-group-children">`; if (groupIsEmpty) { groupHtml += `<li class="empty-group-message"><em>No lights currently in this group.</em></li>`; } else { groupHtml += generateLightListHtml(lightsInGroup); } groupHtml += `</ul></div>`; return groupHtml; }

    // --- Build HTML Content String ---
let htmlContent = `<form class="light-toggle-form">`;
htmlContent += `
    <div class="stage-quick-actions global-controls">
        <div class="parent-section quick-action-buttons">
            <!-- Moved Fade Time Input Here -->
            <div class="fade-time-inline-control">
                <label for="fade-time">Fade Time(ms):</label>
                <input type="number" id="fade-time" name="fade-time" value="${FADE_TIME_DEFAULT_MS}" min="0" style="width: 70px;" title="Manual animation fade time in milliseconds (0 for instant)." />
            </div>
             <span class="button-separator">|</span>
            <button type="button" id="stage-lights-off-button" class="stage-action-button stage-off" title="Turn ALL ${stageLightUUIDs.length} Stage Lights OFF (Uses Manual Animation)" ${stageLightUUIDs.length === 0 ? 'disabled' : ''}>
                <i class="fas fa-power-off"></i> Stage OFF
            </button>
            <button type="button" id="stage-lights-on-white-button" class="stage-action-button stage-on-white" title="Turn ALL ${stageLightUUIDs.length} Stage Lights ON to White [${DEFAULT_ON_COLOR}] at luminosity [${TARGET_ON_LUMINOSITY}] (Uses Manual Animation)" ${stageLightUUIDs.length === 0 ? 'disabled' : ''}>
                <i class="fas fa-lightbulb"></i> Stage ON (White)
            </button>
            <span class="button-separator">|</span>
            <button type="button" id="house-lights-off-button" class="house-action-button house-off" title="Turn OFF ALL ${houseLightUUIDs.length} house UUID lights (luminosity to 0)" ${!houseControlsEnabled ? 'disabled' : ''}>
                <i class="fas fa-power-off"></i> House Lights OFF
            </button>
            <button type="button" id="house-lights-on-button" class="house-action-button house-on" title="Turn ON ALL ${houseLightUUIDs.length} house UUID lights (luminosity to ${TARGET_ON_LUMINOSITY})" ${!houseControlsEnabled ? 'disabled' : ''}>
                <i class="fas fa-lightbulb"></i> House Lights ON
            </button>
            <span class="button-separator">|</span>
            <button type="button" id="export-macro-button" class="stage-action-button export-macro" title="Export current Stage light states to a new Macro" ${stageLightUUIDs.length === 0 ? 'disabled' : ''}>
                <i class="fas fa-file-export"></i> Export Macro
            </button>

        </div>
    </div>`;

    htmlContent += `<div class="light-list-area">`;
    if (stageBoundsDefined) { htmlContent += `<div class="spotlight-controls"> <h4 class="spotlight-title">Stage Spotlights <span class="spotlight-hint">(Lights follow tokens on stage)</span></h4> <ul class="spotlight-token-list"> <li class="spotlight-loading"><em>Detecting tokens on stage...</em></li> </ul> </div>`; } else { htmlContent += `<div class="spotlight-controls disabled-info"><p>Stage Area not defined. Spotlights disabled.</p></div>`; }
    if (stageLightUUIDs.length > 0) { htmlContent += `<div class="quick-color-luminosity-palette"> <h4 class="quick-palette-title">Stage Quick Set <span class="quick-palette-hint">(Click to apply Color & Luminosity to ALL ${stageLightUUIDs.length} Stage lights)</span></h4> <div class="palette-grid">`; COLOR_LUMINOSITY_INTENSITY_PALETTE.forEach(colorGroup => { htmlContent += `<div class="palette-color-column">`; colorGroup.steps.forEach(swatch => { htmlContent += `<button type="button" class="color-luminosity-swatch-button" data-color="${swatch.targetColor}" data-luminosity="${swatch.luminosity}" data-intensity="${swatch.intensity}" style="background-color: ${swatch.visualColor};" title="Set Stage: ${swatch.targetColor}, Lum ${swatch.luminosity.toFixed(2)}"></button>`; }); htmlContent += `</div>`; }); htmlContent += `</div></div>`; htmlContent += `<div class="quick-animation-types"> <h4 class="quick-animation-title">Stage Quick Animations <span class="quick-animation-hint">(Click to apply instantly to ALL ${stageLightUUIDs.length} Stage lights)</span></h4> ${sortedAnimationTypes.map(anim => `<button type="button" class="animation-type-button" data-animation-type="${anim.key}" title="Set Stage Lights Animation to ${anim.label}">${anim.label}</button>`).join('')} </div>`; htmlContent += `<div class="quick-animation-sliders">`; htmlContent += `<div class="slider-control-row"> <label for="stage-anim-speed-slider" class="slider-label" title="Animation Speed (${ANIM_SLIDER_MIN}-${ANIM_SLIDER_MAX})">Speed:</label> <input type="range" id="stage-anim-speed-slider" class="anim-slider" name="stage_anim_speed" min="${ANIM_SLIDER_MIN}" max="${ANIM_SLIDER_MAX}" step="${ANIM_SLIDER_STEP}" value="${DEFAULT_ANIMATION_SPEED}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-anim-speed-value">${DEFAULT_ANIMATION_SPEED}</span> </div>`; htmlContent += `<div class="slider-control-row"> <label for="stage-anim-intensity-slider" class="slider-label" title="Animation Intensity (${ANIM_SLIDER_MIN}-${ANIM_SLIDER_MAX})">Anim Intensity:</label> <input type="range" id="stage-anim-intensity-slider" class="anim-slider" name="stage_anim_intensity" min="${ANIM_SLIDER_MIN}" max="${ANIM_SLIDER_MAX}" step="${ANIM_SLIDER_STEP}" value="${DEFAULT_ANIMATION_INTENSITY}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-anim-intensity-value">${DEFAULT_ANIMATION_INTENSITY}</span> </div>`; htmlContent += `<div class="slider-control-row"> <label for="stage-focus-slider" class="slider-label" title="Focus (Attenuation: 0=Wide, 1=Narrow)">Focus:</label> <input type="range" id="stage-focus-slider" class="focus-slider" name="stage_focus" min="${FOCUS_SLIDER_MIN}" max="${FOCUS_SLIDER_MAX}" step="${FOCUS_SLIDER_STEP}" value="${DEFAULT_FOCUS_VALUE}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-focus-value">${DEFAULT_FOCUS_VALUE.toFixed(2)}</span> </div>`;
    htmlContent += `<div class="slider-control-row"> <label for="stage-master-brightness-slider" class="slider-label" title="Master Brightness (Luminosity: ${LUMINOSITY_SLIDER_MIN.toFixed(1)}-${LUMINOSITY_SLIDER_MAX.toFixed(1)}; pairs with opacity for subtle lows)">Brightness:</label> <input type="range" id="stage-master-brightness-slider" class="luminosity-slider" name="stage_master_brightness" min="${LUMINOSITY_SLIDER_MIN}" max="${LUMINOSITY_SLIDER_MAX}" step="${LUMINOSITY_SLIDER_STEP}" value="${DEFAULT_LUMINOSITY_VALUE}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-master-brightness-value">${DEFAULT_LUMINOSITY_VALUE.toFixed(2)}</span> </div>`;
    htmlContent += `<div class="slider-control-row"> <label for="stage-color-intensity-slider" class="slider-label" title="Colour intensity: left = muted (saturation -1), right = vivid (+1), centre = neutral">Color Intensity:</label> <input type="range" id="stage-color-intensity-slider" class="saturation-slider" name="stage_color_intensity" min="${COLOR_INTENSITY_SLIDER_MIN}" max="${COLOR_INTENSITY_SLIDER_MAX}" step="${COLOR_INTENSITY_SLIDER_STEP}" value="${DEFAULT_COLOR_INTENSITY_VALUE}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-color-intensity-value">${DEFAULT_COLOR_INTENSITY_VALUE.toFixed(2)}</span> </div>`;
    htmlContent += `<div class="slider-control-row"> <label for="stage-master-bright-radius-slider" class="slider-label" title="Bright radius for ALL stage lights (grid units). Dim is kept &ge; bright.">Bright:</label> <input type="range" id="stage-master-bright-radius-slider" class="radius-slider" name="stage_master_bright" min="${STAGE_BRIGHT_SLIDER_MIN}" max="${STAGE_BRIGHT_SLIDER_MAX}" step="${STAGE_BRIGHT_DIM_SLIDER_STEP}" value="${DEFAULT_AMBIENT_BRIGHT}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-master-bright-value">${DEFAULT_AMBIENT_BRIGHT}</span> </div>`;
    htmlContent += `<div class="slider-control-row"> <label for="stage-master-dim-radius-slider" class="slider-label" title="Dim radius for ALL stage lights (grid units). Raised if below bright.">Dim:</label> <input type="range" id="stage-master-dim-radius-slider" class="radius-slider" name="stage_master_dim" min="${STAGE_DIM_SLIDER_MIN}" max="${STAGE_DIM_SLIDER_MAX}" step="${STAGE_BRIGHT_DIM_SLIDER_STEP}" value="${DEFAULT_AMBIENT_DIM}" ${stageLightUUIDs.length === 0 ? 'disabled' : ''} /> <span class="slider-value" id="stage-master-dim-value">${DEFAULT_AMBIENT_DIM}</span> </div>`;
    htmlContent += `</div>`; htmlContent += `<div class="quick-environment-types"> <h4 class="quick-environment-title">Stage Environments <span class="quick-environment-hint">(Randomly sets ALL ${stageLightUUIDs.length} Stage lights to theme colors)</span></h4>`; ENVIRONMENT_PALETTES.forEach(env => { const colors = env.colors && env.colors.length > 0 ? env.colors.map(c => normalizeColorToString(c) ?? DEFAULT_ON_COLOR) : [DEFAULT_ON_COLOR]; const color1 = colors[0]; const color2 = colors.length > 1 ? colors[1] : color1; const colorsString = colors.join(' / '); const title = `Set Stage Environment: ${env.name} (${colorsString})${env.description ? ` - ${env.description}` : ''}`; const colorsDataAttribute = JSON.stringify(colors).replace(/'/g, "\\'"); htmlContent += `<button type="button" class="environment-type-button" data-colors='${colorsDataAttribute}' style="background: linear-gradient(to right, ${color1}, ${color2});" title="${title}">${env.name}</button>`; }); htmlContent += `</div>`; } else if (stageBoundsDefined) { htmlContent += `<div class="quick-controls-info"><p>No non-spotlight lights detected in Stage Area. Stage Quick Controls disabled.</p></div>`; }

    htmlContent += generateGroupHtml('stage', 'Stage Lights', lightGroups.stage);
    htmlContent += generateGroupHtml('house', 'House Lights', lightGroups.house);

    htmlContent += `</div></form>`;

    // --- CSS Styles ---
    htmlContent += `
    <style>
    /* General Dialog Styles */
    .dialog.${DIALOG_ID.replace('#','')} { font-size: 13px; }
    .dialog.${DIALOG_ID.replace('#','')} .window-content { padding: 5px !important; overflow-y: hidden; }
    .dialog.${DIALOG_ID.replace('#','')} .dialog-content { padding: 0 !important; }
    .dialog.${DIALOG_ID.replace('#','')} .window-content > form.light-toggle-form { width: 100%; border: none; padding: 0; background: none; display: flex; flex-direction: column; height: 100%; }
    .dialog.${DIALOG_ID.replace('#','')} .light-list-area { flex-grow: 1; overflow-y: auto; overflow-x: hidden; padding: 5px 8px; border: 1px solid #ccc; border-radius: 3px; background: rgba(255,255,255,0.7); margin: 0px 0 5px 0; display: flex; flex-direction: column; }

    /* Small Action Buttons */
    .dialog.${DIALOG_ID.replace('#','')} .action-button { width: 24px; height: 24px; padding: 1px; line-height: 1; background: #e8e8e8; border: 1px solid #a0a0a0; border-radius: 3px; cursor: pointer; font-size: 0.9em; color: #333; min-width: unset; display: inline-flex; align-items: center; justify-content: center; text-align: center; transition: background-color 0.1s ease, border-color 0.1s ease; }
    .dialog.${DIALOG_ID.replace('#','')} .action-button i { line-height: inherit; margin: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .action-button:hover { background: #d8d8d8; border-color: #888;}
    .dialog.${DIALOG_ID.replace('#','')} .action-button:disabled { cursor: not-allowed; opacity: 0.6; background: #f0f0f0; border-color: #ccc; }
    .dialog.${DIALOG_ID.replace('#','')} .action-button:disabled:hover { background: #f0f0f0; border-color: #ccc; }

    /* Disabled/Info Text */
    .disabled-info { font-style: italic; color: #777; padding: 8px; text-align: center; background: rgba(0,0,0,0.05); border-radius: 3px; margin-bottom: 5px; }
    .quick-controls-info { font-style: italic; color: #777; padding: 8px; text-align: center; background: rgba(0,0,0,0.05); border-radius: 3px; margin-bottom: 5px; }


    /* Top Controls (Global On/Off, Fade Time) */
    .dialog.${DIALOG_ID.replace('#','')} .stage-quick-actions { padding: 10px 10px; background: rgba(0,0,0,0.1); border-bottom: 1px solid #bbb; margin-bottom: 10px; display: flex; align-items: center; gap: 15px; flex-wrap: wrap; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-quick-actions .quick-action-buttons { display: flex; gap: 8px; flex-wrap: wrap; flex-grow: 1; justify-content: flex-start; align-items: center; }
    .dialog.${DIALOG_ID.replace('#','')} .fade-time-inline-control { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; margin-right: 5px; } /* Style for moved fade time */
    .dialog.${DIALOG_ID.replace('#','')} .fade-time-inline-control label { margin-bottom: 0; white-space: nowrap; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button,
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button { padding: 3px 8px; font-size: 1.0em; font-weight: bold; border-radius: 5px; border: 1px solid #555; cursor: pointer; transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease; line-height: 1.2; display: inline-flex; align-items: center; justify-content: center; min-width: 90px; text-align: center; width: auto; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button:hover,
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button:hover { transform: scale(1.02); filter: brightness(1.1); }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button i,
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button i { margin-right: 4px; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button.stage-off { background-color: #c0392b; color: white; border-color: #a03020; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button.stage-off:hover { background-color: #e74c3c; border-color: #c0392b; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button.stage-on-white { background-color: #f8f9fa; color: #212529; border-color: #adb5bd; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button.stage-on-white:hover { background-color: #e9ecef; border-color: #9098a0; }
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button.house-off { background-color: #a0522d; color: white; border-color: #8b4513; }
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button.house-off:hover { background-color: #b8860b; border-color: #a0522d; }
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button.house-on { background-color: ${normalizedHouseColor || '#f5deb3'}; color: #3d2b1f; border-color: #d2b48c; text-shadow: 1px 1px 1px rgba(0,0,0,0.1); }
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button.house-on:hover { filter: brightness(1.1); border-color: #c19a6b; }

/* START NEW STYLE */
.dialog.${DIALOG_ID.replace('#','')} .stage-action-button.export-macro { background-color: #3498db; color: white; border-color: #2980b9; }
.dialog.${DIALOG_ID.replace('#','')} .stage-action-button.export-macro:hover { background-color: #2c3e50; border-color: #212f3c; }


    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button:disabled,
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button:disabled { cursor: not-allowed; opacity: 0.6; }
    .dialog.${DIALOG_ID.replace('#','')} .stage-action-button:disabled:hover,
    .dialog.${DIALOG_ID.replace('#','')} .house-action-button:disabled:hover { transform: none; filter: none; }
    .dialog.${DIALOG_ID.replace('#','')} .button-separator { color: #999; font-weight: bold; display: inline-block; margin: 0 5px; }

    /* Spotlight Section */
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-controls { padding: 8px 6px 10px 6px; margin-bottom: 10px; border: 1px solid #b5b5b5; border-radius: 3px; background-color: rgba(200, 200, 220, 0.1); flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-title { margin: 0 0 8px 2px; font-size: 1.1em; font-weight: bold; color: #333; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-hint { font-size: 0.9em; font-weight: normal; color: #555; margin-left: 5px; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list { list-style: none; padding: 5px; margin: 0; max-height: 150px; overflow-y: auto; border: 1px solid #ddd; background: #fff; border-radius: 3px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list li { padding: 4px 8px; border: 1px solid #eee; border-radius: 3px; display: flex; align-items: center; justify-content: space-between; gap: 10px; background-color: #f9f9f9; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list .token-name { flex-grow: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.95em; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list input[type="checkbox"] { margin-left: 5px; flex-shrink: 0; height: 16px; width: 16px; cursor: pointer; }
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list .spotlight-loading,
    .dialog.${DIALOG_ID.replace('#','')} .spotlight-token-list .spotlight-empty { font-style: italic; color: #777; padding: 8px; text-align: center; grid-column: 1 / -1; background-color: transparent; border: none; }

    /* Quick Control Sections */
    .dialog.${DIALOG_ID.replace('#','')} .quick-color-luminosity-palette,
    .dialog.${DIALOG_ID.replace('#','')} .quick-animation-types,
    .dialog.${DIALOG_ID.replace('#','')} .quick-animation-sliders,
    .dialog.${DIALOG_ID.replace('#','')} .quick-environment-types { padding: 3px 3px 3px 6px; margin-bottom: 3px; border: 1px solid #ddd; border-radius: 3px; background-color: rgba(0,0,0,0.03); text-align: left; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .quick-palette-title,
    .dialog.${DIALOG_ID.replace('#','')} .quick-animation-title,
    .dialog.${DIALOG_ID.replace('#','')} .quick-environment-title { margin: 0 0 8px 2px; font-size: 1em; font-weight: bold; color: #333; }
    .dialog.${DIALOG_ID.replace('#','')} .quick-palette-hint,
    .dialog.${DIALOG_ID.replace('#','')} .quick-animation-hint,
    .dialog.${DIALOG_ID.replace('#','')} .quick-environment-hint { font-size: 0.9em; font-weight: normal; color: #555; margin-left: 5px; }

    /* Color/Luminosity Palette Grid */
    .dialog.${DIALOG_ID.replace('#','')} .palette-grid { display: flex; flex-wrap: nowrap; gap: 5px; padding-top: 5px; padding-bottom: 10px; overflow-x: auto; overflow-y: hidden; }
    .dialog.${DIALOG_ID.replace('#','')} .palette-color-column { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button { width: 19.7px !important; height: 20px; border: 1px solid #999; border-radius: 3px; padding: 0; cursor: pointer; box-shadow: inset 0 0 3px rgba(0,0,0,0.2); transition: transform 0.1s ease-out, box-shadow 0.1s ease-out, border-color 0.1s ease-out; vertical-align: middle; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button:hover { transform: scale(1.1); box-shadow: 0px 1px 5px rgba(0,0,0,0.3); border-color: #333; z-index: 1; position: relative; }
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button[style*="background-color: rgb(0, 0, 0)"],
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button[style*="#000000"] { border-color: #bbb; }
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button[style*="background-color: rgb(0, 0, 0)"]:hover,
    .dialog.${DIALOG_ID.replace('#','')} .color-luminosity-swatch-button[style*="#000000"]:hover { border-color: #fff; }

    /* Quick Animation Buttons */
    .dialog.${DIALOG_ID.replace('#','')} .animation-type-button { display: inline-block; width: auto; max-width: 160px; padding: 3px 8px; margin: 3px; font-size: 0.9em; line-height: 1.4; background-color: #f0f0f0; border: 1px solid #b5b5b5; border-radius: 3px; cursor: pointer; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; transition: background-color 0.15s ease, border-color 0.15s ease; }
    .dialog.${DIALOG_ID.replace('#','')} .animation-type-button:hover { background-color: #e0e0e0; border-color: #909090; }

    /* Animation/Focus/Luminosity/Saturation Sliders */
    .dialog.${DIALOG_ID.replace('#','')} .quick-animation-sliders { padding: 8px 6px; }
    .dialog.${DIALOG_ID.replace('#','')} .slider-control-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
    .dialog.${DIALOG_ID.replace('#','')} .slider-control-row:last-child { margin-bottom: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .slider-label { width: 95px; text-align: right; font-size: 0.9em; color: #444; flex-shrink: 0; white-space: nowrap; } /* Adjusted width for longer labels */
    .dialog.${DIALOG_ID.replace('#','')} .anim-slider,
    .dialog.${DIALOG_ID.replace('#','')} .focus-slider,
    .dialog.${DIALOG_ID.replace('#','')} .luminosity-slider,
    .dialog.${DIALOG_ID.replace('#','')} .saturation-slider { flex-grow: 1; height: 10px; cursor: pointer; margin: 0; padding: 0; accent-color: #555; }
    .dialog.${DIALOG_ID.replace('#','')} .anim-slider:disabled,
    .dialog.${DIALOG_ID.replace('#','')} .focus-slider:disabled,
    .dialog.${DIALOG_ID.replace('#','')} .luminosity-slider:disabled,
    .dialog.${DIALOG_ID.replace('#','')} .saturation-slider:disabled,
    .dialog.${DIALOG_ID.replace('#','')} .radius-slider:disabled { cursor: not-allowed; opacity: 0.5; }
    .dialog.${DIALOG_ID.replace('#','')} .slider-value { font-weight: bold; min-width: 35px; text-align: right; font-size: 0.9em; color: #333; font-family: monospace; } /* Using monospace for consistent width */

    /* Environment Buttons */
    .dialog.${DIALOG_ID.replace('#','')} .environment-type-button { display: inline-block; width: auto; max-width: 180px; padding: 4px 10px; margin: 3px; font-size: 0.95em; font-weight: bold; line-height: 1.4; color: white; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); border: 1px solid rgba(0,0,0,0.4); border-radius: 4px; cursor: pointer; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; transition: filter 0.15s ease, border-color 0.15s ease, transform 0.1s ease; }
    .dialog.${DIALOG_ID.replace('#','')} .environment-type-button:hover { filter: brightness(1.15); border-color: rgba(255,255,255,0.7); transform: translateY(-1px); }

    /* Light Group Styling */
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent { border: 1px solid #ccc; border-radius: 4px; margin-bottom: 6px; background-color: #f9f9f9; overflow: hidden; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent .group-header { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid #ddd; background-color: #efefef; position: relative; display: flex; align-items: center; gap: 8px; }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent.collapsed .group-header { border-bottom: none; }
    .dialog.${DIALOG_ID.replace('#','')} .group-toggle-vis { width: 20px; text-align: center; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .group-selector { width: 20px; text-align: center; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .group-name-details { flex-grow: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: bold; color: #444; min-width: 50px; }
    .dialog.${DIALOG_ID.replace('#','')} .group-actions { margin-left: auto; flex-shrink: 0; display: flex; align-items: center; gap: 5px; }
    .dialog.${DIALOG_ID.replace('#','')} .group-toggle-vis button { width: 20px; height: 20px; padding: 0; line-height: 20px; background: #e8e8e8; border: 1px solid #aaa; border-radius: 3px; cursor: pointer; font-size: 0.8em; color: #333; display: inline-flex; align-items: center; justify-content: center; }
    .dialog.${DIALOG_ID.replace('#','')} .group-toggle-vis button:hover { background: #ddd; }
    .dialog.${DIALOG_ID.replace('#','')} .group-toggle-vis button:disabled { cursor: not-allowed; opacity: 0.6; }
    .dialog.${DIALOG_ID.replace('#','')} .group-toggle-vis i { transition: transform 0.2s ease-in-out; display: inline-block; line-height: inherit; }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-children { list-style: none; padding: 5px 5px 5px 15px; margin: 0; display: block; border-top: 1px solid #eee; background-color: #fff; }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent.collapsed .light-group-children { display: none; }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent.collapsed .group-toggle-vis i { transform: rotate(-90deg); }
    .dialog.${DIALOG_ID.replace('#','')} .light-group-parent:not(.collapsed) .group-toggle-vis i { transform: rotate(0deg); }
    .dialog.${DIALOG_ID.replace('#','')} .empty-group-message { font-style: italic; color: #777; padding: 8px 0; text-align: center; }

    /* Individual Light Item Styling */
    .dialog.${DIALOG_ID.replace('#','')} .${LIGHT_ITEM_CLASS} { padding: 5px 6px; border-bottom: 1px solid #eee; position: relative; display: flex; align-items: center; gap: 8px; transition: background-color 0.1s ease; }
    .dialog.${DIALOG_ID.replace('#','')} .${LIGHT_ITEM_CLASS}:last-child { border-bottom: none; }
    .dialog.${DIALOG_ID.replace('#','')} .${LIGHT_ITEM_CLASS}:hover { background-color: #f5f5f5; }
    .dialog.${DIALOG_ID.replace('#','')} .light-selector { width: 20px; text-align: center; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .light-status-color { display: inline-flex; align-items: center; gap: 5px; min-width: 45px; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .light-name-details { flex-grow: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 50px; display: inline-flex; align-items: center; }
    .dialog.${DIALOG_ID.replace('#','')} .light-actions { margin-left: auto; flex-shrink: 0; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }

    /* Light Label ([Stage]/[House]) */
    .dialog.${DIALOG_ID.replace('#','')} .light-label { font-size: 0.8em; font-weight: bold; padding: 1px 5px; border-radius: 3px; margin-right: 6px; vertical-align: middle; line-height: 1.3; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid transparent; white-space: nowrap; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .light-label.stage { background-color: #d1e7dd; color: #0f5132; border-color: #badbcc; }
    .dialog.${DIALOG_ID.replace('#','')} .light-label.house { background-color: #fff3cd; color: #664d03; border-color: #ffecb5; }

    /* Light Status Dot and Color Swatch */
    .dialog.${DIALOG_ID.replace('#','')} .light-status { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 1px solid #555; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .light-status.green { background-color: #2ecc71; border-color: #27ae60; box-shadow: 0 0 4px #2ecc71; }
    .dialog.${DIALOG_ID.replace('#','')} .light-status.red { background-color: #e74c3c; border-color: #c0392b; box-shadow: 0 0 4px #e74c3c; }
    .dialog.${DIALOG_ID.replace('#','')} .color-swatch { display: inline-block; width: 15px; height: 15px; border: 1px solid #666; vertical-align: middle; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .color-swatch[style*="background-color: rgb(0, 0, 0)"],
    .dialog.${DIALOG_ID.replace('#','')} .color-swatch[style*="#000000"] { border-color: #ccc; }

    /* Light Name */
    .dialog.${DIALOG_ID.replace('#','')} .light-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.95em; vertical-align: middle; }

    /* Individual Color Input */
    .dialog.${DIALOG_ID.replace('#','')} .current-color-wrapper { display: inline-flex; align-items: center; border: 1px solid #aaa; border-radius: 3px; padding: 2px 4px; background: #fdfdfd; }
    .dialog.${DIALOG_ID.replace('#','')} .current-color-wrapper i.fa-palette { margin-right: 4px; color: #555; font-size: 0.9em; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .current-color-wrapper input[type="color"] { width: 35px; height: 18px; padding: 0; border: none; cursor: pointer !important; background-color: transparent; margin: 0 3px 0 0; min-width: 35px; }
    .dialog.${DIALOG_ID.replace('#','')} .current-color-wrapper .action-button { margin-left: 3px; width: 20px; height: 20px; font-size: 0.8em; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .house-no-color-controls { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8em; color: #666; white-space: nowrap; padding: 2px 4px; border: 1px dashed #ccc; border-radius: 3px; background: #fafafa; }
    .dialog.${DIALOG_ID.replace('#','')} .house-no-color-controls i { color: #888; }

    /* Individual Focus Slider */
    .dialog.${DIALOG_ID.replace('#','')} .individual-focus-control { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #bbb; border-radius: 3px; padding: 1px 5px; background: #f5f5f5; max-width: 130px; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-focus-control i.fa-crosshairs { font-size: 0.9em; color: #444; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-focus-slider { height: 8px; flex-grow: 1; min-width: 50px; accent-color: #666; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-focus-value { font-size: 0.85em; font-family: monospace; min-width: 28px; text-align: right; color: #222; flex-shrink: 0; }

    /* Individual Position Sliders */
    .dialog.${DIALOG_ID.replace('#','')} .individual-position-controls { display: flex; flex-direction: column; gap: 2px; border: 1px solid #bbb; border-radius: 3px; padding: 3px 5px; background: #f5f5f5; margin-left: 3px; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-pos-control { display: inline-flex; align-items: center; gap: 4px; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-pos-control i { font-size: 0.9em; color: #444; flex-shrink: 0; width: 12px; text-align: center; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-pos-slider { height: 8px; flex-grow: 1; min-width: 70px; accent-color: #666; cursor: grab; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-pos-slider:active { cursor: grabbing; }
    .dialog.${DIALOG_ID.replace('#','')} .individual-pos-value { font-size: 0.85em; font-family: monospace; min-width: 35px; text-align: right; color: #222; flex-shrink: 0; }

    /* Dialog Buttons */
    .dialog.${DIALOG_ID.replace('#','')} .dialog-buttons { margin-top: 8px; padding: 10px 0 0 0 !important; border-top: 1px solid #bbb !important; height: auto !important; background: rgba(0,0,0,0.05); text-align: right; flex-shrink: 0; }
    .dialog.${DIALOG_ID.replace('#','')} .dialog-buttons button { margin-left: 5px; }
    .dialog.${DIALOG_ID.replace('#','')} .dialog-buttons button i { margin-right: 3px; }
    </style>`;

    // --- Dialog Definition ---
    const dialogData = {
        title: `Location Light Controller`,
        content: htmlContent,
        buttons: {
            close: {
                icon: '<i class="fas fa-times"></i>',
                label: "Close",
                callback: async (html) => {
                    console.log("Macro | Dialog closing. Cleaning up spotlights and hooks.");
                    if (isAnimatingManually) { cancelCurrentAnimation = true; }
                    const lightIdsToDelete = Array.from(activeSpotlights.values());
                    if (lightIdsToDelete.length > 0) { try { await canvas.scene.deleteEmbeddedDocuments("AmbientLight", lightIdsToDelete); } catch (err) { console.error("Macro | Error deleting spotlight lights on close:", err); } }
                    activeSpotlights.clear();
                    if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null; }
                    if (tokenRefreshDebounceMap.size > 0) { for (const timeoutId of tokenRefreshDebounceMap.values()) { clearTimeout(timeoutId); } tokenRefreshDebounceMap.clear(); }
                    const hookIdsToUnregister = newDialog?._locLightControlHookIds ?? spotlightHookIds; // Use IDs stored on dialog if possible
                    console.log("Macro | Unregistering hooks:", hookIdsToUnregister);
                    hookIdsToUnregister.forEach(id => Hooks.off("updateToken", id));
                    hookIdsToUnregister.forEach(id => Hooks.off("deleteToken", id));
                    hookIdsToUnregister.forEach(id => Hooks.off("createToken", id));
                    hookIdsToUnregister.forEach(id => Hooks.off("refreshToken", id));
                    spotlightHookIds = []; // Clear global fallback
                    if (newDialog) newDialog._locLightControlHookIds = []; // Clear on dialog instance
                }
            }
        },
        default: "close",
        render: (html) => {
            console.log("Macro | Dialog rendered, attaching event listeners and initializing.");
            const $html = $(html);
            const $spotlightList = $html.find('.spotlight-token-list');
            const $dialog = $html.closest('.app');
            if ($dialog.length) { $dialog.find('.window-title').text(`Location Light Controller (${totalLightCount} Lights)`); }

            const getAnimationSettings = () => { const $durationInput = $html.find('#fade-time'); let duration = parseInt($durationInput.val(), 10); if (isNaN(duration) || duration < 0) { duration = 0; } return { duration: duration, steps: duration > 0 ? ANIMATION_STEPS : 0 }; };
            const updateLightElementUI = (element, updateData) => {
                 const $element = $(element);
                if (!$element || $element.length === 0) return;

                const $statusSpan = $element.find('.light-status');
                const $colorSwatch = $element.find('.light-status-color .color-swatch');
                const $colorInput = $element.find('.light-current-color-input');
                const $focusSlider = $element.find('.individual-focus-slider');
                const $focusValueSpan = $element.find('.individual-focus-value');
                const $xSlider = $element.find('.individual-x-slider');
                const $xValueSpan = $element.find('.individual-x-value');
                const $ySlider = $element.find('.individual-y-slider');
                const $yValueSpan = $element.find('.individual-y-value');

                const lightUuid = $element.data(DATA_LIGHT_UUID.replace('data-', ''));
                const initialColorAttr = $element.data(DATA_INITIAL_COLOR.replace('data-', ''));
                const isMarkedHouseInitial = $element.find('.light-label.house').length > 0;
                const isMarkedStage = $element.find('.light-label.stage').length > 0;

                let baseColorForOnState;
                if (isMarkedStage) {
                     baseColorForOnState = (initialColorAttr && initialColorAttr !== "null" && initialColorAttr !== "undefined") ? initialColorAttr : DEFAULT_ON_COLOR;
                } else {
                    baseColorForOnState = (initialColorAttr && initialColorAttr !== "null" && initialColorAttr !== "undefined") ? initialColorAttr : DEFAULT_ON_COLOR;
                }

                let newLuminosity = undefined;
                let newColorValue = undefined;
                let newAttenuation = undefined;
                let newSaturation = undefined; // Check for saturation updates
                let newX = undefined;
                let newY = undefined;

                if (updateData.hasOwnProperty('luminosity')) { newLuminosity = updateData['luminosity']; }
                if (updateData.hasOwnProperty('color')) { newColorValue = normalizeColorToString(updateData['color']); }
                if (updateData.hasOwnProperty('config.attenuation')) { newAttenuation = updateData['config.attenuation']; }
                if (updateData.hasOwnProperty('attenuation')) { newAttenuation = updateData['attenuation']; }
                if (updateData.hasOwnProperty('config.saturation')) { newSaturation = updateData['config.saturation']; } // Check for saturation
                if (updateData.hasOwnProperty('saturation')) { newSaturation = updateData['saturation']; } // Check for saturation
                if (updateData.hasOwnProperty('x')) { newX = updateData['x']; }
                if (updateData.hasOwnProperty('y')) { newY = updateData['y']; }

                const lightDoc = lightDocMap.get(lightUuid);
                let isEffectivelyOn;
                if (newLuminosity !== undefined) {
                    isEffectivelyOn = newLuminosity > OFF_LUMINOSITY;
                } else {
                    const currentLuminosity = lightDoc?.config?.luminosity ?? 0.0;
                    isEffectivelyOn = currentLuminosity > OFF_LUMINOSITY;
                }

                // Update Status Dot
                if ($statusSpan.length) {
                    const effectiveLuminosity = newLuminosity !== undefined ? newLuminosity : (lightDoc?.config?.luminosity ?? 0.0);
                    $statusSpan.toggleClass('red', !isEffectivelyOn);
                    $statusSpan.toggleClass('green', isEffectivelyOn);
                    $statusSpan.attr('title', isEffectivelyOn ? `Visible (Luminosity ${effectiveLuminosity.toFixed(2)})` : `Off (Luminosity ${OFF_LUMINOSITY})`);
                }

                // Update Color Swatch and Color Input (house rows: luminosity only; no colour control)
                if (isMarkedHouseInitial) {
                    const houseDisplay = isEffectivelyOn ? '#a8a8a8' : OFF_COLOR;
                    const lumShow = newLuminosity !== undefined ? newLuminosity : (lightDoc?.config?.luminosity ?? 0.0);
                    if ($colorSwatch.length) {
                        $colorSwatch.css('background-color', houseDisplay);
                        $colorSwatch.attr(
                            'title',
                            isEffectivelyOn
                                ? `House on (luminosity ${lumShow.toFixed(2)}); colour is not set by this macro`
                                : `Off (luminosity ${OFF_LUMINOSITY})`
                        );
                    }
                } else {
                    let displayColor, inputColorValue;
                    const currentActualColor = normalizeColorToString(lightDoc?.config?.color) ?? $element.data(DATA_INITIAL_COLOR.replace('data-', ''));

                    if (isEffectivelyOn) {
                        const colorToUse = newColorValue ?? currentActualColor ?? baseColorForOnState;
                        displayColor = colorToUse;
                        inputColorValue = colorToUse;
                    } else {
                        displayColor = OFF_COLOR;
                        inputColorValue = (newColorValue === OFF_COLOR) ? OFF_COLOR : (currentActualColor ?? OFF_COLOR);
                    }

                    if ($colorSwatch.length) {
                        $colorSwatch.css('background-color', displayColor);
                        $colorSwatch.attr('title', `Current Light Color: ${isEffectivelyOn ? (currentActualColor ?? 'Unknown') : 'None'}`);
                    }
                    if ($colorInput.length) {
                        const currentInputColor = normalizeColorToString($colorInput.val());
                        if (inputColorValue !== currentInputColor) {
                            $colorInput.val(inputColorValue);
                        }
                    }
                }

                // Update Focus Slider and Value
                if (newAttenuation !== undefined) {
                     const newValue = parseFloat(newAttenuation);
                     if($focusSlider.length) {
                        const currentSliderValue = parseFloat($focusSlider.val());
                        if (Math.abs(currentSliderValue - newValue) > 0.001) { $focusSlider.val(newValue); }
                     }
                    if ($focusValueSpan.length) { $focusValueSpan.text(newValue.toFixed(2)); }
                }

                // Saturation doesn't have a direct UI element in the list item, no update needed here

                // Update X Position Slider and Value
                if (newX !== undefined) {
                     const newXInt = Math.round(newX);
                    if($xSlider.length) {
                        const currentSliderValX = parseInt($xSlider.val());
                        if (currentSliderValX !== newXInt) { $xSlider.val(newXInt); }
                    }
                    if ($xValueSpan.length) { $xValueSpan.text(newXInt); }
                }

                // Update Y Position Slider and Value
                if (newY !== undefined) {
                     const newYInt = Math.round(newY);
                    if ($ySlider.length) {
                        const currentSliderValY = parseInt($ySlider.val());
                         if (currentSliderValY !== newYInt) { $ySlider.val(newYInt); }
                    }
                    if ($yValueSpan.length) { $yValueSpan.text(newYInt); }
                }
            };
            const getToggleTransitionData = (element) => {
                 const $element = $(element);
                const lightUuid = $element.data(DATA_LIGHT_UUID.replace('data-', ''));
                const lightDoc = lightDocMap.get(lightUuid);
                if (!lightUuid || !lightDoc?.config) { console.warn("getToggleTransitionData: Could not find lightDoc or config for", lightUuid); return null; }

                const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
                const currentColor = normalizeColorToString(lightDoc.config.color);
                const isCurrentlyEffectivelyOn = currentLuminosity > OFF_LUMINOSITY;

                const initialColorAttr = $element.data(DATA_INITIAL_COLOR.replace('data-', ''));
                 const wasInitiallyStage = $element.find('.light-label.stage').length > 0;
                 const wasInitiallyHouse = $element.find('.light-label.house').length > 0;

                if (wasInitiallyHouse) {
                    const startState = { luminosity: currentLuminosity };
                    const endLum = isCurrentlyEffectivelyOn ? OFF_LUMINOSITY : TARGET_ON_LUMINOSITY;
                    const endState = { luminosity: endLum };
                    const uiUpdateData = { luminosity: endLum };
                    return { uuid: lightUuid, startState, endState, uiUpdateData, luminosityOnly: true };
                }

                let targetOnColor;
                if (wasInitiallyStage) {
                    targetOnColor = (initialColorAttr && initialColorAttr !== "null" && initialColorAttr !== "undefined") ? initialColorAttr : DEFAULT_ON_COLOR;
                } else {
                    targetOnColor = (initialColorAttr && initialColorAttr !== "null" && initialColorAttr !== "undefined") ? initialColorAttr : DEFAULT_ON_COLOR;
                }

                const startState = { color: currentColor ?? OFF_COLOR, luminosity: currentLuminosity };
                let endState;

                if (isCurrentlyEffectivelyOn) { // Turn OFF
                    endState = { color: OFF_COLOR, luminosity: OFF_LUMINOSITY };
                } else { // Turn ON
                    endState = { color: targetOnColor, luminosity: TARGET_ON_LUMINOSITY };
                }

                const uiUpdateData = { color: endState.color, luminosity: endState.luminosity };

                return { uuid: lightUuid, startState, endState, uiUpdateData };
            };
            const applyBulkLightUpdates = async (transitions, elementsToUpdate, notificationMessage, errorMessagePrefix) => {
                if (!transitions || transitions.length === 0) { return; }
                if (isAnimatingManually) {
                    console.log(`[${errorMessagePrefix}] Request to interrupt existing animation.`);
                    ui.notifications.warn("Interrupting previous light animation...", { permanent: false });
                    cancelCurrentAnimation = true;
                    const interruptFadeMs = getAnimationSettings().duration;
                    const interruptBudgetMs = Math.max(ANIMATION_INTERRUPT_WAIT_TIMEOUT_MS, interruptFadeMs + 2000);
                    const waitStart = Date.now();
                    while (isAnimatingManually && (Date.now() - waitStart < interruptBudgetMs)) {
                        await sleep(ANIMATION_INTERRUPT_CHECK_INTERVAL_MS);
                    }
                    if (isAnimatingManually) {
                        console.error(`[${errorMessagePrefix}] Failed to interrupt previous animation cleanly. Aborting.`);
                        ui.notifications.error("Failed to interrupt previous animation.");
                        cancelCurrentAnimation = false;
                        return;
                    }
                    console.log(`[${errorMessagePrefix}] Previous animation lock released. Proceeding.`);
                    cancelCurrentAnimation = false;
                }
                const animSettings = getAnimationSettings();
                const luminosityOnly = transitions.length > 0 && transitions.every((t) => t.luminosityOnly === true);
                try {
                    isAnimatingManually = true;
                    console.log(`[${errorMessagePrefix}] Animation lock acquired.`);
                    cancelCurrentAnimation = false;
                    await bulkAnimateLightsManually(transitions, animSettings.duration, animSettings.steps, lightDocMap, luminosityOnly);
                    if (!cancelCurrentAnimation) {
                        elementsToUpdate.forEach((item) => {
                            const elUuid = getLightUuidFromElement(item.element);
                            const lightDoc = lightDocMap.get(elUuid);
                            if (lightDoc) {
                                const trans = transitions.find((t) => t.uuid === elUuid);
                                const endState = trans?.endState;
                                if (endState) {
                                    const b0 = (Number(lightDoc.config?.bright) || 0) <= 0 && (Number(lightDoc.config?.dim) || 0) <= 0;
                                    const lumOn = (endState.luminosity ?? OFF_LUMINOSITY) > OFF_LUMINOSITY;
                                    let cfg;
                                    if (trans.luminosityOnly) {
                                        cfg = { luminosity: endState.luminosity, color: null };
                                    } else {
                                        cfg = { color: endState.color, luminosity: endState.luminosity };
                                    }
                                    if (b0 && lumOn) {
                                        cfg.bright = DEFAULT_AMBIENT_BRIGHT;
                                        cfg.dim = DEFAULT_AMBIENT_DIM;
                                    }
                                    lightDoc.updateSource({ config: cfg }, { diff: false });
                                }
                            }
                            updateLightElementUI(item.element, item.data);
                        });
                        if (notificationMessage) {
                            ui.notifications.info(`${notificationMessage} (${transitions.length} light${transitions.length > 1 ? "s" : ""}).`);
                        }
                    } else {
                        console.log(`[${errorMessagePrefix}] Skipping UI updates as animation was cancelled.`);
                    }
                } catch (err) {
                    console.error(`[${errorMessagePrefix}] Error during animation/update:`, err);
                    ui.notifications.error(`Error ${errorMessagePrefix}. Check console (F12).`);
                } finally {
                    isAnimatingManually = false;
                    console.log(`[${errorMessagePrefix}] Animation lock released.`);
                    cancelCurrentAnimation = false;
                }
            };
            const getStageLightElements = () => {
                let $stageLightElements = $(); if (!stageLightUUIDs || stageLightUUIDs.length === 0) return $stageLightElements; stageLightUUIDs.forEach(uuid => { $stageLightElements = $stageLightElements.add($html.find(`.${LIGHT_ITEM_CLASS}[${DATA_LIGHT_UUID}="${uuid}"]`)); }); return $stageLightElements;
             };
            const getListedHouseLightElements = () => $html.find('.light-group-parent[data-group-type="house"] .' + LIGHT_ITEM_CLASS);
            const getColorLuminosityTransitions = ($elements, targetColor, targetLuminosity) => {
                const transitions = []; const elementsToUpdate = []; const normalizedTargetColor = normalizeColorToString(targetColor); $elements.each((i, el) => { const $el = $(el); const lightUuid = $el.data(DATA_LIGHT_UUID.replace('data-', '')); const lightDoc = lightDocMap.get(lightUuid); if (!lightUuid || !lightDoc?.config) return; const currentLuminosity = lightDoc.config.luminosity ?? 0.0; const currentColor = normalizeColorToString(lightDoc.config.color); const alreadyAtTarget = Math.abs(currentLuminosity - targetLuminosity) < 0.01 && currentColor === normalizedTargetColor; if (alreadyAtTarget) return; const startState = { color: currentColor ?? OFF_COLOR, luminosity: currentLuminosity }; const endState = { color: normalizedTargetColor, luminosity: targetLuminosity }; const uiUpdateData = { color: normalizedTargetColor, luminosity: targetLuminosity }; transitions.push({ uuid: lightUuid, startState, endState }); elementsToUpdate.push({ element: el, data: uiUpdateData }); }); return { transitions, elementsToUpdate };
             };
            const getColorTransitions = ($elements, newColor) => {
                const transitions = [];
                const elementsToUpdate = [];
                const normalizedNewColor = normalizeColorToString(newColor);
                $elements.each((i, el) => {
                    const $el = $(el);
                    const lightUuid = $el.data(DATA_LIGHT_UUID.replace('data-', ''));
                    const lightDoc = lightDocMap.get(lightUuid);
                    if (!lightUuid || !lightDoc?.config) return;
                    if ($el.find('.light-label.house').length > 0) return;
                    const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
                    const currentColor = normalizeColorToString(lightDoc.config.color);
                    if (currentLuminosity <= OFF_LUMINOSITY) {
                        console.log(`Skipping color set for ${lightUuid} - light is off.`);
                        return;
                    }
                    if (currentColor === normalizedNewColor) return;
                    const startState = { color: currentColor ?? DEFAULT_ON_COLOR, luminosity: currentLuminosity };
                    const endState = { color: normalizedNewColor, luminosity: currentLuminosity };
                    const uiUpdateData = { color: normalizedNewColor, luminosity: currentLuminosity };
                    transitions.push({ uuid: lightUuid, startState, endState });
                    elementsToUpdate.push({ element: el, data: uiUpdateData });
                });
                return { transitions, elementsToUpdate };
            };
            const getResetTransitions = ($elements) => {
                const transitions = [];
                const elementsToUpdate = [];
                $elements.each((i, el) => {
                    const $el = $(el);
                    const lightUuid = $el.data(DATA_LIGHT_UUID.replace('data-', ''));
                    const lightDoc = lightDocMap.get(lightUuid);
                    if (!lightUuid || !lightDoc?.config) return;
                    const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
                    const currentColor = normalizeColorToString(lightDoc.config.color);
                    const initialLuminosity = parseFloat($el.data(DATA_INITIAL_LUMINOSITY.replace('data-', ''))) || TARGET_ON_LUMINOSITY;
                    const isHouseRow = $el.find('.light-label.house').length > 0;
                    if (isHouseRow) {
                        if (Math.abs(currentLuminosity - initialLuminosity) < 0.01) return;
                        const startState = { luminosity: currentLuminosity };
                        const endState = { luminosity: initialLuminosity };
                        const uiUpdateData = { luminosity: initialLuminosity };
                        transitions.push({ uuid: lightUuid, startState, endState, luminosityOnly: true });
                        elementsToUpdate.push({ element: el, data: uiUpdateData });
                        return;
                    }
                    const initialColor = $el.data(DATA_INITIAL_COLOR.replace('data-', '')) || DEFAULT_ON_COLOR;
                    const colorMatches = (currentColor === initialColor) || (!currentColor && initialColor === DEFAULT_ON_COLOR);
                    const luminosityMatches = Math.abs(currentLuminosity - initialLuminosity) < 0.01;
                    if (colorMatches && luminosityMatches) return;
                    const startState = { color: currentColor, luminosity: currentLuminosity };
                    const endState = { color: initialColor, luminosity: initialLuminosity };
                    const uiUpdateData = { color: initialColor, luminosity: initialLuminosity };
                    transitions.push({ uuid: lightUuid, startState, endState });
                    elementsToUpdate.push({ element: el, data: uiUpdateData });
                });
                return { transitions, elementsToUpdate };
            };
            const checkGroupSelectState = ($groupParent) => {
                const $childrenCheckboxes = $groupParent.find('.light-select-checkbox'); const totalChildren = $childrenCheckboxes.length; const checkedChildren = $childrenCheckboxes.filter(':checked').length; const $groupCheckbox = $groupParent.find('.group-select-checkbox').first(); if (totalChildren === 0) { $groupCheckbox.prop({ checked: false, indeterminate: false }); } else if (checkedChildren === 0) { $groupCheckbox.prop({ checked: false, indeterminate: false }); } else if (checkedChildren === totalChildren) { $groupCheckbox.prop({ checked: true, indeterminate: false }); } else { $groupCheckbox.prop({ checked: false, indeterminate: true }); }
             };
            const initializeAnimationSliders = () => {
                if (stageLightUUIDs.length === 0) { $html.find('#stage-anim-speed-slider, #stage-anim-intensity-slider').prop('disabled', true); $html.find('#stage-anim-speed-value, #stage-anim-intensity-value').text('-'); return; } let totalSpeed = 0, totalIntensity = 0, count = 0; stageLightUUIDs.forEach(uuid => { const lightDoc = lightDocMap.get(uuid); const animConfig = lightDoc?.config?.animation; if (animConfig) { const speed = animConfig.speed; const intensity = animConfig.intensity; totalSpeed += (speed >= ANIM_SLIDER_MIN && speed <= ANIM_SLIDER_MAX ? speed : DEFAULT_ANIMATION_SPEED); totalIntensity += (intensity >= ANIM_SLIDER_MIN && intensity <= ANIM_SLIDER_MAX ? intensity : DEFAULT_ANIMATION_INTENSITY); } else { totalSpeed += DEFAULT_ANIMATION_SPEED; totalIntensity += DEFAULT_ANIMATION_INTENSITY; } count++; }); const avgSpeed = count > 0 ? Math.round(totalSpeed / count) : DEFAULT_ANIMATION_SPEED; const avgIntensity = count > 0 ? Math.round(totalIntensity / count) : DEFAULT_ANIMATION_INTENSITY; const clampedSpeed = Math.max(ANIM_SLIDER_MIN, Math.min(ANIM_SLIDER_MAX, avgSpeed)); const clampedIntensity = Math.max(ANIM_SLIDER_MIN, Math.min(ANIM_SLIDER_MAX, avgIntensity)); $html.find('#stage-anim-speed-slider').val(clampedSpeed).prop('disabled', false); $html.find('#stage-anim-speed-value').text(clampedSpeed); $html.find('#stage-anim-intensity-slider').val(clampedIntensity).prop('disabled', false); $html.find('#stage-anim-intensity-value').text(clampedIntensity);
            };
            const initializeFocusSliders = () => {
                 if (stageLightUUIDs.length === 0) { $html.find('#stage-focus-slider').prop('disabled', true); $html.find('#stage-focus-value').text('-'); return; } let totalAttenuation = 0, count = 0; stageLightUUIDs.forEach(uuid => { const lightDoc = lightDocMap.get(uuid); const attenuation = lightDoc?.config?.attenuation; totalAttenuation += (attenuation !== null && attenuation !== undefined ? attenuation : DEFAULT_FOCUS_VALUE); count++; }); const avgAttenuation = count > 0 ? (totalAttenuation / count) : DEFAULT_FOCUS_VALUE; const clampedAttenuation = Math.max(FOCUS_SLIDER_MIN, Math.min(FOCUS_SLIDER_MAX, avgAttenuation)); $html.find('#stage-focus-slider').val(clampedAttenuation).prop('disabled', false); $html.find('#stage-focus-value').text(clampedAttenuation.toFixed(2));
            };
            const initializeMasterBrightnessSlider = () => {
                 if (stageLightUUIDs.length === 0) { $html.find('#stage-master-brightness-slider').prop('disabled', true); $html.find('#stage-master-brightness-value').text('-'); return; } let totalLuminosity = 0, count = 0; stageLightUUIDs.forEach(uuid => { const lightDoc = lightDocMap.get(uuid); const luminosity = lightDoc?.config?.luminosity; if (luminosity !== null && luminosity !== undefined && luminosity > OFF_LUMINOSITY) { totalLuminosity += luminosity; count++; } }); const avgLuminosity = count > 0 ? (totalLuminosity / count) : OFF_LUMINOSITY; const clampedLuminosity = Math.max(LUMINOSITY_SLIDER_MIN, Math.min(LUMINOSITY_SLIDER_MAX, avgLuminosity)); $html.find('#stage-master-brightness-slider').val(clampedLuminosity).prop('disabled', false); $html.find('#stage-master-brightness-value').text(clampedLuminosity.toFixed(2));
            };
            // NEW: Initialize Color Intensity Slider
            const initializeColorIntensitySlider = () => {
                 if (stageLightUUIDs.length === 0) {
                     $html.find('#stage-color-intensity-slider').prop('disabled', true);
                     $html.find('#stage-color-intensity-value').text('-');
                     return;
                 }
                 let totalSaturation = 0, count = 0;
                 stageLightUUIDs.forEach(uuid => {
                     const lightDoc = lightDocMap.get(uuid);
                     const saturation = lightDoc?.config?.saturation;
                     totalSaturation += (saturation !== null && saturation !== undefined ? saturation : 0);
                     count++;
                 });
                 const avgFoundrySat = count > 0 ? (totalSaturation / count) : 0;
                 const slider01 = (avgFoundrySat + 1) / 2;
                 const clampedSlider = Math.max(COLOR_INTENSITY_SLIDER_MIN, Math.min(COLOR_INTENSITY_SLIDER_MAX, slider01));
                 $html.find('#stage-color-intensity-slider').val(clampedSlider).prop('disabled', false);
                 $html.find('#stage-color-intensity-value').text(clampedSlider.toFixed(2));
            };
            const initializeStageBrightDimSliders = () => {
                if (stageLightUUIDs.length === 0) {
                    $html.find('#stage-master-bright-radius-slider, #stage-master-dim-radius-slider').prop('disabled', true);
                    $html.find('#stage-master-bright-value, #stage-master-dim-value').text('-');
                    return;
                }
                let sumB = 0, sumD = 0, n = 0;
                stageLightUUIDs.forEach((uuid) => {
                    const lightDoc = lightDocMap.get(uuid);
                    const b = Number(lightDoc?.config?.bright);
                    const d = Number(lightDoc?.config?.dim);
                    if (!Number.isNaN(b) && !Number.isNaN(d)) {
                        sumB += b;
                        sumD += d;
                        n++;
                    }
                });
                let b = n > 0 ? sumB / n : DEFAULT_AMBIENT_BRIGHT;
                let d = n > 0 ? sumD / n : DEFAULT_AMBIENT_DIM;
                b = Math.max(STAGE_BRIGHT_SLIDER_MIN, Math.min(STAGE_BRIGHT_SLIDER_MAX, b));
                d = Math.max(STAGE_DIM_SLIDER_MIN, Math.min(STAGE_DIM_SLIDER_MAX, d));
                if (d < b) d = b;
                if (b > d) b = d;
                $html.find('#stage-master-bright-radius-slider').val(Math.round(b)).prop('disabled', false);
                $html.find('#stage-master-dim-radius-slider').val(Math.round(d)).prop('disabled', false);
                $html.find('#stage-master-bright-value').text(b.toFixed(1));
                $html.find('#stage-master-dim-value').text(d.toFixed(1));
            };
            const updateStageLightProperty = async (propertyKey, value) => {
                if (stageLightUUIDs.length === 0) return;
                let processedValue = value;
                if (propertyKey === 'config.animation.speed' || propertyKey === 'config.animation.intensity') {
                    processedValue = parseInt(value, 10);
                    if (isNaN(processedValue)) return;
                    processedValue = Math.max(ANIM_SLIDER_MIN, Math.min(ANIM_SLIDER_MAX, processedValue));
                } else if (propertyKey === 'config.attenuation') {
                    processedValue = parseFloat(value);
                    if (isNaN(processedValue)) return;
                    processedValue = Math.max(FOCUS_SLIDER_MIN, Math.min(FOCUS_SLIDER_MAX, processedValue));
                } else if (propertyKey === 'config.luminosity') {
                    processedValue = parseFloat(value);
                    if (isNaN(processedValue)) return;
                    processedValue = Math.max(LUMINOSITY_SLIDER_MIN, Math.min(LUMINOSITY_SLIDER_MAX, processedValue));
                } else if (propertyKey === 'config.saturation') {
                    processedValue = parseFloat(value);
                    if (isNaN(processedValue)) return;
                    processedValue = Math.max(COLOR_INTENSITY_SLIDER_MIN, Math.min(COLOR_INTENSITY_SLIDER_MAX, processedValue));
                }

                let updates;
                let alphaForLum = null;
                let foundrySaturation = null;
                let brightRadius = null;
                let dimRadius = null;

                if (propertyKey === 'config.luminosity') {
                    alphaForLum = processedValue <= OFF_LUMINOSITY ? 0 : Math.min(1, Math.max(0, processedValue));
                    updates = stageLightUUIDs.map((uuid) => ({
                        _id: uuid.split(".").pop(),
                        "config.luminosity": processedValue,
                        "config.alpha": alphaForLum,
                    }));
                } else if (propertyKey === 'config.saturation') {
                    foundrySaturation = processedValue * 2 - 1;
                    updates = stageLightUUIDs.map((uuid) => ({
                        _id: uuid.split(".").pop(),
                        "config.saturation": foundrySaturation,
                    }));
                } else if (propertyKey === 'config.bright' || propertyKey === 'config.dim') {
                    let b = parseFloat($html.find("#stage-master-bright-radius-slider").val());
                    let d = parseFloat($html.find("#stage-master-dim-radius-slider").val());
                    if (isNaN(b)) b = DEFAULT_AMBIENT_BRIGHT;
                    if (isNaN(d)) d = DEFAULT_AMBIENT_DIM;
                    if (propertyKey === "config.bright") {
                        b = parseFloat(value);
                        if (isNaN(b)) return;
                        b = Math.max(STAGE_BRIGHT_SLIDER_MIN, Math.min(STAGE_BRIGHT_SLIDER_MAX, b));
                        d = Math.max(d, b);
                        d = Math.min(STAGE_DIM_SLIDER_MAX, d);
                    } else {
                        d = parseFloat(value);
                        if (isNaN(d)) return;
                        d = Math.max(STAGE_DIM_SLIDER_MIN, Math.min(STAGE_DIM_SLIDER_MAX, d));
                        b = Math.min(b, d);
                        b = Math.max(STAGE_BRIGHT_SLIDER_MIN, b);
                    }
                    brightRadius = b;
                    dimRadius = d;
                    $html.find("#stage-master-bright-radius-slider").val(Math.round(b));
                    $html.find("#stage-master-dim-radius-slider").val(Math.round(d));
                    $html.find("#stage-master-bright-value").text(b.toFixed(1));
                    $html.find("#stage-master-dim-value").text(d.toFixed(1));
                    updates = stageLightUUIDs.map((uuid) => ({
                        _id: uuid.split(".").pop(),
                        "config.bright": b,
                        "config.dim": d,
                    }));
                } else {
                    processedValue = propertyKey === 'config.animation.speed' || propertyKey === 'config.animation.intensity'
                        ? processedValue
                        : parseFloat(value);
                    if (propertyKey !== 'config.animation.speed' && propertyKey !== 'config.animation.intensity') {
                        if (isNaN(processedValue)) return;
                    }
                    updates = stageLightUUIDs.map((uuid) => ({ _id: uuid.split(".").pop(), [propertyKey]: processedValue }));
                }

                if (!updates?.length) return;
                try {
                    await canvas.scene.updateEmbeddedDocuments("AmbientLight", updates, { noHook: true });
                    updates.forEach((update) => {
                        const fullUuid = `${currentScene.uuid}.AmbientLight.${update._id}`;
                        const lightDoc = lightDocMap.get(fullUuid);
                        if (lightDoc) {
                            if (propertyKey === "config.luminosity") {
                                lightDoc.updateSource(
                                    { config: { luminosity: processedValue, alpha: alphaForLum } },
                                    { diff: false, recursive: true }
                                );
                            } else if (propertyKey === "config.saturation") {
                                lightDoc.updateSource(
                                    { config: { saturation: foundrySaturation } },
                                    { diff: false, recursive: true }
                                );
                            } else if (propertyKey === "config.bright" || propertyKey === "config.dim") {
                                lightDoc.updateSource(
                                    { config: { bright: brightRadius, dim: dimRadius } },
                                    { diff: false, recursive: true }
                                );
                            } else {
                                const srcChanges = {};
                                foundry.utils.setProperty(srcChanges, propertyKey, processedValue);
                                lightDoc.updateSource(srcChanges, { diff: false, recursive: true });
                            }
                        }
                        const $listItem = $html.find(`.${LIGHT_ITEM_CLASS}[${DATA_LIGHT_UUID}="${fullUuid}"]`);
                        if ($listItem.length) {
                            let uiUpdateData = {};
                            if (propertyKey === "config.luminosity") {
                                uiUpdateData = { luminosity: processedValue };
                            } else if (propertyKey === "config.attenuation") {
                                uiUpdateData = { attenuation: processedValue };
                            } else if (propertyKey === "config.saturation") {
                                uiUpdateData = { saturation: foundrySaturation };
                            }
                            if (Object.keys(uiUpdateData).length > 0) {
                                updateLightElementUI($listItem.get(0), uiUpdateData);
                            }
                        }
                    });
                } catch (err) {
                    console.error(`Error updating stage light property ${propertyKey}:`, err);
                    ui.notifications.error(`Failed to update ${propertyKey}. See console.`);
                    if (propertyKey.includes('animation')) initializeAnimationSliders();
                    if (propertyKey.includes('attenuation')) initializeFocusSliders();
                    if (propertyKey.includes('luminosity')) initializeMasterBrightnessSlider();
                    if (propertyKey.includes('saturation')) initializeColorIntensitySlider();
                    if (propertyKey === "config.bright" || propertyKey === "config.dim") initializeStageBrightDimSliders();
                }
            };
            const detectOnStageTokens = () => {
                if (!stageBoundsDefined || !canvas?.tokens?.placeables) return []; return canvas.tokens.placeables.filter(token => token.document && (token.document.hasPlayerOwner || token.actor?.hasPlayerOwner || token.document.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) && !token.document.hidden && isPointInPolygon(token.center, STAGE_VERTICES) ).map(token => token.document);
            };
            const getTokenCenter = (tokenDoc) => {
                if (!tokenDoc || !canvas?.grid) return { x: 0, y: 0 }; const TILE_SIZE = canvas.grid.size; const x = tokenDoc.x + (tokenDoc.width * TILE_SIZE) / 2; const y = tokenDoc.y + (tokenDoc.height * TILE_SIZE) / 2; return { x, y };
            };
            const findSpotlightForToken = (tokenId) => {
                 if (!canvas?.scene?.lights) return null; return canvas.scene.lights.find(light => foundry.utils.getProperty(light, `flags.${SPOTLIGHT_FLAG_MODULE}.${SPOTLIGHT_FLAG_KEY}`) === tokenId );
             };
            const rebuildActiveSpotlightsMap = () => {
                activeSpotlights.clear(); if (!canvas?.scene?.lights) return; for (const light of canvas.scene.lights) { const flaggedTokenId = foundry.utils.getProperty(light, `flags.${SPOTLIGHT_FLAG_MODULE}.${SPOTLIGHT_FLAG_KEY}`); if (flaggedTokenId) { if (canvas.tokens.get(flaggedTokenId)) { activeSpotlights.set(flaggedTokenId, light.id); } else { console.warn(`Macro | Found spotlight light (${light.id}) for non-existent token (${flaggedTokenId}).`); } } } console.log("Macro | Rebuilt activeSpotlights map:", activeSpotlights);
             };
            const updateSpotlightList = async () => {
                 if (!$spotlightList.length || !stageBoundsDefined) return; const currentOnStageDocs = detectOnStageTokens(); const currentOnStageIds = new Set(currentOnStageDocs.map(doc => doc.id)); const lightsToDelete = []; for (const [tokenId, lightId] of activeSpotlights.entries()) { if (!currentOnStageIds.has(tokenId)) { const tokenExists = canvas.tokens.get(tokenId); if (!tokenExists) { console.log(`Macro | Token ${tokenId} deleted. Removing spotlight ${lightId}.`); } else { console.log(`Macro | Token ${tokenId} left stage. Removing spotlight ${lightId}.`); } lightsToDelete.push(lightId); activeSpotlights.delete(tokenId); } } if (lightsToDelete.length > 0) { try { await canvas.scene.deleteEmbeddedDocuments("AmbientLight", lightsToDelete); console.log(`Macro | Deleted ${lightsToDelete.length} spotlight(s).`); } catch (err) { console.error("Macro | Error cleaning up spotlight lights:", err); } } $spotlightList.empty(); if (currentOnStageDocs.length === 0) { $spotlightList.append('<li class="spotlight-empty"><em>No relevant tokens detected on stage.</em></li>'); } else { currentOnStageDocs.sort((a, b) => a.name.localeCompare(b.name)).forEach(tokenDoc => { const tokenId = tokenDoc.id; const tokenName = tokenDoc.name; const isChecked = activeSpotlights.has(tokenId); const listItemHtml = `<li> <span class="token-name" title="${tokenName} (ID: ${tokenId})">${tokenName}</span> <input type="checkbox" class="spotlight-checkbox" data-token-id="${tokenId}" ${isChecked ? 'checked' : ''} title="Toggle Spotlight for ${tokenName}"/> </li>`; $spotlightList.append(listItemHtml); }); }
            };
            const debouncedUpdateSpotlightList = () => {
                 clearTimeout(debounceTimer); debounceTimer = setTimeout(updateSpotlightList, SPOTLIGHT_REFRESH_DEBOUNCE_MS);
            };
            const handleTokenUpdate = async (tokenDoc, change, options, userId) => {
                if (!$html.closest('body').length) return; const tokenId = tokenDoc.id; const posChanged = change.hasOwnProperty('x') || change.hasOwnProperty('y'); const visibilityChanged = change.hasOwnProperty('hidden'); const dispositionChanged = change.hasOwnProperty('disposition'); let needsListRefresh = false; if (posChanged || visibilityChanged || dispositionChanged) { const isOnStageNow = stageBoundsDefined ? isPointInPolygon(getTokenCenter(tokenDoc), STAGE_VERTICES) : false; const isHiddenNow = tokenDoc.hidden; const isRelevantNow = (tokenDoc.hasPlayerOwner || tokenDoc.actor?.hasPlayerOwner || tokenDoc.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY); const isCurrentlyInList = $spotlightList.find(`.spotlight-checkbox[data-token-id="${tokenId}"]`).length > 0; const shouldBeInList = isOnStageNow && !isHiddenNow && isRelevantNow; if (isCurrentlyInList !== shouldBeInList) { needsListRefresh = true; } } if (needsListRefresh) { console.log(`Macro | Triggering debounced list refresh due to update on token ${tokenId}.`); debouncedUpdateSpotlightList(); }
            };
            const handleTokenDelete = (tokenDoc, options, userId) => {
                if (!$html.closest('body').length) return; const tokenId = tokenDoc.id; if (activeSpotlights.has(tokenId)) { console.log(`Macro | Token ${tokenId} deleted, removing spotlight.`); const lightId = activeSpotlights.get(tokenId); activeSpotlights.delete(tokenId); canvas.scene.deleteEmbeddedDocuments("AmbientLight", [lightId]).catch(err => console.error(`Macro | Error deleting spotlight for deleted token ${tokenId}:`, err)); debouncedUpdateSpotlightList(); } else { const center = getTokenCenter(tokenDoc); const wasRelevant = (tokenDoc.hasPlayerOwner || tokenDoc.actor?.hasPlayerOwner || tokenDoc.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY); const wasVisible = !tokenDoc.hidden; if (stageBoundsDefined && isPointInPolygon(center, STAGE_VERTICES) && wasVisible && wasRelevant) { debouncedUpdateSpotlightList(); } }
             };
            const handleTokenRefresh = (tokenPlaceable, flags) => {
                 if (!$html.closest('body').length) return; const tokenId = tokenPlaceable.document?.id; if (!tokenId || !activeSpotlights.has(tokenId)) return; if (tokenRefreshDebounceMap.has(tokenId)) { clearTimeout(tokenRefreshDebounceMap.get(tokenId)); } const timeoutId = setTimeout(async () => { if (!$html.closest('body').length) return; const lightId = activeSpotlights.get(tokenId); const currentTokenPlaceable = canvas.tokens.get(tokenId); const light = canvas.scene?.lights?.get(lightId); if (currentTokenPlaceable && light) { const newCenter = currentTokenPlaceable.center; if (Math.abs(light.x - newCenter.x) >= 1 || Math.abs(light.y - newCenter.y) >= 1) { try { await canvas.scene.updateEmbeddedDocuments("AmbientLight", [{ _id: lightId, x: newCenter.x, y: newCenter.y }], { diff: false, recursive: false, noHook: true }); const lightDoc = lightDocMap.get(light.uuid); if (lightDoc) { lightDoc.updateSource({ x: newCenter.x, y: newCenter.y }, { diff: false }); } } catch (err) { console.error(`Macro | Debounced Refresh: Error updating spotlight pos for ${tokenId}:`, err); } } } else if (!light) { console.warn(`Macro | Debounced Refresh: Light ${lightId} for token ${tokenId} not found.`); activeSpotlights.delete(tokenId); debouncedUpdateSpotlightList(); } else if (!currentTokenPlaceable) { console.warn(`Macro | Debounced Refresh: Token ${tokenId} not found.`); } tokenRefreshDebounceMap.delete(tokenId); }, SPOTLIGHT_MOVE_DEBOUNCE_MS); tokenRefreshDebounceMap.set(tokenId, timeoutId);
            };
            const handleTokenCreate = (tokenDoc, options, userId) => {
                if (!$html.closest('body').length) return; const center = getTokenCenter(tokenDoc); const isRelevant = (tokenDoc.hasPlayerOwner || tokenDoc.actor?.hasPlayerOwner || tokenDoc.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY); if (stageBoundsDefined && isPointInPolygon(center, STAGE_VERTICES) && !tokenDoc.hidden && isRelevant) { console.log(`Macro | Token ${tokenDoc.id} created on stage and relevant. Refreshing list.`); debouncedUpdateSpotlightList(); }
             };

            // --- Initial Setup ---
            if (COLLAPSE_DELAY_MS > 0) { setTimeout(() => { if ($html.closest('body').length) { $html.find('.light-group-parent').addClass('collapsed'); $html.find('.light-group-parent').each(function() { checkGroupSelectState($(this)); }); } }, COLLAPSE_DELAY_MS); } else { $html.find('.light-group-parent').addClass('collapsed'); $html.find('.light-group-parent').each(function() { checkGroupSelectState($(this)); }); }
            initializeAnimationSliders();
            initializeFocusSliders();
            initializeMasterBrightnessSlider();
            initializeColorIntensitySlider();
            initializeStageBrightDimSliders();
            if (stageBoundsDefined && canControlSpotlights) { rebuildActiveSpotlightsMap(); updateSpotlightList(); console.log("Macro | Registering spotlight hooks."); spotlightHookIds.push(Hooks.on("updateToken", handleTokenUpdate)); spotlightHookIds.push(Hooks.on("deleteToken", handleTokenDelete)); spotlightHookIds.push(Hooks.on("createToken", handleTokenCreate)); spotlightHookIds.push(Hooks.on("refreshToken", handleTokenRefresh)); } else { console.log("Macro | Skipping spotlight init/hooks."); $spotlightList.html('<li class="spotlight-empty"><em>Spotlight control disabled.</em></li>'); }

            // --- Event Listeners ---

            

            // Group Header/Toggle/Checkbox listeners
            $html.on('click', '.group-header', function(event) { if ($(event.target).is('input, button, .action-button, i') || $(event.target).closest('.action-button, .group-selector, .group-toggle-vis, .individual-focus-control, .individual-position-controls').length > 0) { return; } event.stopPropagation(); const $groupParent = $(this).closest('.light-group-parent'); if ($groupParent.find('.light-group-children li:not(.empty-group-message)').length > 0) { $groupParent.toggleClass('collapsed'); } });
            $html.on('click', '.toggle-group-visibility-button', function(event) { event.stopPropagation(); $(this).closest('.light-group-parent').toggleClass('collapsed'); });
            $html.on('change', '.group-select-checkbox', function(event) { const $groupParent = $(this).closest('.light-group-parent'); const isChecked = $(this).prop('checked'); $(this).prop('indeterminate', false); $groupParent.find('.light-select-checkbox').prop('checked', isChecked); });
            $html.on('change', '.light-select-checkbox', function(event) { const $groupParent = $(this).closest('.light-group-parent'); checkGroupSelectState($groupParent); });

            // Stage Lights OFF/ON
            $html.on('click', '#stage-lights-off-button', async function() {
                const $stageElements = getStageLightElements(); if ($stageElements.length === 0) return; const transitions = []; const elementsToUpdate = []; $stageElements.each((i, el) => { const lightUuid = $(el).data(DATA_LIGHT_UUID.replace('data-', '')); const lightDoc = lightDocMap.get(lightUuid); if (!lightUuid || !lightDoc?.config) return; const currentLuminosity = lightDoc.config.luminosity ?? 0.0; if (currentLuminosity <= OFF_LUMINOSITY) return; const currentColor = normalizeColorToString(lightDoc.config.color); const startState = { color: currentColor ?? OFF_COLOR, luminosity: currentLuminosity }; const endState = { color: OFF_COLOR, luminosity: OFF_LUMINOSITY }; transitions.push({ uuid: lightUuid, startState, endState }); elementsToUpdate.push({ element: el, data: endState }); }); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Turned OFF Stage Lights", "Stage OFF"); } else { ui.notifications.info("Stage Lights were already off."); }
            });
            $html.on('click', '#stage-lights-on-white-button', async function() {
                const $stageElements = getStageLightElements(); if ($stageElements.length === 0) return; const targetColor = DEFAULT_ON_COLOR; const targetLuminosity = TARGET_ON_LUMINOSITY; const { transitions, elementsToUpdate } = getColorLuminosityTransitions($stageElements, targetColor, targetLuminosity); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Turned ON Stage Lights to White", "Stage ON White"); } else { ui.notifications.info(`Stage Lights already ON White.`); }
            });

            // --- House Light Buttons (UUID list only) ---
            $html.on('click', '#house-lights-off-button', async function() {
                if (!houseControlsEnabled) return;
                console.log("House Lights OFF | house UUID list");
                const transitions = []; const elementsToUpdate = [];
                for (const [uuid, lightDoc] of lightDocMap.entries()) {
                    if (!lightDoc?.config) continue;
                    const isSpotlight = foundry.utils.getProperty(lightDoc, `flags.${SPOTLIGHT_FLAG_MODULE}.${SPOTLIGHT_FLAG_KEY}`);
                    if (isSpotlight) continue;
                    const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
                    if (houseLightUuidAllowSet.has(uuid) && currentLuminosity > OFF_LUMINOSITY) {
                        const startState = { luminosity: currentLuminosity };
                        const endState = { luminosity: OFF_LUMINOSITY };
                        transitions.push({ uuid: uuid, startState, endState, luminosityOnly: true });
                        const $element = $html.find(`.${LIGHT_ITEM_CLASS}[${DATA_LIGHT_UUID}="${uuid}"]`);
                        if ($element.length > 0) { elementsToUpdate.push({ element: $element.get(0), data: { luminosity: OFF_LUMINOSITY } }); }
                    }
                }
                if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Turned OFF house UUID lights", "House OFF"); }
                else { ui.notifications.info("No house UUID lights were on."); }
            });
            $html.on('click', '#house-lights-on-button', async function() {
                if (!houseControlsEnabled) return;
                console.log("House Lights ON | house UUID list");
                const transitions = []; const elementsToUpdate = []; const targetLuminosity = TARGET_ON_LUMINOSITY;
                for (const [uuid, lightDoc] of lightDocMap.entries()) {
                     if (!lightDoc?.config) continue;
                     const isSpotlight = foundry.utils.getProperty(lightDoc, `flags.${SPOTLIGHT_FLAG_MODULE}.${SPOTLIGHT_FLAG_KEY}`);
                     if (isSpotlight) continue;
                    const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
                    if (houseLightUuidAllowSet.has(uuid) && Math.abs(currentLuminosity - targetLuminosity) > 0.01) {
                        const startState = { luminosity: currentLuminosity };
                        const endState = { luminosity: targetLuminosity };
                        transitions.push({ uuid: uuid, startState, endState, luminosityOnly: true });
                        const $element = $html.find(`.${LIGHT_ITEM_CLASS}[${DATA_LIGHT_UUID}="${uuid}"]`);
                        if ($element.length > 0) { elementsToUpdate.push({ element: $element.get(0), data: { luminosity: targetLuminosity } }); }
                    }
                }
                if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Turned ON house UUID lights", "House ON"); }
                else { ui.notifications.info("House UUID lights already at target brightness."); }
            });

            // Quick Controls Listeners (Color, Anim, Env, Sliders)
            $html.on('click', '.color-luminosity-swatch-button', async function(event) {
                const $button = $(this); const targetColor = $button.data('color'); const targetLuminosity = parseFloat($button.data('luminosity')); if (targetColor === undefined || isNaN(targetLuminosity)) return; const $stageLightElements = getStageLightElements(); if ($stageLightElements.length === 0) return; const { transitions, elementsToUpdate } = getColorLuminosityTransitions($stageLightElements, targetColor, targetLuminosity); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, `Set Stage Lights to ${targetColor}, Lum: ${targetLuminosity.toFixed(2)}`, "Stage Quick Set"); } else { ui.notifications.info(`Stage Lights already at ${targetColor}, Lum: ${targetLuminosity.toFixed(2)}.`); }
            });
            $html.on('click', '.animation-type-button', async function(event) {
                const $button = $(this); const animTypeKey = $button.data('animation-type'); const animTypeLabel = $button.text(); if (stageLightUUIDs.length === 0) return; const currentSpeed = $html.find('#stage-anim-speed-slider').val(); const currentIntensity = $html.find('#stage-anim-intensity-slider').val(); const updates = stageLightUUIDs.map(uuid => { const lightDoc = lightDocMap.get(uuid); return { _id: uuid.split('.').pop(), "config.animation.type": animTypeKey === "none" ? null : animTypeKey, "config.animation.speed": parseInt(currentSpeed) || DEFAULT_ANIMATION_SPEED, "config.animation.intensity": parseInt(currentIntensity) || DEFAULT_ANIMATION_INTENSITY, "config.animation.reverse": lightDoc?.config?.animation?.reverse ?? false }; }); try { await canvas.scene.updateEmbeddedDocuments("AmbientLight", updates); updates.forEach(update => { const fullUuid = `${currentScene.uuid}.AmbientLight.${update._id}`; const lightDoc = lightDocMap.get(fullUuid); if (lightDoc) { lightDoc.updateSource({ config: { animation: { type: update["config.animation.type"], speed: update["config.animation.speed"], intensity: update["config.animation.intensity"], reverse: update["config.animation.reverse"] } } }, { diff: false }); } }); ui.notifications.info(`Set ${stageLightUUIDs.length} Stage Lights animation to: ${animTypeLabel}`); } catch (err) { console.error("Error bulk updating light animation types:", err); ui.notifications.error(`Error setting animation type. See console (F12).`); }
            });
            $html.on('input', '#stage-anim-speed-slider', async function() {
                 const speedValue = $(this).val(); $html.find('#stage-anim-speed-value').text(speedValue); await updateStageLightProperty('config.animation.speed', speedValue);
            });
            $html.on('input', '#stage-anim-intensity-slider', async function() {
                 const intensityValue = $(this).val(); $html.find('#stage-anim-intensity-value').text(intensityValue); await updateStageLightProperty('config.animation.intensity', intensityValue);
             });
            $html.on('input', '#stage-focus-slider', async function() {
                const focusValue = $(this).val(); $html.find('#stage-focus-value').text(parseFloat(focusValue).toFixed(2)); await updateStageLightProperty('config.attenuation', focusValue);
            });
            $html.on('input', '#stage-master-brightness-slider', async function() {
                const brightnessValue = $(this).val(); $html.find('#stage-master-brightness-value').text(parseFloat(brightnessValue).toFixed(2)); await updateStageLightProperty('config.luminosity', brightnessValue);
            });
            $html.on('input', '#stage-color-intensity-slider', async function() {
                const intensityValue = $(this).val();
                $html.find('#stage-color-intensity-value').text(parseFloat(intensityValue).toFixed(2));
                await updateStageLightProperty('config.saturation', intensityValue);
            });
            $html.on('input', '#stage-master-bright-radius-slider', async function() {
                const v = $(this).val();
                $html.find('#stage-master-bright-value').text(parseFloat(v).toFixed(1));
                await updateStageLightProperty('config.bright', v);
            });
            $html.on('input', '#stage-master-dim-radius-slider', async function() {
                const v = $(this).val();
                $html.find('#stage-master-dim-value').text(parseFloat(v).toFixed(1));
                await updateStageLightProperty('config.dim', v);
            });
            $html.on('click', '.environment-type-button', async function(event) {
                 const $button = $(this); const envName = $button.text().trim(); let availableColors = []; try { const colorsData = $button.data('colors'); if (colorsData && Array.isArray(colorsData)) { availableColors = colorsData; } else if (typeof colorsData === 'string' && colorsData.length > 2) { try { availableColors = JSON.parse(colorsData.replace(/\\'/g, "'")); } catch (jsonError) { console.error(`JSON Parse Error for '${envName}':`, jsonError); throw new Error("Invalid JSON"); } } else { throw new Error("Invalid data"); } } catch (e) { console.error(`Environment | Error parsing color data for '${envName}':`, e); ui.notifications.error(`Error reading colors for environment '${envName}'.`); return; } availableColors = availableColors.map(c => normalizeColorToString(c) ?? DEFAULT_ON_COLOR); if (availableColors.length === 0) return; const $stageLightElements = getStageLightElements(); if ($stageLightElements.length === 0) return; const transitions = []; const elementsToUpdate = []; const targetLuminosity = TARGET_ON_LUMINOSITY; $stageLightElements.each((i, el) => { const $el = $(el); const lightUuid = $el.data(DATA_LIGHT_UUID.replace('data-', '')); const lightDoc = lightDocMap.get(lightUuid); if (!lightUuid || !lightDoc?.config) return; const randomIndex = Math.floor(Math.random() * availableColors.length); const targetColor = availableColors[randomIndex]; const currentLuminosity = lightDoc.config.luminosity ?? 0.0; const currentColor = normalizeColorToString(lightDoc.config.color); const startState = { color: currentColor ?? OFF_COLOR, luminosity: currentLuminosity }; const endState = { color: targetColor, luminosity: targetLuminosity }; transitions.push({ uuid: lightUuid, startState, endState }); elementsToUpdate.push({ element: el, data: endState }); }); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, `Applied '${envName}' environment to Stage Lights`, `Environment ${envName}`); }
            });

            // Individual Light Action Listeners
            $html.on('click', '.toggle-single-button', async function() {
                 const $listItem = $(this).closest('.' + LIGHT_ITEM_CLASS); if (!$listItem.length) return; const transitionData = getToggleTransitionData($listItem.get(0)); if (transitionData) { await applyBulkLightUpdates([transitionData], [{ element: $listItem.get(0), data: transitionData.uiUpdateData }], null, "Toggle Light"); } else { ui.notifications.warn("Toggle failed: Could not get transition data."); }
            });
            $html.on('click', '.reset-single-button', async function() {
                const $listItem = $(this).closest('.' + LIGHT_ITEM_CLASS); if (!$listItem.length) return; const { transitions, elementsToUpdate } = getResetTransitions($listItem); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Reset light", "Reset Light"); } else { ui.notifications.info("Light is already in its initial state."); }
            });
            $html.on('click', '.set-single-color-button', async function() {
                 const $listItem = $(this).closest('.' + LIGHT_ITEM_CLASS); if (!$listItem.length) return; const $colorInput = $listItem.find('.light-current-color-input'); if (!$colorInput.length) return; const newColor = normalizeColorToString($colorInput.val()); if (!newColor) return; const lightDoc = lightDocMap.get($listItem.data(DATA_LIGHT_UUID.replace('data-', ''))); if (lightDoc && (lightDoc.config.luminosity ?? 0.0) <= OFF_LUMINOSITY) { ui.notifications.warn(`Cannot set color: Light is currently off.`); } const { transitions, elementsToUpdate } = getColorTransitions($listItem, newColor); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, "Set color for light", "Set Light Color"); } else { if (lightDoc && (lightDoc.config.luminosity ?? 0.0) > OFF_LUMINOSITY) { ui.notifications.info("Light color already matches."); } }
            });
            $html.on('click', '.copy-uuid-button', function() {
                 const uuid = $(this).closest('.' + LIGHT_ITEM_CLASS)?.data(DATA_LIGHT_UUID.replace('data-', '')); if (uuid) { navigator.clipboard.writeText(uuid).then(() => ui.notifications.info(`Copied UUID: ${uuid}`)).catch(err => { console.error('Failed to copy UUID:', err); ui.notifications.error('Failed to copy UUID.'); }); }
            });
            $html.on('input', '.individual-focus-slider', async function() {
                const $slider = $(this); const $listItem = $slider.closest('.' + LIGHT_ITEM_CLASS); const $valueSpan = $listItem.find('.individual-focus-value'); const lightUuid = $listItem.data(DATA_LIGHT_UUID.replace('data-', '')); const focusValue = parseFloat($slider.val()); if (!lightUuid || isNaN(focusValue)) { return; } $valueSpan.text(focusValue.toFixed(2)); const update = { _id: lightUuid.split('.').pop(), "config.attenuation": focusValue }; try { await canvas.scene.updateEmbeddedDocuments("AmbientLight", [update], { diff: false, recursive: false, noHook: true }); const lightDoc = lightDocMap.get(lightUuid); if (lightDoc) { lightDoc.updateSource({ config: { attenuation: focusValue } }, { diff: false }); } } catch (err) { console.error(`Error updating individual focus (${lightUuid}):`, err); ui.notifications.error(`Failed to update focus. See console.`); const lightDoc = lightDocMap.get(lightUuid); if (lightDoc) { const currentAttenuation = lightDoc.config?.attenuation ?? DEFAULT_FOCUS_VALUE; $slider.val(currentAttenuation); $valueSpan.text(currentAttenuation.toFixed(2)); } }
            });
            $html.on('input', '.individual-pos-slider', async function() {
                 const $slider = $(this); const $listItem = $slider.closest('.' + LIGHT_ITEM_CLASS); const axis = $slider.data('axis'); const $valueSpan = $listItem.find(`.individual-${axis}-value`); const lightUuid = $listItem.data(DATA_LIGHT_UUID.replace('data-', '')); const posValue = parseInt($slider.val(), 10); if (!lightUuid || !axis || isNaN(posValue)) { return; } $valueSpan.text(posValue); const update = { _id: lightUuid.split('.').pop(), [axis]: posValue }; try { await canvas.scene.updateEmbeddedDocuments("AmbientLight", [update], { diff: false, recursive: false, noHook: true }); const lightDoc = lightDocMap.get(lightUuid); if (lightDoc) { lightDoc.updateSource({ [axis]: posValue }, { diff: false }); } } catch (err) { console.error(`Error updating individual position (${lightUuid}, ${axis}):`, err); ui.notifications.error(`Failed to update position. See console.`); const lightDoc = lightDocMap.get(lightUuid); if (lightDoc) { const originalPos = Math.round(lightDoc[axis]); $slider.val(originalPos); $valueSpan.text(originalPos); } }
            });

            // Group Action Listeners (Toggle/Reset work on the initially listed lights in that group)
            $html.on('click', '.group-toggle-button', async function() {
                const $groupParent = $(this).closest('.light-group-parent'); const groupType = $groupParent.data('group-type'); const $lightsInGroup = $groupParent.find('.' + LIGHT_ITEM_CLASS); if ($lightsInGroup.length === 0) return; const transitions = []; const elementsToUpdate = []; $lightsInGroup.each((i, el) => { const transitionData = getToggleTransitionData(el); if (transitionData) { transitions.push(transitionData); elementsToUpdate.push({ element: el, data: transitionData.uiUpdateData }); } }); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, `Toggled ${groupType} group lights`, `Toggle Group ${groupType}`); } else { ui.notifications.info(`All lights in the ${groupType} group were already in a non-toggleable state.`); }
            });
            $html.on('click', '.group-reset-button', async function() {
                const $groupParent = $(this).closest('.light-group-parent'); const groupType = $groupParent.data('group-type'); const $lightsInGroup = $groupParent.find('.' + LIGHT_ITEM_CLASS); if ($lightsInGroup.length === 0) return; const { transitions, elementsToUpdate } = getResetTransitions($lightsInGroup); if (transitions.length > 0) { await applyBulkLightUpdates(transitions, elementsToUpdate, `Reset ${groupType} group lights`, `Reset Group ${groupType}`); } else { ui.notifications.info(`All lights in the ${groupType} group were already in their initial state.`); }
            });

            // START NEW EXPORT MACRO LISTENER
            $html.on('click', '#export-macro-button', async function() {
                if (stageLightUUIDs.length === 0) {
                    ui.notifications.warn("No Stage lights defined to export.");
                    return;
                }

                // 1. Get current Fade Duration
                const $durationInput = $html.find('#fade-time');
                let fadeDuration = parseInt($durationInput.val(), 10);
                if (isNaN(fadeDuration) || fadeDuration < 0) {
                    fadeDuration = 0; // Default to instant if invalid
                }

                // 2. Capture Current State of Stage Lights
                const capturedStates = {};
                let successfulCaptures = 0;
                for (const uuid of stageLightUUIDs) {
                    const lightDoc = lightDocMap.get(uuid);
                    if (!lightDoc?.config) {
                        console.warn(`Export Macro | Skipping light ${uuid}: Document or config not found.`);
                        continue;
                    }
                    // Ensure color is normalized, provide defaults if null/undefined
                    const color = normalizeColorToString(lightDoc.config.color) ?? DEFAULT_ON_COLOR;
                    const luminosity = lightDoc.config.luminosity ?? OFF_LUMINOSITY;
                    const isEffectivelyOn = luminosity > OFF_LUMINOSITY;

                    capturedStates[uuid] = {
                        id: lightDoc.id, // Store ID for easier updates later
                        // --- Animated Properties ---
                        color: isEffectivelyOn ? color : OFF_COLOR, // Use OFF_COLOR if lumi is 0
                        luminosity: luminosity,
                        // --- Instant Properties (Set at end of animation) ---
                        attenuation: lightDoc.config.attenuation ?? DEFAULT_FOCUS_VALUE,
                        saturation: lightDoc.config.saturation ?? DEFAULT_COLOR_INTENSITY_VALUE,
                        animation: {
                            type: lightDoc.config.animation?.type ?? null,
                            speed: lightDoc.config.animation?.speed ?? DEFAULT_ANIMATION_SPEED,
                            intensity: lightDoc.config.animation?.intensity ?? DEFAULT_ANIMATION_INTENSITY,
                            reverse: lightDoc.config.animation?.reverse ?? false,
                        },
                        x: lightDoc.x,
                        y: lightDoc.y,
                        // Add other properties if needed (angle, contrast, shadows, darkness, etc.)
                    };
                    successfulCaptures++;
                }

                if (successfulCaptures === 0) {
                    ui.notifications.error("Failed to capture state for any Stage lights.");
                    return;
                }

                // 3. Generate the Macro Code String
                const timestamp = new Date().toLocaleString();
                const macroName = `Stage Scene - ${timestamp}`;
                // --- Corrected Template Literal Start ---
                const generatedMacroCode = `/*
Generated Stage Scene Macro
Scene: ${canvas.scene.name} (${canvas.scene.id})
Generated On: ${timestamp}
Fade Duration: ${fadeDuration}ms
Lights Captured: ${successfulCaptures}
*/

(async () => {
    // --- Configuration (Captured from Controller) ---
    const TARGET_STATES = ${JSON.stringify(capturedStates, null, 2)};
    const FADE_DURATION_MS = ${fadeDuration};
    const ANIMATION_STEPS = ${ANIMATION_STEPS}; // Use the same value as the controller for consistency
    const OFF_LUMINOSITY = ${OFF_LUMINOSITY};
    const OFF_COLOR = "${OFF_COLOR}";
    const DEFAULT_ON_COLOR_RGB = [${DEFAULT_ON_COLOR_RGB.join(', ')}]; // Inject RGB array
    const OFF_COLOR_RGB = [${OFF_COLOR_RGB.join(', ')}]; // Inject RGB array

    // --- Helper Functions (Copied from Controller) ---
    function lerp(start, end, t) { return start * (1 - t) + end * t; }
    function hexToRgb(hex) { if (!hex || typeof hex !== 'string') return null; const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex); return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : null; }
    function rgbToHex(r, g, b) { r = Math.max(0, Math.min(255, Math.round(r))); g = Math.max(0, Math.min(255, Math.round(g))); b = Math.max(0, Math.min(255, Math.round(b))); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toLowerCase(); }
    function interpolateRgb(rgb1, rgb2, t) { const startRgb = Array.isArray(rgb1) && rgb1.length === 3 ? rgb1 : DEFAULT_ON_COLOR_RGB; const endRgb = Array.isArray(rgb2) && rgb2.length === 3 ? rgb2 : DEFAULT_ON_COLOR_RGB; const r = lerp(startRgb[0], endRgb[0], t); const g = lerp(startRgb[1], endRgb[1], t); const b = lerp(startRgb[2], endRgb[2], t); return [r, g, b]; }
    function normalizeColorToString(color) { if (color === null || color === undefined) return null; if (typeof color === 'string' && /^#?([a-f\\d]{3}){1,2}$/i.test(color)) { let hex = color.startsWith('#') ? color : '#' + color; if (hex.length === 4) { hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]; } return hex.toLowerCase(); } return null; } // Simplified slightly for export
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // --- Main Logic ---
    if (!canvas?.scene) { ui.notifications.warn("Exported Macro: No active scene."); return; }
    if (!game.user.isGM) { ui.notifications.warn("Exported Macro: Requires GM privileges."); return; }

    const lightUUIDsToUpdate = Object.keys(TARGET_STATES);
    if (lightUUIDsToUpdate.length === 0) { console.log("Exported Macro: No target lights defined."); return; }

    const transitions = [];
    const finalInstantUpdates = [];

    for (const uuid of lightUUIDsToUpdate) {
        const lightDoc = canvas.scene.lights.get(TARGET_STATES[uuid]?.id); // Find by ID
        const targetState = TARGET_STATES[uuid];

        if (!lightDoc || !targetState) {
            console.warn(\`Exported Macro: Skipping light \${uuid} (ID: \${TARGET_STATES[uuid]?.id}) - Not found in current scene or target state missing.\`);
            continue;
        }

        const currentLuminosity = lightDoc.config.luminosity ?? 0.0;
        const currentColorStr = normalizeColorToString(lightDoc.config.color) ?? (currentLuminosity > OFF_LUMINOSITY ? rgbToHex(DEFAULT_ON_COLOR_RGB[0], DEFAULT_ON_COLOR_RGB[1], DEFAULT_ON_COLOR_RGB[2]) : OFF_COLOR);
        const targetColorStr = targetState.color ?? OFF_COLOR;
        const targetLuminosity = targetState.luminosity ?? OFF_LUMINOSITY;

        const startRgbVal = hexToRgb(currentColorStr) ?? (currentLuminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);
        const endRgbVal = hexToRgb(targetColorStr) ?? (targetLuminosity > OFF_LUMINOSITY ? DEFAULT_ON_COLOR_RGB : OFF_COLOR_RGB);

        transitions.push({
            id: lightDoc.id,
            startLuminosity: currentLuminosity,
            endLuminosity: targetLuminosity,
            startRgb: startRgbVal,
            endRgb: endRgbVal,
        });

        // Prepare the final state update (including instant properties)
        finalInstantUpdates.push({
             _id: lightDoc.id,
            "config.color": targetColorStr,
            "config.luminosity": targetLuminosity,
            "config.attenuation": targetState.attenuation,
            "config.saturation": targetState.saturation,
            "config.animation.type": targetState.animation.type,
            "config.animation.speed": targetState.animation.speed,
            "config.animation.intensity": targetState.animation.intensity,
            "config.animation.reverse": targetState.animation.reverse,
            "x": targetState.x,
            "y": targetState.y
            // Add other instant properties here if captured
        });
    }

    if (transitions.length === 0) {
        console.log("Exported Macro: No valid lights found to transition.");
        return;
    }

    console.log(\`Exported Macro: Starting transition for \${transitions.length} lights over \${FADE_DURATION_MS}ms.\`);

    // --- Animation Loop ---
    if (FADE_DURATION_MS <= 0 || ANIMATION_STEPS <= 0) {
        // Instant update
        console.log("Exported Macro: Applying instant update.");
        try {
            await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalInstantUpdates);
            ui.notifications.info(\`Scene set instantly (\${finalInstantUpdates.length} lights).\`);
        } catch (err) {
            console.error("Exported Macro: Error applying instant update:", err);
            ui.notifications.error("Error setting scene instantly. See console (F12).");
        }
    } else {
        // Animated transition
        const stepDuration = FADE_DURATION_MS / ANIMATION_STEPS;
        try {
            for (let i = 1; i <= ANIMATION_STEPS; i++) {
                const t = i / ANIMATION_STEPS;
                const stepUpdates = [];

                for (const transition of transitions) {
                    const currentLuminosity = lerp(transition.startLuminosity, transition.endLuminosity, t);
                    const currentRgb = interpolateRgb(transition.startRgb, transition.endRgb, t);
                    const currentHex = rgbToHex(currentRgb[0], currentRgb[1], currentRgb[2]);

                    stepUpdates.push({
                        _id: transition.id,
                        "config.color": currentHex,
                        "config.luminosity": currentLuminosity
                    });
                }

                if (stepUpdates.length > 0) {
                   await canvas.scene.updateEmbeddedDocuments("AmbientLight", stepUpdates, { diff: false, recursive: false, noHook: true });
                }

                if (i < ANIMATION_STEPS) {
                    await sleep(stepDuration);
                }
            }

            // Apply final state with all properties after animation
            console.log("Exported Macro: Animation complete, applying final state with all properties.");
            await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalInstantUpdates);
            ui.notifications.info(\`Scene transition complete (\${finalInstantUpdates.length} lights).\`);

        } catch (err) {
            console.error("Exported Macro: Error during animation:", err);
            ui.notifications.error("Error during scene transition. See console (F12). Trying final update.");
            // Attempt to set final state even if animation failed
            try {
                 await canvas.scene.updateEmbeddedDocuments("AmbientLight", finalInstantUpdates);
            } catch (finalErr) {
                 console.error("Exported Macro: Error applying final state after animation error:", finalErr);
            }
        }
    }
})();
`;
                // --- Corrected Template Literal End ---

                // 4. Display the generated macro in a new Dialog
                const dialogId = `export-macro-dialog-${Date.now()}`;
                new Dialog({
                    title: "Generated Stage Scene Macro",
                    content: `
                        <p>Copy the macro script below and paste it into a new Script Macro in Foundry VTT.</p>
                        <p><strong>Macro Name Suggestion:</strong> ${macroName}</p>
                        <textarea id="${dialogId}-textarea" style="width: 98%; height: 400px; font-family: monospace; font-size: 12px; white-space: pre; background: #f0f0f0; border: 1px solid #ccc; resize: vertical;" readonly>${generatedMacroCode}</textarea>
                        <p><small>This macro will transition ${successfulCaptures} stage light(s) from their state *at the time the macro is run* to the captured state over ${fadeDuration}ms.</small></p>
                    `,
                    buttons: {
                        copy: {
                            icon: '<i class="fas fa-copy"></i>',
                            label: "Copy to Clipboard",
                            callback: (html) => {
                                const textarea = html.find(`#${dialogId}-textarea`)[0];
                                if (textarea) {
                                    textarea.select();
                                    document.execCommand('copy');
                                    ui.notifications.info("Macro code copied to clipboard!");
                                } else {
                                    ui.notifications.error("Could not find text area to copy from.");
                                }
                            }
                        },
                        close: {
                            icon: '<i class="fas fa-times"></i>',
                            label: "Close"
                        }
                    },
                    default: "close"
                }, {
                    width: 650,
                    height: "auto",
                    resizable: true,
                    id: dialogId
                }).render(true);

                ui.notifications.info(`Generated macro code for ${successfulCaptures} stage lights.`);

            });
            // END NEW EXPORT MACRO LISTENER

            // Spotlight Checkbox Listener
            if (canControlSpotlights) { $html.on('change', '.spotlight-checkbox', async function() {
                const $checkbox = $(this); const tokenId = $checkbox.data('token-id'); const isChecked = $checkbox.prop('checked'); const tokenDoc = canvas.tokens.get(tokenId)?.document; if (!tokenId || !tokenDoc) { console.error("Spotlight toggle failed: Token not found", tokenId); $checkbox.prop('checked', !isChecked); ui.notifications.error("Failed toggle: Token not found."); await updateSpotlightList(); return; } if (isChecked) { if (activeSpotlights.has(tokenId)) { console.warn(`Spotlight already exists for ${tokenId}.`); return; } const center = getTokenCenter(tokenDoc); const lightData = { x: center.x, y: center.y, rotation: 0, config: { dim: SPOTLIGHT_DIM_RADIUS, bright: SPOTLIGHT_BRIGHT_RADIUS, color: SPOTLIGHT_COLOR, alpha: SPOTLIGHT_ALPHA, angle: 360, coloration: SPOTLIGHT_COLORATION_TECHNIQUE, luminosity: SPOTLIGHT_LUMINOSITY, saturation: DEFAULT_COLOR_INTENSITY_VALUE, contrast: 0, shadows: 0, animation: { type: SPOTLIGHT_ANIMATION_TYPE, speed: 5, intensity: 5, reverse: false }, darkness: { min: 0, max: 1 }, attenuation: SPOTLIGHT_ATTENUATION, }, flags: { [SPOTLIGHT_FLAG_MODULE]: { [SPOTLIGHT_FLAG_KEY]: tokenId } } }; try { console.log(`Creating spotlight for ${tokenId}`); const createdLights = await canvas.scene.createEmbeddedDocuments("AmbientLight", [lightData]); if (createdLights && createdLights.length > 0) { const newLight = createdLights[0]; activeSpotlights.set(tokenId, newLight.id); lightDocMap.set(newLight.uuid, newLight); console.log(`Spotlight ${newLight.id} created.`); } else { throw new Error("Light creation failed silently."); } } catch (err) { console.error(`Error creating spotlight for ${tokenId}:`, err); ui.notifications.error(`Failed to create spotlight. See console.`); $checkbox.prop('checked', false); activeSpotlights.delete(tokenId); } } else { let lightId = activeSpotlights.get(tokenId); let lightUUID = null; if (!lightId) { console.warn(`No active spotlight in map for ${tokenId}. Checking flags...`); const foundLight = findSpotlightForToken(tokenId); if (foundLight) { lightId = foundLight.id; lightUUID = foundLight.uuid; console.log(`Found spotlight ${lightId} via flag.`); } else { console.log(`No spotlight found via flag for ${tokenId}.`); return; } } else { const foundDoc = [...lightDocMap.values()].find(doc => doc.id === lightId); if (foundDoc) lightUUID = foundDoc.uuid; } if (lightId) { console.log(`Deleting spotlight ${lightId} for ${tokenId}`); try { await canvas.scene.deleteEmbeddedDocuments("AmbientLight", [lightId]); activeSpotlights.delete(tokenId); if (lightUUID) lightDocMap.delete(lightUUID); console.log(`Spotlight ${lightId} deleted.`); } catch (err) { console.error(`Error deleting spotlight ${lightId}:`, err); activeSpotlights.delete(tokenId); if (lightUUID) lightDocMap.delete(lightUUID); } } } }); }

        } // End render function
    }; // End dialogData

    // --- Dialog Options ---
    const dialogOptions = {
        width: 700, height: "auto", resizable: true,
        classes: ["dialog", DIALOG_ID.replace('#', '')],
        popOut: true, id: DIALOG_ID
    };

    // --- Create and Render Dialog ---
    spotlightHookIds = []; // Reset hook storage
    let newDialog = null; // Declare here for access in close callback

    const existingDialog = Object.values(ui.windows).find(w => w.id === DIALOG_ID);
    if (existingDialog) {
        console.log(`Macro | Closing existing dialog: ${DIALOG_ID}`);
        const lightIdsToDelete = Array.from(activeSpotlights.values());
        if (lightIdsToDelete.length > 0) { try { await canvas.scene.deleteEmbeddedDocuments("AmbientLight", lightIdsToDelete); } catch {} }
        activeSpotlights.clear();
        if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (tokenRefreshDebounceMap.size > 0) { for (const timeoutId of tokenRefreshDebounceMap.values()) { clearTimeout(timeoutId); } tokenRefreshDebounceMap.clear(); }
        const oldHookIds = existingDialog._locLightControlHookIds || spotlightHookIds; // Use stored or global
        console.log("Macro | Unregistering hooks from previous instance:", oldHookIds);
        oldHookIds.forEach(id => Hooks.off("updateToken", id)); oldHookIds.forEach(id => Hooks.off("deleteToken", id)); oldHookIds.forEach(id => Hooks.off("createToken", id)); oldHookIds.forEach(id => Hooks.off("refreshToken", id));
        spotlightHookIds = [];
        await existingDialog.close();
    }

    console.log(`Macro | Rendering new dialog: ${DIALOG_ID}`);
    newDialog = new Dialog(dialogData, dialogOptions); // Assign to the outer scope variable
    newDialog._locLightControlHookIds = spotlightHookIds; // Store hook array ON the dialog instance
    newDialog.render(true);

})().catch(err => {
    console.error("Macro Error | Uncaught exception in main execution:", err);
    ui.notifications.error("An error occurred in the Location Light Controller Macro. Check the console (F12).");
});