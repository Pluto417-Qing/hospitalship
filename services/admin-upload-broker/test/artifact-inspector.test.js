"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { inspectArtifact } = require("../src/artifact-inspector");
const { BrokerError } = require("../src/errors");

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0
          ? (value >>> 1) ^ 0xedb88320
          : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const value of entries) {
    const name = Buffer.from(value.name, "utf8");
    const content = Buffer.isBuffer(value.content)
      ? value.content
      : Buffer.from(value.content || "", "utf8");
    const method = value.method === 0 ? 0 : 8;
    const compressed = method === 0 ? content : zlib.deflateRawSync(content);
    const checksum = crc32(content);
    const flags = value.flags === undefined ? 0x0800 : value.flags;
    const versionNeeded = value.versionNeeded === undefined ? 20 : value.versionNeeded;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function documentXml(paragraphs = ["第一段 &amp; 测试", "第二段"]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.map((text) =>
    `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  ).join("")}</w:body>
</w:document>`;
}

function docxEntries(overrides = {}) {
  const entries = [
    {
      name: "[Content_Types].xml",
      content: overrides.contentTypes ||
        "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>"
    },
    {
      name: "_rels/.rels",
      content: overrides.rootRelationships ||
        "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"
    },
    { name: "word/document.xml", content: documentXml() }
  ];
  return [...entries.map((entry) =>
    entry.name === "word/document.xml" && overrides.document
      ? { ...entry, ...overrides.document }
      : entry
  ), ...(overrides.extraEntries || [])];
}

function relationshipsXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.map((relationship, index) => {
    const attributes = [
      `Id="${relationship.id || `rId${index + 1}`}"`,
      `Type="${relationship.type}"`,
      `Target="${relationship.target}"`
    ];
    if (relationship.targetMode) {
      attributes.push(`TargetMode="${relationship.targetMode}"`);
    }
    return `<Relationship ${attributes.join(" ")}/>`;
  }).join("\n")}
</Relationships>`;
}

function reservation(assetType, extension) {
  return { assetType, extension };
}

async function withTempFile(t, extension, bytes, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-inspector-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, `artifact${extension}`);
  await fs.writeFile(filePath, bytes);
  return callback(filePath);
}

function expectCode(code) {
  return (error) => error instanceof BrokerError && error.code === code;
}

test("accepts a safe DOCX and returns bounded plain-text paragraphs", async (t) => {
  await withTempFile(t, ".docx", createZip(docxEntries()), async (filePath) => {
    const result = await inspectArtifact({
      path: filePath,
      reservation: reservation("manuscript", ".docx")
    });

    assert.equal(result.format, "docx");
    assert.equal(result.signatureValid, true);
    assert.equal(result.needsManualStructure, true);
    assert.deepEqual(result.previewParagraphs, ["第一段 & 测试", "第二段"]);
    assert.equal(result.metadata.zipEntryCount, 3);
    assert.equal(result.metadata.previewParagraphCount, 2);
    assert.equal(JSON.stringify(result).includes('"type":"Buffer"'), false);
  });
});

test("rejects a damaged DOCX archive", async (t) => {
  const archive = createZip(docxEntries());
  archive.writeUInt32LE(0, archive.length - 22);
  await withTempFile(t, ".docx", archive, async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("special-topic", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_INVALID")
    );
  });
});

test("requires all three core DOCX package entries", async (t) => {
  const missingRelationships = docxEntries().filter(
    (entry) => entry.name !== "_rels/.rels"
  );
  await withTempFile(t, ".docx", createZip(missingRelationships), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCUMENT_STRUCTURE_INVALID")
    );
  });
});

test("rejects DOCX path traversal before extracting content", async (t) => {
  const entries = [...docxEntries(), { name: "../escape.txt", content: "escape" }];
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_UNSAFE")
    );
  });
});

test("rejects DOCX compression bombs", async (t) => {
  const entries = [
    ...docxEntries(),
    { name: "word/repeated.bin", content: Buffer.alloc(2 * 1024 * 1024, 0x41) }
  ];
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_UNSAFE")
    );
  });
});

test("rejects encrypted and Zip64 DOCX entries", async (t) => {
  await Promise.all([
    withTempFile(
      t,
      ".docx",
      createZip(docxEntries({ document: { flags: 0x0801 } })),
      async (filePath) => assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("manuscript", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      )
    ),
    withTempFile(
      t,
      ".zip64.docx",
      createZip(docxEntries({ document: { versionNeeded: 45 } })),
      async (filePath) => assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("manuscript", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      )
    )
  ]);
});

test("rejects malformed WordprocessingML with a structure error", async (t) => {
  const entries = docxEntries({
    document: { content: "<w:document><w:body><w:p></w:body>" }
  });
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCUMENT_STRUCTURE_INVALID")
    );
  });
});

test("allows a normal internal DOCX image relationship", async (t) => {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png"/>
</Types>`;
  const imageRelationships = relationshipsXml([{
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: "media/image1.png"
  }]);
  const drawingRelationships = relationshipsXml([{
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: "../media/image1.png"
  }]);
  const entries = docxEntries({
    contentTypes,
    extraEntries: [
      { name: "word/_rels/document.xml.rels", content: imageRelationships },
      { name: "word/drawings/_rels/drawing1.xml.rels", content: drawingRelationships },
      { name: "word/drawings/drawing1.xml", content: "<drawing/>" },
      { name: "word/media/image1.png", content: Buffer.from([1, 2, 3, 4]) }
    ]
  });
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    const result = await inspectArtifact({
      path: filePath,
      reservation: reservation("manuscript", ".docx")
    });
    assert.equal(result.signatureValid, true);
    assert.equal(result.metadata.relationshipFileCount, 3);
    assert.equal(result.metadata.relationshipCount, 2);
  });
});

test("rejects macro, embedded, ActiveX, OLE, altChunk and customUI package parts", async (t) => {
  const dangerousParts = [
    "word/vbaProject.bin",
    "word/macros/project.bin",
    "word/embeddings/oleObject1.bin",
    "word/activeX/activeX1.bin",
    "word/oleObject1.bin",
    "word/afchunk1.html",
    "customUI/customUI.xml"
  ];
  for (const dangerousPart of dangerousParts) {
    const entries = docxEntries({
      extraEntries: [{ name: dangerousPart, content: "unsafe" }]
    });
    await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("manuscript", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      );
    });
  }
});

test("rejects active Office content types even when the part name looks harmless", async (t) => {
  const activeContentTypes = [
    "application/vnd.ms-word.document.macroEnabled.main+xml",
    "application/vnd.ms-office.vbaProject",
    "application/vnd.ms-office.activeX+xml",
    "application/vnd.openxmlformats-officedocument.oleObject",
    "application/vnd.ms-office.customUI+xml"
  ];
  for (const activeContentType of activeContentTypes) {
    const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml" ContentType="${activeContentType}"/>
</Types>`;
    await withTempFile(
      t,
      ".docx",
      createZip(docxEntries({ contentTypes })),
      async (filePath) => assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("manuscript", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      )
    );
  }
});

test("rejects active Office relationship types", async (t) => {
  const activeRelationshipKinds = [
    "vbaProject",
    "oleObject",
    "control",
    "attachedTemplate",
    "aFChunk",
    "customUI"
  ];
  for (const kind of activeRelationshipKinds) {
    const rootRelationships = relationshipsXml([{
      type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`,
      target: "word/document.xml"
    }]);
    await withTempFile(
      t,
      ".docx",
      createZip(docxEntries({ rootRelationships })),
      async (filePath) => assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("special-topic", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      )
    );
  }
});

test("rejects external targets in every DOCX relationship part", async (t) => {
  const externalRelationships = relationshipsXml([{
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: "https://example.invalid/tracker.png",
    targetMode: "External"
  }]);
  const entries = docxEntries({
    extraEntries: [{
      name: "word/_rels/header1.xml.rels",
      content: externalRelationships
    }]
  });
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_UNSAFE")
    );
  });
});

test("rejects encoded external relationship targets without TargetMode", async (t) => {
  const relationships = relationshipsXml([{
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: "https%253A%252F%252Fexample.invalid%252Ftracker.png"
  }]);
  const entries = docxEntries({
    extraEntries: [{ name: "word/_rels/document.xml.rels", content: relationships }]
  });
  await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_UNSAFE")
    );
  });
});

test("rejects DOCTYPE and ENTITY declarations in DOCX control XML", async (t) => {
  const unsafeContentTypes = `<?xml version="1.0"?>
<!DOCTYPE Types [<!ENTITY payload "macro">]>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  const unsafeRelationships = `<?xml version="1.0"?>
<!DOCTYPE Relationships [<!ENTITY target SYSTEM "file:///etc/passwd">]>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  const archives = [
    docxEntries({ contentTypes: unsafeContentTypes }),
    docxEntries({
      extraEntries: [{ name: "word/_rels/document.xml.rels", content: unsafeRelationships }]
    })
  ];
  for (const entries of archives) {
    await withTempFile(t, ".docx", createZip(entries), async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("manuscript", ".docx")
        }),
        expectCode("DOCX_ARCHIVE_UNSAFE")
      );
    });
  }
});

test("rejects an altChunk element even without a relationship", async (t) => {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body><w:altChunk r:id="rIdUnsafe"/></w:body>
</w:document>`;
  await withTempFile(
    t,
    ".docx",
    createZip(docxEntries({ document: { content: document } })),
    async (filePath) => assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("manuscript", ".docx")
      }),
      expectCode("DOCX_ARCHIVE_UNSAFE")
    )
  );
});

function pdfFixture(extraDictionary = "") {
  const header = "%PDF-1.7\n%\x80\x81\x82\x83\n";
  const object = `1 0 obj\n<< /Type /Catalog ${extraDictionary} >>\nendobj\n`;
  const objectOffset = Buffer.byteLength(header, "latin1");
  const startXref = objectOffset + Buffer.byteLength(object, "latin1");
  const xref = [
    "xref",
    "0 2",
    "0000000000 65535 f ",
    `${String(objectOffset).padStart(10, "0")} 00000 n `,
    "trailer",
    "<< /Size 2 /Root 1 0 R >>",
    "startxref",
    String(startXref),
    "%%EOF",
    ""
  ].join("\n");
  return Buffer.from(header + object + xref, "latin1");
}

function pdfXrefStreamFixture() {
  const header = Buffer.from("%PDF-1.7\n%\x80\x81\x82\x83\n", "latin1");
  const xrefBytes = Buffer.alloc(14);
  const objectPrefix = Buffer.from(
    "1 0 obj\n<< /Type /XRef /Size 2 /Root 2 0 R /W [1 4 2] /Length 14 >>\nstream\n",
    "ascii"
  );
  const objectSuffix = Buffer.from("\nendstream\nendobj\n", "ascii");
  const tail = Buffer.from(
    `startxref\n${header.length}\n%%EOF\n`,
    "ascii"
  );
  return Buffer.concat([header, objectPrefix, xrefBytes, objectSuffix, tail]);
}

function mp3Fixture() {
  const frame = Buffer.from(
    "//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAEJhAGxgfAACBQcKDQ8SFRcaHB4hJCYpLC4xNDU4Oj1AQkVISk1QUVRXWVxfYWRnaWttcHN1eHt9gIOFh4qMj5KUl5qcn6GjpqirrrCztri7vb/CxcfKzc/S1NfZ297h4+bp6+7x8vX4+v0AAAAATGF2YzU4Ljc4AAAAAAAAAAAAAAAAJAKAAAAAAABsYHzLrMaNAAAAAAAAAAAAAAAAAAAAAA==",
    "base64"
  );
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
  return Buffer.concat([id3, frame]);
}

function isoBox(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function m4aFixture() {
  const brands = Buffer.alloc(16);
  brands.write("M4A ", 0, "ascii");
  brands.write("isom", 8, "ascii");
  brands.write("mp42", 12, "ascii");
  const handler = Buffer.alloc(12);
  handler.write("soun", 8, "ascii");
  const mdia = isoBox("mdia", isoBox("hdlr", handler));
  const trak = isoBox("trak", mdia);
  const moov = isoBox("moov", trak);
  return Buffer.concat([
    isoBox("ftyp", brands),
    moov,
    isoBox("mdat", Buffer.from([1, 2, 3, 4]))
  ]);
}

function riffChunk(type, payload) {
  const padding = payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, padding]);
}

function wavFixture() {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(8000, 4);
  format.writeUInt32LE(8000, 8);
  format.writeUInt16LE(1, 12);
  format.writeUInt16LE(8, 14);
  const payload = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    riffChunk("fmt ", format),
    riffChunk("data", Buffer.from([128, 129, 130, 131, 132, 133, 134, 135]))
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function jpegFixture() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==",
    "base64"
  );
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  typeBytes.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
  return Buffer.concat([header, payload, checksum]);
}

function pngFixture() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function webpFixture() {
  return Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    "base64"
  );
}

const MEDIA_CASES = [
  { assetType: "full-book-pdf", extension: ".pdf", format: "pdf", bytes: pdfFixture },
  { assetType: "audio", extension: ".mp3", format: "mp3", bytes: mp3Fixture },
  { assetType: "audio", extension: ".m4a", format: "m4a", bytes: m4aFixture },
  { assetType: "audio", extension: ".wav", format: "wav", bytes: wavFixture },
  { assetType: "topic-image", extension: ".jpg", format: "jpeg", bytes: jpegFixture },
  { assetType: "topic-image", extension: ".png", format: "png", bytes: pngFixture },
  { assetType: "topic-image", extension: ".webp", format: "webp", bytes: webpFixture }
];

test("recognizes PDF, audio and image signatures", async (t) => {
  for (const media of MEDIA_CASES) {
    await withTempFile(t, media.extension, media.bytes(), async (filePath) => {
      const result = await inspectArtifact({
        path: filePath,
        reservation: reservation(media.assetType, media.extension)
      });
      assert.equal(result.format, media.format);
      assert.equal(result.signatureValid, true);
      assert.ok(result.actualBytes > 0);
      if (["mp3", "wav"].includes(result.format)) {
        assert.ok(result.metadata.durationSeconds > 0);
      }
      if (["jpeg", "png", "webp"].includes(result.format)) {
        assert.ok(result.metadata.width > 0);
        assert.ok(result.metadata.height > 0);
      }
    });
  }
});

test("accepts a bounded PDF xref stream with consistent offsets", async (t) => {
  await withTempFile(t, ".pdf", pdfXrefStreamFixture(), async (filePath) => {
    const result = await inspectArtifact({
      path: filePath,
      reservation: reservation("full-book-pdf", ".pdf")
    });
    assert.equal(result.metadata.xrefKind, "stream");
  });
});

const HEADER_ONLY_CASES = [
  {
    assetType: "full-book-pdf",
    extension: ".pdf",
    bytes: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii")
  },
  {
    assetType: "audio",
    extension: ".mp3",
    bytes: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0])
  },
  {
    assetType: "audio",
    extension: ".m4a",
    bytes: (() => {
      const bytes = Buffer.alloc(24);
      bytes.writeUInt32BE(24, 0);
      bytes.write("ftypM4A ", 4, "ascii");
      return bytes;
    })()
  },
  {
    assetType: "audio",
    extension: ".wav",
    bytes: Buffer.from("RIFF\x04\x00\x00\x00WAVE", "latin1")
  },
  {
    assetType: "topic-image",
    extension: ".jpg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9])
  },
  {
    assetType: "topic-image",
    extension: ".png",
    bytes: (() => {
      const bytes = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      bytes.writeUInt32BE(13, 8);
      bytes.write("IHDR", 12, "ascii");
      bytes.writeUInt32BE(2, 16);
      bytes.writeUInt32BE(3, 20);
      return bytes;
    })()
  },
  {
    assetType: "topic-image",
    extension: ".webp",
    bytes: Buffer.from("RIFF\x08\x00\x00\x00WEBPVP8L", "latin1")
  }
];

test("rejects the former header-only pseudo fixtures", async (t) => {
  for (const media of HEADER_ONLY_CASES) {
    await withTempFile(t, media.extension, media.bytes, async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation(media.assetType, media.extension)
        }),
        expectCode("FILE_SIGNATURE_INVALID")
      );
    });
  }
});

test("rejects unsafe PDF actions, attachments and encryption", async (t) => {
  for (const unsafeName of ["Encrypt", "Java#53cript", "Launch", "EmbeddedFile"]) {
    await withTempFile(t, ".pdf", pdfFixture(`/Unsafe /${unsafeName}`), async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation("full-book-pdf", ".pdf")
        }),
        expectCode("FILE_SIGNATURE_INVALID")
      );
    });
  }
});

test("rejects valid headers with corrupt internal media boundaries", async (t) => {
  const cases = [];
  const pdf = pdfFixture();
  pdf.write("999999", pdf.indexOf("startxref", 0, "ascii") + 10, "ascii");
  cases.push({ assetType: "full-book-pdf", extension: ".pdf", bytes: pdf });

  const mp3 = mp3Fixture().subarray(0, mp3Fixture().length - 1);
  cases.push({ assetType: "audio", extension: ".mp3", bytes: mp3 });

  const m4a = m4aFixture();
  m4a.write("vide", m4a.indexOf("soun", 0, "ascii"), "ascii");
  cases.push({ assetType: "audio", extension: ".m4a", bytes: m4a });

  const nestedM4a = m4aFixture();
  const mdiaOffset = nestedM4a.indexOf("mdia", 0, "ascii") - 4;
  nestedM4a.writeUInt32BE(nestedM4a.readUInt32BE(mdiaOffset) - 1, mdiaOffset);
  cases.push({ assetType: "audio", extension: ".m4a", bytes: nestedM4a });

  const wav = wavFixture();
  wav.writeUInt32LE(wav.readUInt32LE(4) - 1, 4);
  cases.push({ assetType: "audio", extension: ".wav", bytes: wav });

  const jpeg = jpegFixture();
  jpeg.writeUInt16BE(0xffff, 4);
  cases.push({ assetType: "topic-image", extension: ".jpg", bytes: jpeg });

  const png = pngFixture();
  png[png.length - 1] ^= 0xff;
  cases.push({ assetType: "topic-image", extension: ".png", bytes: png });

  const webp = webpFixture();
  webp.writeUInt32LE(webp.readUInt32LE(4) - 2, 4);
  cases.push({ assetType: "topic-image", extension: ".webp", bytes: webp });

  for (const media of cases) {
    await withTempFile(t, media.extension, media.bytes, async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation(media.assetType, media.extension)
        }),
        expectCode("FILE_SIGNATURE_INVALID")
      );
    });
  }
});

test("rejects damaged PDF, audio and image signatures", async (t) => {
  for (const media of MEDIA_CASES) {
    const damaged = Buffer.from(media.bytes());
    damaged[0] ^= 0xff;
    await withTempFile(t, media.extension, damaged, async (filePath) => {
      await assert.rejects(
        inspectArtifact({
          path: filePath,
          reservation: reservation(media.assetType, media.extension)
        }),
        expectCode("FILE_SIGNATURE_INVALID")
      );
    });
  }
});

test("rejects extension and asset-type mismatches as BrokerError", async (t) => {
  await withTempFile(t, ".pdf", pdfFixture(), async (filePath) => {
    await assert.rejects(
      inspectArtifact({
        path: filePath,
        reservation: reservation("audio", ".pdf")
      }),
      expectCode("FILE_SIGNATURE_INVALID")
    );
  });
});
