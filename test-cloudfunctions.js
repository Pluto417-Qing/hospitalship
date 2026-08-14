const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");
const { contentList } = require("./miniprogram/utils/contents");
const reviewedContentSeed = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "seed-data/content-seeds/esophageal-cancer-story.v1.json"
    ),
    "utf8"
  )
).document;

function clone(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return new Date(value.getTime());
  }

  if (Array.isArray(value)) {
    return value.map(clone);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }

  return value;
}

function matches(document, filter) {
  return Object.entries(filter || {}).every(
    ([key, value]) => document[key] === value
  );
}

class MemoryDatabase {
  constructor(initial = {}, options = {}) {
    this.stores = new Map();
    this.options = options;
    this.transactionTail = Promise.resolve();

    Object.entries(initial).forEach(([collectionName, documents]) => {
      const store = new Map();

      documents.forEach((document, index) => {
        const documentId = document._id || `${collectionName}-${index + 1}`;
        const data = clone(document);
        delete data._id;
        store.set(documentId, data);
      });

      this.stores.set(collectionName, store);
    });
  }

  getStore(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }

    return this.stores.get(name);
  }

  getDocuments(name) {
    return Array.from(this.getStore(name), ([documentId, data]) => ({
      _id: documentId,
      ...clone(data)
    }));
  }

  createDocumentReference(name, documentId) {
    const store = this.getStore(name);

    return {
      get: async () => {
        const readFailure = this.options.documentReadFailure;

        if (
          readFailure &&
          (!readFailure.collection || readFailure.collection === name) &&
          (!readFailure.documentId || readFailure.documentId === documentId)
        ) {
          const error = new Error(
            readFailure.message || "database request failed"
          );
          error.errCode = readFailure.errCode || -502001;
          throw error;
        }

        if (!store.has(documentId)) {
          const error = new Error("document does not exist");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }

        return {
          data: {
            _id: documentId,
            ...clone(store.get(documentId))
          }
        };
      },
      set: async ({ data }) => {
        store.set(documentId, clone(data));
        return { stats: { created: 1 } };
      },
      update: async ({ data }) => {
        if (!store.has(documentId)) {
          const error = new Error("document does not exist");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }

        store.set(documentId, {
          ...store.get(documentId),
          ...clone(data)
        });
        return { stats: { updated: 1 } };
      }
    };
  }

  createQuery(
    name,
    filter = {},
    orders = [],
    resultLimit = null,
    resultOffset = 0
  ) {
    const createNext = (nextOrders, nextLimit, nextOffset = resultOffset) =>
      this.createQuery(name, filter, nextOrders, nextLimit, nextOffset);
    const assertCollectionReadable = () => {
      if (
        name === "rewardLedger" &&
        this.options.missingRewardLedgerCollection &&
        !this.stores.has(name)
      ) {
        const error = new Error("collection does not exist");
        error.errCode = -502005;
        throw error;
      }
    };
    const read = () => {
      assertCollectionReadable();
      let documents = this.getDocuments(name).filter((document) =>
        matches(document, filter)
      );

      if (orders.length > 0) {
        documents.sort((left, right) => {
          for (const order of orders) {
            const rawLeftValue = left[order.field];
            const rawRightValue = right[order.field];
            const leftValue = rawLeftValue instanceof Date
              ? rawLeftValue.getTime()
              : rawLeftValue;
            const rightValue = rawRightValue instanceof Date
              ? rawRightValue.getTime()
              : rawRightValue;

            if (leftValue === rightValue) {
              continue;
            }

            const comparison = leftValue < rightValue ? -1 : 1;
            return order.direction === "desc" ? -comparison : comparison;
          }

          return 0;
        });
      }

      if (Number.isInteger(resultOffset) && resultOffset > 0) {
        documents = documents.slice(resultOffset);
      }

      if (Number.isInteger(resultLimit)) {
        documents = documents.slice(0, resultLimit);
      }

      return documents;
    };

    return {
      count: async () => {
        assertCollectionReadable();

        if (
          name === "rewardLedger" &&
          this.options.failRewardLedgerCount
        ) {
          throw new Error("injected reward count failure");
        }

        return { total: read().length };
      },
      get: async () => ({ data: read() }),
      limit: (limit) => createNext(orders, limit),
      orderBy: (field, direction) =>
        createNext([...orders, { field, direction }], resultLimit),
      skip: (offset) => createNext(orders, resultLimit, offset)
    };
  }

  createCollection(name, transactionOnly = false) {
    const collection = {
      doc: (documentId) => this.createDocumentReference(name, documentId)
    };

    if (!transactionOnly) {
      collection.where = (filter) => this.createQuery(name, filter);
    }

    return collection;
  }

  collection(name) {
    return this.createCollection(name, false);
  }

  serverDate() {
    return new Date("2026-07-14T00:00:00.000Z");
  }

  runTransaction(callback) {
    const execute = () =>
      callback({
        collection: (name) => this.createCollection(name, true)
      });
    const callbackResult = this.transactionTail.then(execute);
    this.transactionTail = callbackResult.catch(() => undefined);

    if (this.options.directTransactionResult) {
      return callbackResult;
    }

    return callbackResult.then((result) => ({
      result,
      errMsg: "runTransaction:ok"
    }));
  }
}

function createCloud(database, openid) {
  return {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => (openid ? { OPENID: openid } : {}),
    init: () => {}
  };
}

function loadCloudFunction(
  relativePath,
  cloud,
  environment = {
    GUARDIAN_PHONE_CLAIM_SECRET:
      "test-only-guardian-phone-claim-secret-2026"
  }
) {
  const filename = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const localRequire = Module.createRequire(filename);
  const sandbox = {
    Buffer,
    clearTimeout,
    console: {
      error: () => {},
      log: console.log.bind(console),
      warn: console.warn.bind(console)
    },
    __dirname: path.dirname(filename),
    __filename: filename,
    module,
    process: {
      env: environment
    },
    exports: module.exports,
    require(request) {
      return request === "wx-server-sdk" ? cloud : localRequire(request);
    },
    setTimeout
  };

  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.main;
}

function getMain(
  functionName,
  database,
  openid = "openid-a",
  environment
) {
  return loadCloudFunction(
    `cloudfunctions/${functionName}/index.js`,
    createCloud(database, openid),
    environment
  );
}

function createActiveUser(overrides = {}) {
  const openid = overrides.openid || "openid-a";
  const primaryUserId = crypto
    .createHash("sha256")
    .update(JSON.stringify(["user-openid", openid]))
    .digest("hex")
    .slice(0, 32);

  return {
    _id: overrides._id || primaryUserId,
    openid,
    memberId: "海船号2012A1B2C3D4E5F6",
    nickname: "海船号",
    birthYear: 2012,
    city: "北京",
    phone: "13800138000",
    registerStatus: "active",
    schemaVersion: 3,
    starUsed: 0,
    ...overrides
  };
}

function createActiveSession(user, overrides = {}) {
  const openid = overrides.openid || user.openid;
  const sessionId = crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);

  return {
    _id: sessionId,
    openid,
    userId: user._id,
    memberId: user.memberId,
    status: "active",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function registrationEvent(overrides = {}) {
  return {
    nickname: "海船号",
    birthYear: 2012,
    city: "北京",
    password: "海船号",
    phone: "13800138000",
    consents: {
      noticeVersion: "registration-notice-2026-07-12",
      rulesVersion: "reader-rules-v1"
    },
    ...overrides
  };
}

function createPublishedContent(content) {
  return {
    _id: content.id,
    contentId: content.id,
    status: "published",
    title: content.title,
    currentRevision: "test-revision-1",
    pendingReviewCount: 0,
    ...(content.bookId ? { bookId: content.bookId } : {})
  };
}

function createReadingState(user, content) {
  const stateId = crypto
    .createHash("sha256")
    .update(JSON.stringify(["reading-state", user._id, content.contentId]))
    .digest("hex")
    .slice(0, 32);

  return {
    _id: stateId,
    userId: user._id,
    memberId: user.memberId,
    openid: user.openid,
    contentId: content.contentId,
    contentRevision: content.currentRevision,
    status: "read"
  };
}

function createReadingDataset(content, userOverrides = {}) {
  const user = createActiveUser(userOverrides);
  const dataset = {
    users: [user],
    memberSessions: [createActiveSession(user)]
  };

  if (content) {
    dataset.contents = [content];

    if (content.contentId && content.currentRevision) {
      dataset.readingStates = [createReadingState(user, content)];
    }
  }

  return dataset;
}

function hashLegacyPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${password}`)
    .digest("hex");
}

async function testRegistrationTransactions() {
  const database = new MemoryDatabase();
  const register = getMain("register", database, "openid-register");
  const response = await register(registrationEvent());

  assert.strictEqual(response.success, true);
  assert.ok(response.user.memberId.startsWith("海船号2012"));
  assert.strictEqual(response.user.memberId.length, "海船号2012".length + 12);
  assert.strictEqual(
    response.user.guardianPhoneVerificationStatus,
    "unverified"
  );

  const users = database.getDocuments("users");
  const claims = database.getDocuments("guardianPhoneClaims");
  assert.strictEqual(users.length, 1);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(users[0].passwordAlgorithm, "scrypt-v1");
  assert.strictEqual(users[0].passwordHash.length, 128);
  assert.strictEqual(users[0].schemaVersion, 3);
  assert.strictEqual(users[0].guardianPhoneVerificationStatus, "unverified");
  assert.strictEqual(claims[0].verificationStatus, "unverified");
  assert.strictEqual(claims[0].phone, undefined);

  const sameOpenid = await register(registrationEvent());
  assert.strictEqual(sameOpenid.code, "ALREADY_REGISTERED");

  const sharedDatabase = new MemoryDatabase();
  const registerA = getMain("register", sharedDatabase, "openid-one");
  const registerB = getMain("register", sharedDatabase, "openid-two");
  const concurrent = await Promise.all([
    registerA(registrationEvent({ nickname: "甲一号" })),
    registerB(registrationEvent({ nickname: "乙二号" }))
  ]);

  assert.strictEqual(
    concurrent.filter((item) => item.success).length,
    1,
    "同一监护手机号并发注册只能成功一次"
  );
  assert.strictEqual(
    concurrent.filter(
      (item) => item.code === "GUARDIAN_ALREADY_REGISTERED"
    ).length,
    1
  );
  assert.strictEqual(sharedDatabase.getDocuments("users").length, 1);
  assert.strictEqual(
    sharedDatabase.getDocuments("guardianPhoneClaims").length,
    1
  );

  const inactiveDatabase = new MemoryDatabase({
    users: [
      createActiveUser({
        _id: "legacy-inactive",
        openid: "inactive-openid",
        registerStatus: "inactive"
      })
    ]
  });
  const inactive = await getMain(
    "register",
    inactiveDatabase,
    "inactive-openid"
  )(registrationEvent());
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");
  assert.strictEqual(inactiveDatabase.getDocuments("users").length, 1);
  assert.strictEqual(
    inactiveDatabase.getDocuments("guardianPhoneClaims").length,
    0
  );

  const invalidPrefix = await getMain(
    "register",
    new MemoryDatabase(),
    "openid-invalid-phone"
  )(registrationEvent({ phone: "12800138000" }));
  assert.strictEqual(invalidPrefix.success, false);

  const missingOpenid = await getMain(
    "register",
    new MemoryDatabase(),
    ""
  )(registrationEvent());
  assert.strictEqual(missingOpenid.code, "MISSING_OPENID");

  const missingConsent = await getMain(
    "register",
    new MemoryDatabase(),
    "openid-no-consent"
  )(registrationEvent({ consents: undefined }));
  assert.strictEqual(missingConsent.code, "CONSENT_REQUIRED");

  const missingSecret = await getMain(
    "register",
    new MemoryDatabase(),
    "openid-no-secret",
    {}
  )(registrationEvent());
  assert.strictEqual(missingSecret.code, "CONFIGURATION_ERROR");

  const readFailureDatabase = new MemoryDatabase(
    {},
    {
      documentReadFailure: {
        collection: "guardianPhoneClaims",
        errCode: -502001,
        message: "database request failed"
      }
    }
  );
  const readFailure = await getMain(
    "register",
    readFailureDatabase,
    "openid-read-failure"
  )(registrationEvent());

  assert.strictEqual(readFailure.success, false);
  assert.strictEqual(readFailureDatabase.getDocuments("users").length, 0);
  assert.strictEqual(
    readFailureDatabase.getDocuments("guardianPhoneClaims").length,
    0
  );
}

async function testSaveRecordRewardLedger() {
  const availableContent = {
    id: reviewedContentSeed.contentId,
    title: reviewedContentSeed.title
  };
  const publishedContent = createPublishedContent(availableContent);
  const validComment = "读".repeat(100);
  const database = new MemoryDatabase(createReadingDataset(publishedContent));
  const saveRecord = getMain("saveRecord", database);

  for (const content of contentList) {
    const contractDatabase = new MemoryDatabase({
      ...createReadingDataset(null),
      contents: []
    });
    const contractResult = await getMain(
      "saveRecord",
      contractDatabase
    )({
      contentId: content.id,
      comment: validComment
    });
    assert.strictEqual(
      contractResult.success,
      false,
      `客户端草稿不能成为云端发布白名单：${content.id}`
    );
  }

  const invalid = await saveRecord({
    contentId: "made-up-content",
    comment: validComment
  });
  assert.strictEqual(invalid.code, "INVALID_CONTENT_ID");

  const tooShort = await saveRecord({
    contentId: availableContent.id,
    comment: "太短"
  });
  assert.strictEqual(tooShort.code, "INVALID_COMMENT");

  const maximumComment = "读".repeat(2000);
  const maximumDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const maximumResult = await getMain("saveRecord", maximumDatabase)({
    contentId: availableContent.id,
    comment: maximumComment
  });
  assert.strictEqual(maximumResult.success, true);
  assert.strictEqual(
    Array.from(maximumDatabase.getDocuments("records")[0].comment).length,
    2000
  );

  const tooLongDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const tooLongResult = await getMain("saveRecord", tooLongDatabase)({
    contentId: availableContent.id,
    comment: "读".repeat(2001)
  });
  assert.strictEqual(tooLongResult.success, false);
  assert.strictEqual(tooLongResult.code, "INVALID_COMMENT");
  assert.strictEqual(tooLongResult.message, "读后感应为100至2000字");
  assert.strictEqual(tooLongDatabase.getDocuments("records").length, 0);
  assert.strictEqual(tooLongDatabase.getDocuments("rewardLedger").length, 0);

  const sensitiveDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const sensitiveSaveRecord = getMain("saveRecord", sensitiveDatabase);
  const pendingReview = await sensitiveSaveRecord({
    contentId: availableContent.id,
    comment: `笨蛋${"读".repeat(98)}`
  });
  assert.strictEqual(pendingReview.success, true);
  assert.strictEqual(pendingReview.requiresReview, true);
  assert.strictEqual(pendingReview.reviewStatus, "pending_review");
  assert.strictEqual(pendingReview.starAwarded, 0);
  assert.strictEqual(
    sensitiveDatabase.getDocuments("records")[0].status,
    "pending_review"
  );
  assert.strictEqual(
    sensitiveDatabase.getStore("contents").get(availableContent.id)
      .pendingReviewCount,
    1
  );

  const remoteSensitiveDatabase = new MemoryDatabase({
    ...createReadingDataset(publishedContent),
    moderationTerms: [
      {
        _id: "remote-sensitive-term",
        term: "远程敏感词",
        category: "远端词库",
        action: "block",
        status: "active"
      }
    ]
  });
  const remotePendingReview = await getMain(
    "saveRecord",
    remoteSensitiveDatabase
  )({
    contentId: availableContent.id,
    comment: `远程敏感词${"读".repeat(95)}`
  });
  assert.strictEqual(remotePendingReview.success, true);
  assert.strictEqual(remotePendingReview.requiresReview, true);
  assert.strictEqual(remotePendingReview.reviewStatus, "pending_review");

  const concurrent = await Promise.all([
    saveRecord({ contentId: availableContent.id, comment: validComment }),
    saveRecord({
      contentId: availableContent.id,
      comment: `${validComment}再次提交`
    })
  ]);

  assert.strictEqual(concurrent.every((item) => item.success), true);
  assert.deepStrictEqual(
    concurrent.map((item) => item.starAwarded).sort((a, b) => a - b),
    [0, 50]
  );
  assert.strictEqual(database.getDocuments("records").length, 1);
  assert.strictEqual(database.getDocuments("rewardLedger").length, 1);
  assert.strictEqual(
    database.getDocuments("rewardLedger")[0].amount,
    50
  );
  assert.strictEqual(concurrent[0].record.id, concurrent[1].record.id);
  assert.strictEqual(concurrent[0].record.id.length, 32);
  assert.strictEqual(concurrent[0].starTotal, 50);
  assert.strictEqual(concurrent[1].starTotal, 50);

  const ledgerId = database.getDocuments("rewardLedger")[0]._id;
  const ledgerBefore = clone(database.getDocuments("rewardLedger")[0]);
  await saveRecord({ contentId: availableContent.id, comment: validComment });
  assert.deepStrictEqual(
    database.getDocuments("rewardLedger").find((item) => item._id === ledgerId),
    ledgerBefore,
    "奖励账本一经写入不得被覆盖"
  );

  const migrationDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const migrationSave = getMain("saveRecord", migrationDatabase);
  await migrationSave({ contentId: availableContent.id, comment: validComment });
  migrationDatabase.getStore("rewardLedger").clear();
  const migrated = await migrationSave({
    contentId: availableContent.id,
    comment: `${validComment}旧记录补账`
  });
  assert.strictEqual(migrated.success, true);
  assert.strictEqual(migrated.starAwarded, 0);
  assert.strictEqual(
    migrationDatabase.getDocuments("rewardLedger")[0].migrationSource,
    "legacy-record"
  );

  const legacyBookContent = createPublishedContent({
    ...availableContent,
    bookId: "legacy-book"
  });
  const legacyDataset = createReadingDataset(legacyBookContent);
  const legacyUser = legacyDataset.users[0];
  const legacyOpenidDatabase = new MemoryDatabase({
    ...legacyDataset,
    records: [
      {
        _id: "legacy-openid-record",
        openid: legacyUser.openid,
        contentId: availableContent.id,
        bookTitle: availableContent.title,
        comment: "旧读后感",
        status: "completed",
        completedAt: new Date("2025-01-01T00:00:00.000Z")
      }
    ],
    rewardLedger: [
      {
        _id: "legacy-openid-reward",
        openid: legacyUser.openid,
        contentId: availableContent.id,
        rewardType: "content-completion",
        amount: 50,
        status: "granted",
        grantedAt: new Date("2025-01-01T00:00:00.000Z")
      }
    ]
  });
  const legacyOpenidSave = getMain("saveRecord", legacyOpenidDatabase);
  const legacyMigrated = await legacyOpenidSave({
    contentId: availableContent.id,
    comment: `${validComment}迁移旧账号`
  });

  assert.strictEqual(legacyMigrated.success, true);
  assert.strictEqual(legacyMigrated.starAwarded, 0);
  assert.strictEqual(legacyMigrated.fullBookUnlocked, true);
  assert.strictEqual(
    legacyOpenidDatabase
      .getDocuments("rewardLedger")
      .filter((item) => item.userId === legacyUser._id)[0].migrationSource,
    "legacy-openid"
  );
  assert.strictEqual(
    legacyOpenidDatabase.getDocuments("bookEntitlements").length,
    1
  );

  const legacyPendingReview = await legacyOpenidSave({
    contentId: availableContent.id,
    comment: `杀人${"读".repeat(98)}`
  });

  assert.strictEqual(legacyPendingReview.success, true);
  assert.strictEqual(legacyPendingReview.requiresReview, true);
  assert.strictEqual(
    legacyOpenidDatabase.getStore("contents").get(availableContent.id)
      .pendingReviewCount,
    1
  );
  assert.strictEqual(legacyPendingReview.starAwarded, 0);
  assert.strictEqual(legacyPendingReview.fullBookUnlocked, true);
  assert.strictEqual(
    legacyOpenidDatabase.getDocuments("rewardLedger").length,
    2,
    "旧奖励迁移后不得因复审覆盖而重复发放"
  );

  const countFaultDatabase = new MemoryDatabase(
    {
      ...createReadingDataset(publishedContent)
    },
    { failRewardLedgerCount: true }
  );
  const committedDespiteCountFault = await getMain(
    "saveRecord",
    countFaultDatabase
  )({
    contentId: availableContent.id,
    comment: validComment
  });
  assert.strictEqual(committedDespiteCountFault.success, true);
  assert.strictEqual(committedDespiteCountFault.starAwarded, 50);
  assert.strictEqual(committedDespiteCountFault.starTotal, null);
  assert.strictEqual(committedDespiteCountFault.starTotalPending, true);
  assert.strictEqual(countFaultDatabase.getDocuments("records").length, 1);
  assert.strictEqual(
    countFaultDatabase.getDocuments("rewardLedger").length,
    1
  );

  const inactiveDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent, { registerStatus: "inactive" })
  );
  const inactive = await getMain("saveRecord", inactiveDatabase)({
    contentId: availableContent.id,
    comment: validComment
  });
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");

  const unregistered = await getMain(
    "saveRecord",
    new MemoryDatabase({
      contents: [createPublishedContent(availableContent)]
    })
  )({
    contentId: availableContent.id,
    comment: validComment
  });
  assert.strictEqual(unregistered.code, "MEMBER_LOGIN_REQUIRED");

  const legacyRevisionDatabase = new MemoryDatabase({
    ...createReadingDataset(null),
    contents: [
      {
        _id: availableContent.id,
        contentId: availableContent.id,
        status: "published",
        title: availableContent.title,
        revision: "legacy-only-revision"
      }
    ]
  });
  const legacyRevision = await getMain(
    "saveRecord",
    legacyRevisionDatabase
  )({
    contentId: availableContent.id,
    comment: validComment
  });

  assert.strictEqual(legacyRevision.code, "INVALID_CONTENT_ID");
  assert.strictEqual(legacyRevisionDatabase.getDocuments("records").length, 0);
  assert.strictEqual(
    legacyRevisionDatabase.getDocuments("rewardLedger").length,
    0
  );

  const unpublishedDuringTransactionDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const originalUnpublishTransaction =
    unpublishedDuringTransactionDatabase.runTransaction.bind(
      unpublishedDuringTransactionDatabase
    );
  unpublishedDuringTransactionDatabase.runTransaction = (callback) => {
    unpublishedDuringTransactionDatabase
      .getStore("contents")
      .get(availableContent.id).status = "draft";
    return originalUnpublishTransaction(callback);
  };
  const unpublishedDuringTransaction = await getMain(
    "saveRecord",
    unpublishedDuringTransactionDatabase
  )({
    contentId: availableContent.id,
    comment: validComment
  });

  assert.strictEqual(unpublishedDuringTransaction.code, "INVALID_CONTENT_ID");
  assert.strictEqual(
    unpublishedDuringTransactionDatabase.getDocuments("records").length,
    0
  );
  assert.strictEqual(
    unpublishedDuringTransactionDatabase.getDocuments("rewardLedger").length,
    0
  );

  const revisionChangedDatabase = new MemoryDatabase(
    createReadingDataset(publishedContent)
  );
  const originalRevisionTransaction = revisionChangedDatabase.runTransaction.bind(
    revisionChangedDatabase
  );
  revisionChangedDatabase.runTransaction = (callback) => {
    revisionChangedDatabase
      .getStore("contents")
      .get(availableContent.id).currentRevision = "test-revision-2";
    return originalRevisionTransaction(callback);
  };
  const revisionChanged = await getMain(
    "saveRecord",
    revisionChangedDatabase
  )({
    contentId: availableContent.id,
    comment: validComment
  });

  assert.strictEqual(revisionChanged.code, "CONTENT_REVISION_CHANGED");
  assert.strictEqual(revisionChangedDatabase.getDocuments("records").length, 0);
  assert.strictEqual(
    revisionChangedDatabase.getDocuments("rewardLedger").length,
    0
  );

  const ledgerReadFailureDatabase = new MemoryDatabase(
    {
      ...createReadingDataset(publishedContent)
    },
    {
      documentReadFailure: {
        collection: "rewardLedger",
        errCode: -502001,
        message: "database request failed"
      }
    }
  );
  const ledgerReadFailure = await getMain(
    "saveRecord",
    ledgerReadFailureDatabase
  )({
    contentId: availableContent.id,
    comment: validComment
  });

  assert.strictEqual(ledgerReadFailure.success, false);
  assert.strictEqual(
    ledgerReadFailureDatabase.getDocuments("records").length,
    0
  );
  assert.strictEqual(
    ledgerReadFailureDatabase.getDocuments("rewardLedger").length,
    0
  );
}

async function testGetUserRewardAuthority() {
  const records = [
    {
      _id: "record-one",
      openid: "openid-a",
      status: "completed",
      bookTitle: "第一篇",
      completedAt: new Date("2026-07-14T02:00:00.000Z")
    },
    {
      _id: "record-two",
      openid: "openid-a",
      status: "completed",
      bookTitle: "第二篇",
      completedAt: new Date("2026-07-14T01:00:00.000Z")
    }
  ];
  const ledger = [
    {
      _id: "reward-one",
      openid: "openid-a",
      rewardType: "content-completion",
      status: "granted",
      amount: 50
    }
  ];
  const ledgerDatabase = new MemoryDatabase({
    ...createReadingDataset(null, { starUsed: 999, schemaVersion: 3 }),
    records,
    rewardLedger: ledger
  });
  const result = await getMain("getUser", ledgerDatabase)();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.user.starTotal, 50);
  assert.strictEqual(result.user.starUsed, 50);
  assert.strictEqual(result.user.starRemain, 0);
  assert.strictEqual(result.user.starSource, "reward-ledger");
  assert.strictEqual(result.user.badges.length, 1);
  assert.strictEqual(result.user.badgeTotal, 1);

  const legacyDatabase = new MemoryDatabase({
    ...createReadingDataset(null, { schemaVersion: 2, starUsed: -10 }),
    records,
    rewardLedger: []
  });
  const legacy = await getMain("getUser", legacyDatabase)();
  assert.strictEqual(legacy.user.starTotal, 100);
  assert.strictEqual(legacy.user.starUsed, 0);
  assert.strictEqual(legacy.user.starSource, "legacy-record-migration");
  assert.strictEqual(legacy.user.badgeTotal, 2);

  const emptyLedgerDatabase = new MemoryDatabase(
    {
      ...createReadingDataset(null, { schemaVersion: 3 }),
      records: []
    },
    { missingRewardLedgerCollection: true }
  );
  const emptyLedger = await getMain("getUser", emptyLedgerDatabase)();
  assert.strictEqual(emptyLedger.success, false);
  assert.strictEqual(emptyLedger.message, "会员信息读取失败");

  const missingOpenid = await getMain(
    "getUser",
    new MemoryDatabase(),
    ""
  )();
  assert.strictEqual(missingOpenid.code, "MISSING_OPENID");

  const inactive = await getMain(
    "getUser",
    new MemoryDatabase({
      ...createReadingDataset(null, { registerStatus: "suspended" })
    })
  )();
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");
  assert.strictEqual(inactive.accountStatus, "suspended");
}

async function testGetNotesTransactionLock() {
  const password = "海船号";
  const legacySalt = "legacy-salt";
  const legacyUser = createActiveUser({
    passwordSalt: legacySalt,
    passwordHash: hashLegacyPassword(password, legacySalt),
    passwordFailureCount: 0,
    passwordLockedUntil: null
  });
  const legacyDatabase = new MemoryDatabase({
    users: [legacyUser],
    memberSessions: [createActiveSession(legacyUser)],
    records: [
      {
        _id: "record-note",
        openid: "openid-a",
        userId: legacyUser._id,
        status: "completed",
        bookTitle: "食管癌的故事",
        comment: "读后感内容",
        completedAt: new Date("2026-07-14T00:00:00.000Z")
      }
    ]
  });
  const migrated = await getMain("getNotes", legacyDatabase)({ password });
  const migratedUser = legacyDatabase.getDocuments("users")[0];

  assert.strictEqual(migrated.success, true);
  assert.strictEqual(migrated.notes.length, 1);
  assert.strictEqual(migratedUser.passwordAlgorithm, "scrypt-v1");
  assert.strictEqual(migratedUser.passwordHash.length, 128);

  const paginationDatabase = new MemoryDatabase({
    users: [migratedUser],
    memberSessions: [createActiveSession(migratedUser)],
    records: Array.from({ length: 5 }, (_, index) => ({
      _id: `record-page-${index + 1}`,
      openid: "openid-a",
      userId: migratedUser._id,
      status: "completed",
      bookTitle: `分页书稿${index + 1}`,
      comment: `分页读后感${index + 1}`,
      completedAt: new Date(Date.UTC(2026, 6, 14, 5 - index))
    }))
  });
  const pagedGetNotes = getMain("getNotes", paginationDatabase);
  const firstPage = await pagedGetNotes({ password, offset: 0, limit: 2 });
  const secondPage = await pagedGetNotes({
    password,
    offset: firstPage.nextOffset,
    limit: 2
  });
  const lastPage = await pagedGetNotes({
    password,
    offset: secondPage.nextOffset,
    limit: 2
  });

  assert.deepStrictEqual(
    Array.from(firstPage.notes, (note) => note.id),
    ["record-page-1", "record-page-2"]
  );
  assert.deepStrictEqual(
    Array.from(secondPage.notes, (note) => note.id),
    ["record-page-3", "record-page-4"]
  );
  assert.deepStrictEqual(
    Array.from(lastPage.notes, (note) => note.id),
    ["record-page-5"]
  );
  assert.strictEqual(firstPage.total, 5);
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 2);
  assert.strictEqual(secondPage.nextOffset, 4);
  assert.strictEqual(lastPage.hasMore, false);
  assert.strictEqual(lastPage.nextOffset, null);

  const tiedCompletedAt = new Date("2026-07-14T06:00:00.000Z");
  const stablePaginationDatabase = new MemoryDatabase({
    users: [migratedUser],
    memberSessions: [createActiveSession(migratedUser)],
    records: ["record-tie-a", "record-tie-c", "record-tie-b"].map(
      (recordId) => ({
        _id: recordId,
        openid: "openid-a",
        userId: migratedUser._id,
        status: "completed",
        bookTitle: recordId,
        comment: recordId,
        completedAt: tiedCompletedAt
      })
    )
  });
  const stableGetNotes = getMain("getNotes", stablePaginationDatabase);
  const stableFirstPage = await stableGetNotes({ password, limit: 2 });
  const stableSecondPage = await stableGetNotes({
    password,
    limit: 2,
    offset: stableFirstPage.nextOffset
  });

  assert.deepStrictEqual(
    Array.from(stableFirstPage.notes, (note) => note.id),
    ["record-tie-c", "record-tie-b"]
  );
  assert.deepStrictEqual(
    Array.from(stableSecondPage.notes, (note) => note.id),
    ["record-tie-a"]
  );

  const legacyNotesDatabase = new MemoryDatabase({
    users: [migratedUser],
    memberSessions: [createActiveSession(migratedUser)],
    records: [
      {
        _id: "legacy-note-only",
        openid: migratedUser.openid,
        contentId: "legacy-only-content",
        status: "completed",
        bookTitle: "旧版读后感",
        comment: "旧版内容",
        completedAt: new Date("2026-07-13T00:00:00.000Z")
      },
      {
        _id: "legacy-note-duplicate",
        openid: migratedUser.openid,
        contentId: "shared-content",
        status: "completed",
        bookTitle: "待被新记录覆盖",
        comment: "旧内容",
        completedAt: new Date("2026-07-14T00:00:00.000Z")
      },
      {
        _id: "member-note-new",
        openid: migratedUser.openid,
        userId: migratedUser._id,
        contentId: "shared-content",
        status: "completed",
        bookTitle: "当前会员记录",
        comment: "新内容",
        completedAt: new Date("2026-07-15T00:00:00.000Z")
      }
    ]
  });
  const legacyNotes = await getMain("getNotes", legacyNotesDatabase)({
    password,
    limit: 20
  });

  assert.strictEqual(legacyNotes.success, true);
  assert.strictEqual(legacyNotes.total, 2);
  assert.deepStrictEqual(
    Array.from(legacyNotes.notes, (note) => note.id),
    ["member-note-new", "legacy-note-only"]
  );

  const lockDatabase = new MemoryDatabase({
    users: [
      createActiveUser({
        passwordSalt: migratedUser.passwordSalt,
        passwordHash: migratedUser.passwordHash,
        passwordAlgorithm: "scrypt-v1",
        passwordFailureCount: 0,
        passwordLockedUntil: null
      })
    ],
    memberSessions: [createActiveSession(migratedUser)]
  });
  const getNotes = getMain("getNotes", lockDatabase);
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => getNotes({ password: "错误码" }))
  );
  assert.strictEqual(
    attempts.filter((item) => item.code === "PASSWORD_LOCKED").length,
    1
  );
  assert.strictEqual(
    attempts.filter((item) => item.code === "WRONG_PASSWORD").length,
    4
  );
  assert.ok(lockDatabase.getDocuments("users")[0].passwordLockedUntil);

  const blocked = await getNotes({ password });
  assert.strictEqual(blocked.code, "PASSWORD_LOCKED");

  const unknownDatabase = new MemoryDatabase({
    users: [
      createActiveUser({
        passwordSalt: "salt",
        passwordHash: "00",
        passwordAlgorithm: "plaintext-v0",
        passwordFailureCount: 0
      })
    ],
    memberSessions: [createActiveSession(createActiveUser())]
  });
  const unknown = await getMain("getNotes", unknownDatabase)({ password });
  assert.strictEqual(unknown.code, "UNSUPPORTED_PASSWORD_ALGORITHM");
  assert.strictEqual(
    unknownDatabase.getDocuments("users")[0].passwordFailureCount,
    0
  );

  const missingOpenid = await getMain(
    "getNotes",
    new MemoryDatabase(),
    ""
  )({ password });
  assert.strictEqual(missingOpenid.code, "MISSING_OPENID");

  const inactive = await getMain(
    "getNotes",
    new MemoryDatabase({
      users: [createActiveUser({ registerStatus: "inactive" })],
      memberSessions: [createActiveSession(createActiveUser())]
    })
  )({ password });
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");
}

async function testLoginIdentityStates() {
  const activeUser = createActiveUser();
  const active = await getMain(
    "login",
    new MemoryDatabase({
      users: [activeUser],
      memberSessions: [createActiveSession(activeUser)]
    })
  )();
  assert.strictEqual(active.success, true);
  assert.strictEqual(active.registered, true);
  assert.strictEqual(active.accountStatus, "active");

  const unregistered = await getMain(
    "login",
    new MemoryDatabase()
  )();
  assert.strictEqual(unregistered.success, true);
  assert.strictEqual(unregistered.registered, false);
  assert.strictEqual(unregistered.accountStatus, "unregistered");

  const inactiveUser = createActiveUser({ registerStatus: "inactive" });
  const inactive = await getMain(
    "login",
    new MemoryDatabase({
      users: [inactiveUser],
      memberSessions: [createActiveSession(inactiveUser)]
    })
  )();
  assert.strictEqual(inactive.success, true);
  assert.strictEqual(inactive.loggedIn, false);
  assert.strictEqual(inactive.code, "MEMBER_LOGIN_REQUIRED");

  const missingOpenid = await getMain(
    "login",
    new MemoryDatabase(),
    ""
  )();
  assert.strictEqual(missingOpenid.code, "MISSING_OPENID");
}

async function run() {
  await testRegistrationTransactions();
  await testSaveRecordRewardLedger();
  await testGetUserRewardAuthority();
  await testGetNotesTransactionLock();
  await testLoginIdentityStates();
  console.log(
    "云函数回归测试通过：注册唯一占位、奖励账本、星星余额、密码并发锁与账号状态"
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
