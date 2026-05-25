export type PlanId = "free" | "starter" | "pro" | "heavy";

export type PlanStatus = "free" | "trialing" | "active" | "past_due" | "canceled";

export type BillingRegion = "CN" | "US" | "GLOBAL";

export type AskFairUseTier = "free" | "starter" | "pro" | "heavy";

export type UsageType =
  | "audio_generation"
  | "ask"
  | "storage_delta"
  | "credit_grant"
  | "credit_refund";

export type UsageUnit = "seconds" | "bytes" | "count" | "cost_score";

export type UsageLedgerStatus = "pending" | "committed" | "canceled" | "refunded";

export interface UserAccount {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  billingRegion: BillingRegion;
  planId: PlanId;
  planStatus: PlanStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPriceCny: number;
  monthlyPriceUsd?: number;
  cloudStorageBytes: number;
  monthlyAiAudioSeconds: number;
  firstMonthAiAudioSeconds?: number;
  askFairUseTier: AskFairUseTier;
  maxConcurrentImports: number;
  maxContextTokens: number;
  createdAt: Date;
  updatedAt: Date;
}

export type BillingAddOnKind = "ai_audio_minutes" | "cloud_storage";

export interface BillingAddOn {
  id: string;
  kind: BillingAddOnKind;
  name: string;
  aiAudioSeconds?: number;
  cloudStorageBytes?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreditBalance {
  userId: string;
  periodAiAudioSecondsGranted: number;
  periodAiAudioSecondsUsed: number;
  addonAiAudioSecondsRemaining: number;
  periodStartedAt: Date;
  periodEndsAt: Date;
  updatedAt: Date;
}

export interface StorageUsage {
  userId: string;
  cloudStorageBytesUsed: number;
  lastCalculatedAt: Date;
}

export interface UsageLedger {
  id: string;
  userId: string;
  bookId?: string;
  chapterId?: string;
  operationId: string;
  usageType: UsageType;
  quantity: number;
  unit: UsageUnit;
  status: UsageLedgerStatus;
  reason: string;
  idempotencyKey: string;
  createdAt: Date;
  committedAt?: Date;
}

export type ImportAttemptStatus = "started" | "ready" | "failed";

export interface ImportAttempt {
  id: string;
  jobId: string;
  chapterId: string;
  attemptIndex: number;
  status: ImportAttemptStatus;
  startedAt: Date;
  endedAt?: Date;
  errorCode?: string;
  isRetryable: boolean;
}

export interface AskCostDimensions {
  askTextTokensIn: number;
  askTextTokensOut: number;
  askSttSeconds: number;
  askTtsSeconds: number;
  askWebSearchCalls: number;
  askCostScore: number;
}

export type AskUsageStatus = "requested" | "delivered" | "canceled";

export interface AskUsageRecord {
  id: string;
  userId: string;
  operationId: string;
  idempotencyKey: string;
  status: AskUsageStatus;
  dimensions: AskCostDimensions;
  createdAt: Date;
  committedAt?: Date;
  canceledAt?: Date;
}

export interface EntitlementSnapshot {
  planId: PlanId;
  planStatus: PlanStatus;
  periodEndsAt: Date;
  aiAudioSecondsRemaining: number;
  aiAudioSecondsUsed: number;
  periodAiAudioSecondsGranted: number;
  addonAiAudioSecondsRemaining: number;
  cloudStorageBytesUsed: number;
  cloudStorageBytesLimit: number;
  askTier: AskFairUseTier;
  maxConcurrentImports: number;
  maxContextTokens: number;
}

export type FairUseAction =
  | "full_quality_answer"
  | "shorter_answer"
  | "text_only_answer"
  | "no_web_search"
  | "reduced_context_window"
  | "temporary_cooldown";

export interface AskPeriodStats {
  askCount: number;
  askCostScore: number;
}

export interface FairUsePolicyInput {
  tier: AskFairUseTier;
  periodStats: AskPeriodStats;
  recentAbuseIndicators?: number;
  currentServerLoad?: "normal" | "high";
}

export interface FairUsePolicyDecision {
  actions: FairUseAction[];
  reason: string;
}
