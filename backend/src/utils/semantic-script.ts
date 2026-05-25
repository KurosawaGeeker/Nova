import type { BookScript, SemanticSegment, SentenceCue } from "../types.js";

const TARGET_TEXT_LENGTH = 260;
const MAX_SENTENCES_PER_SEGMENT = 3;

export function buildSemanticSegments(input: {
  bookId: string;
  title: string;
  chapters: Array<{
    chapterIndex: number;
    title: string;
    cues: SentenceCue[];
  }>;
}): BookScript {
  return {
    version: 1,
    bookId: input.bookId,
    title: input.title,
    segments: input.chapters.flatMap((chapter) =>
      buildChapterSegments(chapter.chapterIndex, chapter.title, chapter.cues),
    ),
  };
}

function buildChapterSegments(
  chapterIndex: number,
  chapterTitle: string,
  cues: SentenceCue[],
): SemanticSegment[] {
  const segments: SemanticSegment[] = [];
  let bucket: SentenceCue[] = [];

  const flush = () => {
    if (bucket.length === 0) {
      return;
    }
    const text = bucket.map((cue) => cue.text.trim()).filter(Boolean).join(" ");
    if (text.length === 0) {
      bucket = [];
      return;
    }
    segments.push({
      id: `chapter-${chapterIndex + 1}-segment-${segments.length + 1}`,
      chapterIndex,
      startMs: bucket[0].startMs,
      endMs: bucket[bucket.length - 1].endMs,
      title: chapterTitle,
      text,
      kind: bucket.length === 1 ? "sentence" : "paragraph",
    });
    bucket = [];
  };

  for (const cue of cues) {
    if (cue.text.trim().length === 0) {
      flush();
      continue;
    }

    bucket.push(cue);
    const textLength = bucket.reduce((sum, item) => sum + item.text.length, 0);
    const shouldEndOnNaturalBoundary =
      /[。！？.!?]["'”’)]?$/.test(cue.text.trim()) &&
      (textLength >= TARGET_TEXT_LENGTH || bucket.length >= MAX_SENTENCES_PER_SEGMENT);

    if (shouldEndOnNaturalBoundary) {
      flush();
    }
  }

  flush();
  return segments;
}
