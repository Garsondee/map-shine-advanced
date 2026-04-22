/**
 * @fileoverview Adaptive policy for the V3 shader warmup overlay.
 *
 * Turns the user-facing "Auto" choice into a concrete `"fast"` or `"gated"`
 * decision using:
 *
 *   1. Persisted timing from previous sessions (the coordinator writes a
 *      rolling buffer of recent core compile durations to localStorage).
 *   2. Live hardware hints probed once per mount
 *      ({@link probeWarmupHardware}) — GPU vendor/renderer via
 *      `WEBGL_debug_renderer_info`, `navigator.hardwareConcurrency`,
 *      `navigator.deviceMemory`, and the GL context's max texture size /
 *      vendor string as corroborating signals.
 *   3. Coarse classification of the device into "strong", "moderate", and
 *      "weak" tiers used only as a first-run fallback when no persisted
 *      data is available.
 *
 * All decisions are pure — a rationale object is returned alongside the
 * chosen mode so diagnostics (`V3Shine.shaderWarmup.policy()`) can surface
 * *why* the adaptive layer picked one overlay or the other. This avoids the
 * "mystery gating" anti-pattern where the UX silently flips modes between
 * sessions without explanation.
 *
 * Thresholds are intentionally conservative: adaptive gating should only
 * fire when there is credible evidence the user would otherwise see a long,
 * visually-unexplained stall. A single slow sample on an otherwise capable
 * device is not enough — we also require the recent buffer to corroborate.
 *
 * @module v3/V3WarmupPolicy
 */

/**
 * @typedef {Object} V3WarmupHardwareInfo
 * @property {string|null} vendor Unmasked GL vendor, or `null` if unavailable.
 * @property {string|null} renderer Unmasked GL renderer string, or `null`.
 * @property {number|null} cpuCores `navigator.hardwareConcurrency` if available.
 * @property {number|null} deviceMemoryGb `navigator.deviceMemory` (GB) if available.
 * @property {number|null} maxTextureSize `gl.MAX_TEXTURE_SIZE` if known.
 * @property {"strong" | "moderate" | "weak" | "unknown"} tier
 *   Coarse classification derived from the raw fields above.
 * @property {string[]} tierReasons Why the tier resolved the way it did.
 * @property {string} signature Stable hash-ish identifier for invalidating
 *   persisted samples when the GPU/browser/OS combo changes.
 */

/**
 * @typedef {Object} V3WarmupPolicyPersisted
 * @property {number|null} lastCoreDurationMs Most recent core compile duration.
 * @property {number[]} recentCoreDurationsMs Last N core durations (youngest last).
 * @property {string|null} hardwareSignature Signature when samples were recorded.
 * @property {number} sampleCount Total observed samples (may exceed recent window length).
 */

/**
 * @typedef {Object} V3WarmupPolicyInputs
 * @property {V3WarmupPolicyPersisted|null} persisted Persisted metrics, or `null`.
 * @property {V3WarmupHardwareInfo|null} hardware Live hardware info, or `null`.
 * @property {number} [thresholdMs] Gating threshold for the recent-duration
 *   statistic. Defaults to {@link DEFAULT_GATE_THRESHOLD_MS}.
 * @property {number} [ambiguityBandMs] Band around `thresholdMs` inside which
 *   we fall back to hardware hints rather than numeric comparison alone.
 *   Defaults to {@link DEFAULT_AMBIGUITY_BAND_MS}.
 */

/**
 * @typedef {Object} V3WarmupPolicyDecision
 * @property {"fast" | "gated"} mode Resolved overlay flavour.
 * @property {"persisted-fast" |
 *            "persisted-gated" |
 *            "persisted-ambiguous-hardware-strong" |
 *            "persisted-ambiguous-hardware-weak" |
 *            "persisted-ambiguous-fallback" |
 *            "persisted-signature-mismatch" |
 *            "hardware-weak" |
 *            "hardware-strong" |
 *            "hardware-moderate" |
 *            "default-fast"} reason
 * @property {number|null} statisticMs Representative recent-duration figure
 *   (max of recent buffer with light trimming) used in the decision.
 * @property {number} thresholdMs Threshold used.
 * @property {V3WarmupHardwareInfo|null} hardware Hardware snapshot considered.
 */

/**
 * Upper bound on a "fast" core compile. Core compiles above this duration
 * caused enough of a visible stall on first-pixel to warrant the gated
 * overlay next session. Picked after informal profiling of the V3 pipeline
 * on a mid-range desktop GPU — well below typical cold-load budgets (<1s)
 * but comfortably above the expected 100–400ms warm path.
 */
export const DEFAULT_GATE_THRESHOLD_MS = 900;

/**
 * Durations within `threshold ± AMBIGUITY_BAND_MS` are not conclusive; in
 * that band we consult hardware hints to tie-break rather than flipping on
 * a single noisy sample.
 */
export const DEFAULT_AMBIGUITY_BAND_MS = 150;

/**
 * Minimum number of recent samples required before we will *downgrade* to
 * fast after previously being gated. One fast sample can be luck (warm GPU
 * shader cache, cold scene), so require at least this many to corroborate.
 */
export const MIN_DOWNGRADE_SAMPLES = 2;

/**
 * Rolling window size written by the coordinator. Callers that parse
 * persisted data should trim to this length.
 */
export const RECENT_SAMPLE_WINDOW = 5;

/**
 * Lowercased substrings that strongly suggest integrated / mobile / weak
 * GPU tiers when found in the unmasked renderer string. Matching here is a
 * *hint*, not a rejection — we still let real measurements override.
 */
const WEAK_GPU_HINTS = [
  "intel(r) hd",
  "intel hd",
  "intel(r) uhd",
  "intel uhd",
  "intel iris",
  "apple m1",
  "apple m2",
  "adreno",
  "mali",
  "powervr",
  "swiftshader",
  "software",
  "llvmpipe",
  "basic render driver",
  "microsoft basic",
];

/**
 * Substrings suggesting a high-end or at least reliably capable discrete
 * GPU. Again, hints only.
 */
const STRONG_GPU_HINTS = [
  "nvidia geforce rtx",
  "nvidia rtx",
  "nvidia geforce gtx 10",
  "nvidia geforce gtx 16",
  "nvidia geforce gtx 20",
  "nvidia geforce gtx 30",
  "nvidia geforce gtx 40",
  "radeon rx",
  "radeon pro",
  "radeon vii",
];

/**
 * Probe hardware characteristics that influence compile cost. Safe to call
 * even when the renderer or GL context is unavailable — returns an info
 * object with `tier === "unknown"` in that case.
 *
 * @param {{
 *   renderer?: { getContext?: () => any } | null,
 *   gl?: any,
 * }} [opts]
 * @returns {V3WarmupHardwareInfo}
 */
export function probeWarmupHardware(opts = {}) {
  const gl = opts.gl ?? extractGl(opts.renderer);

  let vendor = null;
  let renderer = null;
  let maxTextureSize = null;
  if (gl) {
    try {
      const ext = gl.getExtension?.("WEBGL_debug_renderer_info");
      if (ext) {
        vendor = safeString(gl.getParameter?.(ext.UNMASKED_VENDOR_WEBGL));
        renderer = safeString(gl.getParameter?.(ext.UNMASKED_RENDERER_WEBGL));
      }
      // Fallback to masked strings — most browsers strip these but some
      // keep usable data and it's cheap to read.
      if (!vendor) vendor = safeString(gl.getParameter?.(gl.VENDOR));
      if (!renderer) renderer = safeString(gl.getParameter?.(gl.RENDERER));
      const maxTex = gl.getParameter?.(gl.MAX_TEXTURE_SIZE);
      if (Number.isFinite(Number(maxTex))) maxTextureSize = Number(maxTex);
    } catch (_) {
      // ignore — hardware probing is best-effort
    }
  }

  const cpuCores = readNumberOrNull(globalThis?.navigator?.hardwareConcurrency);
  const deviceMemoryGb = readNumberOrNull(globalThis?.navigator?.deviceMemory);

  const tierReasons = [];
  let tier = "unknown";

  if (renderer) {
    const lc = renderer.toLowerCase();
    if (WEAK_GPU_HINTS.some((h) => lc.includes(h))) {
      tier = "weak";
      tierReasons.push(`renderer string matches weak hint (${renderer})`);
    } else if (STRONG_GPU_HINTS.some((h) => lc.includes(h))) {
      tier = "strong";
      tierReasons.push(`renderer string matches strong hint (${renderer})`);
    }
  }

  if (tier === "unknown" || tier === "moderate") {
    if (cpuCores != null && cpuCores <= 4) {
      tier = tier === "strong" ? "moderate" : "weak";
      tierReasons.push(`hardwareConcurrency ${cpuCores} (<= 4) suggests weak tier`);
    } else if (cpuCores != null && cpuCores >= 12) {
      if (tier !== "weak") {
        tier = "strong";
        tierReasons.push(`hardwareConcurrency ${cpuCores} (>= 12) suggests strong tier`);
      }
    }
  }

  if (tier === "unknown") {
    if (deviceMemoryGb != null && deviceMemoryGb <= 4) {
      tier = "weak";
      tierReasons.push(`deviceMemory ${deviceMemoryGb}GB (<= 4) suggests weak tier`);
    } else if (deviceMemoryGb != null && deviceMemoryGb >= 16) {
      tier = "strong";
      tierReasons.push(`deviceMemory ${deviceMemoryGb}GB (>= 16) suggests strong tier`);
    } else if (renderer || vendor) {
      tier = "moderate";
      tierReasons.push("no strong/weak hints matched; defaulted to moderate");
    }
  }

  if (tier === "unknown" && (renderer || vendor)) {
    tier = "moderate";
  }

  const signature = buildSignature({
    vendor,
    renderer,
    cpuCores,
    deviceMemoryGb,
    maxTextureSize,
  });

  return {
    vendor,
    renderer,
    cpuCores,
    deviceMemoryGb,
    maxTextureSize,
    tier,
    tierReasons,
    signature,
  };
}

/**
 * Pure policy decision: given persisted metrics and hardware info, choose
 * between the fast toast and the gated overlay. Deterministic + side-effect
 * free so it can be unit-tested against fixed inputs.
 *
 * @param {V3WarmupPolicyInputs} inputs
 * @returns {V3WarmupPolicyDecision}
 */
export function resolveWarmupMode(inputs) {
  const threshold = Number.isFinite(Number(inputs.thresholdMs))
    ? Number(inputs.thresholdMs)
    : DEFAULT_GATE_THRESHOLD_MS;
  const band = Number.isFinite(Number(inputs.ambiguityBandMs))
    ? Number(inputs.ambiguityBandMs)
    : DEFAULT_AMBIGUITY_BAND_MS;
  const hardware = inputs.hardware ?? null;
  const persisted = inputs.persisted ?? null;

  // Persisted-data path: only trust samples that were recorded against the
  // same hardware signature. On signature mismatch we discard the samples
  // and fall through to hardware-hint logic, then annotate the rationale.
  if (persisted && Array.isArray(persisted.recentCoreDurationsMs) && persisted.recentCoreDurationsMs.length > 0) {
    if (hardware?.signature && persisted.hardwareSignature && hardware.signature !== persisted.hardwareSignature) {
      // GPU/driver/browser changed: samples are stale. Fall through to the
      // hardware-hint branch below (we still return a rationale so the
      // user sees why adaptive data was discarded).
      return decideFromHardware(hardware, threshold, "persisted-signature-mismatch");
    }

    const stat = representativeStatistic(persisted.recentCoreDurationsMs);

    if (stat >= threshold + band) {
      return {
        mode: "gated",
        reason: "persisted-gated",
        statisticMs: Math.round(stat),
        thresholdMs: threshold,
        hardware,
      };
    }
    if (stat <= threshold - band) {
      if (persisted.recentCoreDurationsMs.length >= MIN_DOWNGRADE_SAMPLES) {
        return {
          mode: "fast",
          reason: "persisted-fast",
          statisticMs: Math.round(stat),
          thresholdMs: threshold,
          hardware,
        };
      }
      // Only one fast sample so far: be cautious, corroborate with hardware.
    }

    // Ambiguous band — use hardware tier as tie-breaker.
    if (hardware?.tier === "weak") {
      return {
        mode: "gated",
        reason: "persisted-ambiguous-hardware-weak",
        statisticMs: Math.round(stat),
        thresholdMs: threshold,
        hardware,
      };
    }
    if (hardware?.tier === "strong") {
      return {
        mode: "fast",
        reason: "persisted-ambiguous-hardware-strong",
        statisticMs: Math.round(stat),
        thresholdMs: threshold,
        hardware,
      };
    }
    return {
      mode: stat >= threshold ? "gated" : "fast",
      reason: "persisted-ambiguous-fallback",
      statisticMs: Math.round(stat),
      thresholdMs: threshold,
      hardware,
    };
  }

  // No persisted samples — lean entirely on hardware.
  return decideFromHardware(hardware, threshold, null);
}

/**
 * @param {V3WarmupHardwareInfo|null} hardware
 * @param {number} threshold
 * @param {V3WarmupPolicyDecision["reason"]|null} overrideReason
 * @returns {V3WarmupPolicyDecision}
 */
function decideFromHardware(hardware, threshold, overrideReason) {
  if (!hardware || hardware.tier === "unknown") {
    return {
      mode: "fast",
      reason: overrideReason ?? "default-fast",
      statisticMs: null,
      thresholdMs: threshold,
      hardware,
    };
  }
  if (hardware.tier === "weak") {
    return {
      mode: "gated",
      reason: overrideReason ?? "hardware-weak",
      statisticMs: null,
      thresholdMs: threshold,
      hardware,
    };
  }
  if (hardware.tier === "strong") {
    return {
      mode: "fast",
      reason: overrideReason ?? "hardware-strong",
      statisticMs: null,
      thresholdMs: threshold,
      hardware,
    };
  }
  return {
    mode: "fast",
    reason: overrideReason ?? "hardware-moderate",
    statisticMs: null,
    thresholdMs: threshold,
    hardware,
  };
}

/**
 * Trimmed-max statistic over a short recent window. Drops the single
 * highest sample (likely a cold-load outlier) when the window is long
 * enough, then takes the maximum of what remains. This is deliberately
 * pessimistic: a user who consistently saw ~800ms compiles deserves the
 * gated overlay even if the most recent cold-load sample was only 650ms.
 *
 * @param {number[]} samples
 * @returns {number}
 */
function representativeStatistic(samples) {
  const clean = samples
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!clean.length) return 0;
  if (clean.length >= 3) clean.pop();
  return clean[clean.length - 1];
}

/**
 * @param {any} v
 */
function safeString(v) {
  if (v == null) return null;
  try {
    const s = String(v);
    return s.length ? s : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {any} v
 */
function readNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive a stable identifier for the current GPU/driver/browser combination.
 * Used to invalidate persisted samples when the user changes machines or
 * updates their graphics driver.
 *
 * @param {{
 *   vendor: string|null, renderer: string|null,
 *   cpuCores: number|null, deviceMemoryGb: number|null,
 *   maxTextureSize: number|null,
 * }} parts
 * @returns {string}
 */
function buildSignature(parts) {
  const ua = globalThis?.navigator?.userAgent ?? "";
  const raw = [
    parts.vendor ?? "",
    parts.renderer ?? "",
    parts.cpuCores ?? "",
    parts.deviceMemoryGb ?? "",
    parts.maxTextureSize ?? "",
    // Include the major browser token only — full UA is noisy and would
    // invalidate samples on every Chrome minor-version bump.
    ua.split(" ").find((tok) => /Chrome|Firefox|Safari|Edg\//i.test(tok)) ?? "",
  ].join("|");
  return fnv1a(raw);
}

/**
 * Small non-cryptographic hash. We only need stable equality, not
 * collision resistance; 32-bit FNV-1a is plenty and avoids pulling in a
 * crypto dependency.
 *
 * @param {string} s
 */
function fnv1a(s) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * @param {any} renderer
 */
function extractGl(renderer) {
  if (!renderer) return null;
  try {
    if (typeof renderer.getContext === "function") {
      return renderer.getContext();
    }
  } catch (_) {}
  return null;
}
