# Loading Screens & Scene Transitions — Planning Document

## 1. Overview

A world-level system that gives GMs full creative control over **loading screens** (initial Foundry startup) and **scene transition screens** (switching between scenes). The system provides a visual composer for laying out elements, a wallpaper manager, font selection (Google Fonts + Foundry built-ins), and curated presets — all stored at the **world** level so every player sees the same branded experience.

### Goals

- Replace Foundry's bland `#loading` / `#loading-bar` and Map Shine's current `LoadingOverlay` with a fully customisable, cinematic loading experience.
- Operate on a **world basis** (settings persist across scenes, visible to all players).
- Cover **two contexts**: initial world load and scene-to-scene transitions.
- Provide a **visual composer dialog** where the GM drags/places elements (text, images, progress bar, spinner, tips, etc.).
- Ship with **curated presets** (dark fantasy, sci-fi, parchment, minimalist, etc.).
- Support **wallpaper pools** with random selection and a "first load" pin.
- Load **as early as possible** in the Foundry lifecycle so the screen is styled before the user sees anything.
- Store templates/presets in a **separate JSON data file** to keep settings lean.

---

## 2. Foundry Integration Points

### 2.1 Foundry's Native Loading UI

Foundry's game view (`game.hbs`) contains:

```html
<div id="loading">
  <div id="loading-bar">
    <label id="context"></label>
    <label id="progress"></label>
  </div>
</div>
```

- Scene texture loading uses `TextureLoader.load()` which calls `ui.notifications.info(message, {progress: true})` to show a notification-bar progress indicator (Foundry v13+).
- `SceneNavigation.displayProgressBar` is deprecated in v13 in favour of the notification approach.
- The `#loading` element is only visible during canvas initialization.

### 2.2 Map Shine's Current Loading Overlay

`scripts/ui/loading-overlay.js` — a singleton `LoadingOverlay` class:

- Creates a fixed `z-index: 100000` overlay with spinner, stage pills, progress bar, timer, debug log.
- Invoked at `Hooks.once('init')` via `loadingOverlay.showBlack()`.
- Scene transitions use `installCanvasTransitionWrapper()` in `canvas-replacement.js` which wraps `Canvas.prototype.tearDown` to fade to black.
- Stage-based progress tracking during `createThreeCanvas`.

### 2.3 Hook Timing

| Hook | Availability | Use |
|------|-------------|-----|
| `init` | Settings registered, no game data yet | Earliest point to inject our overlay, read world settings |
| `setup` | World data loaded, documents initialised | Font loading, wallpaper preloading |
| `ready` | Full UI available | Composer dialog registration |
| `canvasInit` | Canvas about to initialise | Scene transition overlay |
| `canvasTearDown` | Canvas being torn down | Transition fade-out |
| `canvasReady` | Canvas fully rendered | Transition fade-in / dismiss |

### 2.4 Font Sources

- **Foundry built-in fonts**: `CONFIG.fontDefinitions` + `game.settings.get("core", "fonts")` — available via `FontConfig.getAvailableFonts()`.
- **Google Fonts**: Loaded dynamically via `<link>` tag or `FontFace` API at runtime. We need the user to specify a Google Font family name; we build the URL and load it.
- **Custom uploaded fonts**: Foundry's `FontConfig` already supports file-based fonts. We can piggyback on this or load independently.

---

## 3. Architecture

### 3.1 File Structure

```
scripts/
  ui/
    loading-screen/
      loading-screen-manager.js    # Singleton orchestrator
      loading-screen-composer.js   # Visual composer dialog (Foundry ApplicationV2)
      loading-screen-renderer.js   # DOM renderer that builds the actual overlay
      loading-screen-presets.js    # Built-in preset definitions
      loading-screen-fonts.js      # Font loading helper (Google + Foundry)
      loading-screen-wallpapers.js # Wallpaper pool manager
  settings/
    loading-screen-settings.js     # World-scope settings registration
data/
  loading-screen-presets.json      # Shipped preset templates (separate file)
```

### 3.2 Data Model

All loading screen configuration is stored as a single world-scope setting: `map-shine-advanced.loadingScreenConfig`.

```typescript
interface LoadingScreenConfig {
  /** Whether the custom loading screen system is enabled */
  enabled: boolean;

  /** Which context(s) to apply to */
  applyTo: 'both' | 'world-load' | 'scene-transition';

  /** The active layout template */
  layout: LoadingScreenLayout;

  /** Wallpaper pool configuration */
  wallpapers: WallpaperPool;

  /** Global style overrides */
  style: GlobalStyle;

  /** Optional: ID of a preset this was derived from (for reset) */
  basePresetId: string | null;
}

interface LoadingScreenLayout {
  /** Ordered list of elements on the screen */
  elements: LayoutElement[];
}

interface LayoutElement {
  id: string;
  type: 'title' | 'subtitle' | 'progress-bar' | 'spinner' | 'image'
      | 'text-block' | 'tips-rotator' | 'scene-name' | 'elapsed-timer'
      | 'stage-pills' | 'custom-html';

  /** Whether this element is visible */
  visible: boolean;

  /** Position as percentage of viewport (anchor point) */
  position: { x: number; y: number };

  /** Anchor origin: 'center' | 'top-left' | 'top-center' | 'bottom-center' etc. */
  anchor: string;

  /** Element-specific properties */
  props: Record<string, any>;

  /** Style overrides for this element */
  style: ElementStyle;
}

interface ElementStyle {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  opacity?: number;
  textShadow?: string;
  // ... additional CSS-like properties
}

interface WallpaperPool {
  /** List of wallpaper entries */
  entries: WallpaperEntry[];

  /** Selection mode */
  mode: 'random' | 'sequential' | 'single';

  /** Transition effect between wallpapers (for sequential in long loads) */
  transition: 'fade' | 'none';

  /** CSS object-fit for wallpapers */
  fit: 'cover' | 'contain' | 'fill';

  /** Optional overlay tint/gradient on top of wallpaper */
  overlay: {
    enabled: boolean;
    type: 'solid' | 'gradient';
    color: string;       // e.g. 'rgba(0,0,0,0.6)'
    gradient?: string;   // e.g. 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)'
  };
}

interface WallpaperEntry {
  id: string;
  /** Path to the image (Foundry data path or URL) */
  src: string;
  /** Display name */
  label: string;
  /** If true, always used for the very first load of the session */
  pinToFirstLoad: boolean;
  /** Weight for random selection (higher = more likely) */
  weight: number;
}

interface GlobalStyle {
  /** Primary font for headings */
  primaryFont: string;
  /** Body font for descriptions/tips */
  bodyFont: string;
  /** Accent color (progress bar, spinner, highlights) */
  accentColor: string;
  /** Background color (fallback when no wallpaper) */
  backgroundColor: string;
  /** Whether to use backdrop blur on content panels */
  backdropBlur: boolean;
}
```

### 3.3 Preset Data File

Presets are stored in `data/loading-screen-presets.json` (or `.js` for easier bundling). Each preset is a complete `LoadingScreenConfig` snapshot that the user can load, then customise.

Example presets to ship:

| Preset | Description |
|--------|-------------|
| **Classic Map Shine** | Current overlay style (dark glass panel, blue accent, stage pills) |
| **Dark Fantasy** | Parchment-textured wallpaper, serif fonts, golden accent, ornate spinner |
| **Sci-Fi Terminal** | Dark background, monospace font, green/cyan accent, scanline overlay |
| **Minimalist** | No wallpaper, centred text only, thin progress line, system font |
| **Cinematic** | Full-bleed wallpaper, large scene name, bottom progress bar, no panel |
| **Tavern Board** | Wood-texture wallpaper, handwritten font, warm amber accents |

### 3.4 Preset Storage Strategy

Presets ship as a static asset file (`data/loading-screen-presets.json`) bundled with the module. The user's active config is stored in the world setting. When the user picks a preset, we deep-clone it into the setting. The `basePresetId` field tracks lineage so a "Reset to Preset" button can work.

User-created presets (save-as) are stored in a second world setting: `map-shine-advanced.loadingScreenUserPresets` (array of `{id, name, config}`).

---

## 4. Bootstrap & Early Loading Strategy

### 4.1 The Problem

The loading screen must be visible **before** Foundry finishes initialising. Currently `loadingOverlay.showBlack()` fires at `Hooks.once('init')`, which is the earliest module hook. But the `init` hook fires after:

1. Page load / DOM ready
2. Module scripts loaded (our `module.js` ESM import)
3. Foundry calls `game.initialize()` which fires `Hooks.callAll("init")`

Settings are available at `init` time (`game.settings` is ready). So our earliest opportunity is:

```
DOM ready → module.js loaded → init hook → read world settings → render loading screen
```

### 4.2 Proposed Bootstrap Sequence

1. **`init` hook** (earliest):
   - Read `map-shine-advanced.loadingScreenConfig` from world settings.
   - If enabled, immediately call `LoadingScreenManager.bootstrap(config)`.
   - This hides Foundry's native `#loading` element via `display: none`.
   - Injects our custom loading screen DOM into `document.body`.
   - Picks a wallpaper (respecting `pinToFirstLoad`).
   - Starts font loading for configured fonts (non-blocking — use system fallback until loaded).
   - Shows the screen immediately with system fonts, then swap in custom fonts when ready (FOUT is acceptable here since it's a loading screen).

2. **`setup` hook**:
   - Fonts should be loaded by now. Refresh any text elements if fonts arrived late.
   - Preload wallpaper images for scene transitions (if different from current).

3. **Scene transition** (`Canvas.tearDown` wrapper):
   - Show transition screen (may pick a new random wallpaper).
   - Drive progress from `createThreeCanvas` stages as today.

4. **Scene ready** (`canvasReady` or Map Shine's final stage):
   - Fade out the loading screen with configured transition.

### 4.3 Hiding Foundry's Native Loading UI

```javascript
// In init hook, immediately after reading config:
const nativeLoading = document.getElementById('loading');
if (nativeLoading) nativeLoading.style.display = 'none';

// Also suppress the notification-based progress bar during texture loading
// by wrapping TextureLoader.prototype.load to skip displayProgress when our system is active.
```

### 4.4 Relationship to Existing LoadingOverlay

The existing `LoadingOverlay` class becomes the **fallback renderer**. If the loading screen system is disabled (or settings fail to load), we fall back to the current overlay seamlessly. The new `LoadingScreenRenderer` replaces the DOM generation but reuses the progress-tracking logic (stages, auto-progress, timer).

Strategy:
- Extract progress/stage logic from `LoadingOverlay` into a shared `LoadingProgressTracker` utility.
- `LoadingOverlay` (legacy) and `LoadingScreenRenderer` (new) both consume the tracker.
- `LoadingScreenManager` decides which renderer to use based on config.

---

## 5. Visual Composer Dialog

### 5.1 Concept

A Foundry `ApplicationV2` dialog (GM-only) that provides a **WYSIWYG-like** editor for the loading screen layout. The dialog shows a live preview of the loading screen with draggable/configurable elements.

### 5.2 Composer Features

- **Live Preview Panel**: A scaled-down viewport showing the current loading screen layout with the active wallpaper.
- **Element Palette**: Add new elements from a list (title, subtitle, progress bar, spinner, image, tips rotator, etc.).
- **Element Inspector**: Click an element in the preview to select it. The inspector panel shows its properties (position, font, color, size, visibility toggle).
- **Drag Positioning**: Elements can be dragged within the preview to reposition. Positions stored as viewport percentages for resolution independence.
- **Wallpaper Manager Tab**: Add/remove wallpapers, set weights, pin first-load image, configure overlay tint.
- **Font Picker**: Dropdown combining Foundry's available fonts + a Google Fonts text input with live preview.
- **Preset Browser Tab**: Browse built-in and user-saved presets with thumbnail previews. Load / Save As / Delete.
- **Style Tab**: Global style controls (accent color, background color, backdrop blur, etc.).

### 5.3 Dialog Layout (Rough)

```
┌──────────────────────────────────────────────────────┐
│ Loading Screen Composer                         [×]  │
├──────┬───────────────────────────────────────────────┤
│      │                                               │
│  E   │         LIVE PREVIEW (16:9 scaled)            │
│  L   │                                               │
│  E   │    ┌─────────────────────┐                    │
│  M   │    │   My World Title    │                    │
│  E   │    │   Loading scene...  │                    │
│  N   │    │   ████████░░░ 65%   │                    │
│  T   │    └─────────────────────┘                    │
│      │                                               │
│  L   ├───────────────────────────────────────────────┤
│  I   │ INSPECTOR                                     │
│  S   │ Selected: Title Text                          │
│  T   │ Font: [Modesto Condensed ▾] Size: [28px]     │
│      │ Color: [#ffffff] Weight: [700 ▾]              │
│      │ Position: X [50%] Y [35%] Anchor: [center ▾] │
│      │ Text Shadow: [0 2px 8px rgba(0,0,0,0.8)]     │
├──────┴───────────────────────────────────────────────┤
│ [Presets ▾] [Wallpapers] [Fonts] [Style]  [Save]    │
└──────────────────────────────────────────────────────┘
```

### 5.4 Element Types

| Type | Description | Configurable Props |
|------|-------------|-------------------|
| `title` | Main heading text | `text`, font, size, color, shadow |
| `subtitle` | Secondary text (e.g. world name) | `text`, `useWorldName` (auto-fill), font, size, color |
| `scene-name` | Auto-populated scene name during transitions | font, size, color, prefix text |
| `progress-bar` | Horizontal progress indicator | width, height, colors (track/fill/glow), border-radius, show-percentage |
| `spinner` | Animated loading indicator | `variant` (ring/dots/pulse/custom), size, color |
| `image` | Static graphic (logo, emblem, etc.) | `src`, width, height, opacity, border |
| `text-block` | Arbitrary text paragraph | `text`, font, size, color, max-width |
| `tips-rotator` | Rotating tips/lore text | `tips[]`, interval, fade duration, font, size |
| `elapsed-timer` | Time since loading started | font, size, color, format |
| `stage-pills` | Stage progress indicators | pill style, colors, font |
| `custom-html` | Raw HTML block (advanced) | `html` |

### 5.5 Tips System

The `tips-rotator` element cycles through user-defined strings. GMs can add game-specific tips, lore snippets, or quotes. Presets ship with thematic defaults.

---

## 6. Wallpaper Manager

### 6.1 Features

- **Add wallpapers** via Foundry's FilePicker (supports images from Data, S3, etc.).
- **Reorder** wallpapers via drag handles.
- **Set weight** per wallpaper (1-10 scale) for random selection probability.
- **Pin to first load**: One wallpaper can be flagged as the mandatory first-load image.
- **Preview**: Thumbnail previews in the manager list.
- **Fit mode**: Global `cover` / `contain` / `fill` setting.
- **Overlay tint**: A colour/gradient overlay on top of the wallpaper to ensure text readability.
  - Solid colour (e.g. `rgba(0,0,0,0.6)`)
  - Gradient (e.g. `linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, transparent 40%, transparent 60%, rgba(0,0,0,0.9) 100%)`)
  - Vignette (radial gradient from centre)

### 6.2 Selection Algorithm

```javascript
function selectWallpaper(pool, isFirstLoad) {
  const entries = pool.entries.filter(e => e.src);
  if (entries.length === 0) return null;

  // First load: use pinned wallpaper if available
  if (isFirstLoad) {
    const pinned = entries.find(e => e.pinToFirstLoad);
    if (pinned) return pinned;
  }

  if (pool.mode === 'single') return entries[0];
  if (pool.mode === 'sequential') {
    // Track index in session storage
    const idx = (sessionStorage.getItem('ms-wallpaper-idx') || 0) % entries.length;
    sessionStorage.setItem('ms-wallpaper-idx', idx + 1);
    return entries[idx];
  }

  // Weighted random
  const totalWeight = entries.reduce((sum, e) => sum + (e.weight || 1), 0);
  let roll = Math.random() * totalWeight;
  for (const entry of entries) {
    roll -= (entry.weight || 1);
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}
```

### 6.3 Preloading

On `setup` hook, preload all wallpaper images as `<img>` elements (or `Image()` objects) so transitions are instant. Cache in a module-level Map.

---

## 7. Font System

### 7.1 Foundry Built-In Fonts

Available via `FontConfig.getAvailableFonts()` after fonts are loaded. Includes Signika, Modesto Condensed, and any world-configured fonts.

### 7.2 Google Fonts Integration

- User types a Google Font family name (e.g. "Cinzel", "Roboto Slab").
- We construct the CSS import URL: `https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&display=swap`
- Inject a `<link>` element into `<head>`.
- Wait for `document.fonts.ready` or use `FontFace` API to confirm loading.
- Store the Google Font family name in the config so it's reloaded on next session.

### 7.3 Font Picker UI

A dropdown / combo-box in the composer:

1. **Section: Foundry Fonts** — Lists all fonts from `FontConfig.getAvailableFonts()`.
2. **Section: Google Fonts** — Text input where user types a family name. On blur/enter, we attempt to load it. If successful, it appears in a "Recently Used Google Fonts" section.
3. **Live preview**: The dropdown items render in their own font face.

### 7.4 Font Config Storage

```typescript
interface FontConfig {
  /** Google Font families to load */
  googleFonts: string[];
  /** Primary font (headings) */
  primary: string;
  /** Body font (descriptions, tips) */
  body: string;
}
```

Google font families are loaded at `init` time (non-blocking) before the rest of the loading screen renders.

---

## 8. Settings Architecture

### 8.1 World-Scope Settings

| Setting Key | Type | Description |
|-------------|------|-------------|
| `loadingScreenConfig` | `Object` | The full `LoadingScreenConfig` (see §3.2) |
| `loadingScreenUserPresets` | `Object[]` | User-saved preset snapshots |
| `loadingScreenEnabled` | `Boolean` | Quick toggle (also in config, but a separate top-level for fast access) |

All are `scope: 'world'` so they're shared across all clients.

### 8.2 Why World Scope?

- The loading screen is a **world branding** feature — all players should see the same thing.
- Only the GM can edit it (Foundry enforces world-scope write permissions).
- Players receive the setting value on connect and render locally.

### 8.3 Client-Local Overrides (Future)

A possible future enhancement: a client-scope `loadingScreenPlayerOverride` setting that lets players disable the custom loading screen if it causes performance issues (e.g. slow wallpaper loading on metered connections). For v1, not needed.

---

## 9. Scene Transition Flow

### 9.1 Current Flow (to preserve)

```
User clicks scene → Canvas.tearDown wrapper fires → fadeToBlack → Canvas.tearDown runs →
canvasInit hook → createThreeCanvas starts → stage progress → canvasReady → fadeIn
```

### 9.2 Enhanced Flow

```
User clicks scene →
  Canvas.tearDown wrapper fires →
    LoadingScreenManager.showTransition(nextScene) →
      Pick wallpaper (random/sequential) →
      Render loading screen with scene name →
      Crossfade from gameplay to loading screen (configurable duration) →
  Canvas.tearDown runs →
  canvasInit hook →
    createThreeCanvas starts →
      LoadingScreenManager.setStage() drives progress →
  canvasReady →
    LoadingScreenManager.dismiss() →
      Configurable fade-out (fade / slide / dissolve)
```

### 9.3 Transition Animations

| Transition | Description |
|-----------|-------------|
| `fade` | Simple opacity crossfade (default) |
| `slide-down` | Loading screen slides down to reveal scene |
| `dissolve` | Pixelated dissolve effect (CSS filter) |
| `none` | Instant cut |

---

## 10. Phased Implementation Plan

### Phase 1: Foundation (Core System)

- [ ] **P1.1** — Create `LoadingScreenManager` singleton (orchestrator)
- [ ] **P1.2** — Create `LoadingScreenRenderer` (DOM builder from config)
- [ ] **P1.3** — Register world-scope settings (`loadingScreenConfig`, `loadingScreenEnabled`)
- [ ] **P1.4** — Extract `LoadingProgressTracker` from existing `LoadingOverlay`
- [ ] **P1.5** — Bootstrap at `init` hook: read config → render → hide native `#loading`
- [ ] **P1.6** — Wire scene transition wrapper to use new system
- [ ] **P1.7** — Fallback to legacy `LoadingOverlay` when disabled
- [ ] **P1.8** — Wallpaper selection logic (random/sequential/single + pin)
- [ ] **P1.9** — Wallpaper preloading at `setup`

### Phase 2: Presets & Fonts

- [ ] **P2.1** — Create `loading-screen-presets.json` with 4-6 built-in presets
- [ ] **P2.2** — Preset loading/application logic in manager
- [ ] **P2.3** — Google Fonts dynamic loader (`loading-screen-fonts.js`)
- [ ] **P2.4** — Foundry font enumeration helper
- [ ] **P2.5** — Font loading at `init` (non-blocking with FOUT fallback)

### Phase 3: Visual Composer

- [ ] **P3.1** — Composer dialog shell (Foundry ApplicationV2 or custom DOM)
- [ ] **P3.2** — Live preview panel with scaled viewport
- [ ] **P3.3** — Element palette (add/remove elements)
- [ ] **P3.4** — Element inspector (property editing)
- [ ] **P3.5** — Drag positioning in preview
- [ ] **P3.6** — Wallpaper manager tab
- [ ] **P3.7** — Font picker with live preview
- [ ] **P3.8** — Preset browser tab (load/save-as/delete)
- [ ] **P3.9** — Style tab (accent color, background, blur)
- [ ] **P3.10** — Save to world settings on apply/close

### Phase 4: Polish & Advanced

- [ ] **P4.1** — Tips rotator element with fade cycling
- [ ] **P4.2** — Transition animation options (slide, dissolve)
- [ ] **P4.3** — Suppress Foundry's native notification progress bar during loads
- [ ] **P4.4** — User preset export/import (JSON file download/upload)
- [ ] **P4.5** — Module setting button in Foundry's module config to open composer
- [ ] **P4.6** — Keyboard shortcut or scene control button to open composer

---

## 11. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Settings not available at `init` | Settings ARE available at `init` in Foundry v12+/v13. Verified via source. |
| Google Fonts blocked (offline/firewall) | Graceful fallback to system fonts. Non-blocking load. |
| Large wallpapers slow to load | Preload in background. Show solid color immediately, crossfade when ready. |
| Config corruption | Validate config on read. Fall back to defaults on parse error. |
| Conflict with other modules that touch `#loading` | We hide `#loading` immediately; other modules unlikely to care since it's a simple div. |
| Composer complexity | Phase 3 is optional for v1. The system works with presets and manual JSON editing even without the composer. |

---

## 12. Open Questions

1. **Video wallpapers?** — Should we support `.webm` / `.mp4` backgrounds? High impact but adds complexity (autoplay policies, memory). Recommend deferring to v2.
2. **Audio on loading screen?** — Ambient music during loading? Browsers block autoplay without user interaction. Could work for scene transitions (user already interacted). Defer.
3. **Per-scene overrides?** — Should a scene be able to override the world loading screen (e.g. "entering the dungeon" has a dungeon-themed transition)? Nice to have, store as scene flag. Defer to v2.
4. **Loading screen for non-Map-Shine scenes?** — Should the loading screen also appear for scenes that don't use Map Shine? Currently the overlay only shows for MS-enabled scenes. The world-load screen should always show regardless. Scene transitions could be gated.

---

## 13. Technical Notes

### 13.1 DOM Layering

```
z-index hierarchy:
  100001  Loading screen (above everything, including Foundry UI)
  100000  Legacy LoadingOverlay (current)
  10      Foundry PIXI canvas (#board)
  1       Three.js canvas (#map-shine-canvas)
```

### 13.2 CSS Approach

All loading screen styles should be injected via a `<style>` element (as `LoadingOverlay` does today) rather than relying on `styles/module.css`. This ensures styles are available immediately at `init` time before Foundry loads external stylesheets.

### 13.3 Image Paths

Wallpapers and graphics use Foundry data paths (e.g. `worlds/my-world/loading/wallpaper1.webp`). The FilePicker integration handles path resolution. For presets, we can ship default wallpapers in `assets/loading/` within the module.

### 13.4 Performance Budget

- Loading screen DOM should be <50 elements.
- Wallpaper images should be pre-decoded (`Image.decode()`) before display.
- Font loading should have a 3-second timeout (show fallback after that).
- No heavy JS (no three.js, no canvas rendering) — pure DOM/CSS.

### 13.5 Suppressing Foundry's Native Progress

During scene texture loading, Foundry creates a notification bar via `ui.notifications.info(message, {progress: true})`. We can either:

- **Option A**: Let it show underneath our overlay (invisible to user). Simplest.
- **Option B**: Wrap `TextureLoader.prototype.load` to skip `displayProgress` when our system is active.

Recommend **Option A** for v1. The notification is hidden behind our overlay anyway.

---

## 14. CSS & HTML5 Animation Effects Catalog

All effects below are pure CSS/HTML5 — no canvas, no three.js, no WebGL. They run on the compositor thread where possible (transforms, opacity, filters) for smooth 60fps even during heavy JS loading.

### 14.1 Element Entrance Animations

These play once when an element first appears on the loading screen. Each element in the layout can have an `entrance` property selecting from these.

| Animation | CSS Technique | Description |
|-----------|--------------|-------------|
| `fade-in` | `opacity: 0→1` | Simple opacity fade. The bread and butter. |
| `fade-in-up` | `opacity 0→1` + `translateY(20px→0)` | Fade in while sliding upward. Elegant default. |
| `fade-in-down` | `opacity 0→1` + `translateY(-20px→0)` | Fade in while sliding downward from above. |
| `fade-in-left` | `opacity 0→1` + `translateX(-30px→0)` | Slide in from the left. |
| `fade-in-right` | `opacity 0→1` + `translateX(30px→0)` | Slide in from the right. |
| `scale-in` | `opacity 0→1` + `scale(0.8→1)` | Grows from slightly smaller. Feels punchy. |
| `scale-in-bounce` | `scale(0→1.05→1)` | Pops in with a slight overshoot bounce. |
| `blur-in` | `filter: blur(12px)→blur(0)` + `opacity 0→1` | Emerges from a blur. Dreamy/cinematic feel. |
| `clip-reveal-up` | `clip-path: inset(100% 0 0 0)→inset(0)` | Revealed by an upward wipe mask. |
| `clip-reveal-left` | `clip-path: inset(0 100% 0 0)→inset(0)` | Revealed by a left-to-right wipe. |
| `clip-reveal-center` | `clip-path: inset(50% 50% 50% 50%)→inset(0)` | Expands outward from the centre. |
| `typewriter` | `width: 0→100%` with `steps(N)` + blinking cursor pseudo-element | Types out text character by character. Best for monospace. |
| `letter-cascade` | Per-`<span>` stagger with `animation-delay` | Each letter fades/slides in one at a time. Requires wrapping text in `<span>`s. |
| `drop-in` | `translateY(-100vh→0)` with `cubic-bezier(0.34, 1.56, 0.64, 1)` | Falls from above with a bounce easing. |
| `flip-in` | `rotateX(90deg→0)` with `perspective` | 3D flip reveal (card-flip feel). |
| `glitch-in` | `clip-path` slices + `translateX` jitter keyframes | Glitchy digital reveal. 3-4 rapid clip-path slices. |

### 14.2 Looping / Ambient Animations

These run continuously while the loading screen is visible, adding life and atmosphere.

| Animation | CSS Technique | Description |
|-----------|--------------|-------------|
| `pulse` | `opacity: 0.6→1→0.6` | Gentle breathing pulse. Great for spinners, accent elements. |
| `float` | `translateY(0→-8px→0)` | Slow hover/bob. Ideal for logos, icons, images. |
| `float-rotate` | `translateY(0→-6px→0)` + `rotate(-2deg→2deg)` | Floating with a gentle tilt. Magical feel. |
| `shimmer` | Pseudo-element with `linear-gradient(transparent, white 50%, transparent)` moving via `translateX(-100%→100%)` | A shine sweep across text or images. Gold/silver effect. |
| `glow-pulse` | `text-shadow` or `box-shadow` intensity oscillation | Pulsing glow around text or borders. |
| `color-cycle` | `filter: hue-rotate(0→360deg)` | Slowly rotates through the colour spectrum. Psychedelic/arcane. |
| `gradient-shift` | `background-position` animation on oversized gradient | Background gradient that slowly moves/shifts. |
| `spin` | `rotate(0→360deg)` | Continuous rotation. For spinners, gear icons. |
| `spin-reverse` | `rotate(360deg→0)` | Counter-rotation. Pair with `spin` for mechanical feel. |
| `pendulum` | `rotate(-15deg→15deg)` with `ease-in-out` | Swinging pendulum motion. For hanging signs, pendants. |
| `breathe-scale` | `scale(1→1.03→1)` | Very subtle size pulse. Adds life to static images. |
| `flicker` | Randomised `opacity` keyframes (1, 0.85, 0.9, 1, 0.8, 1) | Candle/torch flicker. Irregular timing sells it. |
| `scan-line-drift` | Pseudo-element with `repeating-linear-gradient` + `translateY` animation | Scrolling CRT scanlines. Sci-fi aesthetic. |

### 14.3 Background / Wallpaper Effects

Applied to the full-screen wallpaper layer.

| Effect | CSS Technique | Description |
|--------|--------------|-------------|
| **Ken Burns** | `scale(1→1.15)` + `translate(0→3%, 0→-2%)` over 20-30s | Slow zoom + drift on a still image. Cinematic staple. Makes any static wallpaper feel alive. |
| **Parallax Layers** | Multiple `background-image` layers with different `background-position` animation speeds | Depth illusion. E.g. far mountains move slowly, near fog moves faster. Requires layered wallpaper design. |
| **Slow Pan** | `background-position` animation from `0% 50%` to `100% 50%` | Slowly pans across a wide wallpaper. Good for panoramic art. |
| **Vignette** | `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.8) 100%)` overlay | Darkened edges that draw focus to the centre. |
| **Grain/Noise** | Tiny tiled noise PNG (64×64) with `background-position` rapidly cycling via `steps(8)` | Film grain texture. Adds warmth and texture. Very subtle. |
| **Colour Wash** | Semi-transparent overlay with `background-color` animated via `filter: hue-rotate` | Slowly shifts the colour temperature of the wallpaper. |
| **Desaturate In** | `filter: grayscale(1)→grayscale(0)` over 3-5s | Wallpaper starts greyscale, colour bleeds in. Dramatic reveal. |
| **Blur Reveal** | `filter: blur(20px)→blur(0)` over 2-4s | Wallpaper starts blurred, sharpens as loading progresses. Can be tied to progress %. |
| **Crossfade** | Two stacked `<img>` elements, swap opacity | For wallpaper pools — smoothly crossfade between images during long loads. |

### 14.4 Progress Bar Variants

The progress bar is the most important functional element. These are different visual treatments.

| Variant | Technique | Description |
|---------|-----------|-------------|
| **Classic Bar** | `width` transition on inner div | Standard horizontal fill bar with rounded corners. |
| **Gradient Bar** | `linear-gradient` background on bar + `background-size` animation | Moving gradient that creates a shimmer/flow within the bar. |
| **Glow Bar** | Bar + animated `box-shadow` pulse | The filled portion pulses with a glow aura. |
| **Striped Bar** | `repeating-linear-gradient(45deg, ...)` with `background-position` animation | Classic candy-stripe loading bar that appears to move. |
| **Thin Line** | 2-3px height bar at top or bottom of screen | Minimal, out of the way. YouTube-style. |
| **Dot Progress** | Multiple `<span>` dots, filled sequentially via `nth-child` + `animation-delay` | 10-20 dots that light up as loading progresses. RPG quest tracker feel. |
| **Circle Progress** | SVG `<circle>` with `stroke-dashoffset` animation | Circular progress ring. Can surround a logo or spinner. |
| **Segment Bar** | Multiple discrete segments (flex children) that fill individually | Segmented bar where each segment = one loading stage. |
| **Liquid Fill** | `clip-path` or `border-radius` animation on the bar edge | The leading edge of the bar has a wave/liquid shape. |
| **Rune Bar** | Segments styled as rune/glyph shapes that light up | Fantasy-themed. Each "rune" is a progress step that glows when reached. |

### 14.5 Spinner Variants

Alternatives to the standard ring spinner.

| Variant | Technique | Description |
|---------|-----------|-------------|
| **Ring** | `border` with `border-top-color` + `rotate` animation | Classic spinning ring. Current default. |
| **Dual Ring** | Two concentric rings spinning in opposite directions | More complex, mechanical feel. |
| **Dots Orbit** | 3-4 small dots on a `rotate` animation with `animation-delay` stagger | Dots chasing each other in a circle. |
| **Pulse Dot** | Single dot with `scale(1→2→1)` + `opacity` | Minimal single pulsing dot. |
| **Three Bounce** | Three dots with staggered `translateY` bounce | Classic "typing indicator" style. |
| **Hourglass** | `rotate(180deg)` alternating with `ease-in-out` | Flipping hourglass. Fantasy appropriate. |
| **Compass** | A needle element with `rotate` + slight `ease` wobble | Compass needle that swings and settles. Exploration theme. |
| **Quill** | Small image of a quill with `pendulum` swing + `translateX` drift | Writing/scribing animation. Parchment theme. |
| **Gear** | Two interlocking gear SVGs with counter-rotation | Steampunk / mechanical theme. |
| **Orbiting Rune** | Small glyph on a circular path via `offset-path` + `offset-distance` animation | Arcane rune orbiting a central point. |

### 14.6 Decorative Overlay Effects

Fullscreen overlays that add atmosphere without replacing the wallpaper.

| Effect | Technique | Description |
|--------|-----------|-------------|
| **Scanlines** | `repeating-linear-gradient(transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)` | CRT monitor lines. Sci-fi / retro. |
| **Vignette** | `radial-gradient` from transparent centre to dark edges | Focus-drawing edge darkening. |
| **Film Grain** | Tiled noise PNG with `animation: grain 0.5s steps(6) infinite` shifting `background-position` | Subtle grain texture. Cinematic warmth. |
| **Fog Drift** | 2-3 large semi-transparent gradient divs with slow `translateX` + `opacity` loops at different speeds | Drifting fog layers. Fantasy/horror. |
| **Ember Particles** | 8-15 small `<div>` circles with individual `translateY` (upward) + `opacity` + `translateX` wobble keyframes, staggered delays | Rising embers/sparks. No JS needed — pure CSS animations with unique delays. |
| **Snow / Ash Fall** | 15-25 small `<div>` circles with falling `translateY` + `translateX` sine wobble via separate keyframes | Falling particles. Each div gets random size, delay, duration, horizontal drift. |
| **Twinkling Stars** | 20-40 tiny `<div>` positioned via `top`/`left` percentages with staggered `opacity` pulse animations | Night sky twinkle. Random sizes (1-3px), random delays. |
| **Light Rays** | 3-5 long thin gradient divs angled via `rotate`, with `opacity` pulse | God-ray / sunbeam effect from a corner or edge. |
| **Rain Streaks** | 10-20 thin tall `<div>`s with fast `translateY` + slight `translateX`, staggered | Vertical rain lines. Thin (1-2px), high speed, varying length. |
| **Magic Motes** | 6-10 small glowing dots with unique `offset-path: path(...)` + `offset-distance` animation | Floating magical particles following curved paths. Uses CSS Motion Path. |
| **Fireflies** | 8-12 small dots with slow random-feeling `translate` loops + `opacity` flicker, all different durations | Gentle floating lights. Long durations (8-15s) with varied timing. |
| **Dust Motes** | 10-15 tiny dots with very slow diagonal drift + `opacity: 0→0.3→0` | Barely visible drifting dust in a sunbeam. Extremely subtle. |
| **Smoke Wisps** | 3-5 large blurred circles (`filter: blur(40px)`) with slow drift + `opacity` + `scale` | Large soft shapes that slowly morph and drift. Ethereal. |
| **Lightning Flash** | Full-screen `<div>` with `opacity: 0→0.3→0→0.15→0` keyframes at irregular timing | Intermittent lightning flash. 0.3s flash, 8-15s gap. |

### 14.7 Text Effects

Special treatments for text elements beyond simple entrance animations.

| Effect | Technique | Description |
|--------|-----------|-------------|
| **Glow Text** | `text-shadow` with `0 0 Xpx color` animated intensity | Text with a pulsing glow. Arcane/neon. |
| **Emboss** | Dual `text-shadow` (light above, dark below) | Engraved/raised text on stone or metal. Static but high quality. |
| **Outline Stroke** | Multiple `text-shadow` offsets in 8 directions or `-webkit-text-stroke` | Outlined text that works on any background. |
| **Metallic Shimmer** | `background: linear-gradient(gold, white, gold)` + `background-clip: text` + `background-position` animation | Gold/silver text with a moving highlight. Shimmer sweep. |
| **Gradient Text** | `background: linear-gradient(...)` + `background-clip: text` + `color: transparent` | Multi-colour gradient text. Static or animated via `background-position`. |
| **Shadow Lift** | `text-shadow: 0 4px 20px rgba(0,0,0,0.5)` | Large soft shadow that makes text float above the background. |
| **Neon** | `text-shadow` stack: `0 0 7px, 0 0 10px, 0 0 21px, 0 0 42px` in neon colour | Neon sign glow. Multiple shadow layers for bloom effect. |
| **Typewriter** | `width` animation with `steps()` + pseudo-element blinking cursor | Character-by-character reveal with a blinking cursor bar. |
| **Word Reveal** | `clip-path: inset(0 100% 0 0)→inset(0)` per word with stagger | Words appear one at a time from left. Narration feel. |
| **Flicker Neon** | Neon shadows + intermittent `opacity` drops | Neon sign that occasionally flickers/buzzes. |

### 14.8 Element Animation Data Model Extension

Each `LayoutElement` gains an `animation` property:

```typescript
interface ElementAnimation {
  /** Entrance animation (plays once on appear) */
  entrance: {
    type: string;         // One of the §14.1 animation names
    duration: number;     // ms (default 600)
    delay: number;        // ms delay before starting (default 0)
    easing: string;       // CSS easing (default 'ease-out')
  } | null;

  /** Looping ambient animation (plays continuously) */
  ambient: {
    type: string;         // One of the §14.2 animation names
    duration: number;     // ms per cycle (default 3000)
    easing: string;       // CSS easing (default 'ease-in-out')
  } | null;

  /** Text-specific effect */
  textEffect: string | null; // One of the §14.7 effect names
}
```

The wallpaper layer gains a separate `wallpaperEffect` property:

```typescript
interface WallpaperEffect {
  type: string;          // One of the §14.3 effect names (e.g. 'ken-burns', 'blur-reveal')
  duration: number;      // ms (default 25000 for ken-burns)
  intensity: number;     // 0-1 scale factor (default 0.5)
}
```

And a new top-level `overlayEffects` array on the config:

```typescript
interface OverlayEffect {
  type: string;          // One of the §14.6 effect names
  enabled: boolean;
  intensity: number;     // 0-1 (controls opacity/count/speed)
  color: string;         // Tint colour (where applicable)
  speed: number;         // Relative speed multiplier (0.5 = half, 2 = double)
}
```

### 14.9 Implementation Notes for CSS Animations

- **Compositor-friendly**: All animations should prefer `transform` and `opacity` properties. These run on the GPU compositor thread and won't block the main thread during heavy JS loading. Avoid animating `width`, `height`, `top`, `left` (these trigger layout reflow).
- **`will-change` hints**: Apply `will-change: transform, opacity` to animated elements so the browser promotes them to their own compositor layer.
- **Reduced motion**: Respect `prefers-reduced-motion: reduce`. When active, skip all looping animations and replace entrances with simple `fade-in`.
- **CSS `@keyframes` injection**: All keyframe definitions are injected once via a single `<style>` element at boot. Elements reference them by `animation-name`. No per-element inline keyframes.
- **`animation-play-state`**: Use `paused`/`running` to freeze/resume animations without removing them (useful for composer preview).
- **Particle div generation**: Overlay effects like embers, snow, stars are generated as a batch of `<div>` elements at render time. Each gets randomised `animation-duration`, `animation-delay`, `top`, `left`, and `--size` custom properties. The keyframes themselves are shared; the variation comes from per-element CSS custom properties.

```css
/* Example: ember particle (shared keyframes, per-element variation) */
@keyframes ms-ember-rise {
  0%   { transform: translateY(0) translateX(0) scale(var(--size)); opacity: 0; }
  10%  { opacity: var(--max-opacity); }
  90%  { opacity: var(--max-opacity); }
  100% { transform: translateY(calc(-100vh * var(--travel)))
                    translateX(calc(30px * var(--drift)))
                    scale(0); opacity: 0; }
}

.ms-ember {
  position: absolute;
  bottom: 0;
  width: 4px; height: 4px;
  border-radius: 50%;
  background: var(--ember-color, #ff6a00);
  box-shadow: 0 0 6px var(--ember-color, #ff6a00);
  animation: ms-ember-rise var(--duration) var(--delay) linear infinite;
  will-change: transform, opacity;
}
```

```html
<!-- Generated at render time with randomised custom properties -->
<div class="ms-ember" style="left:23%; --size:0.8; --travel:0.7; --drift:-0.5; --duration:4.2s; --delay:0.3s; --max-opacity:0.9;"></div>
<div class="ms-ember" style="left:67%; --size:1.2; --travel:0.9; --drift:0.8; --duration:5.8s; --delay:1.1s; --max-opacity:0.7;"></div>
<!-- ... 8-15 total -->
```

---

## 15. Preset Template Specifications

Each preset below is a complete design specification. During implementation these translate to `LoadingScreenConfig` JSON objects in `data/loading-screen-presets.json`.

---

### Preset 0: **Default (Map Shine Classic)**

> The current loading overlay, preserved as a selectable option. No wallpaper, dark glass panel, blue accent.

**Wallpaper**: None (solid `#000000` background)  
**Overlay Effects**: None  
**Wallpaper Effect**: None  

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `title` "Map Shine" | x:50% y:32% centre | `fade-in` 400ms | White, 20px, Signika Bold |
| 2 | `elapsed-timer` | x:87% y:32% right | `fade-in` 400ms 100ms delay | Light grey, 13px, tabular-nums |
| 3 | `subtitle` (scene name) | x:50% y:37% centre | `fade-in` 400ms 200ms delay | 50% white, 13px |
| 4 | `spinner` ring | x:50% y:45% centre | `spin` 800ms loop | Cyan/blue, 30px, 2.5px border |
| 5 | `stage-pills` | x:50% y:54% centre | `fade-in` 300ms 300ms delay | Pill badges, flex row |
| 6 | `text-block` (status msg) | x:50% y:62% centre | None (updated dynamically) | 70% white, 12.5px |
| 7 | `progress-bar` classic | x:50% y:68% centre | Glow pulse loop | Blue→purple gradient, 6px, 360px wide |
| 8 | `text-block` (percentage) | x:82% y:68% right | None | 55% white, 12px, tabular-nums |

**Content Panel**: Dark glass card (`rgba(10,10,14,0.7)`, `backdrop-filter: blur(14px)`, subtle border, drop shadow). Width `min(440px, calc(100vw - 40px))`.  
**Accent Color**: `rgba(0, 180, 255, 0.9)` (Map Shine blue)  
**Fonts**: Signika (Foundry default)

---

### Preset 1: **Dark Fantasy**

> Evokes Baldur's Gate, Dark Souls, high-fantasy RPG title screens. Rich, atmospheric, gold-accented.

**Wallpaper**: Dark fantasy art (ship a default — moody castle/landscape). `object-fit: cover`.  
**Wallpaper Effect**: `ken-burns` — slow 25s zoom from `scale(1)→scale(1.12)` with slight upward drift.  
**Overlay Effects**:
- **Vignette**: Heavy (`rgba(0,0,0,0.85)` edges)
- **Ember Particles**: 12 embers, warm orange `#ff6a00`, rising from bottom-centre region, slow (6-10s travel)
- **Fog Drift**: 2 layers, dark semi-transparent, very slow horizontal movement

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `image` (world logo/crest) | x:50% y:18% centre | `scale-in` 800ms `ease-out` | 120×120px, optional border glow |
| 2 | `title` (world name) | x:50% y:35% centre | `fade-in-up` 1000ms 300ms | Gold `#d4a847`, 36px, Cinzel (Google) or Modesto, **metallic shimmer** text effect |
| 3 | `text-block` (tagline) | x:50% y:42% centre | `fade-in-up` 800ms 600ms | Pale gold `rgba(212,168,71,0.6)`, 14px italic, max-width 500px |
| 4 | `scene-name` | x:50% y:82% centre | `fade-in` 600ms 800ms | White 70%, 16px, prefix "Entering: " |
| 5 | `progress-bar` rune-segment | x:50% y:88% centre | Segments glow as filled | 8 segments, gold fill `#d4a847`, dark track, 400px wide |
| 6 | `tips-rotator` | x:50% y:95% centre | `fade-in` per tip, 8s interval | Muted cream `rgba(255,245,220,0.5)`, 12px italic, max-width 600px |

**Content Panel**: None (elements float directly on wallpaper with text shadows for readability)  
**Accent Color**: `#d4a847` (antique gold)  
**Fonts**: Primary: `Cinzel` (Google). Body: `EB Garamond` (Google).  
**Text Shadows**: Heavy `0 2px 12px rgba(0,0,0,0.9)` on all text for wallpaper readability.

**Tips (default set)**:
- *"Steel your nerves. The darkness remembers."*
- *"Trust the light of your torch — but not too much."*
- *"A locked door is just an invitation to find another way."*
- *"The bard's song may save you where the sword cannot."*

---

### Preset 2: **Arcane Sanctum**

> Mystical, magical, ethereal. Glowing runes, floating particles, deep purple/blue palette. Think wizard's study.

**Wallpaper**: Dark purple/navy abstract or starfield. `object-fit: cover`.  
**Wallpaper Effect**: `slow-pan` — very slow horizontal drift over 40s, or `gradient-shift` cycling through deep blue → purple → indigo.  
**Overlay Effects**:
- **Magic Motes**: 8 glowing dots on curved CSS motion paths (`offset-path`), soft purple/cyan `#a78bfa` / `#67e8f9`, 10-18s orbit cycles
- **Twinkling Stars**: 30 tiny dots, white, staggered `opacity` pulse (0.1→0.7→0.1), 2-6s random durations
- **Smoke Wisps**: 3 large blurred circles, deep purple, very slow drift + opacity fade

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `title` (world name) | x:50% y:28% centre | `blur-in` 1200ms | White with **neon glow** effect (`#a78bfa` purple), 32px, `Cinzel Decorative` (Google) |
| 2 | `subtitle` "The veil thins..." | x:50% y:36% centre | `fade-in` 800ms 500ms | `rgba(167,139,250,0.6)`, 14px |
| 3 | `spinner` orbiting-rune | x:50% y:52% centre | Rune glyph on `offset-path` circular orbit, 3s | Purple `#a78bfa`, 40px orbit radius |
| 4 | `text-block` (status) | x:50% y:62% centre | `fade-in` 400ms | White 60%, 13px |
| 5 | `progress-bar` glow-bar | x:50% y:70% centre | Fill + `glow-pulse` on bar | Purple→cyan gradient, 4px thin, 350px, heavy `box-shadow` glow |
| 6 | `scene-name` | x:50% y:78% centre | `word-reveal` 600ms per word, 400ms stagger | White 80%, 18px |
| 7 | `tips-rotator` | x:50% y:92% centre | Crossfade 1s, 10s interval | Lavender `rgba(200,180,255,0.5)`, 12px |

**Content Panel**: None (floating elements with heavy glow/shadow)  
**Accent Color**: `#a78bfa` (soft purple)  
**Secondary Accent**: `#67e8f9` (cyan)  
**Fonts**: Primary: `Cinzel Decorative`. Body: `Cormorant Garamond` (Google).  

**Tips**:
- *"Magic is not power — it is understanding."*
- *"Every spell has a price. Choose wisely what you pay."*
- *"The stars do not lie, but neither do they speak plainly."*
- *"A familiar's loyalty is worth more than a king's army."*

---

### Preset 3: **Parchment & Ink**

> Old-world cartography, handwritten notes, warm sepia tones. Cozy tavern-meets-scholar's-desk.

**Wallpaper**: Parchment/old paper texture (ship a tileable parchment). `object-fit: cover`.  
**Wallpaper Effect**: `grain` — very subtle film grain, warm tone. Plus `desaturate-in` — starts slightly grey, warms to full colour over 3s.  
**Overlay Effects**:
- **Dust Motes**: 10 tiny dots, warm `rgba(180,160,120,0.3)`, very slow diagonal drift
- **Vignette**: Moderate, warm-toned `rgba(60,40,20,0.5)` edges

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `image` (ink splat or compass rose) | x:50% y:15% centre | `fade-in` 800ms + `breathe-scale` loop | 80×80px, sepia-toned decorative element |
| 2 | `title` (world name) | x:50% y:30% centre | `fade-in-up` 1000ms | Dark brown `#3e2723`, 34px, **emboss** text effect, `Pirata One` (Google) |
| 3 | `text-block` (subtitle) | x:50% y:38% centre | `typewriter` 2000ms 500ms delay | Dark sepia `#5d4037`, 14px, `Special Elite` (Google, typewriter font) |
| 4 | `image` (decorative rule/divider) | x:50% y:44% centre | `clip-reveal-center` 800ms 700ms | Thin ornamental line, ~300px wide |
| 5 | `scene-name` | x:50% y:52% centre | `fade-in` 600ms 900ms | Dark brown `#4e342e`, 18px italic |
| 6 | `progress-bar` classic | x:50% y:62% centre | Ink-coloured fill, no glow | Brown fill `#6d4c41` on cream track `rgba(0,0,0,0.08)`, 5px, 350px, rounded |
| 7 | `text-block` (percentage) | x:72% y:62% right | None | Sepia `#8d6e63`, 11px |
| 8 | `tips-rotator` | x:50% y:78% centre | `fade-in` per tip, 9s interval | Italic, muted brown `rgba(93,64,55,0.7)`, 13px, `Special Elite`, max-width 500px |
| 9 | `text-block` (footer quote) | x:50% y:92% centre | `fade-in` 600ms 1200ms | Very faint, small, `"Here be dragons..."` |

**Content Panel**: Subtle inner frame — `border: 1px solid rgba(0,0,0,0.1)` inset by 5%, no background (parchment IS the background)  
**Accent Color**: `#6d4c41` (warm brown)  
**Fonts**: Primary: `Pirata One`. Body: `Special Elite`. (Both Google.)  

**Tips**:
- *"The map is not the territory — but it's a good start."*
- *"Every tavern has a story. Most of them are true."*
- *"When in doubt, ask the barkeep. They know everything."*
- *"A well-placed coin speaks louder than a well-placed sword."*

---

### Preset 4: **Cyberpunk Terminal**

> Sci-fi hacker terminal. Monospace text, glitch effects, neon green or cyan on black, CRT scanlines.

**Wallpaper**: Solid black `#0a0a0a` (no image needed — the aesthetic IS the blackness).  
**Wallpaper Effect**: None (or optional: very faint circuit-board pattern background with `gradient-shift`).  
**Overlay Effects**:
- **Scanlines**: Visible (2px spacing, `rgba(0,255,100,0.03)` tint)
- **Film Grain**: Very subtle, fast cycling
- **Lightning Flash**: Very rare (every 20-30s), brief white flash at `opacity 0.05` (simulates screen glitch)

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `text-block` (system header) | x:5% y:5% top-left | `typewriter` 800ms | `> SYSTEM BOOT v4.2.1`, green `#00ff88`, 11px, `Fira Code` (Google) |
| 2 | `text-block` (init sequence) | x:5% y:9% top-left | `typewriter` 1200ms 800ms delay | `> Loading kernel modules...`, green 60%, 11px |
| 3 | `text-block` (init line 2) | x:5% y:12% top-left | `typewriter` 1000ms 2000ms delay | `> Establishing secure connection...`, green 60%, 11px |
| 4 | `title` (world name) | x:50% y:40% centre | `glitch-in` 600ms 2500ms delay | Bright cyan `#00ffff`, 42px, `Orbitron` (Google), **neon** text effect, **flicker-neon** loop |
| 5 | `subtitle` | x:50% y:50% centre | `fade-in` 400ms 3000ms | Green 50% `rgba(0,255,136,0.5)`, 14px, `Fira Code` |
| 6 | `progress-bar` thin-line | x:50% y:60% centre | Striped bar animation | Cyan `#00ffff` on dark track, 3px height, 500px wide, striped candy-bar pattern |
| 7 | `text-block` (percentage) | x:78% y:60% right | None | Cyan 70%, 12px, `Fira Code`, format: `[065/100]` |
| 8 | `scene-name` | x:50% y:68% centre | `typewriter` 800ms | Green `#00ff88`, 16px, prefix `> LOADING SECTOR: ` |
| 9 | `text-block` (footer) | x:5% y:95% bottom-left | `fade-in` 200ms 3500ms | Very dim green 20%, 10px, `MYTHICA MACHINA OS // UPLINK ACTIVE` |
| 10 | `elapsed-timer` | x:95% y:95% bottom-right | `fade-in` 200ms | Dim green 30%, 10px, `Fira Code`, format `T+{seconds}s` |

**Content Panel**: None (terminal text floats on black)  
**Accent Color**: `#00ffff` (cyan)  
**Secondary**: `#00ff88` (terminal green)  
**Fonts**: Primary: `Orbitron`. Body: `Fira Code`. (Both Google.)  

**Tips** (displayed as terminal messages):
- `> ADVISORY: Hostiles detected in sector 7-G. Proceed with caution.`
- `> REMINDER: Energy shields recharge 15% faster in low-gravity zones.`
- `> WARNING: Unauthorized access to restricted decks will trigger security protocols.`
- `> TIP: Your neural interface works best when you trust your crew.`

---

### Preset 5: **Cinematic Widescreen**

> Film premiere feel. Letterbox bars, dramatic oversized scene title, minimal UI, full-bleed wallpaper hero shot. The wallpaper IS the star.

**Wallpaper**: Full-bleed scene art or key art (user must supply). `object-fit: cover`.  
**Wallpaper Effect**: `ken-burns` — slow 30s zoom to `scale(1.08)` with very slight horizontal drift. Also `blur-reveal` — starts at `blur(6px)`, sharpens to `blur(0)` over 3s.  
**Overlay Effects**:
- **Vignette**: Moderate, cinematic `rgba(0,0,0,0.6)` edges
- **Grain**: Very subtle warm grain

**Layout Elements**:

| # | Element | Position | Animation | Description |
|---|---------|----------|-----------|-------------|
| 1 | `custom-html` (letterbox top) | x:0% y:0% top-left, full width | `clip-reveal-down` 800ms | Black bar, height `8vh`, css `background: #000` |
| 2 | `custom-html` (letterbox bottom) | x:0% y:92% bottom-left, full width | `clip-reveal-up` 800ms | Black bar, height `8vh`, css `background: #000` |
| 3 | `scene-name` | x:50% y:50% centre | `blur-in` 1500ms 500ms + `fade-in-up` | White, 48px, `Playfair Display` (Google), heavy `text-shadow`, **shadow-lift** effect |
| 4 | `subtitle` (chapter/act text) | x:50% y:58% centre | `fade-in-up` 800ms 1200ms | White 50%, 16px italic, `Playfair Display` |
| 5 | `progress-bar` thin-line | x:50% y:92.5% centre (on bottom letterbox) | No glow, simple fill | White 40% fill on white 10% track, 2px height, `80vw` wide |
| 6 | `text-block` (status) | x:50% y:4% centre (on top letterbox) | `fade-in` 300ms | White 30%, 11px, loading message |
| 7 | `image` (small logo) | x:95% y:4% top-right | `fade-in` 600ms 400ms | 24px height, module/world logo watermark, opacity 0.3 |

**Content Panel**: None (elements on wallpaper + letterbox bars)  
**Accent Color**: `#ffffff` (pure white — the wallpaper provides all colour)  
**Fonts**: Primary: `Playfair Display` (Google). Body: system sans-serif.  
**Key Design Principle**: The wallpaper is the centrepiece. UI is deliberately minimal — just a thin white line for progress, the scene name as a hero title, and letterbox bars for cinema framing.

**Tips**: None by default (tips would clutter the cinematic feel). Can be enabled if desired.

---

### 15.1 Preset Comparison Matrix

| Feature | Default | Dark Fantasy | Arcane Sanctum | Parchment & Ink | Cyberpunk Terminal | Cinematic |
|---------|---------|-------------|----------------|-----------------|-------------------|-----------|
| **Wallpaper** | None (black) | Dark art | Starfield/abstract | Parchment texture | Black | Hero scene art |
| **Ken Burns** | No | Yes | No | No | No | Yes |
| **Particles** | No | Embers + fog | Magic motes + stars | Dust motes | No | No |
| **Scanlines** | No | No | No | No | Yes | No |
| **Vignette** | No | Heavy | No | Moderate warm | No | Moderate |
| **Grain** | No | No | No | Yes | Yes | Yes (subtle) |
| **Content Panel** | Glass card | None | None | Subtle frame | None | None |
| **Progress Style** | Gradient bar | Rune segments | Glow bar | Classic bar | Thin striped | Thin line |
| **Spinner** | Ring | None | Orbiting rune | None | None | None |
| **Text Effect** | None | Metallic shimmer | Neon glow | Emboss | Neon + typewriter | Shadow lift + blur |
| **Entrance** | Simple fade | Fade-up | Blur-in | Typewriter | Glitch + typewriter | Blur-in |
| **Font Vibe** | System (Signika) | Serif (Cinzel) | Decorative (Cinzel Dec.) | Handwritten (Pirata) | Monospace (Fira Code) | Elegant (Playfair) |
| **Mood** | Clean/functional | Epic/atmospheric | Mystical/ethereal | Warm/scholarly | Techy/edgy | Dramatic/filmic |
| **UI Density** | High (many elements) | Medium | Medium | Medium-high | High (terminal lines) | Very low |
| **Best For** | Debug/dev | Fantasy campaigns | Magic-heavy worlds | Historical/low-magic | Sci-fi/modern | Any (wallpaper-driven) |

### 15.2 Default Wallpapers to Ship

We should ship a small set of royalty-free wallpapers in `assets/loading/` so presets work out of the box:

| File | Used By | Description |
|------|---------|-------------|
| `assets/loading/dark-castle.webp` | Dark Fantasy | Moody castle silhouette, dark sky |
| `assets/loading/starfield.webp` | Arcane Sanctum | Deep blue/purple starfield |
| `assets/loading/parchment.webp` | Parchment & Ink | Tileable aged paper texture |
| `assets/loading/placeholder-scene.webp` | Cinematic | Generic landscape (user should replace) |

These should be compressed WebP, ~200-400KB each, 1920×1080 minimum resolution.

### 15.3 Stagger Timing Strategy

A key detail that makes loading screens feel **polished** rather than **jarring** is staggered entrance timing. Every preset above has intentional delays between element entrances. The general pattern:

```
0ms     — Wallpaper appears (instant or blur-reveal)
200ms   — Primary branding (logo, world crest)
500ms   — Title text
800ms   — Subtitle / tagline
1000ms  — Progress bar + status
1200ms  — Secondary elements (tips, scene name, timer)
```

Each element's delay is 200-400ms after the previous one. This creates a cascade effect that feels intentional and smooth, rather than everything popping in at once.

The composer should expose per-element delay as a simple number field, but presets set sensible defaults.
