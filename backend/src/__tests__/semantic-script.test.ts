import { describe, expect, it } from "vitest";

import { buildSemanticSegments } from "../utils/semantic-script.js";

describe("semantic-script", () => {
  it("groups sentence cues into natural semantic segments instead of fixed windows", () => {
    const script = buildSemanticSegments({
      bookId: "book-1",
      title: "Test Book",
      chapters: [
        {
          chapterIndex: 0,
          title: "Chapter One",
          cues: [
            { text: "第一句介绍背景。", startMs: 0, endMs: 1_000 },
            { text: "第二句继续铺垫。", startMs: 1_000, endMs: 2_000 },
            {
              text:
                "第三句把同一个语义段讲完整，并且让文本长度足够触发自然边界，而不是依赖固定时长；这里继续补充背景、人物、原因、影响和听感线索，让这个段落达到更接近真实长段落的长度，然后在句号处自然收束。",
              startMs: 2_000,
              endMs: 3_000,
            },
            { text: "新的想法重新开始。", startMs: 3_000, endMs: 4_000 },
          ],
        },
      ],
    });

    expect(script.version).toBe(1);
    expect(script.segments).toHaveLength(2);
    expect(script.segments[0]).toMatchObject({
      chapterIndex: 0,
      startMs: 0,
      endMs: 3_000,
      title: "Chapter One",
      kind: "paragraph",
    });
    expect(script.segments[1]?.text).toBe("新的想法重新开始。");
  });
});
