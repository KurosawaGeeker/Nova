export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function splitIntoSentences(input: string): string[] {
  const normalized = input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return [];
  }

  const raw = normalized
    .split(/(?<=[。！？!?\.])\s+|(?<=\n)\s*(?=\S)/g)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const sentences: string[] = [];
  for (const part of raw) {
    if (part.length <= 280) {
      sentences.push(part);
      continue;
    }

    const chunks = part
      .split(/(?<=[，,;；:：])\s+/g)
      .map((chunk) => normalizeWhitespace(chunk))
      .filter(Boolean);

    if (chunks.length <= 1) {
      for (let index = 0; index < part.length; index += 240) {
        sentences.push(part.slice(index, index + 240).trim());
      }
      continue;
    }

    let buffer = "";
    for (const chunk of chunks) {
      const next = buffer ? `${buffer} ${chunk}` : chunk;
      if (next.length > 240 && buffer) {
        sentences.push(buffer);
        buffer = chunk;
      } else {
        buffer = next;
      }
    }

    if (buffer) {
      sentences.push(buffer);
    }
  }

  return sentences.filter(Boolean);
}

export function chunkSentencesByLength(
  title: string,
  sentences: string[],
  targetChars: number,
): { title: string; sentences: string[] }[] {
  if (sentences.length === 0) {
    return [];
  }

  const result: { title: string; sentences: string[] }[] = [];
  let bucket: string[] = [];
  let charCount = 0;

  for (const sentence of sentences) {
    if (bucket.length > 0 && charCount + sentence.length > targetChars) {
      result.push({ title, sentences: bucket });
      bucket = [];
      charCount = 0;
    }
    bucket.push(sentence);
    charCount += sentence.length;
  }

  if (bucket.length > 0) {
    result.push({ title, sentences: bucket });
  }

  if (result.length <= 1) {
    return result;
  }

  return result.map((entry, index) => ({
    title: `${title} Part ${index + 1}`,
    sentences: entry.sentences,
  }));
}
