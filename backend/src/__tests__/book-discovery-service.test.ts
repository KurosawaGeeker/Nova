import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import {
  BookDiscoveryService,
  normalizeDiscoveryUrl,
} from "../services/book-discovery-service.js";

const baseConfig: AppConfig = {
  port: 8787,
  host: "0.0.0.0",
  publicBaseUrl: "http://localhost:8787",
  dataDir: "/tmp/nova-test",
  fetchTimeoutMs: 30_000,
  maxJobAgeHours: 24,
  importConcurrency: 3,
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

describe("book-discovery-service", () => {
  it("discovers ordered chapters from a TOC page", async () => {
    const service = serviceWithPages({
      "https://example.com/book": `
        <html>
          <head><title>Nova Guide Contents</title></head>
          <body>
            <h1>Nova Guide 目录</h1>
            <ol class="toc">
              <li><a href="/book/chapter-1">第 1 章 起步</a></li>
              <li><a href="/book/chapter-2">第 2 章 进阶</a></li>
              <li><a href="/book/chapter-3">第 3 章 部署</a></li>
            </ol>
          </body>
        </html>
      `,
    });

    const result = await service.discover("https://example.com/book");

    expect(result.discoveryMode).toBe("toc_page");
    expect(result.candidateBookTitle).toBe("Nova Guide");
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.chapters.map((chapter) => chapter.title)).toEqual([
      "第 1 章 起步",
      "第 2 章 进阶",
      "第 3 章 部署",
    ]);
    expect(result.chapters.every((chapter) => chapter.selectedByDefault)).toBe(true);
  });

  it("discovers chapters from a chapter sidebar", async () => {
    const service = serviceWithPages({
      "https://docs.example.com/guide/chapter-2": `
        <html>
          <head><title>Chapter 2 - Nova Handbook</title></head>
          <body>
            <h1>Chapter 2: Voice Commands</h1>
            <aside class="book-sidebar">
              <a href="/guide/chapter-1">Chapter 1: Setup</a>
              <a href="/guide/chapter-2">Chapter 2: Voice Commands</a>
              <a href="/guide/chapter-3">Chapter 3: Offline Playback</a>
            </aside>
            <article><p>Voice command content.</p></article>
          </body>
        </html>
      `,
    });

    const result = await service.discover("https://docs.example.com/guide/chapter-2");

    expect(result.discoveryMode).toBe("chapter_sidebar");
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[1]?.url).toBe("https://docs.example.com/guide/chapter-2");
  });

  it("excludes unrelated comments, tags, login, sharing, and privacy links", async () => {
    const service = serviceWithPages({
      "https://example.com/story": `
        <html>
          <body>
            <h1>Story 目录</h1>
            <nav class="toc">
              <a href="/story/chapter-1">Chapter 1</a>
              <a href="/story/chapter-2">Chapter 2</a>
              <a href="/comments">Comments</a>
              <a href="/tag/audio">Tag: audio</a>
              <a href="/login">Login</a>
              <a href="/share/twitter">Share</a>
              <a href="/privacy">Privacy Policy</a>
              <a href="https://other.example.com/story/chapter-3">Chapter 3</a>
            </nav>
          </body>
        </html>
      `,
    });

    const result = await service.discover("https://example.com/story");

    expect(result.chapters.map((chapter) => chapter.url)).toEqual([
      "https://example.com/story/chapter-1",
      "https://example.com/story/chapter-2",
    ]);
  });

  it("normalizes duplicate URLs before returning chapters", async () => {
    const service = serviceWithPages({
      "https://example.com/book": `
        <html>
          <body>
            <h1>Book Contents</h1>
            <ol class="toc">
              <li><a href="/book/chapter-1/">Chapter 1</a></li>
              <li><a href="/book/chapter-1?utm_source=newsletter#comments">Chapter 1 duplicate</a></li>
              <li><a href="/book/chapter-2?b=2&a=1&utm_medium=email">Chapter 2</a></li>
            </ol>
          </body>
        </html>
      `,
    });

    const result = await service.discover("https://example.com/book");

    expect(normalizeDiscoveryUrl("https://EXAMPLE.com/book/chapter-1/?utm_source=x#top")).toBe(
      "https://example.com/book/chapter-1",
    );
    expect(result.chapters.map((chapter) => chapter.url)).toEqual([
      "https://example.com/book/chapter-1",
      "https://example.com/book/chapter-2?a=1&b=2",
    ]);
  });

  it("falls back to a low-confidence current-page chapter for ordinary articles", async () => {
    const service = serviceWithPages({
      "https://example.com/blog/post-1": `
        <html>
          <head><title>A normal blog post - Example</title></head>
          <body>
            <h1>A normal blog post</h1>
            <article><p>This is just one standalone article.</p></article>
            <footer>
              <a href="/tag/news">News tag</a>
              <a href="/privacy">Privacy</a>
            </footer>
          </body>
        </html>
      `,
    });

    const result = await service.discover("https://example.com/blog/post-1");

    expect(result.discoveryMode).toBe("article_fallback");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.warnings.join(" ")).toContain("current page only");
    expect(result.chapters).toEqual([
      {
        index: 0,
        title: "A normal blog post",
        url: "https://example.com/blog/post-1",
        selectedByDefault: true,
        confidence: 0.32,
      },
    ]);
  });
});

function serviceWithPages(pages: Record<string, string>): BookDiscoveryService {
  return new BookDiscoveryService(baseConfig, async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const html = pages[url];
    if (!html) {
      return new Response("not found", { status: 404 });
    }
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}
