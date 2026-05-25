import type { BillingRegion, PlanId, PlanStatus, UserAccount } from "./types.js";

export const LOCAL_DEMO_BILLING_ACCOUNT_ID = "local_demo_account";

export interface LocalDemoBillingAccountOptions {
  accountId?: string;
  billingRegion?: BillingRegion;
  planId?: PlanId;
  planStatus?: PlanStatus;
  now?: () => Date;
}

export class LocalDemoBillingAccountService {
  private account: UserAccount;
  private readonly now: () => Date;

  constructor(options: LocalDemoBillingAccountOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const createdAt = this.now();
    const planId = options.planId ?? "free";

    this.account = {
      id: options.accountId ?? LOCAL_DEMO_BILLING_ACCOUNT_ID,
      createdAt,
      updatedAt: createdAt,
      billingRegion: options.billingRegion ?? "GLOBAL",
      planId,
      planStatus: options.planStatus ?? "free",
      currentPeriodStart: createdAt,
      currentPeriodEnd: addBillingMonth(createdAt),
    };
  }

  getAccount(): UserAccount {
    this.advancePeriodIfNeeded();
    return cloneAccount(this.account);
  }

  private advancePeriodIfNeeded(): void {
    const timestamp = this.now();
    let periodStart = this.account.currentPeriodStart;
    let periodEnd = this.account.currentPeriodEnd;

    while (periodEnd.getTime() <= timestamp.getTime()) {
      periodStart = periodEnd;
      periodEnd = addBillingMonth(periodStart);
    }

    if (periodStart.getTime() !== this.account.currentPeriodStart.getTime()) {
      this.account = {
        ...this.account,
        updatedAt: timestamp,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      };
    }
  }
}

function addBillingMonth(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function cloneAccount(account: UserAccount): UserAccount {
  return {
    ...account,
    createdAt: new Date(account.createdAt.getTime()),
    updatedAt: new Date(account.updatedAt.getTime()),
    currentPeriodStart: new Date(account.currentPeriodStart.getTime()),
    currentPeriodEnd: new Date(account.currentPeriodEnd.getTime()),
  };
}
