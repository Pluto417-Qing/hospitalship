"use strict";

const { BrokerError } = require("./errors");
const {
  UPLOAD_ATTEMPT_MAX,
  UPLOAD_LEASE_MAX_AGE_MS
} = require("./constants");
const {
  ATTEMPT_ID_PATTERN,
  assertExactCloudFileID,
  cleanupCandidateCloudPaths,
  derivePreparedCloudPath,
  exactRecordedCandidateFileIDs,
  timeValue,
  validateClaimRecovery,
  validateInspectionResult,
  validateOwnerAccount,
  validateReservation
} = require("./security");

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

function isDocumentNotFound(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String((error && (error.errMsg || error.message)) || "");
  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist|not exist)/i.test(message)
  );
}

async function getDocumentOrNull(reference) {
  try {
    const result = await reference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function serializeBrokerError(error) {
  if (!(error instanceof BrokerError)) {
    throw error;
  }

  return {
    ok: false,
    error: {
      code: error.code,
      status: error.status,
      publicMessage: error.publicMessage
    }
  };
}

function throwTransactionError(result) {
  if (result && result.ok === false && result.error) {
    throw new BrokerError(
      result.error.code,
      result.error.status,
      result.error.publicMessage
    );
  }
}

function sameStringSet(left, right) {
  const leftValues = Array.from(new Set(Array.isArray(left) ? left : [])).sort();
  const rightValues = Array.from(new Set(Array.isArray(right) ? right : [])).sort();
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

class CloudBaseReservationStore {
  constructor(database, options = {}) {
    this.database = database;
    this.now = options.now || (() => Date.now());
    this.uploadLeaseMs = options.uploadLeaseMs === undefined
      ? UPLOAD_LEASE_MAX_AGE_MS
      : Number(options.uploadLeaseMs);
    if (
      !Number.isSafeInteger(this.uploadLeaseMs) ||
      this.uploadLeaseMs <= 0 ||
      this.uploadLeaseMs > UPLOAD_LEASE_MAX_AGE_MS
    ) {
      throw new Error("uploadLeaseMs must be a positive bounded integer");
    }
  }

  serverDate() {
    return typeof this.database.serverDate === "function"
      ? this.database.serverDate()
      : new Date(this.now());
  }

  async claim({ uploadId, ticketHash, attemptId }) {
    if (!ATTEMPT_ID_PATTERN.test(attemptId || "")) {
      throw new BrokerError(
        "UPLOAD_ATTEMPT_INVALID",
        500,
        "The upload attempt identifier is invalid"
      );
    }

    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction.collection("adminUploads").doc(uploadId);
      const document = await getDocumentOrNull(reference);
      let reservation;

      try {
        reservation = validateReservation(document, uploadId, ticketHash, this.now());
        const accountReference = transaction
          .collection("adminAccounts")
          .doc(reservation.ownerAdminId);
        const account = await getDocumentOrNull(accountReference);
        validateOwnerAccount(account, reservation);
      } catch (error) {
        return serializeBrokerError(error);
      }

      if (reservation.alreadyUploaded) {
        return { ok: true, reservation };
      }

      const nowMs = this.now();
      const nextAttempt = Number(document.uploadAttempt || 0) + 1;
      if (
        !Number.isSafeInteger(nextAttempt) ||
        nextAttempt < 1 ||
        nextAttempt > UPLOAD_ATTEMPT_MAX
      ) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_ATTEMPT_LIMIT_REACHED",
            409,
            "The upload attempt limit has been reached"
          )
        );
      }
      const leaseExpiresAtMs = Math.min(
        nowMs + this.uploadLeaseMs,
        reservation.ticketExpiresAt.getTime()
      );
      if (leaseExpiresAtMs <= nowMs) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_TICKET_EXPIRED",
            401,
            "The upload ticket is invalid or expired"
          )
        );
      }
      const candidateCloudPaths = cleanupCandidateCloudPaths(reservation);

      await reference.update({
        data: {
          status: "uploading",
          uploadAttemptId: attemptId,
          uploadTicketHash: "",
          consumedUploadTicketHash: ticketHash,
          ticketStatus: "consumed",
          transportStatus: "uploading",
          uploadAttempt: nextAttempt,
          uploadLeaseStartedAt: new Date(nowMs),
          uploadLeaseExpiresAt: new Date(leaseExpiresAtMs),
          uploadCandidateCloudPaths: candidateCloudPaths,
          uploadCandidateFileIDs: [],
          ticketConsumedAt: this.serverDate(),
          updateTime: this.serverDate()
        }
      });

      return { ok: true, reservation };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok || !result.reservation) {
      throw new Error("claim transaction returned an invalid result");
    }

    return result.reservation;
  }

  async recoverExpiredClaim({ uploadId, ticketHash }) {
    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction.collection("adminUploads").doc(uploadId);
      const document = await getDocumentOrNull(reference);
      let recovery;

      try {
        recovery = validateClaimRecovery(
          document,
          uploadId,
          ticketHash,
          this.now()
        );
      } catch (error) {
        return serializeBrokerError(error);
      }

      if (recovery.state === "not_claimed") {
        return { ok: true, recovered: false };
      }
      if (recovery.state === "cleanup_completed") {
        return {
          ok: true,
          recovered: true,
          cleanupCompleted: true,
          alreadyRecovered: true,
          candidateFileIDs: [],
          unverifiedCandidatePathCount:
            recovery.unverifiedCandidatePathCount,
          failureCode: recovery.failureCode,
          cleanupOutcome: recovery.cleanupOutcome
        };
      }
      if (recovery.state === "recovered") {
        return {
          ok: true,
          recovered: true,
          cleanupCompleted: false,
          alreadyRecovered: true,
          candidateFileIDs: recovery.candidateFileIDs,
          unverifiedCandidatePathCount:
            recovery.unverifiedCandidatePathCount,
          failureCode: recovery.failureCode
        };
      }

      const now = this.serverDate();
      await reference.update({
        data: {
          status: "upload_failed_cleanup_required",
          transportStatus: "cleanup_required",
          reviewStatus: "not_submitted",
          validationStatus: "upload_failed",
          uploadFailureCode: recovery.failureCode,
          cleanupRequired: true,
          cleanupFileID: recovery.candidateFileIDs[0] || "",
          cleanupFileIDs: recovery.candidateFileIDs,
          cleanupCloudPath: recovery.candidateCloudPaths[0],
          cleanupCloudPaths: recovery.candidateCloudPaths,
          fileID: "",
          preparedFileID: "",
          preparedCloudPath: "",
          uploadCandidateCloudPaths: [],
          uploadCandidateFileIDs: [],
          uploadCleanupStatus: "pending",
          uploadCleanupOutcome: "",
          uploadCleanupConfirmedFileCount: 0,
          uploadLeaseRecoveredAt: now,
          uploadFailedAt: now,
          updateTime: now
        }
      });

      return {
        ok: true,
        recovered: true,
        cleanupCompleted: false,
        alreadyRecovered: false,
        candidateFileIDs: recovery.candidateFileIDs,
        unverifiedCandidatePathCount:
          recovery.unverifiedCandidatePathCount,
        failureCode: recovery.failureCode
      };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok) {
      throw new Error("claim recovery transaction returned an invalid result");
    }

    return result;
  }

  async completeRecoveredCleanup({
    uploadId,
    ticketHash,
    fileIDs,
    outcome
  }) {
    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction.collection("adminUploads").doc(uploadId);
      const document = await getDocumentOrNull(reference);
      let recovery;

      try {
        recovery = validateClaimRecovery(
          document,
          uploadId,
          ticketHash,
          this.now()
        );
      } catch (error) {
        return serializeBrokerError(error);
      }

      if (recovery.state === "cleanup_completed") {
        return { ok: true, alreadyCompleted: true };
      }
      if (recovery.state !== "recovered") {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_CLEANUP_STATE_CHANGED",
            409,
            "The interrupted upload cleanup state has changed"
          )
        );
      }

      const expectedFileIDs = recovery.candidateFileIDs;
      const unverifiedCandidatePathCount =
        recovery.unverifiedCandidatePathCount;
      const expectedOutcome = expectedFileIDs.length === 0
        ? "no_recorded_file_id_unverified"
        : unverifiedCandidatePathCount > 0
          ? "recorded_files_deleted_unverified_paths"
          : "deleted_confirmed";
      const validOutcome = outcome === expectedOutcome;
      if (!validOutcome || !sameStringSet(fileIDs, expectedFileIDs)) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_CLEANUP_RESULT_INVALID",
            502,
            "The interrupted upload cleanup result is invalid"
          )
        );
      }

      const now = this.serverDate();
      await reference.update({
        data: {
          status: "upload_failed",
          transportStatus: "upload_failed",
          cleanupRequired: false,
          cleanupFileID: "",
          cleanupFileIDs: [],
          cleanupCloudPath: "",
          cleanupCloudPaths: [],
          fileID: "",
          preparedFileID: "",
          preparedCloudPath: "",
          uploadCandidateCloudPaths: [],
          uploadCandidateFileIDs: [],
          uploadCleanupStatus: "completed",
          uploadCleanupOutcome: outcome,
          uploadCleanupFileCount:
            recovery.confirmedCandidateCount + expectedFileIDs.length,
          uploadCleanupUnverifiedPathCount: unverifiedCandidatePathCount,
          uploadCleanupCompletedAt: now,
          updateTime: now
        }
      });

      return { ok: true, alreadyCompleted: false };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok) {
      throw new Error("cleanup completion transaction returned an invalid result");
    }
    return result;
  }

  async recordRecoveredCleanupFailure({
    uploadId,
    ticketHash,
    remainingFileIDs
  }) {
    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction.collection("adminUploads").doc(uploadId);
      const document = await getDocumentOrNull(reference);
      let recovery;

      try {
        recovery = validateClaimRecovery(
          document,
          uploadId,
          ticketHash,
          this.now()
        );
      } catch (error) {
        return serializeBrokerError(error);
      }

      if (recovery.state === "cleanup_completed") {
        return { ok: true, alreadyCompleted: true };
      }
      const exactRemaining = exactRecordedCandidateFileIDs(
        { uploadCandidateFileIDs: remainingFileIDs },
        recovery.candidateCloudPaths || []
      );
      if (
        recovery.state !== "recovered" ||
        exactRemaining.length === 0 ||
        !exactRemaining.every((fileID) =>
          recovery.candidateFileIDs.includes(fileID)
        )
      ) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_CLEANUP_RESULT_INVALID",
            502,
            "The interrupted upload cleanup result is invalid"
          )
        );
      }

      const now = this.serverDate();
      const newlyConfirmedCount =
        recovery.candidateFileIDs.length - exactRemaining.length;
      await reference.update({
        data: {
          status: "upload_failed_cleanup_required",
          transportStatus: "cleanup_required",
          cleanupRequired: true,
          cleanupFileID: exactRemaining[0],
          cleanupFileIDs: exactRemaining,
          cleanupCloudPath: recovery.candidateCloudPaths[0],
          cleanupCloudPaths: recovery.candidateCloudPaths,
          uploadCandidateCloudPaths: [],
          uploadCandidateFileIDs: [],
          uploadCleanupStatus: "pending",
          uploadCleanupConfirmedFileCount:
            recovery.confirmedCandidateCount + newlyConfirmedCount,
          uploadCleanupLastFailureCode: "STORAGE_CLEANUP_FAILED",
          uploadCleanupLastAttemptAt: now,
          updateTime: now
        }
      });

      return { ok: true, alreadyCompleted: false };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok) {
      throw new Error("cleanup failure transaction returned an invalid result");
    }
    return result;
  }

  async recordStorageWrite({ reservation, attemptId, fileID, cloudPath }) {
    const candidateCloudPaths = cleanupCandidateCloudPaths(reservation);
    if (!candidateCloudPaths.includes(cloudPath)) {
      throw new BrokerError(
        "STORAGE_RESULT_MISMATCH",
        502,
        "The storage target does not match its reservation",
        { markUploadFailed: true }
      );
    }
    assertExactCloudFileID(fileID, cloudPath);

    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction
        .collection("adminUploads")
        .doc(reservation.uploadId);
      const document = await getDocumentOrNull(reference);

      if (
        !document ||
        document.status !== "uploading" ||
        document.transportStatus !== "uploading" ||
        document.uploadAttemptId !== attemptId ||
        document.ownerAdminId !== reservation.ownerAdminId ||
        document.cloudPath !== reservation.cloudPath
      ) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_STATE_CHANGED",
            409,
            "The upload task state has changed",
            { markUploadFailed: true }
          )
        );
      }

      const next = exactRecordedCandidateFileIDs(
        {
          uploadCandidateFileIDs: [
            ...(Array.isArray(document.uploadCandidateFileIDs)
              ? document.uploadCandidateFileIDs
              : []),
            fileID
          ]
        },
        candidateCloudPaths
      );
      await reference.update({
        data: {
          uploadCandidateFileIDs: next,
          updateTime: this.serverDate()
        }
      });
      return { ok: true };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok) {
      throw new Error("storage write transaction returned an invalid result");
    }
  }

  async finalize({
    reservation,
    attemptId,
    fileID,
    actualBytes,
    sha256,
    inspection,
    preparedFileID,
    preparedCloudPath
  }) {
    assertExactCloudFileID(fileID, reservation.cloudPath);
    if (
      Number(actualBytes) !== reservation.declaredBytes ||
      !/^[a-f0-9]{64}$/.test(sha256 || "")
    ) {
      throw new BrokerError(
        "UPLOAD_RESULT_INVALID",
        502,
        "The uploaded artifact fingerprint is invalid",
        { markUploadFailed: true }
      );
    }
    const validatedInspection = validateInspectionResult(
      inspection,
      reservation,
      actualBytes
    );
    const expectedPreparedCloudPath = derivePreparedCloudPath(reservation);
    if (
      preparedCloudPath !== expectedPreparedCloudPath ||
      Boolean(preparedFileID) !== Boolean(expectedPreparedCloudPath)
    ) {
      throw new BrokerError(
        "STORAGE_RESULT_MISMATCH",
        502,
        "The prepared asset target does not match its reservation",
        { markUploadFailed: true }
      );
    }
    if (expectedPreparedCloudPath) {
      assertExactCloudFileID(preparedFileID, expectedPreparedCloudPath);
    }

    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction
        .collection("adminUploads")
        .doc(reservation.uploadId);
      const document = await getDocumentOrNull(reference);
      const leaseExpiresAt = timeValue(document && document.uploadLeaseExpiresAt);

      if (
        !document ||
        document.status !== "uploading" ||
        document.uploadAttemptId !== attemptId ||
        document.ownerAdminId !== reservation.ownerAdminId ||
        document.ownerOpenid !== reservation.ownerOpenid ||
        document.cloudPath !== reservation.cloudPath ||
        document.assetType !== reservation.assetType ||
        document.extension !== reservation.extension ||
        document.originalFileName !== reservation.originalFileName ||
        document.relatedId !== reservation.relatedId ||
        !Number.isFinite(leaseExpiresAt) ||
        leaseExpiresAt <= this.now()
      ) {
        return serializeBrokerError(
          new BrokerError(
            "UPLOAD_STATE_CHANGED",
            409,
            "上传任务状态已变化",
            { markUploadFailed: true }
          )
        );
      }

      const now = this.serverDate();
      await reference.update({
        data: {
          fileID,
          actualBytes,
          sha256,
          inspection: validatedInspection,
          preparedFileID: preparedFileID || "",
          preparedCloudPath: preparedCloudPath || "",
          status: "uploaded",
          transportStatus: "broker_uploaded",
          reviewStatus: "not_submitted",
          validationStatus: "validated",
          cleanupRequired: false,
          cleanupFileID: "",
          cleanupFileIDs: [],
          cleanupCloudPath: "",
          cleanupCloudPaths: [],
          uploadedAt: now,
          updateTime: now
        }
      });

      return { ok: true };
    });
    const result = unwrapTransactionResult(rawResult);
    throwTransactionError(result);

    if (!result || !result.ok) {
      throw new Error("finalize transaction returned an invalid result");
    }
  }

  async markFailed({ reservation, attemptId, code, cleanupRequired, fileIDs }) {
    const safeCode = /^[A-Z0-9_]{3,64}$/.test(code || "")
      ? code
      : "UPLOAD_BROKER_FAILED";
    const cleanupCloudPaths = cleanupCandidateCloudPaths(reservation);
    const cleanupFileIDs = cleanupRequired && Array.isArray(fileIDs)
      ? exactRecordedCandidateFileIDs(
          { uploadCandidateFileIDs: fileIDs },
          cleanupCloudPaths
        )
      : [];
    const needsCleanup = Boolean(cleanupRequired);
    const rawResult = await this.database.runTransaction(async (transaction) => {
      const reference = transaction
        .collection("adminUploads")
        .doc(reservation.uploadId);
      const document = await getDocumentOrNull(reference);

      if (
        !document ||
        document.status !== "uploading" ||
        document.uploadAttemptId !== attemptId ||
        document.ownerAdminId !== reservation.ownerAdminId ||
        document.ownerOpenid !== reservation.ownerOpenid ||
        document.cloudPath !== reservation.cloudPath
      ) {
        return { ok: false, skipped: true };
      }

      const now = this.serverDate();
      await reference.update({
        data: {
          status: needsCleanup
            ? "upload_failed_cleanup_required"
            : "upload_failed",
          transportStatus: needsCleanup
            ? "cleanup_required"
            : "upload_failed",
          reviewStatus: "not_submitted",
          validationStatus: "upload_failed",
          uploadFailureCode: safeCode,
          cleanupRequired: needsCleanup,
          cleanupFileID: cleanupFileIDs[0] || "",
          cleanupFileIDs,
          cleanupCloudPath: needsCleanup ? cleanupCloudPaths[0] : "",
          cleanupCloudPaths: needsCleanup ? cleanupCloudPaths : [],
          uploadFailedAt: now,
          updateTime: now
        }
      });

      return { ok: true };
    });

    return unwrapTransactionResult(rawResult);
  }
}

module.exports = {
  CloudBaseReservationStore,
  getDocumentOrNull,
  unwrapTransactionResult
};
