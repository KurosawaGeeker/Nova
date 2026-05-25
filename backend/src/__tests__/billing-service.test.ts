import { describe, expect, it } from "vitest";

import {
  BillingService,
  evaluateAskFairUse,
  getPlan,
  InMemoryBillingRepository,
  PLAN_CATALOG,
  type UserAccount,
} from "../billing/index.js";

function makeAccount(overrides: Partial<UserAccount> = {}): UserAccount {
  const periodStart = new Date("2026-04-01T00:00:00.000Z");
  const periodEnd = new Date("2026-05-01T00:00:00.000Z");
  return {
    id: "user_1",
    createdAt: periodStart,
    updatedAt: periodStart,
    billingRegion: "CN",
    planId: "free",
    planStatus: "free",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    ...overrides,
  };
}

function makeService(now = new Date("2026-04-10T00:00:00.000Z")): {
  repository: InMemoryBillingRepository;
  service: BillingService;
} {
  const repository = new InMemoryBillingRepository();
  const service = new BillingService(repository, () => now);
  return { repository, service };
}

describe("billing plan catalog and entitlements", () => {
  it("calculates plan entitlements from catalog data", () => {
    const { service } = makeService();
    const account = makeAccount({
      planId: "pro",
      planStatus: "active",
      currentPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
    });
    service.setStorageUsage(account.id, 1024);

    const entitlements = service.getEntitlements(account);

    expect(Object.keys(PLAN_CATALOG)).toEqual(["free", "starter", "pro", "heavy"]);
    expect(entitlements.planId).toBe("pro");
    expect(entitlements.aiAudioSecondsRemaining).toBe(300 * 60);
    expect(entitlements.cloudStorageBytesLimit).toBe(10 * 1024 * 1024 * 1024);
    expect(entitlements.cloudStorageBytesUsed).toBe(1024);
    expect(entitlements.askTier).toBe("pro");
    expect(entitlements.maxConcurrentImports).toBe(getPlan("pro").maxConcurrentImports);
  });

  it("grants free users first-month AI audio credits", () => {
    const { service } = makeService();
    const account = makeAccount();

    const balance = service.getOrCreateCreditBalance(account);

    expect(balance.periodAiAudioSecondsGranted).toBe(30 * 60);
    expect(balance.periodAiAudioSecondsUsed).toBe(0);
  });

  it("resets monthly period credits without removing add-on credits", () => {
    const { service } = makeService();
    const firstPeriod = makeAccount();
    service.getOrCreateCreditBalance(firstPeriod);
    service.addAddonAudioCredits(firstPeriod.id, 500);
    service.commitAudioUsage({
      userId: firstPeriod.id,
      operationId: "chapter_1",
      actualAudioSeconds: 300,
      idempotencyKey: "audio:chapter_1",
    });

    const nextPeriod = makeAccount({
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
    });
    const reset = service.getOrCreateCreditBalance(nextPeriod);

    expect(reset.periodAiAudioSecondsGranted).toBe(10 * 60);
    expect(reset.periodAiAudioSecondsUsed).toBe(0);
    expect(reset.addonAiAudioSecondsRemaining).toBe(500);
  });

  it("consumes add-on credits after period credits", () => {
    const { service } = makeService();
    const account = makeAccount();
    service.getOrCreateCreditBalance(account);
    service.addAddonAudioCredits(account.id, 300);

    service.commitAudioUsage({
      userId: account.id,
      operationId: "long_audio",
      actualAudioSeconds: 1_900,
      idempotencyKey: "audio:long_audio",
    });

    const entitlements = service.getEntitlements(account);
    expect(entitlements.periodAiAudioSecondsGranted).toBe(1_800);
    expect(entitlements.aiAudioSecondsUsed).toBe(1_800);
    expect(entitlements.addonAiAudioSecondsRemaining).toBe(200);
    expect(entitlements.aiAudioSecondsRemaining).toBe(200);
  });
});

describe("billing usage ledger", () => {
  it("commits audio usage idempotently", () => {
    const { repository, service } = makeService();
    const account = makeAccount();
    service.getOrCreateCreditBalance(account);

    const first = service.commitAudioUsage({
      userId: account.id,
      bookId: "book_1",
      chapterId: "chapter_1",
      operationId: "operation_1",
      actualAudioSeconds: 120.2,
      idempotencyKey: "audio:operation_1",
    });
    const second = service.commitAudioUsage({
      userId: account.id,
      bookId: "book_1",
      chapterId: "chapter_1",
      operationId: "operation_1",
      actualAudioSeconds: 120.2,
      idempotencyKey: "audio:operation_1",
    });

    const entitlements = service.getEntitlements(account);
    const audioLedgers = repository.listLedger(account.id).filter((entry) => entry.usageType === "audio_generation");
    expect(first.id).toBe(second.id);
    expect(first.quantity).toBe(121);
    expect(entitlements.aiAudioSecondsUsed).toBe(121);
    expect(audioLedgers).toHaveLength(1);
  });

  it("charges a successful retry once", () => {
    const { repository, service } = makeService();
    const account = makeAccount();
    service.getOrCreateCreditBalance(account);
    service.recordImportAttempt({
      jobId: "job_1",
      chapterId: "chapter_1",
      attemptIndex: 0,
      status: "failed",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      endedAt: new Date("2026-04-10T00:01:00.000Z"),
      errorCode: "TTS_TIMEOUT",
      isRetryable: true,
    });
    service.recordImportAttempt({
      jobId: "job_1",
      chapterId: "chapter_1",
      attemptIndex: 1,
      status: "ready",
      startedAt: new Date("2026-04-10T00:02:00.000Z"),
      endedAt: new Date("2026-04-10T00:03:00.000Z"),
      isRetryable: false,
    });

    service.finalizeImportUsage({
      userId: account.id,
      chapterId: "chapter_1",
      operationId: "job_1:chapter_1",
      actualAudioSeconds: 240,
      idempotencyKey: "audio:job_1:chapter_1",
      ready: true,
    });
    service.finalizeImportUsage({
      userId: account.id,
      chapterId: "chapter_1",
      operationId: "job_1:chapter_1",
      actualAudioSeconds: 240,
      idempotencyKey: "audio:job_1:chapter_1",
      ready: true,
    });

    const audioLedgers = repository.listLedger(account.id).filter((entry) => entry.usageType === "audio_generation");
    expect(audioLedgers).toHaveLength(1);
    expect(audioLedgers[0]?.status).toBe("committed");
    expect(service.getEntitlements(account).aiAudioSecondsUsed).toBe(240);
    expect(repository.listImportAttempts("job_1", "chapter_1")).toHaveLength(2);
  });

  it("does not charge when retries are exhausted without ready audio", () => {
    const { repository, service } = makeService();
    const account = makeAccount();
    service.getOrCreateCreditBalance(account);
    service.recordImportAttempt({
      jobId: "job_2",
      chapterId: "chapter_2",
      attemptIndex: 0,
      status: "failed",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      endedAt: new Date("2026-04-10T00:01:00.000Z"),
      errorCode: "PACKAGING_FAILED",
      isRetryable: true,
    });
    service.recordImportAttempt({
      jobId: "job_2",
      chapterId: "chapter_2",
      attemptIndex: 1,
      status: "failed",
      startedAt: new Date("2026-04-10T00:02:00.000Z"),
      endedAt: new Date("2026-04-10T00:03:00.000Z"),
      errorCode: "PACKAGING_FAILED",
      isRetryable: false,
    });

    const ledger = service.finalizeImportUsage({
      userId: account.id,
      chapterId: "chapter_2",
      operationId: "job_2:chapter_2",
      actualAudioSeconds: 240,
      idempotencyKey: "audio:job_2:chapter_2",
      ready: false,
    });

    expect(ledger.status).toBe("canceled");
    expect(ledger.quantity).toBe(0);
    expect(service.getEntitlements(account).aiAudioSecondsUsed).toBe(0);
    expect(repository.listLedger(account.id).filter((entry) => entry.usageType === "audio_generation")).toHaveLength(1);
  });
});

describe("ask usage and fair use", () => {
  it("commits ask usage only when delivered", () => {
    const { repository, service } = makeService();
    const delivered = service.recordAskUsage({
      userId: "user_ask",
      operationId: "ask_1",
      idempotencyKey: "ask:1",
      delivered: true,
      dimensions: {
        askTextTokensIn: 100,
        askTextTokensOut: 250,
        askSttSeconds: 4,
        askTtsSeconds: 8,
        askWebSearchCalls: 1,
        askCostScore: 20,
      },
    });

    expect(delivered.record.status).toBe("delivered");
    expect(delivered.record.dimensions.askCostScore).toBe(20);
    expect(repository.listLedger("user_ask").find((entry) => entry.usageType === "ask")?.status).toBe("committed");
  });

  it("cancels failed ask usage", () => {
    const { repository, service } = makeService();
    const canceled = service.recordAskUsage({
      userId: "user_ask",
      operationId: "ask_2",
      idempotencyKey: "ask:2",
      delivered: false,
      dimensions: {
        askTextTokensIn: 100,
        askCostScore: 10,
      },
    });

    const ledger = repository.listLedger("user_ask").find((entry) => entry.idempotencyKey === "ask:2");
    expect(canceled.record.status).toBe("canceled");
    expect(canceled.record.committedAt).toBeUndefined();
    expect(ledger?.status).toBe("canceled");
    expect(ledger?.quantity).toBe(0);
  });

  it("returns graceful fair-use degradation rules", () => {
    const freeDecision = evaluateAskFairUse({
      tier: "free",
      periodStats: {
        askCount: 30,
        askCostScore: 90,
      },
    });
    const heavyDecision = evaluateAskFairUse({
      tier: "heavy",
      periodStats: {
        askCount: 30,
        askCostScore: 90,
      },
    });
    const abuseDecision = evaluateAskFairUse({
      tier: "pro",
      periodStats: {
        askCount: 1,
        askCostScore: 1,
      },
      recentAbuseIndicators: 2,
      currentServerLoad: "high",
    });

    expect(freeDecision.actions).toContain("shorter_answer");
    expect(freeDecision.actions).not.toContain("temporary_cooldown");
    expect(heavyDecision.actions).toEqual(["full_quality_answer"]);
    expect(abuseDecision.actions).toEqual(["reduced_context_window", "temporary_cooldown"]);
  });
});
