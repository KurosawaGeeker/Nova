import fastify from "fastify";
import cors from "@fastify/cors";

import { loadConfig } from "./config.js";
import { FileBackedStore } from "./storage/store.js";
import { WebpageExtractor } from "./services/webpage-extractor.js";
import { ContentPreprocessor } from "./services/content-preprocessor.js";
import { AudioScriptAdapter } from "./services/audio-script-adapter.js";
import { ImportService } from "./services/import-service.js";
import { OpenAiTtsClient } from "./tts/openai-tts-client.js";
import { MockTtsClient } from "./tts/mock-tts-client.js";
import type { TtsClient } from "./tts/tts-client.js";
import { registerImportRoutes } from "./routes/imports.js";
import { registerBookRoutes } from "./routes/books.js";

const config = loadConfig();
const app = fastify({ logger: true });

await app.register(cors, {
  origin: true,
});

const store = new FileBackedStore(config.dataDir);
await store.init();

const extractor = new WebpageExtractor(config);
const contentPreprocessor = new ContentPreprocessor(config);
const audioScriptAdapter = new AudioScriptAdapter(config);
const ttsClient: TtsClient =
  config.ttsMode === "openai"
    ? new OpenAiTtsClient(
        config.openAiApiKey!,
        config.openAiModel,
        config.openAiVoice,
      )
    : new MockTtsClient();
const importService = new ImportService(
  config,
  store,
  extractor,
  contentPreprocessor,
  audioScriptAdapter,
  ttsClient,
);

await registerImportRoutes(app, importService);
await registerBookRoutes(app, importService);

app.get("/health", async () => ({
  ok: true,
  ttsMode: config.ttsMode,
  contentPreprocessMode: config.contentPreprocessMode,
  audioAdaptMode: config.audioAdaptMode,
}));

await store.cleanupExpiredArtifacts(config.maxJobAgeHours);
setInterval(() => {
  store.cleanupExpiredArtifacts(config.maxJobAgeHours).catch((error) => {
    app.log.error(error, "cleanupExpiredArtifacts failed");
  });
}, 60 * 60 * 1000).unref();

await app.listen({
  port: config.port,
  host: config.host,
});
