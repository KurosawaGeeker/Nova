import type { BillingAddOn, Plan, PlanId } from "./types.js";

const GB = 1024 * 1024 * 1024;
const MINUTE = 60;
const catalogTimestamp = new Date("2026-04-27T00:00:00.000Z");

export const PLAN_CATALOG: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPriceCny: 0,
    monthlyPriceUsd: 0,
    cloudStorageBytes: 1 * GB,
    monthlyAiAudioSeconds: 10 * MINUTE,
    firstMonthAiAudioSeconds: 30 * MINUTE,
    askFairUseTier: "free",
    maxConcurrentImports: 1,
    maxContextTokens: 8_000,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPriceCny: 28,
    monthlyPriceUsd: 4.99,
    cloudStorageBytes: 3 * GB,
    monthlyAiAudioSeconds: 100 * MINUTE,
    askFairUseTier: "starter",
    maxConcurrentImports: 2,
    maxContextTokens: 16_000,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceCny: 58,
    monthlyPriceUsd: 9.99,
    cloudStorageBytes: 10 * GB,
    monthlyAiAudioSeconds: 300 * MINUTE,
    askFairUseTier: "pro",
    maxConcurrentImports: 4,
    maxContextTokens: 64_000,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  heavy: {
    id: "heavy",
    name: "Heavy",
    monthlyPriceCny: 168,
    cloudStorageBytes: 80 * GB,
    monthlyAiAudioSeconds: 800 * MINUTE,
    askFairUseTier: "heavy",
    maxConcurrentImports: 8,
    maxContextTokens: 128_000,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
};

export const ADD_ON_CATALOG: BillingAddOn[] = [
  {
    id: "audio_minutes_100",
    kind: "ai_audio_minutes",
    name: "100 AI audio minutes",
    aiAudioSeconds: 100 * MINUTE,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  {
    id: "audio_minutes_500",
    kind: "ai_audio_minutes",
    name: "500 AI audio minutes",
    aiAudioSeconds: 500 * MINUTE,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  {
    id: "cloud_storage_20gb",
    kind: "cloud_storage",
    name: "20GB cloud storage",
    cloudStorageBytes: 20 * GB,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
  {
    id: "cloud_storage_100gb",
    kind: "cloud_storage",
    name: "100GB cloud storage",
    cloudStorageBytes: 100 * GB,
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp,
  },
];

export function getPlan(planId: PlanId): Plan {
  return PLAN_CATALOG[planId];
}

export function getInitialGrantSeconds(plan: Plan): number {
  return plan.firstMonthAiAudioSeconds ?? plan.monthlyAiAudioSeconds;
}
