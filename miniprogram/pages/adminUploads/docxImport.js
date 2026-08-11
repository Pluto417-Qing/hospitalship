const CORE_ENTRY_REQUESTS = Object.freeze([
  { path: "[Content_Types].xml", encoding: "utf-8" },
  { path: "_rels/.rels", encoding: "utf-8" },
  { path: "word/document.xml", encoding: "utf-8" },
  { path: "word/_rels/document.xml.rels", encoding: "utf-8" }
]);

const MAX_BLOCKS = 5000;
const MAX_CHARACTERS = 1000000;
const MAX_IMAGES = 200;
const MAX_PARAGRAPH_CHARACTERS = 8000;
const SAFE_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp"
]);

function isBinaryEntryData(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return true;
  }
  return Boolean(
    typeof ArrayBuffer !== "undefined" &&
    (
      value instanceof ArrayBuffer ||
      (
        typeof ArrayBuffer.isView === "function" &&
        ArrayBuffer.isView(value)
      )
    )
  );
}

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function decodeXmlEntities(value) {
  return String(value || "").replace(
    /&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|([A-Za-z]+));/g,
    (entity, decimal, hexadecimal, named) => {
      if (decimal || hexadecimal) {
        const codePoint = parseInt(decimal || hexadecimal, decimal ? 10 : 16);
        if (
          !Number.isInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "";
        }
        try {
          return String.fromCodePoint(codePoint);
        } catch (error) {
          return "";
        }
      }

      const entities = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: "\""
      };
      return entities[named] || entity;
    }
  );
}

function parseXmlAttributes(fragment) {
  const attributes = {};
  const expression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = expression.exec(String(fragment || "")))) {
    attributes[match[1]] = decodeXmlEntities(
      match[2] === undefined ? match[3] : match[2]
    );
  }

  return attributes;
}

function packageExtension(value) {
  const path = String(value || "").toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function normalizePackageTarget(baseDirectory, target) {
  const raw = String(target || "").replace(/\\/g, "/");

  if (
    !raw ||
    raw.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return "";
  }

  const output = String(baseDirectory || "")
    .split("/")
    .filter(Boolean);
  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (output.length === 0) {
        return "";
      }
      output.pop();
      continue;
    }
    output.push(part);
  }

  return output.join("/");
}

function parseRelationships(xml, baseDirectory = "word") {
  const byId = {};
  const external = [];
  const expression = /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g;
  let match;

  while ((match = expression.exec(String(xml || "")))) {
    const attributes = parseXmlAttributes(match[1]);
    const id = normalizeText(attributes.Id, 128);
    const targetMode = normalizeText(attributes.TargetMode, 32).toLowerCase();
    const target = normalizeText(attributes.Target, 1024);
    const type = normalizeText(attributes.Type, 1024);

    if (!id || !target) {
      continue;
    }
    if (targetMode === "external") {
      external.push({ id, target, type });
      continue;
    }

    const path = normalizePackageTarget(baseDirectory, target);
    if (path) {
      byId[id] = { id, path, target, type };
    }
  }

  return { byId, external };
}

function headingLevel(styleId) {
  const value = String(styleId || "").replace(/\s+/g, "");
  const match =
    /^(?:heading|标题)([1-9])$/i.exec(value) ||
    /^([1-9])$/.exec(value);

  if (match) {
    return Number(match[1]);
  }
  return /^(?:title|标题)$/.test(value.toLowerCase()) ? 1 : 0;
}

function headingLookupKey(value) {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function tableOfContentsTitle(value) {
  return normalizeText(value)
    .replace(/\s*\t+\s*\d+\s*$/, "")
    .replace(/^\s*\d{1,4}\s*[.、．]\s*/, "")
    .trim();
}

function paragraphContent(xml, relationships) {
  let text = "";
  const imageRelationIds = [];
  const styleMatch = /<w:pStyle\b([^>]*?)\/?>/.exec(xml);
  const styleAttributes = parseXmlAttributes(styleMatch && styleMatch[1]);
  const styleId = styleAttributes["w:val"] || styleAttributes.val || "";
  const tokenExpression =
    /<w:t\b[^>]*>|<\/w:t\s*>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>|<a:blip\b[^>]*\/?>|<v:imagedata\b[^>]*\/?>|[^<]+/g;
  let insideText = false;
  let match;

  while ((match = tokenExpression.exec(String(xml || "")))) {
    const token = match[0];
    if (/^<w:t\b/.test(token)) {
      insideText = true;
      continue;
    }
    if (/^<\/w:t/.test(token)) {
      insideText = false;
      continue;
    }
    if (/^<w:tab\b/.test(token)) {
      text += "\t";
      continue;
    }
    if (/^<w:(?:br|cr)\b/.test(token)) {
      text += "\n";
      continue;
    }
    if (/^<(?:a:blip|v:imagedata)\b/.test(token)) {
      const attributes = parseXmlAttributes(token);
      const relationId =
        attributes["r:embed"] ||
        attributes["r:id"] ||
        attributes.embed ||
        attributes.id ||
        "";
      if (relationId && relationships[relationId]) {
        imageRelationIds.push(relationId);
      }
      continue;
    }
    if (insideText && token[0] !== "<") {
      text += decodeXmlEntities(token);
    }
  }

  return {
    headingLevel: headingLevel(styleId),
    imageRelationIds,
    isTableOfContentsEntry:
      /<w:instrText\b[\s\S]*?(?:\bTOC\b|\bPAGEREF\b)[\s\S]*?<\/w:instrText>/i.test(
        xml
      ),
    styleId,
    text: normalizeText(text, MAX_PARAGRAPH_CHARACTERS)
  };
}

function parseDocumentXml(xml, relationshipResult, options = {}) {
  const relationships =
    relationshipResult && relationshipResult.byId
      ? relationshipResult.byId
      : {};
  const maximumBlocks = Math.min(
    MAX_BLOCKS,
    Math.max(1, Number(options.maximumBlocks) || MAX_BLOCKS)
  );
  const maximumCharacters = Math.min(
    MAX_CHARACTERS,
    Math.max(1000, Number(options.maximumCharacters) || MAX_CHARACTERS)
  );
  const maximumImages = Math.min(
    MAX_IMAGES,
    Math.max(0, Number(options.maximumImages) || MAX_IMAGES)
  );
  const blocks = [];
  const images = [];
  const imageByPath = new Map();
  let characters = 0;
  let totalParagraphs = 0;
  let imageReferenceCount = 0;
  let omittedImageReferences = 0;
  let skippedTableOfContentsParagraphs = 0;
  let unsupportedImageReferences = 0;
  let truncated = false;
  let title = "";
  const sourceXml = String(xml || "");
  const tableOfContentsTitles = new Set();
  const paragraphExpression = /<w:p(?=[\s>])[\s\S]*?<\/w:p>/g;
  let preliminaryMatch;

  while ((preliminaryMatch = paragraphExpression.exec(sourceXml))) {
    const paragraph = paragraphContent(preliminaryMatch[0], relationships);
    if (paragraph.isTableOfContentsEntry && paragraph.text) {
      const tocTitle = tableOfContentsTitle(paragraph.text);
      const lookupKey = headingLookupKey(tocTitle);
      if (lookupKey) {
        tableOfContentsTitles.add(lookupKey);
      }
    }
  }

  let inferredHeadingLevel = 1;
  const matchingHeadingLevels = [];
  paragraphExpression.lastIndex = 0;
  while ((preliminaryMatch = paragraphExpression.exec(sourceXml))) {
    const paragraph = paragraphContent(preliminaryMatch[0], relationships);
    if (
      !paragraph.isTableOfContentsEntry &&
      paragraph.headingLevel > 0 &&
      tableOfContentsTitles.has(headingLookupKey(paragraph.text))
    ) {
      matchingHeadingLevels.push(paragraph.headingLevel);
    }
  }
  if (matchingHeadingLevels.length > 0) {
    const counts = new Map();
    matchingHeadingLevels.forEach((level) => {
      counts.set(level, (counts.get(level) || 0) + 1);
    });
    inferredHeadingLevel = Array.from(counts.entries())
      .sort((left, right) =>
        right[1] === left[1] ? left[0] - right[0] : right[1] - left[1]
      )[0][0];
  }

  let inferredHeadingCount = 0;
  const expression = /<w:p(?=[\s>])[\s\S]*?<\/w:p>/g;
  let match;

  while ((match = expression.exec(sourceXml))) {
    totalParagraphs += 1;
    const paragraph = paragraphContent(match[0], relationships);
    const paragraphImages = [];

    if (
      paragraph.isTableOfContentsEntry ||
      (
        paragraph.imageRelationIds.length === 0 &&
        paragraph.text.replace(/\s+/g, "") === "目录"
      )
    ) {
      skippedTableOfContentsParagraphs += 1;
      continue;
    }

    for (const relationId of paragraph.imageRelationIds) {
      imageReferenceCount += 1;
      const relation = relationships[relationId];
      const extension = packageExtension(relation && relation.path);
      if (!relation || !SAFE_IMAGE_EXTENSIONS.has(extension)) {
        unsupportedImageReferences += 1;
        continue;
      }

      let image = imageByPath.get(relation.path);
      if (!image) {
        if (images.length >= maximumImages) {
          omittedImageReferences += 1;
          continue;
        }
        image = {
          relationId,
          packagePath: relation.path,
          extension,
          order: images.length + 1
        };
        imageByPath.set(relation.path, image);
        images.push(image);
      }
      paragraphImages.push(image);
    }

    if (!paragraph.text && paragraphImages.length === 0) {
      continue;
    }
    if (
      blocks.length >= maximumBlocks ||
      characters + paragraph.text.length > maximumCharacters
    ) {
      truncated = true;
      break;
    }

    let effectiveHeadingLevel = paragraph.headingLevel;
    if (
      effectiveHeadingLevel === 0 &&
      paragraph.text &&
      tableOfContentsTitles.has(headingLookupKey(paragraph.text))
    ) {
      effectiveHeadingLevel = inferredHeadingLevel;
      inferredHeadingCount += 1;
    }

    const block = {
      type: effectiveHeadingLevel > 0 ? "heading" : "paragraph",
      text: paragraph.text
    };
    if (effectiveHeadingLevel > 0) {
      block.level = effectiveHeadingLevel;
    }
    if (paragraphImages.length > 0) {
      block.images = paragraphImages.map((image) => image.order);
    }
    blocks.push(block);
    characters += paragraph.text.length;

    if (!title && paragraph.text) {
      title = normalizeText(paragraph.text, 120);
    }
  }

  if (!title) {
    title = "未命名文稿";
  }

  return {
    blocks,
    images,
    stats: {
      extractedBlocks: blocks.length,
      extractedCharacters: characters,
      imageCount: images.length,
      imageReferenceCount,
      inferredHeadingCount,
      omittedImageReferences,
      skippedTableOfContentsParagraphs,
      unsupportedImageReferences,
      totalParagraphs,
      truncated
    },
    title
  };
}

function containsUnsafeOfficeContent(contentTypesXml, relationshipsXml = "") {
  const value = `${String(contentTypesXml || "")}\n${String(
    relationshipsXml || ""
  )}`.toLowerCase();
  return (
    value.includes("macroenabled") ||
    value.includes("vbaproject") ||
    value.includes("activex") ||
    value.includes("oleobject") ||
    value.includes("/relationships/package")
  );
}

function entryData(result, path, required) {
  const entries =
    result && result.entries && typeof result.entries === "object"
      ? result.entries
      : {};
  const item = entries[path];
  const data = item && item.data;

  if (typeof data === "string" || isBinaryEntryData(data)) {
    return data;
  }
  if (required) {
    const nativeErrorMessage =
      item && typeof item.errMsg === "string" ? item.errMsg.trim() : "";
    const error = new Error(
      nativeErrorMessage && !/:ok$/i.test(nativeErrorMessage)
        ? `DOCX 内容读取失败：${path}`
        : `DOCX 缺少必要内容：${path}`
    );
    error.code =
      nativeErrorMessage && !/:ok$/i.test(nativeErrorMessage)
        ? "DOCX_ENTRY_READ_FAILED"
        : "DOCX_ENTRY_MISSING";
    error.entryPath = path;
    error.nativeErrorMessage = nativeErrorMessage;
    error.dataType = Object.prototype.toString.call(data);
    throw error;
  }
  return "";
}

function readZipEntries(fileSystem, filePath, entries) {
  return new Promise((resolve, reject) => {
    if (!fileSystem || typeof fileSystem.readZipEntry !== "function") {
      const error = new Error("当前微信版本过低，无法自动读取 Word 文稿，请升级微信后重试");
      error.code = "DOCX_READER_UNAVAILABLE";
      reject(error);
      return;
    }

    fileSystem.readZipEntry({
      filePath,
      entries,
      success: resolve,
      fail: (error) => {
        const wrapped = new Error("无法读取这个 Word 文件，请确认文件未损坏且格式为 .docx");
        wrapped.code = "DOCX_READ_FAILED";
        wrapped.cause = error;
        reject(wrapped);
      }
    });
  });
}

async function analyzeDocx(filePath, options = {}) {
  const runtimeWx = options.wx || (typeof wx !== "undefined" ? wx : null);
  const fileSystem =
    options.fileSystem ||
    (runtimeWx && typeof runtimeWx.getFileSystemManager === "function"
      ? runtimeWx.getFileSystemManager()
      : null);
  const firstRead = await readZipEntries(
    fileSystem,
    filePath,
    CORE_ENTRY_REQUESTS
  );
  const contentTypes = entryData(firstRead, "[Content_Types].xml", true);
  const rootRelationshipsXml = entryData(firstRead, "_rels/.rels", true);
  const documentXml = entryData(firstRead, "word/document.xml", true);
  const documentRelationshipsXml = entryData(
    firstRead,
    "word/_rels/document.xml.rels",
    false
  );

  if (
    containsUnsafeOfficeContent(
      contentTypes,
      documentRelationshipsXml
    )
  ) {
    const error = new Error("该 Word 文件包含宏或嵌入程序，请另存为普通 .docx 后再上传");
    error.code = "DOCX_ACTIVE_CONTENT";
    throw error;
  }

  const rootRelationships = parseRelationships(rootRelationshipsXml, "");
  const officeDocument = Object.values(rootRelationships.byId).find((item) =>
    /\/officeDocument$/i.test(item.type)
  );
  if (!officeDocument || officeDocument.path !== "word/document.xml") {
    const error = new Error("这个文件不是标准 Word 文稿，请在 Word 或 WPS 中另存为 .docx");
    error.code = "DOCX_STRUCTURE_INVALID";
    throw error;
  }

  const relationships = parseRelationships(
    documentRelationshipsXml,
    "word"
  );
  const parsed = parseDocumentXml(documentXml, relationships, options);
  const warnings = [];

  if (relationships.external.length > 0) {
    warnings.push("文稿中的外部链接不会自动带入小程序正文");
  }
  if (parsed.stats.truncated) {
    warnings.push("文稿内容超过单篇导入上限，已停止导入；发布前需要拆分文稿");
  }
  if (parsed.stats.unsupportedImageReferences > 0) {
    warnings.push(
      "文稿中含有暂不支持的图片格式，请在 Word 中改为 JPG、PNG、GIF 或 WEBP 后重新上传"
    );
  }
  if (parsed.stats.omittedImageReferences > 0) {
    warnings.push("文稿中的图片数量超过导入上限，请拆分文稿后重新上传");
  }

  return {
    schemaVersion: 1,
    sourceType: "docx",
    title: parsed.title,
    blocks: parsed.blocks,
    images: parsed.images,
    warnings,
    stats: parsed.stats
  };
}

async function readDocxImage(filePath, packagePath, options = {}) {
  const normalizedPath = normalizePackageTarget("", packagePath);
  if (
    !normalizedPath ||
    !normalizedPath.startsWith("word/media/") ||
    !SAFE_IMAGE_EXTENSIONS.has(packageExtension(normalizedPath))
  ) {
    const error = new Error("Word 内嵌图片路径无效");
    error.code = "DOCX_IMAGE_PATH_INVALID";
    throw error;
  }

  const runtimeWx = options.wx || (typeof wx !== "undefined" ? wx : null);
  const fileSystem =
    options.fileSystem ||
    (runtimeWx && typeof runtimeWx.getFileSystemManager === "function"
      ? runtimeWx.getFileSystemManager()
      : null);
  const result = await readZipEntries(fileSystem, filePath, [
    { path: normalizedPath }
  ]);
  return entryData(result, normalizedPath, true);
}

module.exports = {
  CORE_ENTRY_REQUESTS,
  analyzeDocx,
  decodeXmlEntities,
  normalizePackageTarget,
  parseDocumentXml,
  parseRelationships,
  parseXmlAttributes,
  readDocxImage,
  containsUnsafeOfficeContent
};
