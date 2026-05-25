import { createReadStream } from "node:fs";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { BookDiscoveryService } from "../services/book-discovery-service.js";
import { ImportService } from "../services/import-service.js";

const discoverSchema = z.object({
  url: z.string().url(),
});

const createBookSchema = z.object({
  discoveryId: z.string().optional(),
  title: z.string().min(1),
  sourceRootUrl: z.string().url(),
  chapters: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        title: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .min(1)
    .max(50),
});

const bookParamsSchema = z.object({ bookId: z.string().uuid() });

const chapterParamsSchema = z.object({
  bookId: z.string().uuid(),
  chapterId: z.string().uuid(),
});

export async function registerBookRoutes(
  app: FastifyInstance,
  importService: ImportService,
  bookDiscoveryService: BookDiscoveryService,
): Promise<void> {
  app.post("/v1/books/discover", async (request) => {
    const payload = discoverSchema.parse(request.body);
    return bookDiscoveryService.discover(payload.url);
  });

  app.post("/v1/books", async (request, reply) => {
    const payload = createBookSchema.parse(request.body);
    const result = await importService.submitBookImport(payload);
    reply.code(202);
    return result;
  });

  app.get("/v1/books/:bookId", async (request, reply) => {
    const params = bookParamsSchema.parse(request.params);
    const status = await importService.getBookStatus(params.bookId);
    if (!status) {
      reply.code(404);
      return { message: "Book not found" };
    }
    return status;
  });

  app.get("/v1/books/:bookId/package.zip", async (request, reply) => {
    const params = bookParamsSchema.parse(request.params);
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

  app.get(
    "/v1/books/:bookId/chapters/:chapterId/package.zip",
    async (request, reply) => {
      const params = chapterParamsSchema.parse(request.params);
      const packagePath = await importService.getChapterPackagePath(
        params.bookId,
        params.chapterId,
      );
      if (!packagePath) {
        reply.code(404);
        return { message: "Chapter package not found" };
      }

      reply.header("Content-Type", "application/zip");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${params.bookId}-${params.chapterId}-package.zip"`,
      );
      return reply.send(createReadStream(packagePath));
    },
  );

  app.post(
    "/v1/books/:bookId/chapters/:chapterId/retry",
    async (request, reply) => {
      const params = chapterParamsSchema.parse(request.params);
      const result = await importService.retryChapterImport(
        params.bookId,
        params.chapterId,
      );
      if (!result.ok) {
        reply.code(result.statusCode);
        return result;
      }

      reply.code(202);
      return result;
    },
  );

  app.post(
    "/v1/books/:bookId/chapters/:chapterId/prioritize",
    async (request, reply) => {
      const params = chapterParamsSchema.parse(request.params);
      const result = await importService.prioritizeChapterImport(
        params.bookId,
        params.chapterId,
      );
      if (!result.ok) {
        reply.code(result.statusCode);
        return result;
      }

      reply.code(202);
      return result;
    },
  );
}
