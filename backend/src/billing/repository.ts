import type { AskUsageRecord, CreditBalance, ImportAttempt, StorageUsage, UsageLedger } from "./types.js";

export interface BillingRepository {
  getCreditBalance(userId: string): CreditBalance | undefined;
  saveCreditBalance(balance: CreditBalance): void;
  getStorageUsage(userId: string): StorageUsage | undefined;
  saveStorageUsage(usage: StorageUsage): void;
  findLedgerByIdempotencyKey(idempotencyKey: string): UsageLedger | undefined;
  appendLedger(entry: UsageLedger): void;
  listLedger(userId: string): UsageLedger[];
  saveImportAttempt(attempt: ImportAttempt): void;
  listImportAttempts(jobId: string, chapterId?: string): ImportAttempt[];
  findAskUsageByIdempotencyKey(idempotencyKey: string): AskUsageRecord | undefined;
  saveAskUsage(record: AskUsageRecord): void;
  listAskUsage(userId: string): AskUsageRecord[];
}

export class InMemoryBillingRepository implements BillingRepository {
  private readonly creditBalances = new Map<string, CreditBalance>();
  private readonly storageUsages = new Map<string, StorageUsage>();
  private readonly ledgers = new Map<string, UsageLedger>();
  private readonly ledgerIdsByUser = new Map<string, string[]>();
  private readonly importAttempts: ImportAttempt[] = [];
  private readonly askUsage = new Map<string, AskUsageRecord>();
  private readonly askIdsByUser = new Map<string, string[]>();

  getCreditBalance(userId: string): CreditBalance | undefined {
    return this.creditBalances.get(userId);
  }

  saveCreditBalance(balance: CreditBalance): void {
    this.creditBalances.set(balance.userId, { ...balance });
  }

  getStorageUsage(userId: string): StorageUsage | undefined {
    return this.storageUsages.get(userId);
  }

  saveStorageUsage(usage: StorageUsage): void {
    this.storageUsages.set(usage.userId, { ...usage });
  }

  findLedgerByIdempotencyKey(idempotencyKey: string): UsageLedger | undefined {
    for (const ledger of this.ledgers.values()) {
      if (ledger.idempotencyKey === idempotencyKey) {
        return { ...ledger };
      }
    }
    return undefined;
  }

  appendLedger(entry: UsageLedger): void {
    this.ledgers.set(entry.id, { ...entry });
    const userLedgerIds = this.ledgerIdsByUser.get(entry.userId) ?? [];
    userLedgerIds.push(entry.id);
    this.ledgerIdsByUser.set(entry.userId, userLedgerIds);
  }

  listLedger(userId: string): UsageLedger[] {
    const ids = this.ledgerIdsByUser.get(userId) ?? [];
    return ids.map((id) => this.ledgers.get(id)).filter((entry): entry is UsageLedger => entry !== undefined);
  }

  saveImportAttempt(attempt: ImportAttempt): void {
    this.importAttempts.push({ ...attempt });
  }

  listImportAttempts(jobId: string, chapterId?: string): ImportAttempt[] {
    return this.importAttempts
      .filter((attempt) => attempt.jobId === jobId && (chapterId === undefined || attempt.chapterId === chapterId))
      .map((attempt) => ({ ...attempt }));
  }

  findAskUsageByIdempotencyKey(idempotencyKey: string): AskUsageRecord | undefined {
    const record = this.askUsage.get(idempotencyKey);
    return record === undefined ? undefined : { ...record };
  }

  saveAskUsage(record: AskUsageRecord): void {
    const existing = this.askUsage.get(record.idempotencyKey);
    this.askUsage.set(record.idempotencyKey, { ...record });
    if (existing === undefined) {
      const userAskIds = this.askIdsByUser.get(record.userId) ?? [];
      userAskIds.push(record.idempotencyKey);
      this.askIdsByUser.set(record.userId, userAskIds);
    }
  }

  listAskUsage(userId: string): AskUsageRecord[] {
    const ids = this.askIdsByUser.get(userId) ?? [];
    return ids.map((id) => this.askUsage.get(id)).filter((record): record is AskUsageRecord => record !== undefined);
  }
}
