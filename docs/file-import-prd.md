# File Import PRD

## Purpose

Nova currently imports public web URLs and converts text content into audiobooks. The next import source is local text-based files.

Supported V1 file types:

- HTML
- PDF
- ePub
- TXT
- Markdown

V1 does not support pure image OCR. Scanned PDFs and image-only documents should be detected and shown as unsupported for now. OCR import is a future paid capability.

This document is written for coding agents and should be implemented in phases. It should reuse the existing `Book -> Chapter -> Segment` model and the whole-book chapter confirmation flow where possible.

## Product Goals

- Users can import common long-form text files from Android.
- Nova extracts text and structure from the file.
- Nova proposes chapters before generating audio.
- Users can confirm the chapter range and structure before any TTS cost is incurred.
- Files without explicit chapters still become listenable through AI-assisted or length-based chaptering.
- Text-based PDF is supported.
- Image-only PDF is detected and routed to a future OCR flow.

## Non-Goals for V1

- No OCR for scanned documents.
- No image-to-text extraction.
- No DRM bypass for protected ePub/PDF.
- No cloud sync or account-level file library beyond existing book storage plans.
- No manual full-featured document editor.
- No perfect academic PDF layout reconstruction.

## Source Types

### HTML File

Parsing strategy:

- Parse local HTML with `jsdom`.
- Reuse existing readability extraction where possible.
- Preserve headings: `h1`, `h2`, `h3`.
- Preserve lists, blockquotes, tables as structured text where feasible.
- Remove script, style, nav, footer, ads, comments, and UI chrome.

Chapter strategy:

- Use heading hierarchy first.
- If headings are shallow or absent, fall back to AI chapter suggestion.
- If AI confidence is low, use length-based fallback.

### PDF

V1 supports text-based PDFs.

Parsing strategy:

- Extract text with a PDF text parser.
- Extract outline/bookmarks when available.
- Preserve page numbers as metadata.
- Detect whether the PDF is image-only or mostly image-based.

Chapter strategy:

- Use PDF outline/bookmarks first.
- Use large-font/title-like text if parser exposes layout metadata.
- Use text patterns such as `Chapter`, `Part`, `Section`, `第`, `章`, `节`.
- Fall back to AI chapter suggestion.
- Fall back to length-based chaptering.

Unsupported:

- If extracted text is too sparse compared with page count, mark as `OCR_REQUIRED`.
- Do not run OCR in V1.

### ePub

ePub should be the highest-quality file import path because it usually contains explicit book structure.

Parsing strategy:

- Parse container and spine order.
- Read `nav.xhtml` or `toc.ncx` where available.
- Extract chapter HTML in spine order.
- Preserve title, author, language, cover, and TOC.

Chapter strategy:

- Use ePub TOC if present.
- Fall back to spine items.
- Merge very short spine items such as cover, copyright, preface fragments when appropriate.
- Let user confirm selected chapters before generation.

### TXT

Parsing strategy:

- Detect encoding when possible.
- Normalize line endings.
- Remove excessive blank lines.
- Preserve paragraph boundaries.

Chapter strategy:

- Detect common headings:
  - `Chapter 1`
  - `Part I`
  - `Section 1`
  - `第1章`
  - `第一章`
  - `一、`
  - numbered headings
- If no heading is found, use AI chapter suggestion.
- If AI confidence is low, use length-based fallback.

### Markdown

Parsing strategy:

- Parse Markdown into an AST if available.
- Preserve headings, lists, code blocks, blockquotes, and links.
- For code-heavy docs, mark code blocks as skippable or summarize-only for audio.

Chapter strategy:

- Use `#`, `##`, and `###` headings.
- Treat first `#` as book title when appropriate.
- Use `##` as default chapter boundary.
- Fall back to AI chapter suggestion or length-based fallback.

## Chaptering Strategy

All file imports should use the same priority order:

1. Source structure first.
2. AI chapter suggestion second.
3. Length-based fallback last.

### Source Structure First

Use the file's native structure when available:

- ePub TOC or spine.
- PDF outline/bookmarks.
- HTML headings.
- Markdown headings.
- TXT chapter headings.

This mode should preserve the author's intended structure.

### AI Chapter Suggestion

When source structure is missing or low quality, run a lightweight model pass that suggests chapters.

Input:

- document title
- extracted heading candidates
- first and last paragraph snippets
- paragraph list with stable paragraph IDs
- approximate token/character counts

Output:

```json
{
  "suggestedTitle": "Book Title",
  "confidence": 0.82,
  "chapters": [
    {
      "title": "第一章：问题背景",
      "startParagraphId": "p_12",
      "endParagraphId": "p_48",
      "reason": "topic shift and title-like paragraph"
    }
  ],
  "warnings": []
}
```

Rules:

- AI suggestion must not start TTS.
- AI suggestion should be shown to the user before import.
- Low confidence should trigger a warning.
- The user can still choose length-based import.

### Length-Based Fallback

When no reliable structure exists:

- target `8-12` listening minutes per chapter
- prefer paragraph boundaries
- do not split inside a sentence
- avoid splitting inside a list or table
- use approximate text size:
  - Chinese: `3000-5000` characters per chapter
  - English: `1800-3000` words per chapter

Fallback output should still produce user-editable chapter titles:

- `Part 1`
- `Part 2`
- `Part 3`

For Chinese UI these can render as:

- `第 1 部分`
- `第 2 部分`
- `第 3 部分`

## User Flow

### Flow A: Import File

1. User taps `Import`.
2. User selects `File`.
3. Android uses Storage Access Framework to pick a file.
4. App uploads the file to backend.
5. Backend parses the file and returns a chapter preview.
6. App shows file title, detected type, warnings, and chapter list.
7. User can select all, invert selection, select individual chapters, merge/split later if supported.
8. User confirms.
9. Backend starts chapter-level audio generation.
10. First selected chapter is prioritized.
11. Later chapters process in the background.

### Flow B: Unsupported OCR Required

1. User selects a scanned PDF.
2. Backend detects little or no extractable text.
3. App shows `OCR required`.
4. V1 offers:
   - cancel
   - save as unsupported item, if useful
   - future paid OCR note

No audio generation starts.

## Backend API

Keep endpoint names under `/v1`.

### Upload File for Preview

```http
POST /v1/files/preview
Content-Type: multipart/form-data

file=@book.epub
```

Response:

```json
{
  "previewId": "fileprev_...",
  "fileName": "book.epub",
  "fileType": "epub",
  "status": "READY",
  "detectedTitle": "Book Title",
  "detectedAuthor": "Author",
  "language": "zh",
  "chapteringMode": "source_structure",
  "confidence": 0.92,
  "warnings": [],
  "chapters": [
    {
      "index": 0,
      "title": "第一章",
      "startRef": "spine:item-1",
      "endRef": "spine:item-1",
      "estimatedTextChars": 4200,
      "estimatedAudioSeconds": 720,
      "selectedByDefault": true
    }
  ]
}
```

OCR required response:

```json
{
  "previewId": "fileprev_...",
  "fileName": "scan.pdf",
  "fileType": "pdf",
  "status": "OCR_REQUIRED",
  "detectedTitle": "scan.pdf",
  "warnings": ["This PDF appears to be image-only. OCR is not supported in V1."],
  "chapters": []
}
```

### Confirm File Import

```http
POST /v1/files/import
Content-Type: application/json

{
  "previewId": "fileprev_...",
  "title": "Book Title",
  "selectedChapters": [
    {
      "index": 0,
      "title": "第一章"
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

- Preview does not consume AI audio minutes.
- Import confirmation can estimate credits but should not charge immediately.
- Charge only when each chapter reaches `READY`.
- Failed chapters do not consume credits.
- Automatic retries do not double charge.

### File Import Status

This should reuse the book/chapter status model from whole-book import if available.

```http
GET /v1/books/:bookId
```

## Android Requirements

### File Picker

Use Android Storage Access Framework.

Supported MIME types:

- `text/html`
- `application/xhtml+xml`
- `application/pdf`
- `application/epub+zip`
- `text/plain`
- `text/markdown`
- common fallback extensions: `.html`, `.htm`, `.pdf`, `.epub`, `.txt`, `.md`, `.markdown`

### Preview UI

The preview screen should show:

- file name
- detected file type
- detected title
- detected author, if available
- chaptering mode
- confidence
- warnings
- estimated audio minutes
- selected chapter count
- chapter checklist

Actions:

- select all
- invert selection
- import selected
- cancel

### OCR UI

If status is `OCR_REQUIRED`:

- show a clear unsupported state
- do not show import button
- mention OCR as future paid import

## Backend Implementation Phases

### Phase 1: TXT and Markdown Preview

Deliverables:

- Upload endpoint.
- Text extraction for TXT and Markdown.
- Heading detection.
- Length fallback.
- Preview response.

Acceptance:

- TXT without headings produces multiple length-based chapters.
- Markdown headings produce chapter list.
- No TTS starts during preview.

### Phase 2: HTML and ePub Preview

Deliverables:

- HTML parser.
- ePub parser.
- Source-structure chaptering.
- Title/author/cover extraction where available.

Acceptance:

- ePub TOC maps to chapters.
- HTML headings map to chapters.
- UI chrome is removed from HTML.

### Phase 3: PDF Text Preview

Deliverables:

- PDF text extraction.
- PDF outline/bookmark support if available.
- OCR required detection.

Acceptance:

- Text PDF produces chapter preview.
- Image-only PDF returns `OCR_REQUIRED`.

### Phase 4: Confirmed File Import

Deliverables:

- Confirm import endpoint.
- Create `Book(kind=file)` and chapters.
- Run existing chapter audio generation pipeline.
- Store `subtitle.vtt` and `script.json`.

Acceptance:

- User-selected chapters are generated.
- Unselected chapters are skipped.
- First selected chapter is prioritized.
- Failed chapters do not block the book.

### Phase 5: Android File Import

Deliverables:

- File picker.
- Upload progress.
- Preview screen.
- Confirm import.
- Status tracking.

Acceptance:

- User can import `.txt`, `.md`, `.html`, `.epub`, and text `.pdf`.
- OCR-required PDF shows clear unsupported state.

### Phase 6: Paid OCR Import

Future phase.

Deliverables:

- OCR pipeline.
- OCR cost estimation.
- Separate OCR credits or premium feature gate.
- Image PDF and image files support.

Acceptance:

- OCR starts only after explicit user confirmation.
- Failed OCR does not charge.
- OCR output feeds the same chapter preview flow.

## Cost and Billing

Preview:

- free, except internal safeguards for abuse.
- no AI audio minutes consumed.

Generation:

- consumes AI audio minutes only after chapter reaches `READY`.
- failed chapter consumes zero.
- retry success charges once.

OCR:

- future paid capability.
- should be accounted separately from normal text import because cost is higher.

## Testing Plan

Backend:

- TXT heading detection.
- TXT length fallback.
- Markdown heading extraction.
- HTML heading extraction and UI removal.
- ePub TOC parsing.
- PDF text extraction.
- OCR required detection.
- Preview does not create TTS artifacts.
- Confirmed import only enqueues selected chapters.

Android:

- SAF picker filters supported files.
- Upload progress.
- Preview screen selection.
- OCR required state.
- Confirm import creates book and chapter jobs.

Manual:

- Chinese TXT novel-like file.
- Markdown technical document.
- Saved HTML article.
- ePub with TOC.
- Text PDF.
- Scanned PDF.

## Open Questions

- Should users be able to edit chapter boundaries in V1, or only select chapters?
- Should very large files require cloud upload first or local preflight?
- What is the maximum file size for free users?
- Should imported original files be stored in cloud, or only generated artifacts?
- Should code blocks in Markdown be skipped, summarized, or read aloud?

