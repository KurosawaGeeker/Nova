import { describe, expect, it } from "vitest";

import { buildWebVtt, formatTimestamp } from "../utils/vtt.js";

describe("formatTimestamp", () => {
  it("formats milliseconds into WebVTT timestamps", () => {
    expect(formatTimestamp(3_723_045)).toBe("01:02:03.045");
  });
});

describe("buildWebVtt", () => {
  it("creates a valid WebVTT body", () => {
    const body = buildWebVtt([
      { text: "Hello world", startMs: 0, endMs: 1_200 },
      { text: "Second cue", startMs: 1_200, endMs: 2_300 },
    ]);

    expect(body).toContain("WEBVTT");
    expect(body).toContain("00:00:00.000 --> 00:00:01.200");
    expect(body).toContain("Second cue");
  });
});
