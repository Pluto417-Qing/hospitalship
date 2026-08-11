const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VALID_MODES = new Set(["text", "audio"]);
const MAX_PUBLISHED_AUDIO_TRACKS = 20;
const MAX_CONTENT_SECTIONS = 120;
const MAX_PARAGRAPHS_PER_SECTION = 200;
const MAX_BLOCKS_PER_SECTION = 400;
const MAX_CONTENT_BLOCKS = 2000;
const MAX_EMBEDDED_IMAGES = 200;
const MAX_PARAGRAPH_CHARACTERS = 10000;
const MAX_CONTENT_CHARACTERS = 150000;
const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMBEDDED_ASSET_ID_PATTERN = /^embedded-[0-9]{4}$/;
const EMBEDDED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp"
]);

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizePositiveNumber(value, maximum) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return Math.min(number, maximum);
}

function createSessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function getTimeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : NaN;
  }

  if (value && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isActiveSession(session, now = Date.now()) {
  const expiresAt = getTimeValue(session && session.expiresAt);

  return Boolean(
    session &&
      session.status === "active" &&
      normalizeText(session.userId, 128) &&
      Number.isFinite(expiresAt) &&
      expiresAt > now
  );
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function getPublishedAudioTrackCount(value) {
  const count = Number(value);

  return Number.isInteger(count) && count > 0 && count <= MAX_PUBLISHED_AUDIO_TRACKS
    ? count
    : 0;
}

function normalizePublishedImageFileId(...values) {
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      !value.startsWith("cloud://") ||
      /[\s\\\u0000-\u001f]/.test(value) ||
      value.includes("..")
    ) {
      continue;
    }

    const pathSeparatorIndex = value.indexOf("/", "cloud://".length);
    const environment = pathSeparatorIndex >= 0
      ? value.slice("cloud://".length, pathSeparatorIndex)
      : "";
    const cloudPath = pathSeparatorIndex >= 0
      ? value.slice(pathSeparatorIndex + 1)
      : "";

    if (
      environment &&
      cloudPath.startsWith("published/images/") &&
      cloudPath.length > "published/images/".length
    ) {
      return value;
    }
  }

  return "";
}

function isSafeTemporaryURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("https://") ||
    /[\s\\\u0000-\u001f]/.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch (error) {
    return false;
  }
}

async function createSignedPublishedImageURL(fileID) {
  if (!fileID || typeof cloud.getTempFileURL !== "function") {
    return "";
  }

  try {
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const signedFiles = result && Array.isArray(result.fileList)
      ? result.fileList
      : [];
    const signed = signedFiles.find(
      (file) =>
        file &&
        file.fileID === fileID &&
        (file.status === undefined || Number(file.status) === 0) &&
        isSafeTemporaryURL(file.tempFileURL)
    );

    return signed ? signed.tempFileURL : "";
  } catch (error) {
    console.warn("getContentDetail cover URL signing failed");
    return "";
  }
}

function normalizeProtectedContentImageFileID(value, contentId) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.includes("..")
  ) {
    return "";
  }

  const pathSeparatorIndex = value.indexOf("/", "cloud://".length);
  const environment = pathSeparatorIndex >= 0
    ? value.slice("cloud://".length, pathSeparatorIndex)
    : "";
  const cloudPath = pathSeparatorIndex >= 0
    ? value.slice(pathSeparatorIndex + 1)
    : "";
  const prefix = `protected/contents/${contentId}/assets/`;

  return environment &&
    cloudPath.startsWith(prefix) &&
    /\/embedded\/[0-9]{4}\.(?:jpe?g|png|gif|webp)$/.test(cloudPath)
    ? value
    : "";
}

function normalizeEmbeddedAssets(value, contentId) {
  if (value === undefined || value === null) {
    return { assets: [], byId: new Map() };
  }

  if (!Array.isArray(value) || value.length > MAX_EMBEDDED_IMAGES) {
    return null;
  }

  const assets = [];
  const byId = new Map();
  const seenOrders = new Set();
  const seenFileIDs = new Set();
  const prefix = `protected/contents/${contentId}/assets/`;

  for (const rawAsset of value) {
    const id = normalizeText(
      rawAsset && (rawAsset.id || rawAsset.assetId),
      32
    ).toLowerCase();
    const order = Number(rawAsset && rawAsset.order);
    const extension = normalizeText(
      rawAsset && rawAsset.extension,
      8
    ).toLowerCase();
    const fileID = normalizeProtectedContentImageFileID(
      rawAsset && rawAsset.fileID,
      contentId
    );
    const separatorIndex = fileID.indexOf("/", "cloud://".length);
    const cloudPath = separatorIndex >= 0
      ? fileID.slice(separatorIndex + 1)
      : "";
    const declaredCloudPath = normalizeText(
      rawAsset && rawAsset.cloudPath,
      1024
    );
    const expectedSuffix =
      `/embedded/${String(order).padStart(4, "0")}${extension}`;

    if (
      !EMBEDDED_ASSET_ID_PATTERN.test(id) ||
      !Number.isInteger(order) ||
      order < 1 ||
      order > MAX_EMBEDDED_IMAGES ||
      id !== `embedded-${String(order).padStart(4, "0")}` ||
      !EMBEDDED_IMAGE_EXTENSIONS.has(extension) ||
      !fileID ||
      !cloudPath.startsWith(prefix) ||
      cloudPath !== declaredCloudPath ||
      !cloudPath.endsWith(expectedSuffix) ||
      byId.has(id) ||
      seenOrders.has(order) ||
      seenFileIDs.has(fileID)
    ) {
      return null;
    }

    const asset = {
      id,
      order,
      fileID,
      caption: normalizeText(rawAsset && rawAsset.caption, 300)
    };
    assets.push(asset);
    byId.set(id, asset);
    seenOrders.add(order);
    seenFileIDs.add(fileID);
  }

  assets.sort((left, right) => left.order - right.order);
  return { assets, byId };
}

async function createSignedFileURLMap(fileIDs) {
  const uniqueFileIDs = [...new Set(
    (Array.isArray(fileIDs) ? fileIDs : []).filter(Boolean)
  )];
  const signedURLs = new Map();

  if (uniqueFileIDs.length === 0) {
    return signedURLs;
  }

  if (typeof cloud.getTempFileURL !== "function") {
    return null;
  }

  try {
    for (let offset = 0; offset < uniqueFileIDs.length; offset += 50) {
      const batch = uniqueFileIDs.slice(offset, offset + 50);
      const result = await cloud.getTempFileURL({ fileList: batch });
      const signedFiles = result && Array.isArray(result.fileList)
        ? result.fileList
        : [];

      for (const file of signedFiles) {
        if (
          file &&
          batch.includes(file.fileID) &&
          (file.status === undefined || Number(file.status) === 0) &&
          isSafeTemporaryURL(file.tempFileURL)
        ) {
          signedURLs.set(file.fileID, file.tempFileURL);
        }
      }
    }
  } catch (error) {
    console.warn("getContentDetail embedded image URL signing failed");
    return null;
  }

  return signedURLs.size === uniqueFileIDs.length ? signedURLs : null;
}

function normalizeSections(value, embeddedAssets = { assets: [], byId: new Map() }) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CONTENT_SECTIONS
  ) {
    return [];
  }

  const sections = [];
  let characterCount = 0;
  let blockCount = 0;
  const referencedAssetIds = new Set();

  for (const sourceSection of value) {
    const rawParagraphs = Array.isArray(sourceSection && sourceSection.paragraphs)
      ? sourceSection.paragraphs
      : [];
    const hasDeclaredBlocks = Array.isArray(sourceSection && sourceSection.blocks);
    const rawBlocks = hasDeclaredBlocks ? sourceSection.blocks : [];

    if (
      rawParagraphs.length > MAX_PARAGRAPHS_PER_SECTION ||
      rawBlocks.length > MAX_BLOCKS_PER_SECTION
    ) {
      return [];
    }

    const heading = normalizeText(sourceSection && sourceSection.heading, 120);
    const paragraphs = [];
    const blocks = [];
    characterCount += heading.length;

    if (characterCount > MAX_CONTENT_CHARACTERS) {
      return [];
    }

    for (const rawParagraph of rawParagraphs) {
      if (typeof rawParagraph !== "string") {
        continue;
      }

      const paragraph = rawParagraph.trim();

      if (paragraph.length > MAX_PARAGRAPH_CHARACTERS) {
        return [];
      }

      if (paragraph) {
        paragraphs.push(paragraph);
        if (!hasDeclaredBlocks) {
          characterCount += paragraph.length;
        }
      }

      if (characterCount > MAX_CONTENT_CHARACTERS) {
        return [];
      }
    }

    if (hasDeclaredBlocks) {
      for (const rawBlock of rawBlocks) {
        const type = normalizeText(rawBlock && rawBlock.type, 20).toLowerCase();

        if (type === "text") {
          const text = normalizeText(rawBlock && rawBlock.text, 10000);
          if (!text) {
            return [];
          }
          blocks.push({ type: "text", text });
          characterCount += text.length;
        } else if (type === "image") {
          const embeddedAssetId = normalizeText(
            rawBlock && rawBlock.embeddedAssetId,
            32
          ).toLowerCase();
          const asset = embeddedAssets.byId.get(embeddedAssetId);

          if (!asset) {
            return [];
          }

          blocks.push({
            type: "image",
            embeddedAssetId,
            fileID: asset.fileID,
            caption:
              normalizeText(rawBlock && rawBlock.caption, 300) ||
              asset.caption
          });
          referencedAssetIds.add(embeddedAssetId);
        } else {
          return [];
        }

        blockCount += 1;
        if (
          blockCount > MAX_CONTENT_BLOCKS ||
          characterCount > MAX_CONTENT_CHARACTERS
        ) {
          return [];
        }
      }
    } else {
      paragraphs.forEach((text) => {
        blocks.push({ type: "text", text });
        blockCount += 1;
      });
      if (blockCount > MAX_CONTENT_BLOCKS) {
        return [];
      }
    }

    if (heading || paragraphs.length > 0 || blocks.length > 0) {
      const section = {
        kind: normalizeText(sourceSection && sourceSection.kind, 32) || "story",
        heading,
        paragraphs
      };
      if (hasDeclaredBlocks) {
        section.blocks = blocks;
      }
      sections.push(section);
    }
  }

  if (
    embeddedAssets.assets.length !== referencedAssetIds.size ||
    embeddedAssets.assets.some((asset) => !referencedAssetIds.has(asset.id))
  ) {
    return [];
  }

  return sections;
}

function hasStableIdentity(document, contentId) {
  return Boolean(
    document &&
    normalizeText(document._id, 64) === contentId &&
    normalizeText(document.contentId, 64) === contentId
  );
}

function hasValidPublishedSchema(document, mode) {
  if (
    !normalizeText(document && document.title, 120) ||
    !normalizeText(document && document.currentRevision, 128)
  ) {
    return false;
  }

  return mode !== "text" || (
    Array.isArray(document.sections) &&
    document.sections.length > 0 &&
    document.sections.length <= MAX_CONTENT_SECTIONS
  );
}

function normalizeContent(document, mode) {
  const sourceAudio = document.audio && typeof document.audio === "object"
    ? document.audio
    : {};
  const currentRevision = normalizeText(document.currentRevision, 128);
  const publishedAudioTrackCount = getPublishedAudioTrackCount(
    document.publishedAudioTrackCount
  );
  const audioAvailable =
    document.audioStatus === "published" &&
    Boolean(currentRevision) &&
    publishedAudioTrackCount > 0;
  const content = {
    id: document._id,
    bookId: STABLE_ID_PATTERN.test(normalizeText(document.bookId, 64))
      ? normalizeText(document.bookId, 64)
      : "",
    currentRevision,
    title: normalizeText(document.title, 120) || "未命名内容",
    subtitle: normalizeText(document.subtitle, 240),
    sourceLabel: normalizeText(document.sourceLabel, 120),
    department: normalizeText(document.department, 80) || null,
    status: "published",
    accessPolicy: {
      text: "member",
      audio: "member"
    },
    publishedAt: document.publishedAt || null,
    cover: normalizePublishedImageFileId(
      document.coverUrl,
      document.coverFileId,
      document.cover
    ),
    disclaimer: normalizeText(document.disclaimer, 1000) || null,
    audio: {
      available: audioAvailable,
      title: normalizeText(sourceAudio.title, 120) || null,
      narrator: normalizeText(sourceAudio.narrator, 80) || null,
      durationMs: audioAvailable
        ? normalizePositiveNumber(sourceAudio.durationMs, 24 * 60 * 60 * 1000)
        : null
    }
  };

  if (mode === "text") {
    const embeddedAssets = normalizeEmbeddedAssets(
      document.embeddedAssets,
      document._id
    );

    if (!embeddedAssets) {
      return null;
    }

    content.sections = normalizeSections(document.sections, embeddedAssets);
    content._embeddedImageFileIDs = embeddedAssets.assets.map(
      (asset) => asset.fileID
    );
  }

  return content;
}

function applySignedEmbeddedImageURLs(content, signedURLs) {
  if (!content || !Array.isArray(content.sections)) {
    return false;
  }

  for (const section of content.sections) {
    for (const block of section.blocks || []) {
      if (block.type !== "image") {
        continue;
      }

      const src = signedURLs && signedURLs.get(block.fileID);
      if (!src) {
        return false;
      }

      block.src = src;
      delete block.fileID;
    }
  }

  return true;
}

function isDocumentNotFoundError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

async function readContent(contentId) {
  try {
    const result = await db.collection("contents").doc(contentId).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function readDocumentOrNull(collectionName, documentId) {
  try {
    const result = await db.collection(collectionName).doc(documentId).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function getActiveMember(openid) {
  const sessionId = createSessionId(openid);
  const session = await readDocumentOrNull("memberSessions", sessionId);

  if (
    !session ||
    session.status !== "active" ||
    !normalizeText(session.userId, 128)
  ) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员"
    };
  }

  if (!isActiveSession(session)) {
    return {
      success: false,
      code: "MEMBER_SESSION_EXPIRED",
      message: "会员登录已过期，请重新登录"
    };
  }

  const userId = normalizeText(session.userId, 128);
  const user = await readDocumentOrNull("users", userId);

  if (
    !user ||
    normalizeText(user._id, 128) !== userId ||
    normalizeText(user.openid, 128) !== openid
  ) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "会员登录状态已失效，请重新登录"
    };
  }

  if (!isActiveUser(user)) {
    return {
      success: false,
      code: "ACCOUNT_INACTIVE",
      message: "当前会员账号已停用"
    };
  }

  return { success: true, sessionId, userId, user };
}

exports.main = async (event = {}) => {
  const contentId = normalizeText(event.contentId, 64);
  const mode = normalizeText(event.mode, 16).toLowerCase() || "text";

  if (!contentId || !CONTENT_ID_PATTERN.test(contentId)) {
    return {
      success: false,
      code: "INVALID_CONTENT_ID",
      message: "内容编号无效"
    };
  }

  if (!VALID_MODES.has(mode)) {
    return {
      success: false,
      code: "INVALID_CONTENT_MODE",
      message: "内容读取模式无效"
    };
  }

  try {
    if (mode === "text" || mode === "audio") {
      const wxContext = cloud.getWXContext();
      const openid = normalizeText(wxContext && wxContext.OPENID, 128);

      if (!openid) {
        return {
          success: false,
          code: "OPENID_UNAVAILABLE",
          message: "无法识别当前微信用户"
        };
      }

      const membership = await getActiveMember(openid);

      if (!membership.success) {
        return membership;
      }
    }

    const document = await readContent(contentId);

    if (!document) {
      return {
        success: false,
        code: "CONTENT_NOT_FOUND",
        message: "内容不存在"
      };
    }

    if (!hasStableIdentity(document, contentId)) {
      return {
        success: false,
        code: "CONTENT_SCHEMA_INVALID",
        message: "内容主键配置无效"
      };
    }

    if (document.status !== "published") {
      return {
        success: false,
        code: "CONTENT_NOT_PUBLISHED",
        message: "内容尚未开放"
      };
    }

    if (!hasValidPublishedSchema(document, mode)) {
      return {
        success: false,
        code: "CONTENT_SCHEMA_INVALID",
        message: "内容发布数据不完整"
      };
    }

    const content = normalizeContent(document, mode);
    if (
      !content ||
      (mode === "text" &&
        (!Array.isArray(content.sections) || content.sections.length === 0))
    ) {
      return {
        success: false,
        code: "CONTENT_SCHEMA_INVALID",
        message: "内容发布数据不完整"
      };
    }

    content.cover = await createSignedPublishedImageURL(content.cover);
    if (mode === "text") {
      const embeddedFileIDs = content._embeddedImageFileIDs || [];
      const signedURLs = await createSignedFileURLMap(embeddedFileIDs);
      delete content._embeddedImageFileIDs;

      if (!signedURLs || !applySignedEmbeddedImageURLs(content, signedURLs)) {
        return {
          success: false,
          code: "CONTENT_ASSET_SIGN_FAILED",
          message: "正文图片暂时无法读取，请稍后重试"
        };
      }
    }

    return {
      success: true,
      source: "cloud",
      mode,
      content
    };
  } catch (error) {
    console.error("getContentDetail error:", error);

    return {
      success: false,
      code: "CONTENT_READ_FAILED",
      message: "内容读取失败"
    };
  }
};
