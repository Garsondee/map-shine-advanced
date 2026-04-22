/**
 * @fileoverview Shared Foundry `FilePicker.browse` helpers for directory
 * listings without speculative image GETs.
 */

/**
 * @returns {((source: string, target: string, options?: object) => Promise<unknown>)|null}
 */
export function getFilePickerBrowseFn() {
  try {
    const App = globalThis.foundry?.applications?.apps?.FilePicker;
    if (App && typeof App.browse === "function") {
      return (source, target, options) => App.browse(source, target, options);
    }
  } catch (_) {}
  const Legacy = globalThis.FilePicker;
  if (Legacy && typeof Legacy.browse === "function") {
    return (source, target, options) => Legacy.browse(source, target, options);
  }
  return null;
}

/**
 * @param {string} dir Directory URL or site-relative path (no trailing slash).
 * @returns {{ source: string, target: string }[]}
 */
export function filePickerBrowseCandidates(dir) {
  /** @type {{ source: string, target: string }[]} */
  const out = [];
  if (!dir) return out;

  let path = dir;
  try {
    if (/^https?:\/\//i.test(dir)) {
      const u = new URL(dir);
      path = u.pathname.replace(/^\/+/, "");
    } else {
      path = String(dir).replace(/^\/+/, "");
    }
  } catch (_) {
    path = String(dir).replace(/^\/+/, "");
  }
  path = path.replace(/\/+$/, "");

  if (path) {
    out.push({ source: "data", target: path });
    out.push({ source: "public", target: path });
  }
  return out;
}

/**
 * List files in a directory via Foundry (no per-file HTTP probes).
 *
 * @param {string} dir
 * @returns {Promise<{ files: string[], target: string, source: string }|null>}
 */
export async function browseDirectoryFiles(dir) {
  const browse = getFilePickerBrowseFn();
  if (!browse) return null;
  const candidates = filePickerBrowseCandidates(dir);
  for (const { source, target } of candidates) {
    try {
      const result = await browse(source, target);
      if (result && Array.isArray(result.files)) {
        return { files: result.files, target, source };
      }
    } catch (_) {
      // Try next source; permissions / missing dirs are expected.
    }
  }
  return null;
}
