import { unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import path from "node:path";

export interface ParsedEpubNavEntry {
  title: string;
  href: string;
  path: string;
  fragment: string | null;
}

export interface ParsedEpubSection {
  id: string;
  path: string;
  html: string;
}

export interface ParsedEpubArchive {
  title: string | null;
  languageTag: string | null;
  sections: ParsedEpubSection[];
  navEntries: ParsedEpubNavEntry[];
  warnings: string[];
}

interface ManifestItem {
  id: string;
  href: string;
  path: string;
  mediaType: string;
  properties: string[];
}

interface SpineItem {
  idref: string;
  linear: boolean;
}

export class EpubUnsupportedError extends Error {
  readonly warnings: string[];

  constructor(message: string, warnings: string[] = [message]) {
    super(message);
    this.name = "EpubUnsupportedError";
    this.warnings = warnings;
  }
}

export function parseEpubArchive(content: Buffer): ParsedEpubArchive {
  const entries = unzipEpub(content);
  const warnings: string[] = [];
  const containerXml = readRequiredTextEntry(entries, "META-INF/container.xml", [
    "EPUB container metadata was not found.",
  ]);
  const containerDocument = parseXml(containerXml, "EPUB container metadata");
  const rootfilePath = findRootfilePath(containerDocument);

  if (!rootfilePath) {
    throw new EpubUnsupportedError("EPUB package rootfile was not found.");
  }

  const normalizedRootfilePath = normalizeZipPath(rootfilePath);
  const opfXml = readRequiredTextEntry(entries, normalizedRootfilePath, [
    "EPUB package document could not be read.",
  ]);
  const opfDocument = parseXml(opfXml, "EPUB package document");
  const opfDirectory = path.posix.dirname(normalizedRootfilePath);
  const encryptedPaths = findEncryptedPaths(entries, opfDirectory, warnings);
  const manifest = parseManifest(opfDocument, opfDirectory);
  const spine = parseSpine(opfDocument);
  const title = firstTextByLocalName(opfDocument, "title");
  const languageTag = firstTextByLocalName(opfDocument, "language");
  const navItem = findNavItem(manifest);
  const ncxItem = findNcxItem(manifest, opfDocument);
  const spineContentPaths = spine
    .map((item) => manifest.get(item.idref))
    .filter((item): item is ManifestItem => Boolean(item))
    .map((item) => item.path);

  guardAgainstEncryptedReadingContent(
    encryptedPaths,
    [normalizedRootfilePath, navItem?.path, ncxItem?.path, ...spineContentPaths],
  );

  const navEntries =
    navItem && entries[navItem.path]
      ? parseNavEntries(readTextEntry(entries, navItem.path), path.posix.dirname(navItem.path))
      : [];
  const tocEntries =
    navEntries.length === 0 && ncxItem && entries[ncxItem.path]
      ? parseNcxEntries(readTextEntry(entries, ncxItem.path), path.posix.dirname(ncxItem.path))
      : navEntries;
  const sections = collectSections(entries, manifest, spine, navItem, warnings);

  if (sections.length === 0) {
    throw new EpubUnsupportedError("No readable XHTML spine content was found in the EPUB.");
  }

  return {
    title,
    languageTag,
    sections,
    navEntries: tocEntries,
    warnings,
  };
}

function unzipEpub(content: Buffer): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(content));
  } catch {
    throw new EpubUnsupportedError(
      "EPUB archive could not be read; it may be corrupt or encrypted.",
    );
  }
}

function readRequiredTextEntry(
  entries: Record<string, Uint8Array>,
  entryPath: string,
  warnings: string[],
): string {
  const entry = entries[entryPath];
  if (!entry) {
    throw new EpubUnsupportedError(warnings[0] ?? "Required EPUB entry was not found.", warnings);
  }
  return decodeUtf8(entry);
}

function readTextEntry(entries: Record<string, Uint8Array>, entryPath: string): string {
  return decodeUtf8(entries[entryPath] ?? new Uint8Array());
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
}

function parseXml(xml: string, label: string): Document {
  const dom = new JSDOM(xml, { contentType: "application/xml" });
  const document = dom.window.document;
  const parserError = document.querySelector("parsererror");

  if (parserError) {
    throw new EpubUnsupportedError(`${label} is malformed and could not be parsed.`);
  }

  return document;
}

function findRootfilePath(document: Document): string | null {
  const rootfiles = elementsByLocalName(document, "rootfile");
  const packageRootfile =
    rootfiles.find(
      (element) =>
        (element.getAttribute("media-type") ?? "").toLowerCase() ===
        "application/oebps-package+xml",
    ) ?? rootfiles[0];

  return packageRootfile?.getAttribute("full-path")?.trim() || null;
}

function findEncryptedPaths(
  entries: Record<string, Uint8Array>,
  opfDirectory: string,
  warnings: string[],
): Set<string> {
  const encryptionEntry = entries["META-INF/encryption.xml"];

  if (!encryptionEntry) {
    return new Set();
  }

  const encryptedPaths = new Set<string>();

  try {
    const encryptionDocument = parseXml(decodeUtf8(encryptionEntry), "EPUB encryption metadata");
    for (const reference of elementsByLocalName(encryptionDocument, "CipherReference")) {
      const uri = reference.getAttribute("URI")?.trim();
      if (uri) {
        encryptedPaths.add(resolveZipPath(".", uri));
        encryptedPaths.add(resolveZipPath(opfDirectory, uri));
      }
    }
  } catch {
    throw new EpubUnsupportedError(
      "EPUB encryption metadata could not be parsed; protected EPUB content is not supported.",
    );
  }

  if (encryptedPaths.size > 0) {
    warnings.push("EPUB contains encrypted assets; protected reading content cannot be previewed.");
  }

  return encryptedPaths;
}

function guardAgainstEncryptedReadingContent(
  encryptedPaths: Set<string>,
  readingPaths: Array<string | undefined>,
): void {
  if (encryptedPaths.size === 0) {
    return;
  }

  const normalizedReadingPaths = new Set(
    readingPaths.filter((entryPath): entryPath is string => Boolean(entryPath)),
  );
  const encryptedReadingContent = Array.from(encryptedPaths).some(
    (entryPath) =>
      normalizedReadingPaths.has(entryPath) ||
      /\.(?:xhtml|html?|opf|ncx|xml)$/i.test(entryPath),
  );

  if (encryptedReadingContent) {
    throw new EpubUnsupportedError(
      "Encrypted/protected EPUB content is not supported; DRM is not bypassed.",
    );
  }
}

function parseManifest(document: Document, opfDirectory: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();

  for (const item of elementsByLocalName(document, "item")) {
    const id = item.getAttribute("id")?.trim();
    const href = item.getAttribute("href")?.trim();
    if (!id || !href) {
      continue;
    }

    manifest.set(id, {
      id,
      href,
      path: resolveZipPath(opfDirectory, href),
      mediaType: (item.getAttribute("media-type") ?? "").trim().toLowerCase(),
      properties: (item.getAttribute("properties") ?? "")
        .split(/\s+/)
        .map((property) => property.trim().toLowerCase())
        .filter(Boolean),
    });
  }

  return manifest;
}

function parseSpine(document: Document): SpineItem[] {
  return elementsByLocalName(document, "itemref")
    .map((itemref) => ({
      idref: itemref.getAttribute("idref")?.trim() ?? "",
      linear: (itemref.getAttribute("linear") ?? "yes").toLowerCase() !== "no",
    }))
    .filter((itemref) => itemref.idref && itemref.linear);
}

function findNavItem(manifest: Map<string, ManifestItem>): ManifestItem | null {
  return (
    Array.from(manifest.values()).find((item) => item.properties.includes("nav")) ??
    null
  );
}

function findNcxItem(manifest: Map<string, ManifestItem>, document: Document): ManifestItem | null {
  const spine = elementsByLocalName(document, "spine")[0];
  const tocId = spine?.getAttribute("toc")?.trim();
  if (tocId && manifest.has(tocId)) {
    return manifest.get(tocId) ?? null;
  }

  return (
    Array.from(manifest.values()).find(
      (item) => item.mediaType === "application/x-dtbncx+xml",
    ) ?? null
  );
}

function parseNavEntries(html: string, navDirectory: string): ParsedEpubNavEntry[] {
  const dom = new JSDOM(html);
  const navs = Array.from(dom.window.document.querySelectorAll("nav"));
  const tocNav =
    navs.find((nav) => {
      const type = `${nav.getAttribute("epub:type") ?? ""} ${nav.getAttribute("type") ?? ""}`;
      return type.toLowerCase().split(/\s+/).includes("toc");
    }) ?? navs[0];

  if (!tocNav) {
    return [];
  }

  return Array.from(tocNav.querySelectorAll("a[href]"))
    .map((anchor) => {
      const href = anchor.getAttribute("href")?.trim() ?? "";
      const title = normalizeInlineText(anchor.textContent ?? "");
      return toNavEntry(title, href, navDirectory);
    })
    .filter((entry): entry is ParsedEpubNavEntry => Boolean(entry));
}

function parseNcxEntries(xml: string, ncxDirectory: string): ParsedEpubNavEntry[] {
  const document = parseXml(xml, "EPUB NCX table of contents");

  return elementsByLocalName(document, "navPoint")
    .map((point) => {
      const label = elementsByLocalName(point, "text")[0]?.textContent ?? "";
      const src = elementsByLocalName(point, "content")[0]?.getAttribute("src") ?? "";
      return toNavEntry(normalizeInlineText(label), src.trim(), ncxDirectory);
    })
    .filter((entry): entry is ParsedEpubNavEntry => Boolean(entry));
}

function toNavEntry(
  title: string,
  href: string,
  baseDirectory: string,
): ParsedEpubNavEntry | null {
  if (!title || !href || /^https?:\/\//i.test(href)) {
    return null;
  }

  const [pathPart, fragmentPart] = href.split("#");
  const resolvedPath = resolveZipPath(baseDirectory, pathPart ?? "");

  return {
    title,
    href,
    path: resolvedPath,
    fragment: fragmentPart ? safeDecodeURIComponent(fragmentPart) : null,
  };
}

function collectSections(
  entries: Record<string, Uint8Array>,
  manifest: Map<string, ManifestItem>,
  spine: SpineItem[],
  navItem: ManifestItem | null,
  warnings: string[],
): ParsedEpubSection[] {
  const spineSections = spine
    .map((item) => manifest.get(item.idref))
    .filter((item): item is ManifestItem => Boolean(item))
    .filter(isHtmlManifestItem)
    .filter((item) => Boolean(entries[item.path]));

  const selectedItems =
    spineSections.length > 0
      ? spineSections
      : Array.from(manifest.values())
          .filter(isHtmlManifestItem)
          .filter((item) => item.path !== navItem?.path)
          .filter((item) => Boolean(entries[item.path]))
          .sort((left, right) => left.path.localeCompare(right.path));

  if (spineSections.length === 0 && selectedItems.length > 0) {
    warnings.push("No EPUB spine was found; preview used common XHTML/HTML files in archive order.");
  }

  return selectedItems.map((item) => ({
    id: item.id,
    path: item.path,
    html: readTextEntry(entries, item.path),
  }));
}

function isHtmlManifestItem(item: ManifestItem): boolean {
  return (
    item.mediaType === "application/xhtml+xml" ||
    item.mediaType === "text/html" ||
    /\.(?:xhtml|html?)$/i.test(item.path)
  );
}

function elementsByLocalName(root: ParentNode, localName: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter(
    (element) => element.localName.toLowerCase() === localName.toLowerCase(),
  );
}

function firstTextByLocalName(root: ParentNode, localName: string): string | null {
  const text = elementsByLocalName(root, localName)[0]?.textContent ?? "";
  return normalizeInlineText(text) || null;
}

function resolveZipPath(baseDirectory: string, href: string): string {
  const [pathPart] = href.split(/[?#]/);
  const decodedPath = safeDecodeURIComponent(pathPart ?? "").replace(/\\/g, "/");
  const joined =
    decodedPath.startsWith("/")
      ? decodedPath.slice(1)
      : path.posix.join(baseDirectory === "." ? "" : baseDirectory, decodedPath);

  return normalizeZipPath(joined);
}

function normalizeZipPath(entryPath: string): string {
  return path.posix.normalize(entryPath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
