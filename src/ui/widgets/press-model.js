/**
 * ui/widgets/press-model.js — what happens when something is pressed, hovered or
 * focused, as a stylesheet fragment any widget or room can use: the part of
 * `rooms/room-style.js` that has to work WITHOUT a room around it.
 *
 * It lives in `widgets/` because the scale strip — a standalone widget a room hangs
 * off its edge — needs exactly the same behaviour as every room's buttons, and a
 * widget reaching up into a room's stylesheet module is the wrong way round. The
 * rooms' kit imports it from here.
 *
 * Why every line is there (the Foundry global-CSS bleed it wins back, and the motion
 * rules it follows) is at the top of `rooms/room-style.js`.
 *
 * @module ui/widgets/press-model
 */

/** The at-rule every hover rule lives inside — hover only where hover exists. */
export const HOVER_GATE = '@media (hover:hover) and (pointer:fine)';

/**
 * THE PRESS MODEL, for any list of complete selectors: one reset (winning back
 * Foundry's button box and 0.5s transition), one keyboard focus ring (never a
 * mouse-click glow), one press response, one disabled look.
 * @param {string[]} selectors - complete selectors, e.g. `['#room .btn', '.strip button']`.
 * @returns {string}
 */
export function pressModelCss(selectors) {
  const press = (pseudo) => selectors.map((sel) => `${sel}${pseudo}`).join(', ');
  return `/* ---- the press model: every pressable thing, one reset ------------------- */
${press('')}{
  /* height:auto — Foundry's button rule is \`height:2em\`, i.e. twice THIS
     button's own font-size, which is a different height for every size of text
     we put in one. Components that need a fixed size set their own below. */
  box-sizing:border-box; height:auto; min-height:0; margin:0; font:inherit; line-height:1.2;
  letter-spacing:normal; text-transform:none; text-decoration:none; text-shadow:none;
  box-shadow:none; outline:none; cursor:pointer; pointer-events:auto; user-select:none;
  -webkit-tap-highlight-color:transparent; touch-action:manipulation;
  transition:transform 160ms var(--ease-out), background-color 120ms ease, border-color 120ms ease,
    color 120ms ease, opacity 120ms ease}
${press(':focus-visible')}{outline:2px solid var(--shine); outline-offset:2px}
${press(':active:not(:disabled)')}{transform:scale(.97)}
${press(':disabled')}{cursor:default; opacity:.45}`;
}
