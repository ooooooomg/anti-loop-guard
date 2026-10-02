/**
 * Core loop detection engine.
 *
 * Three-layer detection strategy (checked in this order by detectLoop()):
 *
 * Layer 1 — Exact Repeat: same (tool, normalized_args) N+ times consecutively.
 * Layer 2 — Pattern Cycle: repeating A→B→C→A→B→C sequences.
 * Layer 3 — Semantic Similarity: different tools/args but high fingerprint similarity.
 *
 * All thresholds scale adaptively with session length (see config.ts).
 *
 * USAGE PATTERN:
 *   1. Call `fingerprint()` to produce a normalized fingerprint.
 *   2. Push the fingerprint into state via `record()`.
 *   3. Call `detectLoop()` to inspect current state.
 *
 * The `logAndDetect()` helper does all three in order.
 */

import { fingerprint, similarity } from "./fingerprint.js";
import type { FingerprintResult } from "./fingerprint.js";
import {
  EXACT_REPEAT_WARN,
  EXACT_REPEAT_BLOCK,
  SIMILARITY_THRESHOLD,
  SIMILARITY_CONSECUTIVE,
  CYCLE_WINDOW,
  CYCLE_MIN_PERIOD,
  CYCLE_MAX_PERIOD,
  CYCLE_REPEATS_REQUIRED,
  adaptiveMultiplier,
} from "./config.js";
import {
  recentRecords,
  getTotalCalls,
  recordIfNew,
  syncFromHookFile,
} from "./state.js";
import type { ToolCallRecord } from "./state.js";

export type LoopPattern =
  | "healthy"
  | "exact_repeat"
  | "semantic_similarity"
  | "pattern_cycle";

export interface DetectionResult {
  isStuck: boolean;
  confidence: number; // 0-1
  pattern: LoopPattern;
  details: string;
  recommendation: string;
}

// ---- Layer 1: Exact Repeat ----

function detectExactRepeat(records: ToolCallRecord[]): DetectionResult | null {
  const mult = adaptiveMultiplier(getTotalCalls());
  const warnThreshold = Math.max(3, Math.round(EXACT_REPEAT_WARN * mult));
  const blockThreshold = Math.max(4, Math.round(EXACT_REPEAT_BLOCK * mult));

  if (records.length < warnThreshold) return null;

  const last = records[records.length - 1];
  let consecutive = 1;
  for (let i = records.length - 2; i >= 0; i--) {
    if (records[i].fingerprint === last.fingerprint) {
      consecutive++;
    } else {
      break;
    }
  }

  if (consecutive >= blockThreshold) {
    return {
      isStuck: true,
      confidence: Math.min(1, consecutive / blockThreshold),
      pattern: "exact_repeat",
      details: `${consecutive} identical calls to "${last.toolName}" with same arguments.`,
      recommendation:
        "STOP immediately. The same tool call has been repeated with identical arguments. Ask the user whether to continue or change approach.",
    };
  }

  if (consecutive >= warnThreshold) {
    return {
      isStuck: true,
      confidence: consecutive / blockThreshold,
      pattern: "exact_repeat",
      details: `${consecutive} identical calls to "${last.toolName}".`,
      recommendation:
        "You may be in a loop — the same tool call has been repeated multiple times. Consider stopping and reporting status to the user.",
    };
  }

  return null;
}

// ---- Layer 2: Semantic Similarity ----

function detectSemanticSimilarity(records: ToolCallRecord[]): DetectionResult | null {
  const mult = adaptiveMultiplier(getTotalCalls());
  const threshold = Math.max(3, Math.round(SIMILARITY_CONSECUTIVE * mult));

  if (records.length < threshold) return null;

  const recent = records.slice(-threshold);
  let highSimilarityPairs = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    const sim = similarity(recent[i].normalized, recent[i + 1].normalized);
    if (sim >= SIMILARITY_THRESHOLD) {
      highSimilarityPairs++;
    }
  }

  if (highSimilarityPairs >= threshold - 1) {
    return {
      isStuck: true,
      confidence: highSimilarityPairs / (threshold - 1),
      pattern: "semantic_similarity",
      details: `Last ${threshold} tool calls are semantically near-identical (similarity > ${(SIMILARITY_THRESHOLD * 100).toFixed(0)}%).`,
      recommendation:
        "Your recent tool calls are semantically very similar — you may be trying the same approach repeatedly. Consider a different strategy or ask the user for guidance.",
    };
  }

  return null;
}

// ---- Layer 3: Pattern Cycle ----

function detectPatternCycle(records: ToolCallRecord[]): DetectionResult | null {
  // Minimum calls needed for the shortest detectable cycle (period=2, 3 repeats).
  if (records.length < CYCLE_MIN_PERIOD * (CYCLE_REPEATS_REQUIRED + 1)) return null;

  const window = records.slice(-CYCLE_WINDOW);
  const fps = window.map((r) => r.fingerprint);

  for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
    const repeats = countCycleRepeats(fps, period);
    if (repeats >= CYCLE_REPEATS_REQUIRED) {
      const toolsInCycle = [
        ...new Set(window.slice(-period * repeats).map((r) => r.toolName)),
      ].join(" → ");
      return {
        isStuck: true,
        confidence: Math.min(1, repeats / (CYCLE_REPEATS_REQUIRED + 1)),
        pattern: "pattern_cycle",
        details: `Detected repeating cycle of ${period} calls (${toolsInCycle}), repeated ${repeats} times.`,
        recommendation:
          "A repeating tool-call pattern has been detected. You are cycling through the same sequence of actions. Break the cycle and report status to the user.",
      };
    }
  }

  return null;
}

function countCycleRepeats(fps: string[], period: number): number {
  if (fps.length < period * 2) return 0;

  let maxRepeats = 0;
  for (let start = fps.length - period * 2; start >= 0; start -= period) {
    let repeats = 1;
    for (let offset = start; offset + period * 2 <= fps.length; offset += period) {
      const a = fps.slice(offset, offset + period);
      const b = fps.slice(offset + period, offset + period * 2);
      if (a.every((fp, i) => fp === b[i])) {
        repeats++;
      } else {
        break;
      }
    }
    maxRepeats = Math.max(maxRepeats, repeats);
  }
  return maxRepeats;
}

// ---- Combined detection ----

export function detectLoop(): DetectionResult {
  syncFromHookFile();
  const records = recentRecords();

  // Layer 1: exact repeat — always highest priority
  const exact = detectExactRepeat(records);
  if (exact) return exact;

  // Layer 2: pattern cycle
  const cycle = detectPatternCycle(records);
  if (cycle) return cycle;

  // Layer 3: semantic similarity — only if no exact/cycle match
  const semantic = detectSemanticSimilarity(records);
  if (semantic) return semantic;

  return {
    isStuck: false,
    confidence: 0,
    pattern: "healthy",
    details: "No loop patterns detected.",
    recommendation: "Continue working normally.",
  };
}

// ---- Convenience helper: fingerprint → record → detect ----

export function logAndDetect(
  toolName: string,
  args: Record<string, unknown>,
  toolUseId?: string
): { record: ToolCallRecord; detection: DetectionResult } {
  const fp: FingerprintResult = fingerprint(toolName, args);
  const rec: ToolCallRecord = {
    toolName,
    fingerprint: fp.hash,
    normalized: fp.normalized,
    timestamp: Date.now(),
    toolUseId,
  };
  // Record FIRST so detection sees the current call; skip if the hook
  // already recorded this exact call (same tool_use_id).
  const recorded = recordIfNew(rec);
  return { record: rec, detection: detectLoop() };
}
