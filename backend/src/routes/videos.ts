import { createReadStream } from "node:fs";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  UnsupportedVideoImportError,
  VideoImportService,
} from "../services/video-import-service.js";
import { VideoMetadataService } from "../services/video-metadata-service.js";

const detectSchema = z.object({
  url: z.string().url(),
});

const importSchema = z.object({
  url: z.string().url(),
});

const videoBookParamsSchema = z.object({
  bookId: z.string().uuid(),
});

export async function registerVideoRoutes(
  app: FastifyInstance,
  service: VideoMetadataService,
  importService?: VideoImportService,
): Promise<void> {
  app.post("/v1/videos/detect", async (request) => {
    const payload = detectSchema.parse(request.body);
    return service.detect(payload.url);
  });

  app.post("/v1/videos/import", async (request, reply) => {
    if (!importService) {
      reply.code(503);
      return { message: "Video import service is not configured" };
    }

    const payload = importSchema.parse(request.body);
    try {
      const job = await importService.importVideoBook(payload.url);
      reply.code(202);
      return job;
    } catch (error) {
      if (error instanceof UnsupportedVideoImportError) {
        reply.code(400);
        return {
          message: error.message,
          warnings: error.warnings,
        };
      }
      throw error;
    }
  });

  app.get("/v1/videos/imports/:jobId", async (request, reply) => {
    if (!importService) {
      reply.code(503);
      return { message: "Video import service is not configured" };
    }

    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const status = await importService.getImportStatus(params.jobId);
    if (!status) {
      reply.code(404);
      return { message: "Video import job not found" };
    }
    return status;
  });

  app.get("/v1/videos/books/:bookId/transcript.vtt", async (request, reply) => {
    if (!importService) {
      reply.code(503);
      return { message: "Video import service is not configured" };
    }

    const params = videoBookParamsSchema.parse(request.params);
    const transcriptPath = await importService.getTranscriptArtifactPath(params.bookId);
    if (!transcriptPath) {
      reply.code(404);
      return { message: "Video transcript not found" };
    }

    reply.header("Content-Type", "text/vtt; charset=utf-8");
    return reply.send(createReadStream(transcriptPath));
  });

  app.get("/v1/videos/books/:bookId/script.json", async (request, reply) => {
    if (!importService) {
      reply.code(503);
      return { message: "Video import service is not configured" };
    }

    const params = videoBookParamsSchema.parse(request.params);
    const scriptPath = await importService.getScriptArtifactPath(params.bookId);
    if (!scriptPath) {
      reply.code(404);
      return { message: "Video script not found" };
    }

    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(createReadStream(scriptPath));
  });
}
