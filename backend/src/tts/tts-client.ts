export interface TtsClient {
  synthesizeToFile(input: { text: string; outputPath: string }): Promise<{ durationMs: number }>;
}
