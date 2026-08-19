const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
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

function createStateId(userId, contentId) {
  return createDeterministicId("reading-state", [userId, contentId]);
}

function isDocumentNotFoundError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

async function getDocumentOrNull(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
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

function isActiveSession(session, now = Date.now()) {
  const expiresAt = getTimeValue(session && session.expiresAt);

  return Boolean(
    session &&
      session.status === "active" &&
      normalizeText(session.userId, 128) &&
      Number.isFinite(expiresAt) &&
      expiresAt > now
  );
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);
    const contentId = normalizeText(event.contentId, 64);
    const expectedRevision = normalizeText(event.contentRevision, 128);

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    if (!contentId || !CONTENT_ID_PATTERN.test(contentId)) {
      return {
        success: false,
        code: "INVALID_CONTENT_ID",
        message: "内容编号无效"
      };
    }

    if (!expectedRevision) {
      return {
        success: false,
        code: "CONTENT_REVISION_REQUIRED",
        message: "正文版本信息缺失，请重新打开正文"
      };
    }

    const sessionId = createSessionId(openid);
    const rawTransactionResult = await db.runTransaction(async (transaction) => {
      const sessionDocument = transaction
        .collection("memberSessions")
        .doc(sessionId);
      const session = await getDocumentOrNull(sessionDocument);

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

      if (!isActiveSession(session)) {
        return {
          success: false,
          code: "MEMBER_SESSION_EXPIRED",
          message: "会员登录已过期，请重新登录"
        };
      }

      const userId = normalizeText(session.userId, 128);
      const userDocument = transaction.collection("users").doc(userId);
      const contentDocument = transaction.collection("contents").doc(contentId);
      const user = await getDocumentOrNull(userDocument);
      const content = await getDocumentOrNull(contentDocument);

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

      const currentRevision = normalizeText(content && content.currentRevision, 128);

      if (
        !content ||
        normalizeText(content._id, 64) !== contentId ||
        normalizeText(content.contentId, 64) !== contentId ||
        content.status !== "published" ||
        !currentRevision
      ) {
        return {
          success: false,
          code: "CONTENT_NOT_PUBLISHED",
          message: "内容不存在或尚未开放"
        };
      }

      if (currentRevision !== expectedRevision) {
        return {
          success: false,
          code: "CONTENT_REVISION_CHANGED",
          message: "正文已更新，请重新打开后阅读"
        };
      }

      const stateId = createStateId(userId, contentId);
      const stateDocument = transaction
        .collection("readingStates")
        .doc(stateId);
      const existingState = await getDocumentOrNull(stateDocument);

      if (
        existingState &&
        (normalizeText(existingState.userId, 128) !== userId ||
          normalizeText(existingState.contentId, 64) !== contentId)
      ) {
        throw new Error("reading state identity mismatch");
      }

      const sameRevision = Boolean(
        existingState && existingState.contentRevision === currentRevision
      );

      if (existingState) {
        await stateDocument.update({
          data: {
            openid,
            memberId,
            contentRevision: currentRevision,
            revisionFirstReadAt: sameRevision
              ? existingState.revisionFirstReadAt || existingState.lastReadAt
              : db.serverDate(),
            lastReadAt: db.serverDate(),
            updateTime: db.serverDate(),
            schemaVersion: 2
          }
        });
      } else {
        await stateDocument.set({
          data: {
            userId,
            memberId,
            openid,
            contentId,
            contentRevision: currentRevision,
            firstReadAt: db.serverDate(),
            revisionFirstReadAt: db.serverDate(),
            lastReadAt: db.serverDate(),
            createTime: db.serverDate(),
            updateTime: db.serverDate(),
            schemaVersion: 2
          }
        });
      }

      return {
        success: true,
        userId,
        contentRevision: currentRevision,
        firstRead: !existingState,
        firstReadOfRevision: !sameRevision
      };
    });
    const transactionResult = unwrapTransactionResult(rawTransactionResult);

    if (!transactionResult || !transactionResult.success) {
      return transactionResult || {
        success: false,
        code: "READ_STATE_UNAVAILABLE",
        message: "云端阅读状态暂不可用"
      };
    }

    return {
      success: true,
      state: {
        contentId,
        contentRevision: transactionResult.contentRevision,
        viewed: true,
        firstRead: Boolean(transactionResult.firstRead),
        firstReadOfRevision: Boolean(transactionResult.firstReadOfRevision)
      }
    };
  } catch (error) {
    console.error("markContentRead error:", error);

    return {
      success: false,
      code: "READ_STATE_UNAVAILABLE",
      message: "云端阅读状态暂不可用"
    };
  }
};
