import type { VideoUrlDetection } from "./video-types.js";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_BV_ID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

export function detectVideoUrl(inputUrl: string): VideoUrlDetection {
  let url: URL;
  try {
    url = new URL(inputUrl.trim());
  } catch {
    return unsupported(null, ["Invalid URL"]);
  }

  const youtube = detectYouTubeUrl(url);
  if (youtube) {
    return youtube;
  }

  const bilibili = detectBilibiliUrl(url);
  if (bilibili) {
    return bilibili;
  }

  return unsupported(url.toString(), [
    "Unsupported video URL. Nova currently supports YouTube and Bilibili BV URLs.",
  ]);
}

function detectYouTubeUrl(url: URL): VideoUrlDetection | null {
  const hostname = normalizedHostname(url);
  let videoId: string | null = null;

  if (hostname === "youtu.be") {
    videoId = firstPathPart(url);
  } else if (isYouTubeHost(hostname)) {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      videoId = pathPartAfter(url, "embed") ?? pathPartAfter(url, "v");
    }
  }

  if (!videoId || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    return null;
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    platform: "youtube",
    videoId,
    canonicalUrl,
    externalPlaybackUrl: canonicalUrl,
    isSupported: true,
    warnings: [],
  };
}

function detectBilibiliUrl(url: URL): VideoUrlDetection | null {
  const hostname = normalizedHostname(url);
  if (!isBilibiliHost(hostname)) {
    return null;
  }

  const rawVideoId = pathPartAfter(url, "video");
  if (!rawVideoId) {
    return null;
  }

  const videoId = normalizeBilibiliVideoId(rawVideoId);
  if (!videoId) {
    return null;
  }

  const canonicalUrl = `https://www.bilibili.com/video/${videoId}`;
  return {
    platform: "bilibili",
    videoId,
    canonicalUrl,
    externalPlaybackUrl: canonicalUrl,
    isSupported: true,
    warnings: [],
  };
}

function unsupported(
  externalPlaybackUrl: string | null,
  warnings: string[],
): VideoUrlDetection {
  return {
    platform: null,
    videoId: null,
    canonicalUrl: null,
    externalPlaybackUrl,
    isSupported: false,
    warnings,
  };
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function isYouTubeHost(hostname: string): boolean {
  return hostname === "youtube.com" || hostname === "m.youtube.com";
}

function isBilibiliHost(hostname: string): boolean {
  return hostname === "bilibili.com" || hostname === "m.bilibili.com";
}

function firstPathPart(url: URL): string | null {
  return url.pathname.split("/").filter(Boolean)[0] ?? null;
}

function pathPartAfter(url: URL, marker: string): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf(marker);
  if (index === -1) {
    return null;
  }
  return parts[index + 1] ?? null;
}

function normalizeBilibiliVideoId(rawVideoId: string): string | null {
  const videoId = rawVideoId.startsWith("bv")
    ? `BV${rawVideoId.slice(2)}`
    : rawVideoId;
  return BILIBILI_BV_ID_PATTERN.test(videoId) ? videoId : null;
}
