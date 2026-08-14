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

module.exports = {
  ADMIN_ENTRY_CARDS,
  ASSET_EXTENSIONS,
  ASSET_TYPES,
  AUDIO_DURATION_TIMEOUT_MS,
  CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS,
  CLIENT_IMAGE_CONFIRM_MAX_RETRIES,
  CLIENT_IMAGE_CONFIRM_RETRY_BASE_MS,
  CLIENT_IMAGE_RESUME_MAX_ROUNDS,
  DEFAULT_BOOK_TARGETS,
  PORTAL_ROLES,
  REVIEW_STATUS_LABELS,
  STATUS_LABELS,
  allowedFileHint,
  buildBookTargets,
  createAdminContentError,
  createClientManifest,
  createNewTargetId,
  createRandomHex32,
  firstNonNegativeInteger,
  formatFileSize,
  formatTime,
  getAssetLabel,
  getConfirmedUploadState,
  getDirectCloudCapability,
  getDocumentImportLimits,
  getDocumentTooLargeMessage,
  getErrorMessage,
  getFileDisplayType,
  getPdfReadiness,
  getUploadMode,
  hasUploadAccess,
  getUploadRole,
  inferMimeType,
  isAllowedFile,
  isCancelError,
  isDirectCloudMode,
  isRetryableAdminContentError,
  isSafeDirectCloudPath,
  isStableTargetId,
  normalizeClientImageProgress,
  normalizeClientImageUploadPlan,
  normalizeCloudFileID,
  normalizeDirectCloudTransport,
  normalizeBrokerTransport,
  normalizeText,
  normalizeUpload,
  normalizeUploadTargets,
  normalizeUploads,
  parseBrokerUploadResult,
  targetTypeForAsset,
  toSafeInteger,
  utf8ByteLength,
  withPublicDraftTitle,
  wrapBookTitle,
  wrapCloudUploadError
};
