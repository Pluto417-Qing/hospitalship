const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");

const root = __dirname;

function clone(value) {
  if (value instanceof Date) {
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

function createId(namespace, ...values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex")
    .slice(0, 32);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => document[key] === value);
}

class MemoryDatabase {
  constructor(seed = {}) {
    this.stores = new Map();
    this.clock = Date.parse("2026-07-14T08:00:00.000Z");

    Object.entries(seed).forEach(([name, documents]) => {
      this.stores.set(
        name,
        new Map(documents.map((document) => [document._id, clone(document)]))
      );
    });
  }

  store(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }

    return this.stores.get(name);
  }

  documents(name) {
    return Array.from(this.store(name).values()).map(clone);
  }

  collection(name) {
    const database = this;

    return {
      doc(documentId) {
        return {
          async get() {
            return {
              data: database.store(name).has(documentId)
                ? clone(database.store(name).get(documentId))
                : null
            };
          },
          async set({ data }) {
            database.store(name).set(documentId, {
              _id: documentId,
              ...clone(data)
            });
          },
          async update({ data }) {
            const existing = database.store(name).get(documentId);

            if (!existing) {
              throw new Error(`missing ${name}/${documentId}`);
            }

            database.store(name).set(documentId, {
              ...existing,
              ...clone(data),
              _id: documentId
            });
          }
        };
      },
      where(filter) {
        const query = {
          filter,
          limitValue: Infinity,
          offset: 0,
          order: []
        };
        const chain = {
          orderBy(field, direction) {
            query.order.push({ field, direction });
            return chain;
          },
          skip(offset) {
            query.offset = offset;
            return chain;
          },
          limit(limit) {
            query.limitValue = limit;
            return chain;
          },
          async get() {
            const rows = database
              .documents(name)
              .filter((document) => matches(document, query.filter));

            for (let index = query.order.length - 1; index >= 0; index -= 1) {
              const order = query.order[index];
              const direction = order.direction === "desc" ? -1 : 1;
              rows.sort((left, right) => {
                const leftValue = left[order.field];
                const rightValue = right[order.field];

                if (leftValue === rightValue) {
                  return 0;
                }

                return (leftValue < rightValue ? -1 : 1) * direction;
              });
            }

            return {
              data: rows.slice(
                query.offset,
                query.offset + query.limitValue
              )
            };
          }
        };

        return chain;
      }
    };
  }

  serverDate() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  async runTransaction(callback) {
    return callback({ collection: (name) => this.collection(name) });
  }
}

function loadModerationCenter(database, openid) {
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };
  const originalLoad = Module._load;
  const functionPath = path.join(
    root,
    "cloudfunctions/moderationCenter/index.js"
  );

  delete require.cache[require.resolve(functionPath)];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return cloud;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(functionPath).main;
  } finally {
    Module._load = originalLoad;
  }
}

function adminAccount(overrides = {}) {
  return {
    _id: "admin-account-a",
    openid: "admin-openid",
    role: "moderator",
    status: "active",
    ...overrides
  };
}

function member(userId, openid, memberId) {
  return {
    _id: userId,
    openid,
    memberId,
    nickname: memberId,
    registerStatus: "active"
  };
}

function pendingRecord({
  recordId,
  userId,
  openid,
  memberId,
  contentId,
  comment = "这是一篇需要复审的少年读后感。".repeat(5)
}) {
  return {
    _id: recordId,
    userId,
    openid,
    memberId,
    contentId,
    contentRevision: "revision-1",
    bookTitle: `文章-${contentId}`,
    comment,
    status: "pending_review",
    submittedAt: new Date("2026-07-14T07:00:00.000Z"),
    moderation: {
      checked: true,
      decision: "review",
      reviewRecommended: true,
      reviewCategory: "测试复审"
    }
  };
}

function publishedContent(contentId, bookId) {
  return {
    _id: contentId,
    contentId,
    bookId,
    title: `文章-${contentId}`,
    currentRevision: "revision-1",
    pendingReviewCount: 1,
    status: "published"
  };
}

async function getPendingHash(main, recordId) {
  const listed = await main({ action: "listPending", limit: 50 });
  assert.strictEqual(listed.success, true);
  const item = listed.records.find((record) => record.id === recordId);
  assert(item, `待审列表缺少 ${recordId}`);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(item, "userId"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(item, "openid"), false);
  assert.match(item.commentHash, /^[a-f0-9]{64}$/);
  return item.commentHash;
}

async function testUnauthorized() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount({ status: "inactive" })]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const result = await main({ action: "listPending" });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, "ADMIN_FORBIDDEN");
}

async function testAuthorizedRoles() {
  for (const role of ["moderator", "content-reviewer", "admin"]) {
    const database = new MemoryDatabase({
      adminAccounts: [adminAccount({ role })],
      records: []
    });
    const main = loadModerationCenter(database, "admin-openid");
    const result = await main({ action: "listPending" });

    assert.strictEqual(result.success, true, `${role} 应有复审权限`);
    assert.deepStrictEqual(result.records, []);
  }

  const uploaderDatabase = new MemoryDatabase({
    adminAccounts: [adminAccount({ role: "uploader" })],
    records: []
  });
  const uploaderMain = loadModerationCenter(
    uploaderDatabase,
    "admin-openid"
  );
  const denied = await uploaderMain({ action: "listPending" });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, "ADMIN_FORBIDDEN");
}

async function testStaleHash() {
  const userId = "child-a";
  const contentId = "story-a";
  const recordId = createId("reading-record", userId, contentId);
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount({ role: "content-reviewer" })],
    contents: [publishedContent(contentId, "")],
    records: [
      pendingRecord({
        recordId,
        userId,
        openid: "guardian-openid",
        memberId: "CHILDA",
        contentId
      })
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const oldHash = await getPendingHash(main, recordId);
  const stored = database.store("records").get(recordId);
  stored.comment = `${stored.comment}读者刚刚覆盖了稿件`;
  stored.submittedAt = new Date("2026-07-14T07:30:00.000Z");
  const result = await main({
    action: "review",
    recordId,
    expectedCommentHash: oldHash,
    decision: "approve"
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, "REVIEW_STALE");
  assert.strictEqual(database.store("records").get(recordId).status, "pending_review");
  assert.strictEqual(database.documents("rewardLedger").length, 0);
}

async function testApproveIsIdempotent() {
  const userId = "child-approve";
  const guardianOpenid = "guardian-approve";
  const memberId = "APPROVE01";
  const contentId = "story-approve";
  const bookId = "hospital-ship";
  const recordId = createId("reading-record", userId, contentId);
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount({ role: "content-reviewer" })],
    users: [member(userId, guardianOpenid, memberId)],
    contents: [publishedContent(contentId, bookId)],
    records: [
      pendingRecord({
        recordId,
        userId,
        openid: guardianOpenid,
        memberId,
        contentId
      })
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const hash = await getPendingHash(main, recordId);
  const first = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "approve",
    userId: "attacker-child",
    amount: 999999,
    bookId: "attacker-book"
  });

  assert.strictEqual(first.success, true);
  assert.strictEqual(first.starAwarded, 50);
  assert.strictEqual(first.fullBookGranted, true);
  assert.strictEqual(database.store("records").get(recordId).status, "completed");
  assert.strictEqual(
    database.store("contents").get(contentId).pendingReviewCount,
    0
  );
  assert.strictEqual(database.documents("rewardLedger").length, 1);
  assert.strictEqual(database.documents("bookEntitlements").length, 1);
  assert.deepStrictEqual(
    database.documents("rewardLedger").map((reward) => ({
      userId: reward.userId,
      contentId: reward.contentId,
      amount: reward.amount
    })),
    [{ userId, contentId, amount: 50 }]
  );
  assert.strictEqual(database.documents("bookEntitlements")[0].bookId, bookId);
  assert.strictEqual(
    database.store("records").get(recordId).moderation.review.adminRole,
    "content-reviewer"
  );

  const second = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "approve"
  });

  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyReviewed, true);
  assert.strictEqual(second.starAwarded, 0);
  assert.strictEqual(database.documents("rewardLedger").length, 1);
  assert.strictEqual(database.documents("bookEntitlements").length, 1);
}

async function testRejectPersistsRevisionRequired() {
  const userId = "child-reject";
  const contentId = "story-reject";
  const recordId = createId("reading-record", userId, contentId);
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount()],
    contents: [publishedContent(contentId, "")],
    records: [
      pendingRecord({
        recordId,
        userId,
        openid: "guardian-reject",
        memberId: "REJECT01",
        contentId
      })
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const hash = await getPendingHash(main, recordId);
  const first = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "reject"
  });

  assert.strictEqual(first.success, true);
  assert.strictEqual(first.status, "revision_required");
  assert.strictEqual(first.starAwarded, 0);
  assert.strictEqual(database.store("records").get(recordId).status, "revision_required");
  assert.strictEqual(
    database.store("contents").get(contentId).pendingReviewCount,
    0
  );
  assert.strictEqual(database.documents("rewardLedger").length, 0);
  assert.strictEqual(database.documents("bookEntitlements").length, 0);

  const retry = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "reject"
  });
  assert.strictEqual(retry.success, true);
  assert.strictEqual(retry.alreadyReviewed, true);
}

async function testExistingRewardIsPreserved() {
  const userId = "child-earned";
  const guardianOpenid = "guardian-earned";
  const memberId = "EARNED01";
  const contentId = "story-earned";
  const recordId = createId("reading-record", userId, contentId);
  const rewardId = createId("content-completion", userId, contentId);
  const originalGrantedAt = new Date("2026-07-01T00:00:00.000Z");
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount()],
    users: [member(userId, guardianOpenid, memberId)],
    contents: [publishedContent(contentId, "earned-book")],
    records: [
      pendingRecord({
        recordId,
        userId,
        openid: guardianOpenid,
        memberId,
        contentId
      })
    ],
    rewardLedger: [
      {
        _id: rewardId,
        userId,
        memberId,
        openid: guardianOpenid,
        contentId,
        rewardType: "content-completion",
        sourceId: recordId,
        status: "granted",
        amount: 50,
        grantedAt: originalGrantedAt
      }
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const hash = await getPendingHash(main, recordId);
  const before = clone(database.store("rewardLedger").get(rewardId));
  const result = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "approve"
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.starAwarded, 0);
  assert.deepStrictEqual(database.store("rewardLedger").get(rewardId), before);
}

async function testLegacyPrimaryRewardIsMigratedWithoutReaward() {
  const guardianOpenid = "guardian-legacy";
  const userId = createId("user-openid", guardianOpenid);
  const memberId = "LEGACY01";
  const contentId = "story-legacy";
  const recordId = createId("reading-record", userId, contentId);
  const legacyRecordId = createId(
    "reading-record",
    guardianOpenid,
    contentId
  );
  const legacyRewardId = createId(
    "content-completion",
    guardianOpenid,
    contentId
  );
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount()],
    users: [member(userId, guardianOpenid, memberId)],
    contents: [publishedContent(contentId, "legacy-book")],
    records: [
      pendingRecord({
        recordId,
        userId,
        openid: guardianOpenid,
        memberId,
        contentId
      }),
      {
        _id: legacyRecordId,
        openid: guardianOpenid,
        contentId,
        status: "completed",
        completedAt: new Date("2026-06-01T00:00:00.000Z")
      }
    ],
    rewardLedger: [
      {
        _id: legacyRewardId,
        openid: guardianOpenid,
        contentId,
        rewardType: "content-completion",
        status: "granted",
        amount: 50,
        grantedAt: new Date("2026-06-01T00:00:00.000Z")
      }
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const hash = await getPendingHash(main, recordId);
  const result = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "approve"
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.starAwarded, 0);
  const scopedRewards = database
    .documents("rewardLedger")
    .filter((reward) => reward.userId === userId);
  assert.strictEqual(scopedRewards.length, 1);
  assert.strictEqual(scopedRewards[0].migrationSource, "legacy-openid");
  assert.strictEqual(scopedRewards[0].amount, 50);
}

async function testTwoChildrenStayIsolated() {
  const guardianOpenid = "guardian-two-children";
  const childOne = "child-one";
  const childTwo = "child-two";
  const contentId = "story-shared";
  const recordId = createId("reading-record", childTwo, contentId);
  const childOneRewardId = createId("content-completion", childOne, contentId);
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount()],
    users: [
      member(childOne, guardianOpenid, "CHILD001"),
      member(childTwo, guardianOpenid, "CHILD002")
    ],
    contents: [publishedContent(contentId, "shared-book")],
    records: [
      pendingRecord({
        recordId,
        userId: childTwo,
        openid: guardianOpenid,
        memberId: "CHILD002",
        contentId
      })
    ],
    rewardLedger: [
      {
        _id: childOneRewardId,
        userId: childOne,
        memberId: "CHILD001",
        openid: guardianOpenid,
        contentId,
        rewardType: "content-completion",
        sourceId: createId("reading-record", childOne, contentId),
        status: "granted",
        amount: 50
      }
    ]
  });
  const main = loadModerationCenter(database, "admin-openid");
  const hash = await getPendingHash(main, recordId);
  const result = await main({
    action: "review",
    recordId,
    expectedCommentHash: hash,
    decision: "approve",
    userId: childOne
  });

  assert.strictEqual(result.success, true);
  const rewards = database.documents("rewardLedger");
  assert.strictEqual(rewards.length, 2);
  assert.deepStrictEqual(
    rewards.map((reward) => reward.userId).sort(),
    [childOne, childTwo]
  );
  assert.strictEqual(database.documents("bookEntitlements")[0].userId, childTwo);
}

async function main() {
  await testUnauthorized();
  await testAuthorizedRoles();
  await testStaleHash();
  await testApproveIsIdempotent();
  await testRejectPersistsRevisionRequired();
  await testExistingRewardIsPreserved();
  await testLegacyPrimaryRewardIsMigratedWithoutReaward();
  await testTwoChildrenStayIsolated();
  console.log("人工复审专项测试通过：未授权、陈旧稿、审批幂等、驳回、既有/旧版奖励和多孩子隔离均已覆盖。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
