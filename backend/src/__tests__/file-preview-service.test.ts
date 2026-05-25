import Fastify from "fastify";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { registerFileRoutes } from "../routes/files.js";
import { FilePreviewService } from "../services/file-preview-service.js";

function buildEpub(files: Record<string, string>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([entryPath, content]) => [entryPath, strToU8(content)]),
      ),
    ),
  );
}

function buildNavEpub(extraFiles: Record<string, string> = {}): Buffer {
  return buildEpub({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
      "<rootfiles>",
      '<rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>',
      "</rootfiles>",
      "</container>",
    ].join(""),
    "OEBPS/package.opf": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<package version="3.0" xmlns="http://www.idpf.org/2007/opf">',
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
      "<dc:title>Synthetic EPUB</dc:title>",
      "<dc:language>en-US</dc:language>",
      "</metadata>",
      "<manifest>",
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="c1" href="chapters/one.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="c2" href="chapters/two.xhtml" media-type="application/xhtml+xml"/>',
      "</manifest>",
      "<spine>",
      '<itemref idref="c1"/>',
      '<itemref idref="c2"/>',
      "</spine>",
      "</package>",
    ].join(""),
    "OEBPS/nav.xhtml": [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<body>",
      '<nav epub:type="toc"><ol>',
      '<li><a href="chapters/one.xhtml#arrival">Arrival</a></li>',
      '<li><a href="chapters/two.xhtml#listening">Listening Setup</a></li>',
      "</ol></nav>",
      "</body>",
      "</html>",
    ].join(""),
    "OEBPS/chapters/one.xhtml": [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<head><title>One</title></head>",
      "<body><section>",
      '<h1 id="arrival">Arrival</h1>',
      "<p>The first EPUB chapter is readable from the uploaded archive.</p>",
      "</section></body>",
      "</html>",
    ].join(""),
    "OEBPS/chapters/two.xhtml": [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<head><title>Two</title></head>",
      "<body><section>",
      '<h1 id="listening">Listening Setup</h1>',
      "<p>The second EPUB chapter stays preview-only and does not enqueue imports.</p>",
      "</section></body>",
      "</html>",
    ].join(""),
    ...extraFiles,
  });
}

describe("FilePreviewService", () => {
  it("builds TXT chapters from common headings", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromString(
      "story.txt",
      [
        "Chapter 1 The Door",
        "",
        "The first room was quiet. It held a map.",
        "",
        "Chapter 2 The Road",
        "",
        "The second room opened into a road.",
        "",
        "第三章 归途",
        "",
        "风从门外吹进来，故事也到了新的地方。",
      ].join("\n"),
    );

    expect(preview.fileType).toBe("txt");
    expect(preview.status).toBe("READY");
    expect(preview.chapteringMode).toBe("source-headings");
    expect(preview.detectedTitle).toBe("Chapter 1 The Door");
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 1 The Door",
      "Chapter 2 The Road",
      "第三章 归途",
    ]);
  });

  it("falls back to listening-length TXT parts without headings", () => {
    const service = new FilePreviewService();
    const paragraphs = Array.from(
      { length: 14 },
      (_, index) =>
        `This is paragraph ${index + 1}. ${"It keeps the same topic and stays readable. ".repeat(
          30,
        )}`,
    );
    const preview = service.buildPreviewFromString("essay.txt", paragraphs.join("\n\n"));

    expect(preview.fileType).toBe("txt");
    expect(preview.chapteringMode).toBe("length-fallback");
    expect(preview.warnings).toContain(
      "No reliable text headings were detected; using length-based preview.",
    );
    expect(preview.chapters.length).toBeGreaterThan(1);
    expect(preview.chapters.every((chapter) => chapter.title.startsWith("Part "))).toBe(true);
  });

  it("uses Markdown h2 headings as chapter boundaries and first h1 as title", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromString(
      "guide.md",
      [
        "# Nova Guide",
        "",
        "Opening note that should be treated as book-level context.",
        "",
        "## Setup",
        "",
        "Install and configure the app.",
        "",
        "### Details",
        "",
        "This heading should stay inside Setup because h2 boundaries exist.",
        "",
        "## Listening",
        "",
        "Start playback from the generated chapter.",
      ].join("\n"),
      "markdown",
    );

    expect(preview.fileType).toBe("markdown");
    expect(preview.detectedTitle).toBe("Nova Guide");
    expect(preview.chapteringMode).toBe("source-headings");
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual(["Setup", "Listening"]);
  });

  it("uses HTML h2 headings as chapter boundaries and strips document chrome", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromString(
      "local.html",
      [
        "<!doctype html>",
        "<html>",
        "<head><title>Browser Title</title><style>body { color: red; }</style></head>",
        "<body>",
        "<nav>Menu Search Login</nav>",
        "<article>",
        "<h1>Nova HTML Guide</h1>",
        "<p>Introductory context for the whole file.</p>",
        "<h2>Setup</h2>",
        "<p>Install and configure the local preview flow.</p>",
        "<h3>Details</h3>",
        "<p>This detail should remain inside the Setup chapter.</p>",
        "<h2>Listening</h2>",
        "<p>Start playback only after a later import confirmation.</p>",
        "</article>",
        "<footer>Privacy Policy</footer>",
        "</body>",
        "</html>",
      ].join("\n"),
      "text/html",
    );

    expect(preview.fileType).toBe("html");
    expect(preview.status).toBe("READY");
    expect(preview.detectedTitle).toBe("Nova HTML Guide");
    expect(preview.chapteringMode).toBe("source-headings");
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual(["Setup", "Listening"]);
    expect(preview.chapters[0]?.previewText).toContain("Details");
    expect(JSON.stringify(preview)).not.toContain("Privacy Policy");
    expect(JSON.stringify(preview)).not.toContain("Menu Search Login");
  });

  it("returns OCR_REQUIRED for image-only PDF preview without running OCR", () => {
    const service = new FilePreviewService();
    const imageOnlyPdf = Buffer.from(
      [
        "%PDF-1.7",
        "1 0 obj",
        "<< /Type /Page /Resources << /XObject << /Im0 2 0 R >> >> >>",
        "endobj",
        "2 0 obj",
        "<< /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB >>",
        "stream",
        "binary-image-data",
        "endstream",
        "endobj",
        "%%EOF",
      ].join("\n"),
      "latin1",
    );

    const preview = service.buildPreviewFromBuffer(
      "scan.pdf",
      imageOnlyPdf,
      "application/pdf",
    );

    expect(preview.fileType).toBe("pdf");
    expect(preview.status).toBe("OCR_REQUIRED");
    expect(preview.chapteringMode).toBe("skipped");
    expect(preview.chapters).toEqual([]);
    expect(preview.warnings.join(" ")).toContain("OCR is not supported in V1");
  });

  it("builds EPUB chapters from nav and spine XHTML", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromBuffer("book.epub", buildNavEpub());

    expect(preview.fileType).toBe("epub");
    expect(preview.status).toBe("READY");
    expect(preview.detectedTitle).toBe("Synthetic EPUB");
    expect(preview.language).toBe("en");
    expect(preview.chapteringMode).toBe("source-headings");
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "Arrival",
      "Listening Setup",
    ]);
    expect(preview.chapters[0]?.previewText).toContain(
      "readable from the uploaded archive",
    );
  });

  it("uses EPUB spine headings when no nav document is available", () => {
    const service = new FilePreviewService();
    const epub = buildEpub({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": [
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
        '<rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>',
        "</container>",
      ].join(""),
      "OPS/package.opf": [
        '<package version="3.0" xmlns="http://www.idpf.org/2007/opf">',
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Spine Book</dc:title></metadata>',
        "<manifest>",
        '<item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>',
        "</manifest>",
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>',
        "</package>",
      ].join(""),
      "OPS/one.xhtml":
        '<html><body><h1>First Spine Heading</h1><p>Opening body.</p></body></html>',
      "OPS/two.xhtml":
        '<html><body><h1>Second Spine Heading</h1><p>Second body.</p></body></html>',
    });
    const preview = service.buildPreviewFromBuffer("spine.epub", epub);

    expect(preview.fileType).toBe("epub");
    expect(preview.status).toBe("READY");
    expect(preview.detectedTitle).toBe("Spine Book");
    expect(preview.chapteringMode).toBe("source-headings");
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "First Spine Heading",
      "Second Spine Heading",
    ]);
  });

  it("does not bypass encrypted EPUB reading content", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromBuffer(
      "protected.epub",
      buildNavEpub({
        "META-INF/encryption.xml": [
          '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
          '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">',
          "<CipherData>",
          '<CipherReference URI="OEBPS/chapters/one.xhtml"/>',
          "</CipherData>",
          "</EncryptedData>",
          "</encryption>",
        ].join(""),
      }),
      "application/epub+zip",
    );

    expect(preview.fileType).toBe("epub");
    expect(preview.status).toBe("UNSUPPORTED");
    expect(preview.chapteringMode).toBe("skipped");
    expect(preview.chapters).toEqual([]);
    expect(preview.warnings.join(" ")).toContain(
      "Encrypted/protected EPUB content is not supported",
    );
  });

  it("returns preview metadata without TTS or import artifacts", () => {
    const service = new FilePreviewService();
    const preview = service.buildPreviewFromString(
      "note.md",
      "# Note\n\n## One\n\nReadable text only.",
      "markdown",
    );
    const serialized = JSON.stringify(preview);

    expect(serialized).not.toContain("jobId");
    expect(serialized).not.toContain("bookId");
    expect(serialized).not.toContain("downloadUrl");
    expect(serialized).not.toContain("audioFile");
    expect(serialized).not.toContain("subtitleFile");
    expect(preview.chapters[0]?.previewText).toContain("Readable text only.");
  });
});

describe("registerFileRoutes", () => {
  it("exposes a JSON/base64 preview endpoint that can be wired later", async () => {
    const app = Fastify();
    await registerFileRoutes(app, new FilePreviewService());

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/preview",
      payload: {
        fileName: "route.md",
        fileType: "markdown",
        contentBase64: Buffer.from("# Route\n\n## Chapter\n\nBody text.", "utf8").toString(
          "base64",
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fileName: "route.md",
      fileType: "markdown",
      status: "READY",
      detectedTitle: "Route",
      chapteringMode: "source-headings",
    });

    await app.close();
  });

  it("accepts HTML previews through the existing JSON/base64 endpoint shape", async () => {
    const app = Fastify();
    await registerFileRoutes(app, new FilePreviewService());

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/preview",
      payload: {
        fileName: "local.html",
        fileType: "text/html",
        contentBase64: Buffer.from(
          "<article><h1>HTML Book</h1><h2>One</h2><p>Readable body.</p></article>",
          "utf8",
        ).toString("base64"),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fileName: "local.html",
      fileType: "html",
      status: "READY",
      detectedTitle: "HTML Book",
      chapteringMode: "source-headings",
    });

    await app.close();
  });

  it("accepts EPUB previews through the existing JSON/base64 endpoint shape", async () => {
    const app = Fastify();
    await registerFileRoutes(app, new FilePreviewService());

    const response = await app.inject({
      method: "POST",
      url: "/v1/files/preview",
      payload: {
        fileName: "book.epub",
        fileType: "application/epub+zip",
        contentBase64: buildNavEpub().toString("base64"),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fileName: "book.epub",
      fileType: "epub",
      status: "READY",
      detectedTitle: "Synthetic EPUB",
      chapteringMode: "source-headings",
    });

    await app.close();
  });
});
