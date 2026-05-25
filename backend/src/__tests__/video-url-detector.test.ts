import { describe, expect, it } from "vitest";

import { detectVideoUrl } from "../services/video-url-detector.js";

describe("video-url-detector", () => {
  it.each([
    ["standard watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["short link", "https://youtu.be/dQw4w9WgXcQ?t=43"],
    ["mobile", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be"],
    ["embed", "https://www.youtube.com/embed/dQw4w9WgXcQ?start=30"],
  ])("normalizes YouTube %s URLs", (_label, url) => {
    const result = detectVideoUrl(url);

    expect(result).toMatchObject({
      platform: "youtube",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      externalPlaybackUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      isSupported: true,
    });
  });

  it.each([
    ["desktop", "https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999"],
    ["mobile", "https://m.bilibili.com/video/BV1xx411c7mD"],
  ])("normalizes Bilibili %s BV URLs", (_label, url) => {
    const result = detectVideoUrl(url);

    expect(result).toMatchObject({
      platform: "bilibili",
      videoId: "BV1xx411c7mD",
      canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      externalPlaybackUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      isSupported: true,
    });
  });

  it("returns unsupported for unrelated URLs", () => {
    const result = detectVideoUrl("https://example.com/watch?v=dQw4w9WgXcQ");

    expect(result).toMatchObject({
      platform: null,
      videoId: null,
      canonicalUrl: null,
      externalPlaybackUrl: "https://example.com/watch?v=dQw4w9WgXcQ",
      isSupported: false,
    });
    expect(result.warnings.join(" ")).toContain("Unsupported video URL");
  });
});
