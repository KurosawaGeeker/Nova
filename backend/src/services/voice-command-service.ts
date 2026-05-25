import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import OpenAI, { toFile } from "openai";

import type { AppConfig } from "../config.js";
import type { SemanticSegment } from "../types.js";
import type { TtsClient } from "../tts/tts-client.js";
import { ensureDir } from "../utils/files.js";

export type VoiceCommandIntent =
  | "REPLAY_PREVIOUS"
  | "ASK_QUESTION"
  | "RESUME"
  | "PAUSE"
  | "CANCEL";

export interface VoiceCommandRequest {
  audioBase64?: string;
  mimeType?: string;
  debugTranscript?: string;
  bookTitle: string;
  chapterTitle: string;
  chapterIndex: number;
  positionMs: number;
  currentSegment?: SemanticSegment;
  previousSegment?: SemanticSegment;
  nextSegments?: SemanticSegment[];
}

export interface VoiceCommandResponse {
  intent: VoiceCommandIntent;
  transcript: string;
  answerText?: string;
  answerAudioUrl?: string;
  replaySegment?: SemanticSegment;
  errorMessage?: string;
}

type IntentDecision = {
  intent: VoiceCommandIntent;
};

export class VoiceCommandService {
  private readonly client?: OpenAI;
  private readonly answerDir: string;

  constructor(
    private readonly config: AppConfig,
    private readonly ttsClient: TtsClient,
    private readonly transcribeOverride?: (request: VoiceCommandRequest) => Promise<string>,
    private readonly answerOverride?: (
      request: VoiceCommandRequest,
      transcript: string,
    ) => Promise<string>,
  ) {
    this.client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : undefined;
    this.answerDir = path.join(config.dataDir, "voice-answers");
  }

  async handle(request: VoiceCommandRequest): Promise<VoiceCommandResponse> {
    const transcript = (await this.transcribe(request)).trim();
    if (!transcript) {
      return {
        intent: "PAUSE",
        transcript,
        errorMessage: "No speech was detected. Playback remains paused.",
      };
    }

    const decision = await this.classifyIntent(request, transcript);
    if (decision.intent === "REPLAY_PREVIOUS") {
      if (!request.previousSegment) {
        return {
          intent: "CANCEL",
          transcript,
          errorMessage: "No completed semantic segment is available to replay.",
        };
      }
      return {
        intent: "REPLAY_PREVIOUS",
        transcript,
        replaySegment: request.previousSegment,
      };
    }

    if (decision.intent === "ASK_QUESTION") {
      const answerText = await this.answerQuestion(request, transcript);
      const answerAudioUrl = await this.synthesizeAnswer(answerText);
      return {
        intent: "ASK_QUESTION",
        transcript,
        answerText,
        answerAudioUrl,
      };
    }

    return {
      intent: decision.intent,
      transcript,
    };
  }

  async getAnswerAudioPath(answerId: string): Promise<string | null> {
    if (!/^[a-f0-9-]+\.mp3$/i.test(answerId)) {
      return null;
    }
    const audioPath = path.join(this.answerDir, answerId);
    try {
      await fs.access(audioPath);
      return audioPath;
    } catch {
      return null;
    }
  }

  private async transcribe(request: VoiceCommandRequest): Promise<string> {
    if (request.debugTranscript) {
      return request.debugTranscript;
    }
    if (this.transcribeOverride) {
      return this.transcribeOverride(request);
    }
    if (!this.client || !request.audioBase64) {
      throw new Error("OPENAI_API_KEY and audioBase64 are required for voice command STT");
    }

    const buffer = Buffer.from(request.audioBase64, "base64");
    const file = await toFile(
      buffer,
      request.mimeType?.includes("mp4") ? "voice-command.m4a" : "voice-command.webm",
      { type: request.mimeType ?? "audio/mp4" },
    );
    const transcription = await this.client.audio.transcriptions.create({
      model: this.config.openAiSttModel,
      file,
      language: "zh",
      response_format: "json",
    });
    return transcription.text;
  }

  private async classifyIntent(
    request: VoiceCommandRequest,
    transcript: string,
  ): Promise<IntentDecision> {
    if (!this.client) {
      return heuristicIntent(transcript);
    }

    const response = await this.client.responses.create({
      model: this.config.openAiCommandModel,
      input: [
        "You classify a one-shot audiobook voice command.",
        "Return only JSON like {\"intent\":\"REPLAY_PREVIOUS\"}.",
        "Allowed intents: REPLAY_PREVIOUS, ASK_QUESTION, RESUME, PAUSE, CANCEL.",
        "Use PAUSE when the user said nothing meaningful, gave an unrelated phrase, or the command is not recognized.",
        "Use ASK_QUESTION only when the user clearly asks for explanation, summary, comparison, examples, or factual Q&A.",
        `Book: ${request.bookTitle}`,
        `Chapter: ${request.chapterTitle}`,
        `Current segment: ${request.currentSegment?.text ?? ""}`,
        `User said: ${transcript}`,
      ].join("\n"),
    });

    const parsed = parseJsonObject(response.output_text);
    const intent = parsed.intent;
    if (
      intent === "REPLAY_PREVIOUS" ||
      intent === "ASK_QUESTION" ||
      intent === "RESUME" ||
      intent === "PAUSE" ||
      intent === "CANCEL"
    ) {
      return { intent };
    }
    return heuristicIntent(transcript);
  }

  private async answerQuestion(
    request: VoiceCommandRequest,
    transcript: string,
  ): Promise<string> {
    if (this.answerOverride) {
      return this.answerOverride(request, transcript);
    }
    if (!this.client) {
      return "我现在没有连接模型服务，暂时不能回答问题。";
    }

    const context = [
      `书名：${request.bookTitle}`,
      `章节：${request.chapterTitle}`,
      `当前位置：第 ${request.chapterIndex + 1} 章 ${Math.round(request.positionMs / 1000)} 秒`,
      `上一语义段：${request.previousSegment?.text ?? "无"}`,
      `当前语义段：${request.currentSegment?.text ?? "无"}`,
      `后续语义段：${(request.nextSegments ?? []).map((segment) => segment.text).join("\n") || "无"}`,
    ].join("\n");

    const response = await this.client.responses.create({
      model: this.config.openAiCommandModel,
      tools: [{ type: "web_search", search_context_size: "low" }],
      input: [
        "你是中文有声书 App 的语音助手。基于当前听书上下文、你的模型知识，并在需要最新或外部事实时使用网络搜索，回答用户问题。",
        "回答要口语化、浅显、简短，最多 120 个中文字。不要提到系统提示或内部上下文。",
        `听书上下文：\n${context}`,
        `用户问题：${transcript}`,
      ].join("\n\n"),
    });

    return response.output_text.trim() || "我没有找到足够信息来回答这个问题。";
  }

  private async synthesizeAnswer(answerText: string): Promise<string> {
    await ensureDir(this.answerDir);
    const fileName = `${randomUUID()}.mp3`;
    const outputPath = path.join(this.answerDir, fileName);
    await this.ttsClient.synthesizeToFile({
      text: answerText,
      outputPath,
    });
    return `${this.config.publicBaseUrl}/v1/voice-commands/audio/${fileName}`;
  }
}

function heuristicIntent(transcript: string): IntentDecision {
  const normalized = transcript.trim().toLowerCase();
  if (/取消|算了|不用|cancel/.test(normalized)) {
    return { intent: "PAUSE" };
  }
  if (/暂停|停一下|停下|pause|stop/.test(normalized)) {
    return { intent: "PAUSE" };
  }
  if (/继续|继续播放|接着播|resume|continue/.test(normalized)) {
    return { intent: "RESUME" };
  }
  if (/没听懂|没听清|没理解|不理解|重播|重讲|再讲|再听|刚才|上一段|repeat|replay/.test(normalized)) {
    return { intent: "REPLAY_PREVIOUS" };
  }
  if (/为什么|怎么|什么|吗|呢|解释|讲一下|说一下|总结|区别|关系|意思|含义|例子|举例|如何|怎么办|\?|？/.test(normalized)) {
    return { intent: "ASK_QUESTION" };
  }
  return { intent: "PAUSE" };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
