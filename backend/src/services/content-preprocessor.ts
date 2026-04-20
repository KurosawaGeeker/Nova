import OpenAI from "openai";
import { JSDOM } from "jsdom";

import type { AppConfig } from "../config.js";
import type { ExtractedArticle } from "../types.js";
import { normalizeWhitespace } from "../utils/text.js";

const COLLECTABLE_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "li",
  "blockquote",
  "pre",
  "figcaption",
]);

const UI_NOISE_PATTERNS = [
  /^(sign in|log in|register|menu|search|close|open|skip to content)$/i,
  /^(share|copy link|print|feedback|report feedback|edit this page)$/i,
  /^(table of contents|on this page|contents|related articles?)$/i,
  /^(privacy policy|cookie policy|terms( of service)?|all rights reserved)$/i,
  /^(subscribe|newsletter|follow us|contact us|back to top)$/i,
  /^(previous|next|home|docs|documentation|github)$/i,
  /^(light|dark|auto) mode$/i,
  /^(rate this page|was this helpful\??)$/i,
];

export interface ContentBlock {
  id: string;
  tagName: string;
  type: "heading" | "body";
  text: string;
  html: string;
}

type ModelSelector = (
  article: ExtractedArticle,
  blocks: ContentBlock[],
) => Promise<string[]>;

export class ContentPreprocessor {
  private readonly client?: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly modelSelector?: ModelSelector,
  ) {
    if (config.contentPreprocessMode === "openai" && config.openAiApiKey) {
      this.client = new OpenAI({ apiKey: config.openAiApiKey });
    }
  }

  async preprocess(article: ExtractedArticle): Promise<ExtractedArticle> {
    const blocks = extractContentBlocks(article.contentHtml);
    if (blocks.length === 0) {
      return article;
    }

    const heuristicBlocks = filterBlocksHeuristically(blocks);
    const fallbackBlocks = isAcceptableCleanResult(article, heuristicBlocks)
      ? heuristicBlocks
      : blocks;
    let selectedBlocks = fallbackBlocks;

    if (this.config.contentPreprocessMode === "openai") {
      try {
        const selectedIds = await this.selectWithModel(article, blocks);
        const modelBlocks = selectBlocksByIds(blocks, selectedIds);
        if (
          isAcceptableCleanResult(article, modelBlocks) &&
          preservesBaselineCoverage(fallbackBlocks, modelBlocks)
        ) {
          selectedBlocks = modelBlocks;
        }
      } catch (error) {
        console.warn("Content preprocessing model fallback", error);
      }
    }

    const cleaned = buildArticleFromBlocks(selectedBlocks);
    return {
      ...article,
      contentHtml: cleaned.contentHtml,
      textContent: cleaned.textContent,
    };
  }

  private async selectWithModel(
    article: ExtractedArticle,
    blocks: ContentBlock[],
  ): Promise<string[]> {
    if (this.modelSelector) {
      return this.modelSelector(article, blocks);
    }
    if (!this.client) {
      return [];
    }

    const response = await this.client.responses.create({
      model: this.config.openAiPreprocessModel,
      instructions: [
        "You clean extracted article blocks before text-to-speech.",
        "Keep the blocks that are topically relevant to the article and useful to hear as an audiobook.",
        "Judge relevance by whether a listener would think the block helps explain the same topic as the title, excerpt, and surrounding section heading.",
        "Drop navigation, menus, search UI, breadcrumbs, table of contents, share prompts, related links, comment prompts, account prompts, cookie/privacy/legal boilerplate, footer text, and repeated site chrome.",
        "Preserve real section headings and the body content that explains the article, including examples, checklists, comparisons, warnings, FAQs, and short list items when they are still about the article's theme.",
        "Do not drop a block only because it is short, link-like, or visually styled as a card if it is still semantically about the article.",
        "Return only the kept block ids in original order, one id per line, with no extra words.",
      ].join(" "),
      input: buildModelPrompt(article, blocks),
    });

    return parseSelectedIds(response.output_text);
  }
}

export function extractContentBlocks(contentHtml: string): ContentBlock[] {
  const dom = new JSDOM(`<article>${contentHtml}</article>`);
  const article = dom.window.document.querySelector("article");
  if (!article) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  const walk = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const tagName = child.tagName.toLowerCase();
      if (COLLECTABLE_TAGS.has(tagName)) {
        const text = normalizeWhitespace(child.textContent ?? "");
        if (!text) {
          continue;
        }
        blocks.push({
          id: `b${String(blocks.length + 1).padStart(4, "0")}`,
          tagName,
          type: /^h[1-4]$/.test(tagName) ? "heading" : "body",
          text,
          html: child.outerHTML,
        });
        continue;
      }
      walk(child);
    }
  };

  walk(article);
  return blocks;
}

export function filterBlocksHeuristically(blocks: ContentBlock[]): ContentBlock[] {
  const filtered = blocks.filter((block) => !looksLikeUiNoise(block));
  return pruneStructuralNoise(filtered);
}

export function buildArticleFromBlocks(blocks: ContentBlock[]): {
  contentHtml: string;
  textContent: string;
} {
  const pruned = pruneStructuralNoise(blocks);
  return {
    contentHtml: pruned.map((block) => block.html).join("\n"),
    textContent: pruned.map((block) => block.text).join("\n\n"),
  };
}

function looksLikeUiNoise(block: ContentBlock): boolean {
  const text = block.text.trim();
  const lower = text.toLowerCase();

  if (!text) {
    return true;
  }
  if (UI_NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (lower.includes("cookie") && lower.includes("privacy")) {
    return true;
  }
  if (lower.includes("sign in") || lower.includes("log in")) {
    return true;
  }
  if (block.type === "heading" && text.length <= 24 && /^[a-z0-9 /-]+$/i.test(text)) {
    return UI_NOISE_PATTERNS.some((pattern) => pattern.test(text));
  }
  if (block.type === "body" && text.length < 28) {
    if (!/[。！？!?\.]/.test(text) && /^[\p{L}\p{N}\s:/&+-]+$/u.test(text)) {
      return true;
    }
  }
  if (block.tagName === "figcaption" && text.length < 12) {
    return true;
  }

  return false;
}

function pruneStructuralNoise(blocks: ContentBlock[]): ContentBlock[] {
  const pruned: ContentBlock[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) {
      continue;
    }

    if (block.type === "heading") {
      const hasBodyAfter = blocks
        .slice(index + 1)
        .some((candidate) => candidate.type === "body");
      if (!hasBodyAfter) {
        continue;
      }

      const next = blocks[index + 1];
      if (next?.type === "heading") {
        continue;
      }
    }

    pruned.push(block);
  }

  return pruned;
}

function selectBlocksByIds(blocks: ContentBlock[], ids: string[]): ContentBlock[] {
  const selectedIdSet = new Set(ids);
  return pruneStructuralNoise(blocks.filter((block) => selectedIdSet.has(block.id)));
}

function isAcceptableCleanResult(
  article: ExtractedArticle,
  blocks: ContentBlock[],
): boolean {
  const textContent = blocks.map((block) => block.text).join(" ");
  return textContent.length >= Math.min(300, Math.round(article.textContent.length * 0.35));
}

function preservesBaselineCoverage(
  baselineBlocks: ContentBlock[],
  candidateBlocks: ContentBlock[],
): boolean {
  const baselineLength = baselineBlocks.map((block) => block.text).join(" ").length;
  const candidateLength = candidateBlocks.map((block) => block.text).join(" ").length;

  if (baselineLength === 0) {
    return candidateLength > 0;
  }

  const baselineHeadings = baselineBlocks.filter((block) => block.type === "heading").length;
  const candidateHeadings = candidateBlocks.filter((block) => block.type === "heading").length;
  const minimumLength = Math.max(300, Math.round(baselineLength * 0.7));
  const minimumHeadings = baselineHeadings === 0
    ? 0
    : Math.max(1, Math.floor(baselineHeadings * 0.7));

  return candidateLength >= minimumLength && candidateHeadings >= minimumHeadings;
}

function buildModelPrompt(article: ExtractedArticle, blocks: ContentBlock[]): string {
  const blockLines = blocks
    .map((block, index) => formatBlockPromptLine(blocks, block, index))
    .join("\n");

  return [
    `Title: ${article.title}`,
    article.siteName ? `Site: ${article.siteName}` : undefined,
    article.excerpt ? `Excerpt: ${article.excerpt}` : undefined,
    "Task: keep blocks that are semantically about this article's subject, even if they are short or styled like cards/lists.",
    "",
    "Blocks:",
    blockLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateBlock(text: string): string {
  if (text.length <= 600) {
    return text;
  }
  return `${text.slice(0, 600).trim()} ...`;
}

function formatBlockPromptLine(
  blocks: ContentBlock[],
  block: ContentBlock,
  index: number,
): string {
  const section = findNearestHeading(blocks, index);
  const parts = [block.id, block.tagName];
  if (section) {
    parts.push(`section=${JSON.stringify(section)}`);
  }
  parts.push(truncateBlock(block.text));
  return parts.join(" | ");
}

function findNearestHeading(blocks: ContentBlock[], index: number): string | null {
  for (let current = index - 1; current >= 0; current -= 1) {
    const candidate = blocks[current];
    if (candidate?.type === "heading") {
      return candidate.text;
    }
  }
  return null;
}

function parseSelectedIds(output: string): string[] {
  return Array.from(new Set(output.match(/\bb\d{4}\b/g) ?? []));
}
