import { evaluateAskFairUse } from "./fair-use-policy.js";
import { getInitialGrantSeconds, getPlan } from "./plan-catalog.js";
import type { BillingRepository } from "./repository.js";
import type {
  AskCostDimensions,
  AskUsageRecord,
  CreditBalance,
  EntitlementSnapshot,
  FairUsePolicyDecision,
  ImportAttempt,
  StorageUsage,
  UsageLedger,
  UserAccount,
} from "./types.js";

const emptyAskDimensions: AskCostDimensions = {
  askTextTokensIn: 0,
  askTextTokensOut: 0,
  askSttSeconds: 0,
  askTtsSeconds: 0,
  askWebSearchCalls: 0,
  askCostScore: 0,
};

export class BillingError extends Error {}

export class InsufficientCreditsError extends BillingError {}

export interface CommitAudioUsageInput {
  userId: string;
  bookId?: string;
  chapterId?: string;
  operationId: string;
  actualAudioSeconds: number;
  idempotencyKey: string;
  reason?: string;
}

export interface FinalizeImportUsageInput extends CommitAudioUsageInput {
  ready: boolean;
}

export interface RecordAskUsageInput {
  userId: string;
  operationId: string;
  idempotencyKey: string;
  delivered: boolean;
  dimensions?: Partial<AskCostDimensions>;
}

export class BillingService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getOrCreateCreditBalance(account: UserAccount): CreditBalance {
    const existing = this.repository.getCreditBalance(account.id);
    const plan = getPlan(account.planId);
    const timestamp = this.now();

    if (existing === undefined) {
      const balance: CreditBalance = {
        userId: account.id,
        periodAiAudioSecondsGranted: getInitialGrantSeconds(plan),
        periodAiAudioSecondsUsed: 0,
        addonAiAudioSecondsRemaining: 0,
        periodStartedAt: account.currentPeriodStart,
        periodEndsAt: account.currentPeriodEnd,
        updatedAt: timestamp,
      };
      this.repository.saveCreditBalance(balance);
      this.repository.appendLedger({
        id: this.makeId("ledger"),
        userId: account.id,
        operationId: `credit-grant:${account.currentPeriodStart.toISOString()}`,
        usageType: "credit_grant",
        quantity: balance.periodAiAudioSecondsGranted,
        unit: "seconds",
        status: "committed",
        reason: "period_credit_grant",
        idempotencyKey: `credit-grant:${account.id}:${account.currentPeriodStart.toISOString()}`,
        createdAt: timestamp,
        committedAt: timestamp,
      });
      return balance;
    }

    if (existing.periodStartedAt.getTime() !== account.currentPeriodStart.getTime()) {
      const resetBalance: CreditBalance = {
        ...existing,
        periodAiAudioSecondsGranted: plan.monthlyAiAudioSeconds,
        periodAiAudioSecondsUsed: 0,
        periodStartedAt: account.currentPeriodStart,
        periodEndsAt: account.currentPeriodEnd,
        updatedAt: timestamp,
      };
      this.repository.saveCreditBalance(resetBalance);
      this.repository.appendLedger({
        id: this.makeId("ledger"),
        userId: account.id,
        operationId: `credit-reset:${account.currentPeriodStart.toISOString()}`,
        usageType: "credit_grant",
        quantity: resetBalance.periodAiAudioSecondsGranted,
        unit: "seconds",
        status: "committed",
        reason: "monthly_credit_reset",
        idempotencyKey: `credit-reset:${account.id}:${account.currentPeriodStart.toISOString()}`,
        createdAt: timestamp,
        committedAt: timestamp,
      });
      return resetBalance;
    }

    return existing;
  }

  getEntitlements(account: UserAccount): EntitlementSnapshot {
    const plan = getPlan(account.planId);
    const balance = this.getOrCreateCreditBalance(account);
    const storageUsage = this.repository.getStorageUsage(account.id) ?? this.defaultStorageUsage(account.id);
    const periodRemaining = Math.max(0, balance.periodAiAudioSecondsGranted - balance.periodAiAudioSecondsUsed);

    return {
      planId: account.planId,
      planStatus: account.planStatus,
      periodEndsAt: account.currentPeriodEnd,
      aiAudioSecondsRemaining: periodRemaining + balance.addonAiAudioSecondsRemaining,
      aiAudioSecondsUsed: balance.periodAiAudioSecondsUsed,
      periodAiAudioSecondsGranted: balance.periodAiAudioSecondsGranted,
      addonAiAudioSecondsRemaining: balance.addonAiAudioSecondsRemaining,
      cloudStorageBytesUsed: storageUsage.cloudStorageBytesUsed,
      cloudStorageBytesLimit: plan.cloudStorageBytes,
      askTier: plan.askFairUseTier,
      maxConcurrentImports: plan.maxConcurrentImports,
      maxContextTokens: plan.maxContextTokens,
    };
  }

  addAddonAudioCredits(userId: string, seconds: number): CreditBalance {
    if (seconds <= 0) {
      throw new BillingError("Add-on credit seconds must be positive.");
    }
    const balance = this.requireCreditBalance(userId);
    const updated = {
      ...balance,
      addonAiAudioSecondsRemaining: balance.addonAiAudioSecondsRemaining + seconds,
      updatedAt: this.now(),
    };
    this.repository.saveCreditBalance(updated);
    return updated;
  }

  commitAudioUsage(input: CommitAudioUsageInput): UsageLedger {
    const existing = this.repository.findLedgerByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    const seconds = Math.ceil(input.actualAudioSeconds);
    if (seconds <= 0) {
      throw new BillingError("Audio usage seconds must be positive.");
    }

    const balance = this.requireCreditBalance(input.userId);
    const periodRemaining = Math.max(0, balance.periodAiAudioSecondsGranted - balance.periodAiAudioSecondsUsed);
    const totalRemaining = periodRemaining + balance.addonAiAudioSecondsRemaining;
    if (totalRemaining < seconds) {
      throw new InsufficientCreditsError("Insufficient AI audio credits.");
    }

    const periodSecondsUsed = Math.min(periodRemaining, seconds);
    const addonSecondsUsed = seconds - periodSecondsUsed;
    const timestamp = this.now();
    this.repository.saveCreditBalance({
      ...balance,
      periodAiAudioSecondsUsed: balance.periodAiAudioSecondsUsed + periodSecondsUsed,
      addonAiAudioSecondsRemaining: balance.addonAiAudioSecondsRemaining - addonSecondsUsed,
      updatedAt: timestamp,
    });

    const ledger: UsageLedger = {
      id: this.makeId("ledger"),
      userId: input.userId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      operationId: input.operationId,
      usageType: "audio_generation",
      quantity: seconds,
      unit: "seconds",
      status: "committed",
      reason: input.reason ?? "audio_ready",
      idempotencyKey: input.idempotencyKey,
      createdAt: timestamp,
      committedAt: timestamp,
    };
    this.repository.appendLedger(ledger);
    return ledger;
  }

  finalizeImportUsage(input: FinalizeImportUsageInput): UsageLedger {
    if (input.ready) {
      return this.commitAudioUsage(input);
    }

    const existing = this.repository.findLedgerByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    const timestamp = this.now();
    const ledger: UsageLedger = {
      id: this.makeId("ledger"),
      userId: input.userId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      operationId: input.operationId,
      usageType: "audio_generation",
      quantity: 0,
      unit: "seconds",
      status: "canceled",
      reason: "import_exhausted_without_ready_audio",
      idempotencyKey: input.idempotencyKey,
      createdAt: timestamp,
    };
    this.repository.appendLedger(ledger);
    return ledger;
  }

  recordImportAttempt(attempt: Omit<ImportAttempt, "id"> & { id?: string }): ImportAttempt {
    const savedAttempt: ImportAttempt = {
      ...attempt,
      id: attempt.id ?? this.makeId("attempt"),
    };
    this.repository.saveImportAttempt(savedAttempt);
    return savedAttempt;
  }

  recordAskUsage(input: RecordAskUsageInput): { record: AskUsageRecord; policy: FairUsePolicyDecision } {
    const existing = this.repository.findAskUsageByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      return { record: existing, policy: this.evaluateFairUseForUser(input.userId, "free") };
    }

    const timestamp = this.now();
    const record: AskUsageRecord = {
      id: this.makeId("ask"),
      userId: input.userId,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      status: input.delivered ? "delivered" : "canceled",
      dimensions: { ...emptyAskDimensions, ...input.dimensions },
      createdAt: timestamp,
      committedAt: input.delivered ? timestamp : undefined,
      canceledAt: input.delivered ? undefined : timestamp,
    };
    this.repository.saveAskUsage(record);

    this.repository.appendLedger({
      id: this.makeId("ledger"),
      userId: input.userId,
      operationId: input.operationId,
      usageType: "ask",
      quantity: input.delivered ? 1 : 0,
      unit: "count",
      status: input.delivered ? "committed" : "canceled",
      reason: input.delivered ? "ask_delivered" : "ask_not_delivered",
      idempotencyKey: input.idempotencyKey,
      createdAt: timestamp,
      committedAt: input.delivered ? timestamp : undefined,
    });

    return { record, policy: this.evaluateFairUseForUser(input.userId, "free") };
  }

  evaluateFairUseForUser(userId: string, tier: "free" | "starter" | "pro" | "heavy"): FairUsePolicyDecision {
    const delivered = this.repository.listAskUsage(userId).filter((record) => record.status === "delivered");
    return evaluateAskFairUse({
      tier,
      periodStats: {
        askCount: delivered.length,
        askCostScore: delivered.reduce((sum, record) => sum + record.dimensions.askCostScore, 0),
      },
    });
  }

  setStorageUsage(userId: string, cloudStorageBytesUsed: number): StorageUsage {
    if (cloudStorageBytesUsed < 0) {
      throw new BillingError("Cloud storage usage cannot be negative.");
    }
    const usage: StorageUsage = {
      userId,
      cloudStorageBytesUsed,
      lastCalculatedAt: this.now(),
    };
    this.repository.saveStorageUsage(usage);
    return usage;
  }

  private requireCreditBalance(userId: string): CreditBalance {
    const balance = this.repository.getCreditBalance(userId);
    if (balance === undefined) {
      throw new BillingError("Credit balance must be initialized before usage is committed.");
    }
    return balance;
  }

  private defaultStorageUsage(userId: string): StorageUsage {
    return {
      userId,
      cloudStorageBytesUsed: 0,
      lastCalculatedAt: this.now(),
    };
  }

  private makeId(prefix: string): string {
    return `${prefix}_${this.now().getTime()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
