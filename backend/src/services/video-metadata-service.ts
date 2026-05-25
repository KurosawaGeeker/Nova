import { detectVideoUrl } from "./video-url-detector.js";
import type { VideoDetectionResponse, VideoUrlMetadata } from "./video-types.js";

export class VideoMetadataService {
  async detect(inputUrl: string): Promise<VideoDetectionResponse> {
    const detection = detectVideoUrl(inputUrl);
    if (!detection.isSupported) {
      return detection;
    }

    const metadata = buildUrlLevelMetadata(detection.platform, detection.videoId);
    return {
      ...detection,
      metadata,
      warnings: [
        ...detection.warnings,
        "Metadata is URL-level only in Phase 1; no video, audio, or transcript was downloaded.",
      ],
    };
  }
}

function buildUrlLevelMetadata(
  platform: "youtube" | "bilibili",
  videoId: string,
): VideoUrlMetadata {
  return {
    title: null,
    description: null,
    durationMs: null,
    thumbnailUrl:
      platform === "youtube"
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : null,
    metadataSource: "url",
  };
}
