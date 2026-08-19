const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { inspectComment } = require("./moderation");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const MIN_COMMENT_LENGTH = 100;
const MAX_COMMENT_LENGTH = 2000;
const STAR_REWARD_PER_COMPLETION = 50;
const REWARD_TYPE = "content-completion";
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function getCharacterCount(value) {
  return Array.from(value).length;
}

function createDeterministicId(namespace, values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex")
    .slice(0, 32);
}

function createSessionId(openid) {
  return createDeterministicId("member-session", [openid]);
}

function createPrimaryUserId(openid) {
  return createDeterministicId("user-openid", [openid]);
}

function createStateId(userId, contentId) {
  return createDeterministicId("reading-state", [userId, contentId]);
}

function createRecordId(userId, contentId) {
  return createDeterministicId("reading-record", [userId, contentId]);
}

function createRewardId(userId, contentId) {
  return createDeterministicId(REWARD_TYPE, [userId, contentId]);
}

function createEntitlementId(userId, bookId) {
  return createDeterministicId("book-entitlement", [userId, bookId]);
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function getTimeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : NaN;
  }

  if (value && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validateSession(session, expectedUserId = "") {
  if (
    !session ||
    session.status !== "active" ||
    !normalizeText(session.userId, 128)
  ) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员"
    };
  }

  if (expectedUserId && normalizeText(session.userId, 128) !== expectedUserId) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "会员登录状态已切换，请重新操作"
    };
  }

  const expiresAt = getTimeValue(session.expiresAt);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return {
      success: false,
      code: "MEMBER_SESSION_EXPIRED",
      message: "会员登录已过期，请重新登录"
    };
  }

  return { success: true };
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

function isDocumentNotFound(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(
    (error && (error.errMsg || error.message)) || ""
  );

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

function normalizePublishedContent(content, contentId) {
  if (
    !content ||
    normalizeText(content._id, 64) !== contentId ||
    normalizeText(content.contentId, 64) !== contentId ||
    content.status !== "published"
  ) {
    return null;
  }

  const title = normalizeText(content.title, 120);
  const revision = normalizeText(content.currentRevision, 128);
  const candidateBookId = normalizeText(content.bookId, 64);

  if (!title || !revision) {
    return null;
  }

  return {
    id: contentId,
    title,
    revision,
    bookId: CONTENT_ID_PATTERN.test(candidateBookId) ? candidateBookId : ""
  };
}

async function resolveMember(openid) {
  const sessionId = createSessionId(openid);
  const session = await getDocumentOrNull(
    db.collection("memberSessions").doc(sessionId)
  );
  const validation = validateSession(session);

  if (!validation.success) {
    return validation;
  }

  const userId = normalizeText(session.userId, 128);
  const user = await getDocumentOrNull(db.collection("users").doc(userId));

  if (
    !user ||
    normalizeText(user._id, 128) !== userId ||
    normalizeText(user.openid, 128) !== openid
  ) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "会员登录状态已失效，请重新登录"
    };
  }

  if (!isActiveUser(user)) {
    return {
      success: false,
      code: "ACCOUNT_INACTIVE",
      message: "当前会员账号已停用"
    };
  }

  const memberId = normalizeText(session.memberId || user.memberId, 128);

  if (!memberId) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "会员登录信息不完整，请重新登录"
    };
  }

  return {
    success: true,
    sessionId,
    session,
    user,
    userId,
    memberId
  };
}

async function getPublishedContent(contentId) {
  const content = await getDocumentOrNull(
    db.collection("contents").doc(contentId)
  );
  return normalizePublishedContent(content, contentId);
}

async function readLegacyEarnedState(member, openid, contentId) {
  if (member.userId !== createPrimaryUserId(openid)) {
    return { record: null, reward: null };
  }

  const [recordResult, rewardResult] = await Promise.all([
    db
      .collection("records")
      .where({ openid, contentId })
      .limit(20)
      .get(),
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
  const legacyRecords = Array.isArray(recordResult && recordResult.data)
    ? recordResult.data.filter(
        (record) => !normalizeText(record.userId, 128)
      )
    : [];
  const legacyRewards = Array.isArray(rewardResult && rewardResult.data)
    ? rewardResult.data.filter(
        (reward) => !normalizeText(reward.userId, 128)
      )
    : [];
  const completedRecord = legacyRecords.find(
    (record) => record.status === "completed"
  );
  const grantedReward = legacyRewards.find(
    (reward) =>
      reward.status === "granted" &&
      reward.rewardType === REWARD_TYPE &&
      Number(reward.amount || STAR_REWARD_PER_COMPLETION) ===
        STAR_REWARD_PER_COMPLETION
  );

  return {
    record: completedRecord || null,
    reward: grantedReward || null
  };
}

async function countGrantedCompletionRewards(userId) {
  const result = await db
    .collection("rewardLedger")
    .where({
      userId,
      rewardType: REWARD_TYPE,
      status: "granted"
    })
    .count();

  return Number(result.total || 0);
}

function hasMatchingIdentity(document, expected) {
  return Object.entries(expected).every(
    ([key, value]) => normalizeText(document && document[key], 128) === value
  );
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);
    const contentId = normalizeText(event.contentId, 64);
    const comment = normalizeText(event.comment);

    if (!openid) {
      return {
        success: false,
        code: "MISSING_OPENID",
        message: "无法识别当前微信用户"
      };
    }

    if (!CONTENT_ID_PATTERN.test(contentId)) {
      return {
        success: false,
        code: "INVALID_CONTENT_ID",
        message: "阅读内容不存在或尚未开放"
      };
    }

    const commentLength = getCharacterCount(comment);

    if (
      commentLength < MIN_COMMENT_LENGTH ||
      commentLength > MAX_COMMENT_LENGTH
    ) {
      return {
        success: false,
        code: "INVALID_COMMENT",
        message: "读后感应为100至2000字"
      };
    }

    const member = await resolveMember(openid);

    if (!member.success) {
      return member;
    }

    const content = await getPublishedContent(contentId);

    if (!content) {
      return {
        success: false,
        code: "INVALID_CONTENT_ID",
        message: "阅读内容不存在或尚未开放"
      };
    }

    const moderation = await inspectComment(db, comment);

    if (!moderation.allowed) {
      return {
        success: false,
        code: moderation.code,
        message: moderation.message
      };
    }

    const requiresReview = Boolean(moderation.requiresReview);
    const legacyEarnedState = await readLegacyEarnedState(
      member,
      openid,
      contentId
    );
    const recordId = createRecordId(member.userId, contentId);
    const rewardId = createRewardId(member.userId, contentId);
    const stateId = createStateId(member.userId, contentId);
    const entitlementId = content.bookId
      ? createEntitlementId(member.userId, content.bookId)
      : "";
    const rawTransactionResult = await db.runTransaction(async (transaction) => {
      const sessionDocument = transaction
        .collection("memberSessions")
        .doc(member.sessionId);
      const userDocument = transaction.collection("users").doc(member.userId);
      const contentDocument = transaction.collection("contents").doc(contentId);
      const stateDocument = transaction.collection("readingStates").doc(stateId);
      const recordDocument = transaction.collection("records").doc(recordId);
      const rewardDocument = transaction
        .collection("rewardLedger")
        .doc(rewardId);
      const entitlementDocument = entitlementId
        ? transaction.collection("bookEntitlements").doc(entitlementId)
        : null;
      const legacyRecordDocument = legacyEarnedState.record
        ? transaction
            .collection("records")
            .doc(legacyEarnedState.record._id)
        : null;
      const legacyRewardDocument = legacyEarnedState.reward
        ? transaction
            .collection("rewardLedger")
            .doc(legacyEarnedState.reward._id)
        : null;
      const transactionSession = await getDocumentOrNull(sessionDocument);
      const transactionUser = await getDocumentOrNull(userDocument);
      const transactionContentDocument = await getDocumentOrNull(
        contentDocument
      );
      const readingState = await getDocumentOrNull(stateDocument);
      const existingRecord = await getDocumentOrNull(recordDocument);
      const existingReward = await getDocumentOrNull(rewardDocument);
      const existingEntitlement = entitlementDocument
        ? await getDocumentOrNull(entitlementDocument)
        : null;
      const transactionLegacyRecord = legacyRecordDocument
        ? await getDocumentOrNull(legacyRecordDocument)
        : null;
      const transactionLegacyReward = legacyRewardDocument
        ? await getDocumentOrNull(legacyRewardDocument)
        : null;
      const sessionValidation = validateSession(
        transactionSession,
        member.userId
      );

      if (!sessionValidation.success) {
        return sessionValidation;
      }

      if (
        !transactionUser ||
        normalizeText(transactionUser._id, 128) !== member.userId ||
        normalizeText(transactionUser.openid, 128) !== openid
      ) {
        return {
          success: false,
          code: "MEMBER_LOGIN_REQUIRED",
          message: "会员登录状态已失效，请重新登录"
        };
      }

      if (!isActiveUser(transactionUser)) {
        return {
          success: false,
          code: "ACCOUNT_INACTIVE",
          message: "当前会员账号已停用"
        };
      }

      const transactionContent = normalizePublishedContent(
        transactionContentDocument,
        contentId
      );

      if (!transactionContent) {
        return {
          success: false,
          code: "INVALID_CONTENT_ID",
          message: "阅读内容不存在或尚未开放"
        };
      }

      if (transactionContent.revision !== content.revision) {
        return {
          success: false,
          code: "CONTENT_REVISION_CHANGED",
          message: "内容版本已更新，请重新阅读后提交"
        };
      }

      if (
        !readingState ||
        !hasMatchingIdentity(readingState, {
          userId: member.userId,
          contentId
        }) ||
        normalizeText(readingState.contentRevision, 128) !==
          transactionContent.revision
      ) {
        return {
          success: false,
          code: "READ_REQUIRED",
          message: "提交读后感前，请先打开当前版本的正文"
        };
      }

      if (
        existingRecord &&
        !hasMatchingIdentity(existingRecord, {
          userId: member.userId,
          contentId
        })
      ) {
        throw new Error("reading record identity mismatch");
      }

      if (
        existingReward &&
        (!hasMatchingIdentity(existingReward, {
          userId: member.userId,
          contentId,
          rewardType: REWARD_TYPE,
          sourceId: recordId
        }) ||
          existingReward.status !== "granted" ||
          existingReward.amount !== STAR_REWARD_PER_COMPLETION)
      ) {
        throw new Error("reward ledger identity mismatch");
      }

      if (
        existingEntitlement &&
        !hasMatchingIdentity(existingEntitlement, {
          userId: member.userId,
          bookId: transactionContent.bookId
        })
      ) {
        throw new Error("book entitlement identity mismatch");
      }

      if (
        legacyEarnedState.record &&
        (!transactionLegacyRecord ||
          normalizeText(transactionLegacyRecord.userId, 128) ||
          !hasMatchingIdentity(transactionLegacyRecord, {
            openid,
            contentId
          }) ||
          transactionLegacyRecord.status !== "completed")
      ) {
        throw new Error("legacy reading record changed during migration");
      }

      if (
        legacyEarnedState.reward &&
        (!transactionLegacyReward ||
          normalizeText(transactionLegacyReward.userId, 128) ||
          !hasMatchingIdentity(transactionLegacyReward, {
            openid,
            contentId,
            rewardType: REWARD_TYPE
          }) ||
          transactionLegacyReward.status !== "granted" ||
          Number(
            transactionLegacyReward.amount || STAR_REWARD_PER_COMPLETION
          ) !== STAR_REWARD_PER_COMPLETION)
      ) {
        throw new Error("legacy reward changed during migration");
      }

      const now = db.serverDate();
      const scopedRecordPreviouslyCompleted = Boolean(
        existingRecord && existingRecord.status === "completed"
      );
      const legacyCompletion = transactionLegacyRecord || null;
      const priorCompletedAt =
        (existingRecord &&
          (existingRecord.firstCompletedAt || existingRecord.completedAt)) ||
        (legacyCompletion &&
          (legacyCompletion.firstCompletedAt ||
            legacyCompletion.completedAt)) ||
        (transactionLegacyReward &&
          (transactionLegacyReward.grantedAt ||
            transactionLegacyReward.createTime)) ||
        null;
      const previouslyEarned = Boolean(
        existingReward ||
          scopedRecordPreviouslyCompleted ||
          legacyCompletion ||
          transactionLegacyReward
      );
      const firstSubmittedAt =
        (existingRecord &&
          (existingRecord.firstSubmittedAt ||
            existingRecord.firstCompletedAt ||
            existingRecord.completedAt)) ||
        (legacyCompletion &&
          (legacyCompletion.firstSubmittedAt ||
            legacyCompletion.firstCompletedAt ||
            legacyCompletion.completedAt)) ||
        now;
      const firstCompletedAt = requiresReview
        ? priorCompletedAt
        : priorCompletedAt || now;
      const recordStatus = requiresReview ? "pending_review" : "completed";
      const wasPendingReview = Boolean(
        existingRecord && existingRecord.status === "pending_review"
      );
      const willBePendingReview = recordStatus === "pending_review";
      const pendingReviewDelta =
        Number(willBePendingReview) - Number(wasPendingReview);
      const storedPendingReviewCount = Number(
        transactionContentDocument.pendingReviewCount
      );

      if (
        (wasPendingReview || willBePendingReview) &&
        (!Number.isInteger(transactionContentDocument.pendingReviewCount) ||
          !Number.isInteger(storedPendingReviewCount) ||
          storedPendingReviewCount < 0 ||
          (wasPendingReview && storedPendingReviewCount < 1))
      ) {
        return {
          success: false,
          code: "CONTENT_REVIEW_STATE_UNINITIALIZED",
          message: "内容复审计数尚未初始化，请联系管理员处理"
        };
      }

      await recordDocument.set({
        data: {
          userId: member.userId,
          memberId: member.memberId,
          openid,
          contentId,
          bookId: transactionContent.bookId,
          bookTitle: transactionContent.title,
          titleSnapshot: transactionContent.title,
          contentRevision: transactionContent.revision,
          comment,
          status: recordStatus,
          firstSubmittedAt,
          submittedAt: now,
          firstCompletedAt,
          completedAt: requiresReview ? null : now,
          updateTime: now,
          moderation: {
            checked: true,
            decision: moderation.decision ||
              (requiresReview ? "review" : "approved"),
            libraryVersion: moderation.version,
            reviewRecommended: requiresReview,
            reviewCategory: moderation.reviewCategory || ""
          },
          schemaVersion: 4
        }
      });

      if (pendingReviewDelta !== 0) {
        await contentDocument.update({
          data: {
            pendingReviewCount:
              storedPendingReviewCount + pendingReviewDelta,
            reviewStateUpdatedAt: now,
            updateTime: now
          }
        });
      }

      let starAwarded = 0;
      let fullBookGranted = false;
      const shouldHaveReward = !requiresReview || previouslyEarned;

      if (!existingReward && shouldHaveReward) {
        const migrationSource = previouslyEarned
          ? legacyCompletion || transactionLegacyReward
            ? "legacy-openid"
            : "legacy-record"
          : "";

        await rewardDocument.set({
          data: {
            userId: member.userId,
            memberId: member.memberId,
            openid,
            rewardType: REWARD_TYPE,
            sourceType: "reading-record",
            sourceId: recordId,
            contentId,
            amount: STAR_REWARD_PER_COMPLETION,
            status: "granted",
            grantedAt: firstCompletedAt || now,
            migrationSource,
            schemaVersion: 2,
            createTime: now
          }
        });
        starAwarded = previouslyEarned ? 0 : STAR_REWARD_PER_COMPLETION;
      }

      if (
        entitlementDocument &&
        !existingEntitlement &&
        (!requiresReview || previouslyEarned)
      ) {
        await entitlementDocument.set({
          data: {
            userId: member.userId,
            memberId: member.memberId,
            openid,
            bookId: transactionContent.bookId,
            sourceType: "reading-record",
            sourceId: recordId,
            sourceContentId: contentId,
            status: "active",
            grantedAt: firstCompletedAt || now,
            createTime: now,
            schemaVersion: 1
          }
        });
        fullBookGranted = true;
      }

      return {
        success: true,
        content: transactionContent,
        recordStatus,
        requiresReview,
        starAwarded,
        fullBookGranted,
        fullBookUnlocked: Boolean(
          transactionContent.bookId &&
            (existingEntitlement || fullBookGranted)
        )
      };
    });
    const transactionResult = unwrapTransactionResult(rawTransactionResult);

    if (!transactionResult || !transactionResult.success) {
      return transactionResult || {
        success: false,
        code: "RECORD_SAVE_FAILED",
        message: "阅读记录保存失败"
      };
    }

    let starTotal = null;

    try {
      const rewardCount = await countGrantedCompletionRewards(member.userId);
      starTotal = rewardCount * STAR_REWARD_PER_COMPLETION;
    } catch (countError) {
      console.error("saveRecord reward count error:", countError);
    }

    return {
      success: true,
      record: {
        id: recordId,
        contentId,
        bookId: transactionResult.content.bookId,
        bookTitle: transactionResult.content.title,
        status: transactionResult.recordStatus,
        contentRevision: transactionResult.content.revision
      },
      requiresReview: transactionResult.requiresReview,
      reviewStatus: transactionResult.requiresReview
        ? "pending_review"
        : "approved",
      starAwarded: transactionResult.starAwarded,
      starTotal,
      starTotalPending: starTotal === null,
      fullBookGranted: transactionResult.fullBookGranted,
      fullBookUnlocked: transactionResult.fullBookUnlocked
    };
  } catch (error) {
    console.error("saveRecord error:", error);

    return {
      success: false,
      code: "RECORD_SAVE_FAILED",
      message: "阅读记录保存失败"
    };
  }
};
