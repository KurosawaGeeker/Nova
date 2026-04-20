import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { buildChapters } from "../utils/chapterizer.js";
import { concatenateToM4a } from "../utils/audio.js";
import { createZip, downloadToFile, ensureDir } from "../utils/files.js";
import { buildWebVtt } from "../utils/vtt.js";
import type {
  BookManifest,
  ChapterManifest,
  ImportJobRecord,
  SentenceCue,
} from "../types.js";
import { FileBackedStore } from "../storage/store.js";
import { WebpageExtractor } from "./webpage-extractor.js";
import type { TtsClient } from "../tts/tts-client.js";
import { ContentPreprocessor } from "./content-preprocessor.js";

export class ImportService {
  private readonly pendingJobIds: string[] = [];
  private activeJobs = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly store: FileBackedStore,
    private readonly extractor: WebpageExtractor,
    private readonly contentPreprocessor: ContentPreprocessor,
    private readonly ttsClient: TtsClient,
  ) {}

  async submitUrl(inputUrl: string): Promise<ImportJobRecord> {
    const normalizedUrl = normalizeUrl(inputUrl);
    const job = await this.store.createUrlJob(normalizedUrl);
    this.enqueue(job.jobId);
    return job;
  }

  async getJob(jobId: string): Promise<ImportJobRecord | null> {
    return this.store.getJob(jobId);
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

  private enqueue(jobId: string): void {
    this.pendingJobIds.push(jobId);
    queueMicrotask(() => {
      this.drainQueue().catch((error) => {
        console.error("Unhandled import queue error", error);
      });
    });
  }

  private async drainQueue(): Promise<void> {
    while (
      this.activeJobs < this.config.importConcurrency &&
      this.pendingJobIds.length > 0
    ) {
      const nextJobId = this.pendingJobIds.shift();
      if (!nextJobId) {
        return;
      }

      this.activeJobs += 1;
      void this.processJob(nextJobId)
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

    const workDir = await this.store.createJobWorkDir(jobId);
    const bookId = randomUUID();

    try {
      await this.store.updateJob(jobId, { status: "FETCHING", progress: 5 });
      const extractedArticle = await this.extractor.extract(job.normalizedUrl);

      await this.store.updateJob(jobId, { status: "EXTRACTING", progress: 18 });
      const article = await this.contentPreprocessor.preprocess(extractedArticle);
      const chapters = buildChapters(article.title, article.contentHtml, article.textContent);

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
        chapters: manifestChapters,
      };

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
}

function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url.toString();
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
