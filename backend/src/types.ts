export type SourceType = "url" | "pdf" | "epub";

export type ImportStatus =
  | "QUEUED"
  | "FETCHING"
  | "EXTRACTING"
  | "SYNTHESIZING"
  | "PACKAGING"
  | "READY"
  | "FAILED";

export interface ImportJobRecord {
  jobId: string;
  bookId?: string;
  sourceType: SourceType;
  normalizedUrl: string;
  status: ImportStatus;
  progress: number;
  errorMessage?: string;
  downloadUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedArticle {
  title: string;
  contentHtml: string;
  textContent: string;
  language: string;
  excerpt?: string;
  siteName?: string;
  coverUrl?: string;
}

export interface ChapterPlan {
  id: string;
  title: string;
  sentences: string[];
}

export interface SentenceCue {
  text: string;
  startMs: number;
  endMs: number;
}

export interface ChapterManifest {
  title: string;
  durationMs: number;
  audioFile: string;
  subtitleFile: string;
}

export interface BookManifest {
  bookId: string;
  title: string;
  sourceType: SourceType;
  sourceUrl: string;
  language: string;
  coverFile?: string;
  totalDurationMs: number;
  chapters: ChapterManifest[];
}
