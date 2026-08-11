const {
  normalizePackageTarget,
  readDocxImage
} = require("./docxImport");

const MAX_DOCX_IMAGES = 200;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const DEFAULT_CONFIRM_BATCH_SIZE = 20;
const SAFE_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp"
]);

let temporaryFileSequence = 0;

function transferError(code, message, cause, details) {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  if (cause) {
    error.cause = cause;
  }
  if (details && typeof details === "object") {
    Object.assign(error, details);
  }
  return error;
}

function normalizeExtension(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const extension = raw && raw[0] === "." ? raw : raw ? `.${raw}` : "";
  return SAFE_IMAGE_EXTENSIONS.has(extension) ? extension : "";
}

function packageExtension(value) {
  const path = String(value || "").toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function validatePackagePath(value, label) {
  const packagePath = typeof value === "string" ? value.trim() : "";
  const normalized = normalizePackageTarget("", packagePath);
  const extension = packageExtension(packagePath);

  if (
    !packagePath ||
    packagePath !== value ||
    normalized !== packagePath ||
    !packagePath.startsWith("word/media/") ||
    !SAFE_IMAGE_EXTENSIONS.has(extension)
  ) {
    throw transferError(
      "DOCX_IMAGE_PLAN_INVALID",
      `${label}中的 Word 图片信息无效，请重新选择文稿`,
      null,
      { field: "packagePath" }
    );
  }

  return { extension, packagePath };
}

function validateOrder(value, label) {
  const imageOrder = Number(value);
  if (
    !Number.isInteger(imageOrder) ||
    imageOrder < 1 ||
    imageOrder > MAX_DOCX_IMAGES
  ) {
    throw transferError(
      "DOCX_IMAGE_PLAN_INVALID",
      `${label}中的图片顺序无效，请重新选择文稿`,
      null,
      { field: "order" }
    );
  }
  return imageOrder;
}

function resolveImageOrder(rawItem, label, conflictCode) {
  const hasImageOrder =
    Object.prototype.hasOwnProperty.call(rawItem, "imageOrder") &&
    rawItem.imageOrder !== undefined &&
    rawItem.imageOrder !== null &&
    rawItem.imageOrder !== "";
  const hasLegacyOrder =
    Object.prototype.hasOwnProperty.call(rawItem, "order") &&
    rawItem.order !== undefined &&
    rawItem.order !== null &&
    rawItem.order !== "";

  if (
    hasImageOrder &&
    hasLegacyOrder &&
    Number(rawItem.imageOrder) !== Number(rawItem.order)
  ) {
    throw transferError(
      conflictCode || "DOCX_IMAGE_PLAN_INVALID",
      `${label}的图片顺序前后不一致，请重新选择文稿`
    );
  }
  return validateOrder(
    hasImageOrder ? rawItem.imageOrder : rawItem.order,
    label
  );
}

function validateManifestImages(images) {
  if (!Array.isArray(images)) {
    throw transferError(
      "DOCX_IMAGE_PLAN_INVALID",
      "没有读到 Word 图片清单，请重新选择文稿"
    );
  }
  if (images.length > MAX_DOCX_IMAGES) {
    throw transferError(
      "DOCX_IMAGE_LIMIT_EXCEEDED",
      `单个 Word 文稿最多可导入 ${MAX_DOCX_IMAGES} 张图片，请拆分文稿后重试`
    );
  }

  const byPath = new Map();
  const byOrder = new Map();

  images.forEach((rawImage, index) => {
    const label = `第 ${index + 1} 张图片`;
    if (!rawImage || typeof rawImage !== "object" || Array.isArray(rawImage)) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        `${label}的信息不完整，请重新选择文稿`
      );
    }

    const imageOrder = resolveImageOrder(
      rawImage,
      label,
      "DOCX_IMAGE_PLAN_INVALID"
    );
    const packageResult = validatePackagePath(rawImage.packagePath, label);
    const extension = normalizeExtension(rawImage.extension);
    if (!extension || extension !== packageResult.extension) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        `${label}的图片格式不受支持，请在 Word 中改为 JPG、PNG、GIF 或 WEBP`,
        null,
        { field: "extension", imageOrder }
      );
    }

    const normalized = {
      imageOrder,
      packagePath: packageResult.packagePath,
      extension
    };
    const existingPath = byPath.get(normalized.packagePath);
    const existingOrder = byOrder.get(imageOrder);

    if (
      (existingPath &&
        (
          existingPath.imageOrder !== imageOrder ||
          existingPath.extension !== extension
        )) ||
      (existingOrder && existingOrder.packagePath !== normalized.packagePath)
    ) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        "Word 图片清单存在冲突，请重新选择文稿"
      );
    }

    if (!existingPath) {
      byPath.set(normalized.packagePath, normalized);
      byOrder.set(imageOrder, normalized);
    }
  });

  const uniqueImages = Array.from(byPath.values()).sort(
    (left, right) => left.imageOrder - right.imageOrder
  );
  uniqueImages.forEach((image, index) => {
    if (image.imageOrder !== index + 1) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        "Word 图片顺序不连续，请重新选择文稿"
      );
    }
  });
  return uniqueImages;
}

function validateCloudPath(value, extension, label) {
  const cloudPath = typeof value === "string" ? value.trim() : "";
  const parts = cloudPath.split("/");
  if (
    !cloudPath ||
    cloudPath !== value ||
    cloudPath.length > 512 ||
    cloudPath[0] === "/" ||
    /[\s\\\u0000-\u001f\u007f?#]/.test(cloudPath) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    packageExtension(cloudPath) !== extension
  ) {
    throw transferError(
      "DOCX_IMAGE_PLAN_INVALID",
      `${label}的云端保存位置无效，请刷新后重试`,
      null,
      { field: "cloudPath" }
    );
  }
  return cloudPath;
}

function validateUploadPlan(images, uploadPlan) {
  if (!Array.isArray(uploadPlan)) {
    throw transferError(
      "DOCX_IMAGE_PLAN_INVALID",
      "图片上传准备尚未完成，请刷新后重试"
    );
  }
  if (uploadPlan.length > MAX_DOCX_IMAGES) {
    throw transferError(
      "DOCX_IMAGE_LIMIT_EXCEEDED",
      `单个 Word 文稿最多可导入 ${MAX_DOCX_IMAGES} 张图片，请拆分文稿后重试`
    );
  }
  if (uploadPlan.length !== images.length) {
    throw transferError(
      "DOCX_IMAGE_PLAN_MISMATCH",
      "图片上传清单与 Word 文稿不一致，请重新选择文稿"
    );
  }

  const imageByOrder = new Map(
    images.map((image) => [image.imageOrder, image])
  );
  const seenOrders = new Set();
  const seenCloudPaths = new Set();

  const normalizedPlan = uploadPlan.map((rawItem, index) => {
    const label = `第 ${index + 1} 个上传位置`;
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        `${label}的信息不完整，请刷新后重试`
      );
    }

    const imageOrder = resolveImageOrder(
      rawItem,
      label,
      "DOCX_IMAGE_PLAN_MISMATCH"
    );
    const packageResult = validatePackagePath(rawItem.packagePath, label);
    const extension = normalizeExtension(rawItem.extension);
    const manifestImage = imageByOrder.get(imageOrder);

    if (
      !extension ||
      extension !== packageResult.extension ||
      !manifestImage ||
      manifestImage.packagePath !== packageResult.packagePath ||
      manifestImage.extension !== extension
    ) {
      throw transferError(
        "DOCX_IMAGE_PLAN_MISMATCH",
        "图片上传清单与 Word 文稿不一致，请重新选择文稿",
        null,
        { imageOrder }
      );
    }

    const cloudPath = validateCloudPath(rawItem.cloudPath, extension, label);
    if (
      seenOrders.has(imageOrder) ||
      seenCloudPaths.has(cloudPath)
    ) {
      throw transferError(
        "DOCX_IMAGE_PLAN_INVALID",
        "图片上传位置有重复，请刷新后重试"
      );
    }
    seenOrders.add(imageOrder);
    seenCloudPaths.add(cloudPath);

    return {
      imageOrder,
      packagePath: manifestImage.packagePath,
      extension,
      cloudPath
    };
  });

  return normalizedPlan.sort(
    (left, right) => left.imageOrder - right.imageOrder
  );
}

function isArrayBuffer(value) {
  return (
    value &&
    (
      Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
      (
        typeof ArrayBuffer !== "undefined" &&
        value instanceof ArrayBuffer
      )
    )
  );
}

function toArrayBuffer(value) {
  let source = null;
  if (isArrayBuffer(value)) {
    source = new Uint8Array(value);
  } else if (
    typeof ArrayBuffer !== "undefined" &&
    typeof ArrayBuffer.isView === "function" &&
    ArrayBuffer.isView(value)
  ) {
    source = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
  }
  if (source) {
    const localCopy = new Uint8Array(source.byteLength);
    localCopy.set(source);
    return localCopy.buffer;
  }
  throw transferError(
    "DOCX_IMAGE_EXTRACT_FAILED",
    "Word 中有一张图片无法读取，请重新保存文稿后重试"
  );
}

function callbackOperation(invoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      handler(value);
    };

    let returned;
    try {
      returned = invoke(
        (result) => finish(resolve, result),
        (error) => finish(reject, error)
      );
    } catch (error) {
      finish(reject, error);
      return;
    }

    if (returned && typeof returned.then === "function") {
      returned.then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error)
      );
    }
  });
}

function writeTemporaryFile(fileSystem, filePath, data) {
  return callbackOperation((success, fail) =>
    fileSystem.writeFile({ filePath, data, success, fail })
  );
}

function statTemporaryFile(fileSystem, filePath) {
  if (!fileSystem || typeof fileSystem.stat !== "function") {
    return Promise.resolve(null);
  }
  return callbackOperation((success, fail) =>
    fileSystem.stat({ path: filePath, success, fail })
  );
}

function temporaryFileSize(result) {
  const stats = result && (result.stats || result.stat || result);
  const size = Number(stats && stats.size);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function unlinkTemporaryFile(fileSystem, filePath) {
  return callbackOperation((success, fail) =>
    fileSystem.unlink({ filePath, success, fail })
  );
}

function cancellationRequested(source) {
  if (!source) {
    return false;
  }
  try {
    if (typeof source === "function") {
      return Boolean(source());
    }
    if (typeof source.isCancelled === "function") {
      return Boolean(source.isCancelled());
    }
    return Boolean(source.cancelled || source.aborted);
  } catch (error) {
    return false;
  }
}

function subscribeCancellation(source, listener) {
  if (!source || typeof source === "function") {
    return () => {};
  }
  if (typeof source.subscribe === "function") {
    const unsubscribe = source.subscribe(listener);
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
  if (typeof source.onCancel === "function") {
    const unsubscribe = source.onCancel(listener);
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
  if (typeof source.addEventListener === "function") {
    source.addEventListener("abort", listener);
    return () => {
      if (typeof source.removeEventListener === "function") {
        source.removeEventListener("abort", listener);
      }
    };
  }
  return () => {};
}

function cancelledError() {
  return transferError(
    "DOCX_IMAGE_UPLOAD_CANCELLED",
    "Word 图片上传已取消"
  );
}

function createCancellationController() {
  let cancelled = false;
  const listeners = new Set();
  const token = {
    get cancelled() {
      return cancelled;
    },
    isCancelled() {
      return cancelled;
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      if (cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };

  return {
    token,
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      Array.from(listeners).forEach((listener) => {
        try {
          listener();
        } catch (error) {
          // A caller callback must not prevent the remaining uploads from stopping.
        }
      });
      listeners.clear();
    }
  };
}

function temporaryFilePath(userDataPath, extension) {
  temporaryFileSequence += 1;
  const root = String(userDataPath || "").replace(/\/+$/, "");
  const nonce = Math.floor(Math.random() * 0x100000000).toString(36);
  return `${root}/docx-image-${Date.now()}-${temporaryFileSequence}-${nonce}${extension}`;
}

function normalizeCloudFileID(value, cloudPath) {
  const fileID = typeof value === "string" ? value.trim() : "";
  if (
    !fileID ||
    fileID !== value ||
    fileID.length > 2048 ||
    !fileID.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f\u007f]/.test(fileID)
  ) {
    throw transferError(
      "DOCX_IMAGE_FILE_ID_INVALID",
      "图片已上传但云端回执无效，请刷新上传记录后重试"
    );
  }

  const separator = fileID.indexOf("/", "cloud://".length);
  const environment =
    separator > "cloud://".length
      ? fileID.slice("cloud://".length, separator)
      : "";
  const returnedPath = separator >= 0 ? fileID.slice(separator + 1) : "";
  if (!environment || returnedPath !== cloudPath) {
    throw transferError(
      "DOCX_IMAGE_FILE_ID_INVALID",
      "图片上传回执与保存位置不一致，请刷新后重试"
    );
  }
  return fileID;
}

function validateExistingFiles(plan, existingFiles) {
  if (existingFiles === undefined || existingFiles === null) {
    return [];
  }
  if (!Array.isArray(existingFiles) || existingFiles.length > plan.length) {
    throw transferError(
      "DOCX_IMAGE_RESUME_INVALID",
      "图片续传记录无效，请刷新上传记录后重试"
    );
  }

  const planByOrder = new Map(
    plan.map((item) => [item.imageOrder, item])
  );
  const seenOrders = new Set();
  return existingFiles
    .map((rawFile, index) => {
      const label = `第 ${index + 1} 条续传记录`;
      if (
        !rawFile ||
        typeof rawFile !== "object" ||
        Array.isArray(rawFile)
      ) {
        throw transferError(
          "DOCX_IMAGE_RESUME_INVALID",
          `${label}无效，请刷新上传记录后重试`
        );
      }

      let imageOrder;
      try {
        imageOrder = resolveImageOrder(
          rawFile,
          label,
          "DOCX_IMAGE_RESUME_INVALID"
        );
      } catch (error) {
        if (error && error.code === "DOCX_IMAGE_PLAN_INVALID") {
          error.code = "DOCX_IMAGE_RESUME_INVALID";
        }
        throw error;
      }
      const planned = planByOrder.get(imageOrder);
      const extension = normalizeExtension(rawFile.extension);
      const packagePath =
        typeof rawFile.packagePath === "string"
          ? rawFile.packagePath
          : "";
      const cloudPath =
        typeof rawFile.cloudPath === "string" ? rawFile.cloudPath : "";

      if (
        !planned ||
        seenOrders.has(imageOrder) ||
        packagePath !== planned.packagePath ||
        extension !== planned.extension ||
        cloudPath !== planned.cloudPath
      ) {
        throw transferError(
          "DOCX_IMAGE_RESUME_INVALID",
          "图片续传记录与本次 Word 文稿不一致，请重新选择文稿"
        );
      }
      seenOrders.add(imageOrder);
      return {
        imageOrder,
        packagePath: planned.packagePath,
        extension: planned.extension,
        cloudPath: planned.cloudPath,
        fileID: normalizeCloudFileID(rawFile.fileID, planned.cloudPath)
      };
    })
    .sort((left, right) => left.imageOrder - right.imageOrder);
}

function uploadCloudFile(runtimeWx, descriptor, onTask) {
  return callbackOperation((success, fail) => {
    const task = runtimeWx.cloud.uploadFile({
      cloudPath: descriptor.cloudPath,
      filePath: descriptor.filePath,
      success,
      fail
    });
    onTask(task);
    return task;
  });
}

function nativeErrorField(error, fields) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (
      (typeof current === "object" || typeof current === "function") &&
      !visited.has(current)
    ) {
      visited.add(current);
      for (const field of fields) {
        const value = current[field];
        if (
          (typeof value === "string" && value.trim()) ||
          typeof value === "number"
        ) {
          return String(value).trim();
        }
      }
      current = current.cause || current.originalError || null;
    } else {
      break;
    }
  }
  return "";
}

function cloudUploadStageError(error, item, details) {
  const nativeErrorMessage = nativeErrorField(
    error,
    ["errMsg", "message"]
  ).slice(0, 300);
  const nativeErrorCode = nativeErrorField(
    error,
    ["errCode", "code", "statusCode", "status"]
  ).slice(0, 80);
  const requestId = nativeErrorField(
    error,
    ["requestId", "requestID", "traceId", "traceID"]
  ).slice(0, 160);
  const searchable = `${nativeErrorCode} ${nativeErrorMessage}`.toLowerCase();
  const suffix = nativeErrorCode ? `（错误码 ${nativeErrorCode}）` : "";
  let message;

  if (/cancel|abort/.test(searchable)) {
    return cancelledError();
  }
  if (
    /no access right|storage_exceed_authority|-503002/.test(searchable) ||
    /permission|forbidden|unauthorized|auth(?:entication)?\s*fail|denied|-501023|权限|无权/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片被云存储拒绝，请检查云存储写入权限${suffix}`;
  } else if (
    /quota|storage.*full|insufficient.*space|no space|额度|空间不足/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片无法写入：云存储免费额度或空间不足${suffix}`;
  } else if (
    /enoent|no such file|file.*not found|invalid file path|file.*expired|临时文件.*(?:失效|不存在)/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片的本地临时文件已失效，请重新选择 Word 后重试${suffix}`;
  } else if (
    /invalid[_\s-]*file[_\s-]*name|invalid.*cloud.*path|illegal.*file.*name/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片的云存储路径被拒绝${suffix}`;
  } else if (
    /exceed.*(?:file|upload).*size|file.*too.*large|entity too large|文件.*(?:过大|超过.*限制)/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片超过当前云存储单文件限制${suffix}`;
  } else if (
    /network|timeout|timed out|storage_request_fail|socket|dns|offline|连接/.test(
      searchable
    )
  ) {
    message = `第 ${item.imageOrder} 张图片连接云存储失败，请稍后重试${suffix}`;
  } else {
    const nativeSummary = nativeErrorMessage
      ? `：${nativeErrorMessage.slice(0, 100)}`
      : suffix;
    message = `第 ${item.imageOrder} 张图片未能写入云存储${nativeSummary}`;
  }

  return transferError(
    "DOCX_IMAGE_UPLOAD_FAILED",
    message,
    error,
    {
      ...details,
      nativeErrorMessage,
      nativeErrorCode,
      requestId
    }
  );
}

function wrapStageError(error, stage, item, context = {}) {
  if (
    error &&
    (
      error.code === "DOCX_IMAGE_UPLOAD_CANCELLED" ||
      error.code === "DOCX_IMAGE_FILE_ID_INVALID" ||
      error.code === "DOCX_IMAGE_TEMP_CLEANUP_FAILED" ||
      error.code === "DOCX_IMAGE_TEMP_VERIFY_FAILED"
    )
  ) {
    return error;
  }

  const details = {
    imageOrder: item.imageOrder,
    packagePath: item.packagePath,
    cloudPath: item.cloudPath,
    temporaryFileSize:
      Number.isFinite(context.temporaryFileSize)
        ? context.temporaryFileSize
        : null
  };
  if (stage === "extract") {
    return transferError(
      "DOCX_IMAGE_EXTRACT_FAILED",
      `Word 中第 ${item.imageOrder} 张图片无法读取，请重新保存文稿后重试`,
      error,
      details
    );
  }
  if (stage === "write") {
    return transferError(
      "DOCX_IMAGE_TEMP_WRITE_FAILED",
      `第 ${item.imageOrder} 张图片暂存失败，请清理微信缓存空间后重试`,
      error,
      details
    );
  }
  return transferError(
    "DOCX_IMAGE_UPLOAD_FAILED",
    `第 ${item.imageOrder} 张图片上传中断，请检查网络后重试`,
    error,
    details
  );
}

function wrapTransferStageError(error, stage, item, context = {}) {
  if (
    stage === "upload" &&
    !(
      error &&
      (
        error.code === "DOCX_IMAGE_UPLOAD_CANCELLED" ||
        error.code === "DOCX_IMAGE_FILE_ID_INVALID" ||
        error.code === "DOCX_IMAGE_TEMP_CLEANUP_FAILED"
      )
    )
  ) {
    return cloudUploadStageError(
      error,
      item,
      {
        imageOrder: item.imageOrder,
        packagePath: item.packagePath,
        cloudPath: item.cloudPath,
        temporaryFileSize:
          Number.isFinite(context.temporaryFileSize)
            ? context.temporaryFileSize
            : null
      }
    );
  }
  return wrapStageError(error, stage, item, context);
}

function safeProgress(callback, event) {
  if (typeof callback !== "function") {
    return;
  }
  try {
    callback(event);
  } catch (error) {
    // Display callbacks are advisory and must never break the data transfer.
  }
}

function normalizedConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(number))
  );
}

function chunkDocxImageFiles(files, batchSize = DEFAULT_CONFIRM_BATCH_SIZE) {
  if (!Array.isArray(files)) {
    throw transferError(
      "DOCX_IMAGE_CONFIRM_BATCH_INVALID",
      "图片确认清单无效，请刷新后重试"
    );
  }
  const requestedSize = Number(batchSize);
  const size =
    Number.isInteger(requestedSize) &&
    requestedSize >= 1 &&
    requestedSize <= DEFAULT_CONFIRM_BATCH_SIZE
      ? requestedSize
      : DEFAULT_CONFIRM_BATCH_SIZE;
  const batches = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
}

async function transferDocxImages(options = {}) {
  const filePath =
    typeof options.filePath === "string" ? options.filePath.trim() : "";
  if (!filePath || filePath !== options.filePath) {
    throw transferError(
      "DOCX_IMAGE_INPUT_INVALID",
      "没有找到待处理的 Word 文稿，请重新选择文件"
    );
  }

  const images = validateManifestImages(options.images);
  const plan = validateUploadPlan(images, options.uploadPlan);
  const total = plan.length;
  const existingFiles = validateExistingFiles(plan, options.existingFiles);
  const existingOrders = new Set(
    existingFiles.map((file) => file.imageOrder)
  );
  const pendingPlan = plan.filter(
    (item) => !existingOrders.has(item.imageOrder)
  );
  const pendingTotal = pendingPlan.length;
  const progress = options.onProgress;

  safeProgress(progress, {
    phase: "start",
    completed: existingFiles.length,
    total,
    percent: total
      ? Math.round((existingFiles.length / total) * 100)
      : 100
  });
  if (total === 0) {
    safeProgress(progress, {
      phase: "complete",
      completed: 0,
      total: 0,
      percent: 100
    });
    return { files: [], total: 0, confirmationBatches: [] };
  }
  if (pendingTotal === 0) {
    safeProgress(progress, {
      phase: "complete",
      completed: total,
      total,
      percent: 100
    });
    return {
      files: existingFiles,
      total,
      confirmationBatches: chunkDocxImageFiles(existingFiles)
    };
  }

  const runtimeWx =
    options.wx || (typeof wx !== "undefined" ? wx : null);
  const fileSystem =
    options.fileSystem ||
    (
      runtimeWx &&
      typeof runtimeWx.getFileSystemManager === "function"
        ? runtimeWx.getFileSystemManager()
        : null
    );
  const userDataPath =
    runtimeWx &&
    runtimeWx.env &&
    typeof runtimeWx.env.USER_DATA_PATH === "string"
      ? runtimeWx.env.USER_DATA_PATH
      : "";

  if (
    !runtimeWx ||
    !runtimeWx.cloud ||
    typeof runtimeWx.cloud.uploadFile !== "function" ||
    !fileSystem ||
    typeof fileSystem.writeFile !== "function" ||
    typeof fileSystem.unlink !== "function" ||
    !userDataPath
  ) {
    throw transferError(
      "DOCX_IMAGE_RUNTIME_UNAVAILABLE",
      "当前微信版本暂不支持 Word 图片上传，请更新微信后重试"
    );
  }

  const readImage =
    typeof options.readImage === "function"
      ? options.readImage
      : readDocxImage;
  const cancellation =
    options.cancelToken || options.cancellation || options.isCancelled;
  const activeTasks = new Set();
  const files = existingFiles.slice();
  let completed = existingFiles.length;
  let cursor = 0;
  let stopError = null;

  const abortActiveTasks = () => {
    Array.from(activeTasks).forEach((task) => {
      if (task && typeof task.abort === "function") {
        try {
          task.abort();
        } catch (error) {
          // The upload may have completed between cancellation and abort.
        }
      }
    });
  };
  const stop = (error) => {
    if (!stopError) {
      stopError = error;
      abortActiveTasks();
    }
  };
  const requestCancellation = () => stop(cancelledError());
  const unsubscribe = subscribeCancellation(
    cancellation,
    requestCancellation
  );
  const cancellationTimer = setInterval(() => {
    if (cancellationRequested(cancellation)) {
      requestCancellation();
    }
  }, 50);

  const assertRunning = () => {
    if (stopError) {
      throw stopError;
    }
    if (cancellationRequested(cancellation)) {
      requestCancellation();
      throw stopError;
    }
  };

  let extractionTail = Promise.resolve();
  const readImageSerially = async (item) => {
    const previousExtraction = extractionTail;
    let releaseExtraction;
    extractionTail = new Promise((resolve) => {
      releaseExtraction = resolve;
    });

    try {
      await previousExtraction;
      assertRunning();
      return await readImage(filePath, item.packagePath, {
        wx: runtimeWx,
        fileSystem
      });
    } finally {
      releaseExtraction();
    }
  };

  const transferOne = async (item) => {
    let stage = "extract";
    let primaryError = null;
    let cleanupError = null;
    let uploadedFile = null;
    let temporaryWriteAttempted = false;
    let verifiedTemporaryFileSize = null;
    const tempPath = temporaryFilePath(userDataPath, item.extension);

    try {
      assertRunning();
      safeProgress(progress, {
        phase: "extracting",
        completed,
        total,
        percent: Math.round((completed / total) * 100),
        imageOrder: item.imageOrder,
        packagePath: item.packagePath
      });
      const extracted = await readImageSerially(item);
      const data = toArrayBuffer(extracted);

      assertRunning();
      stage = "write";
      temporaryWriteAttempted = true;
      await writeTemporaryFile(fileSystem, tempPath, data);
      const statResult = await statTemporaryFile(fileSystem, tempPath);
      verifiedTemporaryFileSize = temporaryFileSize(statResult);
      if (
        verifiedTemporaryFileSize !== null &&
        (
          verifiedTemporaryFileSize <= 0 ||
          verifiedTemporaryFileSize !== data.byteLength
        )
      ) {
        throw transferError(
          "DOCX_IMAGE_TEMP_VERIFY_FAILED",
          `第 ${item.imageOrder} 张图片写入本机临时文件不完整，请重新选择 Word 后重试`,
          null,
          {
            imageOrder: item.imageOrder,
            packagePath: item.packagePath,
            expectedFileSize: data.byteLength,
            temporaryFileSize: verifiedTemporaryFileSize
          }
        );
      }
      if (verifiedTemporaryFileSize === null) {
        verifiedTemporaryFileSize = data.byteLength;
      }

      assertRunning();
      stage = "upload";
      safeProgress(progress, {
        phase: "uploading",
        completed,
        total,
        percent: Math.round((completed / total) * 100),
        imageOrder: item.imageOrder,
        packagePath: item.packagePath
      });
      let uploadTask = null;
      const uploadResult = await uploadCloudFile(
        runtimeWx,
        {
          cloudPath: item.cloudPath,
          filePath: tempPath
        },
        (task) => {
          uploadTask = task;
          if (task) {
            activeTasks.add(task);
          }
          if (stopError && task && typeof task.abort === "function") {
            try {
              task.abort();
            } catch (error) {
              // The task fail callback will provide the final state.
            }
          }
        }
      ).finally(() => {
        if (uploadTask) {
          activeTasks.delete(uploadTask);
        }
      });

      uploadedFile = {
        imageOrder: item.imageOrder,
        packagePath: item.packagePath,
        extension: item.extension,
        cloudPath: item.cloudPath,
        fileID: normalizeCloudFileID(
          uploadResult && (uploadResult.fileID || uploadResult.fileId),
          item.cloudPath
        )
      };
      assertRunning();
    } catch (error) {
      primaryError = wrapTransferStageError(error, stage, item, {
        temporaryFileSize: verifiedTemporaryFileSize
      });
      if (uploadedFile) {
        primaryError.uploadedFile = uploadedFile;
      }
    } finally {
      if (temporaryWriteAttempted) {
        try {
          await unlinkTemporaryFile(fileSystem, tempPath);
        } catch (error) {
          cleanupError = transferError(
            "DOCX_IMAGE_TEMP_CLEANUP_FAILED",
            "Word 图片临时文件清理失败，请关闭页面后重试",
            error,
            {
              imageOrder: item.imageOrder,
              packagePath: item.packagePath
            }
          );
        }
      }
    }

    if (primaryError) {
      if (cleanupError) {
        primaryError.cleanupError = cleanupError;
      }
      throw primaryError;
    }
    if (cleanupError) {
      cleanupError.uploadedFile = uploadedFile;
      throw cleanupError;
    }
    return uploadedFile;
  };

  const worker = async () => {
    while (true) {
      if (stopError) {
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= pendingTotal) {
        return;
      }

      const item = pendingPlan[index];
      try {
        const file = await transferOne(item);
        files.push(file);
        completed += 1;
        safeProgress(progress, {
          phase: "uploaded",
          completed,
          total,
          percent: Math.round((completed / total) * 100),
          imageOrder: item.imageOrder,
          packagePath: item.packagePath,
          fileID: file.fileID
        });
      } catch (error) {
        if (error && error.uploadedFile) {
          files.push(error.uploadedFile);
        }
        stop(error);
        return;
      }
    }
  };

  try {
    if (cancellationRequested(cancellation)) {
      requestCancellation();
    }
    if (!stopError) {
      const workerCount = Math.min(
        pendingTotal,
        normalizedConcurrency(options.concurrency)
      );
      await Promise.all(
        Array.from({ length: workerCount }, () => worker())
      );
    }
  } finally {
    clearInterval(cancellationTimer);
    unsubscribe();
    abortActiveTasks();
  }

  files.sort(
    (left, right) => left.imageOrder - right.imageOrder
  );
  if (stopError) {
    stopError.uploadedFiles = files.slice();
    throw stopError;
  }

  safeProgress(progress, {
    phase: "complete",
    completed: total,
    total,
    percent: 100
  });
  return {
    files,
    total,
    confirmationBatches: chunkDocxImageFiles(files)
  };
}

module.exports = {
  DEFAULT_CONFIRM_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_DOCX_IMAGES,
  SAFE_IMAGE_EXTENSIONS,
  chunkDocxImageFiles,
  createCancellationController,
  transferDocxImages,
  validateManifestImages,
  validateUploadPlan,
  validateExistingFiles
};
