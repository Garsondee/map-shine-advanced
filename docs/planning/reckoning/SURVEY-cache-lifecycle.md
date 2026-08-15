# Reckoning survey — COMPRESSION-CACHE LIFECYCLE (and the death of the stale-cache hypothesis)

*Captured 2026-08-15 by Claude Fable 5 via a read-only scout, adversarially testing the
hypothesis "the author's live session serves pre-v10 cache records without min-grids, so S1a
is silently inert on his machine." **VERDICT: structurally IMPOSSIBLE as stated.** Kept as the
campaign's model exoneration — and for the two REAL findings it surfaced instead.*

## The mechanism (why the hypothesis dies)

- Two unrelated IndexedDB stores: `msa-bc-cache/blocks` (BC records; keys `bc:v10:${src}` and
  `alpha:v2:${src}`) and `map-shine-vt-pages/pages` (page blobs; `${url}|m${mip}|${px},${py}`).
- **The version is part of the cache KEY** (`bc:v${CACHE_VERSION}:${src}`,
  bc-compress.worker.js:435; `CACHE_VERSION = 10` :180; v9→v10 rationale :170-179). A v9 record
  is UNADDRESSABLE by v10 code. The only read branch (:436-447) hits a v10 key or falls through
  to full recompression, which unconditionally builds the min-grid (:495-520).
- `CACHE_VERSION = 10` and `alphaMinGrid` landed in ONE commit (`22a4750`) — no v10-keyed record
  without the grid can exist. The worker file is clean in the working tree.
- The Testament's "v9 records fail-open to no-split" describes the COUNTERFACTUAL the key bump
  was chosen to avoid (the worker's own comment: "would fail-open … re-encoded instead").
- Assignment sites: fresh + cache-hit both deliver `alphaStats`/`alphaMinGrid` through the same
  reply; viewer assigns BEFORE the first setTileGeometry (vt-pan-viewer.js ~:8784-8785, the
  2026-08-13 timing fix) with the async re-mesh gate (~:9019-9021).
- Freshness on a hit is ETag/Last-Modified/Content-Length vs a HEAD (:206-248); **HEAD failure
  trusts the cache** (:241-242, deliberate).

## What WOULD produce the starved signature today

`s1aBlockedNoMinGrid > 0` + `splitDeclinedBy.noMinGrid > 0` = the grid genuinely never reached
the tile at mesh time (arrival/re-mesh chain broken — the Bug #20 timing-bug class recurring),
NOT a version-cache issue. `refusedBy.noAlphaStats` = the RAW-DECODE fallback (worker
blocked/failed) — no stats at all, never appears in splitDeclinedBy, full blended+discard cost.

## The two REAL findings

1. **Silent quota swallow:** `cachePut(...).catch(() => {})` (bc-compress.worker.js:576) eats
   `QuotaExceededError`. An over-quota origin re-encodes EVERY asset EVERY session with zero
   diagnostic — presents as "loading got slow". Signature: compressed-worker stats showing
   fresh encodes with zero cache hits on a world this browser has visited before. (The
   Reckoning Report button now surfaces exactly this.)
2. **Unbounded version-graveyard:** superseded `bc:v1:`…`bc:v9:` records are never deleted —
   nine generations of a 12k-map's blocks accumulate toward the very quota that then silently
   breaks writes. DevTools → Application → IndexedDB → `msa-bc-cache` shows it directly.

## Smaller oddities

- `pyramid-store.js` keys carry NO content-version segment (its own header admits it) — the
  defect class BC's v6 fixed, unfixed there.
- `COARSE_ALPHA_MAX_DIM` silently governs the BC record's min-grid dims — changing it requires
  a `CACHE_VERSION` bump documented nowhere.
- Stale labels: `block-compress.test.mjs:853-854` still says "CACHE_VERSION 9";
  `Performance-Audit-2026-08.md:1385` still asserts v9.
- Bench nuance: the pixel-diff harness uses its own Chrome profile (separate IndexedDB) and
  clears only the HTTP cache; attach-mode can point at the author's own server, making cache
  KEYS identical — the profile is what differs.

## Settling it live (one console call)

`MapShine.getEarlyZComposition()` → `s1aBlockedNoMinGrid` / `splitDeclinedBy` /
`splitInteriorCells` / `tiles.split` / `refusedBy.noAlphaStats` / `earlyZComposition` — the
table in the scout's full output maps each combination to its mechanism. The Reckoning Report
button captures all of it in one press.
