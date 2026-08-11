const ASSET_TYPES = [
  { value: "manuscript", label: "书稿" },
  { value: "audio", label: "录音" },
  { value: "special-topic", label: "小专题" },
  { value: "full-book-pdf", label: "完整书稿 PDF" },
  { value: "topic-image", label: "专题图片" }
];
const ADMIN_ENTRY_CARDS = Object.freeze([
  {
    id: "manuscript",
    kind: "file",
    assetType: "manuscript",
    title: "首页书稿",
    badge: "书稿",
    subtitle: "Word 正文与下载版 PDF",
    tone: "book"
  },
  {
    id: "audio",
    kind: "file",
    assetType: "audio",
    title: "首页配音",
    badge: "音频",
    subtitle: "为已发布文章添加配音",
    tone: "audio"
  },
  {
    id: "zhi-entry",
    kind: "editorial",
    editorialType: "zhi-entry",
    title: "少年志消息",
    badge: "消息",
    subtitle: "发布少年志动态",
    tone: "zhi"
  },
  {
    id: "quiz-question",
    kind: "editorial",
    editorialType: "quiz-question",
    title: "少年爱题目",
    badge: "题目",
    subtitle: "维护少年爱问答题",
    tone: "quiz"
  },
  {
    id: "special-topic",
    kind: "file",
    assetType: "special-topic",
    title: "少年真小专题（Word）",
    badge: "专题",
    subtitle: "上传图文小专题",
    tone: "topic"
  }
]);
const DEFAULT_BOOK_TARGETS = Object.freeze([
  {
    id: "china-hospital-ship",
    title: "《中国医院船》",
    subtitle: "读后感通过后开放下载"
  }
]);
const AUDIO_DURATION_TIMEOUT_MS = 8000;
const CLIENT_IMAGE_CONFIRM_MAX_RETRIES = 3;
const CLIENT_IMAGE_CONFIRM_RETRY_BASE_MS = 800;
const CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS = 500;
const CLIENT_IMAGE_RESUME_MAX_ROUNDS = 100;
const adminContent = require("../../utils/adminContent");
const docxImport = require("./docxImport");
const docxImageTransfer = require("./docxImageTransfer");
const PORTAL_ROLES = new Set([
  "admin",
  "uploader",
  "content-reviewer",
  "moderator"
]);
const ASSET_EXTENSIONS = Object.freeze({
  manuscript: ["docx"],
  audio: ["mp3", "m4a", "wav"],
  "special-topic": ["docx"],
  "full-book-pdf": ["pdf"],
  "topic-image": ["jpg", "jpeg", "png", "webp"]
});
const STATUS_LABELS = {
  pending: "等待上传",
  pending_upload: "等待上传",
  uploading: "上传中",
  uploaded: "已上传，可建草稿",
  confirmed: "已上传待处理",
  processing: "处理中",
  ready: "待发布",
  published: "已发布",
  failed: "上传失败",
  rejected: "已退回",
  canceled: "已取消",
  upload_failed: "上传失败",
  upload_failed_cleanup_required: "异常文件隔离中",
  cleanup_required: "等待清理"
};
const REVIEW_STATUS_LABELS = {
  in_review: "草稿待复核",
  approved: "草稿已批准",
  changes_requested: "草稿退回修改",
  rejected: "草稿已驳回",
  published: "内容已发布"
};

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function hasUploadAccess(result) {
  const role = normalizeText(result && result.role, 32).toLowerCase();
  const roles = Array.isArray(result && result.roles)
    ? result.roles.map((item) => normalizeText(item, 32).toLowerCase())
    : [];

  return Boolean(
    result &&
      result.success &&
      (result.authorized === true ||
        result.canUpload === true ||
        PORTAL_ROLES.has(role) ||
        roles.some((item) => PORTAL_ROLES.has(item)))
  );
}

function getUploadRole(result) {
  const directRole = normalizeText(result && result.role, 32).toLowerCase();

  if (PORTAL_ROLES.has(directRole)) {
    return directRole;
  }

  const roles = Array.isArray(result && result.roles) ? result.roles : [];
  return roles
    .map((item) => normalizeText(item, 32).toLowerCase())
    .find((item) => PORTAL_ROLES.has(item)) || "";
}

function inferMimeType(fileName, providedType) {
  const normalizedType = normalizeText(providedType, 120).toLowerCase();

  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalizedType)) {
    return normalizedType;
  }

  const extension = normalizeText(fileName, 180)
    .toLowerCase()
    .split(".")
    .pop();
  const types = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp"
  };

  return types[extension] || "application/octet-stream";
}

function isAllowedFile(assetType, fileName) {
  const extension = normalizeText(fileName, 180).toLowerCase().split(".").pop();
  const allowed = ASSET_EXTENSIONS[assetType];
  return Boolean(extension && Array.isArray(allowed) && allowed.includes(extension));
}

function allowedFileHint(assetType) {
  const allowed = ASSET_EXTENSIONS[assetType] || [];
  return allowed.map((item) => item.toUpperCase()).join("、");
}

function getFileDisplayType(assetType) {
  if (assetType === "audio") {
    return "音频文件";
  }

  return assetType === "full-book-pdf" ? "PDF 文档" : "Word 文档";
}

function isStableTargetId(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(
    normalizeText(value, 64).toLowerCase()
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes || [], (value) =>
    Number(value).toString(16).padStart(2, "0")
  ).join("");
}

function createRandomHex32() {
  if (typeof wx !== "undefined" && typeof wx.getRandomValues === "function") {
    try {
      const result = wx.getRandomValues({ length: 16 });
      const source = result && (
        result.randomValues ||
        result.values ||
        result.buffer ||
        result
      );
      const bytes = source instanceof Uint8Array
        ? source
        : source instanceof ArrayBuffer
          ? new Uint8Array(source)
          : Array.isArray(source)
            ? new Uint8Array(source)
            : null;
      const secureHex = bytesToHex(bytes);
      if (/^[a-f0-9]{32}$/.test(secureHex)) {
        return secureHex;
      }
    } catch (error) {
      // Older base libraries may not expose secure random bytes.
    }
  }

  let fallback = "";
  while (fallback.length < 32) {
    fallback += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  }
  return fallback.slice(0, 32);
}

function createNewTargetId(assetType) {
  const prefix = assetType === "special-topic" ? "topic" : "content";
  return `${prefix}-${createRandomHex32()}`;
}

function targetTypeForAsset(assetType) {
  return assetType === "special-topic" ? "special-topic" : "content";
}

function normalizeUploadTargets(result) {
  const source = result && Array.isArray(result.targets) ? result.targets : [];
  return source.map((rawTarget) => {
    const target = rawTarget && typeof rawTarget === "object" ? rawTarget : {};
    const id = normalizeText(target.id, 64).toLowerCase();
    if (!isStableTargetId(id)) {
      return null;
    }
    return {
      id,
      title: normalizeText(target.title, 120) || "未命名内容",
      subtitle: normalizeText(target.subtitle, 160)
    };
  }).filter(Boolean);
}

function wrapBookTitle(value) {
  const title = normalizeText(value, 120);

  if (!title) {
    return "未命名书目";
  }

  return /^《.*》$/.test(title) ? title : `《${title}》`;
}

function buildBookTargets(drafts) {
  const targets = DEFAULT_BOOK_TARGETS.map((item) => ({ ...item }));
  const seen = new Set(targets.map((item) => item.id));

  (Array.isArray(drafts) ? drafts : []).forEach((draft) => {
    const targetId = normalizeText(draft && draft.targetId, 64).toLowerCase();
    if (
      !draft ||
      draft.assetType !== "full-book-pdf" ||
      !isStableTargetId(targetId) ||
      seen.has(targetId)
    ) {
      return;
    }

    seen.add(targetId);
    targets.push({
      id: targetId,
      title: wrapBookTitle(
        draft.bookTitle ||
          draft.title ||
          (draft.payload && (draft.payload.bookTitle || draft.payload.title))
      ),
      subtitle: "已有下载版草稿"
    });
  });

  return targets;
}

function getPdfReadiness(drafts, targetId) {
  const matching = (Array.isArray(drafts) ? drafts : []).filter(
    (draft) =>
      draft &&
      draft.assetType === "full-book-pdf" &&
      normalizeText(draft.targetId, 64).toLowerCase() === targetId
  );
  const published = matching.find((draft) => draft.state === "published");

  if (published) {
    return {
      tone: "ready",
      title: "下载版 PDF 已就绪",
      message: "当前已有已发布版本，可直接沿用；重新上传会创建替换草稿。"
    };
  }

  const pending = matching[0];
  const stateCopy = {
    approved: "下载版 PDF 已批准，等待发布",
    changes_requested: "下载版 PDF 草稿待修改",
    editing: "下载版 PDF 草稿待完善",
    in_review: "下载版 PDF 正在复核",
    rejected: "下载版 PDF 草稿已退回"
  };

  if (pending && stateCopy[pending.state]) {
    return {
      tone: pending.state === "approved" ? "ready" : "pending",
      title: stateCopy[pending.state],
      message: "可打开下方草稿继续处理，也可以重新上传替换文件。"
    };
  }

  return {
    tone: "muted",
    title: "尚未读取到已发布 PDF",
    message: "可以现在上传；若云端已有版本，也可先沿用并稍后再替换。"
  };
}

function formatFileSize(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return "大小未知";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getAssetLabel(value) {
  const option = ASSET_TYPES.find((item) => item.value === value);
  return option ? option.label : "其他素材";
}

function normalizeUpload(source) {
  const item = source && typeof source === "object" ? source : {};
  const uploadId = normalizeText(item.uploadId || item.id || item._id, 128);

  if (!uploadId) {
    return null;
  }

  const status = normalizeText(item.status, 48).toLowerCase() || "pending";
  const reviewStatus = normalizeText(item.reviewStatus, 48).toLowerCase();
  const validationStatus = normalizeText(item.validationStatus, 48).toLowerCase();
  const failed = status === "failed" ||
    status === "rejected" ||
    status.includes("failed") ||
    status === "cleanup_required";
  const complete = [
    "uploaded",
    "confirmed",
    "processing",
    "ready",
    "published"
  ].includes(status);
  const awaitingValidation = [
    "awaiting_client_manifest",
    "awaiting_validation",
    "awaiting_server_validation",
    "awaiting_manual_validation",
    "pending",
    "pending_validation",
    "validating"
  ].includes(validationStatus);
  const awaitingImages = validationStatus === "awaiting_client_images";
  const imageProgress = normalizeClientImageProgress(item);
  const cleanupRemainingCount = firstNonNegativeInteger(
    item.cleanupRemainingCount,
    item.remainingCleanupCount
  );
  const cleanupRequired = Boolean(
    item.cleanupRequired === true ||
    (cleanupRemainingCount !== null && cleanupRemainingCount > 0)
  );
  const canceled = status === "canceled";
  const statusLabel = cleanupRequired
      ? "已取消，等待清理"
    : canceled
      ? STATUS_LABELS.canceled
    : awaitingImages
      ? "正文已校验，等待图片"
    : awaitingValidation
      ? "已上传，等待正文校验"
    : REVIEW_STATUS_LABELS[reviewStatus] ||
      STATUS_LABELS[status] ||
      "待处理";

  return {
    uploadId,
    fileName:
      normalizeText(item.fileName || item.originalFileName || item.name, 180) ||
      "未命名文件",
    assetType: normalizeText(item.assetType, 48),
    assetLabel: getAssetLabel(normalizeText(item.assetType, 48)),
    relatedId: normalizeText(item.relatedId, 100),
    status,
    reviewStatus,
    validationStatus,
    statusLabel,
    statusTone: failed ? "error" : complete ? "complete" : "pending",
    clientImageCount: imageProgress.total,
    confirmedClientImageCount: imageProgress.confirmed,
    remainingClientImageCount: imageProgress.remaining,
    clientImageProgressKnown: imageProgress.known,
    clientImageProgressPercent: imageProgress.percent,
    clientImageProgressLabel: awaitingImages
      ? imageProgress.totalKnown && imageProgress.total > 0
        ? `图片确认 ${imageProgress.confirmed}/${imageProgress.total}，还剩 ${imageProgress.remaining} 张`
        : imageProgress.remainingKnown
          ? `图片确认尚未完成，还剩 ${imageProgress.remaining} 张`
          : imageProgress.confirmedKnown
            ? `已确认 ${imageProgress.confirmed} 张图片，仍需继续`
          : "图片确认尚未完成"
      : "",
    canResumeClientImages: awaitingImages && !canceled && !failed,
    cleanupRequired,
    cleanupRemainingCount: cleanupRemainingCount === null
      ? 0
      : cleanupRemainingCount,
    cleanupProgressLabel: cleanupRequired
      ? cleanupRemainingCount !== null
        ? `待清理 ${cleanupRemainingCount} 个云文件`
        : "仍有云文件等待清理"
      : "",
    canCleanupCanceledUpload:
      cleanupRequired &&
      ["canceled", "cleanup_required", "upload_failed_cleanup_required"]
        .includes(status),
    createdLabel: formatTime(item.createdAt || item.createTime || item.updatedAt),
    canCreateDraft:
      status === "uploaded" &&
      [
        "validated",
        "client_manifest_validated",
        "admin_attested_unverified"
      ].includes(validationStatus),
    canCancel: ["pending_upload", "uploaded", "uploaded_unverified"].includes(status),
    hasDraft: false
  };
}

function normalizeUploads(result) {
  const source =
    (result && (result.uploads || result.items || result.history)) || [];

  return Array.isArray(source) ? source.map(normalizeUpload).filter(Boolean) : [];
}

function withPublicDraftTitle(draft) {
  const item = draft && typeof draft === "object" ? draft : {};
  const title = normalizeText(item.title, 160);
  const targetId = normalizeText(item.targetId, 64);
  return {
    ...item,
    displayTitle:
      title && title !== targetId
        ? title
        : `${normalizeText(item.assetLabel, 40) || "内容"}草稿`
  };
}

function isCancelError(error) {
  const message = String(error && (error.errMsg || error.message || ""));
  return /cancel/i.test(message);
}

function getErrorMessage(error, fallback) {
  return normalizeText(
    error && (error.userMessage || error.message || error.errMsg),
    180
  ) || fallback;
}

function firstNonNegativeInteger(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isInteger(number) && number >= 0) {
      return number;
    }
  }
  return null;
}

function normalizeClientImageProgress(source) {
  const item = source && typeof source === "object" ? source : {};
  let total = firstNonNegativeInteger(
    item.clientImageCount,
    item.totalClientImageCount,
    item.totalCount
  );
  let confirmed = firstNonNegativeInteger(
    item.confirmedClientImageCount,
    item.clientImageConfirmedCount,
    item.confirmedCount
  );
  let remaining = firstNonNegativeInteger(
    item.remainingClientImageCount,
    item.clientImageRemainingCount,
    item.remainingCount
  );
  let totalKnown = total !== null;
  let confirmedKnown = confirmed !== null;
  let remainingKnown = remaining !== null;
  const known = totalKnown || confirmedKnown || remainingKnown;

  if (total === null && confirmed !== null && remaining !== null) {
    total = confirmed + remaining;
    totalKnown = true;
  }
  if (confirmed === null && total !== null && remaining !== null) {
    confirmed = Math.max(0, total - remaining);
    confirmedKnown = true;
  }
  if (remaining === null && total !== null && confirmed !== null) {
    remaining = Math.max(0, total - confirmed);
    remainingKnown = true;
  }

  total = total === null ? 0 : total;
  confirmed = Math.min(total || confirmed || 0, confirmed === null ? 0 : confirmed);
  remaining = remaining === null
    ? Math.max(0, total - confirmed)
    : Math.max(0, remaining);

  return {
    confirmed,
    confirmedKnown,
    known,
    percent: total > 0
      ? Math.max(0, Math.min(100, Math.round((confirmed / total) * 100)))
      : 0,
    remaining,
    remainingKnown,
    total,
    totalKnown
  };
}

function createAdminContentError(result, fallback) {
  const item = result && typeof result === "object" ? result : {};
  const message = normalizeText(item.message, 180) || fallback;
  const error = new Error(message);
  error.userMessage = message;
  error.code = normalizeText(
    item.code === undefined || item.code === null ? "" : String(item.code),
    80
  );
  error.status = item.status;
  error.statusCode = item.statusCode;
  error.retryable = item.retryable === true;
  error.fromAdminContentResult = true;
  return error;
}

function isRetryableAdminContentError(error) {
  const rawCode = error && (error.code || error.errCode);
  const code = normalizeText(
    rawCode === undefined || rawCode === null ? "" : String(rawCode),
    80
  ).toUpperCase();
  const rawStatus = error && (error.statusCode || error.status);
  const status = Number(rawStatus);
  const message = normalizeText(
    error && (error.message || error.errMsg || error.userMessage),
    300
  ).toLowerCase();

  if (
    /(?:FORBIDDEN|PERMISSION|UNAUTHORIZED|INVALID|NOT_FOUND|EXPIRED)/.test(code) ||
    /(?:permission denied|forbidden|unauthorized|拒绝访问|没有权限|无权)/i
      .test(message)
  ) {
    return false;
  }
  if (
    (error && error.retryable === true) ||
    code === "ADMIN_CONTENT_CENTER_FAILED"
  ) {
    return true;
  }

  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }

  if (
    /(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/
      .test(code) ||
    /(?:socket hang up|connection reset|timeout|timed out|network|request:fail|callfunction:fail|system error|temporar|service unavailable|busy|rate.?limit|网络|超时|连接|中断|服务暂不可用|稍后重试)/i
      .test(message)
  ) {
    return true;
  }

  // A rejected wx.cloud.callFunction promise has no trusted server result. Its
  // outcome is therefore ambiguous: retry with the same requestId, then
  // reconcile the deterministic draft id before allowing another mutation.
  return Boolean(error && error.fromAdminContentResult !== true);
}

function getCloudUploadErrorCode(error) {
  const value = error && (
    error.errCode ||
    error.code ||
    error.statusCode ||
    error.status
  );
  return normalizeText(
    typeof value === "number" ? String(value) : value,
    80
  );
}

function wrapCloudUploadError(error) {
  const rawMessage = normalizeText(
    error && (error.errMsg || error.message),
    300
  );
  const errorCode = getCloudUploadErrorCode(error);
  const searchable = `${errorCode} ${rawMessage}`.toLowerCase();
  let userMessage = "云存储没有接收文件，请重试";

  if (isCancelError(error)) {
    userMessage = "上传已取消";
  } else if (
    /exceed.*(?:file|upload).*size|file.*too.*large|entity too large|文件.*(?:过大|超.*限制)/i
      .test(searchable)
  ) {
    userMessage = "文件超过当前云存储单文件上传限制";
  } else if (
    /permission|forbidden|unauthorized|auth fail|权限|无权/i.test(searchable)
  ) {
    userMessage = "云存储暂未允许上传，请联系维护人员检查权限";
  } else if (
    /quota|storage.*full|insufficient.*space|额度|空间不足/i.test(searchable)
  ) {
    userMessage = "云存储免费额度或空间不足，请联系维护人员处理";
  } else if (
    /enoent|no such file|not found|file.*(?:invalid|expired)|临时文件.*(?:失效|不存在)/i
      .test(searchable)
  ) {
    userMessage = "所选临时文件已失效，请重新选择文件";
  }

  if (errorCode && !userMessage.includes(errorCode)) {
    userMessage += `（${errorCode}）`;
  }

  const failure = new Error(userMessage);
  failure.userMessage = userMessage;
  failure.errMsg = rawMessage;
  failure.errCode = error && error.errCode;
  failure.code = error && error.code;
  failure.statusCode = error && error.statusCode;
  failure.requestId = error && (error.requestId || error.requestID);
  failure.originalError = error || null;
  return failure;
}

function getBrokerCapability(result) {
  const capabilities = result && result.capabilities;
  const mode = normalizeText(
    capabilities && (capabilities.uploadMode || capabilities.transportMode),
    32
  ).toLowerCase();

  return Boolean(
    capabilities && capabilities.upload === true && mode === "https-broker"
  );
}

function isDirectCloudMode(value) {
  return [
    "cloud-storage-direct",
    "direct-cloud",
    "direct_cloud",
    "directcloud"
  ].includes(normalizeText(value, 32).toLowerCase());
}

function getDirectCloudCapability(result) {
  const capabilities = result && result.capabilities;
  const mode = normalizeText(
    capabilities && (capabilities.uploadMode || capabilities.transportMode),
    32
  ).toLowerCase();

  return Boolean(
    capabilities &&
      capabilities.upload === true &&
      (
        isDirectCloudMode(mode) ||
        capabilities.directCloud === true ||
        capabilities.directClientUpload === true
      )
  );
}

function getUploadMode(result) {
  if (getBrokerCapability(result)) {
    return "https-broker";
  }

  if (getDirectCloudCapability(result)) {
    return "cloud-storage-direct";
  }

  return "";
}

function normalizeBrokerTransport(result) {
  const transport = result && result.uploadTransport;
  const mode = normalizeText(transport && transport.mode, 32);
  const url = normalizeText(transport && transport.url, 2048);
  const ticket = normalizeText(transport && transport.ticket, 256);
  const fieldName = normalizeText(transport && transport.fieldName, 32) || "file";

  if (
    mode !== "https-broker" ||
    !/^https:\/\/[^\s\\]+$/i.test(url) ||
    /[\u0000-\u001f]/.test(url) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(ticket) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(fieldName)
  ) {
    return null;
  }

  return { fieldName, mode, ticket, url };
}

function isSafeDirectCloudPath(value, uploadId) {
  const cloudPath = normalizeText(value, 512);
  const expectedUploadId = normalizeText(uploadId, 32).toLowerCase();
  const parts = cloudPath.split("/");
  const stagingPath = Boolean(
    parts.length === 4 &&
    parts[0] === "admin-direct-staging" &&
    /^[a-f0-9]{24}$/.test(parts[1]) &&
    parts[2] === expectedUploadId &&
    /^source\.(?:docx|pdf|mp3|m4a|wav|jpg|jpeg|png|webp)$/.test(parts[3])
  );
  const publishedAudioPath = Boolean(
    parts.length === 6 &&
    parts[0] === "published" &&
    parts[1] === "audio" &&
    isStableTargetId(parts[2]) &&
    parts[3] === "assets" &&
    parts[4] === expectedUploadId &&
    /^primary\.(?:mp3|m4a|wav)$/.test(parts[5])
  );

  return Boolean(
    /^[a-f0-9]{32}$/.test(expectedUploadId) &&
      (stagingPath || publishedAudioPath)
  );
}

function normalizeDirectCloudTransport(result, uploadId) {
  const transport =
    result && result.uploadTransport && typeof result.uploadTransport === "object"
      ? result.uploadTransport
      : {};
  const upload = result && result.upload && typeof result.upload === "object"
    ? result.upload
    : {};
  const directCloud = result && result.directCloud &&
    typeof result.directCloud === "object"
    ? result.directCloud
    : {};
  const mode = normalizeText(
    transport.mode ||
      result && result.uploadMode ||
      directCloud.mode ||
      upload.uploadMode,
    32
  ).toLowerCase();
  const cloudPath = normalizeText(
    transport.cloudPath ||
      directCloud.cloudPath ||
      result && result.cloudPath ||
      upload.cloudPath,
    512
  );
  const directAllowed =
    transport.directClientUploadAllowed === true ||
    directCloud.allowed === true ||
    result && result.directCloud === true ||
    isDirectCloudMode(mode) ||
    Boolean(cloudPath);
  const sourceMode = normalizeText(
    transport.sourceMode ||
      directCloud.sourceMode ||
      result && result.sourceMode ||
      upload.sourceMode,
    48
  ).toLowerCase();
  const originalFileUploadRequired = ![
    transport.originalFileUploadRequired,
    directCloud.originalFileUploadRequired,
    result && result.originalFileUploadRequired,
    upload.originalFileUploadRequired
  ].some((value) => value === false);
  const clientManifestOnly = Boolean(
    sourceMode === "client-manifest-only" &&
    originalFileUploadRequired === false &&
    transport.requiresClientManifest === true &&
    /^[a-f0-9]{32}$/.test(normalizeText(uploadId, 32).toLowerCase())
  );

  if (
    !directAllowed ||
    (!clientManifestOnly && !isSafeDirectCloudPath(cloudPath, uploadId))
  ) {
    return null;
  }

  return {
    cloudPath,
    mode: "cloud-storage-direct",
    originalFileUploadRequired,
    sourceMode
  };
}

function normalizeCloudFileID(value, expectedCloudPath) {
  const fileID = normalizeText(value, 2048);
  const cloudPath = normalizeText(expectedCloudPath, 512);
  const match = /^cloud:\/\/[^\s/?#]+\/([^\s?#]+)$/i.exec(fileID);

  return match && match[1] === cloudPath ? fileID : "";
}

function getConfirmedUploadState(result, mode) {
  const upload = result && result.upload && typeof result.upload === "object"
    ? result.upload
    : {};
  const validationStatus = normalizeText(
    upload.validationStatus || result && result.validationStatus,
    48
  ).toLowerCase();
  const status = normalizeText(
    upload.status || result && result.status,
    48
  ).toLowerCase();
  const requiresClientManifest = Boolean(
    upload.requiresClientManifest ||
    result && result.requiresClientManifest
  );
  const requiresClientImages = Boolean(
    upload.requiresClientImages ||
    result && result.requiresClientImages ||
    validationStatus === "awaiting_client_images"
  );
  const canCreateDraft = Boolean(
    upload.canCreateDraft ||
    result && result.canCreateDraft
  );
  const validated = [
    "validated",
    "client_manifest_validated"
  ].includes(validationStatus);
  const direct = mode === "cloud-storage-direct";
  const effectiveValidated = validated || (!direct && !validationStatus);

  return {
    canCreateDraft: canCreateDraft || effectiveValidated,
    direct,
    requiresClientImages,
    requiresClientManifest,
    status,
    validated: effectiveValidated,
    validationStatus
  };
}

function normalizeClientImageUploadPlan(result, manifest) {
  const source = result && Array.isArray(result.imageUploadPlan)
    ? result.imageUploadPlan
    : result && result.upload && Array.isArray(result.upload.imageUploadPlan)
      ? result.upload.imageUploadPlan
      : [];
  const images = manifest && Array.isArray(manifest.images)
    ? manifest.images
    : [];
  const imageByOrder = new Map(images.map((image) => [Number(image.order), image]));
  const seenOrders = new Set();
  const seenPaths = new Set();
  const normalized = source.map((rawItem) => {
    const item = rawItem && typeof rawItem === "object" ? rawItem : {};
    const imageOrder = Number(
      item.imageOrder === undefined ? item.order : item.imageOrder
    );
    const manifestImage = imageByOrder.get(imageOrder);
    const packagePath = normalizeText(item.packagePath, 512);
    const extension = normalizeText(item.extension, 12).toLowerCase();
    const cloudPath = normalizeText(item.cloudPath, 512);
    const protectedPath =
      /^protected\/(?:contents|special-topics)\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/assets\/[a-f0-9]{32}\/embedded\/[0-9]{4}\.(?:jpe?g|png|gif|webp)$/i.test(
        cloudPath
      );

    if (
      !Number.isInteger(imageOrder) ||
      imageOrder < 1 ||
      imageOrder > 200 ||
      !manifestImage ||
      Number(manifestImage.order) !== imageOrder ||
      packagePath !== manifestImage.packagePath ||
      extension !== manifestImage.extension ||
      !protectedPath ||
      seenOrders.has(imageOrder) ||
      seenPaths.has(cloudPath)
    ) {
      throw new Error("图片上传清单与 Word 文稿不一致，请重新选择文稿");
    }
    seenOrders.add(imageOrder);
    seenPaths.add(cloudPath);
    return { imageOrder, packagePath, extension, cloudPath };
  }).sort((left, right) => left.imageOrder - right.imageOrder);

  if (
    normalized.length === 0 ||
    normalized.length !== images.length
  ) {
    throw new Error("图片上传清单与 Word 文稿不一致，请重新选择文稿");
  }

  return normalized;
}

function getDocumentImportLimits(assetType) {
  return {
    maximumBlocks: 2000,
    maximumCharacters: assetType === "special-topic" ? 200000 : 150000,
    maximumImages: 200
  };
}

function toSafeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? Math.min(number, maximum)
    : 0;
}

function createClientManifest(source) {
  const manifest = source && typeof source === "object" ? source : {};
  const sourceBlocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
  const blocks = sourceBlocks.length > 0
    ? sourceBlocks.slice(0, 2000).map((sourceBlock) => {
        const block = sourceBlock && typeof sourceBlock === "object"
          ? sourceBlock
          : {};
        const normalized = {
          type: block.type === "heading" ? "heading" : "paragraph",
          text: normalizeText(block.text, 8000)
        };
        if (normalized.type === "heading") {
          normalized.level = Math.max(1, Math.min(9, toSafeInteger(block.level, 9) || 1));
        }
        if (Array.isArray(block.images) && block.images.length > 0) {
          normalized.images = block.images
            .map((order) => toSafeInteger(order, 200))
            .filter((order) => order > 0);
        }
        return normalized;
      })
    : [];
  const images = Array.isArray(manifest.images)
    ? manifest.images.slice(0, 200).map((sourceImage) => {
        const image = sourceImage && typeof sourceImage === "object"
          ? sourceImage
          : {};
        return {
          relationId: normalizeText(image.relationId, 128),
          packagePath: normalizeText(image.packagePath, 512),
          extension: normalizeText(image.extension, 12).toLowerCase(),
          order: toSafeInteger(image.order, 200)
        };
      })
    : [];
  const stats = manifest.stats && typeof manifest.stats === "object"
    ? manifest.stats
    : {};

  return {
    schemaVersion: 1,
    sourceType: "docx",
    title: normalizeText(manifest.title, 120) || "未命名文稿",
    blocks,
    images,
    warnings: Array.isArray(manifest.warnings)
      ? manifest.warnings
          .map((warning) => normalizeText(warning, 160))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    stats: {
      extractedBlocks: toSafeInteger(stats.extractedBlocks, 2000),
      extractedCharacters: toSafeInteger(stats.extractedCharacters, 200000),
      imageCount: toSafeInteger(stats.imageCount, 200),
      imageReferenceCount: toSafeInteger(stats.imageReferenceCount, 100000),
      inferredHeadingCount: toSafeInteger(stats.inferredHeadingCount, 2000),
      omittedImageReferences: toSafeInteger(stats.omittedImageReferences, 100000),
      skippedTableOfContentsParagraphs: toSafeInteger(
        stats.skippedTableOfContentsParagraphs,
        100000
      ),
      totalParagraphs: toSafeInteger(stats.totalParagraphs, 100000),
      truncated: Boolean(
        stats.truncated ||
        sourceBlocks.length > 2000 ||
        sourceBlocks.some((block) => String(block && block.text || "").length > 8000)
      ),
      unsupportedImageReferences: toSafeInteger(
        stats.unsupportedImageReferences,
        100000
      )
    }
  };
}

function utf8ByteLength(value) {
  const text = String(value || "");
  let length = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }

  return length;
}

function getDocumentTooLargeMessage(assetType) {
  return assetType === "special-topic"
    ? "这份 Word 内容较多，请拆成两个小专题后分别上传"
    : "这份 Word 内容较多，请拆成两份文稿后分别上传";
}

function confirmModal(title, content, confirmText = "确认") {
  return new Promise((resolve) => {
    if (typeof wx.showModal !== "function") {
      resolve(false);
      return;
    }
    wx.showModal({
      title,
      content,
      confirmText,
      confirmColor: "#b93731",
      success: (result) => resolve(Boolean(result && result.confirm)),
      fail: () => resolve(false)
    });
  });
}

function parseBrokerUploadResult(result) {
  const statusCode = Number(result && result.statusCode);
  let payload = result && result.data;

  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      payload = null;
    }
  }

  if (
    !Number.isInteger(statusCode) ||
    statusCode < 200 ||
    statusCode >= 300 ||
    !payload ||
    payload.success !== true
  ) {
    const failure = new Error(
      normalizeText(payload && payload.message, 180) || "上传代理未接受该文件"
    );
    failure.code = normalizeText(payload && payload.code, 64);
    failure.restartReservation = true;
    failure.userMessage = failure.message;
    throw failure;
  }

  return payload;
}

Page({
  data: {
    accessLoading: true,
    accessChecked: false,
    authorized: false,
    uploadAvailable: false,
    uploadMode: "",
    capabilities: {
      upload: false,
      drafts: false,
      review: false,
      moderation: false,
      assetPreview: false,
      publish: false,
      transportMode: ""
    },
    transportMessage: "",
    role: "",
    accessMessage: "",
    entryCards: ADMIN_ENTRY_CARDS,
    selectedEntryId: "manuscript",
    selectedEntryKind: "file",
    assetTypeOptions: ASSET_TYPES,
    assetTypeIndex: 0,
    selectedAssetType: ASSET_TYPES[0].value,
    selectedAssetTypeLabel: ASSET_TYPES[0].label,
    manuscriptStep: "word",
    contentMode: "new",
    relatedId: "",
    bookTargets: DEFAULT_BOOK_TARGETS,
    pdfReadinessTone: "muted",
    pdfReadinessTitle: "尚未读取到已发布 PDF",
    pdfReadinessMessage: "可以现在上传；若云端已有版本，也可先沿用并稍后再替换。",
    uploadTargets: [],
    uploadTargetsLoading: false,
    uploadTargetsError: "",
    selectedTargetIndex: -1,
    selectedTargetTitle: "",
    selectedTargetSubtitle: "",
    targetSelectionRequired: false,
    targetPickerLabel: "",
    emptyTargetMessage: "",
    fileDisplayType: "Word 文档",
    fileFormatHint: "支持 DOCX；旧版 DOC 请先另存为 DOCX",
    fileChoosing: false,
    selectedFile: null,
    audioDurationLoading: false,
    audioDurationError: "",
    audioDurationLabel: "",
    localDocumentReady: false,
    localParseError: "",
    localParseLoading: false,
    localParsePreview: [],
    localParseSummary: "",
    localParseWarning: "",
    uploading: false,
    uploadProgress: 0,
    uploadStageLabel: "",
    imageTransferCompleted: 0,
    imageTransferTotal: 0,
    uploadError: "",
    canRetry: false,
    uploadSuccess: "",
    historyLoading: false,
    historyError: "",
    uploads: [],
    historyHasMore: false,
    historyNextOffset: null,
    draftsLoading: false,
    draftsError: "",
    drafts: [],
    draftsHasMore: false,
    draftsNextOffset: null,
    reviewLoading: false,
    reviewError: "",
    reviewDrafts: [],
    reviewHasMore: false,
    reviewNextOffset: null,
    creatingDraftId: "",
    cancelingUploadId: "",
    resumingClientImagesId: "",
    cleaningUpUploadId: ""
  },

  onLoad() {
    this.pageDestroyed = false;
    this.isPageVisible = false;
    this.retryStage = "";
    this.pendingUploadTicket = null;
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.imageTransferController = null;
    this.draftMutationIds = {};
    this.targetSelectionConfirmed = false;
    this.targetRequestId = 0;
    this.fileSelectionRequestId = 0;
    this.audioProbeRequestId = 0;
    this.audioProbeContext = null;
    this.audioProbeCancel = null;
    this.resumeClientImagesOperationId = 0;
    this.cleanupCanceledUploadOperationId = 0;
    this.selectedBookTargetId = DEFAULT_BOOK_TARGETS[0].id;
    this.setData({
      relatedId: createNewTargetId("manuscript")
    });
  },

  onShow() {
    this.isPageVisible = true;
    this.loadAccessStatus();
  },

  onHide() {
    this.isPageVisible = false;
    const discardAudioSelection = this.data.audioDurationLoading;
    const preservePendingFileSelection = Boolean(this.data.fileChoosing);
    this.accessRequestId = (this.accessRequestId || 0) + 1;
    this.historyRequestId = (this.historyRequestId || 0) + 1;
    this.draftsRequestId = (this.draftsRequestId || 0) + 1;
    this.reviewRequestId = (this.reviewRequestId || 0) + 1;
    this.resumeClientImagesOperationId =
      (this.resumeClientImagesOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.draftOperationId = (this.draftOperationId || 0) + 1;
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    if (!preservePendingFileSelection) {
      this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    }
    this.cancelAudioDurationProbe();
    this.setData({
      fileChoosing: preservePendingFileSelection,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: discardAudioSelection
        ? ""
        : this.data.audioDurationLabel,
      selectedFile: discardAudioSelection ? null : this.data.selectedFile,
      localDocumentReady: discardAudioSelection
        ? false
        : this.data.localDocumentReady,
      creatingDraftId: "",
      resumingClientImagesId: "",
      cleaningUpUploadId: ""
    });
    this.stopActiveUpload({ showMessage: false });
  },

  onUnload() {
    this.pageDestroyed = true;
    this.isPageVisible = false;
    this.accessRequestId = (this.accessRequestId || 0) + 1;
    this.historyRequestId = (this.historyRequestId || 0) + 1;
    this.draftsRequestId = (this.draftsRequestId || 0) + 1;
    this.reviewRequestId = (this.reviewRequestId || 0) + 1;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.uploadOperationId = (this.uploadOperationId || 0) + 1;
    this.draftOperationId = (this.draftOperationId || 0) + 1;
    this.cancelOperationId = (this.cancelOperationId || 0) + 1;
    this.resumeClientImagesOperationId =
      (this.resumeClientImagesOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.stopActiveUpload({ showMessage: false });
  },

  stopActiveUpload({
    showMessage = true,
    cancelRemote = showMessage
  } = {}) {
    const ticket = this.pendingUploadTicket;
    const task = this.uploadTask;
    const imageController = this.imageTransferController;

    if (!ticket && !task && !imageController && !this.data.uploading) {
      return;
    }

    this.uploadOperationId = (this.uploadOperationId || 0) + 1;
    if (task && typeof task.abort === "function") {
      try {
        task.abort();
      } catch (error) {
        console.warn("abort admin upload error:", error);
      }
    }
    if (imageController && typeof imageController.cancel === "function") {
      try {
        imageController.cancel();
      } catch (error) {
        console.warn("cancel Word image transfer error:", error);
      }
    }

    this.uploadTask = null;
    this.imageTransferController = null;
    const remoteCanResumeImages = Boolean(
      ticket &&
      (
        this.retryStage === "images" ||
        this.retryStage === "image-confirm" ||
        ticket.manifestResult ||
        ticket.imageUploadPlan
      )
    );
    const shouldCancelRemote = Boolean(
      cancelRemote || !remoteCanResumeImages
    );
    this.pendingUploadTicket = null;
    this.retryStage = "create";

    if (
      shouldCancelRemote &&
      ticket &&
      /^[a-f0-9]{32}$/.test(ticket.uploadId) &&
      wx.cloud
    ) {
      wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "cancelUpload", uploadId: ticket.uploadId }
      }).catch((error) => {
        console.warn("release canceled admin upload error:", error);
      });
    }

    if (!this.pageDestroyed) {
      this.setData({
        uploading: false,
        uploadProgress: 0,
        imageTransferCompleted: 0,
        imageTransferTotal: 0,
        uploadStageLabel: showMessage ? "已取消上传" : "",
        uploadError: "",
        canRetry: showMessage
      });
    }
  },

  cancelActiveUpload() {
    this.stopActiveUpload({
      showMessage: true,
      cancelRemote: true
    });
  },

  async loadAccessStatus() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        accessLoading: false,
        accessChecked: true,
        authorized: false,
        uploadAvailable: false,
        uploadMode: "",
        capabilities: adminContent.normalizeCapabilities(null),
        transportMessage: "",
        accessMessage: "云服务暂不可用，无法验证管理员权限。"
      });
      return;
    }

    const requestId = (this.accessRequestId || 0) + 1;
    this.accessRequestId = requestId;
    this.setData({
      accessLoading: true,
      accessChecked: false,
      authorized: false,
      uploadAvailable: false,
      uploadMode: "",
      capabilities: adminContent.normalizeCapabilities(null),
      transportMessage: "",
      accessMessage: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "status" }
      });
      const result = response.result || {};

      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.accessRequestId
      ) {
        return;
      }

      if (!hasUploadAccess(result)) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities: adminContent.normalizeCapabilities(null),
          transportMessage: "",
          role: "",
          accessMessage:
            result.message || "当前会员没有内容上传权限，请联系管理员。",
          uploads: []
        });
        return;
      }

      const capabilities = adminContent.normalizeCapabilities(result);
      const portalAvailable = Boolean(
        capabilities.upload ||
        capabilities.drafts ||
        capabilities.review ||
        capabilities.moderation ||
        capabilities.publish
      );
      if (!portalAvailable) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities,
          transportMessage: "",
          role: "",
          accessMessage: "当前管理员账号没有可用的内容管理能力。",
          uploads: [],
          drafts: [],
          reviewDrafts: []
        });
        return;
      }

      const uploadMode = capabilities.upload ? getUploadMode(result) : "";
      this.setData({
        accessLoading: false,
        accessChecked: true,
        authorized: true,
        uploadAvailable: Boolean(uploadMode),
        uploadMode,
        capabilities,
        transportMessage: uploadMode
          ? ""
          : capabilities.drafts
            ? "文件上传通道尚未配置，当前仍可处理已有草稿。"
            : "当前角色不承担文件上传。",
        role: getUploadRole(result),
        accessMessage: "",
        uploads: capabilities.drafts ? normalizeUploads(result) : []
      });
      await Promise.all([
        capabilities.drafts ? this.loadHistory({ quiet: true }) : Promise.resolve(),
        capabilities.drafts ? this.loadDrafts({ quiet: true }) : Promise.resolve(),
        capabilities.review ? this.loadReviewQueue({ quiet: true }) : Promise.resolve()
      ]);
    } catch (error) {
      console.error("load admin upload status error:", error);

      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.accessRequestId
      ) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities: adminContent.normalizeCapabilities(null),
          transportMessage: "",
          role: "",
          accessMessage: "权限验证失败，请检查网络后重试。",
          uploads: []
        });
      }
    }
  },

  retryAccess() {
    if (!this.data.accessLoading) {
      this.loadAccessStatus();
    }
  },

  async loadHistory({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.drafts ||
      this.historyLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }

    const requestId = (this.historyRequestId || 0) + 1;
    this.historyRequestId = requestId;
    this.historyLoading = true;
    this.setData({ historyLoading: true, historyError: "" });
    const offset = append && Number.isInteger(this.data.historyNextOffset)
      ? this.data.historyNextOffset
      : 0;

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: {
          action: "listUploads",
          limit: 20,
          offset
        }
      });
      const result = response.result || {};

      if (!result.success) {
        const error = new Error(result.message || "上传记录读取失败");
        error.userMessage = result.message;
        throw error;
      }

      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.historyRequestId
      ) {
        return;
      }

      const incoming = normalizeUploads(result);
      const uploads = append
        ? this.mergeById(this.data.uploads, incoming, "uploadId")
        : incoming;
      this.setData({
        uploads,
        historyError: "",
        historyHasMore: result.hasMore === true,
        historyNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
      this.syncUploadDraftState();
      return this.data.uploads;
    } catch (error) {
      console.error("load admin upload history error:", error);

      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.historyRequestId
      ) {
        const message = getErrorMessage(error, "上传记录读取失败，请稍后重试。");
        this.setData({ historyError: quiet ? "" : message });
      }
      return null;
    } finally {
      if (requestId === this.historyRequestId) {
        this.historyLoading = false;
        if (!this.pageDestroyed) {
          this.setData({ historyLoading: false });
        }
      }
    }
  },

  refreshHistory() {
    this.loadHistory({ append: false });
  },

  loadMoreHistory() {
    if (this.data.historyHasMore && !this.data.historyLoading) {
      this.loadHistory({ append: true });
    }
  },

  mergeById(current, incoming, field = "id") {
    const result = [];
    const seen = new Set();
    (Array.isArray(current) ? current : [])
      .concat(Array.isArray(incoming) ? incoming : [])
      .forEach((item) => {
        const id = normalizeText(item && item[field], 128);
        if (id && !seen.has(id)) {
          seen.add(id);
          result.push(item);
        }
      });
    return result;
  },

  async loadDrafts({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.drafts ||
      this.draftsLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.draftsRequestId || 0) + 1;
    this.draftsRequestId = requestId;
    this.draftsLoading = true;
    const offset = append && Number.isInteger(this.data.draftsNextOffset)
      ? this.data.draftsNextOffset
      : 0;
    this.setData({ draftsLoading: true, draftsError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "listDrafts", limit: 20, offset }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "草稿列表读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.draftsRequestId
      ) {
        return;
      }
      const incoming = adminContent.normalizeDrafts(result).map(withPublicDraftTitle);
      this.setData({
        drafts: append ? this.mergeById(this.data.drafts, incoming) : incoming,
        draftsError: "",
        draftsHasMore: result.hasMore === true,
        draftsNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
      this.syncUploadDraftState();
      this.syncBookTargets();
    } catch (error) {
      console.error("load admin drafts error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.draftsRequestId
      ) {
        this.setData({
          draftsError: quiet ? "" : getErrorMessage(error, "草稿列表读取失败，请稍后重试。")
        });
      }
    } finally {
      if (requestId === this.draftsRequestId) {
        this.draftsLoading = false;
        if (!this.pageDestroyed) this.setData({ draftsLoading: false });
      }
    }
  },

  refreshDrafts() {
    this.loadDrafts({ append: false });
  },

  loadMoreDrafts() {
    if (this.data.draftsHasMore && !this.data.draftsLoading) {
      this.loadDrafts({ append: true });
    }
  },

  syncUploadDraftState() {
    const draftIds = new Set(
      (Array.isArray(this.data.drafts) ? this.data.drafts : [])
        .map((draft) => normalizeText(draft && draft.id, 32))
        .filter(Boolean)
    );
    const uploads = (Array.isArray(this.data.uploads) ? this.data.uploads : [])
      .map((upload) => {
        const hasDraft = draftIds.has(upload.uploadId);
        return {
          ...upload,
          hasDraft,
          canCancel: Boolean(upload.canCancel && !hasDraft)
        };
      });
    this.setData({ uploads });
  },

  syncBookTargets() {
    const targets = buildBookTargets(this.data.drafts);
    const preferredId = normalizeText(this.selectedBookTargetId, 64).toLowerCase();
    let selectedIndex = targets.findIndex((item) => item.id === preferredId);
    if (selectedIndex < 0) {
      selectedIndex = 0;
    }
    const selectedTarget = targets[selectedIndex] || DEFAULT_BOOK_TARGETS[0];
    this.selectedBookTargetId = selectedTarget.id;
    const readiness = getPdfReadiness(this.data.drafts, selectedTarget.id);
    const update = {
      bookTargets: targets,
      pdfReadinessTone: readiness.tone,
      pdfReadinessTitle: readiness.title,
      pdfReadinessMessage: readiness.message
    };

    if (this.data.selectedAssetType === "full-book-pdf") {
      this.targetSelectionConfirmed = true;
      Object.assign(update, {
        relatedId: selectedTarget.id,
        uploadTargets: targets,
        uploadTargetsLoading: false,
        uploadTargetsError: "",
        selectedTargetIndex: selectedIndex,
        selectedTargetTitle: selectedTarget.title,
        selectedTargetSubtitle: selectedTarget.subtitle
      });
    }

    this.setData(update);
  },

  async loadReviewQueue({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.review ||
      this.reviewLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.reviewRequestId || 0) + 1;
    this.reviewRequestId = requestId;
    this.reviewLoading = true;
    const offset = append && Number.isInteger(this.data.reviewNextOffset)
      ? this.data.reviewNextOffset
      : 0;
    this.setData({ reviewLoading: true, reviewError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "listReviewQueue", limit: 20, offset }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "审核队列读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.reviewRequestId
      ) {
        return;
      }
      const incoming = adminContent.normalizeDrafts(result).map(withPublicDraftTitle);
      this.setData({
        reviewDrafts: append
          ? this.mergeById(this.data.reviewDrafts, incoming)
          : incoming,
        reviewError: "",
        reviewHasMore: result.hasMore === true,
        reviewNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
    } catch (error) {
      console.error("load admin review queue error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.reviewRequestId
      ) {
        this.setData({
          reviewError: quiet ? "" : getErrorMessage(error, "审核队列读取失败，请稍后重试。")
        });
      }
    } finally {
      if (requestId === this.reviewRequestId) {
        this.reviewLoading = false;
        if (!this.pageDestroyed) this.setData({ reviewLoading: false });
      }
    }
  },

  refreshReviewQueue() {
    this.loadReviewQueue({ append: false });
  },

  loadMoreReviewQueue() {
    if (this.data.reviewHasMore && !this.data.reviewLoading) {
      this.loadReviewQueue({ append: true });
    }
  },

  onEntryTap(event) {
    if (this.data.uploading) {
      return;
    }
    const entryId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.entryId,
      32
    );
    const entry = ADMIN_ENTRY_CARDS.find((item) => item.id === entryId);
    if (!entry) {
      return;
    }
    if (entry.kind === "editorial") {
      if (typeof wx.navigateTo === "function") {
        wx.navigateTo({
          url:
            `/pages/adminEditorial/adminEditorial?type=${entry.editorialType}`
        });
      }
      return;
    }
    this.activateFileEntry(entry.assetType);
  },

  openModeration() {
    if (!this.data.authorized || !this.data.capabilities.moderation) {
      wx.showToast({
        title: "当前账号没有读后感复审权限",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/adminModeration/adminModeration"
    });
  },

  activateFileEntry(assetType, { force = false } = {}) {
    if (
      this.data.uploading ||
      !["manuscript", "audio", "special-topic", "full-book-pdf"].includes(assetType) ||
      (
        !force &&
        this.data.selectedEntryKind === "file" &&
        this.data.selectedAssetType === assetType
      )
    ) {
      return;
    }

    const optionIndex = ASSET_TYPES.findIndex((item) => item.value === assetType);
    const option = ASSET_TYPES[optionIndex];
    const entryAssetType = assetType === "full-book-pdf"
      ? "manuscript"
      : assetType;
    const entry = ADMIN_ENTRY_CARDS.find(
      (item) => item.kind === "file" && item.assetType === entryAssetType
    );
    const isBookPdf = assetType === "full-book-pdf";
    const requiresTarget = assetType === "audio" || isBookPdf;
    const bookTargets = this.data.bookTargets.length > 0
      ? this.data.bookTargets
      : DEFAULT_BOOK_TARGETS;
    let selectedBookIndex = bookTargets.findIndex(
      (item) => item.id === this.selectedBookTargetId
    );
    if (selectedBookIndex < 0) {
      selectedBookIndex = 0;
    }
    const selectedBook = bookTargets[selectedBookIndex] || DEFAULT_BOOK_TARGETS[0];
    const relatedId = isBookPdf
      ? selectedBook.id
      : requiresTarget
        ? ""
        : createNewTargetId(assetType);
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.targetSelectionConfirmed = isBookPdf || !requiresTarget;
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.setData({
      selectedEntryId: entry.id,
      selectedEntryKind: "file",
      assetTypeIndex: optionIndex,
      selectedAssetType: assetType,
      selectedAssetTypeLabel: option.label,
      manuscriptStep: isBookPdf
        ? "pdf"
        : assetType === "manuscript"
          ? "word"
          : "",
      contentMode: requiresTarget ? "existing" : "new",
      relatedId,
      uploadTargets: isBookPdf ? bookTargets : [],
      uploadTargetsLoading: false,
      uploadTargetsError: "",
      selectedTargetIndex: isBookPdf ? selectedBookIndex : -1,
      selectedTargetTitle: isBookPdf ? selectedBook.title : "",
      selectedTargetSubtitle: isBookPdf ? selectedBook.subtitle : "",
      targetSelectionRequired: requiresTarget,
      targetPickerLabel: isBookPdf
        ? "选择下载版所属书目"
        : requiresTarget
          ? "选择要配音的文章"
          : "",
      emptyTargetMessage: isBookPdf
        ? "暂时没有可选书目。"
        : requiresTarget
          ? "还没有可配音的文章，请先上传并发布首页书稿。"
          : "",
      fileDisplayType: getFileDisplayType(assetType),
      fileFormatHint: assetType === "audio"
        ? "支持 MP3、M4A、WAV 格式"
        : isBookPdf
          ? "仅支持 PDF 格式"
          : "支持 DOCX；旧版 DOC 请先另存为 DOCX",
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });

    if (requiresTarget) {
      if (isBookPdf) {
        this.syncBookTargets();
      } else {
        this.loadUploadTargets("content");
      }
    }
  },

  onManuscriptStepTap(event) {
    if (this.data.uploading) {
      return;
    }
    const step = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.step,
      16
    );
    if (!["word", "pdf"].includes(step) || step === this.data.manuscriptStep) {
      return;
    }

    this.activateFileEntry(
      step === "pdf" ? "full-book-pdf" : "manuscript",
      { force: true }
    );
  },

  onAssetTypeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const option = ASSET_TYPES[index];
    if (!option) {
      return;
    }
    this.activateFileEntry(option.value, { force: true });
  },

  onContentModeTap(event) {
    if (
      this.data.uploading ||
      !["manuscript", "special-topic"].includes(this.data.selectedAssetType)
    ) {
      return;
    }
    const mode = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.mode,
      16
    );
    if (!["new", "update"].includes(mode) || mode === this.data.contentMode) {
      return;
    }

    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.targetSelectionConfirmed = mode === "new";
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    const isTopic = this.data.selectedAssetType === "special-topic";
    this.setData({
      contentMode: mode,
      relatedId: mode === "new"
        ? createNewTargetId(this.data.selectedAssetType)
        : "",
      uploadTargets: [],
      uploadTargetsLoading: false,
      uploadTargetsError: "",
      selectedTargetIndex: -1,
      selectedTargetTitle: "",
      selectedTargetSubtitle: "",
      targetSelectionRequired: mode === "update",
      targetPickerLabel: mode === "update"
        ? (isTopic ? "选择要更新的小专题" : "选择要更新的书稿")
        : "",
      emptyTargetMessage: mode === "update"
        ? (
            isTopic
              ? "还没有已发布的小专题，请先新建并发布一个小专题。"
              : "还没有已发布书稿，请先选择“新建内容”上传第一篇。"
          )
        : "",
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });

    if (mode === "update") {
      this.loadUploadTargets(targetTypeForAsset(this.data.selectedAssetType));
    }
  },

  async loadUploadTargets(targetType) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.upload ||
      !["content", "special-topic"].includes(targetType) ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.targetRequestId || 0) + 1;
    this.targetRequestId = requestId;
    this.setData({
      uploadTargetsLoading: true,
      uploadTargetsError: "",
      uploadTargets: [],
      selectedTargetIndex: -1,
      selectedTargetTitle: "",
      selectedTargetSubtitle: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: {
          action: "listUploadTargets",
          targetType
        }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "内容列表读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.targetRequestId
      ) {
        return;
      }
      this.setData({
        uploadTargets: normalizeUploadTargets(result),
        uploadTargetsError: ""
      });
    } catch (error) {
      console.error("load upload targets error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.targetRequestId
      ) {
        this.setData({
          uploadTargets: [],
          uploadTargetsError: getErrorMessage(
            error,
            "文章列表读取失败，请稍后重试。"
          )
        });
      }
    } finally {
      if (requestId === this.targetRequestId && !this.pageDestroyed) {
        this.setData({ uploadTargetsLoading: false });
      }
    }
  },

  retryUploadTargets() {
    if (!this.data.uploadTargetsLoading) {
      if (this.data.selectedAssetType === "full-book-pdf") {
        this.syncBookTargets();
        return;
      }
      this.loadUploadTargets(
        targetTypeForAsset(this.data.selectedAssetType)
      );
    }
  },

  onUploadTargetChange(event) {
    if (this.data.uploading) {
      return;
    }
    const index = Number(event && event.detail && event.detail.value);
    const target = this.data.uploadTargets[index];
    if (!target || !isStableTargetId(target.id)) {
      return;
    }

    this.targetSelectionConfirmed = true;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    if (this.data.selectedAssetType === "full-book-pdf") {
      this.selectedBookTargetId = target.id;
    }
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.setData({
      relatedId: target.id,
      selectedTargetIndex: index,
      selectedTargetTitle: target.title,
      selectedTargetSubtitle: target.subtitle,
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });
    if (this.data.selectedAssetType === "full-book-pdf") {
      const readiness = getPdfReadiness(this.data.drafts, target.id);
      this.setData({
        pdfReadinessTone: readiness.tone,
        pdfReadinessTitle: readiness.title,
        pdfReadinessMessage: readiness.message
      });
    }
  },

  onRelatedIdInput(event) {
    if (this.data.uploading) {
      return;
    }

    const relatedId = normalizeText(
      event && event.detail && event.detail.value,
      64
    ).toLowerCase();
    if (relatedId !== this.data.relatedId) {
      this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
      this.cancelAudioDurationProbe();
      this.localParseRequestId = (this.localParseRequestId || 0) + 1;
      this.localDocumentManifest = null;
    }
    this.resetRetryState();
    this.targetSelectionConfirmed = true;
    this.setData({
      relatedId,
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadError: "",
      uploadSuccess: ""
    });
  },

  chooseFile() {
    if (
      !this.data.authorized ||
      !this.data.uploadAvailable ||
      this.data.uploading ||
      this.data.fileChoosing
    ) {
      return;
    }

    if (typeof wx.chooseMessageFile !== "function") {
      wx.showToast({ title: "当前微信版本不支持文件选择", icon: "none" });
      return;
    }

    const requestId = (this.fileSelectionRequestId || 0) + 1;
    const selectedAssetType = this.data.selectedAssetType;
    const selectedUploadMode = this.data.uploadMode;
    const relatedId = this.data.relatedId;
    this.fileSelectionRequestId = requestId;
    this.cancelAudioDurationProbe();
    this.setData({
      fileChoosing: true,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: ""
    });
    const finishChoosing = () => {
      if (
        !this.pageDestroyed &&
        requestId === this.fileSelectionRequestId
      ) {
        this.setData({ fileChoosing: false });
      }
    };

    try {
      wx.chooseMessageFile({
        count: 1,
        type: "file",
        success: (result) => {
          if (
            this.pageDestroyed ||
            requestId !== this.fileSelectionRequestId ||
            this.data.selectedAssetType !== selectedAssetType ||
            this.data.relatedId !== relatedId
          ) {
            return;
          }
          finishChoosing();

          const file = result && Array.isArray(result.tempFiles)
            ? result.tempFiles[0]
            : null;
          const filePath = normalizeText(
            file && (file.path || file.tempFilePath),
            2048
          );
          const fallbackFileName = filePath
            ? filePath.split(/[\\/]/).pop()
            : "";
          const fileName = normalizeText(
            file && (file.name || file.fileName) || fallbackFileName,
            180
          );
          const size = Number(file && file.size);

          if (
            !file ||
            !fileName ||
            !filePath ||
            !Number.isFinite(size) ||
            size <= 0
          ) {
            wx.showToast({
              title: "所选文件信息不完整，请重新选择",
              icon: "none"
            });
            return;
          }

          if (!isAllowedFile(selectedAssetType, fileName)) {
            wx.showToast({
              title: `该类型仅支持 ${allowedFileHint(selectedAssetType)}`,
              icon: "none"
            });
            return;
          }

          const selectedFile = {
            fileName,
            filePath,
            size,
            sizeLabel: formatFileSize(size),
            mimeType: inferMimeType(fileName, file.type || file.mimeType)
          };

          this.resetRetryState();
          this.setData({
            selectedFile,
            audioDurationLoading: false,
            audioDurationError: "",
            audioDurationLabel: "",
            uploadProgress: 0,
            imageTransferCompleted: 0,
            imageTransferTotal: 0,
            uploadStageLabel: "",
            uploadError: "",
            uploadSuccess: "",
            localParseWarning: ""
          });
          if (selectedAssetType === "audio") {
            this.prepareSelectedAudio(requestId);
          } else {
            this.prepareSelectedDocument({
              file: selectedFile,
              assetType: selectedAssetType,
              uploadMode: selectedUploadMode
            });
          }
        },
        fail: (error) => {
          if (
            requestId !== this.fileSelectionRequestId ||
            this.pageDestroyed
          ) {
            return;
          }
          finishChoosing();
          if (!isCancelError(error)) {
            console.error("choose admin upload file error:", error);
            wx.showToast({ title: "文件选择失败，请重试", icon: "none" });
          }
        }
      });
    } catch (error) {
      finishChoosing();
      console.error("open admin upload file chooser error:", error);
      wx.showToast({ title: "文件选择失败，请重试", icon: "none" });
    }
  },

  cancelAudioDurationProbe() {
    this.audioProbeRequestId = (this.audioProbeRequestId || 0) + 1;
    const cancel = this.audioProbeCancel;
    const context = this.audioProbeContext;
    this.audioProbeCancel = null;
    this.audioProbeContext = null;

    if (typeof cancel === "function") {
      cancel();
      return;
    }
    if (context && typeof context.destroy === "function") {
      try {
        context.destroy();
      } catch (error) {
        console.warn("destroy audio duration probe error:", error);
      }
    }
  },

  readAudioDuration(filePath, requestId) {
    return new Promise((resolve, reject) => {
      if (typeof wx.createInnerAudioContext !== "function") {
        reject(new Error("当前微信版本无法读取配音时长"));
        return;
      }

      let context;
      try {
        context = wx.createInnerAudioContext();
      } catch (error) {
        reject(error);
        return;
      }
      if (!context) {
        reject(new Error("无法打开配音文件"));
        return;
      }

      this.audioProbeContext = context;
      let settled = false;
      let retryTimer = null;
      const timeoutTimer = setTimeout(() => {
        finish(
          reject,
          new Error("读取配音时长超时，请重新选择音频文件")
        );
      }, AUDIO_DURATION_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (this.audioProbeContext === context) {
          this.audioProbeContext = null;
          this.audioProbeCancel = null;
        }
        if (typeof context.destroy === "function") {
          try {
            context.destroy();
          } catch (error) {
            console.warn("destroy audio duration probe error:", error);
          }
        }
      };
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        handler(value);
      };
      const canceledError = new Error("音频时长读取已取消");
      canceledError.canceled = true;
      this.audioProbeCancel = () => finish(reject, canceledError);
      const readDuration = () => {
        if (
          settled ||
          this.pageDestroyed ||
          requestId !== this.audioProbeRequestId
        ) {
          finish(reject, canceledError);
          return;
        }
        const duration = Number(context.duration);
        if (Number.isFinite(duration) && duration > 0 && duration <= 86400) {
          finish(resolve, Math.round(duration * 1000) / 1000);
          return;
        }
        retryTimer = setTimeout(readDuration, 120);
      };

      if (typeof context.onCanplay === "function") {
        context.onCanplay(readDuration);
      }
      if (typeof context.onLoadedMetadata === "function") {
        context.onLoadedMetadata(readDuration);
      }
      if (typeof context.onError === "function") {
        context.onError(() => {
          finish(reject, new Error("无法读取这段配音的时长"));
        });
      }

      try {
        context.autoplay = false;
        context.src = filePath;
        readDuration();
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  async prepareSelectedAudio(selectionRequestId) {
    const file = this.data.selectedFile;
    const requestId = (this.audioProbeRequestId || 0) + 1;
    this.audioProbeRequestId = requestId;
    this.setData({
      audioDurationLoading: true,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false
    });

    try {
      const durationSeconds = await this.readAudioDuration(
        file && file.filePath,
        requestId
      );
      if (
        this.pageDestroyed ||
        selectionRequestId !== this.fileSelectionRequestId ||
        requestId !== this.audioProbeRequestId ||
        this.data.selectedAssetType !== "audio" ||
        !this.data.selectedFile ||
        this.data.selectedFile.filePath !== file.filePath
      ) {
        return;
      }
      const roundedLabel = durationSeconds >= 60
        ? `${Math.floor(durationSeconds / 60)} 分 ${Math.round(durationSeconds % 60)} 秒`
        : `${Math.round(durationSeconds)} 秒`;
      this.setData({
        selectedFile: {
          ...this.data.selectedFile,
          durationSeconds
        },
        audioDurationLoading: false,
        audioDurationError: "",
        audioDurationLabel: roundedLabel,
        localDocumentReady: true
      });
    } catch (error) {
      if (
        this.pageDestroyed ||
        selectionRequestId !== this.fileSelectionRequestId ||
        requestId !== this.audioProbeRequestId ||
        (error && error.canceled)
      ) {
        return;
      }
      this.setData({
        audioDurationLoading: false,
        audioDurationError:
          "无法读取这段配音的时长，请重新选择音频文件。",
        audioDurationLabel: "",
        localDocumentReady: false
      });
    }
  },

  resetRetryState() {
    this.retryStage = "";
    this.pendingUploadTicket = null;
    this.setData({ canRetry: false });
  },

  requiresLocalDocument(file = this.data.selectedFile, options = {}) {
    const fileName = normalizeText(file && file.fileName, 180).toLowerCase();
    const uploadMode = normalizeText(
      options.uploadMode || this.data.uploadMode,
      64
    );
    const assetType = normalizeText(
      options.assetType || this.data.selectedAssetType,
      64
    );

    return Boolean(
      uploadMode === "cloud-storage-direct" &&
      ["manuscript", "special-topic"].includes(assetType) &&
      fileName.endsWith(".docx")
    );
  },

  async prepareSelectedDocument(options = {}) {
    const file = options.file || this.data.selectedFile;
    const assetType = options.assetType || this.data.selectedAssetType;
    const uploadMode = options.uploadMode || this.data.uploadMode;
    const requestId = (this.localParseRequestId || 0) + 1;
    this.localParseRequestId = requestId;
    this.localDocumentManifest = null;

    if (!this.requiresLocalDocument(file, { assetType, uploadMode })) {
      this.setData({
        localDocumentReady: true,
        localParseError: "",
        localParseLoading: false,
        localParsePreview: [],
        localParseSummary: "",
        localParseWarning: ""
      });
      return;
    }

    this.setData({
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: true,
      localParsePreview: [],
      localParseSummary: "正在本机读取 Word 正文",
      localParseWarning: ""
    });

    try {
      const manifest = createClientManifest(
        await docxImport.analyzeDocx(file.filePath, {
          wx,
          ...getDocumentImportLimits(assetType)
        })
      );

      if (
        this.pageDestroyed ||
        requestId !== this.localParseRequestId ||
        !this.data.selectedFile ||
        this.data.selectedFile.filePath !== file.filePath ||
        this.data.selectedAssetType !== assetType
      ) {
        return;
      }

      const stats = manifest && manifest.stats || {};
      if (stats.truncated) {
        const error = new Error(
          getDocumentTooLargeMessage(assetType)
        );
        error.userMessage = error.message;
        throw error;
      }
      if (Number(stats.omittedImageReferences) > 0) {
        const error = new Error(
          "这份 Word 的图片较多，请拆分文稿后重新上传"
        );
        error.userMessage = error.message;
        throw error;
      }
      if (Number(stats.unsupportedImageReferences) > 0) {
        const error = new Error(
          "Word 中有暂不支持的图片，请改为 JPG、PNG、GIF 或 WEBP 后重新上传"
        );
        error.userMessage = error.message;
        throw error;
      }
      if (utf8ByteLength(JSON.stringify(manifest)) > 700 * 1024) {
        const error = new Error(
          getDocumentTooLargeMessage(assetType)
        );
        error.userMessage = error.message;
        throw error;
      }

      this.localDocumentManifest = manifest;
      const preview = Array.isArray(manifest && manifest.blocks)
        ? manifest.blocks
            .map((block) => normalizeText(block && block.text, 180))
            .filter(Boolean)
            .slice(0, 3)
        : [];
      this.setData({
        localDocumentReady: true,
        localParseError: "",
        localParseLoading: false,
        localParsePreview: preview,
        localParseSummary:
          `已识别 ${Number(stats.extractedBlocks) || 0} 段、` +
          `${Number(stats.extractedCharacters) || 0} 个字` +
          (
            Number(stats.skippedTableOfContentsParagraphs) > 0
              ? `，已跳过目录 ${Number(stats.skippedTableOfContentsParagraphs)} 段`
              : ""
          ),
        localParseWarning: (Array.isArray(manifest.warnings) ? manifest.warnings : [])
          .concat([
            Number(stats.imageCount) > 0
              ? `检测到 ${Number(stats.imageCount)} 张内嵌图片；本轮会保留图片位置说明，图片仍需后续确认。`
              : ""
          ])
          .filter(Boolean)
          .join(" ")
      });
    } catch (error) {
      if (
        this.pageDestroyed ||
        requestId !== this.localParseRequestId
      ) {
        return;
      }
      this.setData({
        localDocumentReady: false,
        localParseError: getErrorMessage(
          error,
          "无法读取这个 Word 文件，请重新选择"
        ),
        localParseLoading: false,
        localParsePreview: [],
        localParseSummary: "",
        localParseWarning: ""
      });
    }
  },

  retryLocalDocument() {
    if (!this.data.localParseLoading && this.data.selectedFile) {
      return this.prepareSelectedDocument();
    }

    return Promise.resolve();
  },

  waitForClientImageDelay(delayMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(delayMs) || 0));
    });
  },

  async callAdminContentWithRetry(data, options = {}) {
    const isActive = typeof options.isActive === "function"
      ? options.isActive
      : () => !this.pageDestroyed;
    const maximumRetries = Number.isInteger(options.maximumRetries)
      ? Math.max(0, options.maximumRetries)
      : CLIENT_IMAGE_CONFIRM_MAX_RETRIES;
    const fallback = normalizeText(options.fallback, 180) ||
      "管理员内容服务暂不可用";
    let retries = 0;

    while (isActive()) {
      try {
        const response = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data
        });
        if (!isActive()) {
          return null;
        }
        const result = response.result || {};
        if (!result.success) {
          throw createAdminContentError(result, fallback);
        }
        return result;
      } catch (error) {
        if (
          !isActive() ||
          retries >= maximumRetries ||
          !isRetryableAdminContentError(error)
        ) {
          throw error;
        }
        const delayMs =
          CLIENT_IMAGE_CONFIRM_RETRY_BASE_MS * Math.pow(2, retries);
        retries += 1;
        await this.waitForClientImageDelay(delayMs);
      }
    }

    return null;
  },

  async transferAndConfirmClientImages(
    ticket,
    manifest,
    manifestResult,
    operationId
  ) {
    if (!ticket.imageUploadPlan) {
      ticket.imageUploadPlan = normalizeClientImageUploadPlan(
        manifestResult,
        manifest
      );
    }

    if (this.retryStage !== "image-confirm") {
      this.retryStage = "images";
      this.pendingUploadTicket = ticket;
      this.setData({
        uploadStageLabel: `正在上传内嵌图片（0/${ticket.imageUploadPlan.length}）`,
        uploadProgress: 0,
        imageTransferCompleted: 0,
        imageTransferTotal: ticket.imageUploadPlan.length
      });
      const controller = docxImageTransfer.createCancellationController();
      this.imageTransferController = controller;
      let transferResult;
      try {
        transferResult = await docxImageTransfer.transferDocxImages({
          filePath: ticket.filePath,
          images: manifest.images,
          uploadPlan: ticket.imageUploadPlan,
          existingFiles: Array.isArray(ticket.imageUploadedFiles)
            ? ticket.imageUploadedFiles
            : [],
          wx,
          concurrency: 2,
          cancelToken: controller.token,
          onProgress: (progress = {}) => {
            if (
              this.pageDestroyed ||
              operationId !== this.uploadOperationId
            ) {
              return;
            }
            const total = Math.max(
              0,
              Number(progress.total) || ticket.imageUploadPlan.length
            );
            const completed = Math.max(
              0,
              Math.min(total, Number(progress.completed) || 0)
            );
            const percent = Math.max(
              0,
              Math.min(100, Math.round(Number(progress.percent) || 0))
            );
            const phaseLabel = progress.phase === "extracting"
              ? "正在读取"
              : progress.phase === "uploading"
                ? "正在上传"
                : "正在处理";
            this.setData({
              imageTransferCompleted: completed,
              imageTransferTotal: total,
              uploadProgress: percent,
              uploadStageLabel:
                `${phaseLabel}内嵌图片（${completed}/${total}）`
            });
          }
        });
      } catch (error) {
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return null;
        }
        if (error && Array.isArray(error.uploadedFiles)) {
          ticket.imageUploadedFiles = error.uploadedFiles;
          this.pendingUploadTicket = ticket;
        }
        throw error;
      } finally {
        if (this.imageTransferController === controller) {
          this.imageTransferController = null;
        }
      }

      if (
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }
      if (
        !transferResult ||
        !Array.isArray(transferResult.files) ||
        transferResult.files.length !== ticket.imageUploadPlan.length
      ) {
        throw new Error("Word 图片上传结果不完整，请重试");
      }
      ticket.imageFiles = transferResult.files;
      ticket.imageUploadedFiles = transferResult.files;
      ticket.imageConfirmationBatches = Array.isArray(
        transferResult.confirmationBatches
      )
        ? transferResult.confirmationBatches
        : docxImageTransfer.chunkDocxImageFiles(ticket.imageFiles);
      ticket.imageConfirmationState = ticket.imageConfirmationBatches.map(
        (files) => ({
          confirmed: false,
          files,
          requestId: adminContent.createMutationId("confirm-images")
        })
      );
      this.pendingUploadTicket = ticket;
      this.retryStage = "image-confirm";
    }

    const batches = Array.isArray(ticket.imageConfirmationState)
      ? ticket.imageConfirmationState
      : [];
    if (
      batches.length === 0 ||
      batches.some(
        (batch) =>
          !Array.isArray(batch.files) ||
          batch.files.length < 1 ||
          batch.files.length > 20
      )
    ) {
      throw new Error("Word 图片确认清单无效，请重试");
    }

    let finalResult = manifestResult;
    let confirmedImages = batches
      .filter((batch) => batch.confirmed)
      .reduce((sum, batch) => sum + batch.files.length, 0);
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      if (batch.confirmed) {
        continue;
      }
      if (
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }
      this.setData({
        uploadStageLabel:
          `正在确认内嵌图片（${confirmedImages}/${ticket.imageFiles.length}）`,
        uploadProgress: Math.round(
          (confirmedImages / ticket.imageFiles.length) * 100
        )
      });
      const result = await this.callAdminContentWithRetry(
        {
          action: "confirmClientImages",
          uploadId: ticket.uploadId,
          requestId: batch.requestId,
          files: batch.files
        },
        {
          fallback: "Word 图片确认失败",
          isActive: () =>
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
        }
      );
      if (
        !result ||
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }

      const state = getConfirmedUploadState(result, ticket.mode);
      const finalBatch = index === batches.length - 1;
      if (
        finalBatch
          ? (
              !result.complete ||
              !state.canCreateDraft ||
              state.validationStatus !== "client_manifest_validated"
            )
          : (
              result.complete ||
              !state.requiresClientImages ||
              state.canCreateDraft ||
              state.validationStatus !== "awaiting_client_images"
            )
      ) {
        throw new Error("Word 图片确认状态异常，请刷新后重试");
      }
      batch.confirmed = true;
      confirmedImages += batch.files.length;
      finalResult = result;
      ticket.imageLastConfirmResult = result;
      this.pendingUploadTicket = ticket;
      if (
        batches.slice(index + 1).some((item) => !item.confirmed)
      ) {
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }
    }

    this.setData({
      imageTransferCompleted: ticket.imageFiles.length,
      imageTransferTotal: ticket.imageFiles.length,
      uploadProgress: 100
    });
    return finalResult;
  },

  async startUpload() {
    if (this.data.uploading || this.data.fileChoosing || this.pageDestroyed) {
      return;
    }

    if (!this.data.authorized) {
      wx.showToast({ title: "当前账号没有上传权限", icon: "none" });
      return;
    }

    if (!this.data.uploadAvailable) {
      wx.showToast({ title: "上传通道尚未配置", icon: "none" });
      return;
    }

    if (
      this.data.targetSelectionRequired &&
      (
        !this.targetSelectionConfirmed ||
        !isStableTargetId(this.data.relatedId)
      )
    ) {
      wx.showToast({
        title: this.data.selectedAssetType === "audio"
          ? "请先选择要配音的文章"
          : "请先选择要更新的内容",
        icon: "none"
      });
      return;
    }

    const selectedFile = this.data.selectedFile;

    if (!selectedFile) {
      wx.showToast({ title: "请先选择一个文件", icon: "none" });
      return;
    }

    if (
      this.data.selectedAssetType === "audio" &&
      (
        this.data.audioDurationLoading ||
        !Number.isFinite(Number(selectedFile.durationSeconds)) ||
        Number(selectedFile.durationSeconds) <= 0
      )
    ) {
      wx.showToast({
        title: this.data.audioDurationLoading
          ? "正在读取配音时长，请稍候"
          : "请重新选择能够正常播放的音频文件",
        icon: "none"
      });
      return;
    }

    if (this.requiresLocalDocument(selectedFile)) {
      if (this.data.localParseLoading) {
        wx.showToast({
          title: "正在读取 Word，请稍候",
          icon: "none"
        });
        return;
      }

      if (
        (
          !this.data.localDocumentReady ||
          !this.localDocumentManifest
        ) &&
        !this.data.localParseError
      ) {
        await this.prepareSelectedDocument({
          file: selectedFile,
          assetType: this.data.selectedAssetType,
          uploadMode: this.data.uploadMode
        });

        if (
          this.pageDestroyed ||
          !this.data.selectedFile ||
          this.data.selectedFile.filePath !== selectedFile.filePath
        ) {
          return;
        }
      }

      if (
        !this.data.localDocumentReady ||
        !this.localDocumentManifest
      ) {
        wx.showToast({
          title: "请先重试读取 Word 文件",
          icon: "none"
        });
        return;
      }
    }

    const relatedId = normalizeText(this.data.relatedId, 64).toLowerCase();
    if (!isStableTargetId(relatedId)) {
      wx.showToast({
        title: "内容信息异常，请重新选择栏目",
        icon: "none"
      });
      return;
    }
    if (!isAllowedFile(this.data.selectedAssetType, selectedFile.fileName)) {
      wx.showToast({
        title: `该类型仅支持 ${allowedFileHint(this.data.selectedAssetType)}`,
        icon: "none"
      });
      return;
    }

    const operationId = (this.uploadOperationId || 0) + 1;
    this.uploadOperationId = operationId;
    this.setData({
      uploading: true,
      uploadError: "",
      uploadSuccess: "",
      canRetry: false,
      uploadStageLabel:
        this.retryStage === "manifest"
          ? "正在校验 Word 正文"
          : this.retryStage === "images"
            ? "正在上传内嵌图片"
            : this.retryStage === "image-confirm"
              ? "正在确认内嵌图片"
              : this.retryStage === "confirm"
                ? "正在确认文件"
                : "正在准备上传"
    });

    try {
      let ticket = this.pendingUploadTicket;

      if (!ticket || this.retryStage === "create") {
        this.retryStage = "create";
        const createUploadData = {
          action: "createUpload",
          fileName: selectedFile.fileName,
          declaredBytes: selectedFile.size,
          mimeType: selectedFile.mimeType,
          assetType: this.data.selectedAssetType,
          relatedId
        };
        if (this.data.selectedAssetType === "audio") {
          createUploadData.clientDurationSeconds = Number(
            selectedFile.durationSeconds
          );
        }
        const response = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: createUploadData
        });
        const result = response.result || {};
        const upload = result.upload && typeof result.upload === "object"
          ? result.upload
          : result;
        const uploadId = normalizeText(upload.uploadId || upload.id, 128);
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          if (
            result.success &&
            /^[a-f0-9]{32}$/.test(uploadId) &&
            wx.cloud &&
            typeof wx.cloud.callFunction === "function"
          ) {
            wx.cloud.callFunction({
              name: "adminContentCenter",
              data: { action: "cancelUpload", uploadId }
            }).catch((error) => {
              console.warn("release stale admin upload error:", error);
            });
          }
          return;
        }
        const brokerTransport = normalizeBrokerTransport(result);
        const directTransport = normalizeDirectCloudTransport(result, uploadId);
        const transport = brokerTransport || directTransport;

        if (
          !result.success ||
          !/^[a-f0-9]{32}$/.test(uploadId) ||
          !transport ||
          (
            transport.mode === "https-broker" &&
            !transport.url.endsWith(`/${uploadId}`)
          )
        ) {
          const error = new Error(result.message || "创建上传任务失败");
          error.userMessage = result.message;
          throw error;
        }

        ticket = transport.mode === "https-broker"
          ? {
              uploadId,
              mode: "https-broker",
              brokerUrl: transport.url,
              brokerTicket: transport.ticket,
              fieldName: transport.fieldName,
              filePath: selectedFile.filePath
            }
          : {
              uploadId,
              mode: "cloud-storage-direct",
              cloudPath: transport.cloudPath,
              filePath: selectedFile.filePath,
              originalFileUploadRequired:
                transport.originalFileUploadRequired !== false,
              sourceMode: transport.sourceMode
            };
        this.pendingUploadTicket = ticket;
        const clientManifestOnly = Boolean(
          ticket.mode === "cloud-storage-direct" &&
          ticket.originalFileUploadRequired === false &&
          ticket.sourceMode === "client-manifest-only" &&
          ["manuscript", "special-topic"].includes(
            this.data.selectedAssetType
          ) &&
          this.localDocumentManifest
        );
        if (clientManifestOnly) {
          ticket.confirmResult = {
            success: true,
            requiresClientManifest: true,
            upload: {
              id: uploadId,
              status: "pending_upload",
              validationStatus: "awaiting_client_manifest",
              requiresClientManifest: true
            }
          };
          this.pendingUploadTicket = ticket;
          this.retryStage = "manifest";
        } else {
          this.retryStage = "upload";
        }
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      if (this.retryStage === "upload") {
        this.setData({ uploadStageLabel: "正在上传文件", uploadProgress: 0 });
        if (ticket.mode === "cloud-storage-direct") {
          const directResult = await this.uploadCloudFile(ticket, operationId);
          if (
            this.pageDestroyed ||
            operationId !== this.uploadOperationId
          ) {
            return;
          }
          const fileID = normalizeCloudFileID(
            directResult && directResult.fileID,
            ticket.cloudPath
          );

          if (!fileID) {
            throw new Error("文件上传结果无效，请重新上传");
          }
          ticket.fileID = fileID;
        } else {
          const uploadResult = parseBrokerUploadResult(
            await this.uploadFile(ticket, operationId)
          );
          if (
            this.pageDestroyed ||
            operationId !== this.uploadOperationId
          ) {
            return;
          }
          const completedUploadId = normalizeText(uploadResult && uploadResult.uploadId, 128);
          const completedStatus = normalizeText(uploadResult && uploadResult.status, 32);

          if (completedUploadId !== ticket.uploadId || completedStatus !== "uploaded") {
            throw new Error("文件上传结果无效，请重试");
          }
        }

        this.pendingUploadTicket = ticket;
        this.retryStage = "confirm";
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      let confirmResult = ticket.confirmResult || {};
      if (this.retryStage === "confirm") {
        this.setData({
          uploadStageLabel: ticket.mode === "cloud-storage-direct"
            ? "正在确认云端原件"
            : "正在确认文件",
          uploadProgress: 100
        });
        const confirmData = {
          action: "confirmUpload",
          uploadId: ticket.uploadId
        };
        if (ticket.mode === "cloud-storage-direct") {
          confirmData.fileID = ticket.fileID;
        }
        const confirmResponse = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: confirmData
        });
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        confirmResult = confirmResponse.result || {};

        if (!confirmResult.success) {
          const error = new Error(confirmResult.message || "文件确认失败");
          error.userMessage = confirmResult.message;
          error.code = confirmResult.code;
          if (confirmResult.code === "UPLOAD_RESERVATION_EXPIRED") {
            error.restartReservation = true;
          }
          throw error;
        }
        ticket.confirmResult = confirmResult;
        this.pendingUploadTicket = ticket;
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      let finalResult = ticket.manifestResult || confirmResult;
      let confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
      const localManifest = this.localDocumentManifest;
      const localImageCount = Number(
        localManifest && localManifest.stats && localManifest.stats.imageCount
      ) || 0;
      if (confirmedState.requiresClientManifest && localManifest) {
        const manifestJson = JSON.stringify(localManifest);
        if (utf8ByteLength(manifestJson) > 700 * 1024) {
          const error = new Error(
            getDocumentTooLargeMessage(this.data.selectedAssetType)
          );
          error.userMessage = error.message;
          throw error;
        }
        if (!ticket.manifestRequestId) {
          ticket.manifestRequestId = adminContent.createMutationId("attach-manifest");
        }
        this.pendingClientManifest = {
          uploadId: ticket.uploadId,
          manifest: localManifest
        };
        this.pendingUploadTicket = ticket;
        this.retryStage = "manifest";
        this.setData({
          uploadStageLabel: "正在校验 Word 正文",
          uploadProgress: 100
        });
        const manifestResponse = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: {
            action: "attachClientManifest",
            uploadId: ticket.uploadId,
            requestId: ticket.manifestRequestId,
            manifest: localManifest
          }
        });
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        finalResult = manifestResponse.result || {};
        if (!finalResult.success) {
          const error = new Error(finalResult.message || "Word 正文校验失败");
          error.userMessage = finalResult.message;
          error.code = finalResult.code;
          if (finalResult.code === "UPLOAD_RESERVATION_EXPIRED") {
            error.restartReservation = true;
          }
          throw error;
        }
        ticket.manifestResult = finalResult;
        this.pendingUploadTicket = ticket;
        confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
        const awaitingClientImages = Boolean(
          confirmedState.requiresClientImages &&
          !confirmedState.canCreateDraft &&
          confirmedState.validationStatus === "awaiting_client_images"
        );
        if (
          !awaitingClientImages &&
          (
            !confirmedState.canCreateDraft ||
            confirmedState.validationStatus !== "client_manifest_validated"
          )
        ) {
          throw new Error("Word 正文尚未完成校验，请稍后重试");
        }
      }

      if (
        confirmedState.requiresClientImages &&
        !confirmedState.canCreateDraft &&
        confirmedState.validationStatus === "awaiting_client_images"
      ) {
        finalResult = await this.transferAndConfirmClientImages(
          ticket,
          localManifest,
          finalResult,
          operationId
        );
        if (
          !finalResult ||
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
      }

      if (
        localManifest &&
        (
          !confirmedState.canCreateDraft ||
          confirmedState.validationStatus !== "client_manifest_validated"
        )
      ) {
        throw new Error("Word 正文及图片尚未完成校验，请稍后重试");
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      this.retryStage = "";
      this.pendingUploadTicket = null;
      this.pendingClientManifest = null;
      this.localDocumentManifest = null;
      const prepareAnotherNewContent = Boolean(
        this.data.contentMode === "new" &&
        ["manuscript", "special-topic"].includes(this.data.selectedAssetType)
      );
      const nextRelatedId = prepareAnotherNewContent
        ? createNewTargetId(this.data.selectedAssetType)
        : relatedId;
      if (prepareAnotherNewContent) {
        this.targetSelectionConfirmed = true;
      }
      this.setData({
        selectedFile: null,
        relatedId: nextRelatedId,
        uploadProgress: 100,
        uploadStageLabel: confirmedState.canCreateDraft
          ? localManifest
            ? "正文结构校验完成，可创建内容草稿"
            : this.data.selectedAssetType === "audio"
              ? "配音上传完成，可创建内容草稿"
              : this.data.selectedAssetType === "full-book-pdf"
                ? "下载版 PDF 上传完成，可创建草稿"
                : "文件上传完成，可创建内容草稿"
          : "文件已上传，等待正文校验",
        uploadSuccess: confirmedState.canCreateDraft
          ? localManifest
            ? localImageCount > 0
              ? `Word 正文及 ${localImageCount} 张内嵌图片已校验，可创建草稿；系统不会自动发布。`
              : "Word 正文结构已校验，可创建草稿；系统不会自动发布。"
            : this.data.selectedAssetType === "audio"
              ? "配音文件已上传，可创建草稿；系统不会自动发布。"
              : this.data.selectedAssetType === "full-book-pdf"
                ? "下载版 PDF 已上传，可创建草稿并送审；系统不会自动发布。"
                : "文件已上传，可创建草稿；系统不会自动发布。"
          : "原件已经收到，完成内容解析与安全校验前不会创建草稿或自动发布。",
        uploadError: "",
        canRetry: false
      });
      await this.loadHistory({ quiet: true });
    } catch (error) {
      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }
      if (
        error &&
        (
          error.nativeErrorMessage ||
          error.nativeErrorCode ||
          error.requestId
        )
      ) {
        console.error("admin upload diagnostic:", {
          code: error.code || "",
          nativeErrorCode: error.nativeErrorCode || "",
          nativeErrorMessage: error.nativeErrorMessage || "",
          requestId: error.requestId || "",
          imageOrder: error.imageOrder || 0,
          cloudPath: error.cloudPath || "",
          temporaryFileSize: error.temporaryFileSize
        });
      }
      console.error("admin upload error:", error);

      if (error && error.restartReservation) {
        this.retryStage = "create";
        this.pendingUploadTicket = null;
      }

      if (!this.pageDestroyed && operationId === this.uploadOperationId) {
        this.setData({
          uploadError: getErrorMessage(error, "上传失败，请稍后重试。"),
          uploadStageLabel:
            this.retryStage === "manifest"
              ? "Word 正文校验未完成"
              : this.retryStage === "images"
                ? "内嵌图片上传未完成"
                : this.retryStage === "image-confirm"
                  ? "内嵌图片确认未完成"
                  : this.retryStage === "confirm"
                    ? "云端文件确认未完成"
                    : this.retryStage === "create"
                      ? "上传任务创建未完成"
                      : "云端文件上传未完成",
          canRetry: true
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.uploadOperationId) {
        this.setData({ uploading: false });
      }
    }
  },

  retryUpload() {
    if (this.data.canRetry && !this.data.uploading) {
      return this.startUpload();
    }

    return Promise.resolve();
  },

  openDraft(event) {
    const draftId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.draftId,
      32
    ).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(draftId) || typeof wx.navigateTo !== "function") {
      return;
    }
    wx.navigateTo({ url: `/pages/adminDraft/adminDraft?id=${draftId}` });
  },

  isDraftOperationActive(operationId) {
    return Boolean(
      !this.pageDestroyed &&
      this.isPageVisible === true &&
      operationId === this.draftOperationId
    );
  },

  markUploadDraftCreated(uploadId) {
    const uploads = Array.isArray(this.data.uploads)
      ? this.data.uploads
      : [];
    let changed = false;
    const nextUploads = uploads.map((upload) => {
      if (!upload || upload.uploadId !== uploadId) return upload;
      changed = true;
      return {
        ...upload,
        hasDraft: true,
        canCancel: false
      };
    });
    if (changed) {
      this.setData({ uploads: nextUploads });
    }
  },

  navigateToCreatedDraft(draftId, uploadId, operationId) {
    if (!this.isDraftOperationActive(operationId)) return false;
    this.markUploadDraftCreated(uploadId);
    const showNavigationError = () => {
      if (!this.isDraftOperationActive(operationId)) return;
      this.setData({
        historyError: "草稿已创建，但页面打开失败，请点击“打开草稿”重试。"
      });
    };
    if (typeof wx.navigateTo !== "function") {
      showNavigationError();
      return false;
    }
    try {
      wx.navigateTo({
        url: `/pages/adminDraft/adminDraft?id=${draftId}`,
        fail: showNavigationError
      });
      return true;
    } catch (error) {
      console.warn("navigate to created admin draft error:", error);
      showNavigationError();
      return false;
    }
  },

  updateHistoryUploadFromResult(uploadId, result) {
    const uploads = Array.isArray(this.data.uploads)
      ? this.data.uploads
      : [];
    const current = uploads.find((item) => item.uploadId === uploadId) || {
      uploadId
    };
    const response = result && typeof result === "object" ? result : {};
    const remote = response.upload && typeof response.upload === "object"
      ? response.upload
      : {};
    const patch = {
      ...current,
      ...remote,
      uploadId,
      status:
        normalizeText(remote.status || response.status, 48) ||
        current.status,
      validationStatus:
        normalizeText(
          remote.validationStatus || response.validationStatus,
          48
        ) || current.validationStatus,
      clientImageCount: firstNonNegativeInteger(
        remote.clientImageCount,
        response.clientImageCount,
        response.totalCount,
        current.clientImageCount
      ),
      confirmedClientImageCount: firstNonNegativeInteger(
        remote.confirmedClientImageCount,
        response.confirmedClientImageCount,
        response.confirmedCount,
        current.confirmedClientImageCount
      ),
      remainingClientImageCount: firstNonNegativeInteger(
        remote.remainingClientImageCount,
        response.remainingClientImageCount,
        response.remainingCount,
        current.remainingClientImageCount
      ),
      cleanupRequired:
        typeof remote.cleanupRequired === "boolean"
          ? remote.cleanupRequired
          : typeof response.cleanupRequired === "boolean"
            ? response.cleanupRequired
            : current.cleanupRequired === true,
      cleanupRemainingCount: firstNonNegativeInteger(
        remote.cleanupRemainingCount,
        response.cleanupRemainingCount,
        response.remainingCleanupCount,
        current.cleanupRemainingCount
      )
    };
    if (
      remote.cleanupRequired === false ||
      response.cleanupRequired === false
    ) {
      patch.cleanupRemainingCount = 0;
    }
    const normalized = normalizeUpload(patch);

    if (!normalized) {
      return current;
    }
    normalized.hasDraft = current.hasDraft === true;
    if (
      response.canCreateDraft === true ||
      remote.canCreateDraft === true
    ) {
      normalized.canCreateDraft = true;
      normalized.canResumeClientImages = false;
    }
    const nextUploads = uploads.map((item) =>
      item.uploadId === uploadId ? normalized : item
    );
    if (!nextUploads.some((item) => item.uploadId === uploadId)) {
      nextUploads.unshift(normalized);
    }
    this.setData({ uploads: nextUploads });
    return normalized;
  },

  async resumeClientImages(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.resumingClientImagesId ||
      this.data.cancelingUploadId ||
      this.data.cleaningUpUploadId
    ) {
      return;
    }

    const operationId = (this.resumeClientImagesOperationId || 0) + 1;
    this.resumeClientImagesOperationId = operationId;
    this.setData({
      resumingClientImagesId: uploadId,
      historyError: ""
    });
    let completed = false;
    let previousSignature = "";
    let stalledRounds = 0;

    try {
      for (
        let round = 0;
        round < CLIENT_IMAGE_RESUME_MAX_ROUNDS;
        round += 1
      ) {
        const requestData = {
          action: "resumeClientImages",
          uploadId,
          requestId: adminContent.createMutationId("resume-images")
        };
        const result = await this.callAdminContentWithRetry(requestData, {
          fallback: "图片确认暂时中断，请稍后重试",
          isActive: () =>
            !this.pageDestroyed &&
            this.isPageVisible &&
            operationId === this.resumeClientImagesOperationId
        });
        if (
          !result ||
          this.pageDestroyed ||
          operationId !== this.resumeClientImagesOperationId
        ) {
          return;
        }
        const upload = this.updateHistoryUploadFromResult(uploadId, result);
        const validationStatus = normalizeText(
          upload && upload.validationStatus,
          48
        ).toLowerCase();
        completed = Boolean(
          result.complete === true ||
          result.canCreateDraft === true ||
          upload && upload.canCreateDraft === true ||
          validationStatus === "client_manifest_validated" ||
          upload &&
            upload.clientImageProgressKnown === true &&
            upload.clientImageCount > 0 &&
            upload.remainingClientImageCount === 0
        );
        if (completed) {
          break;
        }

        const signature = [
          upload && upload.clientImageCount,
          upload && upload.confirmedClientImageCount,
          upload && upload.remainingClientImageCount,
          validationStatus
        ].join(":");
        if (signature === previousSignature) {
          stalledRounds += 1;
        } else {
          previousSignature = signature;
          stalledRounds = 0;
        }
        if (stalledRounds >= 2) {
          throw new Error("图片确认进度没有更新，请稍后再试");
        }
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }

      if (!completed) {
        throw new Error("本轮已确认较多图片，请再次点击继续确认");
      }
      await this.loadHistory({ quiet: true, append: false });
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId &&
        typeof wx.showToast === "function"
      ) {
        wx.showToast({ title: "图片确认完成", icon: "success" });
      }
    } catch (error) {
      console.error("resume client images error:", error);
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(
            error,
            "图片确认暂时中断，请稍后重试。"
          )
        });
      }
    } finally {
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId
      ) {
        this.setData({ resumingClientImagesId: "" });
      }
    }
  },

  async runCanceledUploadCleanup(
    uploadId,
    { quiet = false, maximumRounds = 20 } = {}
  ) {
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      this.data.cleaningUpUploadId
    ) {
      return false;
    }
    const operationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId = operationId;
    this.setData({
      cleaningUpUploadId: uploadId,
      historyError: quiet ? this.data.historyError : ""
    });
    let completed = false;

    try {
      for (let round = 0; round < maximumRounds; round += 1) {
        const result = await this.callAdminContentWithRetry(
          {
            action: "cleanupCanceledUpload",
            uploadId,
            requestId: adminContent.createMutationId("cleanup-upload")
          },
          {
            fallback: "取消任务的云文件尚未清理完成",
            isActive: () =>
              !this.pageDestroyed &&
              this.isPageVisible &&
              operationId === this.cleanupCanceledUploadOperationId,
            maximumRetries: 1
          }
        );
        if (!result) {
          return false;
        }
        const upload = this.updateHistoryUploadFromResult(uploadId, result);
        const remaining = firstNonNegativeInteger(
          result.cleanupRemainingCount,
          result.remainingCleanupCount,
          upload && upload.cleanupRemainingCount
        );
        completed = Boolean(
          result.complete === true ||
          result.cleanupRequired === false ||
          upload && upload.cleanupRequired === false ||
          remaining === 0
        );
        if (completed) {
          break;
        }
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }
      await this.loadHistory({ quiet: true, append: false });
      if (
        completed &&
        !quiet &&
        typeof wx.showToast === "function"
      ) {
        wx.showToast({ title: "云文件清理完成", icon: "success" });
      }
      return completed;
    } catch (error) {
      console.warn("cleanup canceled admin upload error:", error);
      if (
        !quiet &&
        !this.pageDestroyed &&
        operationId === this.cleanupCanceledUploadOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(
            error,
            "云文件尚未清理完成，请稍后重试。"
          )
        });
      }
      return false;
    } finally {
      if (
        !this.pageDestroyed &&
        operationId === this.cleanupCanceledUploadOperationId
      ) {
        this.setData({ cleaningUpUploadId: "" });
      }
    }
  },

  continueCanceledUploadCleanup(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    return this.runCanceledUploadCleanup(uploadId);
  },

  async reconcileCreatedDraft(uploadId, operationId) {
    try {
      const result = await this.callAdminContentWithRetry(
        {
          action: "getDraft",
          draftId: uploadId
        },
        {
          maximumRetries: 1,
          fallback: "草稿创建结果核对失败",
          isActive: () => this.isDraftOperationActive(operationId)
        }
      );
      if (!result || !this.isDraftOperationActive(operationId)) return null;
      const draft = adminContent.normalizeDraft(result.draft);
      return draft && draft.id === uploadId ? draft : null;
    } catch (error) {
      const code = normalizeText(
        error && (error.code || error.errCode),
        80
      ).toUpperCase();
      if (code !== "DRAFT_NOT_FOUND") {
        console.warn("reconcile admin draft error:", error);
      }
      return null;
    }
  },

  async createOrOpenDraft(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.creatingDraftId
    ) {
      return;
    }
    if (!this.draftMutationIds[uploadId]) {
      this.draftMutationIds[uploadId] = adminContent.createMutationId("create-draft");
    }
    const operationId = (this.draftOperationId || 0) + 1;
    this.draftOperationId = operationId;
    this.setData({ creatingDraftId: uploadId, historyError: "" });
    try {
      const result = await this.callAdminContentWithRetry(
        {
          action: "createDraftFromUpload",
          uploadId,
          requestId: this.draftMutationIds[uploadId]
        },
        {
          fallback: "创建草稿失败",
          isActive: () => this.isDraftOperationActive(operationId)
        }
      );
      if (!result) return;
      if (!this.isDraftOperationActive(operationId)) return;
      const draft = adminContent.normalizeDraft(result.draft);
      if (!draft || draft.id !== uploadId) {
        throw new Error("服务端返回的草稿状态无效");
      }
      delete this.draftMutationIds[uploadId];
      this.navigateToCreatedDraft(draft.id, uploadId, operationId);
    } catch (error) {
      console.error("create admin draft error:", error);
      let reconciledDraft = null;
      const retryable = isRetryableAdminContentError(error);
      if (retryable) {
        reconciledDraft = await this.reconcileCreatedDraft(uploadId, operationId);
      } else {
        delete this.draftMutationIds[uploadId];
      }
      if (
        reconciledDraft &&
        this.isDraftOperationActive(operationId)
      ) {
        delete this.draftMutationIds[uploadId];
        this.navigateToCreatedDraft(
          reconciledDraft.id,
          uploadId,
          operationId
        );
        return;
      }
      if (this.isDraftOperationActive(operationId)) {
        this.setData({
          historyError: retryable
            ? "创建结果暂未确认，已保留本次请求；请稍后点击“创建草稿”继续核对。"
            : getErrorMessage(error, "创建草稿失败，请稍后重试。")
        });
      }
    } finally {
      if (this.isDraftOperationActive(operationId)) {
        this.setData({ creatingDraftId: "" });
      }
    }
  },

  async cancelUpload(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.cancelingUploadId ||
      this.data.resumingClientImagesId ||
      this.data.cleaningUpUploadId
    ) {
      return;
    }
    const confirmed = await confirmModal(
      "取消上传任务",
      "未绑定草稿的原件会进入安全清理流程，取消后不能恢复。",
      "取消任务"
    );
    if (!confirmed) return;
    const operationId = (this.cancelOperationId || 0) + 1;
    this.cancelOperationId = operationId;
    this.setData({ cancelingUploadId: uploadId, historyError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "cancelUpload", uploadId }
      });
      const result = response.result || {};
      if (this.pageDestroyed || operationId !== this.cancelOperationId) return;
      if (!result.success) {
        throw createAdminContentError(result, "取消上传失败");
      }
      const canceledFromResponse = this.updateHistoryUploadFromResult(
        uploadId,
        {
          ...result,
          status: "canceled",
          upload: {
            ...(result.upload && typeof result.upload === "object"
              ? result.upload
              : {}),
            status: "canceled"
          }
        }
      );
      const refreshed = await this.loadHistory({
        quiet: true,
        append: false
      });
      const canceledUpload = (
        Array.isArray(refreshed) ? refreshed : this.data.uploads
      ).find((item) => item.uploadId === uploadId) ||
        canceledFromResponse ||
        null;
      if (
        canceledUpload &&
        canceledUpload.status === "canceled" &&
        canceledUpload.cleanupRequired
      ) {
        this.runCanceledUploadCleanup(uploadId, {
          quiet: true,
          maximumRounds: 10
        });
      }
    } catch (error) {
      console.error("cancel admin upload error:", error);
      let canceledAfterRefresh = false;
      let refreshedUpload = null;
      if (
        isRetryableAdminContentError(error) &&
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        const refreshed = await this.loadHistory({
          quiet: true,
          append: false
        });
        refreshedUpload = (
          Array.isArray(refreshed) ? refreshed : this.data.uploads
        ).find((item) => item.uploadId === uploadId) || null;
        canceledAfterRefresh = Boolean(
          refreshedUpload && refreshedUpload.status === "canceled"
        );
      }
      if (
        canceledAfterRefresh &&
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        this.setData({ historyError: "" });
        if (typeof wx.showToast === "function") {
          wx.showToast({ title: "任务已取消", icon: "success" });
        }
        if (refreshedUpload.cleanupRequired) {
          this.runCanceledUploadCleanup(uploadId, {
            quiet: true,
            maximumRounds: 10
          });
        }
      } else if (
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(error, "取消上传失败，请稍后重试。")
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.cancelOperationId) {
        this.setData({ cancelingUploadId: "" });
      }
    }
  },

  uploadCloudFile(ticket, operationId) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || typeof wx.cloud.uploadFile !== "function") {
        reject(new Error("当前微信版本不支持文件上传，请更新微信后重试"));
        return;
      }

      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handler(value);
      };
      const fail = (error) => {
        console.error("cloud storage upload raw error:", error);
        const failure = wrapCloudUploadError(error);
        finish(reject, failure);
      };
      let task = null;

      try {
        task = wx.cloud.uploadFile({
          cloudPath: ticket.cloudPath,
          filePath: ticket.filePath,
          success: (result) => finish(resolve, result),
          fail
        });
      } catch (error) {
        fail(error);
        return;
      }

      this.uploadTask = task;

      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((progressResult) => {
          if (
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
          ) {
            const progress = Math.max(
              0,
              Math.min(100, Math.round(Number(progressResult.progress) || 0))
            );
            this.setData({ uploadProgress: progress });
          }
        });
      }

      if (task && typeof task.then === "function") {
        task.then(
          (result) => finish(resolve, result),
          fail
        );
      }
    }).finally(() => {
      this.uploadTask = null;
    });
  },

  uploadFile(ticket, operationId) {
    return new Promise((resolve, reject) => {
      if (typeof wx.uploadFile !== "function") {
        reject(new Error("当前微信版本不支持安全文件上传"));
        return;
      }

      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handler(value);
      };
      let task = null;

      try {
        task = wx.uploadFile({
          url: ticket.brokerUrl,
          filePath: ticket.filePath,
          name: ticket.fieldName,
          header: {
            Authorization: `Bearer ${ticket.brokerTicket}`
          },
          success: (result) => finish(resolve, result),
          fail: (error) => finish(reject, error)
        });
      } catch (error) {
        finish(reject, error);
        return;
      }

      this.uploadTask = task;

      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((progressResult) => {
          if (
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
          ) {
            const progress = Math.max(
              0,
              Math.min(100, Math.round(Number(progressResult.progress) || 0))
            );
            this.setData({ uploadProgress: progress });
          }
        });
      }

      if (task && typeof task.then === "function") {
        task.then(
          (result) => finish(resolve, result),
          (error) => finish(reject, error)
        );
      }
    }).finally(() => {
      this.uploadTask = null;
    });
  }
});
