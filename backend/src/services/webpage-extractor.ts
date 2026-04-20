import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { AppConfig } from "../config.js";
import type { ExtractedArticle } from "../types.js";

export class WebpageExtractor {
  constructor(private readonly config: AppConfig) {}

  async extract(url: string): Promise<ExtractedArticle> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": this.config.userAgent,
      },
      signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Upstream response was ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("Only HTML article pages are supported in V1");
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const title = article?.title?.trim();
    const contentHtml = article?.content?.trim();
    const textContent = article?.textContent?.trim();

    if (!title || !contentHtml || !textContent || textContent.length < 300) {
      throw new Error("The page did not yield readable article content");
    }

    const parsedArticle = article!;

    const coverUrl =
      dom.window.document
        .querySelector("meta[property='og:image'], meta[name='twitter:image']")
        ?.getAttribute("content") ?? undefined;

    return {
      title,
      contentHtml,
      textContent,
      language: parsedArticle.lang ?? guessLanguage(textContent),
      excerpt: parsedArticle.excerpt ?? undefined,
      siteName: parsedArticle.siteName ?? undefined,
      coverUrl,
    };
  }
}

function guessLanguage(text: string): string {
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  return hasCjk ? "zh" : "en";
}
