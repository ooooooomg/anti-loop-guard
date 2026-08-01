/**
 * Centralized configuration constants and threshold management.
 * All tunable values are here — tweak these, not the detection code.
 */

// ---- exact-repeat detection ----
export const EXACT_REPEAT_WARN = 5; // consecutive identical fingerprints → warn
export const EXACT_REPEAT_BLOCK = 8; // consecutive identical fingerprints → block

// ---- semantic-similarity detection ----
export const SIMILARITY_THRESHOLD = 0.80; // similarity above this → suspicious
export const SIMILARITY_CONSECUTIVE = 4; // consecutive similar calls → warn

// ---- pattern-cycle detection ----
export const CYCLE_WINDOW = 24; // lookback window for cycle detection
export const CYCLE_MIN_PERIOD = 2; // shortest detectable cycle
export const CYCLE_MAX_PERIOD = 6; // longest detectable cycle
export const CYCLE_REPEATS_REQUIRED = 3; // how many times a cycle must repeat

// ---- context budget ----
export const BUDGET_WARN_TURNS = 100; // first advisory
export const BUDGET_DANGER_TURNS = 300; // strong recommendation
export const BUDGET_CRITICAL_TURNS = 500; // practically guaranteed degradation

// ---- adaptive thresholds (multipliers) ----
export const ADAPTIVE_EARLY = 1.5; // first 50 calls — relaxed
export const ADAPTIVE_MID = 1.0; // 50-200 calls — standard
export const ADAPTIVE_LATE = 0.7; // 200+ calls — strict

export function adaptiveMultiplier(callCount: number): number {
  if (callCount < 50) return ADAPTIVE_EARLY;
  if (callCount < 200) return ADAPTIVE_MID;
  return ADAPTIVE_LATE;
}

export function budgetRiskLevel(messageCount: number): "normal" | "warning" | "danger" | "critical" {
  if (messageCount < BUDGET_WARN_TURNS) return "normal";
  if (messageCount < BUDGET_DANGER_TURNS) return "warning";
  if (messageCount < BUDGET_CRITICAL_TURNS) return "danger";
  return "critical";
}

export function budgetRecommendation(messageCount: number): string {
  const level = budgetRiskLevel(messageCount);
  switch (level) {
    case "normal":
      return "Session is within normal operating range.";
    case "warning":
      return "Session is getting long. Consider splitting remaining tasks into a new session.";
    case "danger":
      return "Session is very long — instruction decay is likely. Strongly recommend starting a fresh session.";
    case "critical":
      return "CRITICAL: Context degradation is practically guaranteed. Start a new session immediately.";
  }
}

// ---- sliding window ----
export const WINDOW_SIZE = 32; // how many recent tool calls to track

// ---- state file ----
export const DEFAULT_STATE_DIR = process.env.ANTI_LOOP_STATE_DIR || undefined;
