import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import type { ExtractedArticle } from "../types.js";
import {
  buildArticleFromBlocks,
  ContentPreprocessor,
  extractContentBlocks,
  filterBlocksHeuristically,
} from "../services/content-preprocessor.js";

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
  openAiVoice: "alloy",
  ttsMode: "mock",
  contentPreprocessMode: "heuristic",
  userAgent: "test-agent",
};

describe("content-preprocessor", () => {
  it("extracts readable blocks in order", () => {
    const blocks = extractContentBlocks(`
      <div>
        <p>Intro paragraph.</p>
        <section>
          <h2>Deep Dive</h2>
          <p>Useful details.</p>
        </section>
      </div>
    `);

    expect(blocks.map((block) => [block.tagName, block.text])).toEqual([
      ["p", "Intro paragraph."],
      ["h2", "Deep Dive"],
      ["p", "Useful details."],
    ]);
  });

  it("drops obvious UI chrome heuristically", () => {
    const blocks = extractContentBlocks(`
      <p>Sign in</p>
      <p>Table of contents</p>
      <h2>HTTP basics</h2>
      <p>HTTP is an application-layer protocol for transferring hypermedia documents.</p>
      <p>Share</p>
    `);

    const filtered = filterBlocksHeuristically(blocks);
    expect(filtered.map((block) => block.text)).toEqual([
      "HTTP basics",
      "HTTP is an application-layer protocol for transferring hypermedia documents.",
    ]);
  });

  it("preserves model-selected blocks when they stay close to heuristic coverage", async () => {
    const article: ExtractedArticle = {
      title: "HTTP basics",
      contentHtml: `
        <p>Sign in</p>
        <h2>HTTP basics</h2>
        <p>HTTP is an application-layer protocol for transferring hypermedia documents between clients and servers. It is the foundation of data communication for the Web.</p>
        <p>Related articles</p>
      `,
      textContent:
        "Sign in HTTP basics HTTP is an application-layer protocol for transferring hypermedia documents between clients and servers. It is the foundation of data communication for the Web. Related articles",
      language: "en",
    };

    const preprocessor = new ContentPreprocessor(
      { ...baseConfig, contentPreprocessMode: "openai" },
      async (_inputArticle, blocks) => blocks.slice(1, 3).map((block) => block.id),
    );

    const cleaned = await preprocessor.preprocess(article);
    expect(cleaned.textContent).toContain("HTTP is an application-layer protocol");
    expect(cleaned.textContent).not.toContain("Sign in");
    expect(cleaned.textContent).not.toContain("Related articles");
  });

  it("falls back to heuristic output when the model drops too much article content", async () => {
    const article: ExtractedArticle = {
      title: "Journey map",
      contentHtml: `
        <h2>How to use it</h2>
        <p>Each map should stay anchored in user research rather than internal opinion.</p>
        <p>✓ 这样做</p>
        <p>→基于真实用户调研填写，不要用内部假设替代用户声音</p>
        <p>→地图结束要有行动结论，落地到具体的产品决策</p>
        <p>✗ 避免这些</p>
        <p>→用内部会议讨论替代真实用户调研来填写地图</p>
      `,
      textContent:
        "How to use it Each map should stay anchored in user research rather than internal opinion. ✓ 这样做 →基于真实用户调研填写，不要用内部假设替代用户声音 →地图结束要有行动结论，落地到具体的产品决策 ✗ 避免这些 →用内部会议讨论替代真实用户调研来填写地图",
      language: "zh-CN",
    };

    const preprocessor = new ContentPreprocessor(
      { ...baseConfig, contentPreprocessMode: "openai" },
      async (_inputArticle, blocks) =>
        blocks
          .filter((block) => block.text === "How to use it" || block.text === "✓ 这样做")
          .map((block) => block.id),
    );

    const cleaned = await preprocessor.preprocess(article);
    expect(cleaned.textContent).toContain("→基于真实用户调研填写");
    expect(cleaned.textContent).toContain("→用内部会议讨论替代真实用户调研来填写地图");
  });

  it("rebuilds cleaned html without dangling headings", () => {
    const blocks = extractContentBlocks(`
      <h2>Heading</h2>
      <p>Readable paragraph.</p>
      <h2>Trailing heading</h2>
    `);

    const rebuilt = buildArticleFromBlocks(blocks);
    expect(rebuilt.contentHtml).toContain("<h2>Heading</h2>");
    expect(rebuilt.contentHtml).not.toContain("Trailing heading");
    expect(rebuilt.textContent).toContain("Readable paragraph.");
  });
});
