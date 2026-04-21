import path from "node:path";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  DATA_DIR: z.string().default("./data"),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MAX_JOB_AGE_HOURS: z.coerce.number().int().positive().default(24),
  IMPORT_CONCURRENCY: z.coerce.number().int().positive().max(8).default(3),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini-tts"),
  OPENAI_PREPROCESS_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_ADAPT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_VOICE: z.string().default("alloy"),
  TTS_MODE: z.enum(["auto", "openai", "mock"]).default("auto"),
  CONTENT_PREPROCESS_MODE: z.enum(["auto", "openai", "heuristic"]).default("auto"),
  AUDIO_ADAPT_MODE: z.enum(["auto", "openai", "off"]).default("auto"),
});

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  dataDir: string;
  fetchTimeoutMs: number;
  maxJobAgeHours: number;
  importConcurrency: number;
  openAiApiKey?: string;
  openAiModel: string;
  openAiPreprocessModel: string;
  openAiAdaptModel: string;
  openAiVoice: string;
  ttsMode: "openai" | "mock";
  contentPreprocessMode: "openai" | "heuristic";
  audioAdaptMode: "openai" | "off";
  userAgent: string;
}

export function loadConfig(): AppConfig {
  const env = schema.parse(process.env);
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;
  const ttsMode =
    env.TTS_MODE === "auto"
      ? env.OPENAI_API_KEY
        ? "openai"
        : "mock"
      : env.TTS_MODE;
  const contentPreprocessMode =
    env.CONTENT_PREPROCESS_MODE === "auto"
      ? env.OPENAI_API_KEY
        ? "openai"
        : "heuristic"
      : env.CONTENT_PREPROCESS_MODE;
  const audioAdaptMode =
    env.AUDIO_ADAPT_MODE === "auto"
      ? env.OPENAI_API_KEY
        ? "openai"
        : "off"
      : env.AUDIO_ADAPT_MODE;

  if (ttsMode === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when TTS_MODE=openai");
  }
  if (contentPreprocessMode === "openai" && !env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required when CONTENT_PREPROCESS_MODE=openai",
    );
  }
  if (audioAdaptMode === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AUDIO_ADAPT_MODE=openai");
  }

  return {
    port: env.PORT,
    host: env.HOST,
    publicBaseUrl,
    dataDir: path.resolve(process.cwd(), env.DATA_DIR),
    fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
    maxJobAgeHours: env.MAX_JOB_AGE_HOURS,
    importConcurrency: env.IMPORT_CONCURRENCY,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL,
    openAiPreprocessModel: env.OPENAI_PREPROCESS_MODEL,
    openAiAdaptModel: env.OPENAI_ADAPT_MODEL,
    openAiVoice: env.OPENAI_VOICE,
    ttsMode,
    contentPreprocessMode,
    audioAdaptMode,
    userAgent:
      "NovaAudios/0.1 (+https://example.local; article extraction and audiobook packaging)",
  };
}
