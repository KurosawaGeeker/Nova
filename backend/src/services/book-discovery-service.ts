import { createHash, randomUUID } from "node:crypto";

import { JSDOM } from "jsdom";

import type { AppConfig } from "../config.js";
import type {
  BookDiscoveryMode,
  BookDiscoveryResult,
  DiscoveredChapter,
} from "../types.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DiscoveryLimits {
  maxPages: number;
  maxChapters: number;
  maxDepth: number;
  timeoutMs: number;
}

interface LinkCandidate {
  title: string;
  url: string;
  score: number;
  sourceKind: "toc" | "sidebar" | "ordered" | "heading" | "link";
  documentOrder: number;
}

interface PageAnalysis {
  url: string;
  title: string;
  bookTitle: string;
  candidates: LinkCandidate[];
  hasTocSignal: boolean;
  hasSidebarSignal: boolean;
}

const DEFAULT_LIMITS: DiscoveryLimits = {
  maxPages: 80,
  maxChapters: 50,
  maxDepth: 2,
  timeoutMs: 20_000,
};

const CHAPTER_TEXT_RE =
  /\b(chapter|chap\.?|part|section|lesson|episode|appendix|preface|introduction|intro|contents?|table of contents|toc)\b|第\s*[一二三四五六七八九十百千万\d]+\s*[章节回卷篇部]|目录|章节|序章|下一章|上一章|前言|引言/i;
const CHAPTER_URL_RE =
  /(?:^|\/)(chapter|chapters|part|section|lesson|episode|appendix|intro|preface|toc|contents?)(?:\/|-|_|$)|ch(?:apter)?[-_]?\d+|第[^/]+章/i;
const TOC_TEXT_RE = /\b(contents?|table of contents|toc)\b|目录|章节列表|全部章节/i;
const EXCLUDED_TEXT_RE =
  /\b(comment|comments|reply|tag|tags|category|author|login|log in|sign in|signin|signup|register|share|related|privacy|terms|advertisement|advertising|ads?|cookie|search|subscribe|rss|facebook|twitter|x\.com|weibo)\b|评论|标签|作者|登录|注册|分享|相关|推荐|隐私|条款|广告|搜索|订阅/i;
const EXCLUDED_PATH_RE =
  /\/(comments?|tags?|category|categories|author|login|signin|signup|register|share|privacy|terms|ads?|search|feed|wp-login|account|related)(?:\/|$)/i;
const TRACKING_PARAM_RE =
  /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|yclid$|igshid$|ref$|ref_src$)/i;
const TITLE_SEPARATOR_RE = /\s+[-|–—]\s+/;

export class BookDiscoveryService {
  private readonly limits: DiscoveryLimits;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.limits = {
      maxPages: config.discoveryMaxPages ?? DEFAULT_LIMITS.maxPages,
      maxChapters: config.discoveryMaxChapters ?? DEFAULT_LIMITS.maxChapters,
      maxDepth: config.discoveryMaxDepth ?? DEFAULT_LIMITS.maxDepth,
      timeoutMs: config.discoveryTimeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    };
  }

  async discover(inputUrl: string): Promise<BookDiscoveryResult> {
    const sourceUrl = normalizeDiscoveryUrl(inputUrl);
    const warnings: string[] = [];
    const fetched = new Set<string>();
    const sourcePage = await this.fetchAndAnalyze(sourceUrl, fetched);

    let bestPage = sourcePage;
    if (
      this.limits.maxDepth > 0 &&
      fetched.size < this.limits.maxPages &&
      sourcePage.candidates.length < 3
    ) {
      const tocLink = sourcePage.candidates.find((candidate) =>
        TOC_TEXT_RE.test(candidate.title),
      );
      if (tocLink && tocLink.url !== sourceUrl) {
        try {
          const tocPage = await this.fetchAndAnalyze(tocLink.url, fetched);
          if (tocPage.candidates.length > sourcePage.candidates.length) {
            bestPage = tocPage;
          }
        } catch (error) {
          warnings.push(
            `TOC link could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    }

    const chapters = this.toChapters(bestPage.candidates);
    if (chapters.length === 0 || (chapters.length === 1 && chapters[0]?.url === sourceUrl)) {
      return this.articleFallback(sourcePage, sourceUrl, warnings);
    }

    const mode = classifyDiscoveryMode(sourcePage, bestPage);
    const confidence = scoreDiscoveryConfidence(bestPage, chapters.length);
    if (confidence < 0.6) {
      warnings.push(
        "Discovery confidence is low. Consider importing only the current page.",
      );
    }
    if (chapters.length >= this.limits.maxChapters) {
      warnings.push(`Chapter list was capped at ${this.limits.maxChapters} items.`);
    }

    return {
      discoveryId: createDiscoveryId(sourceUrl),
      sourceUrl,
      candidateBookTitle: bestPage.bookTitle,
      confidence,
      discoveryMode: mode,
      warnings,
      chapters,
    };
  }

  private async fetchAndAnalyze(
    url: string,
    fetched: Set<string>,
  ): Promise<PageAnalysis> {
    if (fetched.size >= this.limits.maxPages) {
      throw new Error(`Discovery page limit ${this.limits.maxPages} reached`);
    }

    fetched.add(url);
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": this.config.userAgent },
      redirect: "follow",
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Upstream response was ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new Error("Only HTML pages can be discovered");
    }

    const html = await response.text();
    return analyzeDiscoveryPage(html, url, this.limits.maxChapters);
  }

  private toChapters(candidates: LinkCandidate[]): DiscoveredChapter[] {
    return candidates.slice(0, this.limits.maxChapters).map((candidate, index) => ({
      index,
      title: candidate.title,
      url: candidate.url,
      selectedByDefault: candidate.score >= 0.48,
      confidence: roundConfidence(Math.min(0.95, candidate.score)),
    }));
  }

  private articleFallback(
    page: PageAnalysis,
    sourceUrl: string,
    warnings: string[],
  ): BookDiscoveryResult {
    return {
      discoveryId: createDiscoveryId(sourceUrl),
      sourceUrl,
      candidateBookTitle: page.bookTitle,
      confidence: 0.32,
      discoveryMode: "article_fallback",
      warnings: [
        ...warnings,
        "No reliable chapter list was discovered. Import the current page only.",
      ],
      chapters: [
        {
          index: 0,
          title: page.title,
          url: sourceUrl,
          selectedByDefault: true,
          confidence: 0.32,
        },
      ],
    };
  }
}

export function analyzeDiscoveryPage(
  html: string,
  pageUrl: string,
  maxChapters = DEFAULT_LIMITS.maxChapters,
): PageAnalysis {
  const dom = new JSDOM(html, { url: pageUrl });
  const document = dom.window.document;
  const title = extractPageTitle(document, pageUrl);
  const bookTitle = extractBookTitle(document, title);
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const sourceOrigin = new URL(pageUrl).origin;
  const deduped = new Map<string, LinkCandidate>();
  let hasTocSignal = false;
  let hasSidebarSignal = false;

  anchors.forEach((anchor, documentOrder) => {
    const rawHref = anchor.getAttribute("href");
    if (!rawHref || isUnsupportedHref(rawHref)) {
      return;
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeDiscoveryUrl(rawHref, pageUrl);
    } catch {
      return;
    }

    const parsedUrl = new URL(normalizedUrl);
    if (parsedUrl.origin !== sourceOrigin) {
      return;
    }

    const titleText = extractAnchorText(anchor);
    if (!titleText || isExcludedLink(titleText, parsedUrl)) {
      return;
    }

    const context = classifyAnchorContext(anchor);
    hasTocSignal = hasTocSignal || context.hasTocSignal || TOC_TEXT_RE.test(titleText);
    hasSidebarSignal = hasSidebarSignal || context.hasSidebarSignal;

    const score = scoreLinkCandidate({
      title: titleText,
      url: parsedUrl,
      pageUrl,
      context,
    });
    if (score < 0.36) {
      return;
    }

    const candidate: LinkCandidate = {
      title: stripLinkNoise(titleText),
      url: normalizedUrl,
      score,
      sourceKind: context.sourceKind,
      documentOrder,
    };
    const existing = deduped.get(normalizedUrl);
    if (!existing || candidate.score > existing.score) {
      deduped.set(normalizedUrl, candidate);
    }
  });

  const candidates = Array.from(deduped.values())
    .sort((left, right) => left.documentOrder - right.documentOrder)
    .slice(0, maxChapters);

  return {
    url: pageUrl,
    title,
    bookTitle,
    candidates,
    hasTocSignal,
    hasSidebarSignal,
  };
}

export function normalizeDiscoveryUrl(input: string, baseUrl?: string): string {
  const url = new URL(input.trim(), baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.username = "";
  url.password = "";
  url.hash = "";

  for (const key of Array.from(url.searchParams.keys())) {
    if (TRACKING_PARAM_RE.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

function classifyAnchorContext(anchor: Element): {
  sourceKind: LinkCandidate["sourceKind"];
  hasTocSignal: boolean;
  hasSidebarSignal: boolean;
  orderedDepth: number;
} {
  let sourceKind: LinkCandidate["sourceKind"] = "link";
  let hasTocSignal = false;
  let hasSidebarSignal = false;
  let orderedDepth = 0;
  let current: Element | null = anchor;
  let depth = 0;

  while (current && depth < 6) {
    const tagName = current.tagName.toLowerCase();
    const marker = `${current.id} ${current.className} ${current.getAttribute("role") ?? ""}`;
    if (/toc|contents|table-of-contents|chapter|book/i.test(marker)) {
      sourceKind = "toc";
      hasTocSignal = true;
    }
    if (/sidebar|aside|drawer|sidenav|side-nav/i.test(marker) || tagName === "aside") {
      sourceKind = sourceKind === "toc" ? sourceKind : "sidebar";
      hasSidebarSignal = true;
    }
    if (tagName === "nav") {
      sourceKind = sourceKind === "link" ? "toc" : sourceKind;
      hasTocSignal = true;
    }
    if (tagName === "ol") {
      sourceKind = "ordered";
      orderedDepth += 1;
    }
    if (/^h[1-6]$/.test(tagName)) {
      sourceKind = "heading";
    }

    current = current.parentElement;
    depth += 1;
  }

  return { sourceKind, hasTocSignal, hasSidebarSignal, orderedDepth };
}

function scoreLinkCandidate({
  title,
  url,
  pageUrl,
  context,
}: {
  title: string;
  url: URL;
  pageUrl: string;
  context: ReturnType<typeof classifyAnchorContext>;
}): number {
  let score = 0;
  if (CHAPTER_TEXT_RE.test(title)) {
    score += 0.38;
  }
  if (CHAPTER_URL_RE.test(url.pathname)) {
    score += 0.22;
  }
  if (context.sourceKind === "toc") {
    score += 0.28;
  }
  if (context.sourceKind === "sidebar") {
    score += 0.22;
  }
  if (context.sourceKind === "ordered") {
    score += 0.3;
  }
  if (context.sourceKind === "heading") {
    score += 0.18;
  }
  if (context.orderedDepth > 0) {
    score += 0.08;
  }
  if (hasSimilarPath(pageUrl, url)) {
    score += 0.14;
  }
  if (/^\d+[\s.、-]/.test(title) || /\b\d+\b/.test(title)) {
    score += 0.08;
  }
  if (TOC_TEXT_RE.test(title)) {
    score += 0.14;
  }
  if (url.toString() === normalizeDiscoveryUrl(pageUrl)) {
    score -= 0.08;
  }

  return Math.max(0, Math.min(0.98, score));
}

function classifyDiscoveryMode(
  sourcePage: PageAnalysis,
  bestPage: PageAnalysis,
): BookDiscoveryMode {
  if (
    bestPage.url === sourcePage.url &&
    bestPage.hasSidebarSignal &&
    !TOC_TEXT_RE.test(`${bestPage.title} ${bestPage.url}`)
  ) {
    return "chapter_sidebar";
  }
  if (
    bestPage.url !== sourcePage.url ||
    bestPage.hasTocSignal ||
    TOC_TEXT_RE.test(`${bestPage.title} ${bestPage.bookTitle} ${bestPage.url}`)
  ) {
    return "toc_page";
  }
  if (bestPage.hasSidebarSignal) {
    return "chapter_sidebar";
  }
  return "toc_page";
}

function scoreDiscoveryConfidence(
  page: PageAnalysis,
  chapterCount: number,
): number {
  const average =
    page.candidates.reduce((sum, candidate) => sum + candidate.score, 0) /
    Math.max(1, page.candidates.length);
  let confidence = average;
  if (chapterCount >= 5) {
    confidence += 0.16;
  } else if (chapterCount >= 3) {
    confidence += 0.1;
  } else if (chapterCount === 2) {
    confidence += 0.02;
  } else {
    confidence -= 0.18;
  }
  if (page.hasTocSignal) {
    confidence += 0.08;
  }
  if (page.hasSidebarSignal) {
    confidence += 0.04;
  }
  return roundConfidence(Math.max(0.1, Math.min(0.95, confidence)));
}

function isUnsupportedHref(href: string): boolean {
  return /^(#|mailto:|tel:|javascript:|data:)/i.test(href.trim());
}

function isExcludedLink(title: string, url: URL): boolean {
  return EXCLUDED_TEXT_RE.test(title) || EXCLUDED_PATH_RE.test(url.pathname);
}

function extractAnchorText(anchor: Element): string {
  const text =
    anchor.textContent?.trim() ||
    anchor.getAttribute("aria-label")?.trim() ||
    anchor.getAttribute("title")?.trim() ||
    anchor.querySelector("img")?.getAttribute("alt")?.trim() ||
    "";
  return normalizeWhitespace(text);
}

function stripLinkNoise(text: string): string {
  return normalizeWhitespace(text)
    .replace(/^(?:next|previous|prev|下一章|上一章)[:：\s-]*/i, "")
    .replace(/\s+#?$/, "")
    .trim();
}

function extractPageTitle(document: Document, pageUrl: string): string {
  const metaTitle =
    document.querySelector("meta[property='og:title'], meta[name='twitter:title']")?.getAttribute("content") ??
    undefined;
  const h1 = document.querySelector("h1")?.textContent ?? undefined;
  const documentTitle = document.title || undefined;
  return (
    normalizeWhitespace(metaTitle ?? h1 ?? documentTitle ?? new URL(pageUrl).hostname) ||
    new URL(pageUrl).hostname
  );
}

function extractBookTitle(document: Document, pageTitle: string): string {
  const h1 = normalizeWhitespace(document.querySelector("h1")?.textContent ?? "");
  const title = h1 || pageTitle;
  const withoutToc = title.replace(TOC_TEXT_RE, "").replace(/[:：-]\s*$/, "").trim();
  if (withoutToc) {
    return withoutToc;
  }
  const parts = pageTitle.split(TITLE_SEPARATOR_RE).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? pageTitle;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasSimilarPath(pageUrl: string, candidateUrl: URL): boolean {
  const source = new URL(pageUrl);
  const sourceParts = source.pathname.split("/").filter(Boolean);
  const candidateParts = candidateUrl.pathname.split("/").filter(Boolean);
  if (sourceParts.length === 0 || candidateParts.length === 0) {
    return true;
  }
  return sourceParts[0] === candidateParts[0];
}

function roundConfidence(input: number): number {
  return Math.round(input * 100) / 100;
}

function createDiscoveryId(sourceUrl: string): string {
  const digest = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 10);
  return `disc_${digest}_${randomUUID().slice(0, 8)}`;
}
