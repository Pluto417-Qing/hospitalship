"use strict";

const crypto = require("crypto");
const { inspectArtifact } = require("./artifact-inspector");
const {
  KNOWN_CHAPTER_SOURCE_PDF_SHA256S,
  MULTIPART_OVERHEAD_BYTES
} = require("./constants");
const { BrokerError, asBrokerError } = require("./errors");
const {
  assertExactCloudFileID,
  derivePreparedCloudPath,
  hashTicket,
  validateInspectionResult
} = require("./security");

const CONFIRMED_ABSENT_CODES = new Set([
  "SUCCESS",
  "STORAGE_FILE_NONEXIST"
]);

function deletionWasConfirmed(item, fileID) {
  const numericStatusIsSuccess =
    item &&
    item.status !== undefined &&
    item.status !== null &&
    Number(item.status) === 0;
  return Boolean(
    item &&
    item.fileID === fileID &&
    (
      numericStatusIsSuccess ||
      CONFIRMED_ABSENT_CODES.has(String(item.code || "").toUpperCase())
    )
  );
}

function interruptedUploadError(cleanupRequired) {
  return cleanupRequired
    ? new BrokerError(
        "UPLOAD_FAILED_CLEANUP_REQUIRED",
        409,
        "The interrupted upload is quarantined and requires storage cleanup"
      )
    : new BrokerError(
        "UPLOAD_INTERRUPTED",
        409,
        "The interrupted upload failed; create a new upload reservation"
      );
}

class UploadBroker {
  constructor(options) {
    this.store = options.store;
    this.storage = options.storage;
    this.receiver = options.receiver;
    this.inspectArtifact = options.inspectArtifact || inspectArtifact;
    this.createAttemptId = options.createAttemptId ||
      (() => crypto.randomBytes(16).toString("hex"));
    this.logger = options.logger || console;
  }

  async cleanupRecoveredClaim({ uploadId, ticketHash, recovery }) {
    if (recovery.cleanupCompleted) {
      throw interruptedUploadError(false);
    }

    const candidateFileIDs = Array.from(new Set(
      Array.isArray(recovery.candidateFileIDs)
        ? recovery.candidateFileIDs.filter((fileID) =>
            typeof fileID === "string" && fileID.startsWith("cloud://")
          )
        : []
    )).slice(0, 2);

    if (candidateFileIDs.length === 0) {
      try {
        await this.store.completeRecoveredCleanup({
          uploadId,
          ticketHash,
          fileIDs: [],
          // A path without a recorded CloudBase fileID is not deletion
          // authority. We do not synthesize an environment-qualified ID or
          // touch an object whose existence cannot be proven here.
          outcome: "no_recorded_file_id_unverified"
        });
      } catch (error) {
        this.logger.error("admin upload recovery state could not be completed", {
          uploadId,
          code: "RECOVERY_STATE_WRITE_FAILED"
        });
        throw interruptedUploadError(true);
      }
      throw interruptedUploadError(false);
    }

    let remainingFileIDs = candidateFileIDs;
    try {
      const cleanup = await this.storage.deleteFile({
        fileList: candidateFileIDs
      });
      const results = cleanup && Array.isArray(cleanup.fileList)
        ? cleanup.fileList
        : [];
      remainingFileIDs = candidateFileIDs.filter((fileID) =>
        !results.some((item) => deletionWasConfirmed(item, fileID))
      );
    } catch (error) {
      this.logger.error("admin upload recovery cleanup failed", {
        uploadId,
        code: "STORAGE_CLEANUP_FAILED"
      });
    }

    if (remainingFileIDs.length > 0) {
      try {
        const pending = await this.store.recordRecoveredCleanupFailure({
          uploadId,
          ticketHash,
          remainingFileIDs
        });
        if (pending.alreadyCompleted) {
          throw interruptedUploadError(false);
        }
      } catch (error) {
        if (error instanceof BrokerError && error.code === "UPLOAD_INTERRUPTED") {
          throw error;
        }
        this.logger.error("admin upload recovery failure state could not be persisted", {
          uploadId,
          code: "RECOVERY_FAILURE_STATE_WRITE_FAILED"
        });
      }
      throw interruptedUploadError(true);
    }

    try {
      await this.store.completeRecoveredCleanup({
        uploadId,
        ticketHash,
        fileIDs: candidateFileIDs,
        outcome: Number(recovery.unverifiedCandidatePathCount) > 0
          ? "recorded_files_deleted_unverified_paths"
          : "deleted_confirmed"
      });
    } catch (error) {
      this.logger.error("admin upload recovery state could not be completed", {
        uploadId,
        code: "RECOVERY_STATE_WRITE_FAILED"
      });
      throw interruptedUploadError(true);
    }
    throw interruptedUploadError(false);
  }

  async process({ uploadId, ticket, request, contentLength }) {
    const attemptId = this.createAttemptId();
    const ticketHash = hashTicket(ticket);
    const recovery = await this.store.recoverExpiredClaim({
      uploadId,
      ticketHash
    });
    if (recovery.recovered) {
      return this.cleanupRecoveredClaim({ uploadId, ticketHash, recovery });
    }
    const reservation = await this.store.claim({
      uploadId,
      ticketHash,
      attemptId
    });
    if (reservation.alreadyUploaded) {
      if (request.readable && !request.readableEnded) {
        request.resume();
      }

      return {
        success: true,
        uploadId,
        status: "uploaded",
        transportStatus: "broker_uploaded",
        reviewStatus: reservation.reviewStatus,
        validationStatus: reservation.validationStatus,
        actualBytes: reservation.actualBytes,
        sha256: reservation.sha256,
        alreadyUploaded: true,
        published: false
      };
    }
    let artifact = null;
    let uploadedFileIDs = [];

    try {
      if (
        contentLength !== null &&
        (contentLength <= reservation.declaredBytes ||
          contentLength > reservation.declaredBytes + MULTIPART_OVERHEAD_BYTES)
      ) {
        throw new BrokerError(
          "INVALID_CONTENT_LENGTH",
          413,
          "上传请求大小与预约不一致",
          { markUploadFailed: true }
        );
      }

      artifact = await this.receiver.receive(request, reservation, attemptId);
      const inspection = validateInspectionResult(
        await this.inspectArtifact({ path: artifact.path, reservation }),
        reservation,
        artifact.actualBytes
      );
      if (
        reservation.assetType === "full-book-pdf" &&
        KNOWN_CHAPTER_SOURCE_PDF_SHA256S.includes(
          String(artifact.sha256 || "").toLowerCase()
        )
      ) {
        throw new BrokerError(
          "BOOK_CHAPTER_SOURCE_NOT_COMPLETE",
          422,
          "The chapter example PDF is not a complete book PDF",
          { markUploadFailed: true }
        );
      }

      const uploadResult = await this.storage.uploadFile({
        cloudPath: reservation.cloudPath,
        fileContent: artifact.createReadStream()
      });
      const fileID = uploadResult && uploadResult.fileID;
      assertExactCloudFileID(fileID, reservation.cloudPath);
      uploadedFileIDs.push(fileID);
      await this.store.recordStorageWrite({
        reservation,
        attemptId,
        fileID,
        cloudPath: reservation.cloudPath
      });

      const preparedCloudPath = derivePreparedCloudPath(reservation);
      let preparedFileID = "";
      if (preparedCloudPath) {
        const preparedUploadResult = await this.storage.uploadFile({
          cloudPath: preparedCloudPath,
          fileContent: artifact.createReadStream()
        });
        preparedFileID = preparedUploadResult && preparedUploadResult.fileID;
        assertExactCloudFileID(preparedFileID, preparedCloudPath);
        uploadedFileIDs.push(preparedFileID);
        await this.store.recordStorageWrite({
          reservation,
          attemptId,
          fileID: preparedFileID,
          cloudPath: preparedCloudPath
        });
      }

      await this.store.finalize({
        reservation,
        attemptId,
        fileID,
        actualBytes: artifact.actualBytes,
        sha256: artifact.sha256,
        inspection,
        preparedFileID,
        preparedCloudPath
      });

      return {
        success: true,
        uploadId,
        status: "uploaded",
        transportStatus: "broker_uploaded",
        reviewStatus: "not_submitted",
        validationStatus: "validated",
        actualBytes: artifact.actualBytes,
        sha256: artifact.sha256,
        published: false
      };
    } catch (error) {
      const brokerError = asBrokerError(error);
      let cleanupRequired = false;

      if (uploadedFileIDs.length > 0) {
        try {
          const cleanup = await this.storage.deleteFile({
            fileList: uploadedFileIDs
          });
          const cleanupResults = cleanup && Array.isArray(cleanup.fileList)
            ? cleanup.fileList
            : [];
          const cleanedFileIDs = new Set(
            cleanupResults
              .filter((item) =>
                item &&
                uploadedFileIDs.includes(item.fileID) &&
                deletionWasConfirmed(item, item.fileID)
              )
              .map((item) => item.fileID)
          );
          uploadedFileIDs = uploadedFileIDs.filter(
            (fileID) => !cleanedFileIDs.has(fileID)
          );
          if (uploadedFileIDs.length > 0) {
            throw new Error("CloudBase did not confirm exact file cleanup");
          }
        } catch (cleanupError) {
          cleanupRequired = uploadedFileIDs.length > 0;
          this.logger.error("admin upload cleanup failed", {
            uploadId,
            attemptId,
            code: "STORAGE_CLEANUP_FAILED"
          });
        }
      }

      try {
        await this.store.markFailed({
          reservation,
          attemptId,
          code: brokerError.code,
          cleanupRequired,
          fileIDs: cleanupRequired ? uploadedFileIDs : []
        });
      } catch (markError) {
        this.logger.error("admin upload failure state could not be persisted", {
          uploadId,
          attemptId,
          code: "FAILURE_STATE_WRITE_FAILED"
        });
      }

      throw brokerError;
    } finally {
      if (artifact) {
        await artifact.cleanup().catch(() => {});
      }
    }
  }
}

module.exports = { UploadBroker };
