import fastify from "fastify";
import cors from "@fastify/cors";

import { loadConfig } from "./config.js";
import { FileBackedStore } from "./storage/store.js";
import { WebpageExtractor } from "./services/webpage-extractor.js";
import { ContentPreprocessor } from "./services/content-preprocessor.js";
import { AudioScriptAdapter } from "./services/audio-script-adapter.js";
import { ImportService } from "./services/import-service.js";
import { BookDiscoveryService } from "./services/book-discovery-service.js";
import { OpenAiTtsClient } from "./tts/openai-tts-client.js";
import { MockTtsClient } from "./tts/mock-tts-client.js";
import type { TtsClient } from "./tts/tts-client.js";
import { registerImportRoutes } from "./routes/imports.js";
import { registerBookRoutes } from "./routes/books.js";
import { registerVoiceCommandRoutes } from "./routes/voice-commands.js";
import { registerVideoRoutes } from "./routes/videos.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { VoiceCommandService } from "./services/voice-command-service.js";
import { VideoMetadataService } from "./services/video-metadata-service.js";
import { VideoImportService } from "./services/video-import-service.js";
import { FilePreviewService } from "./services/file-preview-service.js";
import {
  BillingService,
  InMemoryBillingRepository,
  LocalDemoBillingAccountService,
} from "./billing/index.js";

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
const bookDiscoveryService = new BookDiscoveryService(config);
const videoMetadataService = new VideoMetadataService();
const videoImportService = new VideoImportService(store, videoMetadataService);
const filePreviewService = new FilePreviewService();
const billingRepository = new InMemoryBillingRepository();
const billingService = new BillingService(billingRepository);
const localDemoBillingAccountService = new LocalDemoBillingAccountService();
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
const voiceCommandService = new VoiceCommandService(config, ttsClient);

await registerImportRoutes(app, importService);
await registerBookRoutes(app, importService, bookDiscoveryService);
await registerVoiceCommandRoutes(app, voiceCommandService);
await registerVideoRoutes(app, videoMetadataService, videoImportService);
await registerFileRoutes(app, filePreviewService);
await registerBillingRoutes(app, billingService, localDemoBillingAccountService);

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
