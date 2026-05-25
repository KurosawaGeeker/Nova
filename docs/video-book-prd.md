# Video Book PRD

## Purpose

Nova currently imports readable web pages and converts them into local audiobooks. The next source type is long-form learning video from YouTube and Bilibili.

The goal is not to build a video downloader. The goal is to turn a video URL into a `Video Book`: a learning object with metadata, timeline transcript, semantic segments, playback progress, and context-aware Q&A. Video playback should stay on the official platform player or platform app whenever possible.

V1 should not download, cache, or store platform video. V1 may cache text artifacts such as captions, transcripts, semantic segments, summaries, and user Q&A. Audio caching is allowed only for uploaded user-owned media or explicitly permitted sources in later phases.

This document is intended for subagents. Implement in phases, keep changes verifiable, and do not mix this milestone with whole-book import unless a shared model change is explicitly needed.

## Product Requirements

### Goals

- Users can paste a YouTube or Bilibili video URL into Nova.
- Nova recognizes the platform and extracts stable video metadata.
- Nova creates a `Video Book` card in the library.
- Nova obtains or generates a timestamped transcript.
- Nova builds `script.json` semantic segments from the transcript.
- Nova can answer questions using current video timestamp context, model knowledge, and optional web search.
- Nova can replay or jump to a meaningful previous segment when current playback time is known.
- Nova does not store platform video or bypass platform playback controls in V1.
- Video books should fit the same long-term `Book -> Chapter -> Segment` model as article books.

### Non-Goals for V1

- No YouTube/Bilibili video downloading.
- No audio extraction from platform-hosted videos.
- No DRM or paywall bypass.
- No background playback of platform video unless the official player/app supports it.
- No attempt to remove ads or alter the platform player.
- No full visual understanding of video frames in V1.
- No live stream support.

## Product Model

### Book

Video imports create a `Book` with:

- `kind`: `video`
- `sourceType`: `youtube | bilibili | uploaded_media`
- `sourceRootUrl`: original video URL
- `externalPlaybackUrl`: official video URL
- `title`
- `description?`
- `coverPath?` or `thumbnailUrl`
- `durationMs`
- `lastPositionMs`
- `lastOpenedAt`
- `status`: `DISCOVERED | TRANSCRIPT_READY | PROCESSING | READY | FAILED`

### Chapter

V1 can use one chapter per video. Later phases may split long videos into sections.

Fields:

- `id`
- `bookId`
- `index`: default `0`
- `kind`: `video_section`
- `title`
- `sourceUrl`
- `status`
- `durationMs`
- `transcriptPath?`
- `scriptPath?`
- `playedPositionMs`

### Segment

Reuse the semantic segment model from voice commands.

Fields:

- `id`
- `bookId`
- `chapterId`
- `chapterIndex`
- `startMs`
- `endMs`
- `title?`
- `text`
- `kind`: `video_section | paragraph | list | quote`

## User Flows

### Flow A: Import Video URL

1. User taps `Import URL`.
2. User pastes a YouTube or Bilibili URL.
3. Backend detects platform and returns video metadata.
4. Backend attempts transcript discovery.
5. App creates a `Video Book` card.
6. If transcript is available, App shows `Transcript ready`.
7. If transcript is missing, App shows `Transcript unavailable` and offers later STT/upload path when available.

### Flow B: Watch and Ask

1. User opens a `Video Book`.
2. App opens the official platform player inside WebView when acceptable, or launches the platform app/browser.
3. App tracks current timestamp when technically available.
4. User triggers voice/text command.
5. Nova finds transcript segments around current timestamp.
6. Backend answers using timestamp context, model knowledge, and optional web search.

### Flow C: Timestamp Sync Fallback

Some platform players may not expose current time reliably.

1. User opens video externally.
2. Nova keeps a transcript/timeline panel.
3. User can manually set current timestamp or tap a transcript row.
4. Ask/replay uses the manually selected timestamp.

## Platform Policy and Playback Constraints

### YouTube

V1 should use official playback surfaces:

- Android app intent to YouTube app/browser.
- WebView with official embed player only if it complies with platform rules and works reliably.

V1 should not:

- download YouTube video or audio
- expose raw stream URLs
- hide or replace official player UI
- remove ads or platform controls

Captions should be obtained only through legitimate APIs or publicly available caption surfaces that do not require bypassing access controls. If official API access is unavailable, V1 can mark transcript as unavailable.

### Bilibili

V1 should prefer:

- app/browser intent to official page
- WebView playback when stable

Bilibili metadata and transcript availability may be less stable than YouTube. Implement Bilibili support behind clear error states and avoid fragile assumptions.

## Backend API

Keep endpoint names under `/v1`.

### Detect Video Source

```http
POST /v1/videos/detect
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=..."
}
```

Response:

```json
{
  "platform": "youtube",
  "videoId": "...",
  "canonicalUrl": "https://www.youtube.com/watch?v=...",
  "externalPlaybackUrl": "https://www.youtube.com/watch?v=...",
  "isSupported": true,
  "warnings": []
}
```

### Import Video Book

```http
POST /v1/videos/import
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=..."
}
```

Response:

```json
{
  "bookId": "book_...",
  "jobId": "job_...",
  "platform": "youtube",
  "videoId": "...",
  "title": "Video title",
  "durationMs": 3600000,
  "thumbnailUrl": "https://...",
  "status": "PROCESSING"
}
```

Rules:

- This endpoint must not download video or audio.
- This endpoint may fetch metadata and transcript/caption text.
- If transcript retrieval is slow, return a job immediately and process transcript in the background.

### Get Video Import Status

```http
GET /v1/videos/imports/:jobId
```

Response:

```json
{
  "status": "TRANSCRIPT_READY",
  "progress": 100,
  "bookId": "book_...",
  "transcriptUrl": "/v1/videos/books/book_.../transcript.vtt",
  "scriptUrl": "/v1/videos/books/book_.../script.json",
  "errorMessage": null
}
```

### Video Context Q&A

This can reuse the voice command endpoint once the request supports `sourceType=video`.

Suggested request extension:

```json
{
  "bookId": "book_...",
  "sourceType": "video",
  "positionMs": 930000,
  "currentSegment": {},
  "previousSegment": {},
  "nextSegments": [],
  "debugTranscript": "刚才讲的核心是什么？"
}
```

## Transcript Strategy

Priority order:

1. Official captions or transcript API if available and authorized.
2. Public caption surface if stable and does not bypass access controls.
3. User-provided transcript file.
4. User-uploaded audio/video file processed with STT.
5. Mark transcript unavailable.

Transcript output:

- `transcript.vtt`: timestamped captions.
- `script.json`: semantic segments, generated from transcript.
- optional `summary.json`: chapter-like section summaries for long videos.

Segment generation:

- Merge short captions into coherent 30-120 second semantic segments.
- Prefer natural topic boundaries when captions include punctuation or section markers.
- Avoid fixed 15 second chunks.
- Keep original timestamp precision so replay/jump works.

## Android UX

### Library

Video books appear as normal library cards.

Card fields:

- title
- platform badge: `YouTube` or `Bilibili`
- transcript status
- last watched timestamp
- thumbnail if available

### Video Book Screen

V1 screen layout:

- top: player surface or `Open in YouTube/Bilibili` button
- middle: current timestamp and transcript segment
- bottom: transcript list and Ask controls

If embedded playback is unstable:

- use external intent
- keep transcript and Ask UI in Nova
- allow manual timestamp sync

### Interaction

Supported V1 commands:

- `上一段我没听懂，重播一下`
- `刚才这段讲的核心是什么`
- `解释一下这个概念`
- `总结前十分钟`
- `这个观点和我之前看的文章有什么关系`

Replay behavior:

- If Nova knows current timestamp, jump or guide to the previous semantic segment.
- If the official player cannot be controlled, show the target timestamp and let the user tap to open video at that time when platform supports timestamp URLs.

## Backend Implementation Phases

### Phase 1: URL Detection and Metadata

Deliverables:

- Add platform detector for YouTube and Bilibili URLs.
- Add `POST /v1/videos/detect`.
- Add metadata fetcher where stable and allowed.
- Add tests for URL variants.

Acceptance:

- YouTube standard, short, mobile, and embed URLs normalize to one video ID.
- Bilibili `BV` URLs normalize to one video ID.
- Unsupported URLs return `isSupported=false` with warnings.

### Phase 2: Video Book Import Without Audio

Deliverables:

- Add `POST /v1/videos/import`.
- Create a `Book(kind=video)` compatible response.
- Fetch transcript/captions when available.
- Generate `transcript.vtt` and `script.json`.
- Add status endpoint.

Acceptance:

- No video or audio file is downloaded.
- Transcript-ready imports support timeline context.
- Transcript-missing imports fail gracefully or stay in a clear `TRANSCRIPT_UNAVAILABLE` state.

### Phase 3: Android Video Book Shell

Deliverables:

- Detect video URLs in import flow.
- Show video import status.
- Show video book card in library.
- Add video book screen with external open button and transcript list.

Acceptance:

- A YouTube/Bilibili URL does not enter the article TTS pipeline.
- Imported video book can be opened from library.
- Transcript list can set current timestamp context.

### Phase 4: Video Q&A Context

Deliverables:

- Extend voice/text command request to support video source.
- Use current timestamp to select transcript segments.
- Reuse model/web-search answer path.
- Support debug text command before voice input.

Acceptance:

- User can ask a question about the current timestamp.
- Answer cites or references current transcript context naturally.
- Missing timestamp shows a clear prompt to select or sync timestamp.

### Phase 5: Embedded Playback Experiments

Deliverables:

- Prototype YouTube official embed in WebView or approved player surface.
- Prototype Bilibili WebView playback.
- Capture current time if technically available.

Acceptance:

- If embedded player is stable, it can drive current timestamp automatically.
- If not stable, external playback fallback remains the default.

### Phase 6: User-Owned Media Upload

Deliverables:

- Allow upload of local video/audio file.
- Extract audio with ffmpeg.
- Run STT.
- Generate transcript, script, and optional local audio.

Acceptance:

- User-owned media can become a fully local audio/transcript book.
- This path does not apply to YouTube/Bilibili platform URLs.

## Testing Plan

Backend:

- URL detector tests for YouTube and Bilibili variants.
- Unsupported URL tests.
- Transcript parser tests.
- Segment generation tests from dense captions.
- Status transition tests.

Android:

- Import flow routes video URL to video import, not article import.
- Library renders video card.
- Video book screen opens external platform URL.
- Transcript row selection updates timestamp context.
- Debug text command answers against selected timestamp.

Manual:

- YouTube video with captions.
- YouTube video without captions.
- Bilibili BV video.
- Long video over 60 minutes.
- Unsupported URL fallback.

## Deployment and Configuration

Recommended config:

- `VIDEO_IMPORT_ENABLED=true`
- `YOUTUBE_IMPORT_ENABLED=true`
- `BILIBILI_IMPORT_ENABLED=true`
- `VIDEO_TRANSCRIPT_MAX_DURATION_MINUTES=180`
- `VIDEO_TRANSCRIPT_MAX_SEGMENTS=500`

Optional future config:

- `YOUTUBE_API_KEY`
- `BILIBILI_API_KEY`

Do not require these keys for URL detection.

## Open Questions

- Should V1 create `Video Book` when transcript is unavailable, or require transcript before adding to library?
- Should YouTube playback default to external app or embedded WebView?
- Should Bilibili support be hidden behind an experimental flag until stable?
- Should Nova support user-uploaded transcript files before user-uploaded media files?
- Should video transcript Q&A share memory with article/audio Q&A for the same topic?

