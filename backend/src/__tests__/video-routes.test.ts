import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerVideoRoutes } from "../routes/videos.js";
import { FileBackedStore } from "../storage/store.js";
import {
  type AuthorizedVideoTranscriptProvider,
  NO_AUTHORIZED_TRANSCRIPT_SOURCE_WARNING,
  VideoImportService,
} from "../services/video-import-service.js";
import { VideoMetadataService } from "../services/video-metadata-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("video routes", () => {
  it("detects supported video URLs through POST /v1/videos/detect", async () => {
    const app = fastify();
    await registerVideoRoutes(app, new VideoMetadataService());

    const response = await app.inject({
      method: "POST",
      url: "/v1/videos/detect",
      payload: { url: "https://youtu.be/dQw4w9WgXcQ" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: "youtube",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      externalPlaybackUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      isSupported: true,
      metadata: {
        durationMs: null,
        metadataSource: "url",
        thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    });
    expect(response.json().warnings.join(" ")).toContain("URL-level only");
  });

  it("returns isSupported=false for unsupported video URLs", async () => {
    const app = fastify();
    await registerVideoRoutes(app, new VideoMetadataService());

    const response = await app.inject({
      method: "POST",
      url: "/v1/videos/detect",
      payload: { url: "https://example.com/video/BV1xx411c7mD" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: null,
      videoId: null,
      canonicalUrl: null,
      externalPlaybackUrl: "https://example.com/video/BV1xx411c7mD",
      isSupported: false,
    });
  });

  it("creates a durable video import shell without downloading media", async () => {
    const { app, importService } = await buildVideoImportApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/videos/import",
      payload: { url: "https://youtu.be/dQw4w9WgXcQ?t=43" },
    });

    expect(response.statusCode).toBe(202);
    const created = response.json();
    expect(created).toMatchObject({
      platform: "youtube",
      videoId: "dQw4w9WgXcQ",
      title: "YouTube video dQw4w9WgXcQ",
      durationMs: null,
      thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      externalPlaybackUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "PROCESSING",
    });
    expect(created.warnings.join(" ")).toContain("platform video/audio was not downloaded");

    const status = await waitForImportStatus(app, created.jobId, "TRANSCRIPT_UNAVAILABLE");
    expect(status).toMatchObject({
      status: "TRANSCRIPT_UNAVAILABLE",
      progress: 100,
      bookId: created.bookId,
      transcriptUrl: null,
      scriptUrl: null,
      errorMessage: null,
    });
    expect(status.warnings).toContain(NO_AUTHORIZED_TRANSCRIPT_SOURCE_WARNING);

    const book = await importService.getBook(created.bookId);
    expect(book).toMatchObject({
      bookId: created.bookId,
      kind: "video",
      sourceType: "youtube",
      platform: "youtube",
      videoId: "dQw4w9WgXcQ",
      externalPlaybackUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      status: "TRANSCRIPT_UNAVAILABLE",
      transcriptStatus: "UNAVAILABLE",
      thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      chapters: [
        {
          kind: "video_section",
          index: 0,
          status: "TRANSCRIPT_UNAVAILABLE",
        },
      ],
    });
    expect(book?.chapters[0]).not.toHaveProperty("transcriptPath");
    expect(book?.chapters[0]).not.toHaveProperty("scriptPath");

    const transcriptResponse = await app.inject({
      method: "GET",
      url: `/v1/videos/books/${created.bookId}/transcript.vtt`,
    });
    expect(transcriptResponse.statusCode).toBe(404);

    const scriptResponse = await app.inject({
      method: "GET",
      url: `/v1/videos/books/${created.bookId}/script.json`,
    });
    expect(scriptResponse.statusCode).toBe(404);

    await app.close();
  });

  it("serves authorized transcript and script artifacts for READY video books", async () => {
    const publicBaseUrl = "https://api.nova.test";
    const { app } = await buildVideoImportApp({
      publicBaseUrl,
      transcriptProvider: {
        async getTranscript() {
          return {
            status: "ready",
            cues: [
              {
                text: "Welcome to the video.",
                startMs: 0,
                endMs: 1_500,
              },
              {
                text: "This transcript came from an authorized provider.",
                startMs: 1_500,
                endMs: 4_000,
              },
            ],
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/videos/import",
      payload: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });

    expect(response.statusCode).toBe(202);
    const created = response.json();
    const status = await waitForImportStatus(app, created.jobId, "READY");
    expect(status).toMatchObject({
      status: "READY",
      progress: 100,
      bookId: created.bookId,
      transcriptUrl: `${publicBaseUrl}/v1/videos/books/${created.bookId}/transcript.vtt`,
      scriptUrl: `${publicBaseUrl}/v1/videos/books/${created.bookId}/script.json`,
      errorMessage: null,
    });

    const transcriptResponse = await app.inject({
      method: "GET",
      url: `/v1/videos/books/${created.bookId}/transcript.vtt`,
    });
    expect(transcriptResponse.statusCode).toBe(200);
    expect(transcriptResponse.headers["content-type"]).toContain("text/vtt");
    expect(transcriptResponse.body).toContain("WEBVTT");
    expect(transcriptResponse.body).toContain("Welcome to the video.");

    const scriptResponse = await app.inject({
      method: "GET",
      url: `/v1/videos/books/${created.bookId}/script.json`,
    });
    expect(scriptResponse.statusCode).toBe(200);
    expect(scriptResponse.headers["content-type"]).toContain("application/json");
    expect(scriptResponse.json()).toMatchObject({
      version: 1,
      bookId: created.bookId,
      title: "YouTube video dQw4w9WgXcQ",
      segments: [
        {
          chapterIndex: 0,
          startMs: 0,
          endMs: 4_000,
          text:
            "Welcome to the video. This transcript came from an authorized provider.",
        },
      ],
    });

    await app.close();
  });

  it("rejects unsupported video imports", async () => {
    const { app } = await buildVideoImportApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/videos/import",
      payload: { url: "https://example.com/watch?v=dQw4w9WgXcQ" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message:
        "Unsupported video URL. Nova currently supports YouTube and Bilibili BV URLs.",
      warnings: [
        "Unsupported video URL. Nova currently supports YouTube and Bilibili BV URLs.",
      ],
    });

    await app.close();
  });
});

async function buildVideoImportApp(options: {
  publicBaseUrl?: string;
  transcriptProvider?: AuthorizedVideoTranscriptProvider;
} = {}): Promise<{
  app: ReturnType<typeof fastify>;
  importService: VideoImportService;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-video-import-"));
  tempDirs.push(dataDir);
  const store = new FileBackedStore(dataDir);
  await store.init();
  const metadataService = new VideoMetadataService();
  const importService = new VideoImportService(
    store,
    metadataService,
    options.transcriptProvider,
    { publicBaseUrl: options.publicBaseUrl },
  );
  const app = fastify();
  await registerVideoRoutes(app, metadataService, importService);
  return { app, importService };
}

async function waitForImportStatus(
  app: ReturnType<typeof fastify>,
  jobId: string,
  expectedStatus: string,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/videos/imports/${jobId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    if (body.status === expectedStatus) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Video import did not reach ${expectedStatus}`);
}
