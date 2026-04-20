import { promises as fs } from "node:fs";

import OpenAI from "openai";

import { probeDurationMs } from "../utils/audio.js";
import type { TtsClient } from "./tts-client.js";

export class OpenAiTtsClient implements TtsClient {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly voice: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async synthesizeToFile(input: {
    text: string;
    outputPath: string;
  }): Promise<{ durationMs: number }> {
    const response = await this.client.audio.speech.create({
      model: this.model,
      voice: this.voice,
      input: input.text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(input.outputPath, buffer);
    const durationMs = await probeDurationMs(input.outputPath);
    return { durationMs };
  }
}
