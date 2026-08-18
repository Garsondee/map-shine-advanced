/**
 * Widget Gallery — U0's own exit gate (docs/holy/UI-Testament.md §9: "a
 * standalone widget-gallery harness renders every widget in all 4 themes").
 * Imports the REAL src/ui/ widget canon directly (shader-lab's own precedent
 * — lab.js reaches into src/effects/specular/specular.js the same way) and
 * mounts real `buildParamControl` calls against representative param
 * declarations, so what the author sees here is the ACTUAL renderer, not a
 * mockup of it. Served by tools/shader-lab/serve.mjs, which already serves
 * the whole repo root — no second dev server.
 *
 * Run: node tools/shader-lab/serve.mjs, then open
 * http://localhost:8934/tools/widget-gallery/index.html
 */
import { installTokens, THEMES } from '../../src/ui/tokens.js';
import { installIconSprite, ICONS, iconMarkup } from '../../src/ui/widgets/icon-sprite.js';
import { buildParamControl, buildInheritableRangeRow } from '../../src/ui/widgets/param-control.js';

installTokens();
installIconSprite();
document.body.style.background = 'var(--bg0)';
document.body.style.color = 'var(--ink0)';

// ---- theme switcher --------------------------------------------------------
const themeBar = document.getElementById('themeButtons');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const btn of themeBar.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme));
  }
}
for (const theme of THEMES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.theme = theme;
  btn.textContent = theme;
  btn.addEventListener('click', () => setTheme(theme));
  themeBar.appendChild(btn);
}
setTheme(THEMES[0]);

// ---- one representative declaration per param type -------------------------
// A live in-memory store + onChange, so dragging a control actually moves a
// value and the next control to read it sees the update — proving the
// widgets are functionally real, not just visually present.
const state = {
  opacity: 0.62,
  ripples: 5,
  enabled: true,
  tint: '#4aa8ff',
  blend: 'add',
  flowDirection: 135,
  override: 0.4,
  overrideActive: false,
};

const DECLS = {
  opacity: { type: 'float', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Opacity', help: 'A float param.' },
  ripples: { type: 'int', min: 0, max: 20, step: 1, default: 5, label: 'Ripples', help: 'An int param.' },
  enabled: { type: 'bool', default: true, label: 'Enabled', help: 'A bool param.' },
  tint: { type: 'color', space: 'srgb', default: '#ffaa00', label: 'Tint', help: 'A colour param.' },
  blend: {
    type: 'enum',
    values: ['add', 'screen', 'multiply'],
    default: 'add',
    label: 'Blend mode',
    help: 'An enum param.',
  },
  flowDirection: {
    type: 'angle',
    default: 180,
    label: 'Flow direction',
    help: "An angle param — water's own compass dial.",
  },
};

const widgetsHost = document.getElementById('widgetsHost');
for (const [id, decl] of Object.entries(DECLS)) {
  widgetsHost.appendChild(
    buildParamControl(id, decl, {
      value: state[id],
      onChange: (v) => {
        state[id] = v;
        console.log(`[gallery] ${id} ->`, v);
      },
    })
  );
}

// ---- status:'planned' — the control-readiness convention (U0) -------------
const plannedHost = document.getElementById('plannedHost');
const PLANNED_DECL = {
  type: 'float',
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.5,
  label: 'Sway amount',
  help: 'How far this tile swings.',
  status: 'planned',
  plannedReason: 'Motion Tiles has no src/ runtime yet (V2-only) — this chrome is real, the wiring is not.',
};
plannedHost.appendChild(
  buildParamControl('sway', PLANNED_DECL, { value: 0.5, onChange: (v) => console.log('[gallery] sway ->', v) })
);
const plannedNote = document.createElement('p');
plannedNote.style.cssText = 'font-size:11px; opacity:.7; margin-top:8px';
plannedNote.textContent = 'Dashed --fail edge + ◇ glyph + tooltip. Still fully interactive — never disabled.';
plannedHost.appendChild(plannedNote);

// ---- buildInheritableRangeRow — the shared-default/per-instance override --
const inheritHost = document.getElementById('inheritHost');
function paintInherit() {
  inheritHost.querySelector('.inheritRow')?.remove();
  const row = buildInheritableRangeRow({
    label: 'Size',
    help: 'Per-instance override of the shared default.',
    min: 0,
    max: 1,
    step: 0.01,
    effectiveValue: state.overrideActive ? state.override : 0.5,
    isOverridden: state.overrideActive,
    onDrag: (v) => {
      state.override = v;
      state.overrideActive = true;
      paintInherit();
    },
    onResetToShared: () => {
      state.overrideActive = false;
      paintInherit();
    },
  });
  row.classList.add('inheritRow');
  inheritHost.appendChild(row);
}
paintInherit();

// ---- the icon sprite --------------------------------------------------------
// `.ico` (size + fill:none/stroke:currentColor) comes from tokens.js's own
// base CSS now — no per-usage override needed, which is the whole point of a
// shared class over one-off inline styles.
const iconsHost = document.getElementById('icons');
for (const name of Object.keys(ICONS)) {
  const cell = document.createElement('div');
  cell.className = 'iconCell';
  cell.innerHTML = `${iconMarkup(name)}<span>${name}</span>`;
  iconsHost.appendChild(cell);
}
