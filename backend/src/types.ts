export type SourceType = "url" | "pdf" | "epub";

export type ImportStatus =
  | "QUEUED"
  | "FETCHING"
  | "EXTRACTING"
  | "SYNTHESIZING"
  | "PACKAGING"
  | "READY"
  | "FAILED";

export type ImportJobKind = "single_url" | "book_import" | "chapter_import";

export interface ImportJobRecord {
  jobId: string;
  jobKind: ImportJobKind;
  bookId?: string;
  chapterId?: string;
  sourceType: SourceType;
  normalizedUrl: string;
  status: ImportStatus;
  progress: number;
  priority?: number;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
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

export type BookDiscoveryMode =
  | "toc_page"
  | "chapter_sidebar"
  | "article_fallback";

export interface DiscoveredChapter {
  index: number;
  title: string;
  url: string;
  selectedByDefault: boolean;
  confidence: number;
}

export interface BookDiscoveryResult {
  discoveryId: string;
  sourceUrl: string;
  candidateBookTitle: string;
  confidence: number;
  discoveryMode: BookDiscoveryMode;
  warnings: string[];
  chapters: DiscoveredChapter[];
}

export type BookKind = "single_article" | "web_book";

export type BookImportStatus =
  | "DISCOVERED"
  | "IMPORTING"
  | "PARTIAL_READY"
  | "READY"
  | "FAILED"
  | "PAUSED";

export type ChapterImportStatus =
  | "DISCOVERED"
  | "SELECTED"
  | "QUEUED"
  | "FETCHING"
  | "PROCESSING"
  | "SYNTHESIZING"
  | "PACKAGING"
  | "READY"
  | "FAILED"
  | "SKIPPED";

export interface BookRecord {
  id: string;
  title: string;
  description?: string;
  kind: BookKind;
  sourceRootUrl: string;
  language?: string;
  status: BookImportStatus;
  coverPath?: string;
  chapterCount: number;
  readyChapterCount: number;
  failedChapterCount: number;
  durationMs: number;
  lastChapterIndex?: number;
  lastPositionMs?: number;
  lastOpenedAt?: string;
  importJobId?: string;
  discoveryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterImportRecord {
  id: string;
  bookId: string;
  index: number;
  title: string;
  sourceUrl: string;
  status: ChapterImportStatus;
  progress: number;
  audioPath?: string;
  subtitlePath?: string;
  scriptPath?: string;
  packagePath?: string;
  downloadUrl?: string;
  durationMs: number;
  playedPositionMs: number;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  errorMessage?: string;
  remoteChapterJobId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SelectedBookChapterInput {
  index: number;
  title: string;
  url: string;
}

export interface CreateBookImportInput {
  discoveryId?: string;
  title: string;
  sourceRootUrl: string;
  chapters: SelectedBookChapterInput[];
}

export interface CreateBookImportResult {
  bookId: string;
  jobId: string;
  chapterJobs: Array<{
    chapterId: string;
    index: number;
    status: ChapterImportStatus;
  }>;
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

export type SemanticSegmentKind =
  | "paragraph"
  | "heading"
  | "sentence"
  | "section"
  | "list"
  | "quote"
  | "table";

export interface SemanticSegment {
  id: string;
  chapterIndex: number;
  startMs: number;
  endMs: number;
  title?: string;
  text: string;
  kind: SemanticSegmentKind;
}

export interface BookScript {
  version: 1;
  bookId: string;
  title: string;
  segments: SemanticSegment[];
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
  scriptFile?: string;
  chapters: ChapterManifest[];
}
