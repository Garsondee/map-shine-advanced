# Optional mask HEAD probes and 404 console spam (2026-03-27)

## Summary

The network log entries you see (`XHR` + `HEAD` + `404 Not Found`) are **not** Foundry failing to load the map’s base images. They come from **map-shine-advanced** resolving **optional** effect masks by convention: for each mask type the code tries `basePath + suffix + .webp|.png|.jpg|.jpeg` using **`fetch(..., { method: 'HEAD' })`** until one responds OK.

If those files were never authored (normal for many maps), every attempt returns **404**. The map still works because albedo/background textures load on other paths; effects that need a mask simply find nothing and disable or fall back.

## What the URLs mean

Example pattern (from your log):

`https://mythicamachina.com/modules/mythica-machina-flooded-river-prison/assets/mythica-machina-flooded-river-prison-Ground_Roughness.webp`

- **Directory:** module assets folder for that map pack.
- **Stem:** `…-Ground` or `…-FirstFloor` — derived from the **scene background or tile texture URL** by stripping the file extension. Each distinct base image on the scene gets its own probe set.
- **Suffix:** convention for optional masks, e.g. `_Roughness`, `_Normal`, `_Fluid`, `_Water`, `_Fire`, `_Dust`, `_Windows`, `_Bush`, `_Tree`, `_Iridescence`, `_Prism`, `_Ash`, `_Specular`, etc.
- **Four HEADs per suffix:** one per extension in `SUPPORTED_FORMATS`: `webp`, `png`, `jpg`, `jpeg`.

So a single “missing optional mask” costs **up to four** HEAD requests (all 404 if the file does not exist in any of those extensions).

## Where this is implemented

| Piece | Location | Role |
|--------|-----------|------|
| HEAD loop | `scripts/assets/loader.js` — `_probeMaskPathByConvention` | For each format, `fetch(url, { method: 'HEAD', cache: 'force-cache' })`; returns first `r.ok` path or `null`. |
| When HEAD runs | `scripts/assets/loader.js` — `probeMaskFile` | If `discoverMaskDirectoryFiles` (FilePicker browse) returns **no file list**, and the scene **mask texture manifest** does not list that mask, the loader falls back to `_probeMaskPathByConvention`. |
| Format list | `scripts/assets/loader.js` — `SUPPORTED_FORMATS` | `['webp', 'png', 'jpg', 'jpeg']`. |
| Suffix registry | `scripts/assets/loader.js` — `EFFECT_MASKS` | Documents which suffix strings exist (`_Roughness`, `_Normal`, …). |

Relevant excerpt (HEAD fallback only when browse returned nothing):

```680:684:scripts/assets/loader.js
    // HEAD convention probes only when browse returned nothing. If we have a file list,
    // missing optional masks are authoritative (do not exist on disk for this map).
    if (!resolvedPath && !hasListing) {
      resolvedPath = await _probeMaskPathByConvention(basePath, suffix);
    }
```

```967:976:scripts/assets/loader.js
async function _probeMaskPathByConvention(basePath, suffix) {
  for (const format of SUPPORTED_FORMATS) {
    const candidate = `${basePath}${suffix}.${format}`;
    const u = normalizePath(candidate);
    try {
      const r = await fetch(u, { method: 'HEAD', cache: 'force-cache' });
      if (r.ok) return candidate;
    } catch (_) {}
  }
  return null;
}
```

**GM vs player:** FilePicker directory listing often works for the GM and returns an authoritative list; then **HEAD is skipped** for missing optional masks. When listing is **empty** (common constraints on hosted games, permissions, or API behavior), the code uses HEAD as a last resort — which produces the spam you see even when the map is fine.

## Who calls `probeMaskFile` (why so many suffixes)

Several V2 compositor effects each probe for their own optional masks, using the same `basePath` rule (texture URL without extension). Non-exhaustive list from the codebase:

- `SpecularEffectV2.js` — `_Specular`, then `_Roughness`, `_Normal` (when specular exists).
- `FluidEffectV2.js` — `_Fluid`.
- `WaterEffectV2.js` — `_Water`.
- `WaterSplashesEffectV2.js` — `_Water` again (same tiles/background as water effect).
- `FireEffectV2.js` — `_Fire`.
- `DustEffectV2.js` — `_Dust`.
- `WindowLightEffectV2.js` — `_Windows`, possibly `_Structural`.
- `BushEffectV2.js` / `TreeEffectV2.js` — `_Bush` / `_Tree`.
- `IridescenceEffectV2.js` — `_Iridescence`.
- `PrismEffectV2.js` — `_Prism`.
- `AshDisturbanceEffectV2.js` — `_Ash`.
- `diagnostic-center-dialog.js` — diagnostics path also uses `probeMaskFile`.

So for **one** floor texture (e.g. `…-Ground`), you can see HEADs for every suffix those effects request, times four extensions — even though **none** of those files are required for the base map to display.

### Duplicate `_Water` blocks in the log

`WaterEffectV2` and `WaterSplashesEffectV2` both call `probeMaskFile(basePath, '_Water')` for the same background and tiles. If the first call does not **persist** a negative result (see below), the second effect repeats the same four HEADs.

## Negative cache behavior (why repeats can happen)

`probeMaskFile` uses `_probeMaskNegativeCache` keyed by `` `${basePath}::${suffix}` ``.

- If FilePicker returns a **non-empty** listing and the mask is not in the list, the result **`null` is cached** — no repeat HEAD for that key.
- If FilePicker returns **no listing** and HEAD finds nothing, the function returns **`null` without caching** (comment: empty browse may be transient). So **another caller** with the same `basePath` and `suffix` will run **another** full HEAD sequence.

That conflicts with comments in some effects (“probeMaskFile already checked all formats and cached the result”) — caching is **not** guaranteed for the “no listing + mask missing” case.

## Relationship to other loading paths

- **Scene bundle / manifest loading** (`loadAssetBundle`, `buildMaskManifest`, `loadMaskTextureDirect`) uses **GET** fetch for actual loads and is a separate path from this HEAD probe; see `docs/planning/TEXTURE-LOADING-SYSTEM-RESEARCH-2026-03-27.md`.
- **`probeMaskTexture`** in the same loader is explicitly a no-op (no HEAD/GET) for optional masks; the remaining HEAD traffic is specifically **`probeMaskFile` → `_probeMaskPathByConvention`**.

## Mitigation directions (for future work, not implemented in this doc)

1. **Persist negative results** when HEAD proves all extensions missing (with TTL or session scope) so duplicate effects do not re-probe.
2. **Single coordinator** per `(basePath, suffix)` in flight + shared memo for all effects.
3. **Scene / module manifest** (`maskTextureManifest` flag + GM tooling in `mask-manifest-flags.js`) so clients never need HEAD when the GM has recorded which masks exist.
4. **Skip HEAD entirely** for non-GM when no manifest and no listing — accept “mask unknown” without network proof (trade-off: masks that exist but are undiscoverable would not load).
5. **Effect gating** — only run `probeMaskFile` for masks needed by effects that are enabled for the scene (reduces suffix count, not extensions per suffix).

## Conclusion

The console spam is **expected** with the current design whenever directory listing is unavailable: the module **proves** absence of optional masks via **HEAD**, four extensions per suffix, across **many** optional suffixes and **multiple** effects (and sometimes duplicate `_Water` probes). The 404s do **not** mean the map pack is broken or missing required art; they mean **those optional mask files are not present** at the probed URLs.
