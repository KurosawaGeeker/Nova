import type { AskFairUseTier, FairUsePolicyDecision, FairUsePolicyInput } from "./types.js";

const thresholds: Record<AskFairUseTier, { count: number; score: number }> = {
  free: { count: 20, score: 120 },
  starter: { count: 100, score: 800 },
  pro: { count: 300, score: 3_000 },
  heavy: { count: 1_000, score: 12_000 },
};

export function evaluateAskFairUse(input: FairUsePolicyInput): FairUsePolicyDecision {
  const limit = thresholds[input.tier];
  const actions: FairUsePolicyDecision["actions"] = [];
  const abuseIndicators = input.recentAbuseIndicators ?? 0;

  if (input.currentServerLoad === "high") {
    actions.push("reduced_context_window");
  }

  if (input.periodStats.askCount > limit.count || input.periodStats.askCostScore > limit.score) {
    actions.push("shorter_answer");
  }

  if (input.tier === "free" && input.periodStats.askCostScore > limit.score * 0.6) {
    actions.push("text_only_answer", "no_web_search");
  }

  if (abuseIndicators >= 2) {
    actions.push("temporary_cooldown");
  }

  if (actions.length === 0) {
    actions.push("full_quality_answer");
  }

  return {
    actions: Array.from(new Set(actions)),
    reason: actions.includes("full_quality_answer") ? "within_fair_use" : "fair_use_degraded",
  };
}
