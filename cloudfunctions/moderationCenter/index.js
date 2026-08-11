const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const AUTHORIZED_ROLES = new Set([
  "moderator",
  "content-reviewer",
  "admin"
]);
const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REWARD_TYPE = "content-completion";
const STAR_REWARD_PER_COMPLETION = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 10000;

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, numeric));
}

function createDeterministicId(namespace, values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex")
    .slice(0, 32);
}

function createRewardId(userId, contentId) {
  return createDeterministicId(REWARD_TYPE, [userId, contentId]);
}

function createPrimaryUserId(openid) {
  return createDeterministicId("user-openid", [openid]);
}

function createEntitlementId(userId, bookId) {
  return createDeterministicId("book-entitlement", [userId, bookId]);
}

function stableTimeValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.toISOString() : "";
  }

  if (value && Number.isFinite(Number(value.seconds))) {
    return `${Number(value.seconds)}:${Number(value.nanoseconds || 0)}`;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
  }

  return "";
}

function createCommentHash(record) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "moderation-comment-v1",
        normalizeText(record && record._id, 128),
        normalizeText(record && record.userId, 128),
        normalizeText(record && record.contentId, 64),
        normalizeText(record && record.contentRevision, 128),
        typeof (record && record.comment) === "string" ? record.comment : "",
        stableTimeValue(record && (record.submittedAt || record.updateTime))
      ])
    )
    .digest("hex");
}

function getRoles(account) {
  const roles = [];
  const directRole = normalizeText(account && account.role, 32).toLowerCase();

  if (directRole) {
    roles.push(directRole);
  }

  if (Array.isArray(account && account.roles)) {
    account.roles.forEach((role) => {
      const normalized = normalizeText(role, 32).toLowerCase();

      if (normalized) {
        roles.push(normalized);
      }
    });
  }

  return Array.from(new Set(roles));
}

function isAuthorizedAccount(account, openid) {
  return Boolean(
    account &&
      normalizeText(account._id, 128) &&
      normalizeText(account.openid, 128) === openid &&
      account.status === "active" &&
      getRoles(account).some((role) => AUTHORIZED_ROLES.has(role))
  );
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function isDocumentNotFound(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String((error && (error.errMsg || error.message)) || "");

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist|not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

async function getDocumentOrNull(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

async function resolveAdmin(openid) {
  const result = await db
    .collection("adminAccounts")
    .where({
      openid,
      status: "active"
    })
    .limit(3)
    .get();
  const accounts = result && Array.isArray(result.data) ? result.data : [];
  const account = accounts.find((item) => isAuthorizedAccount(item, openid));

  if (!account) {
    return {
      success: false,
      code: "ADMIN_FORBIDDEN",
      message: "当前微信没有读后感复审权限"
    };
  }

  return {
    success: true,
    account,
    roles: getRoles(account)
  };
}

async function readLegacyEarnedState(record) {
  const userId = normalizeText(record && record.userId, 128);
  const openid = normalizeText(record && record.openid, 128);
  const contentId = normalizeText(record && record.contentId, 64);

  if (
    !openid ||
    !CONTENT_ID_PATTERN.test(contentId) ||
    userId !== createPrimaryUserId(openid)
  ) {
    return { record: null, reward: null };
  }

  const [recordResult, rewardResult] = await Promise.all([
    db.collection("records").where({ openid, contentId }).limit(20).get(),
    db
      .collection("rewardLedger")
      .where({
        openid,
        contentId,
        rewardType: REWARD_TYPE,
        status: "granted"
      })
      .limit(20)
      .get()
  ]);
  const legacyRecord = ((recordResult && recordResult.data) || []).find(
    (item) =>
      !normalizeText(item && item.userId, 128) &&
      item.status === "completed"
  );
  const legacyReward = ((rewardResult && rewardResult.data) || []).find(
    (item) =>
      !normalizeText(item && item.userId, 128) &&
      item.status === "granted" &&
      item.rewardType === REWARD_TYPE &&
      Number(item.amount || STAR_REWARD_PER_COMPLETION) ===
        STAR_REWARD_PER_COMPLETION
  );

  return {
    record: legacyRecord || null,
    reward: legacyReward || null
  };
}

function publicPendingRecord(record) {
  return {
    id: normalizeText(record && record._id, 128),
    contentId: normalizeText(record && record.contentId, 64),
    title: normalizeText(
      record && (record.bookTitle || record.titleSnapshot),
      160
    ) || "未命名阅读内容",
    comment: typeof (record && record.comment) === "string"
      ? Array.from(record.comment).slice(0, 2000).join("")
      : "",
    contentRevision: normalizeText(record && record.contentRevision, 128),
    submittedAt: record && (record.submittedAt || record.updateTime) || null,
    reviewCategory: normalizeText(
      record && record.moderation && record.moderation.reviewCategory,
      80
    ),
    commentHash: createCommentHash(record)
  };
}

async function listPending(event) {
  const offset = normalizeInteger(event.offset, 0, 0, MAX_OFFSET);
  const limit = normalizeInteger(
    event.limit,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  const result = await db
    .collection("records")
    .where({ status: "pending_review" })
    .orderBy("submittedAt", "desc")
    .orderBy("_id", "desc")
    .skip(offset)
    .limit(limit + 1)
    .get();

  if (!result || !Array.isArray(result.data)) {
    throw new Error("pending review query returned an invalid result");
  }

  const hasMore = result.data.length > limit;
  const records = result.data.slice(0, limit).map(publicPendingRecord);
  const nextOffset = hasMore ? offset + records.length : null;

  return {
    success: true,
    action: "listPending",
    records,
    offset,
    limit,
    hasMore: nextOffset !== null,
    nextOffset
  };
}

function validateExistingReward(reward, userId, contentId, recordId) {
  if (!reward) {
    return;
  }

  if (
    normalizeText(reward.userId, 128) !== userId ||
    normalizeText(reward.contentId, 64) !== contentId ||
    reward.rewardType !== REWARD_TYPE ||
    normalizeText(reward.sourceId, 128) !== recordId ||
    reward.status !== "granted" ||
    Number(reward.amount) !== STAR_REWARD_PER_COMPLETION
  ) {
    throw new Error("reward ledger identity mismatch");
  }
}

function validateExistingEntitlement(entitlement, userId, bookId) {
  if (!entitlement) {
    return;
  }

  if (
    normalizeText(entitlement.userId, 128) !== userId ||
    normalizeText(entitlement.bookId, 64) !== bookId
  ) {
    throw new Error("book entitlement identity mismatch");
  }
}

async function reviewRecord(event, admin, openid) {
  const recordId = normalizeText(event.recordId, 128).toLowerCase();
  const expectedCommentHash = normalizeText(
    event.expectedCommentHash,
    64
  ).toLowerCase();
  const decision = normalizeText(event.decision, 16).toLowerCase();

  if (!RECORD_ID_PATTERN.test(recordId)) {
    return {
      success: false,
      code: "INVALID_RECORD_ID",
      message: "待审记录编号无效"
    };
  }

  if (!COMMENT_HASH_PATTERN.test(expectedCommentHash)) {
    return {
      success: false,
      code: "INVALID_COMMENT_HASH",
      message: "待审稿校验值无效"
    };
  }

  if (!new Set(["approve", "reject"]).has(decision)) {
    return {
      success: false,
      code: "INVALID_REVIEW_DECISION",
      message: "复审结论无效"
    };
  }

  const recordPreview = await getDocumentOrNull(
    db.collection("records").doc(recordId)
  );
  const legacyEarnedState = decision === "approve"
    ? await readLegacyEarnedState(recordPreview)
    : { record: null, reward: null };

  const rawResult = await db.runTransaction(async (transaction) => {
    const adminDocument = transaction
      .collection("adminAccounts")
      .doc(admin.account._id);
    const recordDocument = transaction.collection("records").doc(recordId);
    const legacyRecordDocument = legacyEarnedState.record
      ? transaction.collection("records").doc(legacyEarnedState.record._id)
      : null;
    const legacyRewardDocument = legacyEarnedState.reward
      ? transaction
          .collection("rewardLedger")
          .doc(legacyEarnedState.reward._id)
      : null;
    const [
      transactionAdmin,
      record,
      transactionLegacyRecord,
      transactionLegacyReward
    ] = await Promise.all([
      getDocumentOrNull(adminDocument),
      getDocumentOrNull(recordDocument),
      legacyRecordDocument
        ? getDocumentOrNull(legacyRecordDocument)
        : Promise.resolve(null),
      legacyRewardDocument
        ? getDocumentOrNull(legacyRewardDocument)
        : Promise.resolve(null)
    ]);

    if (!isAuthorizedAccount(transactionAdmin, openid)) {
      return {
        success: false,
        code: "ADMIN_FORBIDDEN",
        message: "复审权限已失效"
      };
    }

    if (!record || normalizeText(record._id, 128) !== recordId) {
      return {
        success: false,
        code: "RECORD_NOT_FOUND",
        message: "待审读后感不存在"
      };
    }

    const actualCommentHash = createCommentHash(record);

    if (actualCommentHash !== expectedCommentHash) {
      return {
        success: false,
        code: "REVIEW_STALE",
        message: "读后感已被覆盖，请重新读取最新稿件后复审"
      };
    }

    const existingReview = record.moderation && record.moderation.review;

    if (
      decision === "approve" &&
      record.status === "completed" &&
      existingReview &&
      existingReview.decision === "approve" &&
      existingReview.commentHash === expectedCommentHash
    ) {
      return {
        success: true,
        recordId,
        status: "completed",
        decision,
        alreadyReviewed: true,
        starAwarded: 0,
        fullBookGranted: false
      };
    }

    if (
      decision === "reject" &&
      record.status === "revision_required" &&
      existingReview &&
      existingReview.decision === "reject" &&
      existingReview.commentHash === expectedCommentHash
    ) {
      return {
        success: true,
        recordId,
        status: "revision_required",
        decision,
        alreadyReviewed: true,
        starAwarded: 0,
        fullBookGranted: false
      };
    }

    if (record.status !== "pending_review") {
      return {
        success: false,
        code: "RECORD_NOT_PENDING_REVIEW",
        message: "该读后感已不处于待复审状态"
      };
    }

    const userId = normalizeText(record.userId, 128);
    const contentId = normalizeText(record.contentId, 64);

    if (!userId || !CONTENT_ID_PATTERN.test(contentId)) {
      throw new Error("pending review record identity is invalid");
    }

    const contentDocument = transaction.collection("contents").doc(contentId);
    const content = await getDocumentOrNull(contentDocument);
    const pendingReviewCount = content && content.pendingReviewCount;

    if (
      !content ||
      normalizeText(content._id, 64) !== contentId ||
      normalizeText(content.contentId, 64) !== contentId ||
      !Number.isInteger(pendingReviewCount) ||
      pendingReviewCount < 1
    ) {
      return {
        success: false,
        code: "CONTENT_REVIEW_STATE_INVALID",
        message: "内容复审计数异常，请先核对数据"
      };
    }

    if (
      legacyEarnedState.record &&
      (!transactionLegacyRecord ||
        normalizeText(transactionLegacyRecord.userId, 128) ||
        normalizeText(transactionLegacyRecord.openid, 128) !==
          normalizeText(record.openid, 128) ||
        normalizeText(transactionLegacyRecord.contentId, 64) !== contentId ||
        transactionLegacyRecord.status !== "completed")
    ) {
      throw new Error("legacy completed record changed during moderation");
    }

    if (
      legacyEarnedState.reward &&
      (!transactionLegacyReward ||
        normalizeText(transactionLegacyReward.userId, 128) ||
        normalizeText(transactionLegacyReward.openid, 128) !==
          normalizeText(record.openid, 128) ||
        normalizeText(transactionLegacyReward.contentId, 64) !== contentId ||
        transactionLegacyReward.rewardType !== REWARD_TYPE ||
        transactionLegacyReward.status !== "granted" ||
        Number(
          transactionLegacyReward.amount || STAR_REWARD_PER_COMPLETION
        ) !== STAR_REWARD_PER_COMPLETION)
    ) {
      throw new Error("legacy reward changed during moderation");
    }

    const now = db.serverDate();
    const reviewAudit = {
      decision,
      commentHash: expectedCommentHash,
      adminAccountId: transactionAdmin._id,
      adminRole: getRoles(transactionAdmin).includes("admin")
        ? "admin"
        : getRoles(transactionAdmin).includes("content-reviewer")
          ? "content-reviewer"
          : "moderator",
      reviewedAt: now
    };

    if (decision === "reject") {
      await recordDocument.update({
        data: {
          status: "revision_required",
          completedAt: null,
          updateTime: now,
          moderation: {
            ...((record.moderation && typeof record.moderation === "object")
              ? record.moderation
              : {}),
            decision: "rejected",
            reviewRecommended: false,
            review: reviewAudit
          }
        }
      });
      await contentDocument.update({
        data: {
          pendingReviewCount: pendingReviewCount - 1,
          reviewStateUpdatedAt: now,
          updateTime: now
        }
      });

      return {
        success: true,
        recordId,
        status: "revision_required",
        decision,
        alreadyReviewed: false,
        starAwarded: 0,
        fullBookGranted: false
      };
    }

    const userDocument = transaction.collection("users").doc(userId);
    const user = await getDocumentOrNull(userDocument);

    if (
      !user ||
      normalizeText(user._id, 128) !== userId ||
      !isActiveUser(user) ||
      normalizeText(user.openid, 128) !== normalizeText(record.openid, 128)
    ) {
      return {
        success: false,
        code: "MEMBER_ACCOUNT_UNAVAILABLE",
        message: "读后感所属会员账号不可用"
      };
    }

    const contentRevision = normalizeText(content && content.currentRevision, 128);

    if (
      !content ||
      normalizeText(content._id, 64) !== contentId ||
      normalizeText(content.contentId, 64) !== contentId ||
      content.status !== "published" ||
      !contentRevision ||
      contentRevision !== normalizeText(record.contentRevision, 128)
    ) {
      return {
        success: false,
        code: "CONTENT_REVISION_CHANGED",
        message: "内容已更新或下架，请让读者重新阅读后提交"
      };
    }

    const candidateBookId = normalizeText(content.bookId, 64);
    const bookId = CONTENT_ID_PATTERN.test(candidateBookId)
      ? candidateBookId
      : "";
    const rewardId = createRewardId(userId, contentId);
    const rewardDocument = transaction
      .collection("rewardLedger")
      .doc(rewardId);
    const entitlementId = bookId
      ? createEntitlementId(userId, bookId)
      : "";
    const entitlementDocument = entitlementId
      ? transaction.collection("bookEntitlements").doc(entitlementId)
      : null;
    const [existingReward, existingEntitlement] = await Promise.all([
      getDocumentOrNull(rewardDocument),
      entitlementDocument
        ? getDocumentOrNull(entitlementDocument)
        : Promise.resolve(null)
    ]);

    validateExistingReward(existingReward, userId, contentId, recordId);
    validateExistingEntitlement(existingEntitlement, userId, bookId);

    const memberId = normalizeText(user.memberId, 128);
    const legacyCompletedAt =
      (transactionLegacyRecord &&
        (transactionLegacyRecord.firstCompletedAt ||
          transactionLegacyRecord.completedAt)) ||
      (transactionLegacyReward &&
        (transactionLegacyReward.grantedAt ||
          transactionLegacyReward.createTime)) ||
      null;
    const previouslyEarned = Boolean(
      existingReward ||
        record.firstCompletedAt ||
        transactionLegacyRecord ||
        transactionLegacyReward
    );
    const firstCompletedAt =
      record.firstCompletedAt || legacyCompletedAt || now;

    await recordDocument.update({
      data: {
        memberId,
        bookId,
        bookTitle: normalizeText(content.title, 120) || record.bookTitle,
        status: "completed",
        firstCompletedAt,
        completedAt: now,
        updateTime: now,
        moderation: {
          ...((record.moderation && typeof record.moderation === "object")
            ? record.moderation
            : {}),
          decision: "approved",
          reviewRecommended: false,
          review: reviewAudit
        }
      }
    });
    await contentDocument.update({
      data: {
        pendingReviewCount: pendingReviewCount - 1,
        reviewStateUpdatedAt: now,
        updateTime: now
      }
    });

    let starAwarded = 0;
    let fullBookGranted = false;

    if (!existingReward) {
      await rewardDocument.set({
        data: {
          userId,
          memberId,
          openid: normalizeText(record.openid, 128),
          rewardType: REWARD_TYPE,
          sourceType: "reading-record",
          sourceId: recordId,
          contentId,
          amount: STAR_REWARD_PER_COMPLETION,
          status: "granted",
          grantedAt: firstCompletedAt,
          migrationSource: previouslyEarned
            ? transactionLegacyRecord || transactionLegacyReward
              ? "legacy-openid"
              : "existing-completion"
            : "manual-review",
          schemaVersion: 2,
          createTime: now
        }
      });
      starAwarded = previouslyEarned ? 0 : STAR_REWARD_PER_COMPLETION;
    }

    if (entitlementDocument && !existingEntitlement) {
      await entitlementDocument.set({
        data: {
          userId,
          memberId,
          openid: normalizeText(record.openid, 128),
          bookId,
          sourceType: "reading-record",
          sourceId: recordId,
          sourceContentId: contentId,
          status: "active",
          grantedAt: firstCompletedAt,
          createTime: now,
          schemaVersion: 1
        }
      });
      fullBookGranted = true;
    }

    return {
      success: true,
      recordId,
      status: "completed",
      decision,
      alreadyReviewed: false,
      starAwarded,
      fullBookGranted
    };
  });

  return unwrapTransactionResult(rawResult);
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    const admin = await resolveAdmin(openid);

    if (!admin.success) {
      return admin;
    }

    const action = normalizeText(event.action, 32);

    if (action === "listPending") {
      return await listPending(event);
    }

    if (action === "review") {
      return await reviewRecord(event, admin, openid);
    }

    return {
      success: false,
      code: "INVALID_ACTION",
      message: "复审操作无效"
    };
  } catch (error) {
    console.error("moderationCenter error:", error);

    return {
      success: false,
      code: "MODERATION_CENTER_FAILED",
      message: "读后感复审服务暂不可用"
    };
  }
};
