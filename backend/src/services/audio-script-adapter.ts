import OpenAI from "openai";

import type { AppConfig } from "../config.js";
import type { ChapterPlan, ExtractedArticle } from "../types.js";
import { normalizeWhitespace, splitIntoSentences } from "../utils/text.js";

type ChapterRewriter = (input: {
  article: ExtractedArticle;
  chapter: ChapterPlan;
  sourceText: string;
}) => Promise<string>;

export class AudioScriptAdapter {
  private readonly client?: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly chapterRewriter?: ChapterRewriter,
  ) {
    if (config.audioAdaptMode === "openai" && config.openAiApiKey) {
      this.client = new OpenAI({ apiKey: config.openAiApiKey });
    }
  }

  async adaptChapters(
    article: ExtractedArticle,
    chapters: ChapterPlan[],
  ): Promise<ChapterPlan[]> {
    if (this.config.audioAdaptMode === "off") {
      return chapters;
    }

    const adapted: ChapterPlan[] = [];
    for (const chapter of chapters) {
      adapted.push(await this.adaptChapter(article, chapter));
    }
    return adapted;
  }

  private async adaptChapter(
    article: ExtractedArticle,
    chapter: ChapterPlan,
  ): Promise<ChapterPlan> {
    const sourceText = chapter.sentences.join("\n");
    if (!sourceText || sourceText.length < 80) {
      return chapter;
    }

    try {
      const rewritten = normalizeWhitespace(
        await this.rewriteChapter({ article, chapter, sourceText }),
      );
      if (!isAcceptableAdaptation(sourceText, rewritten)) {
        return chapter;
      }

      const sentences = splitIntoSentences(rewritten);
      if (sentences.length === 0) {
        return chapter;
      }

      return {
        ...chapter,
        sentences,
      };
    } catch (error) {
      console.warn("Audio script adaptation fallback", error);
      return chapter;
    }
  }

  private async rewriteChapter(input: {
    article: ExtractedArticle;
    chapter: ChapterPlan;
    sourceText: string;
  }): Promise<string> {
    if (this.chapterRewriter) {
      return this.chapterRewriter(input);
    }
    if (!this.client) {
      return input.sourceText;
    }

    const response = await this.client.responses.create({
      model: this.config.openAiAdaptModel,
      instructions: [
        "You rewrite article text into a version that is easier to understand when listened to as audio.",
        "Keep the same facts, order, and conclusions.",
        "Do not add new facts or opinions.",
        "Turn list-heavy, table-heavy, and visually oriented writing into smooth spoken narration.",
        "Resolve ambiguous references, add short spoken transitions when needed, and make the text sound natural aloud.",
        "Keep the original language.",
        "Return plain text only with no markdown and no commentary.",
      ].join(" "),
      input: [
        `Article title: ${input.article.title}`,
        input.article.excerpt ? `Article excerpt: ${input.article.excerpt}` : undefined,
        `Chapter title: ${input.chapter.title}`,
        "",
        "Rewrite this chapter for listening:",
        input.sourceText,
      ]
        .filter(Boolean)
        .join("\n"),
    });

    return response.output_text.trim();
  }
}

function isAcceptableAdaptation(sourceText: string, rewrittenText: string): boolean {
  if (!rewrittenText) {
    return false;
  }

  return rewrittenText.length >= Math.max(60, Math.round(sourceText.length * 0.55));
}
