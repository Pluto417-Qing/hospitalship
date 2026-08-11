const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const contentSeedDirectory = path.join(
  projectRoot,
  "seed-data",
  "content-seeds"
);
const audioSeedDirectory = path.join(
  projectRoot,
  "seed-data",
  "audio-seeds"
);
const bookSeedDirectory = path.join(
  projectRoot,
  "seed-data",
  "book-seeds"
);
const bookChapterSeedDirectory = path.join(
  projectRoot,
  "seed-data",
  "book-chapter-seeds"
);
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VALID_STATUSES = new Set(["draft", "review", "published"]);
const VALID_CATALOG_VIEWS = new Set(["book", "summary"]);
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;

function fail(filePath, message) {
  const relativePath = path.relative(projectRoot, filePath);
  throw new Error(`${relativePath}: ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(filePath, `JSON 读取失败：${error.message}`);
  }
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function requireText(value, filePath, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    fail(filePath, `${fieldName} 必须是非空字符串`);
  }

  return value.trim();
}

function resolveSourceAsset(source, filePath) {
  if (!source || typeof source !== "object") {
    fail(filePath, "source 缺失");
  }

  const relativeAsset = requireText(source.asset, filePath, "source.asset");
  const absoluteAsset = path.resolve(projectRoot, relativeAsset);
  const rootPrefix = `${projectRoot}${path.sep}`;

  if (!absoluteAsset.startsWith(rootPrefix)) {
    fail(filePath, "source.asset 不得指向项目目录之外");
  }

  if (!fs.existsSync(absoluteAsset) || !fs.statSync(absoluteAsset).isFile()) {
    fail(filePath, `source.asset 不存在：${relativeAsset}`);
  }

  const expectedHash = requireText(source.sha256, filePath, "source.sha256")
    .toLowerCase();

  if (!SHA256_PATTERN.test(expectedHash)) {
    fail(filePath, "source.sha256 格式不正确");
  }

  const actualHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(absoluteAsset))
    .digest("hex");

  if (actualHash !== expectedHash) {
    fail(filePath, `源文件 SHA-256 不匹配：${relativeAsset}`);
  }

  if (
    Object.prototype.hasOwnProperty.call(source, "bytes") &&
    Number(source.bytes) !== fs.statSync(absoluteAsset).size
  ) {
    fail(filePath, `源文件字节数不匹配：${relativeAsset}`);
  }

  return relativeAsset;
}

function validateBaseSeed(seed, filePath, seedType) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    fail(filePath, "种子文件根节点必须是对象");
  }

  if (seed.schemaVersion !== 1) {
    fail(filePath, "schemaVersion 必须为 1");
  }

  if (seed.seedType !== seedType) {
    fail(filePath, `seedType 必须为 ${seedType}`);
  }

  resolveSourceAsset(seed.source, filePath);

  if (!seed.document || typeof seed.document !== "object") {
    fail(filePath, "document 缺失");
  }
}

function validateSections(sections, filePath, fieldName) {
  if (!Array.isArray(sections) || sections.length === 0) {
    fail(filePath, `${fieldName} 不能为空`);
  }

  let paragraphCount = 0;
  sections.forEach((section, sectionIndex) => {
    if (Object.prototype.hasOwnProperty.call(section, "kind")) {
      requireText(
        section.kind,
        filePath,
        `${fieldName}[${sectionIndex}].kind`
      );
    }
    requireText(
      section.heading,
      filePath,
      `${fieldName}[${sectionIndex}].heading`
    );

    if (!Array.isArray(section.paragraphs) || section.paragraphs.length === 0) {
      fail(filePath, `${fieldName}[${sectionIndex}].paragraphs 不能为空`);
    }

    section.paragraphs.forEach((paragraph, paragraphIndex) => {
      requireText(
        paragraph,
        filePath,
        `${fieldName}[${sectionIndex}].paragraphs[${paragraphIndex}]`
      );
      paragraphCount += 1;
    });
  });

  return paragraphCount;
}

function validateContentSeed(seed, filePath) {
  validateBaseSeed(seed, filePath, "content");
  const document = seed.document;
  const id = requireText(document._id, filePath, "document._id");

  if (!CONTENT_ID_PATTERN.test(id) || document.contentId !== id) {
    fail(filePath, "contentId 必须与合法的 _id 完全一致");
  }

  const revision = requireText(
    document.currentRevision,
    filePath,
    "document.currentRevision"
  );
  requireText(document.title, filePath, "document.title");
  requireText(document.disclaimer, filePath, "document.disclaimer");

  if (!VALID_STATUSES.has(document.status)) {
    fail(filePath, "document.status 不合法");
  }

  if (
    !document.accessPolicy ||
    document.accessPolicy.text !== "member" ||
    document.accessPolicy.audio !== "member"
  ) {
    fail(
      filePath,
      "document.accessPolicy 必须声明正文与配音均为少年会员权限"
    );
  }

  if (
    !Number.isInteger(document.publishedAudioTrackCount) ||
    document.publishedAudioTrackCount < 0
  ) {
    fail(filePath, "document.publishedAudioTrackCount 必须是非负整数");
  }

  if (
    !Array.isArray(document.catalogViews) ||
    document.catalogViews.length === 0 ||
    document.catalogViews.some((view) => !VALID_CATALOG_VIEWS.has(view))
  ) {
    fail(filePath, "document.catalogViews 只能包含 book/summary");
  }

  const bookId = typeof document.bookId === "string"
    ? document.bookId.trim()
    : "";

  if (
    (document.catalogViews.includes("book") && !bookId) ||
    (bookId && !CONTENT_ID_PATTERN.test(bookId))
  ) {
    fail(filePath, "book 目录内容必须关联合法的 document.bookId");
  }

  const paragraphCount = validateSections(
    document.sections,
    filePath,
    "document.sections"
  );

  return {
    id,
    bookId,
    paragraphCount,
    revision,
    status: document.status,
    document
  };
}

function validateAudioSeed(seed, filePath) {
  validateBaseSeed(seed, filePath, "audioTrack");
  const document = seed.document;
  const id = requireText(document._id, filePath, "document._id");
  const contentId = requireText(
    document.contentId,
    filePath,
    "document.contentId"
  );
  const contentRevision = requireText(
    document.contentRevision,
    filePath,
    "document.contentRevision"
  );

  if (!CONTENT_ID_PATTERN.test(contentId)) {
    fail(filePath, "document.contentId 不合法");
  }

  requireText(document.title, filePath, "document.title");
  requireText(document.narrator, filePath, "document.narrator");
  requireText(document.mimeType, filePath, "document.mimeType");

  if (!String(document.mimeType).startsWith("audio/")) {
    fail(filePath, "document.mimeType 必须是 audio/*");
  }

  if (!Number.isFinite(document.durationSeconds) || document.durationSeconds <= 0) {
    fail(filePath, "document.durationSeconds 必须大于 0");
  }

  if (!Number.isInteger(document.trackNo) || document.trackNo < 1) {
    fail(filePath, "document.trackNo 必须是正整数");
  }

  if (!VALID_STATUSES.has(document.status)) {
    fail(filePath, "document.status 不合法");
  }

  if (Object.prototype.hasOwnProperty.call(document, "fileID")) {
    fail(filePath, "仓库种子不得写入 fileID，请在部署时通过环境变量提供");
  }

  const fileIDEnvironmentVariable = requireText(
    document.fileIDEnvironmentVariable,
    filePath,
    "document.fileIDEnvironmentVariable"
  );

  if (!ENVIRONMENT_VARIABLE_PATTERN.test(fileIDEnvironmentVariable)) {
    fail(filePath, "document.fileIDEnvironmentVariable 格式不正确");
  }

  return {
    contentId,
    contentRevision,
    id,
    status: document.status
  };
}

function validateBookSeed(seed, filePath) {
  validateBaseSeed(seed, filePath, "book");
  const document = seed.document;
  const sourceScope = requireText(
    seed.source.scope,
    filePath,
    "source.scope"
  );

  if (!["complete-book", "chapter-source-only"].includes(sourceScope)) {
    fail(filePath, "source.scope 必须说明是整书还是章节来源");
  }

  if (sourceScope === "chapter-source-only") {
    requireText(seed.source.note, filePath, "source.note");
  }

  const id = requireText(document._id, filePath, "document._id");

  if (!CONTENT_ID_PATTERN.test(id) || document.bookId !== id) {
    fail(filePath, "bookId 必须与合法的 _id 完全一致");
  }

  const revision = requireText(
    document.currentRevision,
    filePath,
    "document.currentRevision"
  );
  requireText(document.title, filePath, "document.title");

  if (!VALID_STATUSES.has(document.status)) {
    fail(filePath, "document.status 不合法");
  }

  const reviewStatus = requireText(
    document.reviewStatus,
    filePath,
    "document.reviewStatus"
  );

  if (document.status === "published" && reviewStatus !== "approved") {
    fail(filePath, "未审核整书不得标记为 published");
  }

  if (document.status === "published" && sourceScope !== "complete-book") {
    fail(filePath, "只有章节来源的整书种子不得发布");
  }

  if (
    !Number.isInteger(document.chapterCount) ||
    document.chapterCount < 1
  ) {
    fail(filePath, "document.chapterCount 必须是正整数");
  }

  if (
    !Array.isArray(document.sourceContentIds) ||
    document.sourceContentIds.length === 0
  ) {
    fail(filePath, "document.sourceContentIds 不能为空");
  }

  const sourceContentIds = document.sourceContentIds.map(
    (contentId, index) => {
      const normalizedId = requireText(
        contentId,
        filePath,
        `document.sourceContentIds[${index}]`
      );

      if (!CONTENT_ID_PATTERN.test(normalizedId)) {
        fail(filePath, `document.sourceContentIds[${index}] 不合法`);
      }

      return normalizedId;
    }
  );

  if (new Set(sourceContentIds).size !== sourceContentIds.length) {
    fail(filePath, "document.sourceContentIds 不得重复");
  }

  const pdf = document.pdf;

  if (!pdf || typeof pdf !== "object" || Array.isArray(pdf)) {
    fail(filePath, "document.pdf 缺失");
  }

  if (Object.prototype.hasOwnProperty.call(pdf, "fileID")) {
    fail(
      filePath,
      "仓库整书种子不得写入 fileID，请在部署时注入"
    );
  }

  const cloudPath = requireText(
    pdf.cloudPath,
    filePath,
    "document.pdf.cloudPath"
  );
  const expectedPrefix = `protected/books/${id}/${revision}/`;

  if (
    !cloudPath.startsWith(expectedPrefix) ||
    cloudPath.length <= expectedPrefix.length ||
    cloudPath.includes("..") ||
    /[\\\s\u0000-\u001f]/.test(cloudPath)
  ) {
    fail(
      filePath,
      `document.pdf.cloudPath 必须位于 ${expectedPrefix}`
    );
  }

  if (
    requireText(pdf.mimeType, filePath, "document.pdf.mimeType") !==
    "application/pdf"
  ) {
    fail(filePath, "document.pdf.mimeType 必须为 application/pdf");
  }

  requireText(pdf.fileName, filePath, "document.pdf.fileName");
  const fileIDEnvironmentVariable = requireText(
    pdf.fileIDEnvironmentVariable,
    filePath,
    "document.pdf.fileIDEnvironmentVariable"
  );

  if (!ENVIRONMENT_VARIABLE_PATTERN.test(fileIDEnvironmentVariable)) {
    fail(filePath, "document.pdf.fileIDEnvironmentVariable 格式不正确");
  }

  if (pdf.deploymentStatus !== "pending-upload") {
    fail(filePath, "未部署 PDF 必须标记为 pending-upload");
  }

  if (pdf.requiredArtifact !== "reviewed-complete-book-pdf") {
    fail(filePath, "document.pdf 必须要求上传已复审的完整书稿 PDF");
  }

  return {
    chapterCount: document.chapterCount,
    document,
    id,
    revision,
    sourceContentIds,
    sourceScope,
    status: document.status
  };
}

function validateBookChapterSeed(seed, filePath) {
  validateBaseSeed(seed, filePath, "bookChapter");
  const document = seed.document;
  const id = requireText(document._id, filePath, "document._id");
  const bookId = requireText(document.bookId, filePath, "document.bookId");
  const bookRevision = requireText(
    document.bookRevision,
    filePath,
    "document.bookRevision"
  );
  const sourceContentId = requireText(
    document.sourceContentId,
    filePath,
    "document.sourceContentId"
  );
  const sourceContentRevision = requireText(
    document.sourceContentRevision,
    filePath,
    "document.sourceContentRevision"
  );

  if (
    !CONTENT_ID_PATTERN.test(id) ||
    !CONTENT_ID_PATTERN.test(bookId) ||
    !CONTENT_ID_PATTERN.test(sourceContentId)
  ) {
    fail(filePath, "章节、整书或源内容 ID 不合法");
  }

  requireText(document.title, filePath, "document.title");

  if (!Number.isFinite(document.sortOrder)) {
    fail(filePath, "document.sortOrder 必须是数字");
  }

  if (!VALID_STATUSES.has(document.status)) {
    fail(filePath, "document.status 不合法");
  }

  const reviewStatus = requireText(
    document.reviewStatus,
    filePath,
    "document.reviewStatus"
  );

  if (document.status === "published" && reviewStatus !== "approved") {
    fail(filePath, "未审核章节不得标记为 published");
  }

  if (!Array.isArray(document.sections) || document.sections.length > 40) {
    fail(filePath, "document.sections 必须包含 1 至 40 个分节");
  }

  let totalCharacters = 0;
  document.sections.forEach((section, sectionIndex) => {
    const heading = requireText(
      section.heading,
      filePath,
      `document.sections[${sectionIndex}].heading`
    );
    const paragraphs = section.paragraphs;

    if (
      !Array.isArray(paragraphs) ||
      paragraphs.length === 0 ||
      paragraphs.length > 100
    ) {
      fail(
        filePath,
        `document.sections[${sectionIndex}].paragraphs 必须包含 1 至 100 段`
      );
    }

    totalCharacters += heading.length;
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const normalizedParagraph = requireText(
        paragraph,
        filePath,
        `document.sections[${sectionIndex}].paragraphs[${paragraphIndex}]`
      );

      if (normalizedParagraph.length > 10000) {
        fail(
          filePath,
          `document.sections[${sectionIndex}].paragraphs[${paragraphIndex}] 超过 10000 字`
        );
      }

      totalCharacters += normalizedParagraph.length;
    });
  });

  if (totalCharacters > 120000) {
    fail(filePath, "单章内容超过 getFullBookAccess 的 120000 字限制");
  }

  const paragraphCount = validateSections(
    document.sections,
    filePath,
    "document.sections"
  );

  return {
    bookId,
    bookRevision,
    document,
    id,
    paragraphCount,
    sourceContentId,
    sourceContentRevision,
    status: document.status
  };
}

function validateSeeds() {
  const contentFiles = listJsonFiles(contentSeedDirectory);
  const audioFiles = listJsonFiles(audioSeedDirectory);
  const bookFiles = listJsonFiles(bookSeedDirectory);
  const bookChapterFiles = listJsonFiles(bookChapterSeedDirectory);

  if (contentFiles.length === 0) {
    throw new Error("没有找到内容种子");
  }

  const contents = contentFiles.map((filePath) => ({
    filePath,
    ...validateContentSeed(readJson(filePath), filePath)
  }));
  const audios = audioFiles.map((filePath) => ({
    filePath,
    ...validateAudioSeed(readJson(filePath), filePath)
  }));
  const books = bookFiles.map((filePath) => ({
    filePath,
    ...validateBookSeed(readJson(filePath), filePath)
  }));
  const bookChapters = bookChapterFiles.map((filePath) => ({
    filePath,
    ...validateBookChapterSeed(readJson(filePath), filePath)
  }));
  const revisionKeys = new Set();
  const contentByRevision = new Map();
  const bookById = new Map();

  contents.forEach((content) => {
    const key = `${content.id}@${content.revision}`;

    if (revisionKeys.has(key)) {
      fail(content.filePath, `内容版本重复：${key}`);
    }

    revisionKeys.add(key);
    contentByRevision.set(key, content);
  });

  audios.forEach((audio) => {
    const key = `${audio.contentId}@${audio.contentRevision}`;

    if (!revisionKeys.has(key)) {
      fail(audio.filePath, `找不到匹配的内容版本：${key}`);
    }
  });

  books.forEach((book) => {
    if (bookById.has(book.id)) {
      fail(book.filePath, `整书 ID 重复：${book.id}`);
    }

    bookById.set(book.id, book);
  });

  contents.forEach((content) => {
    if (!content.bookId) {
      return;
    }

    const book = bookById.get(content.bookId);

    if (!book) {
      fail(content.filePath, `找不到关联整书：${content.bookId}`);
    }

    if (!book.sourceContentIds.includes(content.id)) {
      fail(
        content.filePath,
        `整书 ${content.bookId} 未声明源内容 ${content.id}`
      );
    }
  });

  books.forEach((book) => {
    book.sourceContentIds.forEach((contentId) => {
      const linkedContent = contents.find((content) => content.id === contentId);

      if (!linkedContent || linkedContent.bookId !== book.id) {
        fail(
          book.filePath,
          `源内容 ${contentId} 未反向关联整书 ${book.id}`
        );
      }
    });
  });

  const chapterIds = new Set();
  bookChapters.forEach((chapter) => {
    if (chapterIds.has(chapter.id)) {
      fail(chapter.filePath, `整书章节 ID 重复：${chapter.id}`);
    }

    chapterIds.add(chapter.id);
    const book = bookById.get(chapter.bookId);

    if (!book || book.revision !== chapter.bookRevision) {
      fail(
        chapter.filePath,
        `找不到匹配的整书版本：${chapter.bookId}@${chapter.bookRevision}`
      );
    }

    if (
      (book.status === "published" && chapter.status !== "published") ||
      (book.status !== "published" && chapter.status === "published")
    ) {
      fail(chapter.filePath, "整书与章节不得留下半发布状态");
    }

    const sourceKey = `${chapter.sourceContentId}@${chapter.sourceContentRevision}`;
    const sourceContent = contentByRevision.get(sourceKey);

    if (!sourceContent || sourceContent.bookId !== chapter.bookId) {
      fail(chapter.filePath, `找不到匹配的源内容：${sourceKey}`);
    }

    if (!book.sourceContentIds.includes(chapter.sourceContentId)) {
      fail(
        chapter.filePath,
        `章节源内容 ${chapter.sourceContentId} 未记录在整书中`
      );
    }

    if (
      JSON.stringify(chapter.document.sections) !==
      JSON.stringify(sourceContent.document.sections)
    ) {
      fail(
        chapter.filePath,
        `章节未如实映射源内容 ${sourceKey} 的 sections`
      );
    }
  });

  books.forEach((book) => {
    const actualChapterCount = bookChapters.filter(
      (chapter) =>
        chapter.bookId === book.id && chapter.bookRevision === book.revision
    ).length;

    if (actualChapterCount !== book.chapterCount) {
      fail(
        book.filePath,
        `chapterCount 为 ${book.chapterCount}，但找到 ${actualChapterCount} 个章节`
      );
    }
  });

  return {
    audioCount: audios.length,
    bookChapterCount: bookChapters.length,
    bookChapterParagraphCount: bookChapters.reduce(
      (total, chapter) => total + chapter.paragraphCount,
      0
    ),
    bookCount: books.length,
    contentCount: contents.length,
    paragraphCount: contents.reduce(
      (total, content) => total + content.paragraphCount,
      0
    )
  };
}

if (require.main === module) {
  const result = validateSeeds();
  console.log(
    `内容种子校验通过：${result.contentCount} 篇内容、${result.audioCount} 条音轨、${result.bookCount} 本整书、${result.bookChapterCount} 个章节、${result.paragraphCount} 个正文段落。`
  );
}

module.exports = {
  validateSeeds
};
