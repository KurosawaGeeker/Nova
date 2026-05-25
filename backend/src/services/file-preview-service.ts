import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import {
  EpubUnsupportedError,
  parseEpubArchive,
  type ParsedEpubArchive,
  type ParsedEpubNavEntry,
} from "./file-epub-parser.js";

export type PreviewFileType = "txt" | "markdown" | "html" | "pdf" | "epub";

export type PreviewStatus = "READY" | "UNSUPPORTED" | "EMPTY" | "OCR_REQUIRED";

export type PreviewLanguage = "zh" | "en" | "mixed" | "unknown";

export type ChapteringMode = "source-headings" | "length-fallback" | "skipped";

export interface FilePreviewChapter {
  id: string;
  title: string;
  startOffset: number;
  endOffset: number;
  characterCount: number;
  estimatedMinutes: number;
  previewText: string;
}

export interface FilePreviewResult {
  fileName: string;
  fileType: PreviewFileType;
  status: PreviewStatus;
  detectedTitle: string | null;
  language: PreviewLanguage;
  chapteringMode: ChapteringMode;
  confidence: number;
  warnings: string[];
  chapters: FilePreviewChapter[];
}

export interface BuildFilePreviewInput {
  fileName: string;
  fileType?: string | null;
  content: string | Buffer;
}

interface HeadingCandidate {
  title: string;
  lineIndex: number;
  level: number;
  offset: number;
}

interface HtmlExtraction {
  text: string;
  detectedTitle: string | null;
  headings: HeadingCandidate[];
  warnings: string[];
}

interface HtmlBlock {
  type: "heading" | "body";
  level: number;
  text: string;
}

interface EpubSectionExtraction {
  path: string;
  title: string | null;
  text: string;
  headings: HeadingCandidate[];
  startOffset: number;
  endOffset: number;
}

const CHINESE_HEADING_RE =
  /^(?:第[0-9０-９一二三四五六七八九十百千万两〇零]+[章节部篇卷]|[一二三四五六七八九十]+、)\s*.*$/;
const ENGLISH_HEADING_RE =
  /^(?:(?:chapter|part|section)\s+[0-9ivxlcdm]+(?:\b|[:.\-\s])|[0-9]+(?:\.[0-9]+)*[.)、]\s+\S).{0,80}$/i;
const MARKDOWN_HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const HTML_COLLECTABLE_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "p",
  "li",
  "blockquote",
  "pre",
]);
const HTML_NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "[hidden]",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".nav",
  ".navbar",
  ".menu",
  ".sidebar",
  ".toc",
  ".table-of-contents",
  ".breadcrumb",
  ".breadcrumbs",
  ".ads",
  ".advertisement",
  ".share",
  ".social",
  ".cookie",
];
const UI_NOISE_PATTERNS = [
  /^(sign in|log in|register|menu|search|close|open|skip to content)$/i,
  /^(share|copy link|print|feedback|report feedback|edit this page)$/i,
  /^(table of contents|on this page|contents|related articles?)$/i,
  /^(privacy policy|cookie policy|terms( of service)?|all rights reserved)$/i,
  /^(subscribe|newsletter|follow us|contact us|back to top)$/i,
  /^(previous|next|home|docs|documentation|github)$/i,
];
const PDF_TEXT_OPERATOR_RE = /\b(?:Tj|TJ|'|")\b/;
const TARGET_CHINESE_CHARS = 4000;
const TARGET_ENGLISH_WORDS = 2400;
const ENGLISH_WORD_CHAR_RATIO = 5.5;
const MIN_FALLBACK_CHARS = 1200;

export class FilePreviewService {
  buildPreview(input: BuildFilePreviewInput): FilePreviewResult {
    const fileType = detectFileType(input.fileName, input.fileType);

    if (fileType === "pdf") {
      return this.buildPdfPreview(input.fileName, input.content);
    }

    if (fileType === "epub") {
      return this.buildEpubPreview(input.fileName, input.content);
    }

    if (fileType === "html") {
      return this.buildHtmlPreview(input.fileName, toUtf8Text(input.content));
    }

    const text = normalizeText(toUtf8Text(input.content));
    const language = detectLanguage(text);

    if (text.trim().length === 0) {
      return {
        fileName: input.fileName,
        fileType,
        status: "EMPTY",
        detectedTitle: null,
        language,
        chapteringMode: "length-fallback",
        confidence: 0,
        warnings: ["No readable text was found in the file."],
        chapters: [],
      };
    }

    if (fileType === "markdown") {
      return this.buildMarkdownPreview(input.fileName, text, language);
    }

    return this.buildTxtPreview(input.fileName, text, language);
  }

  buildPreviewFromString(
    fileName: string,
    content: string,
    fileType?: string | null,
  ): FilePreviewResult {
    return this.buildPreview({ fileName, fileType, content });
  }

  buildPreviewFromBuffer(
    fileName: string,
    content: Buffer,
    fileType?: string | null,
  ): FilePreviewResult {
    return this.buildPreview({ fileName, fileType, content });
  }

  private buildTxtPreview(
    fileName: string,
    text: string,
    language: PreviewLanguage,
  ): FilePreviewResult {
    const headings = detectTxtHeadings(text);
    const title = headings[0]?.title ?? detectTitleFromText(text);

    if (headings.length > 0) {
      return {
        fileName,
        fileType: "txt",
        status: "READY",
        detectedTitle: title,
        language,
        chapteringMode: "source-headings",
        confidence: headings.length >= 2 ? 0.86 : 0.72,
        warnings:
          headings.length === 1
            ? ["Only one text heading was detected; users should confirm the structure."]
            : [],
        chapters: chaptersFromHeadings(text, headings),
      };
    }

    return fallbackPreview({
      fileName,
      fileType: "txt",
      text,
      language,
      detectedTitle: title,
      warnings: ["No reliable text headings were detected; using length-based preview."],
    });
  }

  private buildMarkdownPreview(
    fileName: string,
    text: string,
    language: PreviewLanguage,
  ): FilePreviewResult {
    const { detectedTitle, headings } = detectMarkdownHeadings(text);
    const boundaryHeadings = chooseMarkdownBoundaries(headings);
    const title = detectedTitle ?? boundaryHeadings[0]?.title ?? detectTitleFromText(text);

    if (boundaryHeadings.length > 0) {
      return {
        fileName,
        fileType: "markdown",
        status: "READY",
        detectedTitle: title,
        language,
        chapteringMode: "source-headings",
        confidence: boundaryHeadings.some((heading) => heading.level === 2) ? 0.92 : 0.82,
        warnings:
          boundaryHeadings.length === 1
            ? ["Only one Markdown chapter boundary was detected; users should confirm the structure."]
            : [],
        chapters: chaptersFromHeadings(text, boundaryHeadings),
      };
    }

    return fallbackPreview({
      fileName,
      fileType: "markdown",
      text,
      language,
      detectedTitle: title,
      warnings: ["No Markdown chapter headings were detected; using length-based preview."],
    });
  }

  private buildHtmlPreview(fileName: string, html: string): FilePreviewResult {
    const extracted = extractHtmlText(html, fileName);
    const text = extracted.text;
    const language = detectLanguage(text);

    if (text.trim().length === 0) {
      return {
        fileName,
        fileType: "html",
        status: "EMPTY",
        detectedTitle: extracted.detectedTitle,
        language,
        chapteringMode: "skipped",
        confidence: 0,
        warnings: [
          ...extracted.warnings,
          "No readable text was found in the HTML file.",
        ],
        chapters: [],
      };
    }

    const boundaryHeadings = chooseMarkdownBoundaries(extracted.headings);
    const title =
      extracted.detectedTitle ?? boundaryHeadings[0]?.title ?? detectTitleFromText(text);

    if (boundaryHeadings.length > 0) {
      return {
        fileName,
        fileType: "html",
        status: "READY",
        detectedTitle: title,
        language,
        chapteringMode: "source-headings",
        confidence: boundaryHeadings.some((heading) => heading.level === 2) ? 0.9 : 0.78,
        warnings:
          boundaryHeadings.length === 1
            ? [
                ...extracted.warnings,
                "Only one HTML chapter boundary was detected; users should confirm the structure.",
              ]
            : extracted.warnings,
        chapters: chaptersFromHeadings(text, boundaryHeadings),
      };
    }

    return fallbackPreview({
      fileName,
      fileType: "html",
      text,
      language,
      detectedTitle: title,
      warnings: [
        ...extracted.warnings,
        "No HTML chapter headings were detected; using length-based preview.",
      ],
    });
  }

  private buildPdfPreview(
    fileName: string,
    content: string | Buffer,
  ): FilePreviewResult {
    const bytes = toBuffer(content);
    const inspection = inspectPdf(bytes);

    if (!inspection.hasPdfHeader) {
      return blockedPreview({
        fileName,
        fileType: "pdf",
        status: "UNSUPPORTED",
        detectedTitle: fileName,
        warnings: ["The file is labeled as PDF but does not contain a valid PDF header."],
      });
    }

    if (!inspection.hasTextOperators) {
      return blockedPreview({
        fileName,
        fileType: "pdf",
        status: "OCR_REQUIRED",
        detectedTitle: fileName,
        warnings: [
          "This PDF appears to be image-only or has no extractable text. OCR is not supported in V1.",
        ],
      });
    }

    return blockedPreview({
      fileName,
      fileType: "pdf",
      status: "UNSUPPORTED",
      detectedTitle: fileName,
      warnings: [
        "This PDF appears to contain embedded text, but PDF text extraction is not enabled in this preview phase.",
      ],
    });
  }

  private buildEpubPreview(
    fileName: string,
    content: string | Buffer,
  ): FilePreviewResult {
    let archive: ParsedEpubArchive;

    try {
      archive = parseEpubArchive(toBuffer(content));
    } catch (error) {
      if (error instanceof EpubUnsupportedError) {
        return blockedPreview({
          fileName,
          fileType: "epub",
          status: "UNSUPPORTED",
          detectedTitle: fileName,
          warnings: error.warnings,
        });
      }

      return blockedPreview({
        fileName,
        fileType: "epub",
        status: "UNSUPPORTED",
        detectedTitle: fileName,
        warnings: ["EPUB preview failed before readable text could be extracted."],
      });
    }

    const extraction = extractEpubText(archive, fileName);
    const text = extraction.text;
    const language = mapEpubLanguage(archive.languageTag) ?? detectLanguage(text);
    const detectedTitle =
      archive.title ??
      extraction.sections.find((section) => section.title)?.title ??
      archive.navEntries[0]?.title ??
      detectTitleFromText(text);

    if (text.trim().length === 0) {
      return {
        fileName,
        fileType: "epub",
        status: "EMPTY",
        detectedTitle,
        language,
        chapteringMode: "skipped",
        confidence: 0,
        warnings: [
          ...archive.warnings,
          ...extraction.warnings,
          "No readable text was found in the EPUB spine content.",
        ],
        chapters: [],
      };
    }

    const navHeadings = headingsFromEpubNav(archive.navEntries, extraction.sections);
    if (navHeadings.length > 0) {
      return {
        fileName,
        fileType: "epub",
        status: "READY",
        detectedTitle,
        language,
        chapteringMode: "source-headings",
        confidence: navHeadings.length >= 2 ? 0.9 : 0.78,
        warnings:
          navHeadings.length === 1
            ? [
                ...archive.warnings,
                ...extraction.warnings,
                "Only one EPUB TOC boundary was detected; users should confirm the structure.",
              ]
            : [...archive.warnings, ...extraction.warnings],
        chapters: chaptersFromHeadings(text, navHeadings),
      };
    }

    const sectionHeadings = headingsFromEpubSections(extraction.sections);
    if (sectionHeadings.length > 0) {
      return {
        fileName,
        fileType: "epub",
        status: "READY",
        detectedTitle,
        language,
        chapteringMode: "source-headings",
        confidence: sectionHeadings.length >= 2 ? 0.82 : 0.7,
        warnings:
          sectionHeadings.length === 1
            ? [
                ...archive.warnings,
                ...extraction.warnings,
                "Only one EPUB spine heading was detected; users should confirm the structure.",
              ]
            : [...archive.warnings, ...extraction.warnings],
        chapters: chaptersFromHeadings(text, sectionHeadings),
      };
    }

    return fallbackPreview({
      fileName,
      fileType: "epub",
      text,
      language,
      detectedTitle,
      warnings: [
        ...archive.warnings,
        ...extraction.warnings,
        "No EPUB TOC or spine headings were detected; using length-based preview.",
      ],
    });
  }
}

function extractEpubText(
  archive: ParsedEpubArchive,
  fileName: string,
): {
  text: string;
  sections: EpubSectionExtraction[];
  warnings: string[];
} {
  const parts: string[] = [];
  const sections: EpubSectionExtraction[] = [];
  const warnings: string[] = [];
  let offset = 0;

  for (const section of archive.sections) {
    const extracted = extractHtmlText(section.html, `${fileName}/${section.path}`);
    const sectionText = extracted.text.trim();

    if (sectionText.length === 0) {
      warnings.push(`EPUB spine item ${section.path} did not contain readable text.`);
      continue;
    }

    if (parts.length > 0) {
      parts.push("\n\n");
      offset += 2;
    }

    const startOffset = offset;
    parts.push(sectionText);
    offset += sectionText.length;

    sections.push({
      path: section.path,
      title: extracted.detectedTitle,
      text: sectionText,
      headings: extracted.headings.map((heading) => ({
        ...heading,
        offset: startOffset + heading.offset,
      })),
      startOffset,
      endOffset: offset,
    });
    warnings.push(...extracted.warnings);
  }

  return {
    text: parts.join(""),
    sections,
    warnings: uniqueStrings(warnings),
  };
}

function headingsFromEpubNav(
  navEntries: ParsedEpubNavEntry[],
  sections: EpubSectionExtraction[],
): HeadingCandidate[] {
  const headings: HeadingCandidate[] = [];
  const usedOffsets = new Set<number>();

  for (const entry of navEntries) {
    const section = sections.find((candidate) => candidate.path === entry.path);
    if (!section) {
      continue;
    }

    const matchingHeading = findMatchingSectionHeading(section, entry.title);
    const offset = matchingHeading?.offset ?? section.startOffset;

    if (usedOffsets.has(offset)) {
      continue;
    }

    headings.push({
      title: entry.title,
      lineIndex: 0,
      level: matchingHeading?.level ?? 2,
      offset,
    });
    usedOffsets.add(offset);
  }

  return headings.sort((left, right) => left.offset - right.offset);
}

function headingsFromEpubSections(sections: EpubSectionExtraction[]): HeadingCandidate[] {
  if (sections.length === 0) {
    return [];
  }

  if (sections.length === 1) {
    return chooseMarkdownBoundaries(sections[0]?.headings ?? []);
  }

  return sections.map((section, index) => {
    const firstHeading = section.headings[0];
    return {
      title:
        firstHeading?.title ??
        section.title ??
        titleFromZipPath(section.path) ??
        `Chapter ${index + 1}`,
      lineIndex: firstHeading?.lineIndex ?? 0,
      level: firstHeading?.level ?? 2,
      offset: firstHeading?.offset ?? section.startOffset,
    };
  });
}

function findMatchingSectionHeading(
  section: EpubSectionExtraction,
  title: string,
): HeadingCandidate | null {
  const normalizedTitle = normalizeComparisonText(title);
  return (
    section.headings.find(
      (heading) => normalizeComparisonText(heading.title) === normalizedTitle,
    ) ?? null
  );
}

function mapEpubLanguage(languageTag: string | null): PreviewLanguage | null {
  if (!languageTag) {
    return null;
  }

  const normalized = languageTag.toLowerCase();
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return "unknown";
}

function titleFromZipPath(entryPath: string): string | null {
  const fileName = entryPath.split("/").pop() ?? "";
  const title = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return title || null;
}

function normalizeComparisonText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function detectFileType(fileName: string, explicitType?: string | null): PreviewFileType {
  const explicit = explicitType?.trim().toLowerCase() ?? "";
  const name = fileName.trim().toLowerCase();
  const value = `${explicit} ${name}`;

  if (explicit.includes("pdf") || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (explicit.includes("epub") || name.endsWith(".epub")) {
    return "epub";
  }
  if (
    explicit.includes("html") ||
    explicit.includes("xhtml") ||
    name.endsWith(".html") ||
    name.endsWith(".htm") ||
    name.endsWith(".xhtml")
  ) {
    return "html";
  }
  if (
    value.includes("markdown") ||
    name.endsWith(".md") ||
    name.endsWith(".mdx") ||
    name.endsWith(".markdown")
  ) {
    return "markdown";
  }
  return "txt";
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

function toUtf8Text(content: string | Buffer): string {
  if (typeof content === "string") {
    return content;
  }
  return content.toString("utf8");
}

function normalizeText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function detectLanguage(text: string): PreviewLanguage {
  const chineseChars = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const englishWords = (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? []).length;

  if (chineseChars === 0 && englishWords === 0) {
    return "unknown";
  }
  if (chineseChars > englishWords * 1.5) {
    return "zh";
  }
  if (englishWords > chineseChars * 1.5) {
    return "en";
  }
  return "mixed";
}

function detectTitleFromText(text: string): string | null {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line.length <= 120);
  return firstLine ?? null;
}

function detectTxtHeadings(text: string): HeadingCandidate[] {
  const lines = text.split("\n");
  let offset = 0;
  const headings: HeadingCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    const previousLine = lines[index - 1]?.trim() ?? "";
    const nextLine = lines[index + 1]?.trim() ?? "";
    const hasBoundary = index === 0 || previousLine.length === 0 || nextLine.length === 0;

    if (line.length > 0 && line.length <= 100 && hasBoundary && isTxtHeading(line)) {
      headings.push({
        title: cleanHeadingTitle(line),
        lineIndex: index,
        level: 1,
        offset,
      });
    }

    offset += rawLine.length + 1;
  }

  return headings;
}

function isTxtHeading(line: string): boolean {
  return CHINESE_HEADING_RE.test(line) || ENGLISH_HEADING_RE.test(line);
}

function cleanHeadingTitle(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function detectMarkdownHeadings(text: string): {
  detectedTitle: string | null;
  headings: HeadingCandidate[];
} {
  const lines = text.split("\n");
  const headings: HeadingCandidate[] = [];
  let detectedTitle: string | null = null;
  let offset = 0;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();

    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      offset += rawLine.length + 1;
      continue;
    }

    if (!inFence) {
      const match = trimmed.match(MARKDOWN_HEADING_RE);
      if (match) {
        const level = match[1]?.length ?? 1;
        const title = cleanHeadingTitle(match[2] ?? "");
        if (level === 1 && !detectedTitle) {
          detectedTitle = title;
        }
        headings.push({ title, lineIndex: index, level, offset });
      }
    }

    offset += rawLine.length + 1;
  }

  return { detectedTitle, headings };
}

function chooseMarkdownBoundaries(headings: HeadingCandidate[]): HeadingCandidate[] {
  const h2 = headings.filter((heading) => heading.level === 2);
  if (h2.length > 0) {
    return h2;
  }

  const h1 = headings.filter((heading, index) => heading.level === 1 && index > 0);
  if (h1.length > 0) {
    return h1;
  }

  return headings.filter((heading) => heading.level === 3);
}

function extractHtmlText(html: string, fileName: string): HtmlExtraction {
  const cleanedDom = new JSDOM(html, {
    url: `https://local.preview/${encodeURIComponent(fileName)}`,
  });
  cleanupHtmlDocument(cleanedDom.window.document);

  const readabilityExtraction = extractWithReadability(cleanedDom.serialize(), fileName);
  const semanticExtraction = extractFromDocument(cleanedDom.window.document);
  const chosen = chooseHtmlExtraction(semanticExtraction, readabilityExtraction);
  const warnings =
    chosen === readabilityExtraction && semanticExtraction.text.length > 0
      ? ["HTML readability extraction was used because semantic content was sparse."]
      : [];

  return {
    ...chosen,
    warnings,
  };
}

function extractWithReadability(html: string, fileName: string): HtmlExtraction {
  const dom = new JSDOM(html, { url: `https://local.preview/${encodeURIComponent(fileName)}` });
  const article = new Readability(dom.window.document).parse();

  if (!article?.content) {
    return {
      text: "",
      detectedTitle: null,
      headings: [],
      warnings: [],
    };
  }

  const contentDom = new JSDOM(`<article>${article.content}</article>`);
  const extraction = extractFromRoot(
    contentDom.window.document.querySelector("article"),
    article.title?.trim() || null,
  );

  return {
    ...extraction,
    detectedTitle: extraction.detectedTitle ?? article.title?.trim() ?? null,
  };
}

function extractFromDocument(document: Document): HtmlExtraction {
  const documentTitle = normalizeInlineText(document.querySelector("title")?.textContent ?? "");
  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.body;

  return extractFromRoot(root, documentTitle || null);
}

function extractFromRoot(root: Element | null, fallbackTitle: string | null): HtmlExtraction {
  if (!root) {
    return {
      text: "",
      detectedTitle: fallbackTitle,
      headings: [],
      warnings: [],
    };
  }

  const blocks = collectHtmlBlocks(root);
  if (blocks.length === 0) {
    const text = normalizeText(root.textContent ?? "");
    return {
      text,
      detectedTitle: fallbackTitle ?? detectTitleFromText(text),
      headings: [],
      warnings: [],
    };
  }

  const headings: HeadingCandidate[] = [];
  const parts: string[] = [];
  let offset = 0;

  for (const block of blocks) {
    if (parts.length > 0) {
      parts.push("\n\n");
      offset += 2;
    }

    const startOffset = offset;
    parts.push(block.text);
    offset += block.text.length;

    if (block.type === "heading") {
      headings.push({
        title: cleanHeadingTitle(block.text),
        lineIndex: parts.length - 1,
        level: block.level,
        offset: startOffset,
      });
    }
  }

  const text = parts.join("");
  const firstH1 = headings.find((heading) => heading.level === 1)?.title ?? null;

  return {
    text,
    detectedTitle: firstH1 ?? fallbackTitle ?? detectTitleFromText(text),
    headings,
    warnings: [],
  };
}

function cleanupHtmlDocument(document: Document): void {
  for (const selector of HTML_NOISE_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      element.remove();
    }
  }
}

function collectHtmlBlocks(root: Element): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];

  const walk = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const tagName = child.tagName.toLowerCase();

      if (HTML_COLLECTABLE_TAGS.has(tagName)) {
        const text = normalizeInlineText(child.textContent ?? "");
        if (!text || looksLikeUiNoise(text)) {
          continue;
        }

        const headingMatch = tagName.match(/^h([1-3])$/);
        blocks.push({
          type: headingMatch ? "heading" : "body",
          level: headingMatch ? Number(headingMatch[1]) : 0,
          text,
        });
        continue;
      }

      walk(child);
    }
  };

  walk(root);
  return blocks;
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeUiNoise(text: string): boolean {
  if (UI_NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const lower = text.toLowerCase();
  return lower.includes("cookie") && lower.includes("privacy");
}

function chooseHtmlExtraction(
  semanticExtraction: HtmlExtraction,
  readabilityExtraction: HtmlExtraction,
): HtmlExtraction {
  const semanticChars = semanticExtraction.text.length;
  const readabilityChars = readabilityExtraction.text.length;
  const semanticHeadings = semanticExtraction.headings.length;
  const readabilityHeadings = readabilityExtraction.headings.length;

  if (semanticChars === 0) {
    return readabilityExtraction;
  }
  if (readabilityChars === 0) {
    return semanticExtraction;
  }
  if (semanticHeadings > 0 && semanticHeadings >= readabilityHeadings) {
    return semanticExtraction;
  }
  if (readabilityChars >= semanticChars * 1.25) {
    return readabilityExtraction;
  }
  return semanticExtraction;
}

function inspectPdf(bytes: Buffer): { hasPdfHeader: boolean; hasTextOperators: boolean } {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1_000_000)).toString("latin1");
  return {
    hasPdfHeader: sample.startsWith("%PDF-"),
    hasTextOperators: PDF_TEXT_OPERATOR_RE.test(sample),
  };
}

function chaptersFromHeadings(text: string, headings: HeadingCandidate[]): FilePreviewChapter[] {
  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const startOffset = heading.offset;
    const endOffset = nextHeading?.offset ?? text.length;
    return buildChapter(`ch_${index + 1}`, heading.title, text, startOffset, endOffset);
  });
}

function fallbackPreview(input: {
  fileName: string;
  fileType: PreviewFileType;
  text: string;
  language: PreviewLanguage;
  detectedTitle: string | null;
  warnings: string[];
}): FilePreviewResult {
  return {
    fileName: input.fileName,
    fileType: input.fileType,
    status: "READY",
    detectedTitle: input.detectedTitle,
    language: input.language,
    chapteringMode: "length-fallback",
    confidence: 0.56,
    warnings: input.warnings,
    chapters: fallbackChapters(input.text, input.language),
  };
}

function blockedPreview(input: {
  fileName: string;
  fileType: PreviewFileType;
  status: "UNSUPPORTED" | "OCR_REQUIRED";
  detectedTitle: string | null;
  warnings: string[];
}): FilePreviewResult {
  return {
    fileName: input.fileName,
    fileType: input.fileType,
    status: input.status,
    detectedTitle: input.detectedTitle,
    language: "unknown",
    chapteringMode: "skipped",
    confidence: 0,
    warnings: input.warnings,
    chapters: [],
  };
}

function fallbackChapters(text: string, language: PreviewLanguage): FilePreviewChapter[] {
  const targetChars =
    language === "zh" || language === "mixed"
      ? TARGET_CHINESE_CHARS
      : Math.round(TARGET_ENGLISH_WORDS * ENGLISH_WORD_CHAR_RATIO);
  const paragraphs = collectParagraphs(text);
  const chapters: Array<{ startOffset: number; endOffset: number }> = [];
  let currentStart = paragraphs[0]?.startOffset ?? 0;
  let currentEnd = currentStart;
  let currentSize = 0;

  for (const paragraph of paragraphs) {
    const paragraphSize = paragraph.endOffset - paragraph.startOffset;
    const shouldCut =
      currentSize >= MIN_FALLBACK_CHARS &&
      currentSize + paragraphSize > targetChars &&
      currentEnd > currentStart;

    if (shouldCut) {
      chapters.push({ startOffset: currentStart, endOffset: currentEnd });
      currentStart = paragraph.startOffset;
      currentSize = 0;
    }

    currentEnd = paragraph.endOffset;
    currentSize += paragraphSize;
  }

  if (currentEnd > currentStart) {
    chapters.push({ startOffset: currentStart, endOffset: currentEnd });
  }

  if (chapters.length <= 1 && text.length > targetChars * 1.5) {
    return sentenceFallbackChapters(text, targetChars);
  }

  return chapters.map((chapter, index) =>
    buildChapter(
      `part_${index + 1}`,
      `Part ${index + 1}`,
      text,
      chapter.startOffset,
      chapter.endOffset,
    ),
  );
}

function collectParagraphs(text: string): Array<{ startOffset: number; endOffset: number }> {
  const matches = text.matchAll(/\S[\s\S]*?(?=\n{2,}|\s*$)/g);
  const paragraphs: Array<{ startOffset: number; endOffset: number }> = [];

  for (const match of matches) {
    if (match.index === undefined) {
      continue;
    }
    const raw = match[0];
    const leadingWhitespace = raw.search(/\S/);
    const startOffset = match.index + Math.max(leadingWhitespace, 0);
    const endOffset = startOffset + raw.trimEnd().length;
    if (endOffset > startOffset) {
      paragraphs.push({ startOffset, endOffset });
    }
  }

  return paragraphs.length > 0 ? paragraphs : [{ startOffset: 0, endOffset: text.length }];
}

function sentenceFallbackChapters(
  text: string,
  targetChars: number,
): FilePreviewChapter[] {
  const boundaries = Array.from(text.matchAll(/[。！？.!?]\s+/g), (match) => ({
    endOffset: (match.index ?? 0) + match[0].length,
  }));
  const chapters: Array<{ startOffset: number; endOffset: number }> = [];
  let startOffset = 0;
  let lastBoundary = 0;

  for (const boundary of boundaries) {
    lastBoundary = boundary.endOffset;
    if (boundary.endOffset - startOffset >= targetChars) {
      chapters.push({ startOffset, endOffset: boundary.endOffset });
      startOffset = boundary.endOffset;
    }
  }

  if (startOffset < text.length) {
    chapters.push({ startOffset, endOffset: text.length });
  }

  if (chapters.length === 0 && lastBoundary === 0) {
    chapters.push({ startOffset: 0, endOffset: text.length });
  }

  return chapters.map((chapter, index) =>
    buildChapter(
      `part_${index + 1}`,
      `Part ${index + 1}`,
      text,
      chapter.startOffset,
      chapter.endOffset,
    ),
  );
}

function buildChapter(
  id: string,
  title: string,
  text: string,
  startOffset: number,
  endOffset: number,
): FilePreviewChapter {
  const content = text.slice(startOffset, endOffset).trim();
  return {
    id,
    title,
    startOffset,
    endOffset,
    characterCount: content.length,
    estimatedMinutes: estimateListeningMinutes(content),
    previewText: content.slice(0, 320),
  };
}

function estimateListeningMinutes(text: string): number {
  const language = detectLanguage(text);
  if (language === "zh" || language === "mixed") {
    return roundMinutes(Math.max(text.length / 420, 0.1));
  }

  const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length ?? 0;
  if (words > 0) {
    return roundMinutes(Math.max(words / 165, 0.1));
  }

  return roundMinutes(Math.max(text.length / 900, 0.1));
}

function roundMinutes(minutes: number): number {
  return Math.round(minutes * 10) / 10;
}
