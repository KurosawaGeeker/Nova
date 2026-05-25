import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  BookImportStatus,
  BookManifest,
  BookRecord,
  ChapterImportRecord,
  CreateBookImportInput,
  ImportJobRecord,
} from "../types.js";
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
      jobKind: "single_url",
      normalizedUrl,
      sourceType: "url",
      status: "QUEUED",
      progress: 0,
      retryCount: 0,
      maxRetries: 2,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return job;
  }

  async createBookImport(input: CreateBookImportInput): Promise<{
    book: BookRecord;
    bookJob: ImportJobRecord;
    chapters: ChapterImportRecord[];
    chapterJobs: ImportJobRecord[];
  }> {
    const now = new Date().toISOString();
    const bookId = randomUUID();
    const bookJobId = randomUUID();
    const book: BookRecord = {
      id: bookId,
      title: input.title.trim(),
      kind: "web_book",
      sourceRootUrl: input.sourceRootUrl,
      status: "IMPORTING",
      chapterCount: input.chapters.length,
      readyChapterCount: 0,
      failedChapterCount: 0,
      durationMs: 0,
      importJobId: bookJobId,
      discoveryId: input.discoveryId,
      createdAt: now,
      updatedAt: now,
    };
    const bookJob: ImportJobRecord = {
      jobId: bookJobId,
      jobKind: "book_import",
      bookId,
      normalizedUrl: input.sourceRootUrl,
      sourceType: "url",
      status: "QUEUED",
      progress: 0,
      retryCount: 0,
      maxRetries: 2,
      createdAt: now,
      updatedAt: now,
    };
    const chapters = input.chapters.map((chapter): ChapterImportRecord => ({
      id: randomUUID(),
      bookId,
      index: chapter.index,
      title: chapter.title.trim(),
      sourceUrl: chapter.url,
      status: "QUEUED",
      progress: 0,
      durationMs: 0,
      playedPositionMs: 0,
      retryCount: 0,
      maxRetries: 2,
      createdAt: now,
      updatedAt: now,
    }));
    const priorityByChapterId = buildChapterPriorities(chapters);
    const chapterJobs = chapters.map((chapter): ImportJobRecord => {
      const jobId = randomUUID();
      chapter.remoteChapterJobId = jobId;
      return {
        jobId,
        jobKind: "chapter_import",
        bookId,
        chapterId: chapter.id,
        normalizedUrl: chapter.sourceUrl,
        sourceType: "url",
        status: "QUEUED",
        progress: 0,
        priority: priorityByChapterId.get(chapter.id) ?? 50,
        retryCount: 0,
        maxRetries: 2,
        createdAt: now,
        updatedAt: now,
      };
    });

    await this.saveBook(book);
    await this.saveJob(bookJob);
    await Promise.all([
      ...chapters.map((chapter) => this.saveChapter(chapter)),
      ...chapterJobs.map((job) => this.saveJob(job)),
    ]);
    return { book, bookJob, chapters, chapterJobs };
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

  async saveBook(book: BookRecord): Promise<void> {
    await writeJson(this.bookPath(book.id), book);
  }

  async getBook(bookId: string): Promise<BookRecord | null> {
    try {
      return await readJson<BookRecord>(this.bookPath(bookId));
    } catch {
      return null;
    }
  }

  async updateBook(
    bookId: string,
    patch: Partial<Omit<BookRecord, "id" | "createdAt">>,
  ): Promise<BookRecord> {
    const current = await this.getBook(bookId);
    if (!current) {
      throw new Error(`Book ${bookId} does not exist`);
    }
    const next: BookRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.saveBook(next);
    return next;
  }

  async saveChapter(chapter: ChapterImportRecord): Promise<void> {
    await writeJson(this.chapterPath(chapter.bookId, chapter.id), chapter);
  }

  async getChapter(
    bookId: string,
    chapterId: string,
  ): Promise<ChapterImportRecord | null> {
    try {
      return await readJson<ChapterImportRecord>(this.chapterPath(bookId, chapterId));
    } catch {
      return null;
    }
  }

  async getChapterJob(
    bookId: string,
    chapterId: string,
  ): Promise<ImportJobRecord | null> {
    const chapter = await this.getChapter(bookId, chapterId);
    if (chapter?.remoteChapterJobId) {
      const job = await this.getJob(chapter.remoteChapterJobId);
      if (
        job?.jobKind === "chapter_import" &&
        job.bookId === bookId &&
        job.chapterId === chapterId
      ) {
        return job;
      }
    }

    const entries = await fs.readdir(this.jobsDir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const job = await this.getJob(path.basename(entry, ".json"));
      if (
        job?.jobKind === "chapter_import" &&
        job.bookId === bookId &&
        job.chapterId === chapterId
      ) {
        return job;
      }
    }
    return null;
  }

  async listBookChapters(bookId: string): Promise<ChapterImportRecord[]> {
    const chaptersDir = path.join(this.booksDir, bookId, "chapters");
    const entries = await fs.readdir(chaptersDir).catch(() => []);
    const chapters = await Promise.all(
      entries.map(async (entry) => {
        const chapterId = path.basename(entry, ".json");
        return this.getChapter(bookId, chapterId);
      }),
    );
    return chapters
      .filter((chapter): chapter is ChapterImportRecord => chapter !== null)
      .sort((left, right) => left.index - right.index);
  }

  async updateChapter(
    bookId: string,
    chapterId: string,
    patch: Partial<Omit<ChapterImportRecord, "id" | "bookId" | "createdAt">>,
  ): Promise<ChapterImportRecord> {
    const current = await this.getChapter(bookId, chapterId);
    if (!current) {
      throw new Error(`Chapter ${chapterId} does not exist`);
    }
    const next: ChapterImportRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.saveChapter(next);
    return next;
  }

  async refreshBookAggregate(bookId: string): Promise<BookRecord> {
    const chapters = await this.listBookChapters(bookId);
    const readyChapterCount = chapters.filter(
      (chapter) => chapter.status === "READY",
    ).length;
    const failedChapterCount = chapters.filter(
      (chapter) => chapter.status === "FAILED",
    ).length;
    const durationMs = chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0);
    const status = deriveBookStatus({
      chapterCount: chapters.length,
      readyChapterCount,
      failedChapterCount,
    });

    return this.updateBook(bookId, {
      status,
      chapterCount: chapters.length,
      readyChapterCount,
      failedChapterCount,
      durationMs,
    });
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

  async allocateChapterDirectories(bookId: string, chapterId: string): Promise<{
    chapterDir: string;
    payloadDir: string;
    packagePath: string;
  }> {
    const chapterDir = path.join(this.booksDir, bookId, "chapter-packages", chapterId);
    const payloadDir = path.join(chapterDir, "payload");
    const packagePath = path.join(chapterDir, "package.zip");
    await ensureDir(payloadDir);
    return { chapterDir, payloadDir, packagePath };
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

  getChapterPackagePath(bookId: string, chapterId: string): string {
    return path.join(this.booksDir, bookId, "chapter-packages", chapterId, "package.zip");
  }

  getChapterPackageDownloadPath(bookId: string, chapterId: string): string {
    return `/v1/books/${bookId}/chapters/${chapterId}/package.zip`;
  }

  async removeChapterPackageArtifacts(
    bookId: string,
    chapterId: string,
  ): Promise<void> {
    await fs.rm(path.join(this.booksDir, bookId, "chapter-packages", chapterId), {
      recursive: true,
      force: true,
    });
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

      if (job.bookId && job.jobKind !== "chapter_import") {
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

  private bookPath(bookId: string): string {
    return path.join(this.booksDir, bookId, "book.json");
  }

  private chapterPath(bookId: string, chapterId: string): string {
    return path.join(this.booksDir, bookId, "chapters", `${chapterId}.json`);
  }
}

function buildChapterPriorities(
  chapters: ChapterImportRecord[],
): Map<string, number> {
  const ordered = [...chapters].sort((left, right) => left.index - right.index);
  return new Map(
    ordered.map((chapter, position) => {
      if (position === 0) {
        return [chapter.id, 100];
      }
      if (position <= 2) {
        return [chapter.id, 80];
      }
      return [chapter.id, Math.max(1, 50 - position)];
    }),
  );
}

function deriveBookStatus(input: {
  chapterCount: number;
  readyChapterCount: number;
  failedChapterCount: number;
}): BookImportStatus {
  if (input.chapterCount === 0) {
    return "FAILED";
  }
  if (input.readyChapterCount === input.chapterCount) {
    return "READY";
  }
  if (input.readyChapterCount > 0) {
    return "PARTIAL_READY";
  }
  if (input.failedChapterCount === input.chapterCount) {
    return "FAILED";
  }
  return "IMPORTING";
}
