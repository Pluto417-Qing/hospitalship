const crypto = require("crypto");
const {
  EditorialValidationError,
  normalizeEditorialPayload
} = require("./editorial");

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DRAFT_ID_PATTERN = /^[a-f0-9]{32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^r-[a-f0-9]{32}$/;
const IMAGE_DRAFT_ID_PATTERN = DRAFT_ID_PATTERN;
const EMBEDDED_ASSET_ID_PATTERN = /^embedded-[0-9]{4}$/;
const EMBEDDED_IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);
const CATALOG_VIEWS = new Set(["book", "summary"]);
const MAX_TOPIC_BLOCKS = 2000;
const MAX_TOPIC_CHARACTERS = 300000;
const MAX_BOOK_CHAPTERS = 200;
const MAX_BOOK_CHARACTERS = 1000000;
const ASSET_KINDS = Object.freeze({
  manuscript: "content",
  audio: "audio",
  "special-topic": "special-topic",
  "full-book-pdf": "full-book",
  "topic-image": "topic-image",
  "zhi-entry": "zhi",
  "quiz-question": "quiz"
});

const EDITORIAL_ASSET_KINDS = Object.freeze({
  "zhi-entry": "zhi",
  "quiz-question": "quiz"
});

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    ? Math.max(minimum, Math.min(maximum, numeric))
    : fallback;
}

function normalizePositiveNumber(value, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(numeric, maximum)
    : 0;
}

function canonicalize(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? value.toISOString() : null;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        const item = value[key];
        if (item !== undefined) {
          result[key] = canonicalize(item);
        }
        return result;
      }, {});
  }

  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createRevision(draftId) {
  return DRAFT_ID_PATTERN.test(draftId) ? `r-${draftId}` : "";
}

function stripExtension(fileName) {
  const normalized = normalizeText(fileName, 180);
  const dot = normalized.lastIndexOf(".");
  return normalizeText(dot > 0 ? normalized.slice(0, dot) : normalized, 160);
}

function normalizeCloudFileID(value, allowedPrefix) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.includes("..")
  ) {
    return "";
  }

  const slash = value.indexOf("/", "cloud://".length);
  const environment = slash >= 0 ? value.slice("cloud://".length, slash) : "";
  const cloudPath = slash >= 0 ? value.slice(slash + 1) : "";

  return environment && cloudPath.startsWith(allowedPrefix) ? value : "";
}

function normalizeEmbeddedAssets(value, assetType, targetId) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 200) {
    return null;
  }

  const protectedPrefix = assetType === "special-topic"
    ? `protected/special-topics/${targetId}/assets/`
    : assetType === "manuscript"
      ? `protected/contents/${targetId}/assets/`
      : "";
  if (!protectedPrefix && value.length > 0) {
    return null;
  }

  const assets = [];
  const seenIds = new Set();
  const seenOrders = new Set();
  const seenFileIDs = new Set();
  for (const rawAsset of value) {
    if (!rawAsset || typeof rawAsset !== "object") {
      return null;
    }
    const id = normalizeText(rawAsset.id || rawAsset.assetId, 32).toLowerCase();
    const order = Number(rawAsset.order);
    const extension = normalizeText(rawAsset.extension, 8).toLowerCase();
    const fileID = normalizeCloudFileID(rawAsset.fileID, protectedPrefix);
    const slash = fileID.indexOf("/", "cloud://".length);
    const cloudPath = slash >= 0 ? fileID.slice(slash + 1) : "";
    const declaredCloudPath = normalizeText(rawAsset.cloudPath, 512);
    const expectedSuffix =
      `/embedded/${String(order).padStart(4, "0")}${extension}`;
    const afterPrefix = cloudPath.slice(protectedPrefix.length);
    const uploadId = afterPrefix.split("/")[0] || "";

    if (
      !EMBEDDED_ASSET_ID_PATTERN.test(id) ||
      !Number.isInteger(order) ||
      order < 1 ||
      order > 200 ||
      id !== `embedded-${String(order).padStart(4, "0")}` ||
      !EMBEDDED_IMAGE_EXTENSIONS.has(extension) ||
      !fileID ||
      cloudPath !== declaredCloudPath ||
      !DRAFT_ID_PATTERN.test(uploadId) ||
      !cloudPath.endsWith(expectedSuffix) ||
      seenIds.has(id) ||
      seenOrders.has(order) ||
      seenFileIDs.has(fileID)
    ) {
      return null;
    }

    seenIds.add(id);
    seenOrders.add(order);
    seenFileIDs.add(fileID);
    assets.push({
      id,
      order,
      fileID,
      cloudPath,
      extension,
      packagePath: normalizeText(rawAsset.packagePath, 512),
      caption: normalizeText(rawAsset.caption, 300),
      validationStatus: "object-exists-unverified"
    });
  }

  return assets.sort((left, right) => left.order - right.order);
}

function normalizeManuscriptBlocks(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 400) {
    return null;
  }

  const blocks = [];
  for (const rawBlock of value) {
    if (!rawBlock || typeof rawBlock !== "object") {
      return null;
    }
    const type = normalizeText(rawBlock.type, 20).toLowerCase();
    if (type === "image") {
      const embeddedAssetId = normalizeText(
        rawBlock.embeddedAssetId,
        32
      ).toLowerCase();
      if (!EMBEDDED_ASSET_ID_PATTERN.test(embeddedAssetId)) {
        return null;
      }
      blocks.push({
        type: "image",
        embeddedAssetId,
        caption: normalizeText(rawBlock.caption, 300)
      });
      continue;
    }
    const text = normalizeText(rawBlock.text, 10000);
    if (type !== "text" || !text) {
      return null;
    }
    blocks.push({ type: "text", text });
  }
  return blocks;
}

function normalizeSections(value) {
  if (!Array.isArray(value) || value.length > 120) {
    return [];
  }

  const sections = [];
  let totalCharacters = 0;

  for (const rawSection of value) {
    if (!rawSection || typeof rawSection !== "object") {
      continue;
    }

    const rawParagraphs = Array.isArray(rawSection.paragraphs)
      ? rawSection.paragraphs
      : [];
    const rawBlocks = normalizeManuscriptBlocks(rawSection.blocks);
    if (rawParagraphs.length > 200) {
      return [];
    }
    if (rawBlocks === null) {
      return [];
    }

    const heading = normalizeText(rawSection.heading, 120);
    const paragraphs = [];
    totalCharacters += heading.length;

    for (const rawParagraph of rawParagraphs) {
      if (typeof rawParagraph !== "string") {
        continue;
      }
      const paragraph = rawParagraph.trim();
      if (paragraph.length > 10000) {
        return [];
      }
      if (paragraph) {
        paragraphs.push(paragraph);
        totalCharacters += paragraph.length;
      }
      if (totalCharacters > 150000) {
        return [];
      }
    }

    if (heading || paragraphs.length > 0 || rawBlocks.length > 0) {
      const section = {
        kind: normalizeText(rawSection.kind, 32) || "story",
        heading,
        paragraphs
      };
      if (rawBlocks.length > 0) {
        section.blocks = rawBlocks;
      }
      sections.push(section);
    }
  }

  return sections;
}

function normalizeTopicBlocks(value) {
  if (!Array.isArray(value) || value.length > 200) {
    return [];
  }

  const blocks = [];
  for (const rawBlock of value) {
    if (!rawBlock || typeof rawBlock !== "object") {
      continue;
    }

    const type = normalizeText(rawBlock.type || rawBlock.kind, 20).toLowerCase();
    if (type === "image") {
      const embeddedAssetId = normalizeText(
        rawBlock.embeddedAssetId,
        32
      ).toLowerCase();
      if (EMBEDDED_ASSET_ID_PATTERN.test(embeddedAssetId)) {
        blocks.push({
          type: "image",
          embeddedAssetId,
          caption: normalizeText(rawBlock.caption, 300)
        });
        continue;
      }
      const imageDraftId = normalizeText(rawBlock.imageDraftId, 32).toLowerCase();
      if (!IMAGE_DRAFT_ID_PATTERN.test(imageDraftId)) {
        return [];
      }
      blocks.push({
        type: "image",
        imageDraftId,
        caption: normalizeText(rawBlock.caption, 300)
      });
      continue;
    }

    if (type === "heading") {
      const text = normalizeText(rawBlock.text || rawBlock.content, 300);
      if (text) {
        blocks.push({ type: "heading", text });
      }
      continue;
    }

    const text = normalizeText(rawBlock.text || rawBlock.content, 10000);
    if (text) {
      blocks.push({ type: "text", text });
    }
  }

  return blocks;
}

function normalizeTopicEntries(value) {
  if (!Array.isArray(value) || value.length > 200) {
    return [];
  }

  const entries = [];
  let totalBlocks = 0;
  let totalCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const rawEntry = value[index];
    const blocks = normalizeTopicBlocks(rawEntry && rawEntry.blocks);
    if (blocks.length === 0) {
      continue;
    }
    totalBlocks += blocks.length;
    totalCharacters += blocks.reduce(
      (sum, block) => sum +
        normalizeText(block.text, 10000).length +
        normalizeText(block.caption, 300).length,
      0
    );
    if (
      totalBlocks > MAX_TOPIC_BLOCKS ||
      totalCharacters > MAX_TOPIC_CHARACTERS
    ) {
      return [];
    }
    entries.push({
      sortOrder: normalizeInteger(
        rawEntry && rawEntry.sortOrder,
        (index + 1) * 10,
        -1000000,
        1000000
      ),
      blocks
    });
  }

  return entries;
}

function embeddedReferenceIssues(assetType, payload) {
  if (!["manuscript", "special-topic"].includes(assetType)) {
    return [];
  }
  const assets = Array.isArray(payload && payload.embeddedAssets)
    ? payload.embeddedAssets
    : [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  const referenced = new Set();
  let invalid = false;

  if (assetType === "manuscript") {
    (payload.sections || []).forEach((section) => {
      (section.blocks || []).forEach((block) => {
        if (block.type === "image") {
          if (!assetIds.has(block.embeddedAssetId)) {
            invalid = true;
          } else {
            referenced.add(block.embeddedAssetId);
          }
        }
      });
    });
  } else {
    (payload.entries || []).forEach((entry) => {
      (entry.blocks || []).forEach((block) => {
        if (block.type === "image" && block.embeddedAssetId) {
          if (!assetIds.has(block.embeddedAssetId)) {
            invalid = true;
          } else {
            referenced.add(block.embeddedAssetId);
          }
        }
      });
    });
  }

  if (invalid || referenced.size !== assetIds.size) {
    return ["内嵌图片与正文位置不一致，请重新从原始 Word 创建草稿"];
  }
  return [];
}

function normalizeBookChapters(value, bookId) {
  if (!Array.isArray(value) || value.length > MAX_BOOK_CHAPTERS) {
    return [];
  }

  const chapters = [];
  const seenIds = new Set();
  let totalCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index];
    const rawChapterId = normalizeText(
      source && (source.chapterId || source.id),
      64
    ).toLowerCase();
    const chapterId = rawChapterId.startsWith(`${bookId}-`)
      ? rawChapterId
      : `${bookId}-${rawChapterId}`;
    const title = normalizeText(source && source.title, 160);
    const sections = normalizeSections(source && source.sections);
    if (
      !STABLE_ID_PATTERN.test(chapterId) ||
      seenIds.has(chapterId) ||
      !title ||
      sections.length === 0
    ) {
      return [];
    }
    totalCharacters += title.length + sections.reduce(
      (sum, section) => sum + section.heading.length +
        section.paragraphs.reduce((count, paragraph) => count + paragraph.length, 0),
      0
    );
    if (totalCharacters > MAX_BOOK_CHARACTERS) {
      return [];
    }
    seenIds.add(chapterId);
    const sourceContentId = normalizeText(source.sourceContentId, 64).toLowerCase();
    chapters.push({
      chapterId,
      title,
      sortOrder: normalizeInteger(
        source.sortOrder,
        (index + 1) * 10,
        -1000000,
        1000000
      ),
      sourceContentId: STABLE_ID_PATTERN.test(sourceContentId)
        ? sourceContentId
        : "",
      sourceContentRevision: normalizeText(source.sourceContentRevision, 128),
      sections
    });
  }
  return chapters;
}

function normalizePayload(assetType, rawPayload, context = {}) {
  const source = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const targetId = normalizeText(context.targetId, 64).toLowerCase();

  if (!STABLE_ID_PATTERN.test(targetId) || ASSET_KINDS[assetType] === undefined) {
    return null;
  }

  if (EDITORIAL_ASSET_KINDS[assetType]) {
    try {
      return normalizeEditorialPayload(
        EDITORIAL_ASSET_KINDS[assetType],
        rawPayload
      );
    } catch (error) {
      if (error instanceof EditorialValidationError) {
        return null;
      }
      throw error;
    }
  }

  if (assetType === "manuscript") {
    const catalogViews = Array.isArray(source.catalogViews)
      ? Array.from(new Set(source.catalogViews
          .map((item) => normalizeText(item, 20).toLowerCase())
          .filter((item) => CATALOG_VIEWS.has(item))))
      : [];
    const bookId = normalizeText(source.bookId, 64).toLowerCase();

    const embeddedAssets = normalizeEmbeddedAssets(
      source.embeddedAssets,
      assetType,
      targetId
    );
    if (embeddedAssets === null) {
      return null;
    }
    return {
      contentId: targetId,
      bookId: STABLE_ID_PATTERN.test(bookId) ? bookId : "",
      title: normalizeText(source.title, 120),
      subtitle: normalizeText(source.subtitle, 240),
      sourceLabel: normalizeText(source.sourceLabel, 120),
      department: normalizeText(source.department, 80),
      catalogViews,
      sortOrder: normalizeInteger(source.sortOrder, 0, -1000000, 1000000),
      coverFileID: normalizeCloudFileID(source.coverFileID, "published/images/"),
      disclaimer: normalizeText(source.disclaimer, 1000),
      sections: normalizeSections(source.sections),
      ...(embeddedAssets.length > 0 ? { embeddedAssets } : {}),
      structureConfirmed: source.structureConfirmed === true
    };
  }

  if (assetType === "audio") {
    return {
      contentId: targetId,
      title: normalizeText(source.title, 120),
      narrator: normalizeText(source.narrator, 80),
      language: normalizeText(source.language, 32) || "zh-CN",
      mimeType: normalizeText(context.mimeType, 64).toLowerCase(),
      durationSeconds: normalizePositiveNumber(source.durationSeconds, 24 * 60 * 60),
      bitrate: normalizeInteger(source.bitrate, 0, 0, 100000000),
      trackNo: 1
    };
  }

  if (assetType === "special-topic") {
    const embeddedAssets = normalizeEmbeddedAssets(
      source.embeddedAssets,
      assetType,
      targetId
    );
    if (embeddedAssets === null) {
      return null;
    }
    return {
      topicId: targetId,
      title: normalizeText(source.title, 120),
      summary: normalizeText(source.summary || source.subtitle, 500),
      producer: normalizeText(source.producer || source.author, 120),
      unlockCostStars: normalizeInteger(source.unlockCostStars, 0, 0, 1000000),
      sortOrder: normalizeInteger(source.sortOrder, 0, -1000000, 1000000),
      previewCoverFileID: normalizeCloudFileID(
        source.previewCoverFileID,
        "published/images/"
      ),
      entries: normalizeTopicEntries(source.entries),
      ...(embeddedAssets.length > 0 ? { embeddedAssets } : {}),
      structureConfirmed: source.structureConfirmed === true
    };
  }

  if (assetType === "full-book-pdf") {
    const structureMode = source.structureMode === "reuse-current"
      ? "reuse-current"
      : source.structureMode === "from-published-contents"
        ? "from-published-contents"
        : "replace";
    return {
      bookId: targetId,
      title: normalizeText(source.title, 160),
      subtitle: normalizeText(source.subtitle, 240),
      fileName: normalizeText(source.fileName, 180) || `${targetId}.pdf`,
      structureMode,
      chapters: structureMode === "replace"
        ? normalizeBookChapters(source.chapters, targetId)
        : [],
      structureConfirmed: structureMode !== "replace" ||
        source.structureConfirmed === true
    };
  }

  return {
    topicId: targetId,
    caption: normalizeText(source.caption, 300)
  };
}

function payloadIssues(assetType, payload) {
  const issues = [];

  if (EDITORIAL_ASSET_KINDS[assetType]) {
    try {
      normalizeEditorialPayload(EDITORIAL_ASSET_KINDS[assetType], payload);
      return issues;
    } catch (error) {
      if (error instanceof EditorialValidationError) {
        return [error.message || "结构化内容不完整"];
      }
      throw error;
    }
  }

  if (!payload) {
    return ["草稿结构无效"];
  }

  if (assetType === "manuscript") {
    if (!payload.title) issues.push("请填写文章标题");
    if (payload.catalogViews.length === 0) issues.push("请至少选择一个展示栏目");
    if (payload.catalogViews.includes("book") && !payload.bookId) {
      issues.push("书稿栏目必须关联稳定的整书编号");
    }
    if (payload.sections.length === 0) issues.push("请补充可发布的正文结构");
    issues.push(...embeddedReferenceIssues(assetType, payload));
    if (!payload.structureConfirmed) issues.push("请确认正文不是截断预览并完成结构校对");
  } else if (assetType === "audio") {
    if (!payload.title) issues.push("请填写录音标题");
    if (!payload.mimeType.startsWith("audio/")) issues.push("录音 MIME 类型无效");
    if (!(payload.durationSeconds > 0)) issues.push("请填写可靠的录音时长");
  } else if (assetType === "special-topic") {
    if (!payload.title) issues.push("请填写专题标题");
    if (!(payload.unlockCostStars > 0)) issues.push("请填写大于零的红五星价格");
    if (payload.entries.length === 0) issues.push("请补充专题图文条目");
    issues.push(...embeddedReferenceIssues(assetType, payload));
    if (!payload.structureConfirmed) issues.push("请确认专题不是截断预览并完成结构校对");
  } else if (assetType === "full-book-pdf") {
    if (!payload.title) issues.push("请填写整书标题");
    if (payload.structureMode === "replace" && payload.chapters.length === 0) {
      issues.push("请补充整书章节结构");
    }
    if (payload.structureMode === "replace" && !payload.structureConfirmed) {
      issues.push("请确认整书章节结构已经完整校对");
    }
  }

  return issues;
}

function defaultPayloadFromUpload(upload, target = {}) {
  const title = stripExtension(upload && upload.originalFileName);
  const inspection = upload && upload.inspection && typeof upload.inspection === "object"
    ? upload.inspection
    : {};
  const inspectionMetadata =
    inspection.metadata && typeof inspection.metadata === "object"
      ? inspection.metadata
      : {};
  const clientAttestedMetadata =
    upload &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.assetType === "audio" &&
    upload.clientAttestedMetadata &&
    typeof upload.clientAttestedMetadata === "object" &&
    upload.clientAttestedMetadata.schemaVersion === 1 &&
    upload.clientAttestedMetadata.scope ===
      "client-measured-audio-duration" &&
    upload.clientAttestedMetadata.adminAccountId === upload.ownerAdminId &&
    typeof upload.clientAttestedMetadata.durationSeconds === "number" &&
    Number.isFinite(upload.clientAttestedMetadata.durationSeconds) &&
    upload.clientAttestedMetadata.durationSeconds > 0 &&
    upload.clientAttestedMetadata.durationSeconds <= 24 * 60 * 60
      ? upload.clientAttestedMetadata
      : {};
  const previewParagraphs = Array.isArray(inspection.previewParagraphs)
    ? inspection.previewParagraphs.filter((item) => typeof item === "string")
    : [];
  let rawPayload;

  if (upload.assetType === "manuscript") {
    rawPayload = {
      title,
      bookId: normalizeText(target.bookId, 64).toLowerCase() ||
        "china-hospital-ship",
      sourceLabel: "管理员上传",
      catalogViews: ["book"],
      sections: previewParagraphs.length > 0
        ? [{ kind: "story", heading: "", paragraphs: previewParagraphs }]
        : [],
      structureConfirmed: false
    };
  } else if (upload.assetType === "audio") {
    const brokerDuration = Number(
      inspectionMetadata.durationSeconds !== undefined
        ? inspectionMetadata.durationSeconds
        : inspection.durationSeconds
    );
    const clientDuration = Number(clientAttestedMetadata.durationSeconds);
    const durationSeconds =
      Number.isFinite(brokerDuration) && brokerDuration > 0
        ? brokerDuration
        : Number.isFinite(clientDuration) && clientDuration > 0
          ? clientDuration
          : 0;
    const averageBitrateKbps = Number(inspectionMetadata.averageBitrateKbps);
    rawPayload = {
      title,
      language: "zh-CN",
      durationSeconds,
      bitrate: Number(inspection.bitrate) ||
        (
          Number.isFinite(averageBitrateKbps) && averageBitrateKbps > 0
            ? Math.round(averageBitrateKbps * 1000)
            : 0
        )
    };
  } else if (upload.assetType === "special-topic") {
    rawPayload = {
      title,
      unlockCostStars: 0,
      entries: previewParagraphs.length > 0
        ? [{
            sortOrder: 10,
            blocks: previewParagraphs.map((text) => ({ type: "text", text }))
          }]
        : [],
      structureConfirmed: false
    };
  } else if (upload.assetType === "full-book-pdf") {
    const canReuseStructure = Boolean(
      target.status === "published" &&
      normalizeText(target.currentRevision, 128)
    );
    rawPayload = {
      title: normalizeText(target.title, 160) ||
        (
          normalizeText(upload.relatedId, 64).toLowerCase() ===
            "china-hospital-ship"
            ? "中国医院船"
            : title
        ),
      subtitle: normalizeText(target.subtitle, 240),
      fileName: upload.originalFileName,
      structureMode: canReuseStructure
        ? "reuse-current"
        : "from-published-contents",
      chapters: [],
      structureConfirmed: canReuseStructure
    };
  } else {
    rawPayload = { caption: title };
  }

  return normalizePayload(upload.assetType, rawPayload, {
    targetId: upload.relatedId,
    mimeType: upload.mimeType
  });
}

function snapshotHash(draft) {
  return sha256(canonicalStringify({
    draftId: draft._id,
    assetType: draft.assetType,
    targetId: draft.targetId,
    revision: draft.revision,
    basePublishedRevision: draft.basePublishedRevision || "",
    baseAssetRevision: draft.baseAssetRevision || "",
    draftVersion: draft.draftVersion,
    sourceFingerprints: draft.sourceFingerprints,
    sourceFileID: draft.sourceFileID || "",
    preparedFileID: draft.preparedFileID || "",
    preparedCloudPath: draft.preparedCloudPath || "",
    extension: draft.extension || "",
    mimeType: draft.mimeType || "",
    inspection: draft.inspection || null,
    payload: draft.payload
  }));
}

function publicDraft(draft) {
  const inspection = draft && draft.inspection && typeof draft.inspection === "object"
    ? draft.inspection
    : {};
  const inspectionMetadata = inspection.metadata && typeof inspection.metadata === "object"
    ? inspection.metadata
    : {};
  return {
    id: normalizeText(draft && draft._id, 32),
    assetType: normalizeText(draft && draft.assetType, 32),
    kind: normalizeText(draft && draft.kind, 32),
    targetId: normalizeText(draft && draft.targetId, 64),
    revision: normalizeText(draft && draft.revision, 40),
    basePublishedRevision: normalizeText(
      draft && draft.basePublishedRevision,
      128
    ),
    baseAssetRevision: normalizeText(draft && draft.baseAssetRevision, 128),
    draftVersion: Number(draft && draft.draftVersion) || 0,
    state: normalizeText(draft && draft.state, 32),
    payload: draft && draft.payload || null,
    issues: Array.isArray(draft && draft.issues) ? draft.issues.slice(0, 20) : [],
    inspection: {
      format: normalizeText(inspection.format, 32),
      paragraphCount: normalizeInteger(
        inspectionMetadata.previewParagraphCount,
        Array.isArray(inspection.previewParagraphs)
          ? inspection.previewParagraphs.length
          : 0,
        0,
        100000
      ),
      embeddedImageCount: normalizeInteger(
        inspection.embeddedImageCount,
        0,
        0,
        100000
      ),
      needsManualStructure: Boolean(inspection.needsManualStructure)
    },
    snapshotHash: SNAPSHOT_HASH_PATTERN.test(draft && draft.snapshotHash)
      ? draft.snapshotHash
      : "",
    review: draft && draft.review
      ? {
          round: Number(draft.review.round) || 0,
          decision: normalizeText(draft.review.decision, 32),
          note: normalizeText(draft.review.note, 1000),
          submittedAt: draft.review.submittedAt || null,
          reviewedAt: draft.review.reviewedAt || null
        }
      : null,
    publication: draft && draft.publication
      ? {
          status: normalizeText(draft.publication.status, 32),
          publishedAt: draft.publication.publishedAt || null
        }
      : null,
    createdAt: draft && draft.createdAt || null,
    updateTime: draft && draft.updateTime || null
  };
}

module.exports = {
  ASSET_KINDS,
  DRAFT_ID_PATTERN,
  REQUEST_ID_PATTERN,
  REVISION_PATTERN,
  SNAPSHOT_HASH_PATTERN,
  STABLE_ID_PATTERN,
  canonicalStringify,
  createRevision,
  defaultPayloadFromUpload,
  normalizePayload,
  normalizeText,
  payloadIssues,
  publicDraft,
  sha256,
  snapshotHash
};
