const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SCAN_BATCH_SIZE = 50;
const MAX_SCAN_BATCHES = 10;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSessionId(openid) {
  return sha256(JSON.stringify(["member-session", openid])).slice(0, 32);
}

function normalizeText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLength);
}

function normalizeLimit(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(number)))
    : DEFAULT_LIMIT;
}

function normalizeOffset(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? Math.min(10000, number)
    : 0;
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value.toMillis === "function") {
    return toTimestamp(value.toMillis());
  }

  if (typeof value.toDate === "function") {
    return toTimestamp(value.toDate());
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isDocumentNotFound(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist|not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

async function readDocument(reference) {
  try {
    const result = await reference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function isActiveUser(user) {
  return Boolean(user) &&
    (!user.registerStatus || user.registerStatus === "active");
}

async function resolveActiveMember(openid) {
  const session = await readDocument(
    db.collection("memberSessions").doc(createSessionId(openid))
  );

  if (
    !session ||
    session.openid !== openid ||
    session.status !== "active" ||
    !session.userId ||
    toTimestamp(session.expiresAt) <= Date.now()
  ) {
    return null;
  }

  const user = await readDocument(db.collection("users").doc(session.userId));

  if (
    !isActiveUser(user) ||
    user._id !== session.userId ||
    user.openid !== openid
  ) {
    return null;
  }

  return { userId: user._id, user };
}

function isUnexpired(message, now) {
  if (
    message.expiresAt === undefined ||
    message.expiresAt === null ||
    message.expiresAt === ""
  ) {
    return true;
  }

  return toTimestamp(message.expiresAt) > now;
}

function createSafeMessage(message) {
  return {
    id: normalizeText(message._id, 128),
    type: normalizeText(message.type, 32),
    title: normalizeText(message.title, 120),
    content: normalizeText(message.content || message.body, 2000),
    publishedAt: message.publishedAt || null,
    expiresAt: message.expiresAt || null,
    isRead: Boolean(message.readAt),
    readAt: message.readAt || null
  };
}

async function listMessages(userId, limit, initialOffset) {
  const now = Date.now();
  let offset = normalizeOffset(initialOffset);
  let hasMore = false;
  const messages = [];

  scan:
  for (let batch = 0; batch < MAX_SCAN_BATCHES; batch += 1) {
    const result = await db
      .collection("memberMessages")
      .where({
        userId,
        status: "published",
        publishedAt: db.command.lte(new Date(now))
      })
      .orderBy("publishedAt", "desc")
      .orderBy("_id", "desc")
      .skip(offset)
      .limit(SCAN_BATCH_SIZE)
      .get();

    if (!result || !Array.isArray(result.data)) {
      throw new Error("memberMessages returned an invalid result");
    }

    for (let index = 0; index < result.data.length; index += 1) {
      const message = result.data[index];
      offset += 1;

      if (isUnexpired(message, now)) {
        messages.push(createSafeMessage(message));
      }

      if (messages.length >= limit) {
        hasMore = index < result.data.length - 1 || result.data.length === SCAN_BATCH_SIZE;
        break scan;
      }
    }

    if (result.data.length < SCAN_BATCH_SIZE) {
      hasMore = false;
      break;
    }

    hasMore = true;
  }

  return {
    success: true,
    messages,
    nextOffset: hasMore && offset <= 10000 ? offset : null
  };
}

async function markMessageRead(userId, messageId) {
  const result = await db
    .collection("memberMessages")
    .where({
      _id: messageId,
      userId,
      status: "published"
    })
    .limit(1)
    .get();
  const message = result.data[0];
  const now = Date.now();

  if (
    !message ||
    !message.publishedAt ||
    toTimestamp(message.publishedAt) > now ||
    !isUnexpired(message, now)
  ) {
    return {
      success: false,
      code: "MESSAGE_NOT_AVAILABLE",
      message: "消息不存在或已失效"
    };
  }

  if (!message.readAt) {
    await db.collection("memberMessages").doc(messageId).update({
      data: {
        readAt: db.serverDate(),
        updateTime: db.serverDate()
      }
    });
  }

  return {
    success: true,
    message: {
      id: messageId,
      isRead: true,
      alreadyRead: Boolean(message.readAt)
    }
  };
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    const authentication = await resolveActiveMember(openid);

    if (!authentication) {
      return {
        success: false,
        code: "MEMBER_LOGIN_REQUIRED",
        message: "请先登录少年会员"
      };
    }

    const action = normalizeText(event.action || "list", 20);

    if (action === "list") {
      return await listMessages(
        authentication.userId,
        normalizeLimit(event.limit),
        event.offset
      );
    }

    if (action === "markRead") {
      const messageId = normalizeText(event.messageId, 128);

      if (!messageId || /[\u0000-\u001f]/.test(messageId)) {
        return {
          success: false,
          code: "INVALID_MESSAGE_ID",
          message: "消息编号无效"
        };
      }

      return await markMessageRead(authentication.userId, messageId);
    }

    return {
      success: false,
      code: "INVALID_ACTION",
      message: "不支持的消息操作"
    };
  } catch (error) {
    console.error("memberInbox error:", error);

    return {
      success: false,
      code: "MEMBER_INBOX_UNAVAILABLE",
      message: "会员消息暂不可用"
    };
  }
};
