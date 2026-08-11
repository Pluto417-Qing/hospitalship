const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const MAX_PASSWORD_FAILURES = 5;
const PASSWORD_LOCK_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const MAX_PAGE_OFFSET = 10000;
const DATABASE_BATCH_SIZE = 100;
const MAX_LEGACY_NOTE_SCAN = MAX_PAGE_OFFSET + MAX_PAGE_LIMIT + 1;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});

function createSessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function createPrimaryUserId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["user-openid", openid]))
    .digest("hex")
    .slice(0, 32);
}

function hashLegacyPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${password}`)
    .digest("hex");
}

function hashScryptPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64, SCRYPT_OPTIONS)
    .toString("hex");
}

function safeEqualHex(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left || ""), "hex");
    const rightBuffer = Buffer.from(String(right || ""), "hex");

    return (
      leftBuffer.length > 0 &&
      leftBuffer.length === rightBuffer.length &&
      crypto.timingSafeEqual(leftBuffer, rightBuffer)
    );
  } catch (error) {
    return false;
  }
}

function getPasswordAlgorithm(user) {
  const algorithm = String(user.passwordAlgorithm || "").trim();

  if (!algorithm || algorithm === "sha256-v1") {
    return "sha256-v1";
  }

  if (algorithm === "scrypt-v1") {
    return algorithm;
  }

  return null;
}

function verifyPassword(password, user, algorithm) {
  const inputHash =
    algorithm === "scrypt-v1"
      ? hashScryptPassword(password, user.passwordSalt)
      : hashLegacyPassword(password, user.passwordSalt);

  return safeEqualHex(inputHash, user.passwordHash);
}

function toTimestamp(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toMillis === "function") {
    return toTimestamp(value.toMillis());
  }

  if (value && typeof value.toDate === "function") {
    return toTimestamp(value.toDate());
  }

  const timestamp = new Date(value || 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeFailureCount(value) {
  const count = Number(value);

  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }

  return Math.min(MAX_PASSWORD_FAILURES - 1, Math.floor(count));
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, number));
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function isDocumentNotFound(error) {
  return Boolean(
    error &&
      (error.code === "DOCUMENT_NOT_FOUND" ||
        error.errCode === -502003 ||
        /not\s*exist|not\s*found/i.test(String(error.message || "")))
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

function validateSession(session, openid) {
  if (
    !session ||
    session.openid !== openid ||
    session.status !== "active" ||
    !session.userId ||
    toTimestamp(session.expiresAt) <= Date.now()
  ) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员账号"
    };
  }

  return { success: true };
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
}

async function readAllDocuments(collectionName, filter) {
  const documents = [];

  while (documents.length < MAX_LEGACY_NOTE_SCAN) {
    const result = await db
      .collection(collectionName)
      .where(filter)
      .skip(documents.length)
      .limit(DATABASE_BATCH_SIZE)
      .get();
    const page = result && Array.isArray(result.data) ? result.data : [];

    documents.push(...page);

    if (page.length < DATABASE_BATCH_SIZE) {
      break;
    }
  }

  if (documents.length >= MAX_LEGACY_NOTE_SCAN) {
    const error = new Error("legacy notes require offline migration");
    error.code = "NOTES_MIGRATION_REQUIRED";
    throw error;
  }

  return documents;
}

function mergeCompletedRecords(memberRecords, legacyRecords) {
  const merged = new Map();

  [...legacyRecords, ...memberRecords].forEach((record) => {
    if (!record || !record._id || record.status !== "completed") {
      return;
    }

    const contentId = String(record.contentId || "").trim();
    const key = contentId ? `content:${contentId}` : `record:${record._id}`;
    merged.set(key, record);
  });

  return Array.from(merged.values()).sort((left, right) => {
    const timeDifference =
      toTimestamp(right.completedAt) - toTimestamp(left.completedAt);

    if (timeDifference !== 0) {
      return timeDifference;
    }

    return String(right._id).localeCompare(String(left._id));
  });
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const password = String(event.password || "");
    const offset = normalizeInteger(event.offset, 0, 0, MAX_PAGE_OFFSET);
    const limit = normalizeInteger(
      event.limit,
      DEFAULT_PAGE_LIMIT,
      1,
      MAX_PAGE_LIMIT
    );

    if (!openid) {
      return {
        success: false,
        code: "MISSING_OPENID",
        message: "无法识别当前微信用户"
      };
    }

    if (!/^\d{6}$/.test(password)) {
      return {
        success: false,
        code: "INVALID_PASSWORD_FORMAT",
        message: "请输入6位会员密码"
      };
    }

    const sessionId = createSessionId(openid);
    const rawAuthentication = await db.runTransaction(async (transaction) => {
      const session = await readDocument(
        transaction.collection("memberSessions").doc(sessionId)
      );
      const sessionValidation = validateSession(session, openid);

      if (!sessionValidation.success) {
        return sessionValidation;
      }

      const userDocument = transaction.collection("users").doc(session.userId);
      const transactionUser = await readDocument(userDocument);

      if (
        !transactionUser ||
        transactionUser.openid !== openid ||
        !isActiveUser(transactionUser)
      ) {
        return {
          success: false,
          code: "ACCOUNT_INACTIVE",
          accountStatus:
            (transactionUser && transactionUser.registerStatus) || "inactive",
          message: "当前少年会员账号已停用"
        };
      }

      const algorithm = getPasswordAlgorithm(transactionUser);

      if (!algorithm) {
        return {
          success: false,
          code: "UNSUPPORTED_PASSWORD_ALGORITHM",
          message: "账号密码格式需要管理员升级，请联系客服"
        };
      }

      const now = Date.now();
      const lockedUntil = toTimestamp(transactionUser.passwordLockedUntil);

      if (lockedUntil > now) {
        return {
          success: false,
          code: "PASSWORD_LOCKED",
          message: "密码错误次数过多，请稍后再试"
        };
      }

      if (!verifyPassword(password, transactionUser, algorithm)) {
        const nextFailures =
          normalizeFailureCount(transactionUser.passwordFailureCount) + 1;
        const shouldLock = nextFailures >= MAX_PASSWORD_FAILURES;

        await userDocument.update({
          data: {
            passwordFailureCount: shouldLock ? 0 : nextFailures,
            passwordLockedUntil: shouldLock
              ? new Date(now + PASSWORD_LOCK_DURATION_MS)
              : null,
            updateTime: db.serverDate()
          }
        });

        return {
          success: false,
          code: shouldLock ? "PASSWORD_LOCKED" : "WRONG_PASSWORD",
          message: shouldLock
            ? "密码错误次数过多，请5分钟后再试"
            : `会员密码错误，还可尝试${
                MAX_PASSWORD_FAILURES - nextFailures
              }次`
        };
      }

      const updateData = {
        passwordFailureCount: 0,
        passwordLockedUntil: null,
        updateTime: db.serverDate()
      };

      if (algorithm === "sha256-v1") {
        const passwordSalt = crypto.randomBytes(16).toString("hex");
        updateData.passwordSalt = passwordSalt;
        updateData.passwordHash = hashScryptPassword(password, passwordSalt);
        updateData.passwordAlgorithm = "scrypt-v1";
      }

      await userDocument.update({ data: updateData });

      return {
        success: true,
        userId: transactionUser._id,
        memberId: transactionUser.memberId,
        includeLegacyOpenidData:
          transactionUser._id === createPrimaryUserId(openid)
      };
    });
    const authentication = unwrapTransactionResult(rawAuthentication);

    if (!authentication.success) {
      return authentication;
    }

    let completedRecords = [];
    let total = 0;

    if (authentication.includeLegacyOpenidData) {
      const [memberRecords, legacyRecords] = await Promise.all([
        readAllDocuments("records", {
          userId: authentication.userId,
          status: "completed"
        }),
        readAllDocuments("records", {
          openid,
          status: "completed"
        })
      ]);
      const mergedRecords = mergeCompletedRecords(
        memberRecords,
        legacyRecords.filter((record) => !record.userId)
      );

      total = mergedRecords.length;
      completedRecords = mergedRecords.slice(offset, offset + limit);
    } else {
      const recordsFilter = {
        userId: authentication.userId,
        status: "completed"
      };
      const [notesResult, notesCountResult] = await Promise.all([
        db
          .collection("records")
          .where(recordsFilter)
          .orderBy("completedAt", "desc")
          .orderBy("_id", "desc")
          .skip(offset)
          .limit(limit)
          .get(),
        db.collection("records").where(recordsFilter).count()
      ]);

      completedRecords = notesResult.data;
      total = Number(notesCountResult.total || 0);
    }

    const notes = completedRecords.map((item) => ({
      id: item._id,
      contentId: item.contentId || "",
      bookTitle: item.bookTitle || "未命名书稿",
      content: item.comment || "",
      completedAt: item.completedAt || null
    }));

    return {
      success: true,
      memberId: authentication.memberId,
      notes,
      offset,
      limit,
      hasMore: total > offset + notes.length,
      nextOffset: total > offset + notes.length
        ? offset + notes.length
        : null,
      total
    };
  } catch (error) {
    console.error("getNotes error:", error);

    return {
      success: false,
      message: "读后感读取失败"
    };
  }
};
