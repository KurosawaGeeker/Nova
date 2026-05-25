import fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  BillingService,
  InMemoryBillingRepository,
  LocalDemoBillingAccountService,
} from "../billing/index.js";
import { registerBillingRoutes } from "../routes/billing.js";

const NOW = new Date("2026-04-27T00:00:00.000Z");

function buildApp() {
  const app = fastify();
  const repository = new InMemoryBillingRepository();
  const billingService = new BillingService(repository, () => NOW);
  const accountService = new LocalDemoBillingAccountService({
    now: () => NOW,
  });

  return {
    app,
    register: () => registerBillingRoutes(app, billingService, accountService),
  };
}

describe("billing routes", () => {
  it("returns the read-only plan catalog and add-ons", async () => {
    const { app, register } = buildApp();
    await register();

    const response = await app.inject({
      method: "GET",
      url: "/v1/billing/plans",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      mode: "local_demo",
      paymentIntegration: false,
    });
    expect(body.plans.map((plan: { id: string }) => plan.id)).toEqual([
      "free",
      "starter",
      "pro",
      "heavy",
    ]);
    expect(body.plans[0]).toMatchObject({
      id: "free",
      cloudStorageBytes: 1 * 1024 * 1024 * 1024,
      cloudStorageGb: 1,
      monthlyAiAudioSeconds: 10 * 60,
      firstMonthAiAudioSeconds: 30 * 60,
      askFairUseTier: "free",
      askFairUse: {
        hardQuota: false,
        userFacingLimit: "fair_use",
      },
    });
    expect(body.addOns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "audio_minutes_100",
          kind: "ai_audio_minutes",
          aiAudioSeconds: 100 * 60,
          aiAudioMinutes: 100,
          purchaseAvailable: false,
        }),
        expect.objectContaining({
          id: "cloud_storage_20gb",
          kind: "cloud_storage",
          cloudStorageBytes: 20 * 1024 * 1024 * 1024,
          cloudStorageGb: 20,
          purchaseAvailable: false,
        }),
      ]),
    );
    expect(body.limitations.join(" ")).toContain("No payment provider");

    await app.close();
  });

  it("returns a free local demo entitlement snapshot", async () => {
    const { app, register } = buildApp();
    await register();

    const response = await app.inject({
      method: "GET",
      url: "/v1/billing/entitlements",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      mode: "local_demo",
      paymentIntegration: false,
      accountId: "local_demo_account",
      billingRegion: "GLOBAL",
      planId: "free",
      planStatus: "free",
      currentPeriodStart: "2026-04-27T00:00:00.000Z",
      periodEndsAt: "2026-05-27T00:00:00.000Z",
      aiAudioSecondsRemaining: 30 * 60,
      aiAudioSecondsUsed: 0,
      periodAiAudioSecondsGranted: 30 * 60,
      addonAiAudioSecondsRemaining: 0,
      cloudStorageBytesUsed: 0,
      cloudStorageBytesLimit: 1 * 1024 * 1024 * 1024,
      askTier: "free",
      maxConcurrentImports: 1,
    });
    expect(body.aiAudio).toMatchObject({
      secondsRemaining: 30 * 60,
      periodSecondsGranted: 30 * 60,
      minutesRemaining: 30,
      failedImportsCharged: false,
      failedAskCharged: false,
    });
    expect(body.cloudStorage).toMatchObject({
      bytesUsed: 0,
      bytesLimit: 1 * 1024 * 1024 * 1024,
      gbLimit: 1,
      localOnlyFilesCountAgainstLimit: false,
    });
    expect(body.askFairUse).toMatchObject({
      tier: "free",
      hardQuota: false,
      userFacingLimit: "fair_use",
      currentPolicy: {
        actions: ["full_quality_answer"],
        reason: "within_fair_use",
      },
    });
    expect(body.askFairUse.trackedDimensions).toContain("ask_cost_score");
    expect(body.limitations.join(" ")).toContain("quota enforcement");

    await app.close();
  });
});
