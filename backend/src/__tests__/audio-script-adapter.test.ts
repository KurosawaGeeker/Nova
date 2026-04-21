import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { AudioScriptAdapter } from "../services/audio-script-adapter.js";
import type { ChapterPlan, ExtractedArticle } from "../types.js";

const baseConfig: AppConfig = {
  port: 8787,
  host: "0.0.0.0",
  publicBaseUrl: "http://localhost:8787",
  dataDir: "/tmp/nova-test",
  fetchTimeoutMs: 30_000,
  maxJobAgeHours: 24,
  importConcurrency: 3,
  openAiModel: "gpt-4o-mini-tts",
  openAiPreprocessModel: "gpt-4o-mini",
  openAiAdaptModel: "gpt-4o-mini",
  openAiVoice: "alloy",
  ttsMode: "mock",
  contentPreprocessMode: "heuristic",
  audioAdaptMode: "off",
  userAgent: "test-agent",
};

const article: ExtractedArticle = {
  title: "Journey mapping",
  contentHtml: "<h2>How to use</h2><p>Original text</p>",
  textContent: "Original text",
  language: "en",
};

describe("audio-script-adapter", () => {
  it("rewrites chapters for listening when adaptation is enabled", async () => {
    const chapters: ChapterPlan[] = [
      {
        id: "chapter-1",
        title: "How to use",
        sentences: [
          "User journey maps often start as a dense checklist.",
          "The spoken version should be easier to follow.",
        ],
      },
    ];

    const adapter = new AudioScriptAdapter(
      { ...baseConfig, audioAdaptMode: "openai" },
      async () =>
        "Let me walk you through it. User journey maps often start as a dense checklist, so the spoken version should be easier to follow.",
    );

    const adapted = await adapter.adaptChapters(article, chapters);
    expect(adapted[0]?.sentences.join(" ")).toContain("Let me walk you through it.");
    expect(adapted[0]?.sentences.join(" ")).toContain("easier to follow");
  });

  it("falls back to the original chapter when the rewrite is too short", async () => {
    const chapters: ChapterPlan[] = [
      {
        id: "chapter-1",
        title: "How to use",
        sentences: [
          "User journey maps often start as a dense checklist.",
          "The spoken version should be easier to follow.",
        ],
      },
    ];

    const adapter = new AudioScriptAdapter(
      { ...baseConfig, audioAdaptMode: "openai" },
      async () => "Too short.",
    );

    const adapted = await adapter.adaptChapters(article, chapters);
    expect(adapted).toEqual(chapters);
  });
});
