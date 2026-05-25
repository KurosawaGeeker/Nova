import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { FilePreviewService } from "../services/file-preview-service.js";

const previewSchema = z
  .object({
    fileName: z.string().min(1),
    fileType: z.string().optional(),
    content: z.string().optional(),
    contentBase64: z.string().optional(),
  })
  .refine((payload) => payload.content !== undefined || payload.contentBase64 !== undefined, {
    message: "Either content or contentBase64 is required.",
  });

export async function registerFileRoutes(
  app: FastifyInstance,
  service: FilePreviewService,
): Promise<void> {
  app.post("/v1/files/preview", async (request, reply) => {
    const payload = previewSchema.parse(request.body);
    const content =
      payload.contentBase64 !== undefined
        ? Buffer.from(payload.contentBase64, "base64")
        : (payload.content ?? "");

    const preview = service.buildPreview({
      fileName: payload.fileName,
      fileType: payload.fileType,
      content,
    });

    if (preview.status === "EMPTY") {
      reply.code(422);
    }

    return preview;
  });
}
