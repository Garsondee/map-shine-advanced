/**
 * ui/rooms/system-panel.js — THE SYSTEM PANEL (U5, docs/holy/UI-Testament.md
 * §5.5): ONE generated component tree, rendered twice — once inside the
 * Studio's own SYSTEM department (GM view, the world-default section too),
 * once inside the standalone Player room (client scope only). "Permission is
 * a filter, not a fork" (`diag/settings-panel.js`'s own doctrine, upheld here
 * against the LANTERN widget canon instead of that file's hand-rolled DOM) —
 * `ctx.isGM()` decides whether the GM-only section renders at all, never a
 * second layout.
 *
 * Reuses the REAL, already-shipped, already-tested settings plumbing
 * verbatim — `effects/effect-settings.js`'s key conventions and
 * `effects/effect-cascade.js`'s resolution order are untouched by this file;
 * boot.js supplies already-derived plain data as `ctx` (`profiles`,
 * `enableChoices`, `effectRows`, `keys`), the identical "boot is the
 * composition root, this file imports nothing from effects/" rule
 * `diag/settings-panel.js`'s own header states and this file upholds for the
 * same reason. `isEffectLocked`/`describeEffectRows` are duplicated here in
 * miniature rather than imported from `diag/` — `ui/` has no door into
 * `diag/` anywhere in this codebase (checked, not assumed), and the two
 * functions are a dozen lines combined.
 *
 * ⚠️ PLAYER-LIGHT ALLOWANCES ARE NOT HERE. §5.5's own line assumes a
 * rendering effect that does not exist anywhere in this engine yet —
 * confirmed by grepping every plausible name (`PlayerLightEffect`,
 * `playerLightMode`, `playerLightAllowance`) across `src/` and finding
 * nothing outside `legacy/` (5,029 lines of V2 GLSL, never rebuilt) and one
 * forward-looking `absorbs:` list entry on an unrelated ambient-lighting
 * pass. Building it is a genuine, separate rendering feature, not a UI port
 * — named for the author's own call, matching U4's own precedent for its
 * missing render path (see Petition P17).
 *
 * ⚠️ THE PER-EFFECT TOGGLE IS NOT "BOUNDED BY THE GM."
 * `effect-cascade.js#resolveEffectEnabled`'s own comment says outright:
 * "Player (client) override — final say, subject only to a11y below." A
 * player's own On/Off wins over a GM's table default in EITHER direction —
 * deliberate, documented, shipped, exercised by seven existing test files.
 * This panel's own help text says exactly that, not the Testament's looser
 * "within GM bounds" phrasing (see Petition P17) — a control must never
 * describe itself as doing something the code underneath it doesn't do.
 *
 * @module ui/rooms/system-panel
 */

import { buildParamControl } from '../widgets/param-control.js';

/** Same shape as `diag/settings-panel.js#isEffectLocked` — see this file's
 * own header for why it's a separate copy, not a shared import. */
function isEffectLocked(row, reducePhotosensitive) {
  return row?.photosensitive === true && reducePhotosensitive === true;
}

function describeEffectRows(effectRows, reducePhotosensitive) {
  const list = Array.isArray(effectRows) ? effectRows : [];
  return list.map((r) => ({
    id: r?.id,
    title: r?.title ?? r?.id ?? '?',
    photosensitive: r?.photosensitive === true,
    playerKey: r?.playerKey,
    gmKey: r?.gmKey,
    locked: isEffectLocked(r, reducePhotosensitive),
  }));
}

function sectionHead(text) {
  const h = document.createElement('div');
  h.textContent = text;
  Object.assign(h.style, {
    fontSize: '.64rem',
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    color: 'var(--ink2)',
    marginTop: '6px',
  });
  return h;
}

function enumDecl({ values, label, help }) {
  return {
    type: 'enum',
    values: values.map((v) => v.value),
    valueLabels: Object.fromEntries(values.map((v) => [v.value, v.label])),
    label,
    help,
  };
}

/**
 * Disable an already-built enum row's own `<select>` — a genuine, functional
 * lock (not `status:'planned'`, which the widget canon deliberately leaves
 * fully interactive; see `param-control.js#decorateAsPlanned`'s own doc for
 * why that would be the wrong tool here). A locked row exists because the
 * cascade's own a11y hard override would silently win anyway — showing a
 * live, draggable control for a value that can't actually take effect would
 * be the exact "instrument that lies" shape this project has named before.
 * @param {HTMLElement} rowEl @param {string} reason
 */
function lockRow(rowEl, reason) {
  const select = rowEl.querySelector('select');
  if (select) select.disabled = true;
  rowEl.style.opacity = '0.5';
  rowEl.title = reason;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   isGM: () => boolean,
 *   read: (key: string) => unknown,
 *   write: (key: string, value: unknown) => void,
 *   profiles: Array<{value:string,label:string}>,
 *   renderScaleChoices?: Array<{value:string,label:string}> - Auto + every SCALE_LADDER rung; omitted renders no row.
 *   enableChoices: Array<{value:string,label:string}>,
 *   effectRows: Array<{id:string,title:string,photosensitive?:boolean,playerKey:string,gmKey:string}>,
 *   keys: {msaEnabled:string, profile:string, renderScale?:string, reducePhotosensitive:string, reducedMotion:string, theme:string},
 * }} ctx
 * @returns {string} a short subtitle.
 */
export function renderSystemPanel(container, ctx) {
  const { isGM, read, write, profiles, enableChoices, effectRows, keys } = ctx;

  // Rebuilds the WHOLE tree on any change — the same "no captured readout"
  // discipline every other department already uses, and the only correct
  // choice here specifically: changing "reduce photosensitive" must repaint
  // every per-effect row's own LOCK state, not just the toggle that changed.
  // No externally-injected `ctx.refresh` — this file owns its own re-render
  // loop, matching cues-department.js/weather-board.js's own local pattern.
  function render() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '9px', maxWidth: '520px' });

    const put = (id, decl, value, onChange) =>
      wrap.append(
        buildParamControl(id, decl, {
          value,
          onChange: (v) => {
            onChange(v);
            render();
          },
        })
      );

    // 1. THE MASTER OFF-SWITCH — highest, most prominent (settings-panel.js's
    // own directive, upheld: "a player whose hardware can't run MSA has an
    // obvious way out").
    put(
      'msaEnabled',
      {
        type: 'bool',
        label: 'Map Shine Advanced',
        help: "Turn off to use Foundry's own renderer instead — useful if this isn't working well on your device. Requires a reload to apply.",
      },
      read(keys.msaEnabled) !== false,
      (v) => write(keys.msaEnabled, v)
    );

    // 2. GRAPHICS QUALITY.
    put(
      'profile',
      enumDecl({
        values: profiles,
        label: 'Graphics quality',
        help: 'Overall visual quality for your machine. Individual effects can still be toggled below.',
      }),
      read(keys.profile),
      (v) => write(keys.profile, v)
    );

    // 2b. RENDER RESOLUTION (UI parity plan, phase 2) — same position as the
    // old panel's own equivalent row (diag/settings-panel.js, right after
    // Graphics Quality, before Accessibility: "both are 'how much GPU does
    // this cost me' knobs"). ctx.renderScaleChoices/ctx.keys.renderScale are
    // already threaded through by boot.js's getSystemPanelCtx() — this row
    // was the only missing piece.
    if (ctx.renderScaleChoices && keys.renderScale) {
      put(
        'renderScale',
        enumDecl({
          values: ctx.renderScaleChoices,
          label: 'Render Resolution',
          help: "Auto automatically balances sharpness against your frame rate — it can never be pushed above a safe ceiling, regardless of your display or Foundry's own resolution setting. A fixed value locks the resolution and turns automatic adjustment off.",
        }),
        read(keys.renderScale) ?? 'auto',
        (v) => write(keys.renderScale, v)
      );
    }

    // 3. ACCESSIBILITY.
    wrap.append(sectionHead('Accessibility'));
    const reducePhotosensitive = read(keys.reducePhotosensitive) === true;
    put(
      'reducePhotosensitive',
      {
        type: 'bool',
        label: 'Reduce photosensitive effects',
        help: 'Turns off flashing / animated-light effects. Wins over every effect toggle below, even a GM forcing one on.',
      },
      reducePhotosensitive,
      (v) => write(keys.reducePhotosensitive, v)
    );
    put(
      'reducedMotion',
      {
        type: 'bool',
        label: 'Reduced motion',
        help: "Turns off panel/UI transitions and sweeps (not the map's own effects — this is about the interface, not the scene).",
      },
      read(keys.reducedMotion) === true,
      (v) => write(keys.reducedMotion, v)
    );
    put(
      'theme',
      enumDecl({
        values: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'hc', label: 'High contrast' },
          { value: 'soft', label: 'Soft' },
        ],
        label: 'Theme',
        help: 'The look of these panels.',
      }),
      read(keys.theme) || 'dark',
      (v) => write(keys.theme, v)
    );

    // 4. PER-EFFECT TOGGLES — my own setting, client-scoped, final say (see
    // this file's own header on why the help text says exactly that).
    wrap.append(sectionHead('Effects'));
    const rows = describeEffectRows(effectRows, reducePhotosensitive);
    for (const r of rows) {
      const value = r.locked ? 'off' : (read(r.playerKey) ?? 'auto');
      const before = wrap.childElementCount;
      put(
        `${r.id}.player`,
        enumDecl({
          values: enableChoices,
          label: r.title,
          help: 'Auto = follow the table default / graphics profile. On/Off is your final say — except "reduce photosensitive effects" above can still force it off.',
        }),
        value,
        (v) => write(r.playerKey, v)
      );
      if (r.locked) lockRow(wrap.children[before], 'Locked off by "reduce photosensitive effects" above.');
    }

    // 5. GM-ONLY: table defaults. Same rows, the WORLD key instead — a second
    // section, never a second layout (§5.5's own "one generated surface, two
    // renderings" upheld literally, not just in spirit).
    if (isGM()) {
      wrap.append(sectionHead('Table Defaults (GM)'));
      for (const r of rows) {
        put(
          `${r.id}.gm`,
          enumDecl({
            values: enableChoices,
            label: r.title,
            help: 'Sets the default for every player at this table. Each player can still override this for themselves above.',
          }),
          read(r.gmKey) ?? 'auto',
          (v) => write(r.gmKey, v)
        );
      }
    }

    container.innerHTML = '';
    container.append(wrap);
    return isGM()
      ? "profile, per-effect enables, and this table's own defaults"
      : 'performance & graphics — the only room you need';
  }

  return render();
}
