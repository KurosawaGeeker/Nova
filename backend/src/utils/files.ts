import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import archiver from "archiver";

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download asset from ${url}`);
  }
  await ensureDir(path.dirname(destination));
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream),
    createWriteStream(destination),
  );
}

export async function createZip(sourceDir: string, outputPath: string): Promise<void> {
  await ensureDir(path.dirname(outputPath));

  await new Promise<void>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = createWriteStream(outputPath);

    stream.on("close", () => resolve());
    stream.on("error", reject);
    archive.on("error", reject);

    archive.pipe(stream);
    archive.directory(sourceDir, false);
    archive.finalize().catch(reject);
  });
}
