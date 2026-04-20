import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { BookManifest, ImportJobRecord } from "../types.js";
import { ensureDir, readJson, writeJson } from "../utils/files.js";

export class FileBackedStore {
  readonly jobsDir: string;
  readonly booksDir: string;
  readonly tmpDir: string;

  constructor(private readonly dataDir: string) {
    this.jobsDir = path.join(dataDir, "jobs");
    this.booksDir = path.join(dataDir, "books");
    this.tmpDir = path.join(dataDir, "tmp");
  }

  async init(): Promise<void> {
    await Promise.all([
      ensureDir(this.dataDir),
      ensureDir(this.jobsDir),
      ensureDir(this.booksDir),
      ensureDir(this.tmpDir),
    ]);
  }

  async createUrlJob(normalizedUrl: string): Promise<ImportJobRecord> {
    const now = new Date().toISOString();
    const job: ImportJobRecord = {
      jobId: randomUUID(),
      normalizedUrl,
      sourceType: "url",
      status: "QUEUED",
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return job;
  }

  async saveJob(job: ImportJobRecord): Promise<void> {
    await writeJson(this.jobPath(job.jobId), job);
  }

  async getJob(jobId: string): Promise<ImportJobRecord | null> {
    try {
      return await readJson<ImportJobRecord>(this.jobPath(jobId));
    } catch {
      return null;
    }
  }

  async updateJob(
    jobId: string,
    patch: Partial<Omit<ImportJobRecord, "jobId" | "createdAt">>,
  ): Promise<ImportJobRecord> {
    const current = await this.getJob(jobId);
    if (!current) {
      throw new Error(`Job ${jobId} does not exist`);
    }
    const next: ImportJobRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.saveJob(next);
    return next;
  }

  async allocateBookDirectories(bookId: string): Promise<{
    bookDir: string;
    payloadDir: string;
    packagePath: string;
  }> {
    const bookDir = path.join(this.booksDir, bookId);
    const payloadDir = path.join(bookDir, "payload");
    const packagePath = path.join(bookDir, "package.zip");
    await ensureDir(payloadDir);
    return { bookDir, payloadDir, packagePath };
  }

  async createJobWorkDir(jobId: string): Promise<string> {
    const workDir = path.join(this.tmpDir, jobId);
    await fs.rm(workDir, { recursive: true, force: true });
    await ensureDir(workDir);
    return workDir;
  }

  async saveManifest(bookId: string, manifest: BookManifest): Promise<void> {
    const manifestPath = path.join(this.booksDir, bookId, "payload", "manifest.json");
    await writeJson(manifestPath, manifest);
  }

  getPackagePath(bookId: string): string {
    return path.join(this.booksDir, bookId, "package.zip");
  }

  getPackageDownloadPath(bookId: string): string {
    return `/v1/books/${bookId}/package.zip`;
  }

  async cleanupExpiredArtifacts(maxAgeHours: number): Promise<void> {
    const entries = await fs.readdir(this.jobsDir).catch(() => []);
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const job = await this.getJob(path.basename(entry, ".json"));
      if (!job) {
        continue;
      }

      const lastTouched = Date.parse(job.updatedAt);
      if (Number.isNaN(lastTouched) || lastTouched > cutoff) {
        continue;
      }

      if (job.bookId) {
        await fs.rm(path.join(this.booksDir, job.bookId), {
          recursive: true,
          force: true,
        });
      }
      await fs.rm(path.join(this.tmpDir, job.jobId), { recursive: true, force: true });
      await fs.rm(this.jobPath(job.jobId), { force: true });
    }
  }

  private jobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }
}
