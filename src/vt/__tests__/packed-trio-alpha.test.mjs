/**
 * THE PACKED TRIO'S ALPHA SLOT, pinned.
 *
 * Three separately-painted mask files composite into ONE RGBA page, so exactly
 * one of them can keep its transparency. For as long as packing existed the
 * packer wrote `out[a] = rPix[a]` under the comment *"shared structural-hole
 * alpha (identical across the trio by design)"* — an invariant that is genuinely
 * true of `tools/make-torture-world.mjs`'s synthetic masks (its `fillHoleAlpha`
 * paints the same hole into all three) and false of every hand-painted map.
 *
 * The cost, measured live on the author's Town River Bridge map (2026-08-02):
 * `_Outdoors` is the G channel, so its own alpha never survived packing. The
 * mask authority composites `_Outdoors` sources BY ALPHA — the author's ruling
 * is *"transparent means unpainted... transparent also means not inside a
 * building"* — and, handed `_Shadow`'s alpha instead, wrote a colour byte for
 * every texel inside each source's rectangle. A transparent texel's byte is 0,
 * which for `_Outdoors` reads as INDOORS. `Tower_Bridge_Middle_Overhead_
 * Outdoors.webp` is 98.1% transparent with ZERO opaque-dark pixels and it was
 * blackening the map: the floor's wall channel measured 73.8% covered live
 * against 14.4% in the bench off the same file.
 *
 * The rule now: the alpha slot belongs to the ONE trio member the authority
 * rasterizes; the other two resolve against their own `absentValue` at pack
 * time, while their alpha still exists.
 */
import { compositePackedTexels, LEGACY_PACK_CHANNEL_POLICY, PACK_RECIPE_VERSION } from '../decode-pool.js';
import { packedTrioChannelPolicy, packedTrioKinds, assembleLayerDescriptors } from '../../scene/mask-catalog.js';

/** One texel's worth of RGBA source bytes. */
const px = (value, alpha) => new Uint8ClampedArray([value, value, value, alpha]);

export function run(t) {
  const { ok } = t;

  // ── THE CATALOG NAMES THE OWNER, AND IT IS THE RASTERIZED KIND ───────
  {
    const trio = packedTrioKinds();
    const policy = packedTrioChannelPolicy();
    ok('the catalog declares a packed trio', !!trio);
    ok('and a channel policy for it', !!policy);
    // ⚠️ THE OWNER IS DECLARED, NOT INFERRED (2026-08-08). This used to assert
    // `rasterize === true`, which was the SELECTION RULE as well as the check —
    // and that rule silently returned no policy at all the moment a second trio
    // member needed a derived grid. `fire` did: it reads the per-floor grid to
    // extract fire sources from the painted region, while wanting nothing to do
    // with the alpha slot (its `absentValue: 0` already says "transparent is
    // not fire"). Two questions, now two flags.
    ok(
      `the alpha slot goes to the DECLARED owner (${policy.alphaOwner} = ${trio[policy.alphaOwner].id})`,
      trio[policy.alphaOwner].ownsPackedAlpha === true
    );
    ok(
      'exactly one trio member claims the alpha slot',
      ['r', 'g', 'b'].filter((ch) => trio[ch].ownsPackedAlpha === true).length === 1
    );
    // The bug this whole file exists for: a member may need a derived grid
    // WITHOUT owning transparency. If those two ever collapse back into one
    // flag, this fails.
    ok(
      'a member can be rasterized without owning the alpha slot',
      ['r', 'g', 'b'].some((ch) => trio[ch].rasterize === true && trio[ch].ownsPackedAlpha !== true)
    );
    // THE regression guard: `r` is what it used to be hardcoded to, and `r` is
    // NOT the kind that needs it. If someone re-hardcodes it this fails.
    ok(
      `the owner is NOT simply 'r' — that hardcoding is the bug (owner is '${policy.alphaOwner}')`,
      policy.alphaOwner !== 'r' || trio.r.rasterize === true
    );
    ok('the owner declares no absent byte — its consumer resolves it', policy.absentByte[policy.alphaOwner] === null);
    for (const ch of ['r', 'g', 'b']) {
      if (ch === policy.alphaOwner) continue;
      const expected = Math.round(trio[ch].absentValue * 255);
      ok(
        `channel ${ch} (${trio[ch].id}) resolves transparency to its own absentValue ${trio[ch].absentValue} = ${expected}`,
        policy.absentByte[ch] === expected
      );
    }
  }

  // ── THE POLICY TRAVELS WITH THE URLS ─────────────────────────────────
  // A consumer must not be able to acquire the pack without the rule for
  // taking it back apart — that separation is how the wrong alpha survived.
  {
    const trio = packedTrioKinds();
    const descriptors = assembleLayerDescriptors({
      [trio.r.id]: 'r.webp',
      [trio.g.id]: 'g.webp',
      [trio.b.id]: 'b.webp',
    });
    const packed = descriptors.find((d) => d.channelUrls);
    ok('assembleLayerDescriptors emits a packed descriptor when all three are found', !!packed);
    ok('and the channel policy rides on it, not somewhere a caller must remember', !!packed.channelPolicy);
    ok(
      'with the same owner the catalog computes',
      packed.channelPolicy.alphaOwner === packedTrioChannelPolicy().alphaOwner
    );
  }

  // ── THE COMPOSITE ITSELF ─────────────────────────────────────────────
  {
    const policy = { alphaOwner: 'g', absentByte: { r: 255, g: null, b: 0 } };
    const out = new Uint8ClampedArray(4);

    // A texel the OUTDOORS author left transparent (g alpha 0), where the
    // SHADOW author painted solid (r alpha 255). This is the exact texel that
    // used to come out claiming "indoors, fully opaque".
    compositePackedTexels(out, px(200, 255), px(0, 0), px(0, 0), policy);
    ok(`an outdoors-transparent texel now reports alpha 0 even where shadow is opaque (got a=${out[3]})`, out[3] === 0);
    ok('and it keeps its raw byte — the owner is never pre-resolved', out[1] === 0);

    // The same texel under the OLD rule, to show the test is measuring the
    // thing that changed and not a tautology.
    const legacy = new Uint8ClampedArray(4);
    compositePackedTexels(legacy, px(200, 255), px(0, 0), px(0, 0), LEGACY_PACK_CHANNEL_POLICY);
    ok(
      `the legacy rule reported that same texel as fully opaque (a=${legacy[3]}) — the bug, pinned`,
      legacy[3] === 255
    );

    // A NON-owner's transparency resolves to its own absent value, so nothing
    // downstream needs an alpha it cannot have.
    const resolved = new Uint8ClampedArray(4);
    compositePackedTexels(resolved, px(0, 0), px(255, 255), px(0, 0), policy);
    ok(`a transparent r (absent 255) resolves to 255, not to its 0 byte (got ${resolved[0]})`, resolved[0] === 255);
    ok('a transparent b (absent 0) resolves to 0', resolved[2] === 0);

    // Half-transparent: a straight source-over toward the absent value.
    const half = new Uint8ClampedArray(4);
    compositePackedTexels(half, px(0, 128), px(10, 255), px(200, 128), policy);
    ok(`a half-transparent r blends toward its absent value (got ${half[0]}, want ~128)`, Math.abs(half[0] - 128) <= 1);
    ok(`a half-transparent b blends toward 0 (got ${half[2]}, want ~100)`, Math.abs(half[2] - 100) <= 1);

    // Opaque everywhere: byte-for-byte the old behaviour, so a genuinely
    // opaque mask (the entirely-black `_Outdoors` an underground scene is
    // authored with) is provably untouched by this change.
    const opaque = new Uint8ClampedArray(4);
    const opaqueLegacy = new Uint8ClampedArray(4);
    compositePackedTexels(opaque, px(11, 255), px(22, 255), px(33, 255), policy);
    compositePackedTexels(opaqueLegacy, px(11, 255), px(22, 255), px(33, 255), LEGACY_PACK_CHANNEL_POLICY);
    ok('a fully-opaque trio composites identically under both rules', String(opaque) === String(opaqueLegacy));
    ok('and carries the three intensities in r/g/b order', opaque[0] === 11 && opaque[1] === 22 && opaque[2] === 33);

    // No policy at all must be the legacy bytes, so the torture world — whose
    // shared-hole invariant IS real — is unaffected by the new machinery.
    const none = new Uint8ClampedArray(4);
    compositePackedTexels(none, px(200, 255), px(0, 0), px(0, 0));
    ok('omitting the policy reproduces the legacy bytes exactly', String(none) === String(legacy));

    // Multi-texel, to catch an offset error the single-texel cases cannot.
    const wide = new Uint8ClampedArray(8);
    compositePackedTexels(
      wide,
      new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255]),
      new Uint8ClampedArray([1, 1, 1, 64, 2, 2, 2, 255]),
      new Uint8ClampedArray([5, 5, 5, 255, 0, 0, 0, 0]),
      policy
    );
    ok('texel 0 takes ITS OWN g alpha, not texel 1s', wide[3] === 64);
    ok('texel 1 takes its own', wide[7] === 255);
    ok('texel 1s transparent b resolves to 0 while texel 0s opaque b stays 5', wide[2] === 5 && wide[6] === 0);
  }

  // ── A CHANGED RECIPE MUST INVALIDATE THE PERSISTED PAGES ─────────────
  // Packed pages live in IndexedDB keyed by `packId`. A page baked under the
  // old rule is byte-indistinguishable from a fresh one, so without this the
  // fix would silently do nothing for every returning session — the
  // `feedback_url_keyed_cache_needs_a_content_validator` class.
  {
    ok(
      `PACK_RECIPE_VERSION is past 1, so the broken pages cannot be served (is ${PACK_RECIPE_VERSION})`,
      PACK_RECIPE_VERSION >= 2
    );
  }
}
