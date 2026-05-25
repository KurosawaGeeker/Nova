import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { FileBackedStore } from "../storage/store.js";
import type { SentenceCue } from "../types.js";
import { buildSemanticSegments } from "../utils/semantic-script.js";
import { buildWebVtt } from "../utils/vtt.js";
import { readJson, writeJson } from "../utils/files.js";
import { VideoMetadataService } from "./video-metadata-service.js";
import type {
  VideoBookRecord,
  VideoChapterRecord,
  VideoImportJobRecord,
  VideoImportResponse,
  VideoImportStatusResponse,
  VideoPlatform,
  VideoUrlMetadata,
} from "./video-types.js";

export const NO_AUTHORIZED_TRANSCRIPT_SOURCE_WARNING =
  "No authorized transcript source is configured; Nova did not scrape captions or download platform audio/video. Transcript is unavailable until an authorized source is added.";

export type VideoTranscriptLookupResult =
  | {
      status: "unavailable";
      warning: string;
    }
  | {
      status: "ready";
      cues: SentenceCue[];
      language?: string;
    };

export interface AuthorizedVideoTranscriptProvider {
  getTranscript(book: VideoBookRecord): Promise<VideoTranscriptLookupResult>;
}

export interface VideoImportServiceOptions {
  publicBaseUrl?: string;
}

export class UnconfiguredVideoTranscriptProvider
  implements AuthorizedVideoTranscriptProvider
{
  async getTranscript(): Promise<VideoTranscriptLookupResult> {
    return {
      status: "unavailable",
      warning: NO_AUTHORIZED_TRANSCRIPT_SOURCE_WARNING,
    };
  }
}

export class UnsupportedVideoImportError extends Error {
  constructor(readonly warnings: string[]) {
    super(warnings[0] ?? "Unsupported video URL");
  }
}

export class VideoImportService {
  constructor(
    private readonly store: FileBackedStore,
    private readonly metadataService: VideoMetadataService,
    private readonly transcriptProvider: AuthorizedVideoTranscriptProvider =
      new UnconfiguredVideoTranscriptProvider(),
    private readonly options: VideoImportServiceOptions = {},
  ) {}

  async importVideoBook(inputUrl: string): Promise<VideoImportResponse> {
    const detection = await this.metadataService.detect(inputUrl);
    if (!detection.isSupported) {
      throw new UnsupportedVideoImportError(detection.warnings);
    }

    const now = new Date().toISOString();
    const bookId = randomUUID();
    const jobId = randomUUID();
    const metadata =
      detection.metadata ?? fallbackMetadata(detection.platform, detection.videoId);
    const title =
      metadata.title ?? `${platformDisplayName(detection.platform)} video ${detection.videoId}`;
    const warnings = uniqueWarnings([
      ...detection.warnings,
      "Created a Video Book shell only; platform video/audio was not downloaded or cached.",
    ]);

    const chapter: VideoChapterRecord = {
      id: randomUUID(),
      bookId,
      index: 0,
      kind: "video_section",
      title,
      sourceUrl: detection.externalPlaybackUrl,
      status: "PROCESSING",
      durationMs: metadata.durationMs,
      playedPositionMs: 0,
    };
    const book: VideoBookRecord = {
      bookId,
      kind: "video",
      sourceType: detection.platform,
      sourceRootUrl: detection.canonicalUrl,
      submittedUrl: inputUrl.trim(),
      platform: detection.platform,
      videoId: detection.videoId,
      externalPlaybackUrl: detection.externalPlaybackUrl,
      title,
      description: metadata.description,
      thumbnailUrl: metadata.thumbnailUrl,
      durationMs: metadata.durationMs,
      lastPositionMs: 0,
      lastOpenedAt: null,
      status: "PROCESSING",
      transcriptStatus: "PENDING",
      warnings,
      chapters: [chapter],
      createdAt: now,
      updatedAt: now,
    };
    const job: VideoImportJobRecord = {
      jobId,
      bookId,
      sourceType: "video",
      platform: detection.platform,
      videoId: detection.videoId,
      externalPlaybackUrl: detection.externalPlaybackUrl,
      status: "PROCESSING",
      progress: 10,
      transcriptUrl: null,
      scriptUrl: null,
      errorMessage: null,
      warnings,
      createdAt: now,
      updatedAt: now,
    };

    await Promise.all([this.saveBook(book), this.saveJob(job)]);
    this.enqueueTranscriptLookup(jobId);
    return toImportResponse(job, book);
  }

  async getImportStatus(
    jobId: string,
  ): Promise<VideoImportStatusResponse | null> {
    const job = await this.getJob(jobId);
    return job ? toImportStatusResponse(job) : null;
  }

  async getBook(bookId: string): Promise<VideoBookRecord | null> {
    try {
      return await readJson<VideoBookRecord>(this.bookPath(bookId));
    } catch {
      return null;
    }
  }

  async getTranscriptArtifactPath(bookId: string): Promise<string | null> {
    return this.getReadyArtifactPath(bookId, "transcript.vtt");
  }

  async getScriptArtifactPath(bookId: string): Promise<string | null> {
    return this.getReadyArtifactPath(bookId, "script.json");
  }

  private enqueueTranscriptLookup(jobId: string): void {
    queueMicrotask(() => {
      this.processTranscriptLookup(jobId).catch((error) => {
        console.error("video transcript lookup failed", error);
      });
    });
  }

  private async processTranscriptLookup(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      return;
    }

    const book = await this.getBook(job.bookId);
    if (!book) {
      await this.updateJob(jobId, {
        status: "FAILED",
        progress: 100,
        errorMessage: `Video book ${job.bookId} does not exist`,
      });
      return;
    }

    let transcript: VideoTranscriptLookupResult;
    try {
      transcript = await this.transcriptProvider.getTranscript(book);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Authorized transcript lookup failed";
      await Promise.all([
        this.updateJob(jobId, {
          status: "FAILED",
          progress: 100,
          errorMessage: message,
        }),
        this.updateBook(book.bookId, {
          status: "FAILED",
          chapters: updateChapterStatuses(book.chapters, "FAILED"),
        }),
      ]);
      return;
    }

    if (transcript.status === "unavailable") {
      await this.markTranscriptUnavailable(job, book, transcript.warning);
      return;
    }

    if (transcript.cues.length === 0) {
      await this.markTranscriptUnavailable(
        job,
        book,
        "Authorized transcript source returned no transcript cues.",
      );
      return;
    }

    await this.writeTranscriptArtifacts(job, book, transcript.cues);
  }

  private async markTranscriptUnavailable(
    job: VideoImportJobRecord,
    book: VideoBookRecord,
    warning: string,
  ): Promise<void> {
    const warnings = uniqueWarnings([...job.warnings, warning]);
    await Promise.all([
      this.updateJob(job.jobId, {
        status: "TRANSCRIPT_UNAVAILABLE",
        progress: 100,
        transcriptUrl: null,
        scriptUrl: null,
        errorMessage: null,
        warnings,
      }),
      this.updateBook(book.bookId, {
        status: "TRANSCRIPT_UNAVAILABLE",
        transcriptStatus: "UNAVAILABLE",
        warnings,
        chapters: updateChapterStatuses(book.chapters, "TRANSCRIPT_UNAVAILABLE"),
      }),
    ]);
  }

  private async writeTranscriptArtifacts(
    job: VideoImportJobRecord,
    book: VideoBookRecord,
    cues: SentenceCue[],
  ): Promise<void> {
    const transcriptPath = this.transcriptPath(book.bookId);
    const scriptPath = this.scriptPath(book.bookId);
    const relativeTranscriptPath = "transcript.vtt";
    const relativeScriptPath = "script.json";

    await Promise.all([
      writeJson(
        scriptPath,
        buildSemanticSegments({
          bookId: book.bookId,
          title: book.title,
          chapters: [
            {
              chapterIndex: 0,
              title: book.title,
              cues,
            },
          ],
        }),
      ),
      writeText(transcriptPath, buildWebVtt(cues)),
    ]);

    const warnings = uniqueWarnings(job.warnings);
    await Promise.all([
      this.updateJob(job.jobId, {
        status: "READY",
        progress: 100,
        transcriptUrl: this.transcriptUrl(book.bookId),
        scriptUrl: this.scriptUrl(book.bookId),
        errorMessage: null,
        warnings,
      }),
      this.updateBook(book.bookId, {
        status: "READY",
        transcriptStatus: "READY",
        warnings,
        chapters: book.chapters.map((chapter, index) =>
          index === 0
            ? {
                ...chapter,
                status: "READY",
                transcriptPath: relativeTranscriptPath,
                scriptPath: relativeScriptPath,
              }
            : chapter,
        ),
      }),
    ]);
  }

  private async getJob(jobId: string): Promise<VideoImportJobRecord | null> {
    try {
      return await readJson<VideoImportJobRecord>(this.jobPath(jobId));
    } catch {
      return null;
    }
  }

  private async saveJob(job: VideoImportJobRecord): Promise<void> {
    await writeJson(this.jobPath(job.jobId), job);
  }

  private async updateJob(
    jobId: string,
    patch: Partial<Omit<VideoImportJobRecord, "jobId" | "createdAt">>,
  ): Promise<VideoImportJobRecord> {
    const current = await this.getJob(jobId);
    if (!current) {
      throw new Error(`Video import job ${jobId} does not exist`);
    }

    const next: VideoImportJobRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.saveJob(next);
    return next;
  }

  private async saveBook(book: VideoBookRecord): Promise<void> {
    await writeJson(this.bookPath(book.bookId), book);
  }

  private async updateBook(
    bookId: string,
    patch: Partial<Omit<VideoBookRecord, "bookId" | "createdAt">>,
  ): Promise<VideoBookRecord> {
    const current = await this.getBook(bookId);
    if (!current) {
      throw new Error(`Video book ${bookId} does not exist`);
    }

    const next: VideoBookRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.saveBook(next);
    return next;
  }

  private jobPath(jobId: string): string {
    return path.join(this.store.jobsDir, "video-imports", `${jobId}.json`);
  }

  private bookPath(bookId: string): string {
    return path.join(this.videoBookDir(bookId), "book.json");
  }

  private transcriptPath(bookId: string): string {
    return path.join(this.videoBookDir(bookId), "transcript.vtt");
  }

  private scriptPath(bookId: string): string {
    return path.join(this.videoBookDir(bookId), "script.json");
  }

  private videoBookDir(bookId: string): string {
    return path.join(this.store.booksDir, "video", bookId);
  }

  private async getReadyArtifactPath(
    bookId: string,
    fileName: "transcript.vtt" | "script.json",
  ): Promise<string | null> {
    const book = await this.getBook(bookId);
    if (!book || book.transcriptStatus !== "READY") {
      return null;
    }

    const chapter = book.chapters.find((candidate) => candidate.index === 0);
    const expectedPath =
      fileName === "transcript.vtt" ? chapter?.transcriptPath : chapter?.scriptPath;
    if (expectedPath !== fileName) {
      return null;
    }

    const artifactPath =
      fileName === "transcript.vtt"
        ? this.transcriptPath(bookId)
        : this.scriptPath(bookId);
    try {
      await fs.access(artifactPath);
      return artifactPath;
    } catch {
      return null;
    }
  }

  private transcriptUrl(bookId: string): string {
    return toPublicUrl(
      this.options.publicBaseUrl,
      `/v1/videos/books/${bookId}/transcript.vtt`,
    );
  }

  private scriptUrl(bookId: string): string {
    return toPublicUrl(
      this.options.publicBaseUrl,
      `/v1/videos/books/${bookId}/script.json`,
    );
  }
}

function toImportResponse(
  job: VideoImportJobRecord,
  book: VideoBookRecord,
): VideoImportResponse {
  return {
    bookId: book.bookId,
    jobId: job.jobId,
    platform: job.platform,
    videoId: job.videoId,
    title: book.title,
    durationMs: book.durationMs,
    thumbnailUrl: book.thumbnailUrl,
    externalPlaybackUrl: job.externalPlaybackUrl,
    status: job.status,
    warnings: job.warnings,
  };
}

function toImportStatusResponse(
  job: VideoImportJobRecord,
): VideoImportStatusResponse {
  return {
    status: job.status,
    progress: job.progress,
    bookId: job.bookId,
    transcriptUrl: job.transcriptUrl,
    scriptUrl: job.scriptUrl,
    errorMessage: job.errorMessage,
    warnings: job.warnings,
  };
}

function fallbackMetadata(
  platform: VideoPlatform,
  videoId: string,
): VideoUrlMetadata {
  return {
    title: null,
    description: null,
    durationMs: null,
    thumbnailUrl:
      platform === "youtube"
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : null,
    metadataSource: "url",
  };
}

function platformDisplayName(platform: VideoPlatform): string {
  return platform === "youtube" ? "YouTube" : "Bilibili";
}

function updateChapterStatuses(
  chapters: VideoChapterRecord[],
  status: VideoChapterRecord["status"],
): VideoChapterRecord[] {
  return chapters.map((chapter) => ({ ...chapter, status }));
}

function uniqueWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.filter((warning) => warning.length > 0)));
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function toPublicUrl(configuredBaseUrl: string | undefined, routePath: string): string {
  const baseUrl =
    configuredBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return `${baseUrl.replace(/\/+$/, "")}${routePath}`;
}
