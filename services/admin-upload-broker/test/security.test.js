"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BrokerError } = require("../src/errors");
const {
  assertExactCloudFileID,
  hashTicket,
  readBearerTicket,
  validateClaimRecovery,
  validateReservation
} = require("../src/security");
const {
  TEST_TICKET,
  TEST_UPLOAD_ID,
  reservationDocument
} = require("./helpers");

test("validates one-time ticket, owner, policy and exact private path", () => {
  const document = reservationDocument();
  const result = validateReservation(
    document,
    TEST_UPLOAD_ID,
    hashTicket(TEST_TICKET),
    Date.now()
  );

  assert.equal(result.cloudPath, document.cloudPath);
  assert.equal(result.ownerAdminId, document.ownerAdminId);
  assert.equal(result.declaredBytes, 4);
  assert.equal(result.originalFileName, document.originalFileName);
  assert.equal(result.relatedId, document.relatedId);
});

test("caps complete-book PDF reservations at 50 MiB", () => {
  const cloudPath =
    `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.pdf`;
  const valid = reservationDocument({
    assetType: "full-book-pdf",
    originalFileName: "complete-book.pdf",
    relatedId: "hospital-ship",
    extension: ".pdf",
    mimeType: "application/pdf",
    declaredBytes: 50 * 1024 * 1024,
    maximumBytes: 50 * 1024 * 1024,
    cloudPath
  });
  assert.doesNotThrow(() =>
    validateReservation(
      valid,
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      Date.now()
    )
  );

  for (const document of [
    { ...valid, declaredBytes: 50 * 1024 * 1024 + 1 },
    { ...valid, maximumBytes: 500 * 1024 * 1024 }
  ]) {
    assert.throws(
      () => validateReservation(
        document,
        TEST_UPLOAD_ID,
        hashTicket(TEST_TICKET),
        Date.now()
      ),
      (error) =>
        error instanceof BrokerError && error.code === "INVALID_UPLOAD_POLICY"
    );
  }
});

test("rejects uncontrolled original file names and related identifiers", () => {
  for (const document of [
    reservationDocument({ originalFileName: "../source.pdf" }),
    reservationDocument({ originalFileName: "source.pdf" }),
    reservationDocument({ originalFileName: " source.pdf" }),
    reservationDocument({ relatedId: "Topic/../../published" }),
    reservationDocument({ relatedId: "UPPERCASE" })
  ]) {
    assert.throws(
      () => validateReservation(
        document,
        TEST_UPLOAD_ID,
        hashTicket(TEST_TICKET),
        Date.now()
      ),
      (error) =>
        error instanceof BrokerError && error.code === "INVALID_UPLOAD_METADATA"
    );
  }
});

test("rejects owner mismatch and path traversal before receiving bytes", () => {
  assert.throws(
    () => validateReservation(
      reservationDocument({ ownerOpenid: "not a valid openid!" }),
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      Date.now()
    ),
    (error) => error instanceof BrokerError && error.code === "UPLOAD_OWNER_MISMATCH"
  );

  assert.throws(
    () => validateReservation(
      reservationDocument({ cloudPath: "admin-staging/../../published/file.pdf" }),
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      Date.now()
    ),
    (error) => error instanceof BrokerError && error.code === "INVALID_UPLOAD_TARGET"
  );
});

test("enforces a maximum ticket lifetime of fifteen minutes", () => {
  const issuedAt = new Date(Date.now() - 1000);
  assert.throws(
    () => validateReservation(
      reservationDocument({
        ticketIssuedAt: issuedAt,
        ticketExpiresAt: new Date(issuedAt.getTime() + 15 * 60 * 1000 + 1)
      }),
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      Date.now()
    ),
    (error) => error instanceof BrokerError && error.code === "UPLOAD_TICKET_EXPIRED"
  );
});

test("does not replay a completed upload after the original ticket expires", () => {
  const document = reservationDocument({
    status: "uploaded",
    ticketStatus: "consumed",
    transportStatus: "broker_uploaded",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    ticketExpiresAt: new Date(Date.now() - 1),
    fileID: `cloud://test-env.bucket/${reservationDocument().cloudPath}`,
    actualBytes: 4,
    sha256: "a".repeat(64)
  });

  assert.throws(
    () => validateReservation(
      document,
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      Date.now()
    ),
    (error) => error instanceof BrokerError && error.code === "UPLOAD_TICKET_EXPIRED"
  );
});

test("an expired consumed claim may only be recovered into cleanup quarantine", () => {
  const nowMs = Date.now();
  const document = reservationDocument({
    status: "uploading",
    ticketStatus: "consumed",
    transportStatus: "uploading",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    ticketIssuedAt: new Date(nowMs - 10 * 60 * 1000),
    ticketExpiresAt: new Date(nowMs - 60 * 1000),
    uploadAttemptId: "3".repeat(32),
    uploadAttempt: 1,
    uploadLeaseStartedAt: new Date(nowMs - 3 * 60 * 1000),
    uploadLeaseExpiresAt: new Date(nowMs - 2 * 60 * 1000)
  });

  const recovery = validateClaimRecovery(
    document,
    TEST_UPLOAD_ID,
    hashTicket(TEST_TICKET),
    nowMs
  );

  assert.equal(recovery.state, "expired");
  assert.equal(recovery.failureCode, "UPLOAD_LEASE_EXPIRED");
  assert.deepEqual(recovery.candidateCloudPaths, [document.cloudPath]);
  assert.equal(recovery.reservation.alreadyUploaded, false);
  assert.throws(
    () => validateReservation(
      document,
      TEST_UPLOAD_ID,
      hashTicket(TEST_TICKET),
      nowMs
    ),
    (error) => error.code === "UPLOAD_TICKET_ALREADY_USED"
  );
});

test("accepts only a strict Bearer ticket and exact CloudBase file path", () => {
  assert.equal(readBearerTicket(`Bearer ${TEST_TICKET}`), TEST_TICKET);
  assert.throws(
    () => readBearerTicket(`bearer ${TEST_TICKET}`),
    (error) => error.code === "INVALID_UPLOAD_TICKET"
  );

  const cloudPath = reservationDocument().cloudPath;
  assert.doesNotThrow(() =>
    assertExactCloudFileID(`cloud://test-env.bucket/${cloudPath}`, cloudPath)
  );
  assert.throws(
    () => assertExactCloudFileID(
      "cloud://test-env.bucket/published/source.pdf",
      cloudPath
    ),
    (error) => error.code === "STORAGE_RESULT_MISMATCH"
  );
});
