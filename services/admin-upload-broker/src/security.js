"use strict";

const crypto = require("crypto");
const {
  ASSET_POLICIES,
  GLOBAL_MAX_BYTES,
  TICKET_MAX_AGE_MS,
  UPLOAD_ATTEMPT_MAX,
  UPLOAD_LEASE_MAX_AGE_MS
} = require("./constants");
const { BrokerError } = require("./errors");

const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;
const ATTEMPT_ID_PATTERN = /^[a-f0-9]{32}$/;
const OWNER_KEY_PATTERN = /^[a-f0-9]{24}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_OPENID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const RELATED_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const INSPECTION_MAX_BYTES = 32 * 1024;

function hashTicket(ticket) {
  return crypto.createHash("sha256").update(ticket, "utf8").digest("hex");
}

function constantTimeEqualHex(left, right) {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function readBearerTicket(header) {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(
    typeof header === "string" ? header : ""
  );

  if (!match || !TICKET_PATTERN.test(match[1])) {
    throw new BrokerError("INVALID_UPLOAD_TICKET", 401, "上传凭证无效或已过期");
  }

  return match[1];
}

function timeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toDate === "function") {
    const converted = value.toDate();
    return converted instanceof Date ? converted.getTime() : NaN;
  }

  if (value && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }

  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : NaN;
}

function getAccountRoles(account) {
  const roles = [];
  if (typeof (account && account.role) === "string") {
    roles.push(account.role.trim().toLowerCase());
  }
  if (Array.isArray(account && account.roles)) {
    account.roles.forEach((role) => {
      if (typeof role === "string") {
        roles.push(role.trim().toLowerCase());
      }
    });
  }
  return Array.from(new Set(roles.filter(Boolean)));
}

function validateOwnerAccount(account, reservation) {
  if (
    !account ||
    account._id !== reservation.ownerAdminId ||
    account.openid !== reservation.ownerOpenid ||
    account.status !== "active" ||
    !getAccountRoles(account).some((role) => ["uploader", "admin"].includes(role))
  ) {
    throw new BrokerError("UPLOAD_OWNER_FORBIDDEN", 403, "上传预约的管理员权限已失效");
  }
}

function getFileExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function validateOriginalFileName(value, extension) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value ||
    Array.from(value).length > 180 ||
    value === "." ||
    value === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(value) ||
    getFileExtension(value) !== extension
  ) {
    throw new BrokerError(
      "INVALID_UPLOAD_METADATA",
      422,
      "The reserved original file name is invalid"
    );
  }

  return value;
}

function validateRelatedId(value) {
  if (typeof value !== "string" || !RELATED_ID_PATTERN.test(value)) {
    throw new BrokerError(
      "INVALID_UPLOAD_METADATA",
      422,
      "The reserved related content identifier is invalid"
    );
  }

  return value;
}

function derivePreparedCloudPath(reservation) {
  const { assetType, extension, relatedId, uploadId } = reservation;

  if (assetType === "audio") {
    return `published/audio/${relatedId}/assets/${uploadId}/primary${extension}`;
  }
  if (assetType === "full-book-pdf") {
    return `protected/books/${relatedId}/assets/${uploadId}/${relatedId}.pdf`;
  }
  if (assetType === "topic-image") {
    return `protected/special-topics/${relatedId}/assets/${uploadId}/images/${uploadId}${extension}`;
  }

  return "";
}

function inspectionJsonClone(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    serialized = "";
  }

  if (!serialized || Buffer.byteLength(serialized, "utf8") > INSPECTION_MAX_BYTES) {
    return null;
  }

  try {
    return JSON.parse(serialized);
  } catch (error) {
    return null;
  }
}

function validateInspectionResult(value, reservation, actualBytes) {
  const inspection = inspectionJsonClone(value);
  const expectedBytes = Number(actualBytes);

  if (
    !inspection ||
    Array.isArray(inspection) ||
    inspection.schemaVersion !== 1 ||
    inspection.assetType !== reservation.assetType ||
    inspection.extension !== reservation.extension ||
    inspection.actualBytes !== expectedBytes ||
    inspection.signatureValid !== true ||
    typeof inspection.needsManualStructure !== "boolean" ||
    !/^[a-z0-9-]{1,32}$/.test(inspection.format || "") ||
    !inspection.metadata ||
    typeof inspection.metadata !== "object" ||
    Array.isArray(inspection.metadata)
  ) {
    throw new BrokerError(
      "UPLOAD_RESULT_INVALID",
      502,
      "The uploaded artifact validation result is invalid",
      { markUploadFailed: true }
    );
  }

  return inspection;
}

function cleanupCandidateCloudPaths(reservation) {
  const preparedCloudPath = derivePreparedCloudPath(reservation);
  return preparedCloudPath
    ? [reservation.cloudPath, preparedCloudPath]
    : [reservation.cloudPath];
}

function exactRecordedCandidateFileIDs(document, cloudPaths) {
  const candidates = [
    ...(Array.isArray(document && document.uploadCandidateFileIDs)
      ? document.uploadCandidateFileIDs
      : []),
    ...(Array.isArray(document && document.cleanupFileIDs)
      ? document.cleanupFileIDs
      : []),
    document && document.fileID,
    document && document.preparedFileID
  ];
  const accepted = [];
  const acceptedPaths = new Set();

  candidates.forEach((fileID) => {
    if (typeof fileID !== "string" || accepted.includes(fileID)) {
      return;
    }

    const exactCloudPath = cloudPaths.find((cloudPath) => {
      try {
        assertExactCloudFileID(fileID, cloudPath);
        return true;
      } catch (error) {
        return false;
      }
    });

    if (exactCloudPath && !acceptedPaths.has(exactCloudPath)) {
      accepted.push(fileID);
      acceptedPaths.add(exactCloudPath);
    }
  });

  return accepted;
}

// This validator is intentionally fail-only: it authenticates a consumed
// ticket and reconstructs the exact reserved targets, but it can never turn an
// interrupted claim back into an uploadable reservation.
function validateClaimRecovery(document, expectedUploadId, suppliedTicketHash, nowMs) {
  const isUploading = Boolean(
    document &&
    document.status === "uploading" &&
    document.ticketStatus === "consumed" &&
    document.transportMode === "https-broker" &&
    document.transportStatus === "uploading"
  );
  const isAlreadyRecovered = Boolean(
    document &&
    document.status === "upload_failed_cleanup_required" &&
    document.ticketStatus === "consumed" &&
    document.transportMode === "https-broker" &&
    document.transportStatus === "cleanup_required" &&
    ["UPLOAD_LEASE_EXPIRED", "UPLOAD_LEASE_INVALID"].includes(
      document.uploadFailureCode
    )
  );
  const isCleanupCompleted = Boolean(
    document &&
    document.status === "upload_failed" &&
    document.ticketStatus === "consumed" &&
    document.transportMode === "https-broker" &&
    document.transportStatus === "upload_failed" &&
    document.cleanupRequired === false &&
    document.uploadCleanupStatus === "completed" &&
    ["UPLOAD_LEASE_EXPIRED", "UPLOAD_LEASE_INVALID"].includes(
      document.uploadFailureCode
    )
  );

  if (!isUploading && !isAlreadyRecovered && !isCleanupCompleted) {
    return { state: "not_claimed" };
  }

  if (!constantTimeEqualHex(
    document.consumedUploadTicketHash,
    suppliedTicketHash
  )) {
    throw new BrokerError(
      "INVALID_UPLOAD_TICKET",
      401,
      "The upload ticket is invalid or expired"
    );
  }

  // The ticket may have expired after the process crashed. Recovery remains
  // safe because it only quarantines exact targets and never accepts bytes.
  const expiresAt = timeValue(document.ticketExpiresAt || document.expiresAt);
  const historicalNow = Number.isFinite(expiresAt)
    ? Math.min(Number(nowMs), expiresAt - 1)
    : Number(nowMs);
  const reservation = validateReservation({
    ...document,
    status: "pending_upload",
    ticketStatus: "active",
    transportStatus: "ticket_issued",
    uploadTicketHash: document.consumedUploadTicketHash
  }, expectedUploadId, suppliedTicketHash, historicalNow);
  const candidateCloudPaths = cleanupCandidateCloudPaths(reservation);
  const candidateFileIDs = exactRecordedCandidateFileIDs(
    document,
    candidateCloudPaths
  );
  const storedConfirmedCandidateCount = Number(
    document.uploadCleanupConfirmedFileCount || 0
  );
  const confirmedCandidateCount =
    Number.isSafeInteger(storedConfirmedCandidateCount) &&
    storedConfirmedCandidateCount >= 0 &&
    storedConfirmedCandidateCount <=
      candidateCloudPaths.length - candidateFileIDs.length
      ? storedConfirmedCandidateCount
      : 0;
  const unverifiedCandidatePathCount = Math.max(
    0,
    candidateCloudPaths.length -
      candidateFileIDs.length -
      confirmedCandidateCount
  );

  if (isCleanupCompleted) {
    return {
      state: "cleanup_completed",
      reservation,
      candidateCloudPaths: [],
      candidateFileIDs: [],
      confirmedCandidateCount: Number(
        document.uploadCleanupFileCount || 0
      ),
      unverifiedCandidatePathCount: Number(
        document.uploadCleanupUnverifiedPathCount || 0
      ),
      failureCode: document.uploadFailureCode,
      cleanupOutcome: document.uploadCleanupOutcome
    };
  }

  if (isAlreadyRecovered) {
    return {
      state: "recovered",
      reservation,
      candidateCloudPaths,
      candidateFileIDs,
      confirmedCandidateCount,
      unverifiedCandidatePathCount,
      failureCode: document.uploadFailureCode
    };
  }

  const leaseStartedAt = timeValue(document.uploadLeaseStartedAt);
  const leaseExpiresAt = timeValue(document.uploadLeaseExpiresAt);
  const attempt = Number(document.uploadAttempt);
  const leaseIsValid =
    ATTEMPT_ID_PATTERN.test(document.uploadAttemptId || "") &&
    Number.isSafeInteger(attempt) &&
    attempt >= 1 &&
    attempt <= UPLOAD_ATTEMPT_MAX &&
    Number.isFinite(leaseStartedAt) &&
    Number.isFinite(leaseExpiresAt) &&
    leaseExpiresAt > leaseStartedAt &&
    leaseExpiresAt - leaseStartedAt <= UPLOAD_LEASE_MAX_AGE_MS &&
    leaseExpiresAt <= expiresAt;

  if (leaseIsValid && Number(nowMs) < leaseExpiresAt) {
    throw new BrokerError(
      "UPLOAD_IN_PROGRESS",
      409,
      "The upload is already in progress"
    );
  }

  return {
    state: "expired",
    reservation,
    candidateCloudPaths,
    candidateFileIDs,
    confirmedCandidateCount,
    unverifiedCandidatePathCount,
    failureCode: leaseIsValid
      ? "UPLOAD_LEASE_EXPIRED"
      : "UPLOAD_LEASE_INVALID"
  };
}

function validateReservation(document, expectedUploadId, suppliedTicketHash, nowMs) {
  if (!document || document._id !== expectedUploadId || !UPLOAD_ID_PATTERN.test(expectedUploadId)) {
    throw new BrokerError("UPLOAD_RESERVATION_NOT_FOUND", 404, "上传预约不存在");
  }

  const isPending =
    document.status === "pending_upload" &&
    document.ticketStatus === "active" &&
    document.transportMode === "https-broker" &&
    document.transportStatus === "ticket_issued";
  const isCompleted =
    document.status === "uploaded" &&
    document.ticketStatus === "consumed" &&
    document.transportMode === "https-broker" &&
    document.transportStatus === "broker_uploaded";

  if (!isPending && !isCompleted) {
    throw new BrokerError("UPLOAD_TICKET_ALREADY_USED", 409, "上传凭证已使用或任务状态已变化");
  }

  const storedTicketHash = isCompleted
    ? document.consumedUploadTicketHash
    : document.uploadTicketHash;
  if (!constantTimeEqualHex(storedTicketHash, suppliedTicketHash)) {
    throw new BrokerError("INVALID_UPLOAD_TICKET", 401, "上传凭证无效或已过期");
  }

  if (
    !SAFE_ID_PATTERN.test(document.ownerAdminId || "") ||
    !SAFE_OPENID_PATTERN.test(document.ownerOpenid || "")
  ) {
    throw new BrokerError("UPLOAD_OWNER_MISMATCH", 403, "上传预约的管理员归属无效");
  }

  const issuedAt = timeValue(document.ticketIssuedAt || document.createdAt);
  const expiresAt = timeValue(document.ticketExpiresAt || document.expiresAt);

  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > TICKET_MAX_AGE_MS
  ) {
    throw new BrokerError("UPLOAD_TICKET_EXPIRED", 401, "上传凭证无效或已过期");
  }

  const policy = ASSET_POLICIES[document.assetType];
  const extension = typeof document.extension === "string"
    ? document.extension.toLowerCase()
    : "";
  const mimeType = typeof document.mimeType === "string"
    ? document.mimeType.toLowerCase()
    : "";
  const declaredBytes = Number(document.declaredBytes);
  const reservationMaximum = Number(document.maximumBytes);

  if (
    !policy ||
    !policy.formats[extension] ||
    !policy.formats[extension].includes(mimeType) ||
    !MIME_PATTERN.test(mimeType) ||
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes <= 0 ||
    !Number.isSafeInteger(reservationMaximum) ||
    reservationMaximum <= 0 ||
    reservationMaximum > policy.maximumBytes ||
    declaredBytes > reservationMaximum ||
    declaredBytes > GLOBAL_MAX_BYTES
  ) {
    throw new BrokerError("INVALID_UPLOAD_POLICY", 422, "上传预约的文件策略无效");
  }

  const ownerKey = typeof document.ownerKey === "string" ? document.ownerKey : "";
  if (!OWNER_KEY_PATTERN.test(ownerKey)) {
    throw new BrokerError("INVALID_UPLOAD_TARGET", 422, "上传预约的云端路径无效");
  }

  const expectedCloudPath =
    `admin-staging/${ownerKey}/${expectedUploadId}/source${extension}`;

  if (
    document.cloudPath !== expectedCloudPath ||
    document.cloudPath.includes("..") ||
    document.cloudPath.includes("\\") ||
    document.cloudPath.startsWith("/")
  ) {
    throw new BrokerError("INVALID_UPLOAD_TARGET", 422, "上传预约的云端路径无效");
  }

  const originalFileName = validateOriginalFileName(
    document.originalFileName,
    extension
  );
  const relatedId = validateRelatedId(document.relatedId);

  const reservation = {
    uploadId: expectedUploadId,
    ownerAdminId: document.ownerAdminId,
    ownerOpenid: document.ownerOpenid,
    ownerKey,
    assetType: document.assetType,
    originalFileName,
    relatedId,
    extension,
    mimeType,
    declaredBytes,
    maximumBytes: reservationMaximum,
    cloudPath: expectedCloudPath,
    ticketExpiresAt: new Date(expiresAt),
    alreadyUploaded: isCompleted
  };

  if (isCompleted) {
    assertExactCloudFileID(document.fileID, expectedCloudPath);
    if (
      Number(document.actualBytes) !== declaredBytes ||
      !HASH_PATTERN.test(document.sha256 || "")
    ) {
      throw new BrokerError("UPLOAD_RESULT_INVALID", 502, "已上传文件记录不完整");
    }
    reservation.fileID = document.fileID;
    reservation.actualBytes = declaredBytes;
    reservation.sha256 = document.sha256;
    reservation.inspection = validateInspectionResult(
      document.inspection,
      reservation,
      declaredBytes
    );
    if (
      document.validationStatus !== "validated" ||
      document.reviewStatus !== "not_submitted"
    ) {
      throw new BrokerError("UPLOAD_RESULT_INVALID", 502, "The uploaded file record is incomplete");
    }
    reservation.validationStatus = "validated";
    reservation.reviewStatus = "not_submitted";

    const expectedPreparedCloudPath = derivePreparedCloudPath(reservation);
    if (expectedPreparedCloudPath) {
      if (document.preparedCloudPath !== expectedPreparedCloudPath) {
        throw new BrokerError("UPLOAD_RESULT_INVALID", 502, "The prepared asset record is invalid");
      }
      assertExactCloudFileID(document.preparedFileID, expectedPreparedCloudPath);
      reservation.preparedCloudPath = expectedPreparedCloudPath;
      reservation.preparedFileID = document.preparedFileID;
    } else if (document.preparedCloudPath || document.preparedFileID) {
      throw new BrokerError("UPLOAD_RESULT_INVALID", 502, "The upload has an unexpected prepared asset");
    }
  }

  return reservation;
}

function assertExactCloudFileID(fileID, cloudPath) {
  if (
    typeof fileID !== "string" ||
    fileID.length > 2048 ||
    !fileID.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(fileID) ||
    fileID.includes("..")
  ) {
    throw new BrokerError(
      "STORAGE_RESULT_MISMATCH",
      502,
      "云存储返回了无效的文件标识",
      { markUploadFailed: true }
    );
  }

  const slash = fileID.indexOf("/", "cloud://".length);
  const environment = slash >= 0 ? fileID.slice("cloud://".length, slash) : "";
  const resultPath = slash >= 0 ? fileID.slice(slash + 1) : "";

  if (!environment || resultPath !== cloudPath) {
    throw new BrokerError(
      "STORAGE_RESULT_MISMATCH",
      502,
      "云存储返回的路径与上传预约不一致",
      { markUploadFailed: true }
    );
  }
}

module.exports = {
  ATTEMPT_ID_PATTERN,
  UPLOAD_ID_PATTERN,
  cleanupCandidateCloudPaths,
  derivePreparedCloudPath,
  exactRecordedCandidateFileIDs,
  assertExactCloudFileID,
  constantTimeEqualHex,
  hashTicket,
  readBearerTicket,
  timeValue,
  validateClaimRecovery,
  validateInspectionResult,
  validateOwnerAccount,
  validateReservation
};
