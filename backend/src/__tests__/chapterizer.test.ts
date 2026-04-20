import { describe, expect, it } from "vitest";

import { buildChapters } from "../utils/chapterizer.js";

describe("buildChapters", () => {
  it("splits content by headings when present", () => {
    const chapters = buildChapters(
      "Fallback",
      `
        <p>Intro paragraph.</p>
        <h2>Chapter A</h2>
        <p>Sentence one. Sentence two.</p>
        <h2>Chapter B</h2>
        <p>Sentence three. Sentence four.</p>
      `,
      "Intro paragraph. Sentence one. Sentence two. Sentence three. Sentence four.",
    );

    expect(chapters).toHaveLength(3);
    expect(chapters[0]?.title).toBe("Fallback");
    expect(chapters[1]?.title).toBe("Chapter A");
    expect(chapters[2]?.title).toBe("Chapter B");
  });

  it("falls back to automatic chunking without headings", () => {
    const repeated = Array.from({ length: 80 }, (_, index) => `Sentence ${index + 1}.`).join(" ");
    const chapters = buildChapters("Long Read", "<p>No headings here.</p>", repeated);

    expect(chapters.length).toBeGreaterThanOrEqual(1);
    expect(chapters[0]?.title.startsWith("Long Read")).toBe(true);
  });
});
