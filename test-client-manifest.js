const assert = require("assert");
const {
  CLIENT_MANIFEST_HASH_SCOPE,
  MAX_CANONICAL_MANIFEST_BYTES,
  ClientManifestError,
  normalizeClientManifest,
  validateAndConvertClientManifest
} = require("./cloudfunctions/adminContentCenter/clientManifest");

function sourceManifest(blocks, images = [], overrides = {}) {
  const rawCharacters = blocks.reduce(
    (sum, block) => sum + (
      block && typeof block.text === "string" ? block.text.length : 0
    ),
    0
  );
  return {
    schemaVersion: 1,
    sourceType: "docx",
    title: "测试文稿",
    blocks,
    images,
    warnings: [],
    stats: {
      extractedBlocks: blocks.length,
      extractedCharacters: rawCharacters,
      imageCount: images.length,
      imageReferenceCount: blocks.reduce(
        (sum, block) => sum + (
          Array.isArray(block && block.images) ? block.images.length : 0
        ),
        0
      ),
      inferredHeadingCount: 0,
      omittedImageReferences: 0,
      unsupportedImageReferences: 0,
      totalParagraphs: blocks.length,
      truncated: false
    },
    ...overrides
  };
}

function paragraph(text, imageOrders) {
  const block = { type: "paragraph", text };
  if (imageOrders) block.images = imageOrders;
  return block;
}

function heading(text, level = 1, imageOrders) {
  const block = { type: "heading", text, level };
  if (imageOrders) block.images = imageOrders;
  return block;
}

function image(order, overrides = {}) {
  return {
    relationId: `rImage${order}`,
    packagePath: `word/media/image${order}.png`,
    extension: ".png",
    order,
    ...overrides
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .reverse()
      .reduce((result, key) => {
        result[key] = reverseObjectKeys(value[key]);
        return result;
      }, {});
  }
  return value;
}

function assertManifestError(callback, code) {
  assert.throws(
    callback,
    (error) => {
      assert.ok(error instanceof ClientManifestError);
      assert.strictEqual(error.code, code);
      assert.ok(typeof error.message === "string" && error.message.length > 0);
      return true;
    },
    code
  );
}

function testManuscriptConversionAndImagePlacement() {
  const manifest = sourceManifest(
    [
      paragraph("测试文稿"),
      paragraph("  第一段\r\n第二行  ", [1]),
      heading("第二节", 2),
      paragraph("第二节正文")
    ],
    [image(1, { caption: "病房照片" })]
  );
  const result = validateAndConvertClientManifest("manuscript", manifest);

  assert.deepStrictEqual(result.clientDraftPayload.sections, [
    {
      kind: "story",
      heading: "",
      paragraphs: ["第一段\n第二行"]
    },
    {
      kind: "story",
      heading: "第二节",
      paragraphs: ["第二节正文"]
    }
  ]);
  assert.strictEqual(result.clientDraftPayload.structureConfirmed, false);
  assert.strictEqual(result.clientDraftPayload.catalogViews[0], "book");
  assert.deepStrictEqual(result.imagePlacements[0].location, {
    kind: "manuscript-section",
    sectionIndex: 0,
    afterParagraphIndex: 0
  });
  assert.strictEqual(result.imagePlacements[0].packagePath, "word/media/image1.png");
  assert.strictEqual(result.importStats.sections, 2);
  assert.strictEqual(result.importStats.paragraphs, 2);
  assert.strictEqual(result.importStats.images, 1);
  assert.strictEqual(
    JSON.stringify(result.clientDraftPayload.sections).includes("测试文稿"),
    false,
    "普通正文样式的首段文档标题不能重复进入正文"
  );
}

function testSpecialTopicConversion() {
  const manifest = sourceManifest(
    [
      heading("测试文稿", 1),
      heading("第一条", 1),
      paragraph("第一条正文", [1]),
      heading("提示", 2),
      paragraph("补充说明"),
      heading("第二条", 1),
      paragraph("第二条正文")
    ],
    [image(1)]
  );
  const result = validateAndConvertClientManifest("special-topic", manifest);

  assert.strictEqual(result.clientDraftPayload.entries.length, 2);
  assert.deepStrictEqual(result.clientDraftPayload.entries[0].blocks, [
    { type: "heading", text: "第一条" },
    { type: "text", text: "第一条正文" },
    { type: "heading", text: "提示" },
    { type: "text", text: "补充说明" }
  ]);
  assert.deepStrictEqual(result.clientDraftPayload.entries[1].blocks, [
    { type: "heading", text: "第二条" },
    { type: "text", text: "第二条正文" }
  ]);
  assert.deepStrictEqual(result.imagePlacements[0].location, {
    kind: "special-topic-entry",
    entryIndex: 0,
    insertAtBlockIndex: 2
  });
  assert.strictEqual(result.importStats.entries, 2);
  assert.strictEqual(result.importStats.blocks, 7);

  const wpsStyles = sourceManifest([
    paragraph("测试文稿"),
    paragraph("专题寄语"),
    heading("第一条", 7),
    paragraph("第一条正文"),
    heading("第二条", 7),
    paragraph("第二条正文")
  ]);
  const wpsResult = validateAndConvertClientManifest(
    "special-topic",
    wpsStyles
  );
  assert.strictEqual(
    wpsResult.clientDraftPayload.entries.length,
    3,
    "WPS 使用非 1 级标题时，应以文档中最上层的实际标题建立目录"
  );
  assert.deepStrictEqual(wpsResult.clientDraftPayload.entries[1].blocks, [
    { type: "heading", text: "第一条" },
    { type: "text", text: "第一条正文" }
  ]);
}

function testRepeatedImageReferencesAndIncompleteImageRejection() {
  const repeated = sourceManifest(
    [
      paragraph("第一次出现", [1]),
      paragraph("第二次出现", [1])
    ],
    [image(1)]
  );
  const converted = validateAndConvertClientManifest(
    "special-topic",
    repeated
  );
  assert.strictEqual(converted.imagePlacements.length, 2);
  assert.deepStrictEqual(
    converted.imagePlacements.map((item) => item.imageOrder),
    [1, 1]
  );
  assert.strictEqual(converted.manifestMeta.stats.imageCount, 1);
  assert.strictEqual(converted.manifestMeta.stats.imageReferenceCount, 2);

  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      {
        ...repeated,
        stats: { ...repeated.stats, omittedImageReferences: 1 }
      }
    ),
    "CLIENT_MANIFEST_IMAGE_INCOMPLETE"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      {
        ...repeated,
        stats: { ...repeated.stats, unsupportedImageReferences: 1 }
      }
    ),
    "CLIENT_MANIFEST_IMAGE_FORMAT_UNSUPPORTED"
  );
}

function testPlainParagraphTitleIsSkippedForBothAssetTypes() {
  const manifest = sourceManifest([
    paragraph("测试文稿"),
    paragraph("真正的正文")
  ]);
  const manuscript = validateAndConvertClientManifest(
    "manuscript",
    manifest
  );
  assert.deepStrictEqual(
    manuscript.clientDraftPayload.sections[0].paragraphs,
    ["真正的正文"]
  );

  const topic = validateAndConvertClientManifest("special-topic", manifest);
  assert.deepStrictEqual(topic.clientDraftPayload.entries[0].blocks, [
    { type: "text", text: "真正的正文" }
  ]);
}

function testCanonicalHashAndCompactIntegrationContract() {
  const body = "同一份正文";
  const manifest = sourceManifest([
    heading("测试文稿"),
    paragraph(body)
  ], [], {
    warnings: ["外部链接不会导入", "外部链接不会导入"]
  });
  const reordered = reverseObjectKeys(manifest);
  const first = validateAndConvertClientManifest("manuscript", manifest);
  const second = validateAndConvertClientManifest("manuscript", reordered);

  assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(first.manifestSha256, second.manifestSha256);
  assert.deepStrictEqual(first.manifestFingerprint, {
    algorithm: "sha256",
    scope: CLIENT_MANIFEST_HASH_SCOPE,
    value: first.manifestSha256
  });
  assert.strictEqual(first.hashScope, CLIENT_MANIFEST_HASH_SCOPE);
  assert.strictEqual(first.manifestMeta.hashAlgorithm, "sha256");
  assert.ok(first.manifestMeta.canonicalBytes > 0);
  assert.ok(first.manifestMeta.canonicalBytes <= MAX_CANONICAL_MANIFEST_BYTES);
  assert.strictEqual(first.normalizedManifest, undefined);
  assert.strictEqual(first.draftPayload, undefined);
  assert.strictEqual(first.originalFileSha256, undefined);
  assert.strictEqual(first.sha256, undefined);
  assert.strictEqual(
    JSON.stringify(first).split(body).length - 1,
    1,
    "正文只能在 clientDraftPayload/draftPayload 中落一份"
  );
  assert.deepStrictEqual(first.manifestMeta.warnings, ["外部链接不会导入"]);
}

function testRejectsUnsafeTruncatedAndUnsupportedInput() {
  const base = sourceManifest([paragraph("正文")]);

  assertManifestError(
    () => validateAndConvertClientManifest("audio", base),
    "CLIENT_MANIFEST_ASSET_TYPE_UNSUPPORTED"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      { ...base, containsMacros: true }
    ),
    "CLIENT_MANIFEST_ACTIVE_CONTENT"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      {
        ...base,
        security: {
          activeContentDetected: false,
          macrosDetected: false,
          activexDetected: true,
          oleObjectsDetected: false
        }
      }
    ),
    "CLIENT_MANIFEST_ACTIVE_CONTENT"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      {
        ...base,
        stats: { ...base.stats, truncated: true }
      }
    ),
    "CLIENT_MANIFEST_TRUNCATED"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      { ...base, tables: [] }
    ),
    "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      sourceManifest([{ type: "table", text: "不支持" }])
    ),
    "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      {
        ...base,
        stats: { ...base.stats, extractedCharacters: 999 }
      }
    ),
    "CLIENT_MANIFEST_STATS_MISMATCH"
  );
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      sourceManifest([paragraph("正文")], [image(1)])
    ),
    "CLIENT_MANIFEST_IMAGE_INVALID"
  );
}

function testManuscriptLimits() {
  const tooManySections = [];
  for (let index = 0; index < 121; index += 1) {
    tooManySections.push(heading(`分节 ${index + 1}`));
    tooManySections.push(paragraph("正文"));
  }
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      sourceManifest(tooManySections)
    ),
    "CLIENT_MANIFEST_LIMIT_EXCEEDED"
  );

  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      sourceManifest(
        Array.from({ length: 201 }, () => paragraph("正文"))
      )
    ),
    "CLIENT_MANIFEST_LIMIT_EXCEEDED"
  );

  const tooManyCharacters = Array.from(
    { length: 15 },
    () => paragraph("甲".repeat(10000))
  );
  tooManyCharacters.push(paragraph("乙"));
  assertManifestError(
    () => validateAndConvertClientManifest(
      "manuscript",
      sourceManifest(tooManyCharacters)
    ),
    "CLIENT_MANIFEST_LIMIT_EXCEEDED"
  );
}

function testSpecialTopicLimits() {
  const tooManyBlocks = [];
  for (let entry = 0; entry < 10; entry += 1) {
    tooManyBlocks.push(heading(`条目 ${entry + 1}`));
    for (let index = 0; index < 199; index += 1) {
      tooManyBlocks.push(paragraph("内容"));
    }
  }
  tooManyBlocks.push(heading("超出的条目"));
  assert.strictEqual(tooManyBlocks.length, 2001);
  assertManifestError(
    () => validateAndConvertClientManifest(
      "special-topic",
      sourceManifest(tooManyBlocks)
    ),
    "CLIENT_MANIFEST_LIMIT_EXCEEDED"
  );

  const tooManyCharacters = Array.from(
    { length: 20 },
    () => paragraph("甲".repeat(10000))
  );
  tooManyCharacters.push(paragraph("乙"));
  assertManifestError(
    () => validateAndConvertClientManifest(
      "special-topic",
      sourceManifest(tooManyCharacters)
    ),
    "CLIENT_MANIFEST_LIMIT_EXCEEDED"
  );
}

function testCanonicalByteLimit() {
  const blocks = [];
  const images = [];
  for (let index = 0; index < 200; index += 1) {
    blocks.push(paragraph("中".repeat(1000), [index + 1]));
    images.push(image(index + 1, { caption: "图".repeat(300) }));
  }
  assertManifestError(
    () => validateAndConvertClientManifest(
      "special-topic",
      sourceManifest(blocks, images)
    ),
    "MANIFEST_TOO_LARGE"
  );
}

function testNormalizeExportIsPureAndBounded() {
  const raw = sourceManifest([
    heading("  测试文稿  "),
    paragraph("正文")
  ], [], {
    warnings: ["提示 B", "提示 A"]
  });
  const normalized = normalizeClientManifest(raw);
  assert.strictEqual(normalized.title, "测试文稿");
  assert.deepStrictEqual(normalized.warnings, ["提示 A", "提示 B"]);
  assert.deepStrictEqual(raw.warnings, ["提示 B", "提示 A"]);

  const tableOfContentsSkipped = sourceManifest(
    [paragraph("正文")],
    [],
    {
      stats: {
        ...sourceManifest([paragraph("正文")]).stats,
        skippedTableOfContentsParagraphs: 2,
        totalParagraphs: 3
      }
    }
  );
  assert.strictEqual(
    normalizeClientManifest(tableOfContentsSkipped)
      .stats.skippedTableOfContentsParagraphs,
    2
  );
}

function main() {
  testManuscriptConversionAndImagePlacement();
  testSpecialTopicConversion();
  testRepeatedImageReferencesAndIncompleteImageRejection();
  testPlainParagraphTitleIsSkippedForBothAssetTypes();
  testCanonicalHashAndCompactIntegrationContract();
  testRejectsUnsafeTruncatedAndUnsupportedInput();
  testManuscriptLimits();
  testSpecialTopicLimits();
  testCanonicalByteLimit();
  testNormalizeExportIsPureAndBounded();
  console.log(
    "Word 客户端清单测试通过：严格校验、稿件/专题转换、图片定位、哈希范围和 700KB 硬限制均已覆盖。"
  );
}

main();
