import type { FastifyInstance } from "fastify";

import {
  ADD_ON_CATALOG,
  BillingService,
  getPlan,
  LocalDemoBillingAccountService,
  PLAN_CATALOG,
  type BillingAddOn,
  type Plan,
} from "../billing/index.js";

const ASK_USAGE_DIMENSIONS = [
  "ask_count",
  "ask_text_tokens_in",
  "ask_text_tokens_out",
  "ask_stt_seconds",
  "ask_tts_seconds",
  "ask_web_search_calls",
  "ask_cost_score",
];

const DEMO_LIMITATIONS = [
  "Local demo account only; no user authentication is attached.",
  "No payment provider, checkout, subscription mutation, or invoice state is implemented.",
  "Usage shown here is informational; quota enforcement and usage ledger integration come in later phases.",
  "Failed imports and failed Ask requests are not charged by these read-only routes.",
];

export async function registerBillingRoutes(
  app: FastifyInstance,
  billingService: BillingService,
  accountService: LocalDemoBillingAccountService,
): Promise<void> {
  app.get("/v1/billing/plans", async () => ({
    mode: "local_demo",
    paymentIntegration: false,
    plans: Object.values(PLAN_CATALOG).map(serializePlan),
    addOns: ADD_ON_CATALOG.map(serializeAddOn),
    limitations: DEMO_LIMITATIONS,
  }));

  app.get("/v1/billing/entitlements", async () => {
    const account = accountService.getAccount();
    const snapshot = billingService.getEntitlements(account);
    const plan = getPlan(account.planId);
    const askPolicy = billingService.evaluateFairUseForUser(account.id, plan.askFairUseTier);

    return {
      mode: "local_demo",
      paymentIntegration: false,
      accountId: account.id,
      billingRegion: account.billingRegion,
      currentPeriodStart: account.currentPeriodStart.toISOString(),
      planId: snapshot.planId,
      planStatus: snapshot.planStatus,
      periodEndsAt: snapshot.periodEndsAt.toISOString(),
      aiAudioSecondsRemaining: snapshot.aiAudioSecondsRemaining,
      aiAudioSecondsUsed: snapshot.aiAudioSecondsUsed,
      periodAiAudioSecondsGranted: snapshot.periodAiAudioSecondsGranted,
      addonAiAudioSecondsRemaining: snapshot.addonAiAudioSecondsRemaining,
      cloudStorageBytesUsed: snapshot.cloudStorageBytesUsed,
      cloudStorageBytesLimit: snapshot.cloudStorageBytesLimit,
      askTier: snapshot.askTier,
      maxConcurrentImports: snapshot.maxConcurrentImports,
      maxContextTokens: snapshot.maxContextTokens,
      aiAudio: {
        secondsRemaining: snapshot.aiAudioSecondsRemaining,
        secondsUsed: snapshot.aiAudioSecondsUsed,
        periodSecondsGranted: snapshot.periodAiAudioSecondsGranted,
        addonSecondsRemaining: snapshot.addonAiAudioSecondsRemaining,
        minutesRemaining: secondsToDisplayMinutes(snapshot.aiAudioSecondsRemaining),
        minutesUsed: secondsToDisplayMinutes(snapshot.aiAudioSecondsUsed),
        failedImportsCharged: false,
        failedAskCharged: false,
      },
      cloudStorage: {
        bytesUsed: snapshot.cloudStorageBytesUsed,
        bytesLimit: snapshot.cloudStorageBytesLimit,
        gbLimit: bytesToGb(snapshot.cloudStorageBytesLimit),
        localOnlyFilesCountAgainstLimit: false,
      },
      askFairUse: {
        tier: snapshot.askTier,
        hardQuota: false,
        userFacingLimit: "fair_use",
        trackedDimensions: ASK_USAGE_DIMENSIONS,
        currentPolicy: askPolicy,
      },
      limitations: DEMO_LIMITATIONS,
    };
  });
}

function serializePlan(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    monthlyPriceCny: plan.monthlyPriceCny,
    monthlyPriceUsd: plan.monthlyPriceUsd ?? null,
    cloudStorageBytes: plan.cloudStorageBytes,
    cloudStorageGb: bytesToGb(plan.cloudStorageBytes),
    monthlyAiAudioSeconds: plan.monthlyAiAudioSeconds,
    monthlyAiAudioMinutes: secondsToDisplayMinutes(plan.monthlyAiAudioSeconds),
    firstMonthAiAudioSeconds: plan.firstMonthAiAudioSeconds ?? null,
    firstMonthAiAudioMinutes:
      plan.firstMonthAiAudioSeconds === undefined ? null : secondsToDisplayMinutes(plan.firstMonthAiAudioSeconds),
    askFairUseTier: plan.askFairUseTier,
    askFairUse: {
      tier: plan.askFairUseTier,
      hardQuota: false,
      userFacingLimit: "fair_use",
      trackedDimensions: ASK_USAGE_DIMENSIONS,
    },
    maxConcurrentImports: plan.maxConcurrentImports,
    maxContextTokens: plan.maxContextTokens,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

function serializeAddOn(addOn: BillingAddOn) {
  return {
    id: addOn.id,
    kind: addOn.kind,
    name: addOn.name,
    aiAudioSeconds: addOn.aiAudioSeconds ?? null,
    aiAudioMinutes: addOn.aiAudioSeconds === undefined ? null : secondsToDisplayMinutes(addOn.aiAudioSeconds),
    cloudStorageBytes: addOn.cloudStorageBytes ?? null,
    cloudStorageGb: addOn.cloudStorageBytes === undefined ? null : bytesToGb(addOn.cloudStorageBytes),
    purchaseAvailable: false,
    createdAt: addOn.createdAt.toISOString(),
    updatedAt: addOn.updatedAt.toISOString(),
  };
}

function secondsToDisplayMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

function bytesToGb(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}
