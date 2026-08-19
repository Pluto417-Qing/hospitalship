const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_INVITES_PER_WINDOW = 20;
const MAX_FAMILY_RELATIONS = 50;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSessionId(openid) {
  return sha256(JSON.stringify(["member-session", openid])).slice(0, 32);
}

function createRelationId(firstUserId, secondUserId) {
  return sha256(JSON.stringify([firstUserId, secondUserId].sort())).slice(0, 32);
}

function createRelationCounterId(userId) {
  return sha256(JSON.stringify(["family-relation-counter", userId])).slice(0, 32);
}

function createInviteCounterId(userId) {
  return sha256(JSON.stringify(["family-invite-counter", userId])).slice(0, 32);
}

function isActiveUser(user) {
  return Boolean(user) &&
    (!user.registerStatus || user.registerStatus === "active");
}

function getTimestamp(value) {
  if (!value) {
    return 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMissingDocument(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(
    (error && (error.errMsg || error.message)) || ""
  );

  return (
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist|not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

function createStageError(stage, error) {
  const message = String(
    (error && (error.errMsg || error.message)) ||
    error ||
    "unknown family center error"
  );
  const stagedError = new Error(message);

  stagedError.familyCenterStage = stage;
  stagedError.familyCenterCode = String(
    (error && (error.errCode || error.code)) || ""
  );
  stagedError.originalError = error;
  return stagedError;
}

async function readDocument(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isMissingDocument(error)) {
      return null;
    }

    throw error;
  }
}

function isUsableSession(session, openid) {
  return Boolean(
    session &&
    session.openid === openid &&
    session.status === "active" &&
    typeof session.userId === "string" &&
    session.userId &&
    getTimestamp(session.expiresAt) > Date.now()
  );
}

async function resolveActiveMember(openid) {
  const sessionId = createSessionId(openid);
  const session = await readDocument(
    db.collection("memberSessions").doc(sessionId)
  );

  if (!isUsableSession(session, openid)) {
    return null;
  }

  const user = await readDocument(db.collection("users").doc(session.userId));

  if (
    !isActiveUser(user) ||
    user._id !== session.userId ||
    user.openid !== openid ||
    (session.memberId && user.memberId !== session.memberId)
  ) {
    return null;
  }

  return {
    openid,
    sessionId,
    session,
    user,
    userId: user._id
  };
}

async function revalidateActiveMember(transaction, authentication) {
  const session = await readDocument(
    transaction.collection("memberSessions").doc(authentication.sessionId)
  );
  const user = await readDocument(
    transaction.collection("users").doc(authentication.userId)
  );

  if (
    !isUsableSession(session, authentication.openid) ||
    session.userId !== authentication.userId ||
    !isActiveUser(user) ||
    user._id !== authentication.userId ||
    user.openid !== authentication.openid
  ) {
    return null;
  }

  return user;
}

function displayName(user, fallback) {
  return String(
    (user && (user.nickname || user.memberId)) || fallback
  ).trim().slice(0, 30);
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

function loginRequiredResult() {
  return {
    success: false,
    code: "MEMBER_LOGIN_REQUIRED",
    message: "请先登录少年会员"
  };
}

function inviteCreatedResult(inviteToken, expiresAtMs) {
  return {
    success: true,
    inviteToken,
    expiresAtMs
  };
}

function isCommittedInvite(
  invite,
  authentication,
  tokenHash,
  expiresAtMs
) {
  return Boolean(
    invite &&
    invite._id === tokenHash &&
    invite.inviterUserId === authentication.userId &&
    invite.inviterGuardianOpenid === authentication.openid &&
    invite.status === "pending" &&
    getTimestamp(invite.expiresAt) === expiresAtMs
  );
}

async function recoverCommittedInvite(
  authentication,
  tokenHash,
  inviteToken,
  expiresAtMs
) {
  try {
    const invite = await readDocument(
      db.collection("familyInvites").doc(tokenHash)
    );

    return isCommittedInvite(
      invite,
      authentication,
      tokenHash,
      expiresAtMs
    )
      ? inviteCreatedResult(inviteToken, expiresAtMs)
      : null;
  } catch (error) {
    console.error("family invite commit recovery error:", error);
    return null;
  }
}

function isRelationForPair(relation, firstUserId, secondUserId) {
  if (!relation) {
    return false;
  }

  const storedPair = [relation.memberUserId, relation.relativeUserId].sort();
  const expectedPair = [firstUserId, secondUserId].sort();

  return storedPair.every((userId, index) => userId === expectedPair[index]);
}

async function countActiveRelations(userId) {
  const relations = db.collection("familyRelations");
  const [asMember, asRelative] = await Promise.all([
    relations.where({ memberUserId: userId, status: "active" }).count(),
    relations.where({ relativeUserId: userId, status: "active" }).count()
  ]);

  return Number(asMember.total || 0) + Number(asRelative.total || 0);
}

async function listRelations(authentication) {
  const relations = db.collection("familyRelations");
  const [asMember, asRelative] = await Promise.all([
    relations
      .where({ memberUserId: authentication.userId, status: "active" })
      .limit(MAX_FAMILY_RELATIONS)
      .get(),
    relations
      .where({ relativeUserId: authentication.userId, status: "active" })
      .limit(MAX_FAMILY_RELATIONS)
      .get()
  ]);
  const seen = new Set();
  const familyMembers = [];

  [...asMember.data, ...asRelative.data].forEach((relation) => {
    if (!relation || seen.has(relation._id)) {
      return;
    }

    seen.add(relation._id);
    const callerIsMember = relation.memberUserId === authentication.userId;
    familyMembers.push({
      id: relation._id,
      displayName: callerIsMember
        ? relation.relativeDisplayName || "少年会员"
        : relation.memberDisplayName || "少年会员",
      relationLabel: "亲友",
      status: "active",
      statusText: "已加入",
      joinedAtMs: getTimestamp(relation.createdAt)
    });
  });

  familyMembers.sort((left, right) => right.joinedAtMs - left.joinedAtMs);

  return {
    success: true,
    familyMembers: familyMembers.slice(0, MAX_FAMILY_RELATIONS)
  };
}

async function createInvite(authentication) {
  let recentInviteCount;

  try {
    recentInviteCount = await db
      .collection("familyInvites")
      .where({
        inviterUserId: authentication.userId,
        createdAt: db.command.gte(new Date(Date.now() - INVITE_RATE_WINDOW_MS))
      })
      .count();
  } catch (error) {
    throw createStageError("recent-invite-count", error);
  }

  const initialRecentCount = Number(recentInviteCount.total || 0);
  const inviteToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256(inviteToken);
  const now = Date.now();
  const expiresAtMs = now + INVITE_TTL_MS;
  const counterId = createInviteCounterId(authentication.userId);
  let callbackOutcome = null;
  let rawOutcome;
  let transactionStage = "transaction-start";

  try {
    rawOutcome = await db.runTransaction(async (transaction) => {
      callbackOutcome = null;
      const counterDocument = transaction
        .collection("familyInviteCounters")
        .doc(counterId);
      transactionStage = "transaction-member-read";
      const transactionUser = await revalidateActiveMember(
        transaction,
        authentication
      );
      transactionStage = "transaction-counter-read";
      const existingCounter = await readDocument(counterDocument);

      if (!transactionUser) {
        callbackOutcome = loginRequiredResult();
        return callbackOutcome;
      }

      if (existingCounter && existingCounter.userId !== authentication.userId) {
        callbackOutcome = {
          success: false,
          code: "INVITE_COUNTER_INVALID",
          message: "邀请状态异常，请稍后重试"
        };
        return callbackOutcome;
      }

      const windowStartedAt = getTimestamp(
        existingCounter && existingCounter.windowStartedAt
      );
      const windowIsActive = windowStartedAt > now - INVITE_RATE_WINDOW_MS;
      const storedCount = Number(existingCounter && existingCounter.inviteCount);
      const inviteCount = Math.max(
        windowIsActive && Number.isInteger(storedCount) && storedCount >= 0
          ? storedCount
          : 0,
        initialRecentCount
      );

      if (inviteCount >= MAX_INVITES_PER_WINDOW) {
        callbackOutcome = {
          success: false,
          code: "INVITE_RATE_LIMITED",
          message: "24小时内邀请次数已达上限，请稍后再试"
        };
        return callbackOutcome;
      }

      const counterData = {
        userId: authentication.userId,
        inviteCount: inviteCount + 1,
        windowStartedAt: windowIsActive
          ? existingCounter.windowStartedAt
          : new Date(now),
        schemaVersion: 2,
        updatedAt: db.serverDate()
      };

      transactionStage = "transaction-counter-set";
      await counterDocument.set({
        data: {
          ...counterData,
          createdAt:
            (existingCounter && existingCounter.createdAt) || db.serverDate()
        }
      });

      transactionStage = "transaction-invite-set";
      await transaction.collection("familyInvites").doc(tokenHash).set({
        data: {
          inviterUserId: authentication.userId,
          inviterMemberId: transactionUser.memberId,
          inviterGuardianOpenid: authentication.openid,
          inviterDisplayName: displayName(transactionUser, "少年会员"),
          status: "pending",
          expiresAt: new Date(expiresAtMs),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
          schemaVersion: 2
        }
      });

      transactionStage = "transaction-commit";
      callbackOutcome = { success: true };
      return callbackOutcome;
    }, 5);
  } catch (error) {
    const recovered = await recoverCommittedInvite(
      authentication,
      tokenHash,
      inviteToken,
      expiresAtMs
    );

    if (recovered) {
      return recovered;
    }

    throw createStageError(transactionStage, error);
  }

  const outcome = unwrapTransactionResult(rawOutcome) || callbackOutcome;

  if (!outcome || typeof outcome.success !== "boolean") {
    const recovered = await recoverCommittedInvite(
      authentication,
      tokenHash,
      inviteToken,
      expiresAtMs
    );

    if (recovered) {
      return recovered;
    }

    throw new Error("family invite transaction outcome missing");
  }

  if (!outcome.success) {
    return outcome;
  }

  return inviteCreatedResult(inviteToken, expiresAtMs);
}

async function acceptInvite(authentication, rawToken) {
  const inviteToken = String(rawToken || "").trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(inviteToken)) {
    return {
      success: false,
      code: "INVALID_INVITE",
      message: "亲友邀请无效"
    };
  }

  const tokenHash = sha256(inviteToken);
  const invitePreview = await readDocument(
    db.collection("familyInvites").doc(tokenHash)
  );
  const inviterUserId = String(
    (invitePreview && invitePreview.inviterUserId) || ""
  );
  const [inviterRelationCount, acceptingRelationCount] = await Promise.all([
    inviterUserId ? countActiveRelations(inviterUserId) : Promise.resolve(0),
    countActiveRelations(authentication.userId)
  ]);

  const rawOutcome = await db.runTransaction(async (transaction) => {
    const inviteDocument = transaction
      .collection("familyInvites")
      .doc(tokenHash);
    const invite = await readDocument(inviteDocument);
    const acceptingUser = await revalidateActiveMember(
      transaction,
      authentication
    );

    if (!acceptingUser) {
      return loginRequiredResult();
    }

    if (!invite) {
      return {
        success: false,
        code: "INVALID_INVITE",
        message: "亲友邀请无效"
      };
    }

    if (!invite.inviterUserId) {
      return {
        success: false,
        code: "INVITE_REISSUE_REQUIRED",
        message: "该邀请版本已失效，请邀请人重新发送"
      };
    }

    if (invite.inviterUserId === authentication.userId) {
      return {
        success: false,
        code: "SELF_INVITE",
        message: "不能接受自己的亲友邀请"
      };
    }

    if (invite.status === "accepted") {
      if (invite.acceptedByUserId === authentication.userId) {
        return {
          success: true,
          relationId: invite.relationId,
          alreadyAccepted: true
        };
      }

      return {
        success: false,
        code: "INVITE_USED",
        message: "该亲友邀请已被使用"
      };
    }

    if (invite.status !== "pending") {
      return {
        success: false,
        code: invite.status === "expired" ? "INVITE_EXPIRED" : "INVITE_USED",
        message:
          invite.status === "expired"
            ? "该亲友邀请已过期"
            : "该亲友邀请已失效"
      };
    }

    if (getTimestamp(invite.expiresAt) <= Date.now()) {
      await inviteDocument.update({
        data: {
          status: "expired",
          updatedAt: db.serverDate()
        }
      });

      return {
        success: false,
        code: "INVITE_EXPIRED",
        message: "该亲友邀请已过期"
      };
    }

    const inviterUser = await readDocument(
      transaction.collection("users").doc(invite.inviterUserId)
    );

    if (!isActiveUser(inviterUser) || inviterUser._id !== invite.inviterUserId) {
      return {
        success: false,
        code: "INVITER_UNAVAILABLE",
        message: "邀请人会员状态已失效"
      };
    }

    const relationId = createRelationId(
      invite.inviterUserId,
      authentication.userId
    );
    const relationDocument = transaction
      .collection("familyRelations")
      .doc(relationId);
    const existingRelation = await readDocument(relationDocument);

    if (existingRelation) {
      if (
        !isRelationForPair(
          existingRelation,
          invite.inviterUserId,
          authentication.userId
        )
      ) {
        throw new Error("family relation identity mismatch");
      }

      if (existingRelation.status === "active") {
        await inviteDocument.update({
          data: {
            status: "accepted",
            acceptedByUserId: authentication.userId,
            acceptedAt: db.serverDate(),
            relationId,
            updatedAt: db.serverDate()
          }
        });

        return {
          success: true,
          relationId,
          alreadyAccepted: true
        };
      }
    }

    const inviterCounterId = createRelationCounterId(invite.inviterUserId);
    const acceptingCounterId = createRelationCounterId(authentication.userId);
    const inviterCounterDocument = transaction
      .collection("familyRelationCounters")
      .doc(inviterCounterId);
    const acceptingCounterDocument = transaction
      .collection("familyRelationCounters")
      .doc(acceptingCounterId);
    const inviterCounter = await readDocument(inviterCounterDocument);
    const acceptingCounter = await readDocument(acceptingCounterDocument);
    const inviterCount = Math.max(
      Number(inviterCounter && inviterCounter.activeCount) || 0,
      inviterRelationCount
    );
    const acceptingCount = Math.max(
      Number(acceptingCounter && acceptingCounter.activeCount) || 0,
      acceptingRelationCount
    );

    if (
      inviterCount >= MAX_FAMILY_RELATIONS ||
      acceptingCount >= MAX_FAMILY_RELATIONS
    ) {
      return {
        success: false,
        code: "FAMILY_LIMIT_REACHED",
        message: "亲友人数已达上限"
      };
    }

    await relationDocument.set({
      data: {
        memberUserId: invite.inviterUserId,
        relativeUserId: authentication.userId,
        memberDisplayName: invite.inviterDisplayName || "少年会员",
        relativeDisplayName: displayName(acceptingUser, "少年会员"),
        status: "active",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        schemaVersion: 2
      }
    });

    const counterUpdates = [
      [inviterCounterDocument, inviterCounter, invite.inviterUserId, inviterCount],
      [acceptingCounterDocument, acceptingCounter, authentication.userId, acceptingCount]
    ];

    for (const [documentReference, existingCounter, userId, activeCount] of counterUpdates) {
      const data = {
        userId,
        activeCount: activeCount + 1,
        schemaVersion: 2,
        updatedAt: db.serverDate()
      };

      if (existingCounter) {
        await documentReference.update({ data });
      } else {
        await documentReference.set({
          data: {
            ...data,
            createdAt: db.serverDate()
          }
        });
      }
    }

    await inviteDocument.update({
      data: {
        status: "accepted",
        acceptedByUserId: authentication.userId,
        acceptedAt: db.serverDate(),
        relationId,
        updatedAt: db.serverDate()
      }
    });

    return {
      success: true,
      relationId,
      alreadyAccepted: false
    };
  });

  return unwrapTransactionResult(rawOutcome);
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;

    if (!openid) {
      return {
        success: false,
        code: "UNAUTHORIZED",
        message: "无法识别当前微信用户"
      };
    }

    const authentication = await resolveActiveMember(openid);

    if (!authentication) {
      return loginRequiredResult();
    }

    switch (event.action) {
      case "list":
        return await listRelations(authentication);
      case "createInvite":
        return await createInvite(authentication);
      case "acceptInvite":
        return await acceptInvite(authentication, event.inviteToken);
      default:
        return {
          success: false,
          code: "INVALID_ACTION",
          message: "不支持的亲友操作"
        };
    }
  } catch (error) {
    console.error("familyCenter error:", {
      action: String(event.action || ""),
      stage: String(error.familyCenterStage || "unknown"),
      code: String(
        error.familyCenterCode ||
        error.errCode ||
        error.code ||
        ""
      ),
      message: String(error.errMsg || error.message || error),
      stack: error.stack || ""
    });

    return {
      success: false,
      code: "FAMILY_CENTER_ERROR",
      message: "亲友服务暂时不可用，请稍后重试"
    };
  }
};
