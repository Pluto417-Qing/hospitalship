const crypto = require("crypto");

const SUPPORTED_ASSET_TYPES = new Set(["manuscript", "special-topic"]);
const SAFE_IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);
const CLIENT_MANIFEST_HASH_SCOPE = "client-parsed-docx-manifest";
const CLIENT_MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CANONICAL_MANIFEST_BYTES = 700 * 1024;
const MAX_SOURCE_BLOCKS = 5000;
const MAX_IMAGES = 200;
const MAX_IMAGE_REFERENCES = 1000;
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARACTERS = 300;
const MAX_PARAGRAPH_CHARACTERS = 10000;
const MAX_MANUSCRIPT_CHARACTERS = 150000;
const MAX_MANUSCRIPT_SECTIONS = 120;
const MAX_MANUSCRIPT_PARAGRAPHS_PER_SECTION = 200;
const MAX_TOPIC_CHARACTERS = 200000;
const MAX_TOPIC_BLOCKS = 2000;
const MAX_TOPIC_ENTRIES = 200;
const MAX_TOPIC_BLOCKS_PER_ENTRY = 200;

const ROOT_KEYS = new Set([
  "activeContent",
  "blocks",
  "containsMacros",
  "hasMacros",
  "images",
  "schemaVersion",
  "security",
  "sourceType",
  "stats",
  "title",
  "unsafeContent",
  "warnings"
]);
const BLOCK_KEYS = new Set(["images", "level", "text", "type"]);
const IMAGE_KEYS = new Set([
  "caption",
  "extension",
  "order",
  "packagePath",
  "relationId"
]);
const STATS_KEYS = new Set([
  "extractedBlocks",
  "extractedCharacters",
  "imageCount",
  "imageReferenceCount",
  "inferredHeadingCount",
  "omittedImageReferences",
  "skippedTableOfContentsParagraphs",
  "totalParagraphs",
  "truncated",
  "unsupportedImageReferences"
]);
const SECURITY_KEYS = new Set([
  "activeContentDetected",
  "activexDetected",
  "macrosDetected",
  "oleObjectsDetected"
]);

class ClientManifestError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ClientManifestError";
    this.code = code;
    if (details && typeof details === "object") {
      this.details = details;
    }
  }
}

function fail(code, message, details = null) {
  throw new ClientManifestError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 结构无效，请重新选择原始 .docx 文件`,
      { path }
    );
  }
}

function assertAllowedKeys(value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(
        "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED",
        `Word 中包含当前版本无法识别的结构（${path}.${key}），请使用普通标题、正文和图片后重试`,
        { path: `${path}.${key}` }
      );
    }
  }
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 必须是布尔值`,
      { path }
    );
  }
  return value;
}

function assertInteger(value, path, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 数值无效`,
      { path }
    );
  }
  return value;
}

function hasInvalidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizePlainText(value, path, maximum, options = {}) {
  if (typeof value !== "string") {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 必须是文字`,
      { path }
    );
  }
  if (hasInvalidUnicode(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 含有损坏的字符，请重新保存文档后重试`,
      { path }
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `Word 解析结果中的 ${path} 含有不支持的控制字符`,
      { path }
    );
  }

  let text = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\ufeff/g, "");

  if (options.heading) {
    text = text.replace(/\s+/g, " ").trim();
  } else {
    text = text
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim();
  }

  if (text.length > maximum) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      `${options.heading ? "标题" : "正文段落"}过长，请在 Word 中拆分后重新上传`,
      { limit: maximum, path }
    );
  }
  if (options.required && !text) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      `${options.heading ? "标题" : "正文"}不能为空`,
      { path }
    );
  }
  return text;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) {
          result[key] = canonicalize(value[key]);
        }
        return result;
      }, {});
  }
  return value;
}

function canonicalStringifyManifest(value) {
  return JSON.stringify(canonicalize(value));
}

function clientManifestSha256(normalizedManifest) {
  return crypto
    .createHash("sha256")
    .update(canonicalStringifyManifest(normalizedManifest), "utf8")
    .digest("hex");
}

function assertSerializedSize(rawManifest) {
  let serialized;
  try {
    serialized = JSON.stringify(rawManifest);
  } catch (error) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      "Word 解析结果无法读取，请重新选择原始 .docx 文件"
    );
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES
  ) {
    fail(
      "MANIFEST_TOO_LARGE",
      "Word 文稿的解析结果过大，请拆分成多个文稿后上传",
      { limitBytes: MAX_MANIFEST_BYTES }
    );
  }
}

function canonicalManifestBytes(normalizedManifest) {
  return Buffer.byteLength(
    canonicalStringifyManifest(normalizedManifest),
    "utf8"
  );
}

function assertCanonicalSize(normalizedManifest) {
  const bytes = canonicalManifestBytes(normalizedManifest);
  if (bytes > MAX_CANONICAL_MANIFEST_BYTES) {
    fail(
      "MANIFEST_TOO_LARGE",
      "这个 Word 文档内容较多，无法一次安全导入；请拆分为多个 Word 文档后分别上传",
      {
        actualBytes: bytes,
        limitBytes: MAX_CANONICAL_MANIFEST_BYTES
      }
    );
  }
  return bytes;
}

function assertNoActiveContent(rawManifest) {
  const activeRootFlags = [
    "activeContent",
    "containsMacros",
    "hasMacros",
    "unsafeContent"
  ];
  for (const key of activeRootFlags) {
    if (rawManifest[key] !== undefined) {
      assertBoolean(rawManifest[key], key);
      if (rawManifest[key]) {
        fail(
          "CLIENT_MANIFEST_ACTIVE_CONTENT",
          "该 Word 文件包含宏或嵌入程序，请在 Word/WPS 中另存为普通 .docx 后再上传"
        );
      }
    }
  }

  const security = rawManifest.security;
  if (security === undefined) {
    return;
  }
  assertPlainObject(security, "security");
  assertAllowedKeys(security, SECURITY_KEYS, "security");
  for (const key of SECURITY_KEYS) {
    if (security[key] !== undefined) {
      assertBoolean(security[key], `security.${key}`);
      if (security[key]) {
        fail(
          "CLIENT_MANIFEST_ACTIVE_CONTENT",
          "该 Word 文件包含宏、ActiveX 或嵌入程序，请另存为普通 .docx 后再上传"
        );
      }
    }
  }
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      "Word 解析结果中的提示信息无效，请重新选择文件"
    );
  }
  if (value.length > MAX_WARNINGS) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      "Word 解析结果中的提示信息过多，请重新保存文档后上传",
      { limit: MAX_WARNINGS, path: "warnings" }
    );
  }
  const warnings = value.map((item, index) =>
    normalizePlainText(
      item,
      `warnings[${index}]`,
      MAX_WARNING_CHARACTERS,
      {}
    )
  ).filter(Boolean);

  if (warnings.some((warning) =>
    /(?:activex|macro|ole|vba|宏|嵌入程序)/i.test(warning)
  )) {
    fail(
      "CLIENT_MANIFEST_ACTIVE_CONTENT",
      "该 Word 文件可能包含宏或嵌入程序，请另存为普通 .docx 后再上传"
    );
  }
  return Array.from(new Set(warnings)).sort();
}

function normalizePackagePath(value, path) {
  const normalized = normalizePlainText(value, path, 512, {
    required: true
  }).replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    !normalized.startsWith("word/media/") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      "CLIENT_MANIFEST_IMAGE_INVALID",
      "Word 内嵌图片路径无效，请重新保存文档后上传",
      { path }
    );
  }
  return normalized;
}

function normalizeImages(value) {
  if (!Array.isArray(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      "Word 解析结果中的图片清单无效，请重新选择原始文档",
      { path: "images" }
    );
  }
  if (value.length > MAX_IMAGES) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      `单个 Word 文稿最多支持 ${MAX_IMAGES} 张内嵌图片`,
      { limit: MAX_IMAGES, path: "images" }
    );
  }

  const seenPaths = new Set();
  const seenRelations = new Set();
  return value.map((rawImage, index) => {
    const path = `images[${index}]`;
    assertPlainObject(rawImage, path);
    assertAllowedKeys(rawImage, IMAGE_KEYS, path);

    const order = assertInteger(rawImage.order, `${path}.order`, 1, MAX_IMAGES);
    if (order !== index + 1) {
      fail(
        "CLIENT_MANIFEST_IMAGE_INVALID",
        "Word 图片顺序不连续，请重新选择原始文档",
        { path: `${path}.order` }
      );
    }

    const relationId = normalizePlainText(
      rawImage.relationId,
      `${path}.relationId`,
      128,
      { required: true, heading: true }
    );
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(relationId)) {
      fail(
        "CLIENT_MANIFEST_IMAGE_INVALID",
        "Word 内嵌图片关系编号无效，请重新保存文档后上传",
        { path: `${path}.relationId` }
      );
    }

    const packagePath = normalizePackagePath(
      rawImage.packagePath,
      `${path}.packagePath`
    );
    const extension = normalizePlainText(
      rawImage.extension,
      `${path}.extension`,
      8,
      { required: true, heading: true }
    ).toLowerCase();
    if (
      !SAFE_IMAGE_EXTENSIONS.has(extension) ||
      !packagePath.toLowerCase().endsWith(extension)
    ) {
      fail(
        "CLIENT_MANIFEST_IMAGE_INVALID",
        "Word 中包含不支持的图片格式，请改用 JPG、PNG、GIF 或 WebP",
        { path: `${path}.extension` }
      );
    }
    if (seenPaths.has(packagePath) || seenRelations.has(relationId)) {
      fail(
        "CLIENT_MANIFEST_IMAGE_INVALID",
        "Word 解析结果中存在重复图片，请重新选择原始文档",
        { path }
      );
    }
    seenPaths.add(packagePath);
    seenRelations.add(relationId);

    return {
      relationId,
      packagePath,
      extension,
      order,
      caption: rawImage.caption === undefined
        ? ""
        : normalizePlainText(rawImage.caption, `${path}.caption`, 300, {})
    };
  });
}

function normalizeBlockImages(value, path, imageCount, referencedImages) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_IMAGE_REFERENCES) {
    fail(
      "CLIENT_MANIFEST_IMAGE_INVALID",
      "Word 正文中的图片引用无效，请重新选择原始文档",
      { path }
    );
  }
  return value.map((item, index) => {
    const imagePath = `${path}[${index}]`;
    const order = assertInteger(item, imagePath, 1, imageCount);
    referencedImages.add(order);
    return order;
  });
}

function normalizeBlocks(value, images) {
  if (!Array.isArray(value)) {
    fail(
      "CLIENT_MANIFEST_INVALID",
      "Word 解析结果中的正文清单无效，请重新选择原始文档",
      { path: "blocks" }
    );
  }
  if (value.length > MAX_SOURCE_BLOCKS) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      "Word 文稿段落过多，请拆分成多个文稿后上传",
      { limit: MAX_SOURCE_BLOCKS, path: "blocks" }
    );
  }

  const referencedImages = new Set();
  const blocks = value.map((rawBlock, index) => {
    const path = `blocks[${index}]`;
    assertPlainObject(rawBlock, path);
    assertAllowedKeys(rawBlock, BLOCK_KEYS, path);

    const type = normalizePlainText(rawBlock.type, `${path}.type`, 20, {
      required: true,
      heading: true
    }).toLowerCase();
    if (type !== "paragraph" && type !== "heading") {
      fail(
        "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED",
        "Word 中包含当前版本无法识别的正文结构，请仅使用普通标题、正文和图片",
        { path: `${path}.type`, type }
      );
    }

    const text = normalizePlainText(
      rawBlock.text,
      `${path}.text`,
      type === "heading" ? 300 : MAX_PARAGRAPH_CHARACTERS,
      { heading: type === "heading" }
    );
    const imageOrders = normalizeBlockImages(
      rawBlock.images,
      `${path}.images`,
      images.length,
      referencedImages
    );
    if (!text && imageOrders.length === 0) {
      fail(
        "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED",
        "Word 解析结果中存在空白内容块，请删除空白对象后重新保存",
        { path }
      );
    }

    if (type === "heading") {
      const level = assertInteger(rawBlock.level, `${path}.level`, 1, 9);
      return { type, text, level, images: imageOrders };
    }
    if (rawBlock.level !== undefined) {
      fail(
        "CLIENT_MANIFEST_STRUCTURE_UNSUPPORTED",
        "普通正文不能带有标题级别，请重新设置 Word 段落样式",
        { path: `${path}.level` }
      );
    }
    return { type, text, images: imageOrders };
  });

  for (const image of images) {
    if (!referencedImages.has(image.order)) {
      fail(
        "CLIENT_MANIFEST_IMAGE_INVALID",
        "Word 解析结果中有未定位的图片，请重新保存文档后上传",
        { imageOrder: image.order }
      );
    }
  }
  return blocks;
}

function normalizeStats(value, rawBlocks, normalizedBlocks, images) {
  assertPlainObject(value, "stats");
  assertAllowedKeys(value, STATS_KEYS, "stats");

  const extractedBlocks = assertInteger(
    value.extractedBlocks,
    "stats.extractedBlocks",
    0,
    MAX_SOURCE_BLOCKS
  );
  const extractedCharacters = assertInteger(
    value.extractedCharacters,
    "stats.extractedCharacters",
    0,
    1000000
  );
  const imageCount = assertInteger(
    value.imageCount,
    "stats.imageCount",
    0,
    MAX_IMAGES
  );
  const imageReferenceCount = assertInteger(
    value.imageReferenceCount,
    "stats.imageReferenceCount",
    0,
    MAX_IMAGE_REFERENCES
  );
  const omittedImageReferences = assertInteger(
    value.omittedImageReferences,
    "stats.omittedImageReferences",
    0,
    100000
  );
  const inferredHeadingCount = assertInteger(
    value.inferredHeadingCount === undefined ? 0 : value.inferredHeadingCount,
    "stats.inferredHeadingCount",
    0,
    MAX_SOURCE_BLOCKS
  );
  const unsupportedImageReferences = assertInteger(
    value.unsupportedImageReferences,
    "stats.unsupportedImageReferences",
    0,
    100000
  );
  const skippedTableOfContentsParagraphs = assertInteger(
    value.skippedTableOfContentsParagraphs === undefined
      ? 0
      : value.skippedTableOfContentsParagraphs,
    "stats.skippedTableOfContentsParagraphs",
    0,
    100000
  );
  const totalParagraphs = assertInteger(
    value.totalParagraphs,
    "stats.totalParagraphs",
    0,
    100000
  );
  const truncated = assertBoolean(value.truncated, "stats.truncated");
  if (truncated) {
    fail(
      "CLIENT_MANIFEST_TRUNCATED",
      "Word 内容超过单篇导入上限，未完整读取；请拆分文稿后重新上传"
    );
  }
  if (omittedImageReferences > 0) {
    fail(
      "CLIENT_MANIFEST_IMAGE_INCOMPLETE",
      "Word 中的图片数量超过单篇导入上限，无法完整导入；请拆分文档后重新上传",
      { omittedImageReferences }
    );
  }
  if (unsupportedImageReferences > 0) {
    fail(
      "CLIENT_MANIFEST_IMAGE_FORMAT_UNSUPPORTED",
      "Word 中有无法导入的图片格式，请转换为 JPG、PNG、GIF 或 WebP 后重新上传",
      { unsupportedImageReferences }
    );
  }

  const rawCharacterCount = rawBlocks.reduce(
    (sum, block) => sum + (
      block && typeof block.text === "string" ? block.text.length : 0
    ),
    0
  );
  const normalizedImageReferenceCount = normalizedBlocks.reduce(
    (sum, block) => sum + block.images.length,
    0
  );
  if (
    extractedBlocks !== rawBlocks.length ||
    extractedCharacters !== rawCharacterCount ||
    imageCount !== images.length ||
    imageReferenceCount !== normalizedImageReferenceCount ||
    totalParagraphs <
      rawBlocks.length + skippedTableOfContentsParagraphs
  ) {
    fail(
      "CLIENT_MANIFEST_STATS_MISMATCH",
      "Word 解析结果不完整或已发生变化，请重新选择原始文档",
      { path: "stats" }
    );
  }

  return {
    extractedBlocks: normalizedBlocks.length,
    extractedCharacters: normalizedBlocks.reduce(
      (sum, block) => sum + block.text.length,
      0
    ),
    imageCount: images.length,
    imageReferenceCount: normalizedImageReferenceCount,
    inferredHeadingCount,
    omittedImageReferences: 0,
    skippedTableOfContentsParagraphs,
    unsupportedImageReferences: 0,
    totalParagraphs,
    truncated: false
  };
}

function normalizeClientManifest(rawManifest) {
  assertSerializedSize(rawManifest);
  assertPlainObject(rawManifest, "manifest");
  assertAllowedKeys(rawManifest, ROOT_KEYS, "manifest");
  assertNoActiveContent(rawManifest);

  if (rawManifest.schemaVersion !== CLIENT_MANIFEST_SCHEMA_VERSION) {
    fail(
      "CLIENT_MANIFEST_SCHEMA_UNSUPPORTED",
      "Word 解析格式版本不受支持，请更新小程序后重新上传",
      { supportedSchemaVersion: CLIENT_MANIFEST_SCHEMA_VERSION }
    );
  }
  if (rawManifest.sourceType !== "docx") {
    fail(
      "CLIENT_MANIFEST_SOURCE_UNSUPPORTED",
      "书稿和小专题目前仅支持 .docx 格式，请在 Word/WPS 中另存后上传"
    );
  }

  const title = normalizePlainText(rawManifest.title, "title", 120, {
    heading: true,
    required: true
  });
  const images = normalizeImages(rawManifest.images);
  const blocks = normalizeBlocks(rawManifest.blocks, images);
  if (blocks.length === 0) {
    fail(
      "CLIENT_MANIFEST_EMPTY_CONTENT",
      "这个 Word 文档没有可导入的正文或图片"
    );
  }
  const stats = normalizeStats(
    rawManifest.stats,
    rawManifest.blocks,
    blocks,
    images
  );
  const warnings = normalizeWarnings(rawManifest.warnings);

  return {
    schemaVersion: CLIENT_MANIFEST_SCHEMA_VERSION,
    sourceType: "docx",
    title,
    blocks,
    images,
    warnings,
    stats,
    security: {
      activeContentDetected: false,
      activexDetected: false,
      macrosDetected: false,
      oleObjectsDetected: false
    }
  };
}

function imageDescriptorByOrder(manifest) {
  return new Map(manifest.images.map((image) => [image.order, image]));
}

function placementFromImage(image, sourceBlockIndex, location, sequence) {
  return {
    imageOrder: image.order,
    relationId: image.relationId,
    packagePath: image.packagePath,
    extension: image.extension,
    caption: image.caption,
    sourceBlockIndex,
    sequence,
    location
  };
}

function manuscriptDraft(manifest) {
  const sections = [];
  const imagePlacements = [];
  const imagesByOrder = imageDescriptorByOrder(manifest);
  let currentSection = null;
  let paragraphCount = 0;
  let characterCount = 0;
  let hasBodyParagraph = false;
  let seenTextBlock = false;

  const ensureSection = (heading = "") => {
    if (sections.length >= MAX_MANUSCRIPT_SECTIONS) {
      fail(
        "CLIENT_MANIFEST_LIMIT_EXCEEDED",
        `单篇书稿最多支持 ${MAX_MANUSCRIPT_SECTIONS} 个正文分节，请拆分后上传`,
        { limit: MAX_MANUSCRIPT_SECTIONS }
      );
    }
    currentSection = { kind: "story", heading, paragraphs: [] };
    sections.push(currentSection);
    characterCount += heading.length;
  };

  manifest.blocks.forEach((block, sourceBlockIndex) => {
    const documentTitleBlock =
      !seenTextBlock &&
      Boolean(block.text) &&
      block.text === manifest.title;

    if (block.type === "heading" && !documentTitleBlock) {
      ensureSection(normalizePlainText(
        block.text,
        `blocks[${sourceBlockIndex}].text`,
        120,
        { heading: true }
      ));
    } else if (block.text && !documentTitleBlock) {
      if (!currentSection) ensureSection("");
      if (
        currentSection.paragraphs.length >=
        MAX_MANUSCRIPT_PARAGRAPHS_PER_SECTION
      ) {
        fail(
          "CLIENT_MANIFEST_LIMIT_EXCEEDED",
          `书稿每个分节最多支持 ${MAX_MANUSCRIPT_PARAGRAPHS_PER_SECTION} 个正文段落，请增加标题分节`,
          { limit: MAX_MANUSCRIPT_PARAGRAPHS_PER_SECTION }
        );
      }
      currentSection.paragraphs.push(block.text);
      paragraphCount += 1;
      characterCount += block.text.length;
      hasBodyParagraph = true;
    }

    if (block.images.length > 0 && !currentSection) {
      ensureSection("");
    }
    block.images.forEach((imageOrder, sequence) => {
      const image = imagesByOrder.get(imageOrder);
      characterCount += image.caption.length;
      imagePlacements.push(placementFromImage(
        image,
        sourceBlockIndex,
        {
          kind: "manuscript-section",
          sectionIndex: sections.length - 1,
          afterParagraphIndex: currentSection.paragraphs.length - 1
        },
        sequence
      ));
    });

    if (block.text) {
      seenTextBlock = true;
    }
  });

  if (!hasBodyParagraph) {
    fail(
      "CLIENT_MANIFEST_EMPTY_CONTENT",
      "书稿中没有可发布的正文段落，请检查 Word 标题和正文样式"
    );
  }
  if (
    characterCount > MAX_MANUSCRIPT_CHARACTERS ||
    manifest.stats.extractedCharacters > MAX_MANUSCRIPT_CHARACTERS
  ) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      `单篇书稿正文最多支持 ${MAX_MANUSCRIPT_CHARACTERS} 个字符，请拆分后上传`,
      { limit: MAX_MANUSCRIPT_CHARACTERS }
    );
  }

  return {
    draftPayload: {
      title: manifest.title,
      subtitle: "",
      sourceLabel: "管理员 Word 导入",
      department: "",
      catalogViews: ["book"],
      sortOrder: 0,
      coverFileID: "",
      disclaimer: "",
      sections,
      structureConfirmed: false
    },
    imagePlacements,
    importStats: {
      sections: sections.length,
      paragraphs: paragraphCount,
      characters: characterCount,
      images: imagePlacements.length
    }
  };
}

function specialTopicDraft(manifest) {
  const entries = [];
  const imagePlacements = [];
  const imagesByOrder = imageDescriptorByOrder(manifest);
  let currentEntry = null;
  let logicalBlockCount = 0;
  let characterCount = 0;
  let seenTextBlock = false;
  const entryLogicalBlockCounts = [];
  const headingLevels = manifest.blocks
    .filter((block) => block.type === "heading" && block.text)
    .map((block) => block.level);
  const primaryHeadingLevel = headingLevels.length > 0
    ? Math.min(...headingLevels)
    : 0;

  const ensureEntry = () => {
    if (currentEntry) return currentEntry;
    if (entries.length >= MAX_TOPIC_ENTRIES) {
      fail(
        "CLIENT_MANIFEST_LIMIT_EXCEEDED",
        `单个小专题最多支持 ${MAX_TOPIC_ENTRIES} 个目录条目，请拆分后上传`,
        { limit: MAX_TOPIC_ENTRIES }
      );
    }
    currentEntry = {
      sortOrder: (entries.length + 1) * 10,
      blocks: []
    };
    entries.push(currentEntry);
    entryLogicalBlockCounts.push(0);
    return currentEntry;
  };

  const startEntry = () => {
    currentEntry = null;
    return ensureEntry();
  };

  const assertEntryCapacity = (additional = 1) => {
    ensureEntry();
    const entryIndex = entries.length - 1;
    if (
      entryLogicalBlockCounts[entryIndex] + additional >
      MAX_TOPIC_BLOCKS_PER_ENTRY
    ) {
      fail(
        "CLIENT_MANIFEST_LIMIT_EXCEEDED",
        `小专题每个目录条目最多支持 ${MAX_TOPIC_BLOCKS_PER_ENTRY} 个图文块，请增加一级标题分条`,
        { limit: MAX_TOPIC_BLOCKS_PER_ENTRY }
      );
    }
    entryLogicalBlockCounts[entryIndex] += additional;
  };

  manifest.blocks.forEach((block, sourceBlockIndex) => {
    const documentTitleBlock =
      !seenTextBlock &&
      Boolean(block.text) &&
      block.text === manifest.title;

    if (
      !documentTitleBlock &&
      block.type === "heading" &&
      block.level === primaryHeadingLevel
    ) {
      startEntry();
    }

    if (block.text && !documentTitleBlock) {
      assertEntryCapacity();
      const entry = ensureEntry();
      entry.blocks.push({
        type: block.type === "heading" ? "heading" : "text",
        text: block.text
      });
      logicalBlockCount += 1;
      characterCount += block.text.length;
    }

    block.images.forEach((imageOrder, sequence) => {
      assertEntryCapacity();
      const entry = ensureEntry();
      const image = imagesByOrder.get(imageOrder);
      characterCount += image.caption.length;
      imagePlacements.push(placementFromImage(
        image,
        sourceBlockIndex,
        {
          kind: "special-topic-entry",
          entryIndex: entries.length - 1,
          insertAtBlockIndex: entry.blocks.length
        },
        sequence
      ));
      logicalBlockCount += 1;
    });

    if (block.text) {
      seenTextBlock = true;
    }
  });

  if (logicalBlockCount === 0) {
    fail(
      "CLIENT_MANIFEST_EMPTY_CONTENT",
      "小专题中没有可导入的图文内容"
    );
  }
  if (logicalBlockCount > MAX_TOPIC_BLOCKS) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      `单个小专题最多支持 ${MAX_TOPIC_BLOCKS} 个图文块，请拆分后上传`,
      { limit: MAX_TOPIC_BLOCKS }
    );
  }
  if (
    characterCount > MAX_TOPIC_CHARACTERS ||
    manifest.stats.extractedCharacters > MAX_TOPIC_CHARACTERS
  ) {
    fail(
      "CLIENT_MANIFEST_LIMIT_EXCEEDED",
      `单个小专题正文最多支持 ${MAX_TOPIC_CHARACTERS} 个字符，请拆分后上传`,
      { limit: MAX_TOPIC_CHARACTERS }
    );
  }

  return {
    draftPayload: {
      title: manifest.title,
      summary: "",
      producer: "",
      unlockCostStars: 0,
      sortOrder: 0,
      previewCoverFileID: "",
      entries,
      structureConfirmed: false
    },
    imagePlacements,
    importStats: {
      entries: entries.length,
      blocks: logicalBlockCount,
      characters: characterCount,
      images: imagePlacements.length
    }
  };
}

function validateAndConvertClientManifest(assetType, rawManifest) {
  if (!SUPPORTED_ASSET_TYPES.has(assetType)) {
    fail(
      "CLIENT_MANIFEST_ASSET_TYPE_UNSUPPORTED",
      "Word 自动解析目前只支持书稿和小专题",
      { assetType: typeof assetType === "string" ? assetType : "" }
    );
  }

  const normalizedManifest = normalizeClientManifest(rawManifest);
  const canonicalBytes = assertCanonicalSize(normalizedManifest);
  const converted = assetType === "manuscript"
    ? manuscriptDraft(normalizedManifest)
    : specialTopicDraft(normalizedManifest);
  const manifestSha256 = clientManifestSha256(normalizedManifest);

  return {
    assetType,
    clientDraftPayload: converted.draftPayload,
    imagePlacements: converted.imagePlacements,
    importStats: converted.importStats,
    manifestSha256,
    hashScope: CLIENT_MANIFEST_HASH_SCOPE,
    manifestMeta: {
      schemaVersion: normalizedManifest.schemaVersion,
      sourceType: normalizedManifest.sourceType,
      title: normalizedManifest.title,
      warnings: normalizedManifest.warnings,
      stats: normalizedManifest.stats,
      security: normalizedManifest.security,
      canonicalBytes,
      hashAlgorithm: "sha256"
    },
    manifestFingerprint: {
      algorithm: "sha256",
      scope: CLIENT_MANIFEST_HASH_SCOPE,
      value: manifestSha256
    }
  };
}

module.exports = {
  MAX_CANONICAL_MANIFEST_BYTES,
  CLIENT_MANIFEST_HASH_SCOPE,
  CLIENT_MANIFEST_SCHEMA_VERSION,
  ClientManifestError,
  canonicalManifestBytes,
  canonicalStringifyManifest,
  clientManifestSha256,
  normalizeClientManifest,
  validateAndConvertClientManifest
};
