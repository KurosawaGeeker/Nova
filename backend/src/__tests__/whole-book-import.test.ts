import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { FileBackedStore } from "../storage/store.js";
import { ImportService } from "../services/import-service.js";
import type { WebpageExtractor } from "../services/webpage-extractor.js";
import { ContentPreprocessor } from "../services/content-preprocessor.js";
import { AudioScriptAdapter } from "../services/audio-script-adapter.js";
import type { TtsClient } from "../tts/tts-client.js";
import type { ExtractedArticle } from "../types.js";

const execFileAsync = promisify(execFile);

const baseConfig: AppConfig = {
  port: 8787,
  host: "0.0.0.0",
  publicBaseUrl: "http://localhost:8787",
  dataDir: "/tmp/nova-test",
  fetchTimeoutMs: 30_000,
  maxJobAgeHours: 24,
  importConcurrency: 1,
  discoveryMaxPages: 80,
  discoveryMaxChapters: 50,
  discoveryMaxDepth: 2,
  discoveryTimeoutMs: 20_000,
  openAiModel: "gpt-4o-mini-tts",
  openAiPreprocessModel: "gpt-4o-mini",
  openAiAdaptModel: "gpt-4o-mini",
  openAiCommandModel: "gpt-4o-mini",
  openAiSttModel: "gpt-4o-mini-transcribe",
  openAiVoice: "alloy",
  ttsMode: "mock",
  contentPreprocessMode: "heuristic",
  audioAdaptMode: "off",
  userAgent: "test-agent",
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("whole-book import", () => {
  it("creates a parent book and prioritized chapter jobs", async () => {
    const { service, store } = await createService({
      "https://example.com/book/chapter-1": article("Chapter 1"),
      "https://example.com/book/chapter-2": article("Chapter 2"),
      "https://example.com/book/chapter-3": article("Chapter 3"),
    });

    const result = await service.submitBookImport({
      discoveryId: "disc_test",
      title: "Example Book",
      sourceRootUrl: "https://example.com/book",
      chapters: [
        { index: 0, title: "Chapter 1", url: "https://example.com/book/chapter-1" },
        { index: 1, title: "Chapter 2", url: "https://example.com/book/chapter-2" },
        { index: 2, title: "Chapter 3", url: "https://example.com/book/chapter-3" },
      ],
    });

    expect(result.chapterJobs).toEqual([
      { chapterId: expect.any(String), index: 0, status: "QUEUED" },
      { chapterId: expect.any(String), index: 1, status: "QUEUED" },
      { chapterId: expect.any(String), index: 2, status: "QUEUED" },
    ]);

    const book = await store.getBook(result.bookId);
    expect(book?.status).toBe("IMPORTING");
    expect(book?.chapterCount).toBe(3);

    const chapters = await store.listBookChapters(result.bookId);
    const priorities = await Promise.all(
      chapters.map(async (chapter) => {
        const job = await store.getJob(chapter.remoteChapterJobId!);
        return job?.priority;
      }),
    );
    expect(priorities).toEqual([100, 80, 80]);

    await waitForBookStatus(service, result.bookId, (candidate) => {
      return candidate.readyChapterCount === 3;
    });
  });

  it("lets one chapter fail without blocking another selected chapter", async () => {
    const { service } = await createService({
      "https://example.com/book/chapter-2": article("Chapter 2"),
    });

    const result = await service.submitBookImport({
      title: "Mixed Book",
      sourceRootUrl: "https://example.com/book",
      chapters: [
        { index: 0, title: "Missing Chapter", url: "https://example.com/book/missing" },
        { index: 1, title: "Chapter 2", url: "https://example.com/book/chapter-2" },
      ],
    });

    const status = await waitForBookStatus(service, result.bookId, (candidate) => {
      return candidate.readyChapterCount === 1 && candidate.failedChapterCount === 1;
    });

    expect(status.status).toBe("PARTIAL_READY");
    expect(status.chapterCount).toBe(2);
    expect(status.chapters).toEqual([
      expect.objectContaining({
        index: 0,
        status: "FAILED",
        retryCount: 0,
        maxRetries: 2,
        errorMessage: "Upstream response was 404",
      }),
      expect.objectContaining({
        index: 1,
        status: "READY",
        progress: 100,
        retryCount: 0,
        maxRetries: 2,
        downloadUrl: expect.stringContaining("/v1/books/"),
      }),
    ]);
  });
});

async function createService(pages: Record<string, ExtractedArticle>): Promise<{
  service: ImportService;
  store: FileBackedStore;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nova-whole-book-"));
  tempDirs.push(dataDir);
  const config = { ...baseConfig, dataDir };
  const store = new FileBackedStore(dataDir);
  await store.init();
  const extractor = {
    extract: vi.fn(async (url: string) => {
      const page = pages[url];
      if (!page) {
        throw new Error("Upstream response was 404");
      }
      return page;
    }),
  } as unknown as WebpageExtractor;

  return {
    store,
    service: new ImportService(
      config,
      store,
      extractor,
      new ContentPreprocessor(config),
      new AudioScriptAdapter(config),
      new FastTtsClient(),
    ),
  };
}

function article(title: string): ExtractedArticle {
  const body = `${title} starts with a concise overview for listeners and explains the main idea with enough context to produce a useful audiobook segment.`;
  return {
    title,
    contentHtml: `<h2>${title}</h2><p>${body}</p>`,
    textContent: body,
    language: "en",
  };
}

async function waitForBookStatus(
  service: ImportService,
  bookId: string,
  predicate: (
    status: NonNullable<Awaited<ReturnType<ImportService["getBookStatus"]>>>,
  ) => boolean,
): Promise<NonNullable<Awaited<ReturnType<ImportService["getBookStatus"]>>>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await service.getBookStatus(bookId);
    if (status && predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for book ${bookId}`);
}

class FastTtsClient implements TtsClient {
  async synthesizeToFile(input: {
    text: string;
    outputPath: string;
  }): Promise<{ durationMs: number }> {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.1",
      "-q:a",
      "9",
      input.outputPath,
    ]);
    return { durationMs: 100 };
  }
}
