export type VideoPlatform = "youtube" | "bilibili";

export type VideoUrlDetection =
  | {
      platform: VideoPlatform;
      videoId: string;
      canonicalUrl: string;
      externalPlaybackUrl: string;
      isSupported: true;
      warnings: string[];
    }
  | {
      platform: null;
      videoId: null;
      canonicalUrl: null;
      externalPlaybackUrl: string | null;
      isSupported: false;
      warnings: string[];
    };

export interface VideoUrlMetadata {
  title: string | null;
  description: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  metadataSource: "url";
}

export type VideoDetectionResponse = VideoUrlDetection & {
  metadata?: VideoUrlMetadata;
};

export type VideoBookSourceType = VideoPlatform | "uploaded_media";

export type VideoImportStatus =
  | "PROCESSING"
  | "TRANSCRIPT_UNAVAILABLE"
  | "READY"
  | "FAILED";

export type VideoTranscriptStatus = "PENDING" | "UNAVAILABLE" | "READY";

export interface VideoChapterRecord {
  id: string;
  bookId: string;
  index: number;
  kind: "video_section";
  title: string;
  sourceUrl: string;
  status: VideoImportStatus;
  durationMs: number | null;
  transcriptPath?: string;
  scriptPath?: string;
  playedPositionMs: number;
}

export interface VideoBookRecord {
  bookId: string;
  kind: "video";
  sourceType: VideoBookSourceType;
  sourceRootUrl: string;
  submittedUrl: string;
  platform: VideoPlatform;
  videoId: string;
  externalPlaybackUrl: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  lastPositionMs: number;
  lastOpenedAt: string | null;
  status: VideoImportStatus;
  transcriptStatus: VideoTranscriptStatus;
  warnings: string[];
  chapters: VideoChapterRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface VideoImportJobRecord {
  jobId: string;
  bookId: string;
  sourceType: "video";
  platform: VideoPlatform;
  videoId: string;
  externalPlaybackUrl: string;
  status: VideoImportStatus;
  progress: number;
  transcriptUrl: string | null;
  scriptUrl: string | null;
  errorMessage: string | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VideoImportResponse {
  bookId: string;
  jobId: string;
  platform: VideoPlatform;
  videoId: string;
  title: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  externalPlaybackUrl: string;
  status: VideoImportStatus;
  warnings: string[];
}

export interface VideoImportStatusResponse {
  status: VideoImportStatus;
  progress: number;
  bookId: string;
  transcriptUrl: string | null;
  scriptUrl: string | null;
  errorMessage: string | null;
  warnings: string[];
}
