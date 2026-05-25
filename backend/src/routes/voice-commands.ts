import { createReadStream } from "node:fs";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { VoiceCommandService } from "../services/voice-command-service.js";

const segmentSchema = z.object({
  id: z.string(),
  chapterIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  title: z.string().optional(),
  text: z.string(),
  kind: z.enum(["paragraph", "heading", "sentence", "section", "list", "quote", "table"]),
});

const voiceCommandSchema = z.object({
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  debugTranscript: z.string().optional(),
  bookTitle: z.string(),
  chapterTitle: z.string(),
  chapterIndex: z.number().int().nonnegative(),
  positionMs: z.number().int().nonnegative(),
  currentSegment: segmentSchema.optional(),
  previousSegment: segmentSchema.optional(),
  nextSegments: z.array(segmentSchema).max(4).optional(),
});

export async function registerVoiceCommandRoutes(
  app: FastifyInstance,
  voiceCommandService: VoiceCommandService,
): Promise<void> {
  app.post("/v1/voice-commands", async (request, reply) => {
    const payload = voiceCommandSchema.parse(request.body);
    try {
      return await voiceCommandService.handle(payload);
    } catch (error) {
      reply.code(502);
      return {
        intent: "CANCEL",
        transcript: payload.debugTranscript ?? "",
        errorMessage: error instanceof Error ? error.message : "Voice command failed",
      };
    }
  });

  app.get("/v1/voice-commands/audio/:answerId", async (request, reply) => {
    const params = z.object({ answerId: z.string() }).parse(request.params);
    const audioPath = await voiceCommandService.getAnswerAudioPath(params.answerId);
    if (!audioPath) {
      reply.code(404);
      return { message: "Answer audio not found" };
    }

    reply.header("Content-Type", "audio/mpeg");
    return reply.send(createReadStream(audioPath));
  });
}
