/**
 * SHADER LAB — THE ONE VIEWING PANEL.
 *
 * Author, twice, 2026-08-02: *"A single view which takes up the entire width of
 * the browser. All controls under that. Use only a single display for
 * everything"* — then, when the first attempt still left the legacy canvas
 * stacked above the live one: *"I asked for just a single viewing panel in the
 * Shader Lab. I meant it. Why do I have to scroll down to see the window this
 * is running in? One main viewing window, even for this stuff at the top."*
 *
 * ============================================================================
 * WHY THIS FILE EXISTS RATHER THAN MORE PER-BENCH TOGGLING
 * ============================================================================
 * Every `*-lab.js` already toggles its own CONTROL panel on `#effect` change,
 * and each also toggled its own view container — but "hide the containers that
 * belong to OTHER benches" was nobody's job, and the legacy `#view`/`#profile`
 * pair (owned by `lab.js`, which no bench wants to edit) had no container at
 * all. The result was N-1 dead views stacked above the live one.
 *
 * Adding "…and also hide sunLeft" to seven separate files would be the same
 * bug waiting to happen the moment an eighth bench lands. So the VIEW column
 * gets exactly one owner — this file — while each bench keeps owning its own
 * CONTROLS. Loaded LAST in `index.html` so it runs after every bench has
 * registered its own listener, and its answer is the one that sticks.
 *
 * ⚠️ A NEW BENCH MUST ADD ITS CONTAINER TO {@link VIEW_BY_EFFECT}. If it does
 * not, its view simply never shows — which is a loud, immediate failure the
 * first time you select it, and deliberately preferred over a silent default
 * that would quietly resurrect the stacked-views bug this file exists to kill.
 *
 * @module tools/shader-lab/view-visibility
 */

/**
 * `#effect` value → the ONE view container that should be visible for it.
 *
 * `specular` maps to `sunLeft`: `bench-specular.js` renders into the `#view`
 * canvas there (it has no canvas of its own) — a leftover name from when that
 * container's original owner was the march/smear prototyping bench, retired
 * 2026-08-02 with the models it prototyped. Kept because `bench-specular.js`
 * still genuinely uses the container; not a fact about specular's own model.
 */
const VIEW_BY_EFFECT = Object.freeze({
  specular: 'sunLeft',
  lightning: 'lightningLeft',
  fixture: 'fixtureLeft',
  derive: 'deriveLeft',
  composite: 'compositeLeft',
  blend: 'blendLeft',
  'sun-shadow': 'sunShadowLeft',
  'floor-lighting': 'floorLightLeft',
  'aperture-gobo': 'apertureGoboLeft',
});

const ALL_CONTAINERS = [...new Set(Object.values(VIEW_BY_EFFECT))];

function applyViewVisibility(effectValue) {
  const wanted = VIEW_BY_EFFECT[effectValue] ?? null;
  for (const id of ALL_CONTAINERS) {
    const el = document.getElementById(id);
    if (el) el.style.display = id === wanted ? '' : 'none';
  }
  if (!wanted) {
    console.warn(
      `[view-visibility] no view container mapped for effect '${effectValue}' — ` +
        'add it to VIEW_BY_EFFECT in view-visibility.js'
    );
  }
}

const effectSelect = document.getElementById('effect');
effectSelect?.addEventListener('change', (e) => applyViewVisibility(e.target.value));
applyViewVisibility(effectSelect?.value ?? 'sun-shadow');
