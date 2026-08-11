"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectArtifact } = require("../src/artifact-inspector");
const { UploadBroker } = require("../src/broker");
const {
  KNOWN_CHAPTER_SOURCE_PDF_SHA256S
} = require("../src/constants");
const { BrokerError } = require("../src/errors");
const { hashTicket } = require("../src/security");
const {
  FakeStore,
  TEST_TICKET,
  TEST_UPLOAD_ID,
  artifact,
  inspection,
  requestStub,
  reservationDocument
} = require("./helpers");

function inspectionFor(document, bytes) {
  const format = document.extension === ".jpg"
    ? "jpeg"
    : document.extension.slice(1);
  return inspection({
    assetType: document.assetType,
    extension: document.extension,
    format,
    actualBytes: bytes,
    metadata: {}
  });
}

function successFixture(options = {}) {
  const store = options.store || new FakeStore();
  const receivedArtifact = options.artifact || artifact();
  const receiver = options.receiver || {
    calls: 0,
    async receive() {
      this.calls += 1;
      return receivedArtifact;
    }
  };
  const storage = options.storage || {
    uploads: [],
    deletes: [],
    async uploadFile(value) {
      this.uploads.push(value);
      return { fileID: `cloud://test-env.bucket/${value.cloudPath}` };
    },
    async deleteFile(value) {
      this.deletes.push(value);
      return {
        fileList: value.fileList.map((fileID) => ({ fileID, code: "SUCCESS" }))
      };
    }
  };
  const broker = new UploadBroker({
    store,
    storage,
    receiver,
    inspectArtifact: options.inspectArtifact || (async () =>
      inspectionFor(store.document, receivedArtifact.actualBytes)),
    createAttemptId: () => "3".repeat(32),
    logger: { error() {} }
  });
  return { broker, receivedArtifact, receiver, storage, store };
}

function expiredClaimDocument(overrides = {}) {
  const nowMs = Date.now();
  const base = reservationDocument();
  return reservationDocument({
    status: "uploading",
    ticketStatus: "consumed",
    transportStatus: "uploading",
    uploadTicketHash: "",
    consumedUploadTicketHash: hashTicket(TEST_TICKET),
    uploadAttemptId: "9".repeat(32),
    uploadAttempt: 1,
    uploadLeaseStartedAt: new Date(nowMs - 2 * 60 * 1000),
    uploadLeaseExpiresAt: new Date(nowMs - 1000),
    uploadCandidateCloudPaths: [base.cloudPath],
    uploadCandidateFileIDs: [],
    ...overrides
  });
}

test("uploads only to the reserved path and persists a non-published result", async () => {
  const fixture = successFixture();
  const result = await fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });

  assert.equal(result.success, true);
  assert.equal(result.status, "uploaded");
  assert.equal(result.transportStatus, "broker_uploaded");
  assert.equal(result.reviewStatus, "not_submitted");
  assert.equal(result.validationStatus, "validated");
  assert.equal(result.published, false);
  assert.equal(Object.hasOwn(result, "fileID"), false);
  assert.equal(Object.hasOwn(result, "cloudPath"), false);
  assert.equal(Object.hasOwn(result, "preparedFileID"), false);
  assert.equal(Object.hasOwn(result, "preparedCloudPath"), false);
  assert.equal(fixture.storage.uploads.length, 1);
  assert.equal(
    fixture.storage.uploads[0].cloudPath,
    reservationDocument().cloudPath
  );
  assert.equal(fixture.store.finalizations.length, 1);
  assert.equal(fixture.store.document.status, "uploaded");
  assert.equal(fixture.store.document.validationStatus, "validated");
  assert.equal(fixture.store.document.reviewStatus, "not_submitted");
  assert.equal(fixture.store.document.inspection.signatureValid, true);
  assert.equal(fixture.receivedArtifact.cleanupCalls, 1);
  assert.equal(Object.hasOwn(result, "ownerOpenid"), false);
});

test("two concurrent requests cannot consume the same ticket", async () => {
  const fixture = successFixture();
  const request = () => fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });
  const settled = await Promise.allSettled([request(), request()]);

  assert.equal(settled.some((item) => item.status === "fulfilled"), true);
  assert.equal(fixture.storage.uploads.length, 1);
  const rejection = settled.find((item) => item.status === "rejected");
  if (rejection) {
    assert.equal(
      ["UPLOAD_IN_PROGRESS", "UPLOAD_TICKET_ALREADY_USED"].includes(
        rejection.reason.code
      ),
      true
    );
  } else {
    assert.equal(
      settled.filter((item) => item.value.alreadyUploaded === true).length,
      1
    );
  }
});

test("a retry after a crashed claim quarantines targets and never uploads again", async () => {
  const document = expiredClaimDocument();
  const fixture = successFixture({ store: new FakeStore(document) });
  const retry = () => fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });

  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_INTERRUPTED"
  );
  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_INTERRUPTED"
  );

  assert.equal(fixture.store.document.status, "upload_failed");
  assert.equal(fixture.store.document.transportStatus, "upload_failed");
  assert.equal(fixture.store.document.uploadFailureCode, "UPLOAD_LEASE_EXPIRED");
  assert.equal(fixture.store.document.cleanupRequired, false);
  assert.deepEqual(fixture.store.document.cleanupCloudPaths, []);
  assert.equal(
    fixture.store.document.uploadCleanupOutcome,
    "no_recorded_file_id_unverified"
  );
  assert.equal(fixture.receiver.calls, 0);
  assert.equal(fixture.storage.uploads.length, 0);
  assert.equal(fixture.storage.deletes.length, 0);
});

test("recovery deletes exact recorded files once and completes cleanup atomically", async () => {
  const cloudPath = reservationDocument().cloudPath;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  const fixture = successFixture({
    store: new FakeStore(expiredClaimDocument({
      uploadCandidateFileIDs: [fileID]
    }))
  });
  const retry = () => fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });

  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_INTERRUPTED"
  );
  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_INTERRUPTED"
  );

  assert.deepEqual(fixture.storage.deletes, [{ fileList: [fileID] }]);
  assert.equal(fixture.store.document.status, "upload_failed");
  assert.equal(fixture.store.document.cleanupRequired, false);
  assert.deepEqual(fixture.store.document.cleanupFileIDs, []);
  assert.deepEqual(fixture.store.document.cleanupCloudPaths, []);
  assert.equal(
    fixture.store.document.uploadCleanupOutcome,
    "deleted_confirmed"
  );
  assert.equal(fixture.store.document.uploadFailureCode, "UPLOAD_LEASE_EXPIRED");
  assert.equal(fixture.receiver.calls, 0);
  assert.equal(fixture.storage.uploads.length, 0);
});

test("recovery keeps only unconfirmed file IDs quarantined when deletion fails", async () => {
  const cloudPath = reservationDocument().cloudPath;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  const storage = {
    uploads: [],
    deletes: [],
    async uploadFile(value) {
      this.uploads.push(value);
      return { fileID: `cloud://test-env.bucket/${value.cloudPath}` };
    },
    async deleteFile(value) {
      this.deletes.push(value);
      return {
        fileList: value.fileList.map((item) => ({
          fileID: item,
          code: "STORAGE_PERMISSION_DENIED"
        }))
      };
    }
  };
  const fixture = successFixture({
    store: new FakeStore(expiredClaimDocument({
      uploadCandidateFileIDs: [fileID]
    })),
    storage
  });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_FAILED_CLEANUP_REQUIRED"
  );

  assert.deepEqual(storage.deletes, [{ fileList: [fileID] }]);
  assert.equal(fixture.store.document.status, "upload_failed_cleanup_required");
  assert.equal(fixture.store.document.transportStatus, "cleanup_required");
  assert.equal(fixture.store.document.cleanupRequired, true);
  assert.deepEqual(fixture.store.document.cleanupFileIDs, [fileID]);
  assert.equal(
    fixture.store.document.uploadCleanupLastFailureCode,
    "STORAGE_CLEANUP_FAILED"
  );
  assert.equal(fixture.receiver.calls, 0);
  assert.equal(storage.uploads.length, 0);
});

test("recovery treats an exact already-absent file as an idempotent deletion", async () => {
  const cloudPath = reservationDocument().cloudPath;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  const store = new FakeStore(expiredClaimDocument({
    uploadCandidateFileIDs: [fileID]
  }));
  const originalComplete = store.completeRecoveredCleanup.bind(store);
  let completionCalls = 0;
  store.completeRecoveredCleanup = async (value) => {
    completionCalls += 1;
    if (completionCalls === 1) {
      throw new Error("simulated database outage after storage deletion");
    }
    return originalComplete(value);
  };
  const storage = {
    uploads: [],
    deletes: [],
    async uploadFile() {
      throw new Error("must not upload during recovery");
    },
    async deleteFile(value) {
      this.deletes.push(value);
      return {
        fileList: value.fileList.map((item) => ({
          fileID: item,
          code: this.deletes.length === 1
            ? "SUCCESS"
            : "STORAGE_FILE_NONEXIST"
        }))
      };
    }
  };
  const fixture = successFixture({ store, storage });
  const retry = () => fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });

  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_FAILED_CLEANUP_REQUIRED"
  );
  await assert.rejects(
    retry(),
    (error) => error.code === "UPLOAD_INTERRUPTED"
  );

  assert.equal(storage.deletes.length, 2);
  assert.equal(store.document.status, "upload_failed");
  assert.equal(store.document.uploadCleanupOutcome, "deleted_confirmed");
});

test("a lost success response can be recovered idempotently with the consumed ticket", async () => {
  const fixture = successFixture();
  const request = () => fixture.broker.process({
    uploadId: TEST_UPLOAD_ID,
    ticket: TEST_TICKET,
    request: requestStub(),
    contentLength: null
  });
  const first = await request();
  const recovered = await request();

  assert.equal(first.success, true);
  assert.equal(recovered.success, true);
  assert.equal(recovered.alreadyUploaded, true);
  assert.equal(recovered.validationStatus, "validated");
  assert.equal(recovered.reviewStatus, "not_submitted");
  assert.equal(Object.hasOwn(recovered, "fileID"), false);
  assert.equal(Object.hasOwn(recovered, "cloudPath"), false);
  assert.equal(Object.hasOwn(recovered, "preparedFileID"), false);
  assert.equal(Object.hasOwn(recovered, "preparedCloudPath"), false);
  assert.equal(fixture.storage.uploads.length, 1);
  assert.equal(fixture.receiver.calls, 1);
});

test("stream validation failure consumes the ticket and marks the task failed", async () => {
  const receiver = {
    async receive() {
      throw new BrokerError(
        "UPLOAD_SIZE_MISMATCH",
        422,
        "size mismatch",
        { markUploadFailed: true }
      );
    }
  };
  const fixture = successFixture({ receiver });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_SIZE_MISMATCH"
  );
  assert.equal(fixture.storage.uploads.length, 0);
  assert.equal(fixture.store.document.status, "upload_failed");
  assert.equal(fixture.store.failures[0].code, "UPLOAD_SIZE_MISMATCH");
  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_TICKET_ALREADY_USED"
  );
});

test("storage failure never finalizes or publishes an upload", async () => {
  const storage = {
    uploads: 0,
    async uploadFile() {
      this.uploads += 1;
      throw new Error("mock storage unavailable");
    },
    async deleteFile() {
      throw new Error("must not be called without a known file id");
    }
  };
  const fixture = successFixture({ storage });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_BROKER_FAILED"
  );
  assert.equal(fixture.store.finalizations.length, 0);
  assert.equal(fixture.store.document.status, "upload_failed");
});

test("rejects a false DOCX extension before any storage write", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "upload-broker-magic-")
  );
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "artifact.docx");
  await fsPromises.writeFile(filePath, Buffer.from("NOPE", "ascii"));
  const receivedArtifact = artifact();
  receivedArtifact.path = filePath;
  receivedArtifact.createReadStream = () => fs.createReadStream(filePath);
  const fixture = successFixture({
    artifact: receivedArtifact,
    inspectArtifact
  });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "DOCX_ARCHIVE_INVALID"
  );
  assert.equal(fixture.storage.uploads.length, 0);
  assert.equal(fixture.store.document.status, "upload_failed");
  assert.equal(fixture.store.failures[0].code, "DOCX_ARCHIVE_INVALID");
});

test("derives exact invisible prepared paths for audio, full book and topic images", async () => {
  const cases = [
    {
      document: reservationDocument({
        assetType: "audio",
        originalFileName: "reading.mp3",
        relatedId: "article-001",
        extension: ".mp3",
        mimeType: "audio/mpeg",
        maximumBytes: 500 * 1024 * 1024,
        cloudPath: `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.mp3`
      }),
      preparedPath:
        `published/audio/article-001/assets/${TEST_UPLOAD_ID}/primary.mp3`
    },
    {
      document: reservationDocument({
        assetType: "full-book-pdf",
        originalFileName: "hospital-ship.pdf",
        relatedId: "hospital-ship",
        extension: ".pdf",
        mimeType: "application/pdf",
        maximumBytes: 50 * 1024 * 1024,
        cloudPath:
          `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.pdf`
      }),
      preparedPath:
        `protected/books/hospital-ship/assets/${TEST_UPLOAD_ID}/hospital-ship.pdf`
    },
    {
      document: reservationDocument({
        assetType: "topic-image",
        originalFileName: "cover.png",
        relatedId: "topic-001",
        extension: ".png",
        mimeType: "image/png",
        maximumBytes: 20 * 1024 * 1024,
        cloudPath: `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.png`
      }),
      preparedPath:
        `protected/special-topics/topic-001/assets/${TEST_UPLOAD_ID}/images/${TEST_UPLOAD_ID}.png`
    }
  ];

  for (const item of cases) {
    const fixture = successFixture({ store: new FakeStore(item.document) });
    const result = await fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    });

    assert.equal(result.validationStatus, "validated");
    assert.deepEqual(
      fixture.storage.uploads.map((upload) => upload.cloudPath),
      [item.document.cloudPath, item.preparedPath]
    );
    assert.equal(
      fixture.store.finalizations[0].preparedCloudPath,
      item.preparedPath
    );
    assert.equal(
      fixture.store.document.preparedFileID,
      `cloud://test-env.bucket/${item.preparedPath}`
    );
  }
});

test("rejects the known chapter example before any complete-book storage write", async () => {
  const document = reservationDocument({
    assetType: "full-book-pdf",
    originalFileName: "renamed-complete-book.pdf",
    relatedId: "hospital-ship",
    extension: ".pdf",
    mimeType: "application/pdf",
    maximumBytes: 50 * 1024 * 1024,
    cloudPath:
      `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.pdf`
  });
  const receivedArtifact = artifact();
  receivedArtifact.sha256 = KNOWN_CHAPTER_SOURCE_PDF_SHA256S[0];
  const fixture = successFixture({
    store: new FakeStore(document),
    artifact: receivedArtifact
  });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "BOOK_CHAPTER_SOURCE_NOT_COMPLETE"
  );
  assert.equal(fixture.storage.uploads.length, 0);
  assert.equal(fixture.store.document.status, "upload_failed");
  assert.equal(
    fixture.store.failures[0].code,
    "BOOK_CHAPTER_SOURCE_NOT_COMPLETE"
  );
});

test("a finalize failure cleans both staging and prepared files exactly", async () => {
  const document = reservationDocument({
    assetType: "audio",
    originalFileName: "reading.mp3",
    relatedId: "article-001",
    extension: ".mp3",
    mimeType: "audio/mpeg",
    maximumBytes: 500 * 1024 * 1024,
    cloudPath: `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.mp3`
  });
  const store = new FakeStore(document);
  store.finalize = async () => {
    throw new BrokerError("UPLOAD_STATE_CHANGED", 409, "changed", {
      markUploadFailed: true
    });
  };
  const fixture = successFixture({ store });
  const preparedPath =
    `published/audio/article-001/assets/${TEST_UPLOAD_ID}/primary.mp3`;

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_STATE_CHANGED"
  );
  assert.deepEqual(fixture.storage.deletes, [{
    fileList: [
      `cloud://test-env.bucket/${document.cloudPath}`,
      `cloud://test-env.bucket/${preparedPath}`
    ]
  }]);
  assert.equal(store.failures[0].cleanupRequired, false);
  assert.deepEqual(store.failures[0].fileIDs, []);
});

test("a prepared upload failure rolls back the staging file", async () => {
  const document = reservationDocument({
    assetType: "audio",
    originalFileName: "reading.mp3",
    relatedId: "article-001",
    extension: ".mp3",
    mimeType: "audio/mpeg",
    maximumBytes: 500 * 1024 * 1024,
    cloudPath: `admin-staging/${"2".repeat(24)}/${TEST_UPLOAD_ID}/source.mp3`
  });
  const storage = {
    uploads: [],
    deletes: [],
    async uploadFile(value) {
      this.uploads.push(value.cloudPath);
      if (this.uploads.length === 2) {
        throw new Error("prepared storage unavailable");
      }
      return { fileID: `cloud://test-env.bucket/${value.cloudPath}` };
    },
    async deleteFile(value) {
      this.deletes.push(value);
      return {
        fileList: value.fileList.map((fileID) => ({ fileID, code: "SUCCESS" }))
      };
    }
  };
  const fixture = successFixture({
    store: new FakeStore(document),
    storage
  });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_BROKER_FAILED"
  );
  assert.deepEqual(storage.deletes, [{
    fileList: [`cloud://test-env.bucket/${document.cloudPath}`]
  }]);
  assert.equal(fixture.store.document.status, "upload_failed");
});

test("a failure after storage upload deletes only the exact uploaded file", async () => {
  const store = new FakeStore();
  store.finalize = async () => {
    throw new BrokerError("UPLOAD_STATE_CHANGED", 409, "changed", {
      markUploadFailed: true
    });
  };
  const fixture = successFixture({ store });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_STATE_CHANGED"
  );
  assert.deepEqual(fixture.storage.deletes, [{
    fileList: [`cloud://test-env.bucket/${reservationDocument().cloudPath}`]
  }]);
});

test("cleanup accepts the CloudBase numeric status success shape", async () => {
  const store = new FakeStore();
  store.finalize = async () => {
    throw new BrokerError("UPLOAD_STATE_CHANGED", 409, "changed");
  };
  const storage = {
    async uploadFile(value) {
      return { fileID: `cloud://test-env.bucket/${value.cloudPath}` };
    },
    async deleteFile({ fileList }) {
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    }
  };
  const fixture = successFixture({ store, storage });

  await assert.rejects(
    fixture.broker.process({
      uploadId: TEST_UPLOAD_ID,
      ticket: TEST_TICKET,
      request: requestStub(),
      contentLength: null
    }),
    (error) => error.code === "UPLOAD_STATE_CHANGED"
  );
  assert.equal(store.failures[0].cleanupRequired, false);
});
