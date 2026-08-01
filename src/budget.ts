/**
 * Context budget tracker.
 *
 * Estimates session depth from tool-call count and provides risk
 * assessment based on known LLM degradation thresholds.
 *
 * Reference literature:
 * - "Lost in the Middle" (Liu et al., TACL 2024): U-shaped attention curve
 * - "Wait, Wait, Wait..." (Pipis et al., ICML 2026): token-level self-reinforcement
 * - "Frayed RoPE" (arXiv 2603.18017): positional encoding collapse
 * - "Contextual Inertia" (ACL 2026 Findings): pattern reproduction
 * - QSAF framework (arXiv 2507.15330): cognitive degradation patterns
 * - Claude Code issue #80873: instruction decay after 5-10 turns
 */

import {
  budgetRiskLevel,
  budgetRecommendation,
  BUDGET_WARN_TURNS,
  BUDGET_DANGER_TURNS,
  BUDGET_CRITICAL_TURNS,
} from "./config.js";
import { getTotalCalls, getBlockedCount, syncFromHookFile } from "./state.js";

export interface BudgetReport {
  totalToolCalls: number;
  blockedCalls: number;
  riskLevel: "normal" | "warning" | "danger" | "critical";
  recommendation: string;
  degradationIndicators: string[];
}

export function assessBudget(): BudgetReport {
  syncFromHookFile();
  const calls = getTotalCalls();
  const blocked = getBlockedCount();

  const indicators: string[] = [];

  if (calls >= BUDGET_CRITICAL_TURNS) {
    indicators.push(
      "Attention decay: positional encoding collapse (Frayed RoPE) — model can no longer discriminate message order"
    );
    indicators.push(
      "Compaction risk: at this depth, auto-compaction loses critical working state and may enter a death spiral"
    );
  } else if (calls >= BUDGET_DANGER_TURNS) {
    indicators.push(
      "Lost in the Middle: early instructions are now in the U-shaped attention blind zone"
    );
    indicators.push(
      "Contextual Inertia: model increasingly reproduces its own prior patterns"
    );
  } else if (calls >= BUDGET_WARN_TURNS) {
    indicators.push(
      "Instruction decay zone: behavioral rules may begin to fade (Claude Code #80873)"
    );
  }

  if (blocked > 0) {
    indicators.push(`${blocked} tool calls have been blocked by anti-loop-guard`);
  }

  return {
    totalToolCalls: calls,
    blockedCalls: blocked,
    riskLevel: budgetRiskLevel(calls),
    recommendation: budgetRecommendation(calls),
    degradationIndicators: indicators,
  };
}
