import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { buildChapters } from "../utils/chapterizer.js";
import { concatenateToM4a } from "../utils/audio.js";
import { createZip, downloadToFile, ensureDir } from "../utils/files.js";
import { buildSemanticSegments } from "../utils/semantic-script.js";
import { buildWebVtt } from "../utils/vtt.js";
import type {
  BookManifest,
  BookRecord,
  ChapterManifest,
  ChapterImportRecord,
  ChapterImportStatus,
  ChapterPlan,
  CreateBookImportInput,
  CreateBookImportResult,
  ImportStatus,
  ImportJobRecord,
  SentenceCue,
} from "../types.js";
import { FileBackedStore } from "../storage/store.js";
import { WebpageExtractor } from "./webpage-extractor.js";
import type { TtsClient } from "../tts/tts-client.js";
import { ContentPreprocessor } from "./content-preprocessor.js";
import { AudioScriptAdapter } from "./audio-script-adapter.js";

const DEFAULT_CHAPTER_MAX_RETRIES = 2;
const MANUAL_CHAPTER_PRIORITY = 1_000;

type ChapterActionResult =
  | {
      ok: true;
      bookId: string;
      chapterId: string;
      jobId: string;
      status: ChapterImportStatus;
      jobStatus: ImportStatus;
      priority: number;
      retryCount: number;
      maxRetries: number;
      message: string;
    }
  | {
      ok: false;
      statusCode: 404 | 409;
      code:
        | "book_not_found"
        | "chapter_not_found"
        | "chapter_job_not_found"
        | "chapter_not_retryable"
        | "chapter_retry_limit_exceeded"
        | "chapter_not_prioritizable";
      message: string;
      status?: ChapterImportStatus;
      jobStatus?: ImportStatus;
      retryCount?: number;
      maxRetries?: number;
    };

type ChapterActionContext =
  | {
      ok: true;
      book: BookRecord;
      chapter: ChapterImportRecord;
      job: ImportJobRecord;
    }
  | Extract<ChapterActionResult, { ok: false }>;

export class ImportService {
  private readonly pendingJobs: Array<{ jobId: string; priority: number }> = [];
  private activeJobs = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly store: FileBackedStore,
    private readonly extractor: WebpageExtractor,
    private readonly contentPreprocessor: ContentPreprocessor,
    private readonly audioScriptAdapter: AudioScriptAdapter,
    private readonly ttsClient: TtsClient,
  ) {}

  async submitUrl(inputUrl: string): Promise<ImportJobRecord> {
    const normalizedUrl = normalizeUrl(inputUrl);
    const job = await this.store.createUrlJob(normalizedUrl);
    this.enqueue(job.jobId);
    return job;
  }

  async submitBookImport(input: CreateBookImportInput): Promise<CreateBookImportResult> {
    const normalizedInput = normalizeBookImportInput(input);
    const { book, bookJob, chapters, chapterJobs } =
      await this.store.createBookImport(normalizedInput);

    await this.store.updateJob(bookJob.jobId, {
      status: "FETCHING",
      progress: 0,
    });
    await this.store.refreshBookAggregate(book.id);

    for (const job of [...chapterJobs].sort(compareJobsByPriority)) {
      this.enqueue(job.jobId, job.priority ?? 0);
    }

    return {
      bookId: book.id,
      jobId: bookJob.jobId,
      chapterJobs: chapters.map((chapter) => ({
        chapterId: chapter.id,
        index: chapter.index,
        status: chapter.status,
      })),
    };
  }

  async getJob(jobId: string): Promise<ImportJobRecord | null> {
    return this.store.getJob(jobId);
  }

  async getBookStatus(bookId: string): Promise<{
    bookId: string;
    title: string;
    status: string;
    chapterCount: number;
    readyChapterCount: number;
    failedChapterCount: number;
    durationMs: number;
    chapters: Array<{
      chapterId: string;
      index: number;
      title: string;
      status: string;
      progress: number;
      durationMs: number;
      retryCount: number;
      maxRetries: number;
      nextRetryAt?: string;
      errorMessage?: string;
      downloadUrl?: string;
    }>;
  } | null> {
    const book = await this.store.getBook(bookId);
    if (!book) {
      return null;
    }
    const chapters = await this.store.listBookChapters(bookId);
    return {
      bookId: book.id,
      title: book.title,
      status: book.status,
      chapterCount: book.chapterCount,
      readyChapterCount: book.readyChapterCount,
      failedChapterCount: book.failedChapterCount,
      durationMs: book.durationMs,
      chapters: chapters.map((chapter) => ({
        chapterId: chapter.id,
        index: chapter.index,
        title: chapter.title,
        status: chapter.status,
        progress: chapter.progress,
        durationMs: chapter.durationMs,
        retryCount: chapter.retryCount,
        maxRetries: chapter.maxRetries,
        nextRetryAt: chapter.nextRetryAt,
        errorMessage: chapter.errorMessage,
        downloadUrl:
          chapter.status === "READY"
            ? `${this.config.publicBaseUrl}${this.store.getChapterPackageDownloadPath(
                book.id,
                chapter.id,
              )}`
            : undefined,
      })),
    };
  }

  async getPackagePath(bookId: string): Promise<string | null> {
    const packagePath = this.store.getPackagePath(bookId);
    try {
      await fs.access(packagePath);
      return packagePath;
    } catch {
      return null;
    }
  }

  async getChapterPackagePath(
    bookId: string,
    chapterId: string,
  ): Promise<string | null> {
    const packagePath = this.store.getChapterPackagePath(bookId, chapterId);
    try {
      await fs.access(packagePath);
      return packagePath;
    } catch {
      return null;
    }
  }

  async retryChapterImport(
    bookId: string,
    chapterId: string,
  ): Promise<ChapterActionResult> {
    const context = await this.getChapterActionContext(bookId, chapterId);
    if (!context.ok) {
      return context;
    }

    const { chapter, job } = context;
    if (chapter.status === "READY" || job.status === "READY") {
      return {
        ok: false,
        statusCode: 409,
        code: "chapter_not_retryable",
        message: "Ready chapters cannot be retried",
        status: chapter.status,
        jobStatus: job.status,
        retryCount: Math.max(chapter.retryCount ?? 0, job.retryCount ?? 0),
        maxRetries: resolveChapterMaxRetries(job, chapter),
      };
    }

    if (chapter.status !== "FAILED" && job.status !== "FAILED") {
      return {
        ok: false,
        statusCode: 409,
        code: "chapter_not_retryable",
        message: "Only failed chapters or failed chapter jobs can be retried",
        status: chapter.status,
        jobStatus: job.status,
        retryCount: Math.max(chapter.retryCount ?? 0, job.retryCount ?? 0),
        maxRetries: resolveChapterMaxRetries(job, chapter),
      };
    }

    const retryCount = Math.max(chapter.retryCount ?? 0, job.retryCount ?? 0);
    const maxRetries = resolveChapterMaxRetries(job, chapter);
    if (retryCount >= maxRetries) {
      return {
        ok: false,
        statusCode: 409,
        code: "chapter_retry_limit_exceeded",
        message: `Chapter retry limit exceeded (${retryCount}/${maxRetries})`,
        status: chapter.status,
        jobStatus: job.status,
        retryCount,
        maxRetries,
      };
    }

    const nextRetryCount = retryCount + 1;
    const priority = Math.max(job.priority ?? 0, MANUAL_CHAPTER_PRIORITY);
    await this.store.removeChapterPackageArtifacts(bookId, chapterId);
    await Promise.all([
      this.store.updateJob(job.jobId, {
        status: "QUEUED",
        progress: 0,
        priority,
        retryCount: nextRetryCount,
        maxRetries,
        nextRetryAt: undefined,
        errorMessage: undefined,
        downloadUrl: undefined,
      }),
      this.store.updateChapter(bookId, chapterId, {
        status: "QUEUED",
        progress: 0,
        durationMs: 0,
        audioPath: undefined,
        subtitlePath: undefined,
        scriptPath: undefined,
        packagePath: undefined,
        downloadUrl: undefined,
        retryCount: nextRetryCount,
        maxRetries,
        nextRetryAt: undefined,
        errorMessage: undefined,
        completedAt: undefined,
      }),
    ]);
    await this.refreshBookAndParentJob(bookId);
    this.enqueue(job.jobId, priority);

    return {
      ok: true,
      bookId,
      chapterId,
      jobId: job.jobId,
      status: "QUEUED",
      jobStatus: "QUEUED",
      priority,
      retryCount: nextRetryCount,
      maxRetries,
      message: "Chapter retry queued",
    };
  }

  async prioritizeChapterImport(
    bookId: string,
    chapterId: string,
  ): Promise<ChapterActionResult> {
    const context = await this.getChapterActionContext(bookId, chapterId);
    if (!context.ok) {
      return context;
    }

    const { chapter, job } = context;
    if (!isPrioritizableChapterStatus(chapter.status, job.status)) {
      return {
        ok: false,
        statusCode: 409,
        code: "chapter_not_prioritizable",
        message: "Only queued or processing chapters can be prioritized",
        status: chapter.status,
        jobStatus: job.status,
        retryCount: Math.max(chapter.retryCount ?? 0, job.retryCount ?? 0),
        maxRetries: resolveChapterMaxRetries(job, chapter),
      };
    }

    const priority = Math.max(job.priority ?? 0, MANUAL_CHAPTER_PRIORITY);
    const updatedJob = await this.store.updateJob(job.jobId, { priority });
    if (updatedJob.status === "QUEUED") {
      this.enqueue(updatedJob.jobId, priority, millisecondsUntil(updatedJob.nextRetryAt));
    }

    return {
      ok: true,
      bookId,
      chapterId,
      jobId: updatedJob.jobId,
      status: chapter.status,
      jobStatus: updatedJob.status,
      priority,
      retryCount: Math.max(chapter.retryCount ?? 0, updatedJob.retryCount ?? 0),
      maxRetries: resolveChapterMaxRetries(updatedJob, chapter),
      message: "Chapter priority raised",
    };
  }

  private async getChapterActionContext(
    bookId: string,
    chapterId: string,
  ): Promise<ChapterActionContext> {
    const book = await this.store.getBook(bookId);
    if (!book) {
      return {
        ok: false,
        statusCode: 404,
        code: "book_not_found",
        message: "Book not found",
      };
    }

    const chapter = await this.store.getChapter(bookId, chapterId);
    if (!chapter) {
      return {
        ok: false,
        statusCode: 404,
        code: "chapter_not_found",
        message: "Chapter not found",
      };
    }

    const job = await this.store.getChapterJob(bookId, chapterId);
    if (!job) {
      return {
        ok: false,
        statusCode: 404,
        code: "chapter_job_not_found",
        message: "Chapter job not found",
        status: chapter.status,
        retryCount: chapter.retryCount,
        maxRetries: chapter.maxRetries,
      };
    }

    return { ok: true, book, chapter, job };
  }

  private enqueue(jobId: string, priority = 0, delayMs = 0): void {
    const addPendingJob = () => {
      const existingJob = this.pendingJobs.find((job) => job.jobId === jobId);
      if (existingJob) {
        existingJob.priority = Math.max(existingJob.priority, priority);
      } else {
        this.pendingJobs.push({ jobId, priority });
      }
      this.pendingJobs.sort((left, right) => right.priority - left.priority);
      queueMicrotask(() => {
        this.drainQueue().catch((error) => {
          console.error("Unhandled import queue error", error);
        });
      });
    };

    if (delayMs > 0) {
      setTimeout(addPendingJob, delayMs).unref();
      return;
    }

    addPendingJob();
  }

  private async drainQueue(): Promise<void> {
    while (
      this.activeJobs < this.config.importConcurrency &&
      this.pendingJobs.length > 0
    ) {
      const nextJob = this.pendingJobs.shift();
      if (!nextJob) {
        return;
      }

      this.activeJobs += 1;
      void this.processJob(nextJob.jobId)
        .catch((error) => {
          console.error("processJob failed", error);
        })
        .finally(() => {
          this.activeJobs -= 1;
          void this.drainQueue();
        });
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      return;
    }
    if (job.status !== "QUEUED") {
      return;
    }

    const delayMs = millisecondsUntil(job.nextRetryAt);
    if (delayMs > 0) {
      this.enqueue(job.jobId, job.priority ?? 0, delayMs);
      return;
    }

    if (job.jobKind === "chapter_import") {
      await this.processChapterJob(job);
      return;
    }

    const workDir = await this.store.createJobWorkDir(jobId);
    const bookId = randomUUID();

    try {
      await this.store.updateJob(jobId, { status: "FETCHING", progress: 5 });
      const extractedArticle = await this.extractor.extract(job.normalizedUrl);

      await this.store.updateJob(jobId, { status: "EXTRACTING", progress: 18 });
      const article = await this.contentPreprocessor.preprocess(extractedArticle);
      const chapters = await this.audioScriptAdapter.adaptChapters(
        article,
        buildChapters(article.title, article.contentHtml, article.textContent),
      );

      if (chapters.length === 0) {
        throw new Error("No readable chapters were extracted from the page");
      }

      const { payloadDir, packagePath } = await this.store.allocateBookDirectories(bookId);
      const segmentRoot = path.join(workDir, "segments");
      await ensureDir(segmentRoot);

      let coverFile: string | undefined;
      if (article.coverUrl) {
        const extension = extensionFromUrl(article.coverUrl);
        coverFile = `cover${extension}`;
        try {
          await downloadToFile(article.coverUrl, path.join(payloadDir, coverFile));
        } catch (error) {
          console.warn("Cover download failed", error);
          coverFile = undefined;
        }
      }

      await this.store.updateJob(jobId, { status: "SYNTHESIZING", progress: 25 });

      const totalSentences = chapters.reduce(
        (count, chapter) => count + chapter.sentences.length,
        0,
      );
      let completedSentences = 0;
      let totalDurationMs = 0;
      const manifestChapters: ChapterManifest[] = [];
      const scriptChapters: Array<{
        chapterIndex: number;
        title: string;
        cues: SentenceCue[];
      }> = [];

      for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
        const chapter = chapters[chapterIndex];
        const chapterSegmentDir = path.join(segmentRoot, `chapter-${chapterIndex + 1}`);
        await ensureDir(chapterSegmentDir);

        const cues: SentenceCue[] = [];
        const segmentPaths: string[] = [];
        let timelineMs = 0;

        for (let sentenceIndex = 0; sentenceIndex < chapter.sentences.length; sentenceIndex += 1) {
          const sentence = chapter.sentences[sentenceIndex];
          const segmentPath = path.join(
            chapterSegmentDir,
            `${String(sentenceIndex + 1).padStart(4, "0")}.mp3`,
          );

          const { durationMs } = await this.ttsClient.synthesizeToFile({
            text: sentence,
            outputPath: segmentPath,
          });

          segmentPaths.push(segmentPath);
          cues.push({
            text: sentence,
            startMs: timelineMs,
            endMs: timelineMs + durationMs,
          });
          timelineMs += durationMs;

          completedSentences += 1;
          const progress = 25 + Math.round((completedSentences / totalSentences) * 60);
          await this.store.updateJob(jobId, {
            status: "SYNTHESIZING",
            progress: Math.min(progress, 85),
          });
        }

        const audioFile = `chapter-${String(chapterIndex + 1).padStart(2, "0")}.m4a`;
        const subtitleFile = `chapter-${String(chapterIndex + 1).padStart(2, "0")}.vtt`;
        const audioPath = path.join(payloadDir, audioFile);
        const subtitlePath = path.join(payloadDir, subtitleFile);

        const durationMs = await concatenateToM4a(segmentPaths, audioPath);
        await fs.writeFile(subtitlePath, buildWebVtt(cues), "utf8");

        totalDurationMs += durationMs;
        scriptChapters.push({
          chapterIndex,
          title: chapter.title,
          cues,
        });
        manifestChapters.push({
          title: chapter.title,
          durationMs,
          audioFile,
          subtitleFile,
        });
      }

      await this.store.updateJob(jobId, { status: "PACKAGING", progress: 90 });
      const manifest: BookManifest = {
        bookId,
        title: article.title,
        sourceType: "url",
        sourceUrl: job.normalizedUrl,
        language: article.language,
        coverFile,
        totalDurationMs,
        scriptFile: "script.json",
        chapters: manifestChapters,
      };

      await fs.writeFile(
        path.join(payloadDir, "script.json"),
        JSON.stringify(
          buildSemanticSegments({
            bookId,
            title: article.title,
            chapters: scriptChapters,
          }),
          null,
          2,
        ),
        "utf8",
      );
      await this.store.saveManifest(bookId, manifest);
      await createZip(payloadDir, packagePath);

      await this.store.updateJob(jobId, {
        bookId,
        status: "READY",
        progress: 100,
        downloadUrl: `${this.config.publicBaseUrl}${this.store.getPackageDownloadPath(bookId)}`,
        errorMessage: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected import failure";
      await this.store.updateJob(jobId, {
        status: "FAILED",
        progress: 100,
        errorMessage: message,
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  private async processChapterJob(job: ImportJobRecord): Promise<void> {
    if (!job.bookId || !job.chapterId) {
      return;
    }

    const chapter = await this.store.getChapter(job.bookId, job.chapterId);
    if (!chapter) {
      return;
    }

    const workDir = await this.store.createJobWorkDir(job.jobId);

    try {
      await this.updateChapterAttempt(job, "FETCHING", "FETCHING", 5);
      const extractedArticle = await this.extractor.extract(chapter.sourceUrl);

      await this.updateChapterAttempt(job, "PROCESSING", "EXTRACTING", 18);
      const article = await this.contentPreprocessor.preprocess(extractedArticle);
      const chapterPlans = await this.audioScriptAdapter.adaptChapters(
        article,
        buildChapters(article.title, article.contentHtml, article.textContent),
      );
      const sentences = flattenChapterSentences(chapterPlans);

      if (sentences.length === 0) {
        throw new Error("No readable sentences were extracted from the chapter");
      }

      const { payloadDir, packagePath } = await this.store.allocateChapterDirectories(
        job.bookId,
        job.chapterId,
      );
      const segmentRoot = path.join(workDir, "segments");
      await ensureDir(segmentRoot);

      await this.updateChapterAttempt(job, "SYNTHESIZING", "SYNTHESIZING", 25);

      const cues: SentenceCue[] = [];
      const segmentPaths: string[] = [];
      let timelineMs = 0;

      for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
        const sentence = sentences[sentenceIndex];
        const segmentPath = path.join(
          segmentRoot,
          `${String(sentenceIndex + 1).padStart(4, "0")}.mp3`,
        );
        const { durationMs } = await this.ttsClient.synthesizeToFile({
          text: sentence,
          outputPath: segmentPath,
        });

        segmentPaths.push(segmentPath);
        cues.push({
          text: sentence,
          startMs: timelineMs,
          endMs: timelineMs + durationMs,
        });
        timelineMs += durationMs;

        const progress = 25 + Math.round(((sentenceIndex + 1) / sentences.length) * 60);
        await this.updateChapterAttempt(
          job,
          "SYNTHESIZING",
          "SYNTHESIZING",
          Math.min(progress, 85),
        );
      }

      await this.updateChapterAttempt(job, "PACKAGING", "PACKAGING", 90);

      const audioFile = "audio.m4a";
      const subtitleFile = "subtitle.vtt";
      const scriptFile = "script.json";
      const chapterFile = "chapter.json";
      const audioPath = path.join(payloadDir, audioFile);
      const subtitlePath = path.join(payloadDir, subtitleFile);
      const scriptPath = path.join(payloadDir, scriptFile);
      const chapterPath = path.join(payloadDir, chapterFile);
      const durationMs = await concatenateToM4a(segmentPaths, audioPath);

      await fs.writeFile(subtitlePath, buildWebVtt(cues), "utf8");
      await fs.writeFile(
        scriptPath,
        JSON.stringify(
          buildSemanticSegments({
            bookId: job.bookId,
            title: chapter.title,
            chapters: [
              {
                chapterIndex: chapter.index,
                title: chapter.title,
                cues,
              },
            ],
          }),
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        chapterPath,
        JSON.stringify(
          {
            bookId: job.bookId,
            chapterId: job.chapterId,
            index: chapter.index,
            title: chapter.title,
            sourceUrl: chapter.sourceUrl,
            durationMs,
            audioFile,
            subtitleFile,
            scriptFile,
          },
          null,
          2,
        ),
        "utf8",
      );
      await createZip(payloadDir, packagePath);

      const downloadUrl = `${this.config.publicBaseUrl}${this.store.getChapterPackageDownloadPath(
        job.bookId,
        job.chapterId,
      )}`;
      const completedAt = new Date().toISOString();
      await Promise.all([
        this.store.updateJob(job.jobId, {
          status: "READY",
          progress: 100,
          retryCount: job.retryCount,
          maxRetries: job.maxRetries,
          nextRetryAt: undefined,
          errorMessage: undefined,
          downloadUrl,
        }),
        this.store.updateChapter(job.bookId, job.chapterId, {
          status: "READY",
          progress: 100,
          durationMs,
          audioPath: audioFile,
          subtitlePath: subtitleFile,
          scriptPath: scriptFile,
          packagePath,
          downloadUrl,
          nextRetryAt: undefined,
          errorMessage: undefined,
          completedAt,
        }),
      ]);
      const book = await this.store.getBook(job.bookId);
      if (book && !book.language) {
        await this.store.updateBook(job.bookId, { language: article.language });
      }
      await this.refreshBookAndParentJob(job.bookId);
    } catch (error) {
      await this.handleChapterFailure(job, error);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  private async updateChapterAttempt(
    job: ImportJobRecord,
    chapterStatus: ChapterImportStatus,
    jobStatus: ImportStatus,
    progress: number,
  ): Promise<void> {
    if (!job.bookId || !job.chapterId) {
      return;
    }

    await Promise.all([
      this.store.updateJob(job.jobId, {
        status: jobStatus,
        progress,
        nextRetryAt: undefined,
        errorMessage: undefined,
      }),
      this.store.updateChapter(job.bookId, job.chapterId, {
        status: chapterStatus,
        progress,
        nextRetryAt: undefined,
        errorMessage: undefined,
      }),
    ]);
  }

  private async handleChapterFailure(
    job: ImportJobRecord,
    error: unknown,
  ): Promise<void> {
    if (!job.bookId || !job.chapterId) {
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected import failure";
    const latestJob = (await this.store.getJob(job.jobId)) ?? job;
    const latestChapter = await this.store.getChapter(job.bookId, job.chapterId);
    const retryCount = Math.max(
      latestJob.retryCount ?? 0,
      latestChapter?.retryCount ?? 0,
    );
    const maxRetries = latestChapter
      ? resolveChapterMaxRetries(latestJob, latestChapter)
      : Math.min(latestJob.maxRetries ?? DEFAULT_CHAPTER_MAX_RETRIES, DEFAULT_CHAPTER_MAX_RETRIES);

    if (isRetryableChapterFailure(message) && retryCount < maxRetries) {
      const nextRetryCount = retryCount + 1;
      const delayMs = retryDelayMs(nextRetryCount);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await Promise.all([
        this.store.updateJob(job.jobId, {
          status: "QUEUED",
          progress: 0,
          retryCount: nextRetryCount,
          maxRetries,
          nextRetryAt,
          errorMessage: message,
        }),
        this.store.updateChapter(job.bookId, job.chapterId, {
          status: "QUEUED",
          progress: 0,
          retryCount: nextRetryCount,
          maxRetries,
          nextRetryAt,
          errorMessage: message,
        }),
      ]);
      this.enqueue(job.jobId, latestJob.priority ?? 0, delayMs);
      await this.refreshBookAndParentJob(job.bookId);
      return;
    }

    await Promise.all([
      this.store.updateJob(job.jobId, {
        status: "FAILED",
        progress: 100,
        retryCount,
        maxRetries,
        nextRetryAt: undefined,
        errorMessage: message,
      }),
      this.store.updateChapter(job.bookId, job.chapterId, {
        status: "FAILED",
        progress: 100,
        retryCount,
        maxRetries,
        nextRetryAt: undefined,
        errorMessage: message,
      }),
    ]);
    await this.refreshBookAndParentJob(job.bookId);
  }

  private async refreshBookAndParentJob(bookId: string): Promise<void> {
    const book = await this.store.refreshBookAggregate(bookId);
    if (!book.importJobId) {
      return;
    }

    const finishedChapterCount = book.readyChapterCount + book.failedChapterCount;
    const finished = finishedChapterCount === book.chapterCount;
    await this.store.updateJob(book.importJobId, {
      status:
        book.status === "FAILED"
          ? "FAILED"
          : finished
            ? "READY"
            : "SYNTHESIZING",
      progress:
        book.chapterCount === 0
          ? 100
          : Math.round((finishedChapterCount / book.chapterCount) * 100),
    });
  }
}

function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url.toString();
}

function normalizeBookImportInput(
  input: CreateBookImportInput,
): CreateBookImportInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Book title is required");
  }

  const chapters = input.chapters
    .map((chapter) => ({
      index: chapter.index,
      title: chapter.title.trim() || `Chapter ${chapter.index + 1}`,
      url: normalizeUrl(chapter.url),
    }))
    .sort((left, right) => left.index - right.index);

  if (chapters.length === 0) {
    throw new Error("At least one chapter is required");
  }

  const dedupedChapters = new Map<string, (typeof chapters)[number]>();
  for (const chapter of chapters) {
    if (!dedupedChapters.has(chapter.url)) {
      dedupedChapters.set(chapter.url, chapter);
    }
  }

  return {
    discoveryId: input.discoveryId,
    title,
    sourceRootUrl: normalizeUrl(input.sourceRootUrl),
    chapters: Array.from(dedupedChapters.values()),
  };
}

function compareJobsByPriority(left: ImportJobRecord, right: ImportJobRecord): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function flattenChapterSentences(chapters: ChapterPlan[]): string[] {
  return chapters.flatMap((chapter) =>
    chapter.sentences.map((sentence) => sentence.trim()).filter(Boolean),
  );
}

function resolveChapterMaxRetries(
  job: ImportJobRecord,
  chapter: ChapterImportRecord,
): number {
  return Math.max(
    0,
    Math.min(
      job.maxRetries ?? DEFAULT_CHAPTER_MAX_RETRIES,
      chapter.maxRetries ?? DEFAULT_CHAPTER_MAX_RETRIES,
      DEFAULT_CHAPTER_MAX_RETRIES,
    ),
  );
}

function isPrioritizableChapterStatus(
  chapterStatus: ChapterImportStatus,
  jobStatus: ImportStatus,
): boolean {
  const chapterStatuses: readonly ChapterImportStatus[] = [
    "QUEUED",
    "FETCHING",
    "PROCESSING",
    "SYNTHESIZING",
    "PACKAGING",
  ];
  const jobStatuses: readonly ImportStatus[] = [
    "QUEUED",
    "FETCHING",
    "EXTRACTING",
    "SYNTHESIZING",
    "PACKAGING",
  ];

  return chapterStatuses.includes(chapterStatus) && jobStatuses.includes(jobStatus);
}

function isRetryableChapterFailure(message: string): boolean {
  if (
    /\b(?:400|401|403|404)\b/.test(message) ||
    /Only http and https URLs are supported/i.test(message) ||
    /Only HTML article pages are supported/i.test(message) ||
    /did not yield readable article content/i.test(message) ||
    /No readable sentences were extracted/i.test(message) ||
    /quota|authentication|authorization|api key/i.test(message)
  ) {
    return false;
  }
  return true;
}

function retryDelayMs(retryCount: number): number {
  return retryCount <= 1 ? 30_000 : 120_000;
}

function millisecondsUntil(timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }
  const delayMs = Date.parse(timestamp) - Date.now();
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

function extensionFromUrl(input: string): string {
  try {
    const pathname = new URL(input).pathname;
    const extension = path.extname(pathname).toLowerCase();
    return extension || ".jpg";
  } catch {
    return ".jpg";
  }
}
