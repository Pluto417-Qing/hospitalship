"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CloudBaseReservationStore } = require("../src/reservation-store");
const { hashTicket, validateReservation } = require("../src/security");
const {
  TEST_TICKET,
  TEST_UPLOAD_ID,
  inspection,
  reservationDocument
} = require("./helpers");

function databaseFixture(document, account = null) {
  const updates = [];
  const reference = {
    async get() {
      return { data: document };
    },
    async update({ data }) {
      updates.push(data);
      Object.assign(document, data);
      return { updated: 1 };
    }
  };
  const transaction = {
    collection(name) {
      if (name === "adminAccounts") {
        return {
          doc(id) {
            assert.equal(id, document.ownerAdminId);
            return {
              async get() {
                return { data: account };
              }
            };
          }
        };
      }
      assert.equal(name, "adminUploads");
      return {
        doc(id) {
          assert.equal(id, TEST_UPLOAD_ID);
          return reference;
        }
      };
    }
  };
  const database = {
    serverDate() {
      return new Date("2026-07-15T00:00:00.000Z");
    },
    async runTransaction(callback) {
      return { result: await callback(transaction) };
    }
  };
  return { database, updates };
}

test("claim stores a bounded lease, attempt number and exact target paths", async () => {
  const nowMs = Date.now();
  const document = reservationDocument({
    ticketIssuedAt: new Date(nowMs - 1000),
    ticketExpiresAt: new Date(nowMs + 5 * 60 * 1000)
  });
  const account = {
    _id: document.ownerAdminId,
    openid: document.ownerOpenid,
    status: "active",
    roles: ["uploader"]
  };
  const { database } = databaseFixture(document, account);
  const store = new CloudBaseReservationStore(database, {
    now: () => nowMs,
    uploadLeaseMs: 60 * 1000
  });

  await store.claim({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET),
    attemptId: "3".repeat(32)
  });

  assert.equal(document.status, "uploading");
  assert.equal(document.ticketStatus, "consumed");
  assert.equal(document.uploadAttempt, 1);
  assert.equal(document.uploadAttemptId, "3".repeat(32));
  assert.equal(document.uploadLeaseStartedAt.getTime(), nowMs);
  assert.equal(document.uploadLeaseExpiresAt.getTime(), nowMs + 60 * 1000);
  assert.deepEqual(document.uploadCandidateCloudPaths, [document.cloudPath]);
  assert.deepEqual(document.uploadCandidateFileIDs, []);
});

test("finalize atomically stores validated inspection and prepared asset state", async () => {
  const document = reservationDocument({
    assetType: "audio",
    originalFileName: "reading.mp3",
    relatedId: "article-001",
    extension: ".mp3",
    mimeType: "audio/mpeg",
    maximumBytes: 500 * 1024 * 1024,
    cloudPath:
      `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.mp3`
  });
  const reservation = validateReservation(
    document,
    TEST_UPLOAD_ID,
    hashTicket(TEST_TICKET),
    Date.now()
  );
  document.status = "uploading";
  document.uploadAttemptId = "3".repeat(32);
  document.uploadLeaseStartedAt = new Date(Date.now() - 1000);
  document.uploadLeaseExpiresAt = new Date(Date.now() + 60 * 1000);
  const { database, updates } = databaseFixture(document);
  const store = new CloudBaseReservationStore(database);
  const preparedCloudPath =
    `published/audio/article-001/assets/${TEST_UPLOAD_ID}/primary.mp3`;
  const stagingFileID = `cloud://test-env.bucket/${document.cloudPath}`;
  const preparedFileID = `cloud://test-env.bucket/${preparedCloudPath}`;
  const validation = inspection({
    assetType: "audio",
    extension: ".mp3",
    format: "mp3",
    metadata: { signature: "id3" }
  });

  await store.finalize({
    reservation,
    attemptId: document.uploadAttemptId,
    fileID: stagingFileID,
    actualBytes: 4,
    sha256: "a".repeat(64),
    inspection: validation,
    preparedFileID,
    preparedCloudPath
  });

  assert.equal(updates.length, 1);
  assert.equal(document.status, "uploaded");
  assert.equal(document.transportStatus, "broker_uploaded");
  assert.equal(document.validationStatus, "validated");
  assert.equal(document.reviewStatus, "not_submitted");
  assert.deepEqual(document.inspection, validation);
  assert.equal(document.fileID, stagingFileID);
  assert.equal(document.preparedFileID, preparedFileID);
  assert.equal(document.preparedCloudPath, preparedCloudPath);
});

test("storage write acknowledgements persist only exact candidate file IDs", async () => {
  const document = reservationDocument();
  const reservation = validateReservation(
    document,
    TEST_UPLOAD_ID,
    hashTicket(TEST_TICKET),
    Date.now()
  );
  document.status = "uploading";
  document.transportStatus = "uploading";
  document.ticketStatus = "consumed";
  document.uploadAttemptId = "3".repeat(32);
  document.uploadCandidateFileIDs = [];
  const { database } = databaseFixture(document);
  const store = new CloudBaseReservationStore(database);
  const fileID = `cloud://test-env.bucket/${document.cloudPath}`;

  await store.recordStorageWrite({
    reservation,
    attemptId: document.uploadAttemptId,
    fileID,
    cloudPath: document.cloudPath
  });
  assert.deepEqual(document.uploadCandidateFileIDs, [fileID]);

  await assert.rejects(
    store.recordStorageWrite({
      reservation,
      attemptId: document.uploadAttemptId,
      fileID: "cloud://test-env.bucket/published/other.pdf",
      cloudPath: document.cloudPath
    }),
    (error) => error.code === "STORAGE_RESULT_MISMATCH"
  );
});

test("an expired claim is quarantined once with exact cleanup candidates", async () => {
  const nowMs = Date.now();
  const sourcePath =
    `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.mp3`;
  const preparedPath =
    `published/audio/article-001/assets/${TEST_UPLOAD_ID}/primary.mp3`;
  const sourceFileID = `cloud://test-env.bucket/${sourcePath}`;
  const document = reservationDocument({
    assetType: "audio",
    originalFileName: "reading.mp3",
    relatedId: "article-001",
    extension: ".mp3",
    mimeType: "audio/mpeg",
    maximumBytes: 500 * 1024 * 1024,
    cloudPath: sourcePath,
    status: "uploading",
    ticketStatus: "consumed",
    transportStatus: "uploading",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    uploadAttemptId: "3".repeat(32),
    uploadAttempt: 1,
    uploadLeaseStartedAt: new Date(nowMs - 2 * 60 * 1000),
    uploadLeaseExpiresAt: new Date(nowMs - 1000),
    uploadCandidateCloudPaths: [sourcePath, preparedPath],
    uploadCandidateFileIDs: [
      sourceFileID,
      "cloud://test-env.bucket/published/not-this-upload.mp3"
    ]
  });
  const { database, updates } = databaseFixture(document);
  const store = new CloudBaseReservationStore(database, {
    now: () => nowMs
  });

  const first = await store.recoverExpiredClaim({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET)
  });
  const replay = await store.recoverExpiredClaim({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET)
  });

  assert.equal(first.recovered, true);
  assert.equal(first.alreadyRecovered, false);
  assert.deepEqual(first.candidateFileIDs, [sourceFileID]);
  assert.equal(first.unverifiedCandidatePathCount, 1);
  assert.equal(replay.recovered, true);
  assert.equal(replay.alreadyRecovered, true);
  assert.deepEqual(replay.candidateFileIDs, [sourceFileID]);
  assert.equal(updates.length, 1);
  assert.equal(document.status, "upload_failed_cleanup_required");
  assert.equal(document.transportStatus, "cleanup_required");
  assert.equal(document.uploadFailureCode, "UPLOAD_LEASE_EXPIRED");
  assert.equal(document.cleanupRequired, true);
  assert.deepEqual(document.cleanupCloudPaths, [sourcePath, preparedPath]);
  assert.deepEqual(document.cleanupFileIDs, [sourceFileID]);

  const completed = await store.completeRecoveredCleanup({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET),
    fileIDs: [sourceFileID],
    outcome: "recorded_files_deleted_unverified_paths"
  });
  const completedReplay = await store.recoverExpiredClaim({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET)
  });

  assert.equal(completed.alreadyCompleted, false);
  assert.equal(completedReplay.cleanupCompleted, true);
  assert.equal(document.status, "upload_failed");
  assert.equal(document.transportStatus, "upload_failed");
  assert.equal(document.cleanupRequired, false);
  assert.deepEqual(document.cleanupFileIDs, []);
  assert.deepEqual(document.cleanupCloudPaths, []);
  assert.equal(document.uploadFailureCode, "UPLOAD_LEASE_EXPIRED");
  assert.equal(
    document.uploadCleanupOutcome,
    "recorded_files_deleted_unverified_paths"
  );
  assert.equal(document.uploadCleanupUnverifiedPathCount, 1);
});

test("a live consumed-ticket lease cannot be recovered or claimed again", async () => {
  const nowMs = Date.now();
  const document = reservationDocument({
    status: "uploading",
    ticketStatus: "consumed",
    transportStatus: "uploading",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    uploadAttemptId: "3".repeat(32),
    uploadAttempt: 1,
    uploadLeaseStartedAt: new Date(nowMs - 1000),
    uploadLeaseExpiresAt: new Date(nowMs + 60 * 1000)
  });
  const { database, updates } = databaseFixture(document);
  const store = new CloudBaseReservationStore(database, {
    now: () => nowMs
  });

  await assert.rejects(
    store.recoverExpiredClaim({
      uploadId: TEST_UPLOAD_ID,
      ticketHash: hashTicket(TEST_TICKET)
    }),
    (error) => error.code === "UPLOAD_IN_PROGRESS"
  );
  assert.equal(updates.length, 0);
  assert.equal(document.status, "uploading");
});

test("a failed recovery deletion transaction retains only exact pending IDs", async () => {
  const nowMs = Date.now();
  const document = reservationDocument({
    status: "uploading",
    ticketStatus: "consumed",
    transportStatus: "uploading",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    uploadAttemptId: "3".repeat(32),
    uploadAttempt: 1,
    uploadLeaseStartedAt: new Date(nowMs - 2 * 60 * 1000),
    uploadLeaseExpiresAt: new Date(nowMs - 1000)
  });
  const fileID = `cloud://test-env.bucket/${document.cloudPath}`;
  document.uploadCandidateFileIDs = [fileID];
  const { database } = databaseFixture(document);
  const store = new CloudBaseReservationStore(database, { now: () => nowMs });

  await store.recoverExpiredClaim({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET)
  });
  await store.recordRecoveredCleanupFailure({
    uploadId: TEST_UPLOAD_ID,
    ticketHash: hashTicket(TEST_TICKET),
    remainingFileIDs: [fileID]
  });

  assert.equal(document.status, "upload_failed_cleanup_required");
  assert.equal(document.cleanupRequired, true);
  assert.deepEqual(document.cleanupFileIDs, [fileID]);
  assert.equal(
    document.uploadCleanupLastFailureCode,
    "STORAGE_CLEANUP_FAILED"
  );
  await assert.rejects(
    store.recordRecoveredCleanupFailure({
      uploadId: TEST_UPLOAD_ID,
      ticketHash: hashTicket(TEST_TICKET),
      remainingFileIDs: ["cloud://test-env.bucket/published/other.pdf"]
    }),
    (error) => error.code === "UPLOAD_CLEANUP_RESULT_INVALID"
  );
});
