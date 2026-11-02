/**
 * Node verification for foundry/shared-vision.js — the pure half (`sharesVisionWith`)
 * plus the install wrapper driven against a fake Token class and fake globals.
 */
import { sharesVisionWith, installSharedVision } from '../shared-vision.js';

export function run(t) {
  const { ok } = t;

  // ---- pure rule ------------------------------------------------------
  ok(
    'player: an owned token is a source even when another is selected',
    sharesVisionWith({ isGM: false, ownedByViewer: true, tokenOwnerIds: [], controlledOwnerIds: [] }) === true
  );
  ok(
    'player: a token they do not own is not',
    sharesVisionWith({ isGM: false, ownedByViewer: false, tokenOwnerIds: ['u1'], controlledOwnerIds: ['u1'] }) === false
  );
  ok(
    'GM: a token sharing an owner with the selected token is a source',
    sharesVisionWith({ isGM: true, ownedByViewer: true, tokenOwnerIds: ['u1'], controlledOwnerIds: ['u1'] }) === true
  );
  ok(
    'GM: a token of a different player is not',
    sharesVisionWith({ isGM: true, ownedByViewer: true, tokenOwnerIds: ['u2'], controlledOwnerIds: ['u1'] }) === false
  );
  ok(
    'GM: selecting an NPC (no player owners) adds nothing',
    sharesVisionWith({ isGM: true, ownedByViewer: true, tokenOwnerIds: ['u1'], controlledOwnerIds: [] }) === false
  );

  // ---- the wrapper, against fakes --------------------------------------
  const saved = { CONFIG: globalThis.CONFIG, canvas: globalThis.canvas, game: globalThis.game };
  try {
    const users = [
      { id: 'gm', isGM: true },
      { id: 'u1', isGM: false },
      { id: 'u2', isGM: false },
    ];
    const owned = (owners) => ({
      testUserPermission: (u) => u.isGM || owners.includes(u.id),
    });
    class FakeToken {
      constructor(owners, { sight = true, controlled = false, hidden = false } = {}) {
        this.hasSight = sight;
        this.controlled = controlled;
        this.layer = FakeToken.layer;
        this.document = { level: 'L1', hidden, ...owned(owners) };
      }
      _isVisionSource() {
        return this.controlled; // core's relevant behaviour for a GM
      }
    }
    FakeToken.layer = { controlled: [] };
    globalThis.CONFIG = { Token: { objectClass: FakeToken } };
    globalThis.canvas = { visibility: { tokenVision: true }, level: { id: 'L1' } };
    globalThis.game = { users, user: users[0] };

    const status = installSharedVision();
    ok('installs', status.installed === true);
    ok('install is idempotent', installSharedVision().reason === 'already installed');

    const a = new FakeToken(['u1'], { controlled: true });
    const b = new FakeToken(['u1']);
    const c = new FakeToken(['u2']);
    const blind = new FakeToken(['u1'], { sight: false });
    FakeToken.layer.controlled = [a];
    ok('GM: the selected token stays a source', a._isVisionSource() === true);
    ok('GM: the same player\'s other token joins', b._isVisionSource() === true);
    ok('GM: another player\'s token does not', c._isVisionSource() === false);
    ok('GM: a token without sight never does', blind._isVisionSource() === false);

    FakeToken.layer.controlled = [];
    ok('GM: nothing selected -> nothing shared', b._isVisionSource() === false);

    globalThis.game = { users, user: users[1] };
    ok('player: owned token with sight is a source with nothing selected', b._isVisionSource() === true);
    ok('player: a token they do not own is not', c._isVisionSource() === false);
    const hiddenOwn = new FakeToken(['u1'], { hidden: true });
    ok('player: a hidden token never is', hiddenOwn._isVisionSource() === false);
    canvas.level = { id: 'L2' };
    ok('player: a token on another level never is', b._isVisionSource() === false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}
