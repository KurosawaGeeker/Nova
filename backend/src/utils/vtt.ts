import type { SentenceCue } from "../types.js";

export function buildWebVtt(cues: SentenceCue[]): string {
  const lines = ["WEBVTT", ""];

  cues.forEach((cue, index) => {
    lines.push(String(index + 1));
    lines.push(`${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`);
    lines.push(cue.text);
    lines.push("");
  });

  return lines.join("\n");
}

export function formatTimestamp(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = Math.floor(safe % 1_000);

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
