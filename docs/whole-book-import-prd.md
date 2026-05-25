# Whole-Book Import and Chapter Pipeline PRD

## Purpose

Nova currently treats one imported URL as one audiobook card. This breaks down when a URL is only one chapter inside a larger web book, documentation site, course, or long-form guide. Users must manually copy each next chapter, and the bookshelf becomes crowded with page-level cards.

This PRD defines a phased implementation for whole-book import:

- discover a book or long-form content structure from one URL
- let the user confirm which chapters to import
- import selected chapters as a pipeline, so chapter 1 becomes playable first while later chapters continue processing
- represent the library as `Book -> Chapter -> Segment`, not `URL -> Book`
- support resume, chapter progress, and a prominent continue-listening entry point

This document is intended for implementation by subagents. Keep changes incremental and verify each phase before moving to the next.

## Product Requirements

### Goals

- A pasted URL can be treated as either a single article or a candidate whole book.
- Whole-book discovery must produce a preview before any expensive TTS work starts.
- Users can choose import scope from the discovered chapter list.
- Users can start listening as soon as the first selected chapter is ready.
- Remaining selected chapters continue importing in the background while the user listens.
- The bookshelf displays one card per book, not one card per source URL.
- Opening a book shows a second-level chapter list with per-chapter status.
- App launch should promote the last listened book and chapter.
- A failed chapter should not block the rest of the book.
- Completed chapters should never be regenerated unless explicitly retried or refreshed.

### Non-Goals for V1

- No unlimited crawler.
- No automatic crawling of unrelated site pages, related posts, ads, category pages, or search results.
- No EPUB/PDF whole-book parsing in this milestone.
- No cloud account, cross-device sync, or shared library.
- No full-book semantic RAG beyond the existing current-context voice command path.
- No DRM bypass or paywall handling.

## User Flows

### Flow A: Directory Page Import

1. User taps `Import URL`.
2. User pastes a table-of-contents URL or book home page.
3. App calls discovery API.
4. App shows a preview screen with detected title, confidence, warnings, and chapter checklist.
5. User uses `Select all`, `Invert`, or individual checkboxes.
6. User confirms.
7. App creates one book and many selected chapter tasks.
8. Chapter 1 is prioritized and becomes playable first.
9. Remaining chapters process in the background.

### Flow B: Chapter Page Import with Reverse Discovery

1. User pastes a URL that is likely a chapter.
2. Backend attempts to find nearby book structure from page navigation, sidebar TOC, canonical links, previous/next links, and same-path URL patterns.
3. If confidence is high enough, App shows the same chapter checklist.
4. If confidence is low, App offers single-article import as fallback.

V1 may ship Flow A first and treat Flow B as best effort.

### Flow C: Continue Listening

1. User opens Nova.
2. Top of the library shows a `Continue listening` card if there is a recent book with saved progress.
3. Tapping it opens the player at the saved book, chapter, and position.
4. If the next chapter is not ready when the current chapter ends, App shows a waiting state and continues polling.

## Domain Model

The current local model should evolve from page-level books to container books.

### Book

Represents one user-facing library card.

Fields:

- `id`
- `title`
- `description?`
- `kind`: `single_article | web_book`
- `sourceRootUrl`
- `language`
- `status`: `DISCOVERED | IMPORTING | PARTIAL_READY | READY | FAILED | PAUSED`
- `coverPath?`
- `chapterCount`
- `readyChapterCount`
- `failedChapterCount`
- `durationMs`
- `lastChapterIndex`
- `lastPositionMs`
- `lastOpenedAt`
- `createdAt`
- `updatedAt`

### Chapter

Represents one playable unit inside a book.

Fields:

- `id`
- `bookId`
- `index`
- `title`
- `sourceUrl`
- `status`: `DISCOVERED | SELECTED | QUEUED | FETCHING | PROCESSING | SYNTHESIZING | DOWNLOADING | READY | FAILED | SKIPPED`
- `progress`
- `audioPath?`
- `subtitlePath?`
- `scriptPath?`
- `durationMs`
- `playedPositionMs`
- `retryCount`
- `maxRetries`: default `2`
- `nextRetryAt?`
- `errorMessage?`
- `remoteChapterJobId?`
- `createdAt`
- `updatedAt`
- `completedAt?`

### Segment

Represents a semantic playback and voice-command unit.

Fields:

- `id`
- `bookId`
- `chapterId`
- `chapterIndex`
- `startMs`
- `endMs`
- `title?`
- `text`
- `kind`: `paragraph | list | section | quote | table`

This should reuse the `script.json` direction from the voice-command milestone.

### ImportJob

Represents work orchestration, not user-facing content.

Fields:

- `id`
- `jobKind`: `single_url | book_discovery | book_import | chapter_import`
- `remoteJobId?`
- `bookId?`
- `chapterId?`
- `status`
- `progress`
- `retryCount`
- `maxRetries`: default `2`
- `nextRetryAt?`
- `errorMessage?`
- `createdAt`
- `updatedAt`

## Backend API

Keep endpoint names under `/v1`.

### Discover Book

```http
POST /v1/books/discover
Content-Type: application/json

{
  "url": "https://example.com/book/chapter-1"
}
```

Response:

```json
{
  "discoveryId": "disc_...",
  "sourceUrl": "https://example.com/book/chapter-1",
  "candidateBookTitle": "Example Book",
  "confidence": 0.86,
  "discoveryMode": "toc_page",
  "warnings": [],
  "chapters": [
    {
      "index": 0,
      "title": "Introduction",
      "url": "https://example.com/book/intro",
      "selectedByDefault": true,
      "confidence": 0.92
    }
  ]
}
```

Rules:

- Discovery must not synthesize audio.
- Discovery should fetch and parse only enough pages to build a safe chapter list.
- Discovery must be bounded by `DISCOVERY_MAX_PAGES`, default `80`.
- Discovery must stay on the same origin unless a canonical same-book link explicitly points elsewhere.
- Discovery should reject or warn about low-confidence results.

### Create Book Import

```http
POST /v1/books
Content-Type: application/json

{
  "discoveryId": "disc_...",
  "title": "Example Book",
  "sourceRootUrl": "https://example.com/book",
  "chapters": [
    {
      "index": 0,
      "title": "Introduction",
      "url": "https://example.com/book/intro"
    }
  ]
}
```

Response:

```json
{
  "bookId": "book_...",
  "jobId": "job_...",
  "chapterJobs": [
    {
      "chapterId": "chapter_...",
      "index": 0,
      "status": "QUEUED"
    }
  ]
}
```

Rules:

- Only selected chapters should be enqueued.
- Chapter 0, or the first selected chapter, must receive highest priority.
- Existing completed chapter packages should be reused if the same source URL and content hash match.

### Get Book Status

```http
GET /v1/books/:bookId
```

Response:

```json
{
  "bookId": "book_...",
  "title": "Example Book",
  "status": "PARTIAL_READY",
  "chapterCount": 10,
  "readyChapterCount": 1,
  "failedChapterCount": 0,
  "chapters": [
    {
      "chapterId": "chapter_...",
      "index": 0,
      "title": "Introduction",
      "status": "READY",
      "progress": 100,
      "downloadUrl": "/v1/books/book_.../chapters/chapter_.../package.zip"
    }
  ]
}
```

### Download Chapter Package

```http
GET /v1/books/:bookId/chapters/:chapterId/package.zip
```

Package contents:

- `chapter.json`
- `audio.m4a`
- `subtitle.vtt`
- `script.json`

`chapter.json`:

```json
{
  "bookId": "book_...",
  "chapterId": "chapter_...",
  "index": 0,
  "title": "Introduction",
  "sourceUrl": "https://example.com/book/intro",
  "durationMs": 123456,
  "audioFile": "audio.m4a",
  "subtitleFile": "subtitle.vtt",
  "scriptFile": "script.json"
}
```

### Retry Chapter

```http
POST /v1/books/:bookId/chapters/:chapterId/retry
```

Rules:

- Only failed or canceled chapters can be manually retried.
- Manual retry resets `retryCount` for that chapter and creates a new chapter job attempt.
- Retry should preserve chapter index and local user progress if the old audio exists.

## Backend Discovery Design

Discovery should produce a candidate chapter list using layered signals:

- Readability title and page title.
- `nav`, `aside`, sidebar TOC, ordered lists, headings with anchors.
- `rel=next`, `rel=prev`, canonical URL, breadcrumb links.
- Links with same origin and similar path prefix.
- Text patterns: `chapter`, `part`, `section`, numeric prefixes, Chinese equivalents such as `第`, `章`, `节`, `目录`, `下一章`.
- Exclusion patterns: comments, tags, author pages, login, share, related posts, ads, privacy, terms, category archives.

Confidence scoring:

- High confidence: ordered TOC with stable same-origin URLs and chapter-like labels.
- Medium confidence: sidebar or nav links with same path and coherent titles.
- Low confidence: many unrelated links, no clear order, or mixed domains.

Safety limits:

- `DISCOVERY_MAX_PAGES=80`
- `DISCOVERY_MAX_CHAPTERS=80`
- `DISCOVERY_MAX_DEPTH=2`
- `DISCOVERY_TIMEOUT_MS=20000`
- same-origin by default

## Chapter Pipeline

The current job model should be split into independent chapter jobs.

Pipeline per chapter:

1. `FETCHING`: fetch chapter HTML.
2. `EXTRACTING`: extract readable content.
3. `PREPROCESSING`: remove UI noise.
4. `ADAPTING`: rewrite into listening-friendly script.
5. `SEGMENTING`: generate `script.json`.
6. `SYNTHESIZING`: generate TTS chunks.
7. `PACKAGING`: write chapter package.
8. `READY`: expose chapter download URL.

Scheduling:

- First selected chapter gets priority `100`.
- Next two selected chapters get priority `80`.
- Remaining chapters get priority by index descending from `50`.
- If the app reports user intent to play a later chapter, raise that chapter and the next two chapters.
- Default concurrency should be conservative for the current Lightsail size: `CHAPTER_IMPORT_CONCURRENCY=1` or `2`.

Failure isolation:

- A failed chapter attempt should automatically retry up to `2` times before the chapter is marked `FAILED`.
- Automatic retries should use short exponential backoff: attempt 1 immediately, retry 1 after about `30s`, retry 2 after about `2m`.
- Retryable failures include network timeout, upstream 5xx, transient OpenAI/API connection errors, and temporary package write failures.
- Non-retryable failures include invalid URL, unsupported content type, empty extraction result, explicit 4xx from the source page, quota or authentication errors, and user cancellation.
- A chapter is marked `FAILED` only after retry attempts are exhausted or a non-retryable error occurs.
- Automatic retry state must be visible in chapter status through `retryCount`, `maxRetries`, `nextRetryAt`, and `errorMessage`.
- The book becomes `PARTIAL_READY` if at least one chapter is ready.
- The book becomes `READY` only when all selected chapters are ready or skipped.

## Android UX

### Import Entry

Current `Import URL` should become an import decision flow:

- User pastes one or more URLs.
- For one URL, App can show actions:
  - `Import as article`
  - `Discover book`
- For many URLs, keep current batch article import, but also offer creating one book from selected URLs later.

### Discovery Preview Screen

Screen contents:

- Candidate book title, editable.
- Source URL.
- Confidence label.
- Warnings.
- Chapter checklist.
- Actions:
  - `Select all`
  - `Invert`
  - `Import selected`
  - `Import current page only`
  - `Cancel`

Selection behavior:

- Default selected chapters come from backend confidence.
- User can select none, but `Import selected` is disabled until at least one chapter is selected.
- Large lists should be virtualized or lazy-rendered.

### Library

Library card should represent `Book`.

Card fields:

- title
- status
- ready count / total selected count
- current chapter title
- last listened progress
- error count if any

Top section:

- `Continue listening` card when `lastOpenedAt` exists.
- Tapping it opens player directly.

### Book Detail

Book detail screen shows chapters.

Chapter row fields:

- index
- title
- status
- progress
- retry state, if active: `retrying 1/2`, `retrying 2/2`, or `retry scheduled`
- duration if ready
- retry action if failed
- play action if ready

### Player

Player changes:

- Queue should be chapter-aware.
- At chapter end:
  - If next selected chapter is ready, continue.
  - If next selected chapter is processing, show waiting state and poll.
  - If next selected chapter failed, offer skip or retry.
- Save progress as `book.lastChapterIndex`, `book.lastPositionMs`, and chapter `playedPositionMs`.

## Local Persistence and Migration

Because the current app has existing single-article books, migration must preserve them.

Migration strategy:

- Existing books become `kind=single_article`.
- Existing chapters remain under their existing book.
- Existing import jobs remain valid.
- New whole-book fields get defaults.
- No destructive migration.

Room migration must be explicit if schema version changes.

## Phased Implementation Plan

### Phase 0: Stabilize Current Import State

Dependencies:

- Keep the recently fixed URL dedupe, submit loading, and stuck-job failure behavior.
- Keep voice-command `script.json` support.

Deliverables:

- Ensure old single-article import still works.
- Ensure old book packages without `script.json` do not crash playback.

Validation:

- Android `compileDebugKotlin`.
- Backend `typecheck` and tests.

### Phase 1: Backend Discovery API

Deliverables:

- Add `/v1/books/discover`.
- Implement bounded TOC/link discovery.
- Return candidate title, confidence, warnings, chapter list.
- Add unit tests for:
  - TOC page
  - chapter page with sidebar
  - unrelated link exclusion
  - duplicate URL normalization

Acceptance:

- Discovery never starts TTS.
- Low-confidence discovery returns warnings or fallback guidance.
- Same-origin and max chapter limits are enforced.

### Phase 2: Android Discovery Preview

Deliverables:

- Add discovery call to API client.
- Add import preview screen.
- Add checklist with select all and invert.
- Confirm selected chapters and create local placeholder book/chapters.

Acceptance:

- User can cancel without creating jobs.
- User can import only selected chapters.
- Existing single-article import remains available.

### Phase 3: Backend Chapter-Level Import

Deliverables:

- Add `/v1/books` create-confirmed-book endpoint.
- Add chapter job queue.
- Add automatic retry tracking for chapter jobs, with `maxRetries=2`.
- Package each chapter independently.
- Add `/v1/books/:bookId` status endpoint.
- Add chapter package download endpoint.

Acceptance:

- First selected chapter can become `READY` while others still process.
- Retryable chapter failures are retried automatically at most `2` times.
- A chapter only becomes `FAILED` after retry exhaustion or a non-retryable error.
- Failed chapter does not block other chapters.
- Re-running the same book can reuse completed chapters when safe.

### Phase 4: Android Chapter Pipeline Download

Deliverables:

- Poll book/chapter status.
- Download each ready chapter package independently.
- Store `audio.m4a`, `subtitle.vtt`, and `script.json` per chapter.
- Update per-chapter local status.

Acceptance:

- First ready chapter appears playable before the whole book is complete.
- Later chapters become playable as they finish.
- Failed chapters show retry.

### Phase 5: Two-Level Library and Continue Listening

Deliverables:

- Library shows one card per book.
- Book detail shows chapters.
- Add `Continue listening` card.
- Save and restore book/chapter/position.

Acceptance:

- Existing single-article books still appear as one-card books.
- A whole book with 10 chapters appears as one card.
- Relaunching App promotes the most recent book.

### Phase 6: Playback-Aware Prefetch Priority

Deliverables:

- When user starts or jumps to a chapter, raise backend priority for that chapter and nearby chapters.
- Add endpoint if needed:

```http
POST /v1/books/:bookId/chapters/:chapterId/prioritize
```

Acceptance:

- Listening chapter 1 while chapters 2-3 process works.
- Jumping to chapter 8 prioritizes 8-10.
- Import concurrency remains bounded.

### Phase 7: Reverse Discovery Hardening

Deliverables:

- Improve chapter-page-to-book discovery.
- Add confidence thresholds.
- Add UI warnings for uncertain results.

Acceptance:

- For known documentation/book pages, discovery returns ordered chapters.
- For ordinary articles, App recommends single-article import.

## Testing Plan

Backend:

- Unit tests for link extraction, URL normalization, confidence scoring, duplicate removal, and exclusion filters.
- Integration test for book creation and chapter queue progression.
- Regression tests that a failed chapter does not fail the book.
- Regression tests for retryable failures: chapter succeeds on retry 1, succeeds on retry 2, and becomes `FAILED` after retry exhaustion.
- Regression tests for non-retryable failures: invalid URL, empty extraction, and auth/quota errors should not retry.

Android:

- Room migration test if available.
- Repository tests for selected chapter creation and status updates.
- WorkManager tests where practical.
- Manual emulator test:
  - discover book
  - select subset
  - first chapter ready and playable
  - later chapter downloads while listening
  - retrying chapter shows retry count and does not block playable chapters
  - failed chapter retry

End-to-end:

- Use a small public documentation page with 3-5 chapters.
- Use a long Chinese article series page.
- Use a normal single article and verify fallback.

## Deployment and Cost Controls

The server currently runs on a small Lightsail instance. Defaults must be conservative.

Recommended defaults:

- `DISCOVERY_MAX_CHAPTERS=50`
- `DISCOVERY_MAX_PAGES=80`
- `CHAPTER_IMPORT_CONCURRENCY=1`
- `CHAPTER_TTS_CONCURRENCY=1`
- `CHAPTER_IMPORT_MAX_RETRIES=2`
- `BOOK_IMPORT_MAX_SELECTED_CHAPTERS=50`

Cost rule:

- Discovery is cheap and can happen before confirmation.
- TTS starts only after explicit user confirmation.
- Skipped chapters must not run TTS.

## Implementation Notes for Subagents

- Do not remove existing single-article import.
- Do not break current Android playback.
- Do not put OpenAI keys into Android.
- Preserve existing dirty worktree changes unless they are part of this task.
- Prefer additive schema migrations over destructive changes.
- Keep old packages playable.
- Use small, verifiable commits or patches if this is split across agents.
- Start with backend discovery and Android preview before changing the full playback model.

## Open Questions

- Should the default import action be `Discover book` or `Import current page only` when one URL is pasted?
- Should discovery results be cached server-side, and for how long?
- Should users be able to reorder chapters before import?
- Should a book support multiple source domains if an official TOC links across domains?
- Should App auto-delete failed or skipped chapter packages after a retention period?
