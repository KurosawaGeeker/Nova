import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ImportService } from "../services/import-service.js";

const submitSchema = z.object({
  url: z.string().url(),
});

export async function registerImportRoutes(
  app: FastifyInstance,
  importService: ImportService,
): Promise<void> {
  app.post("/v1/imports/url", async (request, reply) => {
    const payload = submitSchema.parse(request.body);
    const job = await importService.submitUrl(payload.url);
    reply.code(202);
    return {
      jobId: job.jobId,
      normalizedUrl: job.normalizedUrl,
    };
  });

  app.get("/v1/imports/:jobId", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = await importService.getJob(params.jobId);
    if (!job) {
      reply.code(404);
      return { message: "Job not found" };
    }
    return {
      status: job.status,
      progress: job.progress,
      bookId: job.bookId,
      downloadUrl: job.downloadUrl,
      errorMessage: job.errorMessage,
    };
  });
}
