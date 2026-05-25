import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { VoiceCommandService } from "../services/voice-command-service.js";
import type { TtsClient } from "../tts/tts-client.js";

const config: AppConfig = {
  port: 8787,
  host: "0.0.0.0",
  publicBaseUrl: "http://localhost:8787",
  dataDir: "/tmp/nova-voice-test",
  fetchTimeoutMs: 30_000,
  maxJobAgeHours: 24,
  importConcurrency: 3,
  openAiModel: "gpt-4o-mini-tts",
  openAiPreprocessModel: "gpt-4o-mini",
  openAiAdaptModel: "gpt-4o-mini",
  openAiCommandModel: "gpt-4o-mini",
  openAiSttModel: "gpt-4o-mini-transcribe",
  openAiVoice: "alloy",
  ttsMode: "mock",
  contentPreprocessMode: "heuristic",
  audioAdaptMode: "off",
  userAgent: "test-agent",
};

const ttsClient: TtsClient = {
  async synthesizeToFile() {
    return { durationMs: 1_000 };
  },
};

describe("voice-command-service", () => {
  it("keeps playback paused when no speech is detected", async () => {
    const service = new VoiceCommandService(config, ttsClient, async () => "");
    const response = await service.handle({
      audioBase64: "mock",
      mimeType: "audio/mp4",
      bookTitle: "Book",
      chapterTitle: "Chapter",
      chapterIndex: 0,
      positionMs: 2_000,
    });

    expect(response.intent).toBe("PAUSE");
    expect(response.errorMessage).toContain("No speech");
  });

  it("returns a replay instruction for replay commands", async () => {
    const service = new VoiceCommandService(config, ttsClient);
    const response = await service.handle({
      debugTranscript: "重播刚才那一段",
      bookTitle: "Book",
      chapterTitle: "Chapter",
      chapterIndex: 0,
      positionMs: 2_000,
      previousSegment: {
        id: "s1",
        chapterIndex: 0,
        startMs: 1_000,
        endMs: 2_000,
        text: "上一段内容",
        kind: "paragraph",
      },
    });

    expect(response.intent).toBe("REPLAY_PREVIOUS");
    expect(response.replaySegment?.startMs).toBe(1_000);
  });

  it("cancels replay when no completed semantic segment is available", async () => {
    const service = new VoiceCommandService(config, ttsClient);
    const response = await service.handle({
      debugTranscript: "重播一下",
      bookTitle: "Book",
      chapterTitle: "Chapter",
      chapterIndex: 0,
      positionMs: 500,
    });

    expect(response.intent).toBe("CANCEL");
    expect(response.errorMessage).toContain("No completed semantic segment");
  });

  it("keeps playback paused for unrecognized transcripts", async () => {
    const service = new VoiceCommandService(config, ttsClient);
    const response = await service.handle({
      debugTranscript: "嗯啊随便说一句",
      bookTitle: "Book",
      chapterTitle: "Chapter",
      chapterIndex: 0,
      positionMs: 2_000,
    });

    expect(response.intent).toBe("PAUSE");
  });
});
