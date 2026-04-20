import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probeDurationMs } from "../utils/audio.js";
import type { TtsClient } from "./tts-client.js";

const execFileAsync = promisify(execFile);

export class MockTtsClient implements TtsClient {
  async synthesizeToFile(input: {
    text: string;
    outputPath: string;
  }): Promise<{ durationMs: number }> {
    const seconds = Math.max(1.0, Math.round((input.text.length / 18) * 10) / 10);
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=660:duration=${seconds}`,
      "-q:a",
      "5",
      input.outputPath,
    ]);
    const durationMs = await probeDurationMs(input.outputPath);
    return { durationMs };
  }
}
