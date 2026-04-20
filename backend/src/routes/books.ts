import { createReadStream } from "node:fs";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ImportService } from "../services/import-service.js";

export async function registerBookRoutes(
  app: FastifyInstance,
  importService: ImportService,
): Promise<void> {
  app.get("/v1/books/:bookId/package.zip", async (request, reply) => {
    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const packagePath = await importService.getPackagePath(params.bookId);
    if (!packagePath) {
      reply.code(404);
      return { message: "Package not found" };
    }

    reply.header("Content-Type", "application/zip");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${params.bookId}-package.zip"`,
    );
    return reply.send(createReadStream(packagePath));
  });
}
