"use strict";

const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { UPLOAD_LEASE_MAX_AGE_MS } = require("../src/constants");
const {
  cleanupCandidateCloudPaths,
  hashTicket,
  validateClaimRecovery,
  validateReservation
} = require("../src/security");

const TEST_TICKET = "A".repeat(43);
const TEST_UPLOAD_ID = "1".repeat(32);
const TEST_OWNER_KEY = "2".repeat(24);

function reservationDocument(overrides = {}) {
  const now = Date.now();
  return {
    _id: TEST_UPLOAD_ID,
    ownerAdminId: "admin-one",
    ownerOpenid: "openid_admin_one",
    ownerKey: TEST_OWNER_KEY,
    assetType: "manuscript",
    originalFileName: "source.docx",
    relatedId: "article-001",
    extension: ".docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    declaredBytes: 4,
    maximumBytes: 100 * 1024 * 1024,
    cloudPath:
      `admin-staging/${TEST_OWNER_KEY}/${TEST_UPLOAD_ID}/source.docx`,
    status: "pending_upload",
    uploadTicketHash: hashTicket(TEST_TICKET),
    ticketStatus: "active",
    transportMode: "https-broker",
    transportStatus: "ticket_issued",
    ticketExpiresAt: new Date(now + 14 * 60 * 1000),
    createdAt: new Date(now - 1000),
    ...overrides
  };
}

class FakeStore {
  constructor(document = reservationDocument()) {
    this.document = { ...document };
    this.failures = [];
    this.finalizations = [];
  }

  async claim({ uploadId, ticketHash, attemptId }) {
    const reservation = validateReservation(
      this.document,
      uploadId,
      ticketHash,
      Date.now()
    );
    if (reservation.alreadyUploaded) {
      return reservation;
    }
    this.document.status = "uploading";
    this.document.uploadTicketHash = "";
    this.document.consumedUploadTicketHash = ticketHash;
    this.document.ticketStatus = "consumed";
    this.document.transportStatus = "uploading";
    this.document.uploadAttemptId = attemptId;
    this.document.uploadAttempt = Number(this.document.uploadAttempt || 0) + 1;
    this.document.uploadLeaseStartedAt = new Date();
    this.document.uploadLeaseExpiresAt = new Date(Math.min(
      Date.now() + UPLOAD_LEASE_MAX_AGE_MS,
      reservation.ticketExpiresAt.getTime()
    ));
    this.document.uploadCandidateCloudPaths =
      cleanupCandidateCloudPaths(reservation);
    this.document.uploadCandidateFileIDs = [];
    return reservation;
  }

  async recoverExpiredClaim({ uploadId, ticketHash }) {
    const recovery = validateClaimRecovery(
      this.document,
      uploadId,
      ticketHash,
      Date.now()
    );
    if (recovery.state === "not_claimed") {
      return { recovered: false };
    }
    if (recovery.state === "cleanup_completed") {
      return {
        recovered: true,
        cleanupCompleted: true,
        alreadyRecovered: true,
        candidateFileIDs: [],
        unverifiedCandidatePathCount: 0
      };
    }
    if (recovery.state === "recovered") {
      return {
        recovered: true,
        cleanupCompleted: false,
        alreadyRecovered: true,
        candidateFileIDs: recovery.candidateFileIDs,
        unverifiedCandidatePathCount:
          recovery.unverifiedCandidatePathCount
      };
    }

    this.document.status = "upload_failed_cleanup_required";
    this.document.transportStatus = "cleanup_required";
    this.document.validationStatus = "upload_failed";
    this.document.reviewStatus = "not_submitted";
    this.document.uploadFailureCode = recovery.failureCode;
    this.document.cleanupRequired = true;
    this.document.cleanupFileIDs = recovery.candidateFileIDs;
    this.document.cleanupCloudPaths = recovery.candidateCloudPaths;
    this.document.fileID = "";
    this.document.preparedFileID = "";
    this.document.preparedCloudPath = "";
    this.document.uploadCandidateCloudPaths = [];
    this.document.uploadCandidateFileIDs = [];
    this.document.uploadCleanupStatus = "pending";
    this.document.uploadCleanupConfirmedFileCount = 0;
    return {
      recovered: true,
      cleanupCompleted: false,
      alreadyRecovered: false,
      candidateFileIDs: recovery.candidateFileIDs,
      unverifiedCandidatePathCount:
        recovery.unverifiedCandidatePathCount
    };
  }

  async completeRecoveredCleanup({ uploadId, ticketHash, fileIDs, outcome }) {
    const recovery = validateClaimRecovery(
      this.document,
      uploadId,
      ticketHash,
      Date.now()
    );
    if (recovery.state === "cleanup_completed") {
      return { ok: true, alreadyCompleted: true };
    }
    if (recovery.state !== "recovered") {
      throw new Error("invalid cleanup completion state");
    }
    this.document.status = "upload_failed";
    this.document.transportStatus = "upload_failed";
    this.document.cleanupRequired = false;
    this.document.cleanupFileID = "";
    this.document.cleanupFileIDs = [];
    this.document.cleanupCloudPath = "";
    this.document.cleanupCloudPaths = [];
    this.document.fileID = "";
    this.document.preparedFileID = "";
    this.document.preparedCloudPath = "";
    this.document.uploadCandidateCloudPaths = [];
    this.document.uploadCandidateFileIDs = [];
    this.document.uploadCleanupStatus = "completed";
    this.document.uploadCleanupOutcome = outcome;
    this.document.uploadCleanupFileCount =
      recovery.confirmedCandidateCount + fileIDs.length;
    this.document.uploadCleanupUnverifiedPathCount =
      recovery.unverifiedCandidatePathCount;
    return { ok: true, alreadyCompleted: false };
  }

  async recordRecoveredCleanupFailure({
    uploadId,
    ticketHash,
    remainingFileIDs
  }) {
    const recovery = validateClaimRecovery(
      this.document,
      uploadId,
      ticketHash,
      Date.now()
    );
    if (recovery.state === "cleanup_completed") {
      return { ok: true, alreadyCompleted: true };
    }
    if (recovery.state !== "recovered") {
      throw new Error("invalid cleanup failure state");
    }
    this.document.cleanupRequired = true;
    this.document.cleanupFileID = remainingFileIDs[0] || "";
    this.document.cleanupFileIDs = [...remainingFileIDs];
    this.document.uploadCandidateFileIDs = [];
    this.document.uploadCleanupStatus = "pending";
    this.document.uploadCleanupConfirmedFileCount =
      recovery.confirmedCandidateCount +
      recovery.candidateFileIDs.length - remainingFileIDs.length;
    this.document.uploadCleanupLastFailureCode = "STORAGE_CLEANUP_FAILED";
    return { ok: true, alreadyCompleted: false };
  }

  async recordStorageWrite({ reservation, attemptId, fileID, cloudPath }) {
    if (
      this.document.status !== "uploading" ||
      this.document.uploadAttemptId !== attemptId ||
      !cleanupCandidateCloudPaths(reservation).includes(cloudPath)
    ) {
      throw new Error("invalid storage write state");
    }
    this.document.uploadCandidateFileIDs = Array.from(new Set([
      ...(this.document.uploadCandidateFileIDs || []),
      fileID
    ]));
  }

  async finalize(value) {
    if (
      this.document.status !== "uploading" ||
      this.document.uploadAttemptId !== value.attemptId
    ) {
      throw new Error("invalid finalize state");
    }
    this.document.status = "uploaded";
    this.document.transportStatus = "broker_uploaded";
    this.document.fileID = value.fileID;
    this.document.actualBytes = value.actualBytes;
    this.document.sha256 = value.sha256;
    this.document.inspection = value.inspection;
    this.document.preparedFileID = value.preparedFileID || "";
    this.document.preparedCloudPath = value.preparedCloudPath || "";
    this.document.validationStatus = "validated";
    this.document.reviewStatus = "not_submitted";
    this.finalizations.push(value);
  }

  async markFailed(value) {
    if (
      this.document.status === "uploading" &&
      this.document.uploadAttemptId === value.attemptId
    ) {
      this.document.status = value.cleanupRequired
        ? "upload_failed_cleanup_required"
        : "upload_failed";
    }
    this.failures.push(value);
    return { ok: true };
  }
}

function artifact(bytes = 4) {
  return {
    path: "private-temp-artifact",
    actualBytes: bytes,
    sha256: "a".repeat(64),
    createReadStream: () => new PassThrough(),
    cleanupCalls: 0,
    async cleanup() {
      this.cleanupCalls += 1;
    }
  };
}

function inspection(overrides = {}) {
  return {
    schemaVersion: 1,
    assetType: "manuscript",
    extension: ".docx",
    format: "docx",
    actualBytes: 4,
    signatureValid: true,
    needsManualStructure: true,
    metadata: { previewParagraphCount: 1 },
    ...overrides
  };
}

function requestStub() {
  const request = new EventEmitter();
  request.headers = {};
  return request;
}

function responseStub() {
  const emitter = new EventEmitter();
  emitter.headers = {};
  emitter.setHeader = (name, value) => {
    emitter.headers[String(name).toLowerCase()] = value;
  };
  emitter.end = (body) => {
    emitter.body = body;
    emitter.emit("ended");
  };
  return emitter;
}

module.exports = {
  FakeStore,
  TEST_OWNER_KEY,
  TEST_TICKET,
  TEST_UPLOAD_ID,
  artifact,
  inspection,
  requestStub,
  reservationDocument,
  responseStub
};
