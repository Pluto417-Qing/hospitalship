const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  ClientManifestError,
  MAX_CANONICAL_MANIFEST_BYTES,
  validateAndConvertClientManifest
} = require("./clientManifest");
const {
  ASSET_KINDS,
  DRAFT_ID_PATTERN,
  REQUEST_ID_PATTERN,
  SNAPSHOT_HASH_PATTERN,
  STABLE_ID_PATTERN,
  canonicalStringify,
  createRevision,
  defaultPayloadFromUpload,
  normalizePayload,
  payloadIssues,
  publicDraft,
  sha256,
  snapshotHash
} = require("./workflow");
const {
  EDITORIAL_COLLECTIONS,
  buildEditorialPublishedDocument,
  createEditorialTargetId
} = require("./editorial");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PORTAL_ROLES = new Set([
  "uploader",
  "content-reviewer",
  "moderator",
  "admin"
]);
const UPLOAD_ROLES = new Set(["uploader", "admin"]);
const REVIEW_ROLES = new Set(["content-reviewer", "admin"]);
const MODERATION_ROLES = new Set([
  "moderator",
  "content-reviewer",
  "admin"
]);
const PUBLISH_ROLES = new Set(["admin"]);
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;
const ADMIN_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OPENID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const RELATED_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 10000;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const UPLOAD_TICKET_BYTES = 32;
const DRAFT_PAGE_SIZE = 20;
const MAX_DRAFT_PAGE_SIZE = 50;
const MAX_CLIENT_IMAGE_BATCH = 20;
const MAX_STORAGE_FILE_LOOKUP_BATCH = 50;
const MAX_CLIENT_IMAGE_MUTATIONS = 200;
const MAX_PUBLISH_ENTRY_BATCH = 10;
const MAX_CLEANUP_BATCH = 20;
const MAX_CLEANUP_MUTATIONS = 200;
const MAX_BOOK_CHAPTERS = 200;
const MAX_CLIENT_AUDIO_DURATION_SECONDS = 24 * 60 * 60;
// Leave headroom below the CloudBase document limit for BSON/index metadata.
const MAX_DRAFT_DOCUMENT_BYTES = 880 * 1024;
// Draft list queries must project only the fields needed by publicDraftSummary.
// A full draft may approach the document-size ceiling, so fetching a page of
// complete payloads would make an otherwise small list response expensive.
const DRAFT_LIST_FIELDS = Object.freeze({
  _id: true,
  ownerAdminId: true,
  assetType: true,
  kind: true,
  targetId: true,
  revision: true,
  basePublishedRevision: true,
  baseAssetRevision: true,
  draftVersion: true,
  state: true,
  issues: true,
  "inspection.format": true,
  "inspection.embeddedImageCount": true,
  "inspection.needsManualStructure": true,
  "inspection.metadata.previewParagraphCount": true,
  snapshotHash: true,
  review: true,
  publication: true,
  createdAt: true,
  updateTime: true,
  "payload.title": true,
  "payload.label": true,
  "payload.question": true,
  "payload.caption": true,
  "payload.bookTitle": true
});
// A large special-topic draft can be close to CloudBase's document limit. Once
// all images and entries have been prepared, publishing only needs the approval
// guard and the small topic header. Keeping the final read projected avoids
// deserializing the Word payload (and hundreds of embedded assets) twice in the
// free-tier three-second invocation.
const SPECIAL_TOPIC_PUBLISH_GUARD_FIELDS = Object.freeze({
  _id: true,
  ownerAdminId: true,
  sourceUploadId: true,
  assetType: true,
  kind: true,
  targetId: true,
  revision: true,
  basePublishedRevision: true,
  baseAssetRevision: true,
  draftVersion: true,
  state: true,
  issues: true,
  inspection: true,
  snapshotHash: true,
  review: true,
  publication: true,
  publicationPreparation: true,
  lastMutation: true,
  createdAt: true,
  updateTime: true,
  "payload.title": true,
  "payload.summary": true,
  "payload.producer": true,
  "payload.unlockCostStars": true,
  "payload.sortOrder": true,
  "payload.previewCoverFileID": true
});
const SPECIAL_TOPIC_FINAL_TRANSACTION_FIELDS = Object.freeze({
  _id: true,
  sourceUploadId: true,
  assetType: true,
  targetId: true,
  revision: true,
  basePublishedRevision: true,
  draftVersion: true,
  state: true,
  snapshotHash: true,
  review: true,
  publication: true,
  publicationPreparation: true,
  lastMutation: true,
  createdAt: true,
  updateTime: true
});
const DEFAULT_BOOK_ID = "china-hospital-ship";
const HOME_ASSET_MANIFEST_ID = "app-home-v1";
const HOME_ASSET_REVISION = "app-home-v1";
const HOME_ASSET_CLOUD_PREFIX = "published/images/app-home/v1";
const HOME_ASSET_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "banner02", fileName: "banner-02.jpg" }),
  Object.freeze({ key: "banner03", fileName: "banner-03.jpg" }),
  Object.freeze({ key: "banner04", fileName: "banner-04.jpg" }),
  Object.freeze({ key: "banner05", fileName: "banner-05.jpg" }),
  Object.freeze({ key: "banner06", fileName: "banner-06.jpg" }),
  Object.freeze({ key: "banner07", fileName: "banner-07.jpg" }),
  Object.freeze({ key: "banner08", fileName: "banner-08.jpg" }),
  Object.freeze({ key: "banner09", fileName: "banner-09.jpg" }),
  Object.freeze({ key: "banner10", fileName: "banner-10.jpg" }),
  Object.freeze({ key: "banner11", fileName: "banner-11.jpg" }),
  Object.freeze({ key: "banner12", fileName: "banner-12.jpg" }),
  Object.freeze({ key: "banner13", fileName: "banner-13.jpg" }),
  Object.freeze({ key: "banner14", fileName: "banner-14.jpg" }),
  Object.freeze({ key: "bookRehab", fileName: "book-rehab.jpg" }),
  Object.freeze({ key: "bookSummary", fileName: "book-summary.jpg" })
]);
const HOME_ASSET_BY_KEY = new Map(
  HOME_ASSET_DEFINITIONS.map((asset) => [asset.key, asset])
);
const KNOWN_CHAPTER_SOURCE_PDF_SHA256S = new Set([
  "d443f7dcbbecedd15e4e12fd6dba8bd37d3568401fdb24597a2d7ffabeebc07f"
]);
const CLIENT_IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);
const EDITORIAL_ASSET_KINDS = Object.freeze({
  "zhi-entry": "zhi",
  "quiz-question": "quiz"
});

const ASSET_POLICIES = Object.freeze({
  manuscript: {
    relationKind: "content",
    relationFields: ["contentId", "relatedId"],
    maximumBytes: 100 * 1024 * 1024,
    formats: {
      ".docx": [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ]
    }
  },
  audio: {
    relationKind: "content",
    relationFields: ["contentId", "relatedId"],
    maximumBytes: 500 * 1024 * 1024,
    formats: {
      ".mp3": ["audio/mpeg", "audio/mp3"],
      ".m4a": ["audio/mp4", "audio/x-m4a"],
      ".wav": ["audio/wav", "audio/x-wav", "audio/wave"]
    }
  },
  "special-topic": {
    relationKind: "topic",
    relationFields: ["topicId", "relatedId"],
    maximumBytes: 100 * 1024 * 1024,
    formats: {
      ".docx": [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ]
    }
  },
  "full-book-pdf": {
    relationKind: "book",
    relationFields: ["bookId", "relatedId"],
    maximumBytes: 50 * 1024 * 1024,
    formats: {
      ".pdf": ["application/pdf"]
    }
  },
  "topic-image": {
    relationKind: "topic",
    relationFields: ["topicId", "relatedId"],
    maximumBytes: 20 * 1024 * 1024,
    formats: {
      ".jpg": ["image/jpeg"],
      ".jpeg": ["image/jpeg"],
      ".png": ["image/png"],
      ".webp": ["image/webp"]
    }
  }
});

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, numeric));
}

function getRoles(account) {
  const roles = [];
  const directRole = normalizeText(account && account.role, 32).toLowerCase();

  if (directRole) {
    roles.push(directRole);
  }

  if (Array.isArray(account && account.roles)) {
    account.roles.forEach((role) => {
      const normalized = normalizeText(role, 32).toLowerCase();

      if (normalized) {
        roles.push(normalized);
      }
    });
  }

  return Array.from(new Set(roles));
}

function hasAnyRole(accountOrAdmin, allowedRoles) {
  const roles = Array.isArray(accountOrAdmin && accountOrAdmin.roles)
    ? accountOrAdmin.roles
    : getRoles(accountOrAdmin && accountOrAdmin.account
      ? accountOrAdmin.account
      : accountOrAdmin);
  return roles.some((role) => allowedRoles.has(role));
}

function requireRole(admin, allowedRoles, code, message) {
  return hasAnyRole(admin, allowedRoles)
    ? { success: true }
    : { success: false, code, message };
}

function isAuthorizedAccount(account, openid) {
  return Boolean(
    account &&
      ADMIN_ACCOUNT_ID_PATTERN.test(normalizeText(account._id, 128)) &&
      OPENID_PATTERN.test(openid) &&
      normalizeText(account.openid, 128) === openid &&
      account.status === "active" &&
      getRoles(account).some((role) => PORTAL_ROLES.has(role))
  );
}

function isDocumentNotFound(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String((error && (error.errMsg || error.message)) || "");

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist|not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

function isStorageDeleteSatisfied(item) {
  if (!item) return false;
  if (
    item.code === "SUCCESS" ||
    (item.code === undefined && Number(item.status) === 0)
  ) {
    return true;
  }
  const message = normalizeText(item.errMsg || item.message, 300);
  return /(?:not found|does not exist|not exist)|不存在/i.test(message);
}

async function getDocumentOrNull(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
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

function isUnexpired(value) {
  const expiresAt = getTimeValue(value);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function createOwnerKey(adminAccountId) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["admin-upload-owner", adminAccountId]))
    .digest("hex")
    .slice(0, 24);
}

function createUploadId() {
  return crypto.randomBytes(16).toString("hex");
}

function createUploadTicket() {
  return crypto
    .randomBytes(UPLOAD_TICKET_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hashUploadTicket(ticket) {
  return crypto.createHash("sha256").update(ticket).digest("hex");
}

function getUploadBrokerUrl() {
  const configured = normalizeText(process.env.ADMIN_UPLOAD_BROKER_URL, 2048);

  if (!configured) {
    return "";
  }

  try {
    const url = new URL(configured);

    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }

    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    return "";
  }
}

function createBrokerUploadUrl(brokerUrl, uploadId) {
  return `${brokerUrl}/${uploadId}`;
}

function createReservedCloudPath(mode, ownerKey, uploadId, extension) {
  const prefix = mode === "https-broker"
    ? "admin-staging"
    : "admin-direct-staging";
  return `${prefix}/${ownerKey}/${uploadId}/source${extension}`;
}

function createUploadCloudPath(
  mode,
  ownerKey,
  uploadId,
  extension,
  assetType,
  relatedId
) {
  // A free-tier cloud function cannot safely copy a recording or complete PDF
  // from staging into its durable location inside the execution budget.
  // Direct media therefore lands on its exact protected/publishable path up
  // front. Reader APIs still require a published database pointer, so landing
  // here does not make the object visible to members.
  if (
    mode === "cloud-storage-direct" &&
    ["audio", "full-book-pdf"].includes(assetType)
  ) {
    return derivePreparedCloudPath(assetType, relatedId, uploadId, extension);
  }
  return createReservedCloudPath(mode, ownerKey, uploadId, extension);
}

function usesClientManifestOnlySource(
  transportMode,
  assetType,
  extension
) {
  return Boolean(
    transportMode === "cloud-storage-direct" &&
    extension === ".docx" &&
    ["manuscript", "special-topic"].includes(assetType)
  );
}

function getExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function normalizedComparableFileName(value) {
  return normalizeText(value, 180)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isKnownChapterSourcePdf(value) {
  if (!value || value.assetType !== "full-book-pdf") {
    return false;
  }
  const fileName = normalizedComparableFileName(value.originalFileName);
  const shaValue = normalizeText(value.sha256, 64).toLowerCase();
  const fingerprints = Array.isArray(value.sourceFingerprints)
    ? value.sourceFingerprints
    : [];
  return Boolean(
    fileName.includes("食管癌的故事") ||
    KNOWN_CHAPTER_SOURCE_PDF_SHA256S.has(shaValue) ||
    fingerprints.some((item) =>
      KNOWN_CHAPTER_SOURCE_PDF_SHA256S.has(
        normalizeText(item && item.sha256, 64).toLowerCase()
      )
    )
  );
}

function knownChapterSourceRejection(value) {
  return isKnownChapterSourcePdf(value)
    ? {
        success: false,
        code: "BOOK_CHAPTER_SOURCE_NOT_COMPLETE",
        message: "“食管癌的故事”示例篇章 PDF 不是完整书稿，不能作为整书 PDF 上传"
      }
    : null;
}

function normalizeMimeType(value) {
  const mimeType = normalizeText(value, 120).toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    mimeType
  )
    ? mimeType
    : "";
}

function readRelationId(event, policy) {
  for (const field of policy.relationFields) {
    const candidate = normalizeText(event && event[field], 64);

    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function validateUploadDeclaration(event) {
  const assetType = normalizeText(event.assetType, 32).toLowerCase();
  const policy = ASSET_POLICIES[assetType];

  if (!policy) {
    return {
      success: false,
      code: "INVALID_ASSET_TYPE",
      message: "上传素材类型无效"
    };
  }

  const originalFileName = typeof event.fileName === "string"
    ? event.fileName.trim()
    : "";

  if (
    !originalFileName ||
    Array.from(originalFileName).length > 180 ||
    originalFileName === "." ||
    originalFileName === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(originalFileName)
  ) {
    return {
      success: false,
      code: "INVALID_FILE_NAME",
      message: "文件名无效"
    };
  }

  const knownChapterSource = knownChapterSourceRejection({
    assetType,
    originalFileName
  });
  if (knownChapterSource) {
    return knownChapterSource;
  }

  const extension = getExtension(originalFileName);
  const mimeType = normalizeMimeType(event.mimeType);

  if (
    extension === ".doc" &&
    ["manuscript", "special-topic"].includes(assetType)
  ) {
    return {
      success: false,
      code: "LEGACY_DOC_UNSUPPORTED",
      message: "旧版 .doc 暂不支持安全解析，请在 Word 中另存为 .docx 或导出为 PDF 后上传"
    };
  }

  const allowedMimeTypes = policy.formats[extension];

  if (!allowedMimeTypes || !allowedMimeTypes.includes(mimeType)) {
    return {
      success: false,
      code: "INVALID_FILE_FORMAT",
      message: "文件扩展名与MIME类型不符合该素材要求"
    };
  }

  const declaredBytes = Number(event.declaredBytes);

  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes <= 0 ||
    declaredBytes > policy.maximumBytes
  ) {
    return {
      success: false,
      code: "INVALID_FILE_SIZE",
      message: `声明文件大小应在1至${policy.maximumBytes}字节之间`
    };
  }

  const relatedId = readRelationId(event, policy);

  if (!RELATED_ID_PATTERN.test(relatedId)) {
    return {
      success: false,
      code: "INVALID_RELATED_ID",
      message: "关联内容编号无效"
    };
  }

  const hasClientDuration = Object.prototype.hasOwnProperty.call(
    event,
    "clientDurationSeconds"
  );
  if (assetType !== "audio" && hasClientDuration) {
    return {
      success: false,
      code: "INVALID_CLIENT_AUDIO_DURATION",
      message: "客户端测得时长只适用于录音上传"
    };
  }
  let clientDurationSeconds = null;
  if (assetType === "audio" && hasClientDuration) {
    clientDurationSeconds = event.clientDurationSeconds;
    if (
      typeof clientDurationSeconds !== "number" ||
      !Number.isFinite(clientDurationSeconds) ||
      clientDurationSeconds <= 0 ||
      clientDurationSeconds > MAX_CLIENT_AUDIO_DURATION_SECONDS
    ) {
      return {
        success: false,
        code: "INVALID_CLIENT_AUDIO_DURATION",
        message: "录音时长必须是大于 0 且不超过 24 小时的秒数"
      };
    }
  }

  return {
    success: true,
    assetType,
    originalFileName,
    extension,
    mimeType,
    declaredBytes,
    maximumBytes: policy.maximumBytes,
    relationKind: policy.relationKind,
    relatedId,
    clientDurationSeconds
  };
}

function parseCloudFileID(fileID) {
  if (
    typeof fileID !== "string" ||
    fileID.length > 2048 ||
    !fileID.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(fileID) ||
    fileID.includes("..")
  ) {
    return null;
  }

  const separator = fileID.indexOf("/", "cloud://".length);
  const environment = separator >= 0
    ? fileID.slice("cloud://".length, separator)
    : "";
  const cloudPath = separator >= 0 ? fileID.slice(separator + 1) : "";

  if (!environment || !cloudPath) {
    return null;
  }

  return { environment, cloudPath };
}

function publicUpload(upload) {
  const validationStatus = normalizeText(
    upload && upload.validationStatus,
    32
  );
  const directUpload = Boolean(
    upload && upload.transportMode === "cloud-storage-direct"
  );
  const directManifestUpload = Boolean(
    directUpload &&
    upload &&
    !["audio", "full-book-pdf"].includes(upload.assetType)
  );
  const imagePlan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const confirmedImageCount = clientImagePlanCount(imagePlan, "confirmed");
  const cleanupRemainingCount = Array.from(new Set(
    (
      Array.isArray(upload && upload.cleanupFileIDs)
        ? upload.cleanupFileIDs
        : [upload && upload.cleanupFileID]
    )
      .map((fileID) => normalizeText(fileID, 2048))
      .filter(Boolean)
  )).length;

  return {
    id: normalizeText(upload && upload._id, 32),
    assetType: normalizeText(upload && upload.assetType, 32),
    originalFileName: normalizeText(upload && upload.originalFileName, 180),
    extension: normalizeText(upload && upload.extension, 16),
    mimeType: normalizeText(upload && upload.mimeType, 120),
    declaredBytes: Number(upload && upload.declaredBytes) || 0,
    relationKind: normalizeText(upload && upload.relationKind, 32),
    relatedId: normalizeText(upload && upload.relatedId, 64),
    status: normalizeText(upload && upload.status, 32),
    reviewStatus: normalizeText(upload && upload.reviewStatus, 32),
    validationStatus,
    transportMode: normalizeText(upload && upload.transportMode, 32),
    transportStatus: normalizeText(upload && upload.transportStatus, 32),
    sourceMode:
      normalizeText(upload && upload.sourceMode, 32) || "original-file",
    originalFileUploadRequired:
      !upload || upload.originalFileUploadRequired !== false,
    requiresClientManifest: Boolean(
      directManifestUpload &&
      ["awaiting_upload", "awaiting_client_manifest"].includes(validationStatus)
    ),
    requiresClientImages:
      directUpload && validationStatus === "awaiting_client_images",
    clientImageCount: imagePlan.length,
    confirmedClientImageCount: confirmedImageCount,
    remainingClientImageCount: Math.max(
      0,
      imagePlan.length - confirmedImageCount
    ),
    cleanupRequired: Boolean(
      upload && upload.cleanupRequired && cleanupRemainingCount > 0
    ),
    cleanupRemainingCount,
    canCreateDraft: Boolean(
      upload &&
      (
        upload.validationStatus === "validated" ||
        isDirectAdminAttestedPreparedAssetReady(upload) ||
        isDirectClientManifestReady(upload)
      )
    ),
    rawFileValidationStatus: directUpload
      ? normalizeText(upload && upload.rawFileValidationStatus, 32) ||
        "unverified"
      : "validated",
    expiresAt: upload && upload.expiresAt || null,
    createdAt: upload && upload.createdAt || null,
    uploadedAt: upload && upload.uploadedAt || null
  };
}

async function resolveAdmin(openid) {
  const result = await db
    .collection("adminAccounts")
    .where({ openid, status: "active" })
    .limit(3)
    .get();
  const accounts = result && Array.isArray(result.data) ? result.data : [];
  const authorizedAccounts = accounts.filter((item) =>
    isAuthorizedAccount(item, openid)
  );

  if (authorizedAccounts.length > 1) {
    console.error("duplicate active admin accounts", {
      code: "ADMIN_ACCOUNT_CONFLICT",
      count: authorizedAccounts.length
    });
    return {
      success: false,
      code: "ADMIN_ACCOUNT_CONFLICT",
      message: "管理员账号配置冲突，请联系系统维护人员"
    };
  }

  const account = authorizedAccounts[0];

  if (!account) {
    return {
      success: false,
      code: "UPLOAD_FORBIDDEN",
      message: "当前微信没有内容上传权限"
    };
  }

  return {
    success: true,
    account,
    roles: getRoles(account)
  };
}

function revalidateAdmin(account, openid) {
  if (!isAuthorizedAccount(account, openid)) {
    return {
      success: false,
      code: "UPLOAD_FORBIDDEN",
      message: "内容上传权限已失效"
    };
  }

  return { success: true };
}

async function createUpload(event, admin, openid) {
  const authorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!authorization.success) {
    return authorization;
  }

  const declaration = validateUploadDeclaration(event);

  if (!declaration.success) {
    return declaration;
  }

  const brokerUrl = getUploadBrokerUrl();
  const transportMode = brokerUrl
    ? "https-broker"
    : "cloud-storage-direct";
  const manifestOnlySource = usesClientManifestOnlySource(
    transportMode,
    declaration.assetType,
    declaration.extension
  );
  const sourceMode = manifestOnlySource
    ? "client-manifest-only"
    : "original-file";
  const originalFileUploadRequired = !manifestOnlySource;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const uploadId = createUploadId();
    const ownerKey = createOwnerKey(admin.account._id);
    const cloudPath = manifestOnlySource
      ? ""
      : createUploadCloudPath(
          transportMode,
          ownerKey,
          uploadId,
          declaration.extension,
          declaration.assetType,
          declaration.relatedId
        );
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
    const uploadTicket = brokerUrl ? createUploadTicket() : "";
    const uploadTicketHash = brokerUrl ? hashUploadTicket(uploadTicket) : "";
    const rawResult = await db.runTransaction(async (transaction) => {
      const adminDocument = transaction
        .collection("adminAccounts")
        .doc(admin.account._id);
      const uploadDocument = transaction
        .collection("adminUploads")
        .doc(uploadId);
      // CloudBase transactions only allow one operation to be in flight at a time.
      // Keep every read sequential; Promise.all can surface as TransactionBusy in cloud.
      const transactionAdmin = await getDocumentOrNull(adminDocument);
      const existingUpload = await getDocumentOrNull(uploadDocument);
      const authorization = revalidateAdmin(transactionAdmin, openid);

      if (!authorization.success || !hasAnyRole(transactionAdmin, UPLOAD_ROLES)) {
        return {
          success: false,
          code: "UPLOAD_FORBIDDEN",
          message: "当前管理员没有内容上传权限"
        };
      }

      if (existingUpload) {
        return { success: false, code: "UPLOAD_ID_COLLISION" };
      }

      const createdAt = db.serverDate();
      const clientAttestedMetadata =
        declaration.assetType === "audio" &&
        declaration.clientDurationSeconds !== null
          ? {
              schemaVersion: 1,
              scope: "client-measured-audio-duration",
              source: "wechat-client-media-metadata",
              durationSeconds: declaration.clientDurationSeconds,
              adminAccountId: admin.account._id,
              attestedAt: createdAt
            }
          : null;
      await uploadDocument.set({
        data: {
          ownerAdminId: admin.account._id,
          ownerOpenid: openid,
          ownerKey,
          assetType: declaration.assetType,
          originalFileName: declaration.originalFileName,
          extension: declaration.extension,
          mimeType: declaration.mimeType,
          declaredBytes: declaration.declaredBytes,
          maximumBytes: declaration.maximumBytes,
          relationKind: declaration.relationKind,
          relatedId: declaration.relatedId,
          cloudPath,
          sourceMode,
          originalFileUploadRequired,
          uploadTicketHash,
          ticketStatus: brokerUrl ? "active" : "not_required",
          transportMode,
          transportStatus: brokerUrl
            ? "ticket_issued"
            : manifestOnlySource
              ? "direct_manifest_reserved"
              : "direct_reserved",
          status: "pending_upload",
          reviewStatus: "not_submitted",
          // Only the declaration is known at reservation time. The later
          // ingestion/review worker must inspect actual bytes, MIME signatures,
          // archive safety and document structure before anything is published.
          validationStatus: manifestOnlySource
            ? "awaiting_client_manifest"
            : "awaiting_upload",
          ...(manifestOnlySource
            ? { rawFileValidationStatus: "not_uploaded" }
            : {}),
          ...(clientAttestedMetadata ? { clientAttestedMetadata } : {}),
          expiresAt,
          createdAt,
          updateTime: createdAt,
          schemaVersion: 1
        }
      });

      return {
        success: true,
        upload: {
          id: uploadId,
          expiresAt,
          assetType: declaration.assetType,
          originalFileName: declaration.originalFileName,
          mimeType: declaration.mimeType,
          declaredBytes: declaration.declaredBytes,
          relationKind: declaration.relationKind,
          relatedId: declaration.relatedId,
          status: "pending_upload"
        }
      };
    });
    const result = unwrapTransactionResult(rawResult);

    if (result && result.code === "UPLOAD_ID_COLLISION") {
      continue;
    }

    if (result && result.success) {
      if (!brokerUrl) {
        return {
          ...result,
          uploadTransport: {
            directClientUploadAllowed: true,
            mode: "cloud-storage-direct",
            expiresAt,
            maximumBytes: declaration.maximumBytes,
            sourceMode,
            originalFileUploadRequired,
            ...(originalFileUploadRequired ? { cloudPath } : {}),
            requiresClientManifest:
              !["audio", "full-book-pdf"].includes(declaration.assetType)
          }
        };
      }

      return {
        ...result,
        uploadTransport: {
          directClientUploadAllowed: false,
          mode: "https-broker",
          url: createBrokerUploadUrl(brokerUrl, uploadId),
          ticket: uploadTicket,
          fieldName: "file",
          expiresAt,
          maximumBytes: declaration.maximumBytes,
          sourceMode,
          originalFileUploadRequired
        }
      };
    }

    return result;
  }

  return {
    success: false,
    code: "UPLOAD_ID_UNAVAILABLE",
    message: "暂时无法分配上传编号，请重试"
  };
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

async function createTemporaryFileURL(fileID) {
  if (typeof cloud.getTempFileURL !== "function") {
    return {
      success: false,
      code: "UPLOAD_VERIFICATION_UNAVAILABLE",
      message: "云存储文件核验能力不可用"
    };
  }

  try {
    const result = await cloud.getTempFileURL({
      fileList: [{ fileID, maxAge: 300 }]
    });
    const file = result && Array.isArray(result.fileList)
      ? result.fileList[0]
      : null;

    if (
      !file ||
      Number(file.status || 0) !== 0 ||
      !isSafeTemporaryURL(file.tempFileURL)
    ) {
      return {
        success: false,
        code: "UPLOADED_FILE_NOT_FOUND",
        message: "暂存文件不存在或无法读取"
      };
    }

    return { success: true, tempFileURL: file.tempFileURL };
  } catch (error) {
    console.error("adminContentCenter verify upload error:", error);
    return {
      success: false,
      code: "UPLOADED_FILE_NOT_FOUND",
      message: "暂存文件不存在或无法读取"
    };
  }
}

async function verifyUploadedFile(fileID) {
  const result = await createTemporaryFileURL(fileID);
  return result.success ? { success: true } : result;
}

async function verifyUploadedFiles(
  fileIDs,
  maxBatchSize = MAX_CLIENT_IMAGE_BATCH
) {
  const requested = Array.from(new Set(
    (Array.isArray(fileIDs) ? fileIDs : [])
      .map((fileID) => normalizeText(fileID, 2048))
      .filter(Boolean)
  ));
  const allowedBatchSize = Number.isInteger(maxBatchSize)
    ? Math.min(maxBatchSize, MAX_STORAGE_FILE_LOOKUP_BATCH)
    : MAX_CLIENT_IMAGE_BATCH;
  if (
    requested.length === 0 ||
    requested.length > allowedBatchSize ||
    typeof cloud.getTempFileURL !== "function"
  ) {
    return {
      success: false,
      code: "UPLOAD_VERIFICATION_UNAVAILABLE",
      message: "云存储图片核验能力不可用"
    };
  }

  try {
    const result = await cloud.getTempFileURL({
      fileList: requested.map((fileID) => ({ fileID, maxAge: 300 }))
    });
    const rows = result && Array.isArray(result.fileList)
      ? result.fileList
      : [];
    const existing = new Set(
      rows
        .filter((file) =>
          file &&
          requested.includes(file.fileID) &&
          Number(file.status || 0) === 0 &&
          isSafeTemporaryURL(file.tempFileURL)
        )
        .map((file) => file.fileID)
    );
    if (existing.size !== requested.length) {
      return {
        success: false,
        code: "CLIENT_IMAGE_NOT_FOUND",
        message: "一张或多张 Word 内嵌图片不存在或无法读取"
      };
    }
    return { success: true };
  } catch (error) {
    console.error("adminContentCenter verify client images error:", error);
    return {
      success: false,
      code: "CLIENT_IMAGE_NOT_FOUND",
      message: "一张或多张 Word 内嵌图片不存在或无法读取"
    };
  }
}

function isBrokerCompletedUpload(upload) {
  const fileID = normalizeText(upload && upload.fileID, 2048);
  const cloudPath = normalizeText(upload && upload.cloudPath, 512);
  const parsedFileID = parseCloudFileID(fileID);
  const inspection = upload && upload.inspection;

  return Boolean(
    upload &&
    upload.status === "uploaded" &&
    upload.ticketStatus === "consumed" &&
    upload.transportMode === "https-broker" &&
    upload.transportStatus === "broker_uploaded" &&
    upload.validationStatus === "validated" &&
    inspection &&
    inspection.schemaVersion === 1 &&
    inspection.signatureValid === true &&
    inspection.assetType === upload.assetType &&
    inspection.extension === upload.extension &&
    Number(inspection.actualBytes) === Number(upload.declaredBytes) &&
    Number(upload.actualBytes) === Number(upload.declaredBytes) &&
    /^[a-f0-9]{64}$/.test(normalizeText(upload.sha256, 64)) &&
    cloudPath.startsWith("admin-staging/") &&
    parsedFileID &&
    parsedFileID.cloudPath === cloudPath
  );
}

function directClientFileMatchesReservation(upload, fileID) {
  if (
    upload &&
    (
      upload.sourceMode === "client-manifest-only" ||
      upload.originalFileUploadRequired === false
    )
  ) {
    return false;
  }
  const parsedFileID = parseCloudFileID(fileID);
  const ownerAdminId = normalizeText(upload && upload.ownerAdminId, 128);
  const ownerKey = normalizeText(upload && upload.ownerKey, 64);
  const uploadId = normalizeText(upload && upload._id, 32).toLowerCase();
  const extension = normalizeText(upload && upload.extension, 16).toLowerCase();
  const expectedOwnerKey = ownerAdminId ? createOwnerKey(ownerAdminId) : "";
  const expectedCloudPath =
    UPLOAD_ID_PATTERN.test(uploadId) && extension
      ? createUploadCloudPath(
          "cloud-storage-direct",
          expectedOwnerKey,
          uploadId,
          extension,
          upload && upload.assetType,
          upload && upload.relatedId
        )
      : "";

  return Boolean(
    parsedFileID &&
    ownerKey === expectedOwnerKey &&
    upload.cloudPath === expectedCloudPath &&
    parsedFileID.cloudPath === expectedCloudPath
  );
}

function isClientManifestOnlySource(upload) {
  return Boolean(
    upload &&
    upload.sourceMode === "client-manifest-only" &&
    upload.originalFileUploadRequired === false &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.extension === ".docx" &&
    ["manuscript", "special-topic"].includes(upload.assetType) &&
    !normalizeText(upload.fileID, 2048) &&
    !normalizeText(upload.cloudPath, 512)
  );
}

function isClientManifestOnlyReservation(upload) {
  return Boolean(
    isClientManifestOnlySource(upload) &&
    upload.status === "pending_upload" &&
    upload.ticketStatus === "not_required" &&
    upload.transportStatus === "direct_manifest_reserved" &&
    upload.validationStatus === "awaiting_client_manifest" &&
    upload.rawFileValidationStatus === "not_uploaded"
  );
}

function isDirectAdminAttestedPreparedAssetReady(upload) {
  const fileID = normalizeText(upload && upload.fileID, 2048);
  const parsedFileID = parseCloudFileID(fileID);
  const verification = upload && upload.directVerification;
  const attestation = upload && upload.directAdminAttestation;
  const expectedPath = derivePreparedCloudPath(
    upload && upload.assetType,
    upload && upload.relatedId,
    upload && upload._id,
    upload && upload.extension
  );
  return Boolean(
    upload &&
    ["audio", "full-book-pdf"].includes(upload.assetType) &&
    upload.status === "uploaded" &&
    upload.ticketStatus === "not_required" &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.transportStatus === "direct_uploaded_unverified" &&
    upload.validationStatus === "admin_attested_unverified" &&
    upload.rawFileValidationStatus === "unverified" &&
    expectedPath &&
    upload.cloudPath === expectedPath &&
    upload.preparedCloudPath === expectedPath &&
    upload.preparedFileID === fileID &&
    parsedFileID &&
    parsedFileID.cloudPath === expectedPath &&
    directClientFileMatchesReservation(upload, fileID) &&
    verification &&
    verification.exactReservedPath === true &&
    verification.objectExists === true &&
    verification.actualBytesVerified === false &&
    verification.sha256Verified === false &&
    verification.structureVerified === false &&
    attestation &&
    attestation.scope === "exact-path-object-exists" &&
    attestation.adminAccountId === upload.ownerAdminId
  );
}

function clientAttestedAudioDuration(upload) {
  const metadata = upload && upload.clientAttestedMetadata;
  const durationSeconds = metadata && metadata.durationSeconds;
  return (
    upload &&
    upload.assetType === "audio" &&
    metadata &&
    metadata.schemaVersion === 1 &&
    metadata.scope === "client-measured-audio-duration" &&
    metadata.adminAccountId === upload.ownerAdminId &&
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds <= MAX_CLIENT_AUDIO_DURATION_SECONDS
  )
    ? durationSeconds
    : 0;
}

function isDirectClientConfirmedUpload(upload) {
  const fileID = normalizeText(upload && upload.fileID, 2048);

  return Boolean(
    upload &&
    upload.assetType !== "audio" &&
    upload.status === "uploaded_unverified" &&
    upload.ticketStatus === "not_required" &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.transportStatus === "direct_uploaded_unverified" &&
    upload.validationStatus === "awaiting_client_manifest" &&
    directClientFileMatchesReservation(upload, fileID)
  );
}

function createClientImageUploadPlan(upload, imagePlacements) {
  const uniqueImages = new Map();
  const uploadId = normalizeText(upload && upload._id, 32).toLowerCase();
  const relatedId = normalizeText(upload && upload.relatedId, 64).toLowerCase();
  const basePath = upload && upload.assetType === "special-topic"
    ? `protected/special-topics/${relatedId}/assets/${uploadId}/embedded`
    : `protected/contents/${relatedId}/assets/${uploadId}/embedded`;

  imagePlacements.forEach((placement) => {
    const imageOrder = Number(placement && placement.imageOrder);
    const extension = normalizeText(
      placement && placement.extension,
      8
    ).toLowerCase();
    if (!uniqueImages.has(imageOrder)) {
      uniqueImages.set(imageOrder, {
        imageOrder,
        relationId: normalizeText(placement && placement.relationId, 128),
        packagePath: normalizeText(placement && placement.packagePath, 512),
        extension,
        caption: normalizeText(placement && placement.caption, 300),
        cloudPath:
          `${basePath}/${String(imageOrder).padStart(4, "0")}` +
          extension,
        maximumBytes: ASSET_POLICIES["topic-image"].maximumBytes,
        status: "pending_upload"
      });
    }
  });

  return Array.from(uniqueImages.values()).sort(
    (left, right) => left.imageOrder - right.imageOrder
  );
}

function publicClientImageUploadPlan(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    imageOrder: Number(item && item.imageOrder) || 0,
    relationId: normalizeText(item && item.relationId, 128),
    packagePath: normalizeText(item && item.packagePath, 512),
    extension: normalizeText(item && item.extension, 8).toLowerCase(),
    caption: normalizeText(item && item.caption, 300),
    cloudPath: normalizeText(item && item.cloudPath, 512),
    maximumBytes: Number(item && item.maximumBytes) || 0,
    status: normalizeText(item && item.status, 32) || "pending_upload",
    confirmedAt: item && item.confirmedAt || null
  }));
}

function clientImageEnvironmentForUpload(upload) {
  const lockedEnvironment = normalizeText(
    upload && upload.clientImageEnvironment,
    128
  );
  if (
    lockedEnvironment &&
    !/[\s\\/\u0000-\u001f]/.test(lockedEnvironment)
  ) {
    return lockedEnvironment;
  }
  const source = parseCloudFileID(upload && upload.fileID);
  return source ? source.environment : "";
}

function clientImagePlanIsComplete(value, expectedEnvironment = "") {
  return Boolean(
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) =>
      item &&
      item.status === "confirmed" &&
      directClientImageFileMatchesPlan(
        item,
        item.fileID,
        "",
        expectedEnvironment
      )
    )
  );
}

function clientImagePlanCount(value, status) {
  return (Array.isArray(value) ? value : []).filter(
    (item) => item && item.status === status
  ).length;
}

function expectedClientImagePrefix(upload) {
  const uploadId = normalizeText(upload && upload._id, 32).toLowerCase();
  const relatedId = normalizeText(upload && upload.relatedId, 64).toLowerCase();
  if (
    !UPLOAD_ID_PATTERN.test(uploadId) ||
    !RELATED_ID_PATTERN.test(relatedId)
  ) {
    return "";
  }
  if (upload.assetType === "special-topic") {
    return `protected/special-topics/${relatedId}/assets/${uploadId}/embedded/`;
  }
  if (upload.assetType === "manuscript") {
    return `protected/contents/${relatedId}/assets/${uploadId}/embedded/`;
  }
  return "";
}

function directClientImageFileMatchesPlan(
  plan,
  fileID,
  sourceFileID = "",
  expectedEnvironment = ""
) {
  const parsed = parseCloudFileID(fileID);
  const sourceParsed = sourceFileID ? parseCloudFileID(sourceFileID) : null;
  const lockedEnvironment = normalizeText(expectedEnvironment, 128);
  const cloudPath = normalizeText(plan && plan.cloudPath, 512);
  const extension = normalizeText(plan && plan.extension, 8).toLowerCase();
  const imageOrder = Number(plan && plan.imageOrder);
  return Boolean(
    parsed &&
    (!sourceParsed || parsed.environment === sourceParsed.environment) &&
    (!lockedEnvironment || parsed.environment === lockedEnvironment) &&
    Number.isInteger(imageOrder) &&
    imageOrder >= 1 &&
    imageOrder <= 200 &&
    CLIENT_IMAGE_EXTENSIONS.has(extension) &&
    cloudPath.endsWith(
      `/embedded/${String(imageOrder).padStart(4, "0")}${extension}`
    ) &&
    parsed.cloudPath === cloudPath
  );
}

function cloudFileIDForPath(sourceFileID, cloudPath) {
  const parsed = parseCloudFileID(sourceFileID);
  const normalizedPath = normalizeText(cloudPath, 512);
  return parsed && normalizedPath
    ? `cloud://${parsed.environment}/${normalizedPath}`
    : "";
}

function cloudFileIDForEnvironment(environment, cloudPath) {
  const normalizedEnvironment = normalizeText(environment, 128);
  const normalizedPath = normalizeText(cloudPath, 512);
  return (
    normalizedEnvironment &&
    !/[\s\\/\u0000-\u001f]/.test(normalizedEnvironment) &&
    normalizedPath
  )
    ? `cloud://${normalizedEnvironment}/${normalizedPath}`
    : "";
}

function createEmbeddedAssets(upload) {
  const plan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  if (plan.length === 0) {
    return [];
  }
  const imageEnvironment = clientImageEnvironmentForUpload(upload);
  if (!imageEnvironment || !clientImagePlanIsComplete(plan, imageEnvironment)) {
    return null;
  }
  const prefix = expectedClientImagePrefix(upload);
  const assets = [];
  for (const item of plan) {
    const order = Number(item.imageOrder);
    const fileID = normalizeText(item.fileID, 2048);
    if (
      !prefix ||
      !item.cloudPath.startsWith(prefix) ||
      !directClientImageFileMatchesPlan(
        item,
        fileID,
        upload.fileID,
        imageEnvironment
      )
    ) {
      return null;
    }
    assets.push({
      id: `embedded-${String(order).padStart(4, "0")}`,
      order,
      fileID,
      cloudPath: item.cloudPath,
      extension: item.extension,
      packagePath: item.packagePath,
      caption: normalizeText(item.caption, 300),
      validationStatus: "object-exists-unverified"
    });
  }
  return assets.sort((left, right) => left.order - right.order);
}

function mergeEmbeddedImagesIntoPayload(
  assetType,
  payload,
  embeddedAssets,
  imagePlacements
) {
  const source = payload && typeof payload === "object" ? payload : {};
  const assets = Array.isArray(embeddedAssets) ? embeddedAssets : [];
  const placements = Array.isArray(imagePlacements) ? imagePlacements : [];
  if (assets.length === 0 && placements.length === 0) {
    return source;
  }
  const assetByOrder = new Map(assets.map((asset) => [asset.order, asset]));
  if (assets.length === 0 || placements.length === 0) {
    return null;
  }

  const expectedPlacementKind = assetType === "special-topic"
    ? "special-topic-entry"
    : assetType === "manuscript"
      ? "manuscript-section"
      : "";
  const placementIndexField = assetType === "special-topic"
    ? "entryIndex"
    : assetType === "manuscript"
      ? "sectionIndex"
      : "";
  if (!expectedPlacementKind || !placementIndexField) {
    return null;
  }
  const placementsByContainer = new Map();
  for (const placement of placements) {
    const location = placement && placement.location;
    const containerIndex = Number(location && location[placementIndexField]);
    if (
      !location ||
      location.kind !== expectedPlacementKind ||
      !Number.isInteger(containerIndex) ||
      containerIndex < 0
    ) {
      return null;
    }
    if (!placementsByContainer.has(containerIndex)) {
      placementsByContainer.set(containerIndex, []);
    }
    placementsByContainer.get(containerIndex).push(placement);
  }

  if (assetType === "special-topic") {
    const entries = (Array.isArray(source.entries) ? source.entries : []).map(
      (entry, entryIndex) => {
        const originalBlocks = Array.isArray(entry && entry.blocks)
          ? entry.blocks.filter((block) =>
              !(block && block.type === "image" && block.embeddedAssetId)
            )
          : [];
        const entryPlacements = (placementsByContainer.get(entryIndex) || [])
          .slice()
          .sort((left, right) =>
            Number(left.location.insertAtBlockIndex) -
              Number(right.location.insertAtBlockIndex) ||
            Number(left.sequence) - Number(right.sequence) ||
            Number(left.imageOrder) - Number(right.imageOrder)
          );
        const byInsertIndex = new Map();
        for (const placement of entryPlacements) {
          const asset = assetByOrder.get(Number(placement.imageOrder));
          const insertAt = Number(placement.location.insertAtBlockIndex);
          if (
            !asset ||
            !Number.isInteger(insertAt) ||
            insertAt < 0 ||
            insertAt > originalBlocks.length
          ) {
            return null;
          }
          if (!byInsertIndex.has(insertAt)) byInsertIndex.set(insertAt, []);
          byInsertIndex.get(insertAt).push({
            type: "image",
            embeddedAssetId: asset.id,
            caption: normalizeText(placement.caption, 300) || asset.caption
          });
        }
        const blocks = [];
        for (let index = 0; index <= originalBlocks.length; index += 1) {
          if (index > 0) blocks.push(originalBlocks[index - 1]);
          blocks.push(...(byInsertIndex.get(index) || []));
        }
        return { ...entry, blocks };
      }
    );
    if (entries.some((entry) => entry === null)) return null;
    return { ...source, entries, embeddedAssets: assets };
  }

  if (assetType === "manuscript") {
    const sections = (Array.isArray(source.sections) ? source.sections : []).map(
      (section, sectionIndex) => {
        const paragraphs = Array.isArray(section && section.paragraphs)
          ? section.paragraphs
          : [];
        const sectionPlacements = (placementsByContainer.get(sectionIndex) || [])
          .slice()
          .sort((left, right) =>
            Number(left.location.afterParagraphIndex) -
              Number(right.location.afterParagraphIndex) ||
            Number(left.sequence) - Number(right.sequence) ||
            Number(left.imageOrder) - Number(right.imageOrder)
          );
        const afterParagraph = new Map();
        for (const placement of sectionPlacements) {
          const asset = assetByOrder.get(Number(placement.imageOrder));
          const afterIndex = Number(placement.location.afterParagraphIndex);
          if (
            !asset ||
            !Number.isInteger(afterIndex) ||
            afterIndex < -1 ||
            afterIndex >= paragraphs.length
          ) {
            return null;
          }
          if (!afterParagraph.has(afterIndex)) afterParagraph.set(afterIndex, []);
          afterParagraph.get(afterIndex).push({
            type: "image",
            embeddedAssetId: asset.id,
            caption: normalizeText(placement.caption, 300) || asset.caption
          });
        }
        const blocks = [...(afterParagraph.get(-1) || [])];
        paragraphs.forEach((text, index) => {
          blocks.push({ type: "text", text });
          blocks.push(...(afterParagraph.get(index) || []));
        });
        return { ...section, blocks };
      }
    );
    if (sections.some((section) => section === null)) return null;
    return { ...source, sections, embeddedAssets: assets };
  }

  return null;
}

function isDirectClientManifestAttached(upload) {
  const validationStatus = normalizeText(
    upload && upload.validationStatus,
    32
  );
  const manifestMeta = upload && upload.clientManifestMeta;
  const manifestHash = normalizeText(
    upload && upload.clientManifestSha256,
    64
  );
  const imagePlan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const imageEnvironment = clientImageEnvironmentForUpload(upload);
  const imagePlanComplete = clientImagePlanIsComplete(
    imagePlan,
    imageEnvironment
  );
  const payloadPresent = Boolean(
    upload &&
    upload.clientDraftPayload &&
    typeof upload.clientDraftPayload === "object"
  );
  const payloadTransferred = Boolean(
    upload &&
    upload.clientDraftPayload === null &&
    upload.ingestionStatus === "draft_created" &&
    upload.draftId === upload._id
  );
  const sourceIsReady = isClientManifestOnlySource(upload)
    ? upload.rawFileValidationStatus === "not_uploaded"
    : (
        upload.rawFileValidationStatus === "unverified" &&
        directClientFileMatchesReservation(upload, upload.fileID)
      );

  return Boolean(
    upload &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.transportStatus === "direct_manifest_attached" &&
    sourceIsReady &&
    ["client_manifest_validated", "awaiting_client_images"].includes(
      validationStatus
    ) &&
    /^[a-f0-9]{64}$/.test(manifestHash) &&
    manifestMeta &&
    manifestMeta.schemaVersion === 1 &&
    (payloadPresent || payloadTransferred) &&
    (
      validationStatus === "awaiting_client_images"
        ? imagePlan.length > 0 &&
          (
            !imagePlan.some((item) => item && item.status === "confirmed") ||
            Boolean(imageEnvironment)
          ) &&
          !imagePlanComplete
        : imagePlan.length === 0 || imagePlanComplete
    )
  );
}

function isDirectClientManifestReady(upload) {
  return Boolean(
    isDirectClientManifestAttached(upload) &&
    upload.status === "uploaded" &&
    upload.validationStatus === "client_manifest_validated" &&
    upload.clientDraftPayload &&
    typeof upload.clientDraftPayload === "object" &&
    Array.isArray(upload.clientImageUploadPlan) &&
    (
      upload.clientImageUploadPlan.length === 0 ||
      clientImagePlanIsComplete(
        upload.clientImageUploadPlan,
        clientImageEnvironmentForUpload(upload)
      )
    )
  );
}

async function confirmUpload(event, admin, openid) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) {
    return roleAuthorization;
  }

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();

  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }

  const preliminaryUpload = await getDocumentOrNull(
    db.collection("adminUploads").doc(uploadId)
  );

  if (
    !preliminaryUpload ||
    preliminaryUpload.ownerAdminId !== admin.account._id ||
    preliminaryUpload.ownerOpenid !== openid
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }

  if (isClientManifestOnlySource(preliminaryUpload)) {
    return {
      success: false,
      code: "UPLOAD_ORIGINAL_NOT_REQUIRED",
      message:
        "This Word task imports a client manifest only; the original DOCX is not accepted or retained."
    };
  }

  const isBrokerUpload = preliminaryUpload.transportMode === "https-broker";

  if (isBrokerUpload && !isBrokerCompletedUpload(preliminaryUpload)) {
    return {
      success: false,
      code: "UPLOAD_NOT_BROKER_CONFIRMED",
      message: "上传代理尚未完成文件校验，请从原上传任务重试"
    };
  }

  const fileID = isBrokerUpload
    ? preliminaryUpload.fileID
    : normalizeText(event.fileID, 2048);

  if (
    !isBrokerUpload &&
    !directClientFileMatchesReservation(preliminaryUpload, fileID)
  ) {
    return {
      success: false,
      code: "UPLOAD_FILE_ID_MISMATCH",
      message: "云存储文件与该上传任务预留路径不一致"
    };
  }

  if (
    !isBrokerUpload &&
    !isDirectClientConfirmedUpload(preliminaryUpload) &&
    !isDirectClientManifestAttached(preliminaryUpload) &&
    !isDirectAdminAttestedPreparedAssetReady(preliminaryUpload) &&
    !isUnexpired(preliminaryUpload.expiresAt)
  ) {
    return {
      success: false,
      code: "UPLOAD_RESERVATION_EXPIRED",
      message: "上传预约已过期，请重新选择文件上传"
    };
  }

  const verification = await verifyUploadedFile(fileID);

  if (!verification.success) {
    return verification;
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const uploadDocument = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const transactionAdmin = await getDocumentOrNull(adminDocument);
    const upload = await getDocumentOrNull(uploadDocument);
    const authorization = revalidateAdmin(transactionAdmin, openid);

    if (!authorization.success || !hasAnyRole(transactionAdmin, UPLOAD_ROLES)) {
      return {
        success: false,
        code: "UPLOAD_FORBIDDEN",
        message: "当前管理员没有内容上传权限"
      };
    }

    if (
      !upload ||
      upload.ownerAdminId !== admin.account._id ||
      upload.ownerOpenid !== openid
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }

    if (isBrokerUpload) {
      if (!isBrokerCompletedUpload(upload)) {
        return {
          success: false,
          code: "UPLOAD_NOT_BROKER_CONFIRMED",
          message: "上传代理尚未完成文件校验，请从原上传任务重试"
        };
      }

      if (upload.fileID !== fileID) {
        return {
          success: false,
          code: "UPLOAD_STATE_CHANGED",
          message: "上传任务状态已变化，请刷新后重试"
        };
      }

      return {
        success: true,
        alreadyConfirmed: true,
        requiresClientManifest: false,
        upload: publicUpload(upload)
      };
    }

    if (upload.transportMode !== "cloud-storage-direct") {
      return {
        success: false,
        code: "UPLOAD_TRANSPORT_INVALID",
        message: "上传任务通道状态无效"
      };
    }

    if (isClientManifestOnlySource(upload)) {
      return {
        success: false,
        code: "UPLOAD_ORIGINAL_NOT_REQUIRED",
        message:
          "This Word task imports a client manifest only; the original DOCX is not accepted or retained."
      };
    }

    if (!directClientFileMatchesReservation(upload, fileID)) {
      return {
        success: false,
        code: "UPLOAD_FILE_ID_MISMATCH",
        message: "云存储文件与该上传任务预留路径不一致"
      };
    }

    if (isDirectAdminAttestedPreparedAssetReady(upload)) {
      const directAssetLabel =
        upload.assetType === "full-book-pdf" ? "整书 PDF" : "录音";
      return {
        success: true,
        alreadyConfirmed: true,
        requiresClientManifest: false,
        requiresClientImages: false,
        canCreateDraft: true,
        warning:
          `${directAssetLabel}仅确认精确云路径与对象存在，未校验实际字节、摘要或文件结构；必须经人工预览、复核和正式发布`,
        upload: publicUpload(upload)
      };
    }

    if (isDirectClientManifestAttached(upload)) {
      return {
        success: true,
        alreadyConfirmed: true,
        requiresClientManifest: false,
        requiresClientImages:
          upload.validationStatus === "awaiting_client_images",
        canCreateDraft: isDirectClientManifestReady(upload),
        upload: publicUpload(upload)
      };
    }

    if (isDirectClientConfirmedUpload(upload)) {
      return {
        success: true,
        alreadyConfirmed: true,
        requiresClientManifest: true,
        upload: publicUpload(upload)
      };
    }

    if (
      upload.status !== "pending_upload" ||
      upload.ticketStatus !== "not_required" ||
      upload.transportStatus !== "direct_reserved" ||
      upload.validationStatus !== "awaiting_upload"
    ) {
      return {
        success: false,
        code: "UPLOAD_STATE_CHANGED",
        message: "上传任务状态已变化，请刷新后重试"
      };
    }

    if (!isUnexpired(upload.expiresAt)) {
      return {
        success: false,
        code: "UPLOAD_RESERVATION_EXPIRED",
        message: "上传预约已过期，请重新选择文件上传"
      };
    }

    const now = db.serverDate();
    const directPreparedAsset =
      ["audio", "full-book-pdf"].includes(upload.assetType);
    const validationStatus = directPreparedAsset
      ? "admin_attested_unverified"
      : "awaiting_client_manifest";
    const status = directPreparedAsset ? "uploaded" : "uploaded_unverified";
    const preparedAsset = directPreparedAsset
      ? {
          preparedFileID: fileID,
          preparedCloudPath: upload.cloudPath,
          directAdminAttestation: {
            scope: "exact-path-object-exists",
            adminAccountId: transactionAdmin._id,
            attestedAt: now,
            ...(clientAttestedAudioDuration(upload)
              ? {
                  clientDurationSeconds:
                    clientAttestedAudioDuration(upload),
                  clientDurationSource:
                    "client-measured-audio-duration"
                }
              : {}),
            actualBytesVerified: false,
            sha256Verified: false,
            structureVerified: false
          }
        }
      : {};
    const directVerification = {
      exactReservedPath: true,
      objectExists: true,
      actualBytesVerified: false,
      sha256Verified: false,
      structureVerified: false
    };
    await uploadDocument.update({
      data: {
        fileID,
        ...preparedAsset,
        status,
        transportStatus: "direct_uploaded_unverified",
        validationStatus,
        rawFileValidationStatus: "unverified",
        directVerification,
        uploadedAt: now,
        updateTime: now
      }
    });
    const confirmedUpload = {
      ...upload,
      fileID,
      ...preparedAsset,
      status,
      transportStatus: "direct_uploaded_unverified",
      validationStatus,
      rawFileValidationStatus: "unverified",
      directVerification,
      uploadedAt: now,
      updateTime: now
    };

    return {
      success: true,
      alreadyConfirmed: false,
      requiresClientManifest: !directPreparedAsset,
      requiresClientImages: false,
      canCreateDraft: directPreparedAsset,
      warning: directPreparedAsset
        ? `${upload.assetType === "full-book-pdf" ? "整书 PDF" : "录音"}仅确认精确云路径与对象存在，未校验实际字节、摘要或文件结构；必须经人工预览、复核和正式发布`
        : "文件仅完成私有云存储落盘，尚未通过结构化内容校验，不能进入审核或发布",
      upload: publicUpload(confirmedUpload)
    };
  });

  return unwrapTransactionResult(rawResult);
}

async function attachClientManifest(event, admin, openid) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) {
    return roleAuthorization;
  }

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }

  const mutation = validateMutationRequest(event);
  if (!mutation.success) {
    return mutation;
  }

  const preliminaryUpload = await getDocumentOrNull(
    db.collection("adminUploads").doc(uploadId)
  );
  if (
    !preliminaryUpload ||
    preliminaryUpload.ownerAdminId !== admin.account._id ||
    preliminaryUpload.ownerOpenid !== openid
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }
  if (
    preliminaryUpload.transportMode !== "cloud-storage-direct" ||
    preliminaryUpload.extension !== ".docx" ||
    !["manuscript", "special-topic"].includes(preliminaryUpload.assetType)
  ) {
    return {
      success: false,
      code: "CLIENT_MANIFEST_SOURCE_UNSUPPORTED",
      message: "本地 Word 解析结果只能绑定直传的书稿或小专题 .docx 原件"
    };
  }
  if (
    !isDirectClientConfirmedUpload(preliminaryUpload) &&
    !isClientManifestOnlyReservation(preliminaryUpload) &&
    !isDirectClientManifestAttached(preliminaryUpload)
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_READY_FOR_MANIFEST",
      message: "请先完成原件直传和文件确认"
    };
  }
  if (
    isClientManifestOnlyReservation(preliminaryUpload) &&
    !isUnexpired(preliminaryUpload.expiresAt)
  ) {
    return {
      success: false,
      code: "UPLOAD_RESERVATION_EXPIRED",
      message: "The Word manifest reservation has expired; create a new task."
    };
  }

  let converted;
  try {
    converted = validateAndConvertClientManifest(
      preliminaryUpload.assetType,
      event.manifest
    );
  } catch (error) {
    if (error instanceof ClientManifestError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
        details: error.details || null
      };
    }
    throw error;
  }

  const rawDraftPayload = preliminaryUpload.assetType === "manuscript"
    ? {
        ...converted.clientDraftPayload,
        bookId: "china-hospital-ship"
      }
    : converted.clientDraftPayload;
  const clientDraftPayload = normalizePayload(
    preliminaryUpload.assetType,
    rawDraftPayload,
    {
      targetId: preliminaryUpload.relatedId,
      mimeType: preliminaryUpload.mimeType
    }
  );
  const hasUsablePayload = Boolean(
    clientDraftPayload &&
    (
      (
        preliminaryUpload.assetType === "manuscript" &&
        Array.isArray(clientDraftPayload.sections) &&
        clientDraftPayload.sections.length > 0
      ) ||
      (
        preliminaryUpload.assetType === "special-topic" &&
        Array.isArray(clientDraftPayload.entries) &&
        clientDraftPayload.entries.length > 0
      )
    )
  );
  if (!hasUsablePayload) {
    return {
      success: false,
      code: "CLIENT_MANIFEST_CONVERSION_INVALID",
      message: "Word 正文转换后超出草稿结构限制，请拆分文稿后重试"
    };
  }

  const imagePlacements = converted.imagePlacements;
  const imageUploadPlan = createClientImageUploadPlan(
    preliminaryUpload,
    imagePlacements
  );
  const storedBundle = {
    clientDraftPayload,
    clientImagePlacements: imagePlacements,
    clientImageUploadPlan: imageUploadPlan,
    clientImportStats: converted.importStats,
    clientManifestMeta: converted.manifestMeta,
    clientManifestSha256: converted.manifestSha256,
    clientManifestHashScope: converted.hashScope
  };
  const storedBundleBytes = Buffer.byteLength(
    canonicalStringify(storedBundle),
    "utf8"
  );
  if (storedBundleBytes > MAX_CANONICAL_MANIFEST_BYTES) {
    return {
      success: false,
      code: "MANIFEST_TOO_LARGE",
      message: "转换后的正文超过安全入库上限，请拆成多篇书稿或多个小专题后上传",
      details: {
        maximumBytes: MAX_CANONICAL_MANIFEST_BYTES,
        actualBytes: storedBundleBytes
      }
    };
  }

  const requestHash = sha256(canonicalStringify({
    action: "attachClientManifest",
    uploadId,
    manifestSha256: converted.manifestSha256,
    hashScope: converted.hashScope
  }));
  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const uploadDocument = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const transactionAdmin = await getDocumentOrNull(adminDocument);
    const upload = await getDocumentOrNull(uploadDocument);
    const authorization = revalidateAdmin(transactionAdmin, openid);

    if (!authorization.success || !hasAnyRole(transactionAdmin, UPLOAD_ROLES)) {
      return {
        success: false,
        code: "UPLOAD_FORBIDDEN",
        message: "当前管理员没有内容上传权限"
      };
    }
    if (
      !upload ||
      upload.ownerAdminId !== admin.account._id ||
      upload.ownerOpenid !== openid
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }

    const previousMutation = upload.clientManifestMutation;
    if (
      previousMutation &&
      previousMutation.requestId === mutation.requestId &&
      (
        previousMutation.action !== "attachClientManifest" ||
        previousMutation.requestHash !== requestHash
      )
    ) {
      return {
        success: false,
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "同一请求编号不能用于不同的 Word 解析结果"
      };
    }

    if (isDirectClientManifestAttached(upload)) {
      if (upload.clientManifestSha256 !== converted.manifestSha256) {
        return {
          success: false,
          code: "CLIENT_MANIFEST_ALREADY_ATTACHED",
          message: "该上传任务已绑定另一份 Word 解析结果，请新建上传任务"
        };
      }
      return {
        success: true,
        alreadyApplied: true,
        requiresClientManifest: false,
        requiresClientImages:
          upload.validationStatus === "awaiting_client_images",
        canCreateDraft: isDirectClientManifestReady(upload),
        manifestSha256: upload.clientManifestSha256,
        hashScope: upload.clientManifestHashScope,
        importStats: upload.clientImportStats,
        imagePlacements: upload.clientImagePlacements,
        imageUploadPlan: publicClientImageUploadPlan(
          upload.clientImageUploadPlan
        ),
        upload: publicUpload(upload)
      };
    }

    const manifestOnlyReservation = isClientManifestOnlyReservation(upload);
    if (
      !isDirectClientConfirmedUpload(upload) &&
      !manifestOnlyReservation
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_READY_FOR_MANIFEST",
        message: "请先完成原件直传和文件确认"
      };
    }
    if (manifestOnlyReservation && !isUnexpired(upload.expiresAt)) {
      return {
        success: false,
        code: "UPLOAD_RESERVATION_EXPIRED",
        message: "The Word manifest reservation has expired; create a new task."
      };
    }

    const requiresClientImages = imageUploadPlan.length > 0;
    const validationStatus = requiresClientImages
      ? "awaiting_client_images"
      : "client_manifest_validated";
    const status = requiresClientImages ? "uploaded_unverified" : "uploaded";
    const now = db.serverDate();
    const update = {
      ...storedBundle,
      clientDraftPayloadBytes: storedBundleBytes,
      clientManifestMutation: createLastMutation(
        "attachClientManifest",
        mutation.requestId,
        requestHash
      ),
      clientManifestAttachedAt: now,
      rawFileValidationStatus: manifestOnlyReservation
        ? "not_uploaded"
        : "unverified",
      clientImageEnvironment: manifestOnlyReservation
        ? ""
        : clientImageEnvironmentForUpload(upload),
      status,
      transportStatus: "direct_manifest_attached",
      validationStatus,
      updateTime: now
    };
    if (!requiresClientImages) {
      const readyUpload = { ...upload, ...update };
      update.draftCreationSourceFingerprint =
        draftCreationUploadFingerprint(readyUpload);
      update.draftCreationSourceFingerprintVersion = 1;
    } else {
      update.draftCreationSourceFingerprint = "";
      update.draftCreationSourceFingerprintVersion = 0;
    }
    await uploadDocument.update({ data: update });
    const updatedUpload = { ...upload, ...update };

    return {
      success: true,
      alreadyApplied: false,
      requiresClientManifest: false,
      requiresClientImages,
      canCreateDraft: !requiresClientImages,
      manifestSha256: converted.manifestSha256,
      hashScope: converted.hashScope,
      importStats: converted.importStats,
      imagePlacements,
      imageUploadPlan: publicClientImageUploadPlan(imageUploadPlan),
      warning: requiresClientImages
        ? "Word 正文已校验，但内嵌图片尚未上传并确认，暂时不能创建草稿"
        : "Word 正文结构已校验；原始 DOCX 文件本身仍未做服务端字节级校验",
      upload: publicUpload(updatedUpload)
    };
  });

  return unwrapTransactionResult(rawResult);
}

function normalizeClientImageConfirmationFiles(value, upload) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_CLIENT_IMAGE_BATCH
  ) {
    return {
      success: false,
      code: "CLIENT_IMAGE_BATCH_INVALID",
      message: `每批必须确认 1 至 ${MAX_CLIENT_IMAGE_BATCH} 张 Word 内嵌图片`
    };
  }
  const plan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const planByOrder = new Map(
    plan.map((item) => [Number(item && item.imageOrder), item])
  );
  const seenOrders = new Set();
  const seenFileIDs = new Set();
  const files = [];
  const lockedEnvironment = clientImageEnvironmentForUpload(upload);
  let batchEnvironment = "";

  for (const rawFile of value) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      return {
        success: false,
        code: "CLIENT_IMAGE_CONFIRMATION_INVALID",
        message: "Word 内嵌图片确认参数无效"
      };
    }
    if (
      Object.keys(rawFile).some((key) =>
        ![
          "imageOrder",
          "order",
          "packagePath",
          "extension",
          "cloudPath",
          "fileID"
        ].includes(key)
      )
    ) {
      return {
        success: false,
        code: "CLIENT_IMAGE_CONFIRMATION_INVALID",
        message: "Word 内嵌图片确认参数包含未知字段"
      };
    }
    const imageOrder = Number(
      rawFile.imageOrder === undefined ? rawFile.order : rawFile.imageOrder
    );
    if (
      rawFile.imageOrder !== undefined &&
      rawFile.order !== undefined &&
      Number(rawFile.imageOrder) !== Number(rawFile.order)
    ) {
      return {
        success: false,
        code: "CLIENT_IMAGE_CONFIRMATION_INVALID",
        message: "Word 内嵌图片序号不一致"
      };
    }
    const planned = planByOrder.get(imageOrder);
    const packagePath = normalizeText(rawFile.packagePath, 512);
    const extension = normalizeText(rawFile.extension, 8).toLowerCase();
    const cloudPath = normalizeText(rawFile.cloudPath, 512);
    const fileID = normalizeText(rawFile.fileID, 2048);
    const parsedFileID = parseCloudFileID(fileID);
    const fileEnvironment = parsedFileID
      ? parsedFileID.environment
      : "";
    if (
      !planned ||
      seenOrders.has(imageOrder) ||
      seenFileIDs.has(fileID) ||
      !fileEnvironment ||
      (lockedEnvironment && fileEnvironment !== lockedEnvironment) ||
      (batchEnvironment && fileEnvironment !== batchEnvironment) ||
      packagePath !== planned.packagePath ||
      extension !== planned.extension ||
      cloudPath !== planned.cloudPath ||
      !cloudPath.startsWith(expectedClientImagePrefix(upload)) ||
      !directClientImageFileMatchesPlan(planned, fileID, upload.fileID)
    ) {
      return {
        success: false,
        code: "CLIENT_IMAGE_CONFIRMATION_INVALID",
        message: "Word 内嵌图片与服务端上传计划不一致"
      };
    }
    batchEnvironment = batchEnvironment || fileEnvironment;
    seenOrders.add(imageOrder);
    seenFileIDs.add(fileID);
    files.push({
      imageOrder,
      packagePath,
      extension,
      cloudPath,
      fileID
    });
  }

  files.sort((left, right) => left.imageOrder - right.imageOrder);
  return {
    success: true,
    files,
    environment: lockedEnvironment || batchEnvironment
  };
}

function clientImageConfirmationResult(upload, options = {}) {
  const plan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const confirmedCount = clientImagePlanCount(plan, "confirmed");
  const totalCount = plan.length;
  const remainingCount = Math.max(0, totalCount - confirmedCount);
  const complete = totalCount > 0 && remainingCount === 0;
  return {
    success: true,
    alreadyApplied: options.alreadyApplied === true,
    confirmedCount,
    totalCount,
    remainingCount,
    complete,
    requiresClientImages: !complete,
    validationStatus: normalizeText(upload && upload.validationStatus, 32),
    canCreateDraft: complete && isDirectClientManifestReady(upload),
    imageUploadPlan: publicClientImageUploadPlan(plan),
    upload: publicUpload(upload)
  };
}

async function confirmClientImages(event, admin, openid, options = {}) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) {
    return roleAuthorization;
  }

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;

  const preliminaryUpload = await getDocumentOrNull(
    db.collection("adminUploads").doc(uploadId)
  );
  if (
    !preliminaryUpload ||
    preliminaryUpload.ownerAdminId !== admin.account._id ||
    preliminaryUpload.ownerOpenid !== openid
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }
  if (
    preliminaryUpload.transportMode !== "cloud-storage-direct" ||
    !["manuscript", "special-topic"].includes(preliminaryUpload.assetType) ||
    !isDirectClientManifestAttached(preliminaryUpload) ||
    !Array.isArray(preliminaryUpload.clientImageUploadPlan) ||
    preliminaryUpload.clientImageUploadPlan.length === 0
  ) {
    return {
      success: false,
      code: "CLIENT_IMAGE_CONFIRMATION_NOT_ALLOWED",
      message: "当前上传任务没有可确认的 Word 内嵌图片"
    };
  }

  const normalized = normalizeClientImageConfirmationFiles(
    event.files,
    preliminaryUpload
  );
  if (!normalized.success) return normalized;
  const files = normalized.files;
  const mutationAction = options.mutationAction === "resumeClientImages"
    ? "resumeClientImages"
    : "confirmClientImages";
  const requestHash = normalizeText(options.requestHash, 64) || sha256(
    canonicalStringify({
      action: mutationAction,
      uploadId,
      files
    })
  );
  const preliminaryMutations = Array.isArray(
    preliminaryUpload.clientImageMutations
  )
    ? preliminaryUpload.clientImageMutations
    : [];
  const preliminaryReplay = preliminaryMutations.find(
    (item) => item && item.requestId === mutation.requestId
  );
  if (
    preliminaryReplay &&
    preliminaryReplay.requestHash !== requestHash
  ) {
    return {
      success: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "同一请求编号不能用于不同的图片确认批次"
    };
  }

  const planByOrder = new Map(
    preliminaryUpload.clientImageUploadPlan.map(
      (item) => [Number(item.imageOrder), item]
    )
  );
  for (const file of files) {
    const planned = planByOrder.get(file.imageOrder);
    if (
      planned.status === "confirmed" &&
      planned.fileID !== file.fileID
    ) {
      return {
        success: false,
        code: "CLIENT_IMAGE_ALREADY_CONFIRMED",
        message: "该 Word 内嵌图片已经绑定另一份云存储文件"
      };
    }
  }
  const unconfirmedFileIDs = files
    .filter((file) => planByOrder.get(file.imageOrder).status !== "confirmed")
    .map((file) => file.fileID);
  if (unconfirmedFileIDs.length > 0) {
    const verification = await verifyUploadedFiles(unconfirmedFileIDs);
    if (!verification.success) return verification;
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const uploadDocument = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const transactionAdmin = await getDocumentOrNull(adminDocument);
    const upload = await getDocumentOrNull(uploadDocument);
    if (
      !isAuthorizedAccount(transactionAdmin, openid) ||
      !hasAnyRole(transactionAdmin, UPLOAD_ROLES)
    ) {
      return {
        success: false,
        code: "UPLOAD_FORBIDDEN",
        message: "当前管理员没有内容上传权限"
      };
    }
    if (
      !upload ||
      upload.ownerAdminId !== admin.account._id ||
      upload.ownerOpenid !== openid
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }
    if (
      upload.transportMode !== "cloud-storage-direct" ||
      !["manuscript", "special-topic"].includes(upload.assetType) ||
      !isDirectClientManifestAttached(upload)
    ) {
      return {
        success: false,
        code: "CLIENT_IMAGE_CONFIRMATION_NOT_ALLOWED",
        message: "当前上传任务没有可确认的 Word 内嵌图片"
      };
    }

    const currentNormalized = normalizeClientImageConfirmationFiles(
      files,
      upload
    );
    if (!currentNormalized.success) return currentNormalized;
    const mutations = Array.isArray(upload.clientImageMutations)
      ? upload.clientImageMutations
      : [];
    const priorMutation = mutations.find(
      (item) => item && item.requestId === mutation.requestId
    );
    if (priorMutation && priorMutation.requestHash !== requestHash) {
      return {
        success: false,
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "同一请求编号不能用于不同的图片确认批次"
      };
    }
    if (priorMutation && priorMutation.requestHash === requestHash) {
      return clientImageConfirmationResult(upload, {
        alreadyApplied: true
      });
    }

    const filesByOrder = new Map(
      currentNormalized.files.map((file) => [file.imageOrder, file])
    );
    const now = db.serverDate();
    let newlyConfirmed = 0;
    const updatedPlan = upload.clientImageUploadPlan.map((item) => {
      const file = filesByOrder.get(Number(item.imageOrder));
      if (!file) return item;
      if (item.status === "confirmed") {
        if (item.fileID !== file.fileID) {
          return { ...item, _confirmationConflict: true };
        }
        return item;
      }
      newlyConfirmed += 1;
      return {
        ...item,
        status: "confirmed",
        fileID: file.fileID,
        confirmedAt: now,
        objectExistsVerified: true,
        actualBytesVerified: false,
        signatureVerified: false
      };
    });
    if (updatedPlan.some((item) => item._confirmationConflict)) {
      return {
        success: false,
        code: "CLIENT_IMAGE_ALREADY_CONFIRMED",
        message: "该 Word 内嵌图片已经绑定另一份云存储文件"
      };
    }
    const imageEnvironment = currentNormalized.environment;
    const complete = clientImagePlanIsComplete(
      updatedPlan,
      imageEnvironment
    );
    const nextMutations = mutations
      .slice(-(MAX_CLIENT_IMAGE_MUTATIONS - 1))
      .concat([{
        action: mutationAction,
        requestId: mutation.requestId,
        requestHash,
        imageOrders: currentNormalized.files.map((file) => file.imageOrder),
        newlyConfirmed,
        confirmedAt: now
      }]);
    const update = {
      clientImageUploadPlan: updatedPlan,
      clientImageEnvironment: imageEnvironment,
      clientImageMutations: nextMutations,
      status: complete ? "uploaded" : "uploaded_unverified",
      validationStatus: complete
        ? "client_manifest_validated"
        : "awaiting_client_images",
      clientImagesConfirmedAt: complete ? now : null,
      updateTime: now
    };
    if (complete) {
      const readyUpload = { ...upload, ...update };
      update.draftCreationSourceFingerprint =
        draftCreationUploadFingerprint(readyUpload);
      update.draftCreationSourceFingerprintVersion = 1;
    } else {
      update.draftCreationSourceFingerprint = "";
      update.draftCreationSourceFingerprintVersion = 0;
    }
    await uploadDocument.update({ data: update });
    return clientImageConfirmationResult(
      { ...upload, ...update },
      { alreadyApplied: newlyConfirmed === 0 }
    );
  });

  return unwrapTransactionResult(rawResult);
}

function resumableClientImageEnvironment(upload) {
  const lockedEnvironment = clientImageEnvironmentForUpload(upload);
  if (lockedEnvironment) return lockedEnvironment;

  const environments = new Set(
    (Array.isArray(upload && upload.clientImageUploadPlan)
      ? upload.clientImageUploadPlan
      : []
    )
      .map((item) => parseCloudFileID(item && item.fileID))
      .filter(Boolean)
      .map((item) => item.environment)
  );
  return environments.size === 1 ? Array.from(environments)[0] : "";
}

function resumableClientImageFiles(upload, environment) {
  const expectedPrefix = expectedClientImagePrefix(upload);
  if (!expectedPrefix || !environment) return [];

  return (Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : []
  )
    .filter((item) => item && item.status !== "confirmed")
    .sort((left, right) =>
      Number(left && left.imageOrder) - Number(right && right.imageOrder)
    )
    .slice(0, MAX_CLIENT_IMAGE_BATCH)
    .map((item) => ({
      imageOrder: Number(item.imageOrder),
      packagePath: normalizeText(item.packagePath, 512),
      extension: normalizeText(item.extension, 8).toLowerCase(),
      cloudPath: normalizeText(item.cloudPath, 512),
      fileID: cloudFileIDForEnvironment(environment, item.cloudPath)
    }))
    .filter((item) =>
      item.cloudPath.startsWith(expectedPrefix) &&
      directClientImageFileMatchesPlan(item, item.fileID, "", environment)
    );
}

async function resumeClientImages(event, admin, openid) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) return roleAuthorization;

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;

  const upload = await getDocumentOrNull(
    db.collection("adminUploads").doc(uploadId)
  );
  if (
    !upload ||
    upload.ownerAdminId !== admin.account._id ||
    upload.ownerOpenid !== openid
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }

  const requestHash = sha256(canonicalStringify({
    action: "resumeClientImages",
    uploadId
  }));
  const mutations = Array.isArray(upload.clientImageMutations)
    ? upload.clientImageMutations
    : [];
  const priorMutation = mutations.find(
    (item) => item && item.requestId === mutation.requestId
  );
  if (priorMutation && priorMutation.requestHash !== requestHash) {
    return {
      success: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "同一请求编号不能用于不同的图片续确认操作"
    };
  }
  if (priorMutation && priorMutation.requestHash === requestHash) {
    return {
      ...clientImageConfirmationResult(upload, { alreadyApplied: true }),
      resumedCount: 0
    };
  }

  if (
    upload.transportMode !== "cloud-storage-direct" ||
    !["manuscript", "special-topic"].includes(upload.assetType) ||
    !isDirectClientManifestAttached(upload) ||
    !Array.isArray(upload.clientImageUploadPlan) ||
    upload.clientImageUploadPlan.length === 0
  ) {
    return {
      success: false,
      code: "CLIENT_IMAGE_CONFIRMATION_NOT_ALLOWED",
      message: "当前上传任务没有可续确认的 Word 内嵌图片"
    };
  }

  const currentProgress = clientImageConfirmationResult(upload);
  if (currentProgress.complete) {
    return {
      ...currentProgress,
      alreadyApplied: true,
      resumedCount: 0
    };
  }
  if (upload.validationStatus !== "awaiting_client_images") {
    return {
      success: false,
      code: "CLIENT_IMAGE_RESUME_NOT_ALLOWED",
      message: "当前上传任务不处于内嵌图片待确认状态"
    };
  }

  const environment = resumableClientImageEnvironment(upload);
  if (!environment) {
    return {
      success: false,
      code: "CLIENT_IMAGE_ENVIRONMENT_UNAVAILABLE",
      message: "尚未建立可信云环境，无法从服务端续确认图片"
    };
  }
  const files = resumableClientImageFiles(upload, environment);
  if (
    files.length === 0 ||
    files.length !== Math.min(
      MAX_CLIENT_IMAGE_BATCH,
      currentProgress.remainingCount
    )
  ) {
    return {
      success: false,
      code: "CLIENT_IMAGE_RESUME_PLAN_INVALID",
      message: "Word 内嵌图片续确认计划无效"
    };
  }

  const result = await confirmClientImages(
    {
      action: "confirmClientImages",
      uploadId,
      requestId: mutation.requestId,
      files
    },
    admin,
    openid,
    {
      mutationAction: "resumeClientImages",
      requestHash
    }
  );
  return result && result.success
    ? { ...result, resumedCount: files.length }
    : result;
}

async function listUploads(event, admin) {
  const authorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!authorization.success) {
    return authorization;
  }

  const offset = normalizeInteger(event.offset, 0, 0, MAX_OFFSET);
  const limit = normalizeInteger(
    event.limit,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  const result = await db
    .collection("adminUploads")
    .where({ ownerAdminId: admin.account._id })
    .orderBy("createdAt", "desc")
    .orderBy("_id", "desc")
    .skip(offset)
    .limit(limit + 1)
    .get();

  if (!result || !Array.isArray(result.data)) {
    throw new Error("adminUploads query returned an invalid result");
  }

  const hasMore = result.data.length > limit;
  const uploads = result.data.slice(0, limit).map(publicUpload);
  const nextOffset = hasMore ? offset + uploads.length : null;

  return {
    success: true,
    uploads,
    offset,
    limit,
    hasMore: nextOffset !== null,
    nextOffset
  };
}

async function listUploadTargets(event, admin) {
  const authorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!authorization.success) {
    return authorization;
  }

  const targetType = normalizeText(event.targetType, 32).toLowerCase();
  if (!["content", "special-topic", "book"].includes(targetType)) {
    return {
      success: false,
      code: "INVALID_TARGET_TYPE",
      message: "上传目标类型无效"
    };
  }
  const limit = normalizeInteger(
    event.limit,
    MAX_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  const collectionName = targetType === "content"
    ? "contents"
    : targetType === "special-topic"
      ? "specialTopics"
      : "books";
  const idField = targetType === "content"
    ? "contentId"
    : targetType === "special-topic"
      ? "topicId"
      : "bookId";
  const result = await db
    .collection(collectionName)
    .where({ status: "published" })
    .orderBy("publishedAt", "desc")
    .orderBy("_id", "desc")
    .limit(targetType === "book" ? limit + 1 : limit)
    .get();
  if (!result || !Array.isArray(result.data)) {
    throw new Error(`${collectionName} query returned an invalid result`);
  }
  const targets = result.data
    .map((item) => {
      const id = normalizeText(item && (item[idField] || item._id), 64)
        .toLowerCase();
      const title = normalizeText(item && item.title, 160);
      const subtitle = normalizeText(
        item && (item.subtitle || item.summary),
        240
      );
      if (!RELATED_ID_PATTERN.test(id) || !title) {
        return null;
      }
      return {
        id,
        title,
        ...(subtitle ? { subtitle } : {})
      };
    })
    .filter(Boolean);
  if (
    targetType === "book" &&
    !targets.some((item) => item.id === DEFAULT_BOOK_ID)
  ) {
    const configuredDefault = await getDocumentOrNull(
      db.collection("books").doc(DEFAULT_BOOK_ID)
    );
    targets.unshift({
      id: DEFAULT_BOOK_ID,
      title: normalizeText(configuredDefault && configuredDefault.title, 160) ||
        "中国医院船",
      ...(
        normalizeText(configuredDefault && configuredDefault.subtitle, 240)
          ? {
              subtitle: normalizeText(
                configuredDefault && configuredDefault.subtitle,
                240
              )
            }
          : {}
      )
    });
  }
  return {
    success: true,
    targetType,
    targets: targets.slice(0, limit)
  };
}

function clientImageCleanupFileIDs(upload) {
  const plan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const expectedPrefix = expectedClientImagePrefix(upload);
  const imageEnvironment = clientImageEnvironmentForUpload(upload);
  const result = [];
  for (const item of plan) {
    if (
      !expectedPrefix ||
      !normalizeText(item && item.cloudPath, 512).startsWith(expectedPrefix)
    ) {
      continue;
    }
    const fileID = directClientImageFileMatchesPlan(
      item,
      item.fileID,
      upload.fileID,
      imageEnvironment
    )
      ? item.fileID
      : cloudFileIDForPath(upload.fileID, item.cloudPath) ||
        cloudFileIDForEnvironment(imageEnvironment, item.cloudPath);
    if (
      fileID &&
      directClientImageFileMatchesPlan(
        item,
        fileID,
        upload.fileID,
        imageEnvironment
      ) &&
      !result.includes(fileID)
    ) {
      result.push(fileID);
    }
  }
  return result;
}

function uploadCleanupFileIDs(upload) {
  const cleanupFileIDs = [];
  const parsedStoredFile = parseCloudFileID(upload && upload.fileID);
  const cleanupFileID =
    parsedStoredFile && parsedStoredFile.cloudPath === upload.cloudPath
      ? upload.fileID
      : "";
  if (cleanupFileID) {
    cleanupFileIDs.push(cleanupFileID);
  }

  const expectedPreparedPath = derivePreparedCloudPath(
    upload && upload.assetType,
    upload && upload.relatedId,
    upload && upload._id,
    upload && upload.extension
  );
  const parsedPreparedFile = parseCloudFileID(upload && upload.preparedFileID);
  if (
    expectedPreparedPath &&
    upload.preparedCloudPath === expectedPreparedPath &&
    parsedPreparedFile &&
    parsedPreparedFile.cloudPath === expectedPreparedPath &&
    !cleanupFileIDs.includes(upload.preparedFileID)
  ) {
    cleanupFileIDs.push(upload.preparedFileID);
  }
  clientImageCleanupFileIDs(upload).forEach((fileID) => {
    if (!cleanupFileIDs.includes(fileID)) {
      cleanupFileIDs.push(fileID);
    }
  });
  return cleanupFileIDs;
}

function cleanupProgressResult(upload, options = {}) {
  const cleanupFileIDs = Array.isArray(upload && upload.cleanupFileIDs)
    ? upload.cleanupFileIDs
    : [];
  const remainingCount = cleanupFileIDs.length;
  return {
    success: true,
    alreadyApplied: options.alreadyApplied === true,
    uploadId: normalizeText(upload && upload._id, 32),
    cleanupRequired: Boolean(
      upload && upload.cleanupRequired && remainingCount > 0
    ),
    cleanupRemainingCount: remainingCount,
    cleanupProcessedCount: Number(options.processedCount) || 0,
    cleanupComplete: remainingCount === 0
  };
}

async function cancelUpload(event, admin, openid) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) {
    return roleAuthorization;
  }

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();

  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const uploadDocument = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const draftDocument = transaction
      .collection("adminContentDrafts")
      .doc(uploadId);
    const transactionAdmin = await getDocumentOrNull(adminDocument);
    const upload = await getDocumentOrNull(uploadDocument);
    const boundDraft = await getDocumentOrNull(draftDocument);
    const authorization = revalidateAdmin(transactionAdmin, openid);

    if (!authorization.success || !hasAnyRole(transactionAdmin, UPLOAD_ROLES)) {
      return {
        success: false,
        code: "UPLOAD_FORBIDDEN",
        message: "当前管理员没有内容上传权限"
      };
    }

    if (
      !upload ||
      upload.ownerAdminId !== admin.account._id ||
      upload.ownerOpenid !== openid
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }

    if (boundDraft) {
      return {
        success: false,
        code: "UPLOAD_BOUND_TO_DRAFT",
        message: "上传原件已绑定内容草稿，不能取消"
      };
    }

    if (upload.status === "canceled") {
      return {
        ...cleanupProgressResult(upload, { alreadyApplied: true }),
        alreadyCanceled: true
      };
    }

    if (normalizeText(upload.draftId, 32)) {
      return {
        success: false,
        code: "UPLOAD_BOUND_TO_DRAFT",
        message: "上传原件已绑定内容草稿，不能通过普通取消操作删除"
      };
    }

    if (
      !["pending_upload", "uploaded", "uploaded_unverified"].includes(
        upload.status
      )
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_CANCELABLE",
        message: "上传任务当前不可取消"
      };
    }

    const cleanupFileIDs = uploadCleanupFileIDs(upload);
    const now = db.serverDate();
    await uploadDocument.update({
      data: {
        status: "canceled",
        reviewStatus: "not_submitted",
        cleanupRequired: cleanupFileIDs.length > 0,
        cleanupFileID: cleanupFileIDs[0] || "",
        cleanupFileIDs,
        canceledAt: now,
        updateTime: now
      }
    });

    return {
      ...cleanupProgressResult(
        {
          ...upload,
          _id: uploadId,
          cleanupRequired: cleanupFileIDs.length > 0,
          cleanupFileIDs
        }
      ),
      alreadyCanceled: false,
      uploadId
    };
  });
  return unwrapTransactionResult(rawResult);
}

function storedCleanupFileIDs(upload) {
  const values = Array.isArray(upload && upload.cleanupFileIDs)
    ? upload.cleanupFileIDs
    : [upload && upload.cleanupFileID];
  return Array.from(new Set(
    values
      .map((fileID) => normalizeText(fileID, 2048))
      .filter(Boolean)
  )).slice(0, 250);
}

function cleanupPlanIsSafe(upload, fileIDs) {
  const allowed = new Set(uploadCleanupFileIDs(upload));
  return (
    Array.isArray(fileIDs) &&
    fileIDs.every((fileID) => allowed.has(fileID))
  );
}

async function cleanupCanceledUpload(event, admin, openid) {
  const roleAuthorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "UPLOAD_FORBIDDEN",
    "当前管理员没有内容上传权限"
  );
  if (!roleAuthorization.success) return roleAuthorization;

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;
  const requestHash = sha256(canonicalStringify({
    action: "cleanupCanceledUpload",
    uploadId
  }));

  const [preliminaryUpload, preliminaryDraft] = await Promise.all([
    getDocumentOrNull(db.collection("adminUploads").doc(uploadId)),
    getDocumentOrNull(db.collection("adminContentDrafts").doc(uploadId))
  ]);
  if (
    !preliminaryUpload ||
    preliminaryUpload.ownerAdminId !== admin.account._id ||
    preliminaryUpload.ownerOpenid !== openid
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }
  // A deterministic draft is authoritative even when an old upload row
  // missed its draftId association. This guard runs before cloud.deleteFile.
  if (preliminaryDraft) {
    return {
      success: false,
      code: "UPLOAD_BOUND_TO_DRAFT",
      message: "上传原件已绑定内容草稿，不能清理云文件"
    };
  }
  if (preliminaryUpload.status !== "canceled") {
    return {
      success: false,
      code: "UPLOAD_CLEANUP_NOT_ALLOWED",
      message: "只有已取消的上传任务可以清理云文件"
    };
  }

  const preliminaryMutations = Array.isArray(
    preliminaryUpload.cleanupMutations
  )
    ? preliminaryUpload.cleanupMutations
    : [];
  const preliminaryReplay = preliminaryMutations.find(
    (item) => item && item.requestId === mutation.requestId
  );
  if (
    preliminaryReplay &&
    preliminaryReplay.requestHash !== requestHash
  ) {
    return {
      success: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "同一请求编号不能用于不同的取消清理操作"
    };
  }
  if (
    preliminaryReplay &&
    preliminaryReplay.requestHash === requestHash
  ) {
    return cleanupProgressResult(
      preliminaryUpload,
      { alreadyApplied: true }
    );
  }

  const cleanupFileIDs = storedCleanupFileIDs(preliminaryUpload);
  if (cleanupFileIDs.length === 0) {
    return cleanupProgressResult({
      ...preliminaryUpload,
      cleanupRequired: false,
      cleanupFileIDs: []
    }, { alreadyApplied: true });
  }
  if (!cleanupPlanIsSafe(preliminaryUpload, cleanupFileIDs)) {
    return {
      success: false,
      code: "UPLOAD_CLEANUP_PLAN_INVALID",
      message: "上传任务的云文件清理计划无效"
    };
  }
  if (typeof cloud.deleteFile !== "function") {
    return {
      success: false,
      code: "UPLOAD_CLEANUP_UNAVAILABLE",
      message: "云文件清理能力暂不可用"
    };
  }

  const batch = cleanupFileIDs.slice(0, MAX_CLEANUP_BATCH);
  let deleted;
  try {
    const cleanup = await cloud.deleteFile({ fileList: batch });
    const rows = cleanup && Array.isArray(cleanup.fileList)
      ? cleanup.fileList
      : [];
    deleted = new Set(
      rows
        .filter((item) =>
          item &&
          batch.includes(item.fileID) &&
          isStorageDeleteSatisfied(item)
        )
        .map((item) => item.fileID)
    );
  } catch (error) {
    console.error("adminContentCenter canceled upload cleanup error:", error);
    return {
      success: false,
      code: "UPLOAD_CLEANUP_UNAVAILABLE",
      message: "云文件清理暂时失败，请稍后重试"
    };
  }
  if (deleted.size === 0) {
    return {
      success: false,
      code: "UPLOAD_CLEANUP_UNAVAILABLE",
      message: "云文件暂未清理，请稍后重试"
    };
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const uploadDocument = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const draftDocument = transaction
      .collection("adminContentDrafts")
      .doc(uploadId);
    const transactionAdmin = await getDocumentOrNull(adminDocument);
    const upload = await getDocumentOrNull(uploadDocument);
    const boundDraft = await getDocumentOrNull(draftDocument);
    if (
      !isAuthorizedAccount(transactionAdmin, openid) ||
      !hasAnyRole(transactionAdmin, UPLOAD_ROLES)
    ) {
      return {
        success: false,
        code: "UPLOAD_FORBIDDEN",
        message: "当前管理员没有内容上传权限"
      };
    }
    if (
      !upload ||
      upload.ownerAdminId !== admin.account._id ||
      upload.ownerOpenid !== openid
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }
    if (boundDraft) {
      return {
        success: false,
        code: "UPLOAD_BOUND_TO_DRAFT",
        message: "上传原件已绑定内容草稿，不能清理云文件"
      };
    }
    if (upload.status !== "canceled") {
      return {
        success: false,
        code: "UPLOAD_CLEANUP_NOT_ALLOWED",
        message: "只有已取消的上传任务可以清理云文件"
      };
    }

    const mutations = Array.isArray(upload.cleanupMutations)
      ? upload.cleanupMutations
      : [];
    const priorMutation = mutations.find(
      (item) => item && item.requestId === mutation.requestId
    );
    if (priorMutation && priorMutation.requestHash !== requestHash) {
      return {
        success: false,
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "同一请求编号不能用于不同的取消清理操作"
      };
    }
    if (priorMutation && priorMutation.requestHash === requestHash) {
      return cleanupProgressResult(upload, { alreadyApplied: true });
    }

    const currentFileIDs = storedCleanupFileIDs(upload);
    if (!cleanupPlanIsSafe(upload, currentFileIDs)) {
      return {
        success: false,
        code: "UPLOAD_CLEANUP_PLAN_INVALID",
        message: "上传任务的云文件清理计划无效"
      };
    }
    const remaining = currentFileIDs.filter((fileID) => !deleted.has(fileID));
    const processedCount = currentFileIDs.length - remaining.length;
    const now = db.serverDate();
    const nextMutations = mutations
      .slice(-(MAX_CLEANUP_MUTATIONS - 1))
      .concat([{
        action: "cleanupCanceledUpload",
        requestId: mutation.requestId,
        requestHash,
        processedCount,
        processedAt: now
      }]);
    const update = {
      cleanupRequired: remaining.length > 0,
      cleanupFileID: remaining[0] || "",
      cleanupFileIDs: remaining,
      cleanupMutations: nextMutations,
      cleanupCompletedAt: remaining.length === 0 ? now : null,
      updateTime: now
    };
    await uploadDocument.update({ data: update });
    return cleanupProgressResult(
      { ...upload, ...update },
      {
        alreadyApplied: processedCount === 0,
        processedCount
      }
    );
  });
  return unwrapTransactionResult(rawResult);
}

function targetCollectionForAsset(assetType) {
  if (["manuscript", "audio"].includes(assetType)) {
    return "contents";
  }
  if (["special-topic", "topic-image"].includes(assetType)) {
    return "specialTopics";
  }
  if (EDITORIAL_ASSET_KINDS[assetType]) {
    return EDITORIAL_COLLECTIONS[EDITORIAL_ASSET_KINDS[assetType]];
  }
  return assetType === "full-book-pdf" ? "books" : "";
}

function isStructuredEditorialAsset(assetType) {
  return Boolean(EDITORIAL_ASSET_KINDS[assetType]);
}

function publishedRevisionForTarget(assetType, target) {
  return normalizeText(
    target && (
      isStructuredEditorialAsset(assetType)
        ? target.revision
        : target.currentRevision
    ),
    128
  );
}

function assetRevisionForTarget(assetType, target) {
  if (assetType === "audio") {
    return normalizeText(target && target.audioRevision, 128);
  }
  if (assetType === "full-book-pdf") {
    return normalizeText(target && target.pdfRevision, 128);
  }
  return "";
}

async function createEditorialDraft(event, admin, openid) {
  const authorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "DRAFT_CREATE_FORBIDDEN",
    "当前管理员没有创建结构化内容草稿的权限"
  );
  if (!authorization.success) {
    return authorization;
  }

  const assetType = normalizeText(event.assetType, 32).toLowerCase();
  const editorialKind = EDITORIAL_ASSET_KINDS[assetType];
  if (!editorialKind) {
    return {
      success: false,
      code: "INVALID_EDITORIAL_ASSET_TYPE",
      message: "结构化内容类型无效"
    };
  }

  const mutation = validateMutationRequest(event);
  if (!mutation.success) {
    return mutation;
  }
  const requestHash = mutationHash(
    "createEditorialDraft",
    event,
    ["assetType", "payload"]
  );
  const draftId = sha256(canonicalStringify([
    "structured-editorial-draft",
    admin.account._id,
    mutation.requestId
  ])).slice(0, 32);
  const targetId = createEditorialTargetId(editorialKind, [
    admin.account._id,
    draftId
  ]);
  const payload = normalizePayload(assetType, event.payload, {
    targetId
  });
  const issues = payloadIssues(assetType, event.payload);
  if (!payload || issues.length > 0) {
    return {
      success: false,
      code: "DRAFT_PAYLOAD_INVALID",
      message: issues[0] || "结构化内容不完整",
      issues
    };
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const draftReference = transaction
      .collection("adminContentDrafts")
      .doc(draftId);
    const targetReference = transaction
      .collection(targetCollectionForAsset(assetType))
      .doc(targetId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const existingDraft = await getDocumentOrNull(draftReference);
    const target = await getDocumentOrNull(targetReference);

    if (
      !isAuthorizedAccount(currentAdmin, openid) ||
      !hasAnyRole(currentAdmin, UPLOAD_ROLES)
    ) {
      return {
        success: false,
        code: "DRAFT_CREATE_FORBIDDEN",
        message: "创建结构化内容草稿的权限已失效"
      };
    }

    const transactionalAdmin = {
      account: currentAdmin,
      roles: getRoles(currentAdmin)
    };
    if (existingDraft) {
      if (
        existingDraft.sourceKind !== "structured-form" ||
        existingDraft.assetType !== assetType ||
        !canReadDraft(transactionalAdmin, existingDraft)
      ) {
        return {
          success: false,
          code: "DRAFT_NOT_FOUND",
          message: "内容草稿不存在"
        };
      }
      return replayMutation(
        existingDraft,
        "createEditorialDraft",
        mutation.requestId,
        requestHash
      ) || {
        success: true,
        alreadyApplied: true,
        draft: publicDraft(existingDraft)
      };
    }

    const now = db.serverDate();
    const sourceSha256 = sha256(canonicalStringify(payload));
    const draft = {
      _id: draftId,
      draftId,
      kind: ASSET_KINDS[assetType],
      assetType,
      targetId,
      ownerAdminId: currentAdmin._id,
      sourceKind: "structured-form",
      sourceFingerprints: [{
        sha256: sourceSha256,
        algorithm: "sha256",
        scope: "structured-form-canonical",
        rawFileVerified: true
      }],
      sourceTransportMode: "structured-form",
      rawFileValidationStatus: "not_applicable",
      sourceFileID: "",
      preparedFileID: "",
      preparedCloudPath: "",
      extension: "",
      mimeType: "application/json",
      revision: createRevision(draftId),
      basePublishedRevision: publishedRevisionForTarget(assetType, target),
      baseAssetRevision: "",
      draftVersion: 1,
      state: "editing",
      payload,
      embeddedAssets: [],
      embeddedImagePlacements: [],
      issues: [],
      inspection: {
        schemaVersion: 1,
        format: "structured-form",
        structuredContentValid: true,
        rawFileSignatureValid: false,
        needsManualStructure: false,
        embeddedImageCount: 0,
        metadata: {
          payloadSha256: sourceSha256
        }
      },
      snapshotHash: "",
      review: {
        round: 0,
        submittedDraftVersion: 0,
        submittedSnapshotHash: "",
        decision: "",
        note: ""
      },
      publication: {
        status: "not_started"
      },
      lastMutation: createLastMutation(
        "createEditorialDraft",
        mutation.requestId,
        requestHash
      ),
      createdAt: now,
      updateTime: now,
      schemaVersion: 1
    };
    const { _id: ignoredDraftId, ...draftData } = draft;
    await draftReference.set({ data: draftData });
    return {
      success: true,
      alreadyApplied: false,
      draft: publicDraft(draft)
    };
  });

  return unwrapTransactionResult(rawResult);
}

function canReadDraft(admin, draft) {
  return Boolean(
    draft &&
      (draft.ownerAdminId === admin.account._id ||
        hasAnyRole(admin, REVIEW_ROLES) ||
        hasAnyRole(admin, PUBLISH_ROLES))
  );
}

function canEditDraft(admin, draft) {
  return Boolean(
    draft &&
      (draft.ownerAdminId === admin.account._id ||
        hasAnyRole(admin, PUBLISH_ROLES))
  );
}

function validateMutationRequest(event) {
  const requestId = normalizeText(event && event.requestId, 128);
  return REQUEST_ID_PATTERN.test(requestId)
    ? { success: true, requestId }
    : {
        success: false,
        code: "INVALID_REQUEST_ID",
        message: "操作请求编号无效"
      };
}

function mutationHash(action, event, fields) {
  const body = { action };
  fields.forEach((field) => {
    body[field] = event[field];
  });
  return sha256(canonicalStringify(body));
}

function replayMutation(draft, action, requestId, requestHash) {
  const mutation = draft && draft.lastMutation;
  if (!mutation || mutation.requestId !== requestId) {
    return null;
  }
  if (mutation.action !== action || mutation.requestHash !== requestHash) {
    return {
      success: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "同一请求编号不能用于不同操作"
    };
  }
  return {
    success: true,
    alreadyApplied: true,
    draft: publicDraft(draft)
  };
}

function createLastMutation(action, requestId, requestHash) {
  return { action, requestId, requestHash };
}

function clientImagePlanFingerprint(upload) {
  const plan = Array.isArray(upload && upload.clientImageUploadPlan)
    ? upload.clientImageUploadPlan
    : [];
  const digest = crypto.createHash("sha256");
  let confirmedCount = 0;
  const append = (value) => {
    const text = String(value === undefined || value === null ? "" : value);
    digest.update(String(Buffer.byteLength(text, "utf8")));
    digest.update(":");
    digest.update(text);
    digest.update("|");
  };

  for (const item of plan) {
    const status = normalizeText(item && item.status, 32);
    if (status === "confirmed") confirmedCount += 1;
    append(Number(item && item.imageOrder) || 0);
    append(normalizeText(item && item.relationId, 128));
    append(normalizeText(item && item.packagePath, 512));
    append(normalizeText(item && item.extension, 8).toLowerCase());
    append(normalizeText(item && item.cloudPath, 512));
    append(normalizeText(item && item.fileID, 2048));
    append(status);
    append(normalizeText(item && item.caption, 300));
  }

  return {
    totalCount: plan.length,
    confirmedCount,
    sha256: digest.digest("hex")
  };
}

function draftCreationUploadFingerprint(upload) {
  const manifestSha256 = normalizeText(
    upload && upload.clientManifestSha256,
    64
  ).toLowerCase();
  const manifestBacked = /^[a-f0-9]{64}$/.test(manifestSha256);
  const imagePlan = clientImagePlanFingerprint(upload);
  const inspection = upload && upload.inspection &&
    typeof upload.inspection === "object"
    ? upload.inspection
    : {};
  const inspectionMetadata = inspection.metadata &&
    typeof inspection.metadata === "object"
    ? inspection.metadata
    : {};
  const importStats = upload && upload.clientImportStats &&
    typeof upload.clientImportStats === "object"
    ? upload.clientImportStats
    : {};
  const manifestMeta = upload && upload.clientManifestMeta &&
    typeof upload.clientManifestMeta === "object"
    ? upload.clientManifestMeta
    : {};

  return sha256(canonicalStringify({
    schemaVersion: 1,
    uploadId: normalizeText(upload && upload._id, 32).toLowerCase(),
    ownerAdminId: normalizeText(upload && upload.ownerAdminId, 128),
    ownerOpenid: normalizeText(upload && upload.ownerOpenid, 128),
    assetType: normalizeText(upload && upload.assetType, 32),
    relatedId: normalizeText(upload && upload.relatedId, 64),
    originalFileName: normalizeText(upload && upload.originalFileName, 180),
    extension: normalizeText(upload && upload.extension, 16).toLowerCase(),
    mimeType: normalizeText(upload && upload.mimeType, 120).toLowerCase(),
    status: normalizeText(upload && upload.status, 32),
    ticketStatus: normalizeText(upload && upload.ticketStatus, 32),
    transportMode: normalizeText(upload && upload.transportMode, 32),
    transportStatus: normalizeText(upload && upload.transportStatus, 64),
    validationStatus: normalizeText(upload && upload.validationStatus, 64),
    rawFileValidationStatus: normalizeText(
      upload && upload.rawFileValidationStatus,
      64
    ),
    sourceMode: normalizeText(upload && upload.sourceMode, 32),
    originalFileUploadRequired:
      upload && upload.originalFileUploadRequired !== false,
    fileID: normalizeText(upload && upload.fileID, 2048),
    cloudPath: normalizeText(upload && upload.cloudPath, 512),
    preparedFileID: normalizeText(upload && upload.preparedFileID, 2048),
    preparedCloudPath: normalizeText(
      upload && upload.preparedCloudPath,
      512
    ),
    declaredBytes: Number(upload && upload.declaredBytes) || 0,
    actualBytes: Number(upload && upload.actualBytes) || 0,
    sha256: normalizeText(upload && upload.sha256, 64).toLowerCase(),
    clientManifestSha256: manifestSha256,
    clientManifestHashScope: normalizeText(
      upload && upload.clientManifestHashScope,
      96
    ),
    clientManifestCanonicalBytes:
      Number(manifestMeta.canonicalBytes) || 0,
    clientDraftPayloadBytes:
      Number(upload && upload.clientDraftPayloadBytes) || 0,
    clientImportParagraphs:
      Number(importStats.paragraphs || importStats.blocks) || 0,
    clientImageEnvironment: clientImageEnvironmentForUpload(upload),
    clientImagePlanTotal: imagePlan.totalCount,
    clientImagePlanConfirmed: imagePlan.confirmedCount,
    clientImagePlanSha256: imagePlan.sha256,
    inspection: manifestBacked
      ? null
      : {
          schemaVersion: Number(inspection.schemaVersion) || 0,
          format: normalizeText(inspection.format, 64),
          structuredContentValid: Boolean(inspection.structuredContentValid),
          rawFileSignatureValid: Boolean(inspection.rawFileSignatureValid),
          actualBytes: Number(inspection.actualBytes) || 0,
          durationSeconds:
            Number(inspectionMetadata.durationSeconds) ||
            Number(inspection.durationSeconds) || 0,
          averageBitrateKbps:
            Number(inspectionMetadata.averageBitrateKbps) || 0,
          bitrate: Number(inspection.bitrate) || 0,
          previewParagraphsSha256: sha256(
            (Array.isArray(inspection.previewParagraphs)
              ? inspection.previewParagraphs
              : []
            ).map((item) => String(item)).join("\u0000")
          )
        }
  }));
}

function reusableDraftCreationUploadFingerprint(upload) {
  const computed = draftCreationUploadFingerprint(upload);
  const stored = normalizeText(
    upload && upload.draftCreationSourceFingerprint,
    64
  ).toLowerCase();
  return (
    upload && upload.draftCreationSourceFingerprintVersion === 1 &&
    /^[a-f0-9]{64}$/.test(stored) &&
    stored === computed
  )
    ? stored
    : computed;
}

function draftDocumentSizeBytes(draft) {
  const { _id: ignoredDraftId, ...documentData } =
    draft && typeof draft === "object" ? draft : {};
  return Buffer.byteLength(canonicalStringify(documentData), "utf8");
}

function publicCreatedDraft(draft) {
  const result = publicDraft(draft);
  const payload = result.payload && typeof result.payload === "object"
    ? result.payload
    : {};
  const payloadSummary = {};
  ["title", "label", "question", "caption"].forEach((field) => {
    const value = normalizeText(payload[field], 160);
    if (value) payloadSummary[field] = value;
  });
  return {
    ...result,
    payload: payloadSummary,
    payloadOmitted: true
  };
}

function publicDraftSummary(draft) {
  const detail = publicDraft(draft);
  const payload = draft && draft.payload && typeof draft.payload === "object"
    ? draft.payload
    : {};
  const inspection = detail.inspection || {};
  const {
    payload: ignoredPayload,
    inspection: ignoredInspection,
    ...summary
  } = detail;
  return {
    ...summary,
    title: normalizeText(
      payload.title || payload.label || payload.question || payload.caption,
      160
    ),
    bookTitle: normalizeText(payload.bookTitle, 160),
    inspectionSummary: {
      format: normalizeText(inspection.format, 32),
      paragraphCount: Number(inspection.paragraphCount) || 0,
      embeddedImageCount: Number(inspection.embeddedImageCount) || 0,
      needsManualStructure: Boolean(inspection.needsManualStructure)
    }
  };
}

function validateDraftSourceUpload(upload) {
  const knownChapterSource = knownChapterSourceRejection(upload);
  if (knownChapterSource) {
    return knownChapterSource;
  }

  const brokerUploadReady = isBrokerCompletedUpload(upload);
  const directManifestReady = isDirectClientManifestReady(upload);
  const directPreparedAssetReady =
    isDirectAdminAttestedPreparedAssetReady(upload);
  const directUploadReady = directManifestReady || directPreparedAssetReady;

  if (
    upload &&
    upload.transportMode === "cloud-storage-direct" &&
    upload.validationStatus === "awaiting_client_images"
  ) {
    return {
      success: false,
      code: "SOURCE_UPLOAD_IMAGES_REQUIRED",
      message: "Word 正文中的内嵌图片尚未上传并确认，不能创建草稿"
    };
  }

  if (
    upload &&
    upload.transportMode === "cloud-storage-direct" &&
    !directUploadReady
  ) {
    return {
      success: false,
      code: "SOURCE_UPLOAD_MANIFEST_REQUIRED",
      message: "直传原件尚未提交并通过结构化内容校验，不能创建草稿"
    };
  }

  if (!brokerUploadReady && !directUploadReady) {
    return {
      success: false,
      code: "SOURCE_UPLOAD_NOT_VALIDATED",
      message: "上传原件尚未通过服务端结构校验"
    };
  }

  return {
    success: true,
    brokerUploadReady,
    directManifestReady,
    directPreparedAssetReady
  };
}

async function reconcileUploadWithCreatedDraft(upload, draft) {
  const uploadId = normalizeText(
    draft && draft.sourceUploadId || upload && upload._id,
    32
  ).toLowerCase();
  const expectedDraftId = normalizeText(draft && draft._id, 32).toLowerCase();
  const expectedOwnerAdminId = normalizeText(
    draft && draft.ownerAdminId,
    128
  );
  if (
    !UPLOAD_ID_PATTERN.test(uploadId) ||
    expectedDraftId !== uploadId ||
    !expectedOwnerAdminId
  ) {
    return false;
  }

  try {
    const rawResult = await db.runTransaction(async (transaction) => {
      const uploadReference = transaction
        .collection("adminUploads")
        .doc(uploadId);
      const draftReference = transaction
        .collection("adminContentDrafts")
        .doc(expectedDraftId);
      const currentUpload = await getDocumentOrNull(uploadReference);
      const currentDraft = await getDocumentOrNull(draftReference);

      if (
        !currentUpload ||
        !currentDraft ||
        normalizeText(currentDraft.sourceUploadId, 32).toLowerCase() !==
          uploadId ||
        normalizeText(currentDraft.ownerAdminId, 128) !==
          expectedOwnerAdminId ||
        normalizeText(currentUpload.ownerAdminId, 128) !==
          expectedOwnerAdminId ||
        currentUpload.status !== "uploaded" ||
        ["canceled", "failed"].includes(currentUpload.status) ||
        (
          normalizeText(currentUpload.draftId, 32) &&
          normalizeText(currentUpload.draftId, 32).toLowerCase() !==
            expectedDraftId
        )
      ) {
        return { success: false, reconciled: false };
      }

      const now = db.serverDate();
      const data = {
        draftId: expectedDraftId,
        ingestionStatus: "draft_created",
        reviewStatus: "not_submitted",
        updateTime: now
      };
      if (
        /^[a-f0-9]{64}$/.test(
          normalizeText(currentUpload.clientManifestSha256, 64).toLowerCase()
        )
      ) {
        data.clientDraftPayload = null;
        data.clientDraftPayloadTransferredAt = now;
      }
      await uploadReference.update({ data });
      return { success: true, reconciled: true };
    });
    const result = unwrapTransactionResult(rawResult);
    return Boolean(result && result.success && result.reconciled);
  } catch (error) {
    console.error("reconcile created draft upload error", {
      code: normalizeText(error && (error.code || error.errCode), 80),
      uploadId,
      draftId: expectedDraftId
    });
    return false;
  }
}

async function createDraftFromUpload(event, admin, openid) {
  const authorization = requireRole(
    admin,
    UPLOAD_ROLES,
    "DRAFT_CREATE_FORBIDDEN",
    "当前管理员没有创建内容草稿的权限"
  );
  if (!authorization.success) {
    return authorization;
  }

  const uploadId = normalizeText(event.uploadId, 32).toLowerCase();
  if (!DRAFT_ID_PATTERN.test(uploadId)) {
    return {
      success: false,
      code: "INVALID_UPLOAD_ID",
      message: "上传编号无效"
    };
  }

  const mutation = validateMutationRequest(event);
  if (!mutation.success) {
    return mutation;
  }
  const requestHash = mutationHash("createDraftFromUpload", event, ["uploadId"]);
  const uploadReference = db.collection("adminUploads").doc(uploadId);
  const draftReference = db.collection("adminContentDrafts").doc(uploadId);
  const preliminaryUpload = await getDocumentOrNull(uploadReference);
  const linkedDraftId = normalizeText(
    preliminaryUpload && preliminaryUpload.draftId,
    32
  ).toLowerCase();
  if (linkedDraftId && linkedDraftId !== uploadId) {
    return {
      success: false,
      code: "UPLOAD_DRAFT_LINK_CONFLICT",
      message: "上传任务关联的草稿编号不一致，请刷新后重试"
    };
  }
  const payloadWasTransferred = Boolean(
    preliminaryUpload &&
      preliminaryUpload.clientDraftPayloadTransferredAt &&
      !preliminaryUpload.clientDraftPayload
  );
  const preliminaryDraft = linkedDraftId || payloadWasTransferred
    ? await getDocumentOrNull(draftReference)
    : null;
  if ((linkedDraftId || payloadWasTransferred) && !preliminaryDraft) {
    return {
      success: false,
      code: "DRAFT_NOT_FOUND",
      message: "上传任务关联的内容草稿暂未找到，请稍后重试"
    };
  }

  if (preliminaryDraft) {
    if (
      preliminaryDraft.sourceUploadId !== uploadId ||
      !canReadDraft(admin, preliminaryDraft)
    ) {
      return {
        success: false,
        code: "DRAFT_NOT_FOUND",
        message: "内容草稿不存在"
      };
    }
    const replay = replayMutation(
      preliminaryDraft,
      "createDraftFromUpload",
      mutation.requestId,
      requestHash
    );
    if (replay && !replay.success) {
      return replay;
    }
    const preliminaryDraftId = normalizeText(preliminaryDraft._id, 32)
      .toLowerCase();
    const uploadLinkComplete = Boolean(
      preliminaryUpload &&
      preliminaryUpload.status === "uploaded" &&
      normalizeText(preliminaryUpload.draftId, 32).toLowerCase() ===
        preliminaryDraftId &&
      preliminaryUpload.ingestionStatus === "draft_created" &&
      preliminaryUpload.reviewStatus === "not_submitted"
    );
    const uploadReconciled = uploadLinkComplete
      ? true
      : await reconcileUploadWithCreatedDraft(
          preliminaryUpload,
          preliminaryDraft
        );
    return {
      success: true,
      alreadyApplied: true,
      uploadReconciled,
      draft: publicCreatedDraft(preliminaryDraft)
    };
  }

  if (
    !preliminaryUpload ||
    (preliminaryUpload.ownerAdminId !== admin.account._id &&
      !hasAnyRole(admin, PUBLISH_ROLES))
  ) {
    return {
      success: false,
      code: "UPLOAD_NOT_FOUND",
      message: "上传任务不存在"
    };
  }

  const sourceState = validateDraftSourceUpload(preliminaryUpload);
  if (!sourceState.success) {
    return sourceState;
  }

  const targetCollection = targetCollectionForAsset(
    preliminaryUpload.assetType
  );
  const target = targetCollection
    ? await getDocumentOrNull(
        db.collection(targetCollection).doc(preliminaryUpload.relatedId)
      )
    : null;
  if (
    preliminaryUpload.assetType === "full-book-pdf" &&
    !(
      target &&
      target.status === "published" &&
      normalizeText(target.currentRevision, 128)
    )
  ) {
    const publishedContentResult = await db
      .collection("contents")
      .where({
        bookId: preliminaryUpload.relatedId,
        status: "published"
      })
      .orderBy("sortOrder", "asc")
      .orderBy("_id", "asc")
      .limit(1)
      .get();
    if (
      !publishedContentResult ||
      !Array.isArray(publishedContentResult.data) ||
      publishedContentResult.data.length === 0
    ) {
      return {
        success: false,
        code: "BOOK_PUBLISHED_CONTENT_REQUIRED",
        message: "请先发布至少一篇归属该书的正文，再创建整书 PDF 草稿"
      };
    }
  }

  let payload = sourceState.directManifestReady
    ? preliminaryUpload.clientDraftPayload
    : defaultPayloadFromUpload(preliminaryUpload, target || {});
  const embeddedAssets = sourceState.directManifestReady
    ? createEmbeddedAssets(preliminaryUpload)
    : [];
  if (embeddedAssets === null) {
    return {
      success: false,
      code: "SOURCE_UPLOAD_IMAGES_INVALID",
      message: "Word 内嵌图片确认状态无效，不能创建草稿"
    };
  }
  if (sourceState.directManifestReady && embeddedAssets.length > 0) {
    const mergedPayload = mergeEmbeddedImagesIntoPayload(
      preliminaryUpload.assetType,
      payload,
      embeddedAssets,
      preliminaryUpload.clientImagePlacements
    );
    payload = mergedPayload
      ? normalizePayload(preliminaryUpload.assetType, mergedPayload, {
          targetId: preliminaryUpload.relatedId,
          mimeType: preliminaryUpload.mimeType
        })
      : null;
    if (!payload) {
      return {
        success: false,
        code: "SOURCE_UPLOAD_IMAGE_PLACEMENTS_INVALID",
        message: "Word 内嵌图片与正文位置不一致，不能创建草稿"
      };
    }
  }

  const issues = payloadIssues(preliminaryUpload.assetType, payload);
  const sourceFingerprint = sourceState.directManifestReady
    ? {
        uploadId,
        sha256: preliminaryUpload.clientManifestSha256,
        algorithm: "sha256",
        scope: preliminaryUpload.clientManifestHashScope,
        rawFileVerified: false,
        originalFileRetained: !isClientManifestOnlySource(preliminaryUpload),
        declaredBytes: Number(preliminaryUpload.declaredBytes)
      }
    : sourceState.directPreparedAssetReady
      ? {
          uploadId,
          sha256: "",
          algorithm: "none",
          scope: "exact-path-object-exists-admin-attestation",
          rawFileVerified: false,
          declaredBytes: Number(preliminaryUpload.declaredBytes)
        }
      : {
          uploadId,
          sha256: preliminaryUpload.sha256,
          algorithm: "sha256",
          scope: "original-file-bytes",
          rawFileVerified: true,
          actualBytes: Number(preliminaryUpload.actualBytes)
        };
  const draftInspection = sourceState.directManifestReady
    ? {
        schemaVersion: 1,
        format: "docx-client-manifest",
        structuredContentValid: true,
        rawFileSignatureValid: false,
        needsManualStructure: true,
        embeddedImageCount: embeddedAssets.length,
        metadata: {
          previewParagraphCount:
            Number(
              preliminaryUpload.clientImportStats &&
                (
                  preliminaryUpload.clientImportStats.paragraphs ||
                  preliminaryUpload.clientImportStats.blocks
                )
            ) || 0,
          manifestSha256: preliminaryUpload.clientManifestSha256,
          manifestHashScope: preliminaryUpload.clientManifestHashScope,
          manifestCanonicalBytes:
            Number(
              preliminaryUpload.clientManifestMeta &&
                preliminaryUpload.clientManifestMeta.canonicalBytes
            ) || 0,
          originalFileRetained: !isClientManifestOnlySource(preliminaryUpload)
        }
      }
    : sourceState.directPreparedAssetReady
      ? {
          schemaVersion: 1,
          format: `${preliminaryUpload.extension.slice(1)}-admin-attested`,
          structuredContentValid: false,
          rawFileSignatureValid: false,
          needsManualStructure: true,
          embeddedImageCount: 0,
          metadata: {
            exactReservedPath: true,
            objectExists: true,
            actualBytesVerified: false,
            sha256Verified: false,
            structureVerified: false
          }
        }
      : preliminaryUpload.inspection;
  const now = db.serverDate();
  const draft = {
    _id: uploadId,
    draftId: uploadId,
    kind: ASSET_KINDS[preliminaryUpload.assetType],
    assetType: preliminaryUpload.assetType,
    targetId: preliminaryUpload.relatedId,
    ownerAdminId: preliminaryUpload.ownerAdminId,
    sourceUploadId: uploadId,
    sourceFingerprints: [sourceFingerprint],
    sourceFileID: isClientManifestOnlySource(preliminaryUpload)
      ? ""
      : preliminaryUpload.fileID,
    sourceTransportMode: preliminaryUpload.transportMode,
    sourceMode: normalizeText(preliminaryUpload.sourceMode, 32) ||
      "original-file",
    originalFileUploadRequired:
      preliminaryUpload.originalFileUploadRequired !== false,
    rawFileValidationStatus: sourceState.directManifestReady
      ? normalizeText(preliminaryUpload.rawFileValidationStatus, 32) ||
        "unverified"
      : sourceState.directPreparedAssetReady
        ? "unverified"
        : "validated",
    clientImageEnvironment: sourceState.directManifestReady
      ? clientImageEnvironmentForUpload(preliminaryUpload)
      : "",
    preparedFileID: normalizeText(preliminaryUpload.preparedFileID, 2048),
    preparedCloudPath: normalizeText(
      preliminaryUpload.preparedCloudPath,
      512
    ),
    extension: normalizeText(preliminaryUpload.extension, 16).toLowerCase(),
    mimeType: preliminaryUpload.mimeType,
    revision: createRevision(uploadId),
    basePublishedRevision: normalizeText(target && target.currentRevision, 128),
    baseAssetRevision: assetRevisionForTarget(
      preliminaryUpload.assetType,
      target
    ),
    draftVersion: 1,
    state: "editing",
    payload,
    embeddedAssets,
    embeddedImagePlacements: sourceState.directManifestReady
      ? preliminaryUpload.clientImagePlacements || []
      : [],
    issues,
    inspection: draftInspection,
    snapshotHash: "",
    review: {
      round: 0,
      submittedDraftVersion: 0,
      submittedSnapshotHash: "",
      decision: "",
      note: ""
    },
    publication: {
      status: "not_started"
    },
    lastMutation: createLastMutation(
      "createDraftFromUpload",
      mutation.requestId,
      requestHash
    ),
    createdAt: now,
    updateTime: now,
    schemaVersion: 1
  };
  const expectedUploadFingerprint = reusableDraftCreationUploadFingerprint(
    preliminaryUpload
  );
  const { _id: ignoredDraftId, ...draftData } = draft;
  const draftDocumentBytes = draftDocumentSizeBytes(draft);
  if (draftDocumentBytes > MAX_DRAFT_DOCUMENT_BYTES) {
    return {
      success: false,
      code: "DRAFT_TOO_LARGE",
      message: "生成的内容草稿过大，请拆分 Word 内容或减少内嵌图片后重试",
      draftDocumentBytes,
      maximumDraftDocumentBytes: MAX_DRAFT_DOCUMENT_BYTES
    };
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const currentUploadReference = transaction
      .collection("adminUploads")
      .doc(uploadId);
    const currentDraftReference = transaction
      .collection("adminContentDrafts")
      .doc(uploadId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const currentUpload = await getDocumentOrNull(currentUploadReference);
    const currentDraft = await getDocumentOrNull(currentDraftReference);
    const currentAuthorization = revalidateAdmin(currentAdmin, openid);
    const transactionalAdmin = {
      account: currentAdmin,
      roles: getRoles(currentAdmin)
    };
    if (!currentAuthorization.success || !hasAnyRole(currentAdmin, UPLOAD_ROLES)) {
      return {
        success: false,
        code: "DRAFT_CREATE_FORBIDDEN",
        message: "创建内容草稿的权限已失效"
      };
    }

    if (currentDraft) {
      if (
        currentDraft.sourceUploadId !== uploadId ||
        !canReadDraft(transactionalAdmin, currentDraft)
      ) {
        return {
          success: false,
          code: "DRAFT_NOT_FOUND",
          message: "内容草稿不存在"
        };
      }
      const replay = replayMutation(
        currentDraft,
        "createDraftFromUpload",
        mutation.requestId,
        requestHash
      );
      if (replay && !replay.success) {
        return replay;
      }
      return {
        success: true,
        alreadyApplied: true,
        draftId: normalizeText(currentDraft._id, 32)
      };
    }

    if (
      !currentUpload ||
      (currentUpload.ownerAdminId !== currentAdmin._id &&
        !hasAnyRole(currentAdmin, PUBLISH_ROLES))
    ) {
      return {
        success: false,
        code: "UPLOAD_NOT_FOUND",
        message: "上传任务不存在"
      };
    }
    const currentSourceState = validateDraftSourceUpload(currentUpload);
    if (!currentSourceState.success) {
      return currentSourceState;
    }
    if (
      reusableDraftCreationUploadFingerprint(currentUpload) !==
      expectedUploadFingerprint
    ) {
      return {
        success: false,
        code: "SOURCE_UPLOAD_CHANGED",
        message: "上传任务在创建草稿期间已变更，请刷新后重试"
      };
    }

    if (draftDocumentBytes > MAX_DRAFT_DOCUMENT_BYTES) {
      return {
        success: false,
        code: "DRAFT_TOO_LARGE",
        message: "生成的内容草稿过大，请拆分 Word 内容或减少内嵌图片后重试"
      };
    }
    const transactionNow = db.serverDate();
    await currentDraftReference.set({ data: draftData });
    const uploadLinkData = {
      draftId: uploadId,
      ingestionStatus: "draft_created",
      reviewStatus: "not_submitted",
      updateTime: transactionNow
    };
    if (
      /^[a-f0-9]{64}$/.test(
        normalizeText(currentUpload.clientManifestSha256, 64).toLowerCase()
      )
    ) {
      uploadLinkData.clientDraftPayload = null;
      uploadLinkData.clientDraftPayloadTransferredAt = transactionNow;
    }
    await currentUploadReference.update({
      data: uploadLinkData
    });
    return {
      success: true,
      alreadyApplied: false,
      draftId: uploadId,
      uploadReconciled: true
    };
  });

  const result = unwrapTransactionResult(rawResult);
  if (!result || !result.success) {
    return result;
  }
  const storedDraft = result.alreadyApplied
    ? await getDocumentOrNull(draftReference)
    : draft;
  if (!storedDraft) {
    return {
      success: false,
      code: "DRAFT_NOT_FOUND",
      message: "内容草稿不存在"
    };
  }
  if (result.alreadyApplied) {
    result.uploadReconciled = await reconcileUploadWithCreatedDraft(
      preliminaryUpload,
      storedDraft
    );
  }
  result.draft = publicCreatedDraft(storedDraft);
  delete result.draftId;
  return result;
}

async function getDraft(event, admin) {
  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    return { success: false, code: "INVALID_DRAFT_ID", message: "草稿编号无效" };
  }
  const draft = await getDocumentOrNull(
    db.collection("adminContentDrafts").doc(draftId)
  );
  if (!canReadDraft(admin, draft)) {
    return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
  }
  return { success: true, draft: publicDraft(draft) };
}

async function listDrafts(event, admin, reviewOnly = false) {
  if (reviewOnly && !hasAnyRole(admin, REVIEW_ROLES)) {
    return {
      success: false,
      code: "CONTENT_REVIEW_FORBIDDEN",
      message: "当前管理员没有内容审核权限"
    };
  }

  const offset = normalizeInteger(event.offset, 0, 0, MAX_OFFSET);
  const limit = normalizeInteger(
    event.limit,
    DRAFT_PAGE_SIZE,
    1,
    MAX_DRAFT_PAGE_SIZE
  );
  const filter = reviewOnly
    ? { state: "in_review" }
    : hasAnyRole(admin, REVIEW_ROLES)
      ? {}
      : { ownerAdminId: admin.account._id };
  let query = db.collection("adminContentDrafts");
  if (Object.keys(filter).length > 0) {
    query = query.where(filter);
  }
  const result = await query
    .field(DRAFT_LIST_FIELDS)
    .orderBy("updateTime", "desc")
    .orderBy("_id", "desc")
    .skip(offset)
    .limit(limit + 1)
    .get();
  const rows = result && Array.isArray(result.data) ? result.data : [];
  const visibleRows = rows.filter((draft) => canReadDraft(admin, draft));
  const hasMore = rows.length > limit;
  const drafts = visibleRows.slice(0, limit).map(publicDraftSummary);

  return {
    success: true,
    drafts,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

async function saveDraft(event, admin, openid) {
  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  const expectedDraftVersion = Number(event.expectedDraftVersion);
  if (!DRAFT_ID_PATTERN.test(draftId) || !Number.isInteger(expectedDraftVersion)) {
    return { success: false, code: "INVALID_DRAFT_REQUEST", message: "草稿保存参数无效" };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;
  const patch = event.patch && typeof event.patch === "object" && !Array.isArray(event.patch)
    ? event.patch
    : {};
  const requestHash = mutationHash("saveDraft", {
    ...event,
    patch
  }, ["draftId", "expectedDraftVersion", "patch"]);

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction.collection("adminAccounts").doc(admin.account._id);
    const draftReference = transaction.collection("adminContentDrafts").doc(draftId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReference);
    const transactionalAdmin = {
      account: currentAdmin,
      roles: getRoles(currentAdmin)
    };
    if (
      !isAuthorizedAccount(currentAdmin, openid) ||
      !hasAnyRole(currentAdmin, UPLOAD_ROLES) ||
      !canEditDraft(transactionalAdmin, draft)
    ) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    const replay = replayMutation(draft, "saveDraft", mutation.requestId, requestHash);
    if (replay) return replay;
    if (!Number.isInteger(draft.draftVersion) || draft.draftVersion !== expectedDraftVersion) {
      return {
        success: false,
        code: "DRAFT_VERSION_CONFLICT",
        message: "草稿已被其他操作更新，请刷新后重试"
      };
    }
    if (!["editing", "changes_requested"].includes(draft.state)) {
      return { success: false, code: "DRAFT_STATE_CONFLICT", message: "草稿当前不可编辑" };
    }

    let payload = normalizePayload(
      draft.assetType,
      { ...(draft.payload || {}), ...patch },
      { targetId: draft.targetId, mimeType: draft.mimeType }
    );
    if (
      payload &&
      Array.isArray(draft.embeddedAssets) &&
      draft.embeddedAssets.length > 0
    ) {
      const mergedPayload = mergeEmbeddedImagesIntoPayload(
        draft.assetType,
        payload,
        draft.embeddedAssets,
        draft.embeddedImagePlacements
      );
      payload = mergedPayload
        ? normalizePayload(draft.assetType, mergedPayload, {
            targetId: draft.targetId,
            mimeType: draft.mimeType
          })
        : null;
    }
    if (!payload) {
      return { success: false, code: "DRAFT_PAYLOAD_INVALID", message: "草稿内容结构无效" };
    }
    const nextVersion = draft.draftVersion + 1;
    const issues = payloadIssues(draft.assetType, payload);
    const now = db.serverDate();
    const sourceFingerprints = isStructuredEditorialAsset(draft.assetType)
      ? [{
          sha256: sha256(canonicalStringify(payload)),
          algorithm: "sha256",
          scope: "structured-form-canonical",
          rawFileVerified: true
        }]
      : draft.sourceFingerprints;
    const updated = {
      ...draft,
      payload,
      issues,
      sourceFingerprints,
      draftVersion: nextVersion,
      state: "editing",
      snapshotHash: "",
      review: {
        ...(draft.review || {}),
        decision: "",
        note: "",
        submittedDraftVersion: 0,
        submittedSnapshotHash: ""
      },
      publication: { status: "not_started" },
      lastMutation: createLastMutation("saveDraft", mutation.requestId, requestHash),
      updateTime: now
    };
    const updatedDocumentBytes = draftDocumentSizeBytes(updated);
    if (updatedDocumentBytes > MAX_DRAFT_DOCUMENT_BYTES) {
      return {
        success: false,
        code: "DRAFT_TOO_LARGE",
        message: "生成的内容草稿过大，请拆分 Word 内容或减少内嵌图片后重试",
        draftDocumentBytes: updatedDocumentBytes,
        maximumDraftDocumentBytes: MAX_DRAFT_DOCUMENT_BYTES
      };
    }
    await draftReference.update({
      data: {
        payload: updated.payload,
        issues: updated.issues,
        sourceFingerprints: updated.sourceFingerprints,
        draftVersion: updated.draftVersion,
        state: updated.state,
        snapshotHash: "",
        review: updated.review,
        publication: updated.publication,
        lastMutation: updated.lastMutation,
        updateTime: now
      }
    });
    return { success: true, alreadyApplied: false, draft: publicDraft(updated) };
  });
  return unwrapTransactionResult(rawResult);
}

async function submitDraft(event, admin, openid) {
  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  const expectedDraftVersion = Number(event.expectedDraftVersion);
  if (!DRAFT_ID_PATTERN.test(draftId) || !Number.isInteger(expectedDraftVersion)) {
    return { success: false, code: "INVALID_DRAFT_REQUEST", message: "草稿提交参数无效" };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;
  const requestHash = mutationHash("submitDraft", event, ["draftId", "expectedDraftVersion"]);

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction.collection("adminAccounts").doc(admin.account._id);
    const draftReference = transaction.collection("adminContentDrafts").doc(draftId);
    const uploadReference = transaction.collection("adminUploads").doc(draftId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReference);
    const upload = await getDocumentOrNull(uploadReference);
    const transactionalAdmin = {
      account: currentAdmin,
      roles: getRoles(currentAdmin)
    };
    if (
      !isAuthorizedAccount(currentAdmin, openid) ||
      !hasAnyRole(currentAdmin, UPLOAD_ROLES) ||
      !canEditDraft(transactionalAdmin, draft)
    ) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    const replay = replayMutation(draft, "submitDraft", mutation.requestId, requestHash);
    if (replay) return replay;
    if (draft.draftVersion !== expectedDraftVersion) {
      return { success: false, code: "DRAFT_VERSION_CONFLICT", message: "草稿已更新，请刷新后重试" };
    }
    if (!["editing", "changes_requested"].includes(draft.state)) {
      return { success: false, code: "DRAFT_STATE_CONFLICT", message: "草稿当前不可提交" };
    }
    const knownChapterSource = knownChapterSourceRejection(upload);
    if (knownChapterSource) {
      return knownChapterSource;
    }
    const issues = payloadIssues(draft.assetType, draft.payload);
    if (issues.length > 0) {
      return {
        success: false,
        code: "DRAFT_INCOMPLETE",
        message: issues[0],
        issues
      };
    }
    const standaloneStructuredDraft = Boolean(
      isStructuredEditorialAsset(draft.assetType) &&
      draft.sourceKind === "structured-form"
    );
    const sourceValidated = standaloneStructuredDraft || Boolean(
      upload &&
      (
        upload.validationStatus === "validated" ||
        (
          upload.validationStatus === "client_manifest_validated" &&
          upload.transportMode === "cloud-storage-direct" &&
          isDirectClientManifestAttached(upload)
        ) ||
        isDirectAdminAttestedPreparedAssetReady(upload)
      )
    );
    if (
      !sourceValidated ||
      (!standaloneStructuredDraft && upload.draftId !== draftId)
    ) {
      return {
        success: false,
        code: "SOURCE_UPLOAD_NOT_VALIDATED",
        message: "草稿原件校验状态已变化"
      };
    }

    const hash = snapshotHash(draft);
    const now = db.serverDate();
    const nextVersion = draft.draftVersion + 1;
    const updated = {
      ...draft,
      draftVersion: nextVersion,
      state: "in_review",
      snapshotHash: hash,
      review: {
        round: Number(draft.review && draft.review.round || 0) + 1,
        submittedDraftVersion: draft.draftVersion,
        submittedSnapshotHash: hash,
        submittedBy: admin.account._id,
        submittedAt: now,
        decision: "",
        reviewedBy: "",
        reviewedAt: null,
        note: ""
      },
      lastMutation: createLastMutation("submitDraft", mutation.requestId, requestHash),
      updateTime: now
    };
    await draftReference.update({
      data: {
        draftVersion: nextVersion,
        state: "in_review",
        snapshotHash: hash,
        review: updated.review,
        lastMutation: updated.lastMutation,
        updateTime: now
      }
    });
    if (!standaloneStructuredDraft) {
      await uploadReference.update({
        data: { reviewStatus: "in_review", updateTime: now }
      });
    }
    return { success: true, alreadyApplied: false, draft: publicDraft(updated) };
  });
  return unwrapTransactionResult(rawResult);
}

async function reviewDraft(event, admin, openid) {
  const authorization = requireRole(
    admin,
    REVIEW_ROLES,
    "CONTENT_REVIEW_FORBIDDEN",
    "当前管理员没有内容审核权限"
  );
  if (!authorization.success) return authorization;
  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  const expectedSnapshotHash = normalizeText(event.expectedSnapshotHash, 64).toLowerCase();
  const decision = normalizeText(event.decision, 32).toLowerCase();
  const note = normalizeText(event.note, 1000);
  if (
    !DRAFT_ID_PATTERN.test(draftId) ||
    !SNAPSHOT_HASH_PATTERN.test(expectedSnapshotHash) ||
    !["approve", "request_changes", "reject"].includes(decision)
  ) {
    return { success: false, code: "INVALID_REVIEW_REQUEST", message: "审核参数无效" };
  }
  if (decision !== "approve" && !note) {
    return { success: false, code: "REVIEW_NOTE_REQUIRED", message: "退回或驳回时必须填写原因" };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;
  const requestHash = mutationHash("reviewDraft", {
    ...event,
    decision,
    note
  }, ["draftId", "expectedSnapshotHash", "decision", "note"]);
  const requiredPreviewAuditId = previewAuditId(
    draftId,
    admin.account._id,
    expectedSnapshotHash
  );

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction.collection("adminAccounts").doc(admin.account._id);
    const draftReference = transaction.collection("adminContentDrafts").doc(draftId);
    const uploadReference = transaction.collection("adminUploads").doc(draftId);
    const previewAuditReference = decision === "approve"
      ? transaction.collection("adminDraftPreviewAudits").doc(requiredPreviewAuditId)
      : null;
    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReference);
    const previewAudit = previewAuditReference
      ? await getDocumentOrNull(previewAuditReference)
      : null;
    if (!isAuthorizedAccount(currentAdmin, openid) || !hasAnyRole(currentAdmin, REVIEW_ROLES)) {
      return { success: false, code: "CONTENT_REVIEW_FORBIDDEN", message: "内容审核权限已失效" };
    }
    if (!draft) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    const replay = replayMutation(draft, "reviewDraft", mutation.requestId, requestHash);
    if (replay) return replay;
    if (draft.state !== "in_review") {
      return { success: false, code: "DRAFT_STATE_CONFLICT", message: "草稿已不在待审核状态" };
    }
    if (
      draft.snapshotHash !== expectedSnapshotHash ||
      draft.review.submittedSnapshotHash !== expectedSnapshotHash ||
      !Number.isInteger(draft.review.submittedDraftVersion) ||
      snapshotHash({
        ...draft,
        draftVersion: draft.review.submittedDraftVersion
      }) !== expectedSnapshotHash
    ) {
      return {
        success: false,
        code: "DRAFT_SNAPSHOT_CHANGED",
        message: "草稿内容已经变化，请重新打开审核"
      };
    }
    const sourceFingerprint =
      Array.isArray(draft.sourceFingerprints) &&
      draft.sourceFingerprints[0] || {};
    const standaloneStructuredDraft = Boolean(
      isStructuredEditorialAsset(draft.assetType) &&
      draft.sourceKind === "structured-form"
    );
    const structuredPreviewDraft = usesStructuredDraftPreview(draft);
    const expectedHashScope =
      normalizeText(sourceFingerprint.scope, 80) || "original-file-bytes";
    const expectedRawFileVerified = sourceFingerprint.rawFileVerified !== false;
    const auditedHashScope =
      normalizeText(previewAudit && previewAudit.sourceHashScope, 80) ||
      (expectedRawFileVerified ? "original-file-bytes" : "");
    if (
      decision === "approve" &&
      (!previewAudit ||
        previewAudit.draftId !== draftId ||
        previewAudit.snapshotHash !== expectedSnapshotHash ||
        previewAudit.adminAccountId !== currentAdmin._id ||
        previewAudit.sourceSha256 !== sourceFingerprint.sha256 ||
        (
          structuredPreviewDraft &&
          previewAudit.previewKind !== "structured"
        ) ||
        auditedHashScope !== expectedHashScope ||
        (
          structuredPreviewDraft &&
          previewAudit.rawFileVerified !== expectedRawFileVerified
        ) ||
        (
          !structuredPreviewDraft &&
          previewAudit.rawFileVerified !== undefined &&
          previewAudit.rawFileVerified !== expectedRawFileVerified
        ))
    ) {
      return {
        success: false,
        code: "DRAFT_ASSET_PREVIEW_REQUIRED",
        message: "批准前必须先预览当前审核快照对应的原件"
      };
    }

    const state = decision === "approve"
      ? "approved"
      : decision === "request_changes"
        ? "changes_requested"
        : "rejected";
    const now = db.serverDate();
    const nextVersion = draft.draftVersion + 1;
    const review = {
      ...draft.review,
      decision,
      reviewedBy: admin.account._id,
      reviewedAt: now,
      note
    };
    const updated = {
      ...draft,
      state,
      draftVersion: nextVersion,
      snapshotHash: state === "approved" ? expectedSnapshotHash : "",
      review,
      lastMutation: createLastMutation("reviewDraft", mutation.requestId, requestHash),
      updateTime: now
    };
    await draftReference.update({
      data: {
        state,
        draftVersion: nextVersion,
        snapshotHash: updated.snapshotHash,
        review,
        lastMutation: updated.lastMutation,
        updateTime: now
      }
    });
    if (!standaloneStructuredDraft) {
      await uploadReference.update({
        data: { reviewStatus: state, updateTime: now }
      });
    }
    return { success: true, alreadyApplied: false, draft: publicDraft(updated) };
  });
  return unwrapTransactionResult(rawResult);
}

function storagePathFromFileID(fileID) {
  const parsed = parseCloudFileID(fileID);
  return parsed ? parsed.cloudPath : "";
}

function derivePreparedCloudPath(assetType, targetId, uploadId, extension) {
  const normalizedTargetId = normalizeText(targetId, 64).toLowerCase();
  const normalizedUploadId = normalizeText(uploadId, 32).toLowerCase();
  const normalizedExtension = normalizeText(extension, 16).toLowerCase();

  if (
    !DRAFT_ID_PATTERN.test(normalizedUploadId) ||
    !STABLE_ID_PATTERN.test(normalizedTargetId)
  ) {
    return "";
  }
  if (assetType === "audio" && /^\.(?:mp3|m4a|wav)$/.test(normalizedExtension)) {
    return `published/audio/${normalizedTargetId}/assets/${normalizedUploadId}/primary${normalizedExtension}`;
  }
  if (assetType === "full-book-pdf" && normalizedExtension === ".pdf") {
    return `protected/books/${normalizedTargetId}/assets/${normalizedUploadId}/${normalizedTargetId}.pdf`;
  }
  if (
    assetType === "topic-image" &&
    /^\.(?:jpe?g|png|webp)$/.test(normalizedExtension)
  ) {
    return `protected/special-topics/${normalizedTargetId}/assets/${normalizedUploadId}/images/${normalizedUploadId}${normalizedExtension}`;
  }
  return "";
}

function expectedPreparedCloudPath(draft) {
  return derivePreparedCloudPath(
    draft && draft.assetType,
    draft && draft.targetId,
    draft && draft._id,
    draft && draft.extension
  );
}

function hasExactPreparedAsset(draft) {
  const preparedFileID = normalizeText(draft && draft.preparedFileID, 2048);
  const preparedCloudPath = normalizeText(draft && draft.preparedCloudPath, 512);
  const parsedPath = storagePathFromFileID(preparedFileID);
  const expectedCloudPath = expectedPreparedCloudPath(draft);
  return Boolean(
    expectedCloudPath &&
      preparedCloudPath === expectedCloudPath &&
      parsedPath === preparedCloudPath &&
      !preparedCloudPath.includes("..") &&
      !preparedCloudPath.includes("\\")
  );
}

function hasExactSourceAsset(draft) {
  const draftId = normalizeText(draft && draft._id, 32).toLowerCase();
  const extension = normalizeText(draft && draft.extension, 16).toLowerCase();
  const cloudPath = storagePathFromFileID(draft && draft.sourceFileID);
  const parts = cloudPath.split("/");
  const sourceTransportMode = normalizeText(
    draft && draft.sourceTransportMode,
    32
  );
  const fingerprint =
    draft &&
    Array.isArray(draft.sourceFingerprints) &&
    draft.sourceFingerprints[0];
  const brokerSource = Boolean(
    parts[0] === "admin-staging" &&
    (!sourceTransportMode || sourceTransportMode === "https-broker")
  );
  const directManifestSource = Boolean(
    parts[0] === "admin-direct-staging" &&
    sourceTransportMode === "cloud-storage-direct" &&
    draft.rawFileValidationStatus === "unverified" &&
    fingerprint &&
    fingerprint.rawFileVerified === false &&
    fingerprint.scope === "client-parsed-docx-manifest"
  );
  return Boolean(
    DRAFT_ID_PATTERN.test(draftId) &&
    /^\.[a-z0-9]{2,8}$/.test(extension) &&
    parts.length === 4 &&
    (brokerSource || directManifestSource) &&
    /^[a-f0-9]{24}$/.test(parts[1]) &&
    parts[2] === draftId &&
    parts[3] === `source${extension}`
  );
}

function isClientManifestOnlyDraft(draft) {
  const fingerprint =
    draft &&
    Array.isArray(draft.sourceFingerprints) &&
    draft.sourceFingerprints[0];
  const inspection = draft && draft.inspection;
  const metadata = inspection && inspection.metadata;
  return Boolean(
    draft &&
    ["manuscript", "special-topic"].includes(draft.assetType) &&
    draft.sourceMode === "client-manifest-only" &&
    draft.originalFileUploadRequired === false &&
    draft.sourceTransportMode === "cloud-storage-direct" &&
    !normalizeText(draft.sourceFileID, 2048) &&
    draft.rawFileValidationStatus === "not_uploaded" &&
    fingerprint &&
    /^[a-f0-9]{64}$/.test(normalizeText(fingerprint.sha256, 64)) &&
    fingerprint.scope === "client-parsed-docx-manifest" &&
    fingerprint.rawFileVerified === false &&
    fingerprint.originalFileRetained === false &&
    inspection &&
    inspection.format === "docx-client-manifest" &&
    inspection.structuredContentValid === true &&
    inspection.rawFileSignatureValid === false &&
    inspection.needsManualStructure === true &&
    metadata &&
    metadata.originalFileRetained === false &&
    metadata.manifestSha256 === fingerprint.sha256 &&
    metadata.manifestHashScope === fingerprint.scope
  );
}

function usesStructuredDraftPreview(draft) {
  return Boolean(
    (
      isStructuredEditorialAsset(draft && draft.assetType) &&
      draft.sourceKind === "structured-form"
    ) ||
    isClientManifestOnlyDraft(draft)
  );
}

function previewAuditId(draftId, adminId, snapshot) {
  return sha256(`${draftId}:${adminId}:${snapshot}`);
}

async function getDraftAssetPreview(event, admin, openid) {
  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  const expectedSnapshotHash = normalizeText(
    event.expectedSnapshotHash,
    64
  ).toLowerCase();
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    return { success: false, code: "INVALID_DRAFT_ID", message: "草稿编号无效" };
  }

  const preliminaryDraft = await getDocumentOrNull(
    db.collection("adminContentDrafts").doc(draftId)
  );
  if (!canReadDraft(admin, preliminaryDraft)) {
    return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
  }
  const snapshotRequired = ["in_review", "approved"].includes(
    preliminaryDraft.state
  );
  if (
    snapshotRequired &&
    (preliminaryDraft.snapshotHash !== expectedSnapshotHash ||
      !SNAPSHOT_HASH_PATTERN.test(expectedSnapshotHash))
  ) {
    return {
      success: false,
      code: "DRAFT_SNAPSHOT_CHANGED",
      message: "草稿审核快照已变化"
    };
  }

  const structuredFormPreview = Boolean(
    isStructuredEditorialAsset(preliminaryDraft.assetType) &&
    preliminaryDraft.sourceKind === "structured-form"
  );
  const manifestOnlyPreview = isClientManifestOnlyDraft(preliminaryDraft);
  if (structuredFormPreview || manifestOnlyPreview) {
    const issues = payloadIssues(
      preliminaryDraft.assetType,
      preliminaryDraft.payload
    );
    if (issues.length > 0) {
      return {
        success: false,
        code: "DRAFT_PAYLOAD_INVALID",
        message: issues[0],
        issues
      };
    }
    if (manifestOnlyPreview && !hasExactEmbeddedAssets(preliminaryDraft)) {
      return {
        success: false,
        code: "PUBLISH_EMBEDDED_ASSET_INVALID",
        message: "Word 内嵌图片引用无效"
      };
    }

    const fingerprint =
      Array.isArray(preliminaryDraft.sourceFingerprints) &&
      preliminaryDraft.sourceFingerprints[0] || {};
    const sourceSha256 = structuredFormPreview
      ? sha256(canonicalStringify(preliminaryDraft.payload))
      : normalizeText(fingerprint.sha256, 64);
    const sourceHashScope = structuredFormPreview
      ? "structured-form-canonical"
      : "client-parsed-docx-manifest";
    const rawFileVerified = structuredFormPreview;
    if (
      fingerprint.scope !== sourceHashScope ||
      fingerprint.sha256 !== sourceSha256
    ) {
      return {
        success: false,
        code: "DRAFT_SNAPSHOT_CHANGED",
        message: "结构化内容摘要已变化"
      };
    }

    // The draft and administrator were already read and authorized for this
    // request. Avoid rereading a large Word manifest inside a transaction: the
    // deterministic audit is bound to the exact snapshot hash, and reviewDraft
    // revalidates the administrator, fingerprint and snapshot before approval.
    if (
      preliminaryDraft.state === "in_review" &&
      hasAnyRole(admin, REVIEW_ROLES)
    ) {
      const auditId = previewAuditId(
        draftId,
        admin.account._id,
        expectedSnapshotHash
      );
      await db
        .collection("adminDraftPreviewAudits")
        .doc(auditId)
        .set({
          data: {
            draftId,
            snapshotHash: expectedSnapshotHash,
            adminAccountId: admin.account._id,
            sourceSha256,
            sourceHashScope,
            rawFileVerified,
            previewKind: "structured",
            sourceMode: structuredFormPreview
              ? "structured-form"
              : "client-manifest-only",
            assetType: preliminaryDraft.assetType,
            previewedAt: db.serverDate(),
            schemaVersion: 1
          }
        });
    }
    return {
      success: true,
      previewKind: "structured",
      draftId,
      assetType: preliminaryDraft.assetType,
      targetId: preliminaryDraft.targetId,
      snapshotHash: preliminaryDraft.snapshotHash,
      sourceMode: structuredFormPreview
        ? "structured-form"
        : "client-manifest-only",
      rawFileVerified: structuredFormPreview,
      warning: manifestOnlyPreview
        ? "The original DOCX was not uploaded or retained; review the structured content and all embedded images before approval."
        : ""
    };
  }

  const usesPreparedAsset = ["audio", "full-book-pdf", "topic-image"].includes(
    preliminaryDraft.assetType
  );
  if (
    (usesPreparedAsset && !hasExactPreparedAsset(preliminaryDraft)) ||
    (!usesPreparedAsset && !hasExactSourceAsset(preliminaryDraft))
  ) {
    return {
      success: false,
      code: "DRAFT_ASSET_INVALID",
      message: "草稿原件引用无效"
    };
  }
  const fileID = usesPreparedAsset
    ? preliminaryDraft.preparedFileID
    : preliminaryDraft.sourceFileID;
  const delivery = await createTemporaryFileURL(fileID);
  if (!delivery.success) {
    return delivery;
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction.collection("adminAccounts").doc(admin.account._id);
    const draftReference = transaction.collection("adminContentDrafts").doc(draftId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReference);
    const transactionalAdmin = { account: currentAdmin, roles: getRoles(currentAdmin) };
    if (!isAuthorizedAccount(currentAdmin, openid) || !canReadDraft(transactionalAdmin, draft)) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    if (
      draft.sourceFileID !== preliminaryDraft.sourceFileID ||
      draft.preparedFileID !== preliminaryDraft.preparedFileID ||
      draft.snapshotHash !== preliminaryDraft.snapshotHash ||
      draft.state !== preliminaryDraft.state
    ) {
      return { success: false, code: "DRAFT_SNAPSHOT_CHANGED", message: "草稿审核快照已变化" };
    }
    if (snapshotRequired && draft.snapshotHash !== expectedSnapshotHash) {
      return { success: false, code: "DRAFT_SNAPSHOT_CHANGED", message: "草稿审核快照已变化" };
    }

    if (draft.state === "in_review" && hasAnyRole(currentAdmin, REVIEW_ROLES)) {
      const auditId = previewAuditId(draftId, currentAdmin._id, expectedSnapshotHash);
      await transaction.collection("adminDraftPreviewAudits").doc(auditId).set({
        data: {
          draftId,
          snapshotHash: expectedSnapshotHash,
          adminAccountId: currentAdmin._id,
          sourceSha256: draft.sourceFingerprints[0].sha256,
          sourceHashScope:
            normalizeText(draft.sourceFingerprints[0].scope, 80) ||
            "original-file-bytes",
          rawFileVerified:
            draft.sourceFingerprints[0].rawFileVerified !== false,
          fileKind: usesPreparedAsset ? "prepared" : "source",
          previewedAt: db.serverDate(),
          schemaVersion: 1
        }
      });
    }
    return { success: true };
  });
  const result = unwrapTransactionResult(rawResult);
  if (!result || !result.success) return result;
  return {
    success: true,
    draftId,
    snapshotHash: preliminaryDraft.snapshotHash,
    mimeType: normalizeText(preliminaryDraft.mimeType, 80),
    sha256: normalizeText(
      preliminaryDraft.sourceFingerprints &&
        preliminaryDraft.sourceFingerprints[0] &&
        preliminaryDraft.sourceFingerprints[0].sha256,
      64
    ),
    hashScope: normalizeText(
      preliminaryDraft.sourceFingerprints &&
        preliminaryDraft.sourceFingerprints[0] &&
        preliminaryDraft.sourceFingerprints[0].scope,
      80
    ) || "original-file-bytes",
    rawFileVerified:
      !preliminaryDraft.sourceFingerprints ||
      !preliminaryDraft.sourceFingerprints[0] ||
      preliminaryDraft.sourceFingerprints[0].rawFileVerified !== false,
    warning:
      preliminaryDraft.rawFileValidationStatus === "unverified"
        ? preliminaryDraft.assetType === "audio"
          ? "该录音仅确认精确云路径与对象存在，尚未校验实际字节、摘要、音频签名或时长；请人工完整试听后再批准"
          : "该原始 DOCX 仅用于人工对照，尚未做服务端字节级安全校验；审核依据为已绑定哈希的结构化正文快照"
        : "",
    expiresInSeconds: 300,
    previewUrl: delivery.tempFileURL
  };
}

function hasExactEmbeddedAssets(draft) {
  const embeddedAssets = Array.isArray(draft && draft.embeddedAssets)
    ? draft.embeddedAssets
    : [];
  const payloadAssets = Array.isArray(
    draft && draft.payload && draft.payload.embeddedAssets
  )
    ? draft.payload.embeddedAssets
    : [];
  if (embeddedAssets.length === 0) {
    return payloadAssets.length === 0;
  }
  if (
    !["manuscript", "special-topic"].includes(draft.assetType) ||
    embeddedAssets.length !== payloadAssets.length ||
    embeddedAssets.length > 200
  ) {
    return false;
  }
  const uploadShape = {
    _id: draft._id,
    assetType: draft.assetType,
    relatedId: draft.targetId,
    fileID: draft.sourceFileID,
    clientImageEnvironment: draft.clientImageEnvironment
  };
  const prefix = expectedClientImagePrefix(uploadShape);
  const imageEnvironment = clientImageEnvironmentForUpload(uploadShape);
  const payloadById = new Map(payloadAssets.map((asset) => [asset.id, asset]));
  const seen = new Set();
  return Boolean(
    prefix &&
    Boolean(imageEnvironment) &&
    embeddedAssets.every((asset) => {
      const payloadAsset = payloadById.get(asset.id);
      const order = Number(asset.order);
      const planShape = {
        imageOrder: order,
        extension: asset.extension,
        cloudPath: asset.cloudPath
      };
      const exact = Boolean(
        payloadAsset &&
        payloadAsset.fileID === asset.fileID &&
        payloadAsset.cloudPath === asset.cloudPath &&
        payloadAsset.extension === asset.extension &&
        payloadAsset.order === asset.order &&
        asset.id === `embedded-${String(order).padStart(4, "0")}` &&
        asset.cloudPath.startsWith(prefix) &&
        directClientImageFileMatchesPlan(
          planShape,
          asset.fileID,
          draft.sourceFileID,
          imageEnvironment
        ) &&
        !seen.has(asset.id)
      );
      seen.add(asset.id);
      return exact;
    })
  );
}

async function verifyDraftEmbeddedAssets(draft) {
  if (!hasExactEmbeddedAssets(draft)) {
    return {
      success: false,
      code: "PUBLISH_EMBEDDED_ASSET_INVALID",
      message: "Word 内嵌图片引用无效"
    };
  }
  const fileIDs = (draft.embeddedAssets || []).map((asset) => asset.fileID);
  const batches = [];
  for (
    let offset = 0;
    offset < fileIDs.length;
    offset += MAX_STORAGE_FILE_LOOKUP_BATCH
  ) {
    batches.push(fileIDs.slice(offset, offset + MAX_STORAGE_FILE_LOOKUP_BATCH));
  }
  const verifications = await Promise.all(
    batches.map((batch) =>
      verifyUploadedFiles(batch, MAX_STORAGE_FILE_LOOKUP_BATCH)
    )
  );
  if (verifications.some((verification) => !verification.success)) {
    return {
      success: false,
      code: "PUBLISH_ASSET_NOT_FOUND",
      message: "一张或多张 Word 内嵌图片不存在或无法读取"
    };
  }
  return { success: true };
}

function publicationPreparationPlan(draft) {
  const embeddedAssetCount = Array.isArray(draft && draft.embeddedAssets)
    ? draft.embeddedAssets.length
    : 0;
  const topicEntryCount =
    draft &&
    draft.assetType === "special-topic" &&
    draft.payload &&
    Array.isArray(draft.payload.entries)
      ? draft.payload.entries.length
      : 0;
  return {
    embeddedAssetCount,
    topicEntryCount,
    resumable:
      embeddedAssetCount > MAX_STORAGE_FILE_LOOKUP_BATCH ||
      topicEntryCount > MAX_PUBLISH_ENTRY_BATCH
  };
}

function normalizePublicationPreparation(draft, plan) {
  const value = draft && draft.publicationPreparation;
  const matches = Boolean(
    value &&
    value.snapshotHash === draft.snapshotHash &&
    value.revision === draft.revision &&
    Number(value.embeddedAssetCount) === plan.embeddedAssetCount &&
    Number(value.topicEntryCount) === plan.topicEntryCount
  );
  return {
    snapshotHash: draft.snapshotHash,
    revision: draft.revision,
    embeddedAssetCount: plan.embeddedAssetCount,
    topicEntryCount: plan.topicEntryCount,
    verifiedEmbeddedAssetCount: matches
      ? normalizeInteger(
          value.verifiedEmbeddedAssetCount,
          0,
          0,
          plan.embeddedAssetCount
        )
      : 0,
    preparedTopicEntryCount: matches
      ? normalizeInteger(
          value.preparedTopicEntryCount,
          0,
          0,
          plan.topicEntryCount
        )
      : 0
  };
}

function isPublicationPreparationComplete(preparation, plan) {
  return Boolean(
    preparation &&
    preparation.verifiedEmbeddedAssetCount >= plan.embeddedAssetCount &&
    preparation.preparedTopicEntryCount >= plan.topicEntryCount
  );
}

function hasCompleteSpecialTopicPublicationPreparation(draft) {
  const preparation = draft && draft.publicationPreparation;
  if (
    !draft ||
    draft.assetType !== "special-topic" ||
    !preparation ||
    preparation.status !== "prepared" ||
    preparation.snapshotHash !== draft.snapshotHash ||
    preparation.revision !== draft.revision
  ) {
    return false;
  }
  const embeddedAssetCount = Number(preparation.embeddedAssetCount);
  const topicEntryCount = Number(preparation.topicEntryCount);
  const verifiedEmbeddedAssetCount = Number(
    preparation.verifiedEmbeddedAssetCount
  );
  const preparedTopicEntryCount = Number(
    preparation.preparedTopicEntryCount
  );
  return Boolean(
    Number.isInteger(embeddedAssetCount) &&
    embeddedAssetCount >= 0 &&
    Number.isInteger(topicEntryCount) &&
    topicEntryCount > 0 &&
    Number.isInteger(verifiedEmbeddedAssetCount) &&
    verifiedEmbeddedAssetCount >= embeddedAssetCount &&
    Number.isInteger(preparedTopicEntryCount) &&
    preparedTopicEntryCount >= topicEntryCount
  );
}

function publicDraftState(draft) {
  const result = publicDraft(draft);
  // The editor already has the approved payload. Omitting it from the final
  // publish response keeps a near-limit Word draft from spending the last part
  // of the three-second free-tier budget on response serialization.
  delete result.payload;
  return result;
}

async function advancePublicationPreparation(
  draftId,
  expectedSnapshotHash,
  progress
) {
  const rawResult = await db.runTransaction(async (transaction) => {
    const reference = transaction
      .collection("adminContentDrafts")
      .doc(draftId);
    const current = await getDocumentOrNull(reference);
    if (!current) {
      return {
        success: false,
        code: "DRAFT_NOT_FOUND",
        message: "内容草稿不存在"
      };
    }
    if (current.state === "published") {
      return {
        success: true,
        published: true,
        draft: publicDraftState(current)
      };
    }
    if (
      current.state !== "approved" ||
      current.snapshotHash !== expectedSnapshotHash ||
      current.review.submittedSnapshotHash !== expectedSnapshotHash
    ) {
      return {
        success: false,
        code: "DRAFT_SNAPSHOT_CHANGED",
        message: "已批准快照发生变化"
      };
    }
    const plan = publicationPreparationPlan(current);
    const previous = normalizePublicationPreparation(current, plan);
    const preparation = {
      ...previous,
      verifiedEmbeddedAssetCount: Math.max(
        previous.verifiedEmbeddedAssetCount,
        normalizeInteger(
          progress && progress.verifiedEmbeddedAssetCount,
          previous.verifiedEmbeddedAssetCount,
          0,
          plan.embeddedAssetCount
        )
      ),
      preparedTopicEntryCount: Math.max(
        previous.preparedTopicEntryCount,
        normalizeInteger(
          progress && progress.preparedTopicEntryCount,
          previous.preparedTopicEntryCount,
          0,
          plan.topicEntryCount
        )
      ),
      status: "preparing",
      updateTime: db.serverDate()
    };
    if (isPublicationPreparationComplete(preparation, plan)) {
      preparation.status = "prepared";
    }
    await reference.update({ data: { publicationPreparation: preparation } });
    return { success: true, preparation, plan };
  });
  return unwrapTransactionResult(rawResult);
}

function publicationPendingResult(phase, preparation, plan) {
  const verifiesAssets = phase === "verifying-assets";
  return {
    success: true,
    pending: true,
    phase,
    processed: verifiesAssets
      ? preparation.verifiedEmbeddedAssetCount
      : preparation.preparedTopicEntryCount,
    total: verifiesAssets
      ? plan.embeddedAssetCount
      : plan.topicEntryCount,
    message: verifiesAssets
      ? `正在核验 Word 图片（${preparation.verifiedEmbeddedAssetCount}/${plan.embeddedAssetCount}）`
      : `正在准备小专题目录（${preparation.preparedTopicEntryCount}/${plan.topicEntryCount}）`
  };
}

async function prepareSpecialTopicEntries(
  draft,
  startOffset = 0,
  maximumEntries = 0
) {
  const entries = [];
  const imageDrafts = new Map();
  const verifiedImageDraftIds = new Set();
  const embeddedAssets = new Map(
    (Array.isArray(draft && draft.embeddedAssets) ? draft.embeddedAssets : [])
      .map((asset) => [asset.id, asset])
  );

  const allEntries = Array.isArray(draft && draft.payload && draft.payload.entries)
    ? draft.payload.entries
    : [];
  const safeStartOffset = normalizeInteger(
    startOffset,
    0,
    0,
    allEntries.length
  );
  const safeMaximumEntries = maximumEntries > 0
    ? normalizeInteger(maximumEntries, 1, 1, MAX_PUBLISH_ENTRY_BATCH)
    : allEntries.length;
  const sourceEntries = allEntries.slice(
    safeStartOffset,
    safeStartOffset + safeMaximumEntries
  );

  for (const entry of sourceEntries) {
    const blocks = [];
    for (const block of entry.blocks) {
      if (block.type !== "image") {
        blocks.push(block);
        continue;
      }

      if (block.embeddedAssetId) {
        const embeddedAsset = embeddedAssets.get(block.embeddedAssetId);
        if (!embeddedAsset) {
          return {
            success: false,
            code: "PUBLISH_PREPARATION_INCOMPLETE",
            message: "专题内嵌图片与正文位置不一致"
          };
        }
        blocks.push({
          type: "image",
          fileID: embeddedAsset.fileID,
          caption: block.caption || embeddedAsset.caption
        });
        continue;
      }

      let imageDraft = imageDrafts.get(block.imageDraftId);
      if (!imageDraft) {
        imageDraft = await getDocumentOrNull(
          db.collection("adminContentDrafts").doc(block.imageDraftId)
        );
        imageDrafts.set(block.imageDraftId, imageDraft);
      }
      if (
        !imageDraft ||
        imageDraft.assetType !== "topic-image" ||
        imageDraft.targetId !== draft.targetId ||
        !["approved", "published"].includes(imageDraft.state) ||
        !hasExactPreparedAsset(imageDraft)
      ) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "专题图片尚未完成校验和审核"
        };
      }
      if (!verifiedImageDraftIds.has(imageDraft._id)) {
        const verification = await verifyUploadedFile(imageDraft.preparedFileID);
        if (!verification.success) {
          return {
            success: false,
            code: "PUBLISH_ASSET_NOT_FOUND",
            message: "专题图片不存在或无法读取"
          };
        }
        verifiedImageDraftIds.add(imageDraft._id);
      }
      blocks.push({
        type: "image",
        fileID: imageDraft.preparedFileID,
        caption: block.caption
      });
    }
    entries.push({ sortOrder: entry.sortOrder, blocks });
  }

  for (
    let offset = 0;
    offset < entries.length;
    offset += MAX_PUBLISH_ENTRY_BATCH
  ) {
    const batch = entries.slice(offset, offset + MAX_PUBLISH_ENTRY_BATCH);
    await Promise.all(batch.map(async (entry, batchIndex) => {
      const index = safeStartOffset + offset + batchIndex;
      const entryId = `${draft.targetId}-${draft._id.slice(0, 12)}-${index + 1}`;
      await db.collection("specialTopicEntries").doc(entryId).set({
        data: {
          topicId: draft.targetId,
          topicRevision: draft.revision,
          sortOrder: entry.sortOrder,
          blocks: entry.blocks,
          status: "published",
          reviewStatus: "approved",
          sourceDraftId: draft._id,
          schemaVersion: 1
        }
      });
    }));
  }

  return {
    success: true,
    entries,
    entryCount: entries.length,
    nextOffset: safeStartOffset + entries.length
  };
}

async function prepareNextPublicationStep(draft) {
  const plan = publicationPreparationPlan(draft);
  if (!plan.resumable) {
    return { success: true, pending: false, plan };
  }
  let preparation = normalizePublicationPreparation(draft, plan);

  if (preparation.verifiedEmbeddedAssetCount < plan.embeddedAssetCount) {
    if (!hasExactEmbeddedAssets(draft)) {
      return {
        success: false,
        code: "PUBLISH_EMBEDDED_ASSET_INVALID",
        message: "Word 内嵌图片引用无效"
      };
    }
    const start = preparation.verifiedEmbeddedAssetCount;
    const end = Math.min(
      start + MAX_STORAGE_FILE_LOOKUP_BATCH,
      plan.embeddedAssetCount
    );
    const fileIDs = draft.embeddedAssets
      .slice(start, end)
      .map((asset) => asset.fileID);
    const verification = await verifyUploadedFiles(
      fileIDs,
      MAX_STORAGE_FILE_LOOKUP_BATCH
    );
    if (!verification.success) {
      return {
        success: false,
        code: "PUBLISH_ASSET_NOT_FOUND",
        message: "一张或多张 Word 内嵌图片不存在或无法读取"
      };
    }
    const advanced = await advancePublicationPreparation(
      draft._id,
      draft.snapshotHash,
      { verifiedEmbeddedAssetCount: end }
    );
    if (!advanced.success || advanced.published) return advanced;
    return publicationPendingResult(
      "verifying-assets",
      advanced.preparation,
      advanced.plan
    );
  }

  if (preparation.preparedTopicEntryCount < plan.topicEntryCount) {
    const start = preparation.preparedTopicEntryCount;
    const prepared = await prepareSpecialTopicEntries(
      draft,
      start,
      MAX_PUBLISH_ENTRY_BATCH
    );
    if (!prepared.success) return prepared;
    const advanced = await advancePublicationPreparation(
      draft._id,
      draft.snapshotHash,
      { preparedTopicEntryCount: prepared.nextOffset }
    );
    if (!advanced.success || advanced.published) return advanced;
    return publicationPendingResult(
      "preparing-entries",
      advanced.preparation,
      advanced.plan
    );
  }

  return { success: true, pending: false, plan, preparation };
}

async function prepareBookChapters(draft) {
  if (
    !draft ||
    !draft.payload ||
    !["replace", "from-published-contents"].includes(
      draft.payload.structureMode
    )
  ) {
    return {
      success: false,
      code: "PUBLISH_PREPARATION_INCOMPLETE",
      message: "整书章节尚未完整准备"
    };
  }

  let chapters = Array.isArray(draft.payload.chapters)
    ? draft.payload.chapters
    : [];
  if (draft.payload.structureMode === "from-published-contents") {
    const sourceResult = await db
      .collection("contents")
      .where({
        bookId: draft.targetId,
        status: "published"
      })
      .orderBy("sortOrder", "asc")
      .orderBy("_id", "asc")
      .limit(MAX_BOOK_CHAPTERS + 1)
      .get();
    const sourceContents =
      sourceResult && Array.isArray(sourceResult.data)
        ? sourceResult.data
        : [];
    if (sourceContents.length === 0) {
      return {
        success: false,
        code: "BOOK_PUBLISHED_CONTENT_REQUIRED",
        message: "请先发布至少一篇归属该书的正文，再发布整书 PDF"
      };
    }
    if (sourceContents.length > MAX_BOOK_CHAPTERS) {
      return {
        success: false,
        code: "BOOK_PUBLISHED_CONTENT_LIMIT",
        message: `一本书最多支持 ${MAX_BOOK_CHAPTERS} 篇已发布正文`
      };
    }
    const rawChapters = sourceContents.map((content, index) => {
      const sourceContentId = normalizeText(
        content && (content.contentId || content._id),
        64
      ).toLowerCase();
      const readableChapterId = `${draft.targetId}-${sourceContentId}`;
      const hashLength = Math.min(
        24,
        Math.max(0, 63 - draft.targetId.length)
      );
      const chapterId = STABLE_ID_PATTERN.test(readableChapterId)
        ? readableChapterId
        : hashLength > 0
          ? `${draft.targetId}-${sha256(
              canonicalStringify([
                "published-content-chapter",
                draft.targetId,
                sourceContentId
              ])
            ).slice(0, hashLength)}`
          : "";
      return {
        chapterId,
        sourceContentId,
        sourceContentRevision: normalizeText(
          content && content.currentRevision,
          128
        ),
        title: normalizeText(content && content.title, 160),
        sortOrder: Number.isInteger(content && content.sortOrder)
          ? content.sortOrder
          : (index + 1) * 10,
        sections: content && content.sections
      };
    });
    const normalized = normalizePayload(
      "full-book-pdf",
      {
        title: draft.payload.title,
        subtitle: draft.payload.subtitle,
        fileName: draft.payload.fileName,
        structureMode: "replace",
        structureConfirmed: true,
        chapters: rawChapters
      },
      { targetId: draft.targetId, mimeType: "application/pdf" }
    );
    if (
      !normalized ||
      !Array.isArray(normalized.chapters) ||
      normalized.chapters.length !== sourceContents.length ||
      normalized.chapters.some((chapter) =>
        !chapter.sourceContentId ||
        !chapter.sourceContentRevision
      )
    ) {
      return {
        success: false,
        code: "BOOK_PUBLISHED_CONTENT_INVALID",
        message: "已发布正文缺少标题、版本或完整正文结构，请先修正文稿"
      };
    }
    chapters = normalized.chapters;
  }
  if (chapters.length === 0) {
    return {
      success: false,
      code: "PUBLISH_PREPARATION_INCOMPLETE",
      message: "整书章节尚未完整准备"
    };
  }

  const chapterIds = [];
  const sourceContentIds = new Set();
  for (let offset = 0; offset < chapters.length; offset += 10) {
    const batch = chapters.slice(offset, offset + 10);
    await Promise.all(batch.map(async (chapter) => {
      const chapterDocumentId = `${chapter.chapterId}-${draft._id.slice(0, 12)}`;
      chapterIds.push(chapterDocumentId);
      if (chapter.sourceContentId) {
        sourceContentIds.add(chapter.sourceContentId);
      }
      await db.collection("bookChapters").doc(chapterDocumentId).set({
        data: {
          chapterId: chapter.chapterId,
          bookId: draft.targetId,
          bookRevision: draft.revision,
          sourceContentId: chapter.sourceContentId,
          sourceContentRevision: chapter.sourceContentRevision,
          title: chapter.title,
          sortOrder: chapter.sortOrder,
          sections: chapter.sections,
          status: "published",
          reviewStatus: "approved",
          sourceDraftId: draft._id,
          schemaVersion: 1
        }
      });
    }));
  }

  return {
    success: true,
    chapterIds,
    sourceContentIds: Array.from(sourceContentIds),
    sourceContentRevisions: chapters
      .filter((chapter) => chapter.sourceContentId)
      .map((chapter) => ({
        contentId: chapter.sourceContentId,
        revision: chapter.sourceContentRevision
      }))
  };
}

async function hasPublishedBookStructure(bookId, revision) {
  if (!STABLE_ID_PATTERN.test(bookId) || !normalizeText(revision, 128)) {
    return false;
  }
  const result = await db
    .collection("bookChapters")
    .where({ bookId, bookRevision: revision, status: "published" })
    .limit(1)
    .get();
  return Boolean(result && Array.isArray(result.data) && result.data.length === 1);
}

function withoutDocumentId(document) {
  if (!document || typeof document !== "object") {
    return null;
  }
  const { _id: ignoredDocumentId, ...data } = document;
  return data;
}

function projectDocumentReference(reference, fields) {
  return reference && typeof reference.field === "function"
    ? reference.field(fields)
    : reference;
}

async function publishPreparedSpecialTopicFast({
  preliminaryDraft,
  draftId,
  expectedSnapshotHash,
  expectedTargetRevision,
  mutation,
  requestHash,
  admin,
  openid
}) {
  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const draftReference = transaction
      .collection("adminContentDrafts")
      .doc(draftId);
    const draftReadReference = projectDocumentReference(
      draftReference,
      SPECIAL_TOPIC_FINAL_TRANSACTION_FIELDS
    );
    const targetReference = transaction
      .collection("specialTopics")
      .doc(preliminaryDraft.targetId);
    const targetReadReference = projectDocumentReference(targetReference, {
      _id: true,
      topicId: true,
      currentRevision: true,
      title: true,
      summary: true,
      producer: true,
      unlockCostStars: true,
      sortOrder: true,
      previewCover: true,
      status: true,
      reviewStatus: true,
      sourceDraftId: true,
      publishedAt: true,
      updateTime: true,
      schemaVersion: true
    });
    const revisionReference = transaction
      .collection("adminPublishedRevisions")
      .doc(draftId);

    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReadReference);
    if (
      !isAuthorizedAccount(currentAdmin, openid) ||
      !hasAnyRole(currentAdmin, PUBLISH_ROLES)
    ) {
      return {
        success: false,
        code: "CONTENT_PUBLISH_FORBIDDEN",
        message: "内容发布权限已失效"
      };
    }
    if (!draft) {
      return {
        success: false,
        code: "DRAFT_NOT_FOUND",
        message: "内容草稿不存在"
      };
    }

    const replay = replayMutation(
      draft,
      "publishDraft",
      mutation.requestId,
      requestHash
    );
    if (replay) {
      return replay.success
        ? { ...replay, draft: publicDraftState(draft) }
        : replay;
    }
    if (draft.state === "published") {
      return {
        success: true,
        alreadyApplied: true,
        draft: publicDraftState(draft)
      };
    }

    const review = draft.review || {};
    const preliminaryReview = preliminaryDraft.review || {};
    if (
      draft.assetType !== "special-topic" ||
      draft.state !== "approved" ||
      draft.targetId !== preliminaryDraft.targetId ||
      draft.revision !== preliminaryDraft.revision ||
      draft.basePublishedRevision !== preliminaryDraft.basePublishedRevision ||
      draft.draftVersion !== preliminaryDraft.draftVersion ||
      draft.snapshotHash !== expectedSnapshotHash ||
      review.submittedSnapshotHash !== expectedSnapshotHash ||
      review.decision !== "approve" ||
      !Number.isInteger(review.submittedDraftVersion) ||
      review.submittedDraftVersion !== preliminaryReview.submittedDraftVersion ||
      !hasCompleteSpecialTopicPublicationPreparation(draft)
    ) {
      return {
        success: false,
        code: "DRAFT_SNAPSHOT_CHANGED",
        message: "已批准快照发生变化"
      };
    }

    const target = await getDocumentOrNull(targetReadReference);
    const currentTargetRevision = publishedRevisionForTarget(
      "special-topic",
      target
    );
    if (
      currentTargetRevision !== expectedTargetRevision ||
      draft.basePublishedRevision !== expectedTargetRevision
    ) {
      return {
        success: false,
        code: "TARGET_REVISION_CONFLICT",
        message: "目标内容已发布新版本，请重新创建草稿"
      };
    }

    const payload = preliminaryDraft.payload || {};
    const now = db.serverDate();
    await targetReference.set({
      data: {
        topicId: draft.targetId,
        currentRevision: draft.revision,
        title: payload.title,
        summary: payload.summary,
        producer: payload.producer,
        unlockCostStars: payload.unlockCostStars,
        sortOrder: payload.sortOrder,
        previewCover: payload.previewCoverFileID,
        status: "published",
        reviewStatus: "approved",
        sourceDraftId: draftId,
        publishedAt: now,
        updateTime: now,
        schemaVersion: 1
      }
    });

    // The approved draft is the immutable payload snapshot. Revision history
    // points to it instead of copying the near-limit Word payload and its image
    // manifest into another document during the final transaction.
    await revisionReference.set({
      data: {
        draftId,
        assetType: "special-topic",
        targetCollection: "specialTopics",
        targetId: draft.targetId,
        revision: draft.revision,
        previousRevision: currentTargetRevision,
        previousAssetRevision: "",
        previousDocument: withoutDocumentId(target),
        payloadSource: {
          collection: "adminContentDrafts",
          documentId: draftId,
          snapshotHash: expectedSnapshotHash
        },
        snapshotHash: expectedSnapshotHash,
        publishedBy: currentAdmin._id,
        publishedAt: now,
        schemaVersion: 1
      }
    });

    const nextVersion = draft.draftVersion + 1;
    const publication = {
      status: "published",
      previousRevision: currentTargetRevision,
      publishedRevision: draft.revision,
      publishedBy: currentAdmin._id,
      publishedAt: now
    };
    const lastMutation = createLastMutation(
      "publishDraft",
      mutation.requestId,
      requestHash
    );
    await draftReference.update({
      data: {
        state: "published",
        draftVersion: nextVersion,
        publication,
        publicationPreparation: null,
        lastMutation,
        updateTime: now
      }
    });
    const uploadId =
      normalizeText(draft.sourceUploadId, 32).toLowerCase() || draftId;
    await transaction.collection("adminUploads").doc(uploadId).update({
      data: {
        reviewStatus: "published",
        publicationStatus: "published",
        updateTime: now
      }
    });

    return {
      success: true,
      alreadyApplied: false,
      draft: publicDraftState({
        ...draft,
        state: "published",
        draftVersion: nextVersion,
        publication,
        publicationPreparation: null,
        lastMutation,
        updateTime: now
      })
    };
  });

  return unwrapTransactionResult(rawResult);
}

async function publishDraft(event, admin, openid) {
  const authorization = requireRole(
    admin,
    PUBLISH_ROLES,
    "CONTENT_PUBLISH_FORBIDDEN",
    "当前管理员没有内容发布权限"
  );
  if (!authorization.success) return authorization;

  const draftId = normalizeText(event.draftId, 32).toLowerCase();
  const expectedSnapshotHash = normalizeText(event.expectedSnapshotHash, 64).toLowerCase();
  const expectedTargetRevision = normalizeText(event.expectedTargetRevision, 128);
  if (
    !DRAFT_ID_PATTERN.test(draftId) ||
    !SNAPSHOT_HASH_PATTERN.test(expectedSnapshotHash)
  ) {
    return { success: false, code: "INVALID_PUBLISH_REQUEST", message: "发布参数无效" };
  }
  const mutation = validateMutationRequest(event);
  if (!mutation.success) return mutation;
  const requestHash = mutationHash("publishDraft", {
    ...event,
    expectedSnapshotHash,
    expectedTargetRevision
  }, ["draftId", "expectedSnapshotHash", "expectedTargetRevision"]);

  const preliminaryDraftReference = db
    .collection("adminContentDrafts")
    .doc(draftId);
  const projectedDraft = await getDocumentOrNull(
    projectDocumentReference(
      preliminaryDraftReference,
      SPECIAL_TOPIC_PUBLISH_GUARD_FIELDS
    )
  );
  let preliminaryDraft = projectedDraft;
  if (!preliminaryDraft) {
    return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
  }
  let fastSpecialTopicFinal = Boolean(
    preliminaryDraft.assetType === "special-topic" &&
    preliminaryDraft.state === "approved" &&
    hasCompleteSpecialTopicPublicationPreparation(preliminaryDraft)
  );
  if (
    preliminaryDraft.assetType !== "special-topic" ||
    (preliminaryDraft.state === "approved" && !fastSpecialTopicFinal)
  ) {
    preliminaryDraft = await getDocumentOrNull(preliminaryDraftReference);
    if (!preliminaryDraft) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    fastSpecialTopicFinal = false;
  }
  const preliminaryUpload = isStructuredEditorialAsset(
    preliminaryDraft.assetType
  ) || fastSpecialTopicFinal
    ? null
    : await getDocumentOrNull(
        db.collection("adminUploads").doc(
          normalizeText(preliminaryDraft.sourceUploadId, 32).toLowerCase() ||
            draftId
        )
      );
  const knownChapterSource = knownChapterSourceRejection(
    preliminaryUpload || preliminaryDraft
  );
  if (knownChapterSource) {
    return knownChapterSource;
  }
  if (
    preliminaryDraft.state !== "approved" &&
    preliminaryDraft.state !== "published"
  ) {
    return { success: false, code: "DRAFT_STATE_CONFLICT", message: "草稿尚未审核通过" };
  }
  if (
    preliminaryDraft.snapshotHash !== expectedSnapshotHash ||
    preliminaryDraft.review.submittedSnapshotHash !== expectedSnapshotHash
  ) {
    return { success: false, code: "DRAFT_SNAPSHOT_CHANGED", message: "审核快照已变化" };
  }
  if (preliminaryDraft.state === "published") {
    const replay = replayMutation(
      preliminaryDraft,
      "publishDraft",
      mutation.requestId,
      requestHash
    );
    if (replay) {
      return replay.success
        ? { ...replay, draft: publicDraftState(preliminaryDraft) }
        : replay;
    }
    return {
      success: true,
      alreadyApplied: true,
      draft: publicDraftState(preliminaryDraft)
    };
  }
  if (
    !Number.isInteger(preliminaryDraft.review.submittedDraftVersion) ||
    (!fastSpecialTopicFinal &&
      snapshotHash({
        ...preliminaryDraft,
        draftVersion: preliminaryDraft.review.submittedDraftVersion
      }) !== expectedSnapshotHash)
  ) {
    return { success: false, code: "DRAFT_SNAPSHOT_CHANGED", message: "审核快照已变化" };
  }
  if (["audio", "full-book-pdf", "topic-image"].includes(preliminaryDraft.assetType)) {
    if (!hasExactPreparedAsset(preliminaryDraft)) {
      return {
        success: false,
        code: "PUBLISH_PREPARATION_INCOMPLETE",
        message: "发布资源引用无效"
      };
    }
    const preparedAssetVerification = await verifyUploadedFile(
      preliminaryDraft.preparedFileID
    );
    if (!preparedAssetVerification.success) {
      return {
        success: false,
        code: "PUBLISH_ASSET_NOT_FOUND",
        message: "发布资源不存在或无法读取"
      };
    }
  }
  if (fastSpecialTopicFinal) {
    return publishPreparedSpecialTopicFast({
      preliminaryDraft,
      draftId,
      expectedSnapshotHash,
      expectedTargetRevision,
      mutation,
      requestHash,
      admin,
      openid
    });
  }
  const preliminaryPreparationPlan = publicationPreparationPlan(
    preliminaryDraft
  );
  if (preliminaryPreparationPlan.resumable) {
    const preparationStep = await prepareNextPublicationStep(
      preliminaryDraft
    );
    if (!preparationStep.success) return preparationStep;
    if (preparationStep.published) {
      return {
        success: true,
        alreadyApplied: true,
        draft: preparationStep.draft
      };
    }
    if (preparationStep.pending) return preparationStep;
  }
  if (
    !preliminaryPreparationPlan.resumable &&
    Array.isArray(preliminaryDraft.embeddedAssets) &&
    preliminaryDraft.embeddedAssets.length > 0
  ) {
    const embeddedVerification = await verifyDraftEmbeddedAssets(
      preliminaryDraft
    );
    if (!embeddedVerification.success) return embeddedVerification;
  }
  if (
    preliminaryDraft.assetType === "full-book-pdf" &&
    preliminaryDraft.payload.structureMode === "reuse-current" &&
    !await hasPublishedBookStructure(
      preliminaryDraft.targetId,
      preliminaryDraft.basePublishedRevision
    )
  ) {
    return {
      success: false,
      code: "BOOK_STRUCTURE_REQUIRED",
      message: "当前整书版本没有可复用的已发布章节"
    };
  }
  let topicPreparation = null;
  if (
    preliminaryDraft.assetType === "special-topic" &&
    preliminaryDraft.state !== "published"
  ) {
    if (preliminaryPreparationPlan.resumable) {
      topicPreparation = {
        success: true,
        entryCount: preliminaryPreparationPlan.topicEntryCount
      };
    } else {
      topicPreparation = await prepareSpecialTopicEntries(preliminaryDraft);
      if (!topicPreparation.success) return topicPreparation;
    }
  }
  let bookPreparation = null;
  if (
    preliminaryDraft.assetType === "full-book-pdf" &&
    preliminaryDraft.state !== "published" &&
    ["replace", "from-published-contents"].includes(
      preliminaryDraft.payload.structureMode
    )
  ) {
    bookPreparation = await prepareBookChapters(preliminaryDraft);
    if (!bookPreparation.success) return bookPreparation;
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction.collection("adminAccounts").doc(admin.account._id);
    const draftReference = transaction.collection("adminContentDrafts").doc(draftId);
    const uploadReference = transaction.collection("adminUploads").doc(draftId);
    const revisionReference = transaction
      .collection("adminPublishedRevisions")
      .doc(draftId);
    const currentAdmin = await getDocumentOrNull(adminReference);
    const draft = await getDocumentOrNull(draftReference);
    const upload = isStructuredEditorialAsset(preliminaryDraft.assetType)
      ? null
      : await getDocumentOrNull(uploadReference);
    if (!isAuthorizedAccount(currentAdmin, openid) || !hasAnyRole(currentAdmin, PUBLISH_ROLES)) {
      return { success: false, code: "CONTENT_PUBLISH_FORBIDDEN", message: "内容发布权限已失效" };
    }
    if (!draft) {
      return { success: false, code: "DRAFT_NOT_FOUND", message: "内容草稿不存在" };
    }
    const transactionalKnownChapterSource = knownChapterSourceRejection(
      upload || draft
    );
    if (transactionalKnownChapterSource) {
      return transactionalKnownChapterSource;
    }
    const replay = replayMutation(draft, "publishDraft", mutation.requestId, requestHash);
    if (replay) {
      return replay.success
        ? { ...replay, draft: publicDraftState(draft) }
        : replay;
    }
    if (draft.state === "published") {
      return {
        success: true,
        alreadyApplied: true,
        draft: publicDraftState(draft)
      };
    }
    if (
      draft.state !== "approved" ||
      draft.snapshotHash !== expectedSnapshotHash ||
      draft.review.submittedSnapshotHash !== expectedSnapshotHash ||
      draft.review.decision !== "approve" ||
      !Number.isInteger(draft.review.submittedDraftVersion) ||
      snapshotHash({
        ...draft,
        draftVersion: draft.review.submittedDraftVersion
      }) !== expectedSnapshotHash
    ) {
      return { success: false, code: "DRAFT_SNAPSHOT_CHANGED", message: "已批准快照发生变化" };
    }
    if (
      Array.isArray(draft.embeddedAssets) &&
      draft.embeddedAssets.length > 0 &&
      !hasExactEmbeddedAssets(draft)
    ) {
      return {
        success: false,
        code: "PUBLISH_EMBEDDED_ASSET_INVALID",
        message: "Word 内嵌图片引用无效"
      };
    }
    if (preliminaryPreparationPlan.resumable) {
      const transactionalPreparationPlan = publicationPreparationPlan(draft);
      const transactionalPreparation = normalizePublicationPreparation(
        draft,
        transactionalPreparationPlan
      );
      if (
        !transactionalPreparationPlan.resumable ||
        !isPublicationPreparationComplete(
          transactionalPreparation,
          transactionalPreparationPlan
        )
      ) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "发布准备尚未完成，请继续发布"
        };
      }
    }

    const targetCollection = targetCollectionForAsset(draft.assetType);
    const targetReference = targetCollection
      ? transaction.collection(targetCollection).doc(draft.targetId)
      : null;
    const target = targetReference ? await getDocumentOrNull(targetReference) : null;
    const currentTargetRevision = publishedRevisionForTarget(
      draft.assetType,
      target
    );
    const currentAssetRevision = assetRevisionForTarget(draft.assetType, target);
    if (
      draft.assetType !== "topic-image" &&
      (currentTargetRevision !== expectedTargetRevision ||
        draft.basePublishedRevision !== expectedTargetRevision)
    ) {
      return {
        success: false,
        code: "TARGET_REVISION_CONFLICT",
        message: "目标内容已发布新版本，请重新创建草稿"
      };
    }
    if (
      ["audio", "full-book-pdf"].includes(draft.assetType) &&
      currentAssetRevision !== normalizeText(draft.baseAssetRevision, 128)
    ) {
      return {
        success: false,
        code: "ASSET_REVISION_CONFLICT",
        message: "目标资源已发布新版本，请重新创建草稿"
      };
    }
    if (draft.assetType === "manuscript" && target) {
      if (!Number.isInteger(target.pendingReviewCount) || target.pendingReviewCount < 0) {
        return {
          success: false,
          code: "CONTENT_REVIEW_STATE_UNINITIALIZED",
          message: "该文章的复审计数尚未初始化，不能覆盖发布"
        };
      }
      if (target.pendingReviewCount > 0) {
        return {
          success: false,
          code: "PENDING_READER_REVIEWS",
          message: "该文章仍有等待人工复审的读后感，请处理后再覆盖发布"
        };
      }
    }
    if (
      draft.assetType === "full-book-pdf" &&
      draft.payload.structureMode === "from-published-contents"
    ) {
      const sourceSnapshots =
        bookPreparation &&
        Array.isArray(bookPreparation.sourceContentRevisions)
          ? bookPreparation.sourceContentRevisions
          : [];
      if (sourceSnapshots.length === 0) {
        return {
          success: false,
          code: "BOOK_PUBLISHED_CONTENT_REQUIRED",
          message: "请先发布至少一篇归属该书的正文，再发布整书 PDF"
        };
      }
      const currentSources = [];
      for (const source of sourceSnapshots) {
        currentSources.push(await getDocumentOrNull(
          transaction.collection("contents").doc(source.contentId)
        ));
      }
      const sourceChanged = currentSources.some((content, index) =>
        !content ||
        content.status !== "published" ||
        content.bookId !== draft.targetId ||
        normalizeText(content.currentRevision, 128) !==
          sourceSnapshots[index].revision
      );
      if (sourceChanged) {
        return {
          success: false,
          code: "BOOK_SOURCE_CONTENT_CHANGED",
          message: "书内正文已更新，请重新发布整书 PDF 以生成最新章节目录"
        };
      }
    }

    const now = db.serverDate();
    let publishedRevision = draft.revision;

    if (draft.assetType === "manuscript") {
      const payload = draft.payload;
      const existingBookId = normalizeText(target && target.bookId, 64).toLowerCase();
      if (existingBookId && existingBookId !== payload.bookId) {
        return {
          success: false,
          code: "BOOK_RELATION_CHANGE_REQUIRES_MIGRATION",
          message: "已发布文章不能在普通覆盖中变更整书归属"
        };
      }
      await targetReference.set({
        data: {
          contentId: draft.targetId,
          bookId: payload.bookId,
          currentRevision: draft.revision,
          title: payload.title,
          subtitle: payload.subtitle,
          sourceLabel: payload.sourceLabel,
          department: payload.department,
          catalogViews: payload.catalogViews,
          displayDate: payload.displayDate,
          sortOrder: payload.sortOrder,
          coverFileId: payload.coverFileID,
          disclaimer: payload.disclaimer,
          sections: payload.sections,
          embeddedAssets: payload.embeddedAssets || [],
          status: "published",
          reviewStatus: "approved",
          accessPolicy: { text: "member", audio: "member" },
          audioStatus: "draft",
          audioRevision: "",
          publishedAudioTrackCount: 0,
          pendingReviewCount: 0,
          sourceDraftId: draftId,
          publishedAt: now,
          updateTime: now,
          schemaVersion: 1
        }
      });
    } else if (draft.assetType === "audio") {
      if (!target || target.status !== "published" || !currentTargetRevision) {
        return {
          success: false,
          code: "CONTENT_TARGET_NOT_PUBLISHED",
          message: "请先发布对应正文"
        };
      }
      if (!hasExactPreparedAsset(draft)) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "录音发布资源尚未准备完成"
        };
      }
      const trackReference = transaction
        .collection("audioTracks")
        .doc(`${draft.targetId}-primary`);
      await trackReference.set({
        data: {
          contentId: draft.targetId,
          contentRevision: currentTargetRevision,
          audioRevision: draft.revision,
          title: draft.payload.title,
          narrator: draft.payload.narrator,
          language: draft.payload.language,
          mimeType: draft.payload.mimeType,
          durationSeconds: draft.payload.durationSeconds,
          bitrate: draft.payload.bitrate,
          trackNo: 1,
          fileID: draft.preparedFileID,
          status: "published",
          reviewStatus: "approved",
          sourceDraftId: draftId,
          publishedAt: now,
          schemaVersion: 1
        }
      });
      await targetReference.update({
        data: {
          audioStatus: "published",
          audioRevision: draft.revision,
          publishedAudioTrackCount: 1,
          audio: {
            trackId: `${draft.targetId}-primary`,
            title: draft.payload.title,
            narrator: draft.payload.narrator,
            durationMs: Math.round(draft.payload.durationSeconds * 1000)
          },
          updateTime: now
        }
      });
      publishedRevision = draft.revision;
    } else if (draft.assetType === "special-topic") {
      if (!topicPreparation || topicPreparation.entryCount === 0) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "专题条目尚未完整准备"
        };
      }
      await targetReference.set({
        data: {
          topicId: draft.targetId,
          currentRevision: draft.revision,
          title: draft.payload.title,
          summary: draft.payload.summary,
          producer: draft.payload.producer,
          unlockCostStars: draft.payload.unlockCostStars,
          sortOrder: draft.payload.sortOrder,
          previewCover: draft.payload.previewCoverFileID,
          embeddedAssets: draft.payload.embeddedAssets || [],
          status: "published",
          reviewStatus: "approved",
          sourceDraftId: draftId,
          publishedAt: now,
          updateTime: now,
          schemaVersion: 1
        }
      });
    } else if (draft.assetType === "full-book-pdf") {
      const reusesCurrentStructure = draft.payload.structureMode === "reuse-current";
      if (
        reusesCurrentStructure &&
        (!target ||
          target.status !== "published" ||
          !currentTargetRevision ||
          !Number.isInteger(target.chapterCount) ||
          target.chapterCount < 1)
      ) {
        return {
          success: false,
          code: "BOOK_STRUCTURE_REQUIRED",
          message: "请先完成整书章节结构后再发布 PDF"
        };
      }
      if (!hasExactPreparedAsset(draft)) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "整书 PDF 发布资源尚未准备完成"
        };
      }
      const pdf = {
        fileID: draft.preparedFileID,
        mimeType: "application/pdf",
        fileName: draft.payload.fileName
      };
      if (reusesCurrentStructure) {
        await targetReference.update({
          data: {
            title: draft.payload.title,
            subtitle: draft.payload.subtitle,
            pdf,
            pdfRevision: draft.revision,
            reviewStatus: "approved",
            updateTime: now
          }
        });
      } else {
        if (!bookPreparation || bookPreparation.chapterIds.length === 0) {
          return {
            success: false,
            code: "PUBLISH_PREPARATION_INCOMPLETE",
            message: "整书章节尚未完整准备"
          };
        }
        await targetReference.set({
          data: {
            bookId: draft.targetId,
            currentRevision: draft.revision,
            pdfRevision: draft.revision,
            title: draft.payload.title,
            subtitle: draft.payload.subtitle,
            status: "published",
            reviewStatus: "approved",
            chapterCount: bookPreparation.chapterIds.length,
            sourceContentIds: bookPreparation.sourceContentIds,
            pdf,
            sourceDraftId: draftId,
            publishedAt: now,
            updateTime: now,
            schemaVersion: 1
          }
        });
      }
      publishedRevision = draft.revision;
    } else if (draft.assetType === "topic-image") {
      if (!hasExactPreparedAsset(draft)) {
        return {
          success: false,
          code: "PUBLISH_PREPARATION_INCOMPLETE",
          message: "专题图片资源尚未准备完成"
        };
      }
      publishedRevision = draft.revision;
    } else if (isStructuredEditorialAsset(draft.assetType)) {
      const editorialKind = EDITORIAL_ASSET_KINDS[draft.assetType];
      const editorialNow = new Date();
      const existingCreatedAt =
        target &&
        target.createdAt &&
        typeof target.createdAt.toDate === "function"
          ? target.createdAt.toDate()
          : target && target.createdAt instanceof Date
            ? target.createdAt
            : editorialNow;
      const publishedDocument = buildEditorialPublishedDocument(
        editorialKind,
        draft.payload,
        {
          targetId: draft.targetId,
          revision: draft.revision,
          sourceDraftId: draftId,
          createdAt: existingCreatedAt,
          updatedAt: editorialNow,
          publishedAt: editorialNow
        }
      );
      const { _id: ignoredEditorialId, ...publishedData } =
        publishedDocument;
      await targetReference.set({
        data: {
          ...publishedData,
          reviewStatus: "approved",
          publishedBy: currentAdmin._id
        }
      });
      publishedRevision = publishedDocument.revision;
    } else {
      return { success: false, code: "DRAFT_KIND_UNSUPPORTED", message: "草稿类型暂不支持发布" };
    }

    const previousDocument = withoutDocumentId(target);
    await revisionReference.set({
      data: {
        draftId,
        assetType: draft.assetType,
        targetCollection,
        targetId: draft.targetId,
        revision: publishedRevision,
        previousRevision: currentTargetRevision,
        previousAssetRevision: currentAssetRevision,
        previousDocument,
        payload: draft.payload,
        snapshotHash: expectedSnapshotHash,
        publishedBy: admin.account._id,
        publishedAt: now,
        schemaVersion: 1
      }
    });
    const nextVersion = draft.draftVersion + 1;
    const publication = {
      status: draft.assetType === "topic-image" ? "asset_ready" : "published",
      previousRevision: currentTargetRevision,
      publishedRevision,
      publishedBy: admin.account._id,
      publishedAt: now
    };
    const updated = {
      ...draft,
      state: "published",
      draftVersion: nextVersion,
      publication,
      publicationPreparation: null,
      lastMutation: createLastMutation("publishDraft", mutation.requestId, requestHash),
      updateTime: now
    };
    await draftReference.update({
      data: {
        state: "published",
        draftVersion: nextVersion,
        publication,
        publicationPreparation: null,
        lastMutation: updated.lastMutation,
        updateTime: now
      }
    });
    if (!isStructuredEditorialAsset(draft.assetType)) {
      await uploadReference.update({
        data: {
          reviewStatus: "published",
          publicationStatus: publication.status,
          updateTime: now
        }
      });
    }
    return {
      success: true,
      alreadyApplied: false,
      draft: publicDraftState(updated)
    };
  });

  return unwrapTransactionResult(rawResult);
}

async function deletePublishedContent(event, admin, openid) {
  const authorization = requireRole(
    admin,
    PUBLISH_ROLES,
    "CONTENT_DELETE_FORBIDDEN",
    "当前管理员没有删除书稿权限"
  );
  if (!authorization.success) return authorization;

  const contentId = normalizeText(event.contentId, 64).toLowerCase();
  if (!STABLE_ID_PATTERN.test(contentId)) {
    return {
      success: false,
      code: "INVALID_CONTENT_ID",
      message: "书稿编号无效"
    };
  }

  const target = await getDocumentOrNull(
    db.collection("contents").doc(contentId)
  );
  if (!target) {
    return {
      success: false,
      code: "CONTENT_NOT_FOUND",
      message: "书稿不存在或尚未发布"
    };
  }

  let referencedByFullBook = false;

  try {
    const references = await db
      .collection("bookChapters")
      .where({ sourceContentId: contentId, status: "published" })
      .limit(1)
      .get();
    referencedByFullBook = Boolean(
      references &&
      Array.isArray(references.data) &&
      references.data.length > 0
    );
  } catch (error) {
    console.warn("整书引用检查失败，继续执行删除：", error);
  }

  if (referencedByFullBook) {
    return {
      success: false,
      code: "CONTENT_IN_FULL_BOOK",
      message: "该书稿已被整书引用，请先处理整书章节后再删除"
    };
  }

  try {
    await db.collection("contents").doc(contentId).remove();
  } catch (error) {
    if (!isDocumentNotFound(error)) {
      throw error;
    }
  }

  try {
    await db.collection("audioTracks").doc(`${contentId}-primary`).remove();
  } catch (error) {
    if (!isDocumentNotFound(error)) {
      console.warn("删除书稿时清理配音记录失败：", error);
    }
  }

  return {
    success: true,
    contentId
  };
}

function getHomeAssetCloudPath(asset) {
  return `${HOME_ASSET_CLOUD_PREFIX}/${asset.fileName}`;
}

function normalizeExactHomeAssetFileID(value, asset) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
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

  return environment && cloudPath === getHomeAssetCloudPath(asset)
    ? value
    : "";
}

function normalizeHomeManifestAssets(document) {
  const source = document &&
    document.manifestId === HOME_ASSET_MANIFEST_ID &&
    document.revision === HOME_ASSET_REVISION &&
    Number(document.schemaVersion) === 1 &&
    document.assets &&
    typeof document.assets === "object" &&
    !Array.isArray(document.assets)
      ? document.assets
      : {};
  const assets = {};

  HOME_ASSET_DEFINITIONS.forEach((definition) => {
    const candidate = source[definition.key];
    const fileID = normalizeExactHomeAssetFileID(
      candidate && candidate.fileID,
      definition
    );

    if (fileID) {
      assets[definition.key] = {
        key: definition.key,
        fileName: definition.fileName,
        fileID,
        cloudPath: getHomeAssetCloudPath(definition),
        contentType: "image/jpeg",
        bytes: normalizeInteger(candidate && candidate.bytes, 0, 0, 20 * 1024 * 1024),
        sha256: /^[a-f0-9]{64}$/.test(normalizeText(candidate && candidate.sha256, 64))
          ? normalizeText(candidate.sha256, 64)
          : ""
      };
    }
  });

  return assets;
}

function createHomeAssetProgress(assets, uploadedAssetKey = "", alreadyPresent = false) {
  const completedAssetKeys = HOME_ASSET_DEFINITIONS
    .map((asset) => asset.key)
    .filter((key) => Boolean(assets[key]));
  const completedSet = new Set(completedAssetKeys);
  const missingAssetKeys = HOME_ASSET_DEFINITIONS
    .map((asset) => asset.key)
    .filter((key) => !completedSet.has(key));

  return {
    success: true,
    manifestId: HOME_ASSET_MANIFEST_ID,
    revision: HOME_ASSET_REVISION,
    uploadedAssetKey,
    alreadyPresent,
    progress: {
      total: HOME_ASSET_DEFINITIONS.length,
      completed: completedAssetKeys.length,
      remaining: missingAssetKeys.length,
      complete: missingAssetKeys.length === 0,
      completedAssetKeys,
      missingAssetKeys,
      nextAssetKey: missingAssetKeys[0] || ""
    }
  };
}

async function seedHomeAssets(event, admin, openid) {
  const authorization = requireRole(
    admin,
    PUBLISH_ROLES,
    "ADMIN_FORBIDDEN",
    "Only an administrator can initialize public home assets"
  );
  if (!authorization.success) {
    return authorization;
  }

  const requestedKey = normalizeText(event && event.assetKey, 64);
  if (requestedKey && !HOME_ASSET_BY_KEY.has(requestedKey)) {
    return {
      success: false,
      code: "INVALID_HOME_ASSET_KEY",
      message: "The requested home asset is not in the fixed manifest"
    };
  }

  const manifestReference = db
    .collection("publicAssets")
    .doc(HOME_ASSET_MANIFEST_ID);
  const existingManifest = await getDocumentOrNull(manifestReference);
  const existingAssets = normalizeHomeManifestAssets(existingManifest);
  const selectedAsset = requestedKey
    ? HOME_ASSET_BY_KEY.get(requestedKey)
    : HOME_ASSET_DEFINITIONS.find((asset) => !existingAssets[asset.key]);

  if (!selectedAsset) {
    return createHomeAssetProgress(existingAssets);
  }

  if (existingAssets[selectedAsset.key]) {
    return createHomeAssetProgress(existingAssets, "", true);
  }

  const currentAdmin = await getDocumentOrNull(
    db.collection("adminAccounts").doc(admin.account._id)
  );
  const currentAuthorization = revalidateAdmin(currentAdmin, openid);
  if (
    !currentAuthorization.success ||
    !hasAnyRole(currentAdmin, PUBLISH_ROLES)
  ) {
    return {
      success: false,
      code: "ADMIN_FORBIDDEN",
      message: "Administrator permission is no longer active"
    };
  }

  if (typeof cloud.uploadFile !== "function") {
    return {
      success: false,
      code: "HOME_ASSET_UPLOAD_UNAVAILABLE",
      message: "Cloud storage upload is unavailable"
    };
  }

  const localPath = path.join(
    __dirname,
    "assets",
    "home",
    "v1",
    selectedAsset.fileName
  );
  const fileContent = fs.readFileSync(localPath);
  const sha256Value = crypto
    .createHash("sha256")
    .update(fileContent)
    .digest("hex");
  const uploadResult = await cloud.uploadFile({
    cloudPath: getHomeAssetCloudPath(selectedAsset),
    fileContent
  });
  const fileID = normalizeExactHomeAssetFileID(
    uploadResult && uploadResult.fileID,
    selectedAsset
  );

  if (!fileID) {
    return {
      success: false,
      code: "HOME_ASSET_UPLOAD_INVALID",
      message: "Cloud storage returned an unexpected home asset path"
    };
  }

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminReference = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const transactionManifestReference = transaction
      .collection("publicAssets")
      .doc(HOME_ASSET_MANIFEST_ID);
    const transactionAdmin = await getDocumentOrNull(adminReference);
    const transactionManifest = await getDocumentOrNull(
      transactionManifestReference
    );

    if (
      !revalidateAdmin(transactionAdmin, openid).success ||
      !hasAnyRole(transactionAdmin, PUBLISH_ROLES)
    ) {
      return {
        success: false,
        code: "ADMIN_FORBIDDEN",
        message: "Administrator permission is no longer active"
      };
    }

    const assets = normalizeHomeManifestAssets(transactionManifest);
    assets[selectedAsset.key] = {
      key: selectedAsset.key,
      fileName: selectedAsset.fileName,
      fileID,
      cloudPath: getHomeAssetCloudPath(selectedAsset),
      contentType: "image/jpeg",
      bytes: fileContent.length,
      sha256: sha256Value
    };
    const now = db.serverDate();
    const progress = createHomeAssetProgress(assets, selectedAsset.key);

    await transactionManifestReference.set({
      data: {
        manifestId: HOME_ASSET_MANIFEST_ID,
        revision: HOME_ASSET_REVISION,
        status: progress.progress.complete ? "ready" : "partial",
        assets,
        assetCount: HOME_ASSET_DEFINITIONS.length,
        createdAt: transactionManifest && transactionManifest.createdAt || now,
        updateTime: now,
        lastSeededByAdminId: admin.account._id,
        schemaVersion: 1
      }
    });

    return progress;
  });

  return unwrapTransactionResult(rawResult);
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    const admin = await resolveAdmin(openid);

    if (!admin.success) {
      return admin;
    }

    const action = normalizeText(event.action, 32);

    if (action === "status") {
      const brokerConfigured = Boolean(getUploadBrokerUrl());
      const canUpload = hasAnyRole(admin, UPLOAD_ROLES);

      return {
        success: true,
        authorized: true,
        roles: admin.roles.filter((role) => PORTAL_ROLES.has(role)),
        capabilities: {
          upload: canUpload,
          directClientUpload: canUpload && !brokerConfigured,
          transportMode: canUpload
            ? (brokerConfigured ? "https-broker" : "cloud-storage-direct")
            : "disabled",
          directUploadRequiresClientManifest: canUpload && !brokerConfigured,
          clientManifestImport: canUpload,
          drafts: canUpload,
          review: hasAnyRole(admin, REVIEW_ROLES),
          moderation: hasAnyRole(admin, MODERATION_ROLES),
          assetPreview: true,
          publish: hasAnyRole(admin, PUBLISH_ROLES)
        }
      };
    }

    if (action === "seedHomeAssets") {
      return await seedHomeAssets(event, admin, openid);
    }

    if (action === "createUpload") {
      return await createUpload(event, admin, openid);
    }

    if (action === "confirmUpload") {
      return await confirmUpload(event, admin, openid);
    }

    if (action === "attachClientManifest") {
      return await attachClientManifest(event, admin, openid);
    }

    if (action === "confirmClientImages") {
      return await confirmClientImages(event, admin, openid);
    }

    if (action === "resumeClientImages") {
      return await resumeClientImages(event, admin, openid);
    }

    if (action === "listUploads") {
      return await listUploads(event, admin);
    }

    if (action === "listUploadTargets") {
      return await listUploadTargets(event, admin);
    }

    if (action === "cancelUpload") {
      return await cancelUpload(event, admin, openid);
    }

    if (action === "cleanupCanceledUpload") {
      return await cleanupCanceledUpload(event, admin, openid);
    }

    if (action === "createDraftFromUpload") {
      return await createDraftFromUpload(event, admin, openid);
    }

    if (action === "createEditorialDraft") {
      return await createEditorialDraft(event, admin, openid);
    }

    if (action === "getDraft") {
      return await getDraft(event, admin);
    }

    if (action === "listDrafts") {
      return await listDrafts(event, admin, false);
    }

    if (action === "saveDraft") {
      return await saveDraft(event, admin, openid);
    }

    if (action === "submitDraft") {
      return await submitDraft(event, admin, openid);
    }

    if (action === "listReviewQueue") {
      return await listDrafts(event, admin, true);
    }

    if (action === "getDraftAssetPreview") {
      return await getDraftAssetPreview(event, admin, openid);
    }

    if (action === "reviewDraft") {
      return await reviewDraft(event, admin, openid);
    }

    if (action === "publishDraft") {
      return await publishDraft(event, admin, openid);
    }

    if (action === "deletePublishedContent") {
      return await deletePublishedContent(event, admin, openid);
    }

    return {
      success: false,
      code: "INVALID_ACTION",
      message: "管理员内容操作无效"
    };
  } catch (error) {
    console.error("adminContentCenter error:", error);

    const rawDiagnosticCode = error &&
      (error.code || error.errCode || error.name);
    const diagnosticCode = normalizeText(
      rawDiagnosticCode === undefined || rawDiagnosticCode === null
        ? ""
        : String(rawDiagnosticCode),
      80
    ) || "UNCLASSIFIED";

    return {
      success: false,
      code: "ADMIN_CONTENT_CENTER_FAILED",
      message: "管理员内容服务暂不可用",
      diagnosticCode
    };
  }
};
