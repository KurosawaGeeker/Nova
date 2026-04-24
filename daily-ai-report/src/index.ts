import he from "he";
import nodemailer from "nodemailer";
import OpenAI from "openai";
import Parser from "rss-parser";
import { z } from "zod";

const SOURCE_FEEDS = [
  {
    name: "The Hacker News / AI",
    url: "https://thehackernews.com/feeds/posts/default/-/AI?alt=rss",
  },
  {
    name: "The Hacker News / Artificial Intelligence",
    url: "https://thehackernews.com/feeds/posts/default/-/artificial%20intelligence?alt=rss",
  },
  {
    name: "The Hacker News / Generative AI",
    url: "https://thehackernews.com/feeds/posts/default/-/Generative%20AI?alt=rss",
  },
  {
    name: "The Hacker News / AI Security",
    url: "https://thehackernews.com/feeds/posts/default/-/AI%20Security?alt=rss",
  },
] as const;

const KEYWORDS = [
  "ai",
  "artificial intelligence",
  "llm",
  "agent",
  "agents",
  "gpt",
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "copilot",
  "llama",
  "mistral",
  "inference",
  "prompt",
  "rag",
  "vector",
  "embedding",
  "model",
  "models",
  "generative ai",
  "agentic",
];

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  QQ_SMTP_HOST: z.string().default("smtp.qq.com"),
  QQ_SMTP_PORT: z.coerce.number().int().positive().default(465),
  QQ_SMTP_SECURE: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  QQ_SMTP_USER: z.string().email(),
  QQ_SMTP_PASS: z.string().min(1),
  REPORT_RECIPIENTS: z.string().min(1),
  REPORT_LOOKBACK_HOURS: z.coerce.number().int().positive().default(36),
  REPORT_MAX_ITEMS: z.coerce.number().int().positive().max(20).default(8),
});

type FeedItem = {
  title: string;
  link: string;
  publishedAt: string;
  source: string;
  summary: string;
  categories: string[];
  score: number;
};

type DigestReport = {
  subject: string;
  intro: string;
  highlights: Array<{
    title: string;
    source: string;
    url: string;
    whyItMatters: string;
    simpleChineseSummary: string;
    tags: string[];
  }>;
  closing: string;
};

const parser = new Parser({
  customFields: {
    item: [
      ["atom:summary", "atomSummary"],
      ["category", "categories", { keepArray: true }],
    ],
  },
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
  },
});

async function main() {
  const env = envSchema.parse(process.env);
  const recipients = env.REPORT_RECIPIENTS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const items = await collectFeedItems(env.REPORT_LOOKBACK_HOURS);
  const shortlisted = items
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, env.REPORT_MAX_ITEMS);

  if (shortlisted.length === 0) {
    console.log("No matching AI items found in the configured lookback window.");
    return;
  }

  const report = await buildDigestReport(env.OPENAI_API_KEY, env.OPENAI_MODEL, shortlisted);
  const html = renderHtml(report);
  const text = renderText(report);

  const transporter = nodemailer.createTransport({
    host: env.QQ_SMTP_HOST,
    port: env.QQ_SMTP_PORT,
    secure: env.QQ_SMTP_SECURE,
    auth: {
      user: env.QQ_SMTP_USER,
      pass: env.QQ_SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: env.QQ_SMTP_USER,
    to: recipients.join(", "),
    subject: report.subject,
    text,
    html,
  });

  console.log(`Sent report to ${recipients.length} recipient(s).`);
}

async function collectFeedItems(lookbackHours: number): Promise<FeedItem[]> {
  const cutoffTime = Date.now() - lookbackHours * 60 * 60 * 1000;
  const results = await Promise.all(
    SOURCE_FEEDS.map(async (source) => {
      const feed = await parser.parseURL(source.url);
      return (feed.items ?? [])
        .map((item) => toFeedItem(source.name, item))
        .filter((item): item is FeedItem => item !== null)
        .filter((item) => Date.parse(item.publishedAt) >= cutoffTime);
    }),
  );

  const deduped = new Map<string, FeedItem>();
  for (const item of results.flat()) {
    const existing = deduped.get(item.link);
    if (!existing || item.score > existing.score) {
      deduped.set(item.link, item);
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );
}

function toFeedItem(source: string, item: Parser.Item): FeedItem | null {
  const title = item.title?.trim();
  const link = item.link?.trim();
  const publishedAt = item.pubDate?.trim();
  if (!title || !link || !publishedAt) {
    return null;
  }

  const summary = cleanSummary(
    String(
      (item as Parser.Item & { atomSummary?: string }).atomSummary ??
        item.contentSnippet ??
        item.content ??
        "",
    ),
  );
  const categories = normalizeCategories((item.categories ?? []) as string[]);
  const score = scoreItem(`${title}\n${summary}\n${categories.join(" ")}`);

  return {
    title,
    link,
    publishedAt,
    source,
    summary,
    categories,
    score,
  };
}

function cleanSummary(input: string): string {
  return he
    .decode(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategories(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function scoreItem(text: string): number {
  const normalized = text.toLowerCase();
  let score = 0;

  for (const keyword of KEYWORDS) {
    if (normalized.includes(keyword)) {
      score += keyword.length >= 6 ? 2 : 1;
    }
  }

  if (normalized.includes("llm") || normalized.includes("agent")) {
    score += 3;
  }
  if (normalized.includes("open-weight") || normalized.includes("open source")) {
    score += 1;
  }

  return score;
}

async function buildDigestReport(
  apiKey: string,
  model: string,
  items: FeedItem[],
): Promise<DigestReport> {
  const client = new OpenAI({ apiKey });
  const payload = items.map((item, index) => ({
    index: index + 1,
    title: item.title,
    url: item.link,
    publishedAt: item.publishedAt,
    source: item.source,
    categories: item.categories,
    summary: item.summary,
  }));

  const response = await client.responses.create({
    model,
    text: {
      format: {
        type: "json_schema",
        name: "daily_ai_digest",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            subject: { type: "string" },
            intro: { type: "string" },
            highlights: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  source: { type: "string" },
                  url: { type: "string" },
                  whyItMatters: { type: "string" },
                  simpleChineseSummary: { type: "string" },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: [
                  "title",
                  "source",
                  "url",
                  "whyItMatters",
                  "simpleChineseSummary",
                  "tags",
                ],
              },
            },
            closing: { type: "string" },
          },
          required: ["subject", "intro", "highlights", "closing"],
        },
      },
    },
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are an editor producing a daily AI security and LLM-agent digest.",
              "Use only the supplied source items.",
              "Write in Simplified Chinese.",
              "Make the language simple and easy for a non-specialist reader.",
              "Prefer concrete explanation over jargon.",
              "Focus on LLMs, AI agents, model security, prompt injection, AI misuse, AI browser/assistant risk, and major AI platform or tooling updates.",
              "If an item is AI-adjacent but weakly relevant, de-prioritize it.",
              "Do not invent facts or links.",
            ].join(" "),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `请根据这些候选新闻生成今天的中文日报：\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
      },
    ],
  });

  return JSON.parse(response.output_text) as DigestReport;
}

function renderHtml(report: DigestReport): string {
  const items = report.highlights
    .map(
      (item) => `
        <li style="margin-bottom:20px;">
          <div style="font-size:18px;font-weight:700;margin-bottom:6px;">${escapeHtml(item.title)}</div>
          <div style="color:#666;margin-bottom:6px;">${escapeHtml(item.source)}</div>
          <div style="margin-bottom:8px;"><strong>为什么值得看：</strong>${escapeHtml(item.whyItMatters)}</div>
          <div style="margin-bottom:8px;"><strong>通俗解释：</strong>${escapeHtml(item.simpleChineseSummary)}</div>
          <div style="margin-bottom:8px;"><strong>标签：</strong>${item.tags.map(escapeHtml).join(" / ")}</div>
          <div><a href="${escapeAttribute(item.url)}">${escapeHtml(item.url)}</a></div>
        </li>`,
    )
    .join("");

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.7;color:#1f2937;">
      <h1 style="margin-bottom:12px;">${escapeHtml(report.subject)}</h1>
      <p style="font-size:16px;margin-bottom:20px;">${escapeHtml(report.intro)}</p>
      <ol style="padding-left:20px;">${items}</ol>
      <p style="margin-top:24px;font-weight:600;">${escapeHtml(report.closing)}</p>
    </div>
  `;
}

function renderText(report: DigestReport): string {
  const lines = [
    report.subject,
    "",
    report.intro,
    "",
    ...report.highlights.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `来源：${item.source}`,
      `为什么值得看：${item.whyItMatters}`,
      `通俗解释：${item.simpleChineseSummary}`,
      `标签：${item.tags.join(" / ")}`,
      `链接：${item.url}`,
      "",
    ]),
    report.closing,
  ];

  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
