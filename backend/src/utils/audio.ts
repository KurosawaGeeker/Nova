import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function probeDurationMs(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`Unable to probe audio duration for ${filePath}`);
  }
  return Math.round(seconds * 1000);
}

export async function concatenateToM4a(
  segmentPaths: string[],
  outputPath: string,
): Promise<number> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (segmentPaths.length === 0) {
    throw new Error("No audio segments to concatenate");
  }

  if (segmentPaths.length === 1) {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      segmentPaths[0],
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputPath,
    ]);
    return probeDurationMs(outputPath);
  }

  const listPath = path.join(path.dirname(outputPath), `${path.basename(outputPath)}.txt`);
  const content = segmentPaths
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, content, "utf8");

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputPath,
    ]);
  } finally {
    await fs.rm(listPath, { force: true });
  }

  return probeDurationMs(outputPath);
}
