import { JSDOM } from "jsdom";

import type { ChapterPlan } from "../types.js";
import { chunkSentencesByLength, normalizeWhitespace, splitIntoSentences } from "./text.js";

const TARGET_CHAPTER_CHARS = 7_000;

export function buildChapters(
  fallbackTitle: string,
  contentHtml: string,
  fallbackText: string,
): ChapterPlan[] {
  const dom = new JSDOM(`<article>${contentHtml}</article>`);
  const article = dom.window.document.querySelector("article");
  const chapters: ChapterPlan[] = [];

  if (!article) {
    return fallbackChapters(fallbackTitle, fallbackText);
  }

  let currentTitle = fallbackTitle;
  let collectedText = "";

  const flush = () => {
    const normalized = normalizeWhitespace(collectedText);
    if (!normalized) {
      return;
    }

    const sentences = splitIntoSentences(normalized);
    const chunks = chunkSentencesByLength(currentTitle, sentences, TARGET_CHAPTER_CHARS);
    for (const chunk of chunks) {
      chapters.push({
        id: `chapter-${chapters.length + 1}`,
        title: chunk.title,
        sentences: chunk.sentences,
      });
    }
    collectedText = "";
  };

  for (const node of Array.from(article.children)) {
    const tagName = node.tagName.toLowerCase();
    if (tagName === "h2" || tagName === "h3") {
      flush();
      currentTitle = normalizeWhitespace(node.textContent ?? "") || fallbackTitle;
      continue;
    }

    const text = normalizeWhitespace(node.textContent ?? "");
    if (!text) {
      continue;
    }
    collectedText = collectedText ? `${collectedText}\n${text}` : text;
  }

  flush();

  if (chapters.length === 0) {
    return fallbackChapters(fallbackTitle, fallbackText);
  }

  return chapters;
}

function fallbackChapters(title: string, text: string): ChapterPlan[] {
  const sentences = splitIntoSentences(text);
  const chunks = chunkSentencesByLength(title, sentences, TARGET_CHAPTER_CHARS);
  return chunks.map((chunk, index) => ({
    id: `chapter-${index + 1}`,
    title: chunk.title,
    sentences: chunk.sentences,
  }));
}
