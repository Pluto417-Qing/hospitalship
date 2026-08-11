const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_FAILURES = 5;
const PASSWORD_LOCK_MS = 5 * 60 * 1000;
const MAX_RECOVERY_FAILURES = 5;
const RECOVERY_LOCK_MS = 15 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});

function createDeterministicId(namespace, value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([namespace, value]))
    .digest("hex")
    .slice(0, 32);
}

function createSessionId(openid) {
  return createDeterministicId("member-session", openid);
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
  return String(user && user.passwordAlgorithm) === "scrypt-v1"
    ? "scrypt-v1"
    : "legacy-sha256";
}

function verifyPassword(password, user) {
  if (!user || !user.passwordSalt || !user.passwordHash) {
    return false;
  }

  const inputHash =
    getPasswordAlgorithm(user) === "scrypt-v1"
      ? hashScryptPassword(password, user.passwordSalt)
      : hashLegacyPassword(password, user.passwordSalt);

  return safeEqualHex(inputHash, user.passwordHash);
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function maskPhone(phone) {
  const value = String(phone || "");
  return /^1[3-9]\d{9}$/.test(value)
    ? `${value.slice(0, 3)}****${value.slice(-4)}`
    : "";
}

function toTimestamp(value) {
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

function publicProfile(user) {
  return {
    userId: user._id,
    memberId: String(user.memberId || ""),
    nickname: String(user.nickname || "少年会员"),
    birthYear: user.birthYear,
    city: String(user.city || ""),
    phoneMasked: maskPhone(user.phone),
    accountStatus: user.registerStatus || "active"
  };
}

function unwrapTransactionResult(value) {
  return value && Object.prototype.hasOwnProperty.call(value, "result")
    ? value.result
    : value;
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

async function listGuardianUsers(openid) {
  const result = await db
    .collection("users")
    .where({ openid })
    .limit(3)
    .get();

  return result.data
    .slice()
    .sort((left, right) => {
      const leftSlot = Number.isInteger(left.guardianSlot)
        ? left.guardianSlot
        : 0;
      const rightSlot = Number.isInteger(right.guardianSlot)
        ? right.guardianSlot
        : 0;
      return leftSlot - rightSlot || String(left._id).localeCompare(String(right._id));
    });
}

async function listAction(openid) {
  const users = await listGuardianUsers(openid);
  const profiles = users.filter(isActiveUser).map(publicProfile);

  return {
    success: true,
    registered: users.length > 0,
    profiles,
    canAddMember: users.length < 2
  };
}

async function statusAction(openid) {
  const listResult = await listAction(openid);

  if (!listResult.registered) {
    return {
      ...listResult,
      loggedIn: false,
      accountStatus: "unregistered"
    };
  }

  const sessionId = createSessionId(openid);
  const session = await getDocumentOrNull(
    db.collection("memberSessions").doc(sessionId)
  );

  if (!session || session.openid !== openid || session.status !== "active") {
    return {
      ...listResult,
      loggedIn: false,
      code: "MEMBER_LOGIN_REQUIRED",
      accountStatus: "login-required"
    };
  }

  if (toTimestamp(session.expiresAt) <= Date.now()) {
    return {
      ...listResult,
      loggedIn: false,
      code: "MEMBER_SESSION_EXPIRED",
      accountStatus: "session-expired"
    };
  }

  const user = await getDocumentOrNull(
    db.collection("users").doc(String(session.userId || ""))
  );

  if (
    !isActiveUser(user) ||
    user.openid !== openid ||
    user.memberId !== session.memberId
  ) {
    return {
      ...listResult,
      loggedIn: false,
      code: "MEMBER_LOGIN_REQUIRED",
      accountStatus: "login-required"
    };
  }

  return {
    ...listResult,
    loggedIn: true,
    accountStatus: "active",
    sessionExpiresAtMs: toTimestamp(session.expiresAt),
    user: publicProfile(user)
  };
}

async function loginAction(openid, event) {
  const memberId = String(event.memberId || "").trim().toUpperCase();
  const password = String(event.password || "");

  if (!/^\d{6}$/.test(password)) {
    return {
      success: false,
      code: "INVALID_CREDENTIALS",
      message: "会员编号或密码不正确"
    };
  }

  const guardianUsers = await listGuardianUsers(openid);
  const candidates = guardianUsers.filter(
    (user) => !memberId || String(user.memberId || "").toUpperCase() === memberId
  );

  if (candidates.length !== 1) {
    return {
      success: false,
      code: "INVALID_CREDENTIALS",
      message: "会员编号或密码不正确"
    };
  }

  const candidate = candidates[0];

  if (!isActiveUser(candidate)) {
    return {
      success: false,
      code: "ACCOUNT_INACTIVE",
      accountStatus: candidate.registerStatus || "inactive",
      message: "当前会员账号已停用，请联系管理员处理"
    };
  }

  const lockedUntil = toTimestamp(candidate.passwordLockedUntil);

  if (lockedUntil > Date.now()) {
    return {
      success: false,
      code: "PASSWORD_LOCKED",
      retryAfterMs: lockedUntil - Date.now(),
      message: "密码尝试次数过多，请稍后再试"
    };
  }

  const sessionId = createSessionId(openid);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  const rawTransactionResult = await db.runTransaction(async (transaction) => {
    const transactionUserDocument = transaction
      .collection("users")
      .doc(candidate._id);
    const transactionSessionDocument = transaction
      .collection("memberSessions")
      .doc(sessionId);
    const transactionUser = await getDocumentOrNull(transactionUserDocument);

    if (
      !transactionUser ||
      transactionUser.openid !== openid ||
      transactionUser.memberId !== candidate.memberId
    ) {
      return {
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "会员编号或密码不正确"
      };
    }

    if (!isActiveUser(transactionUser)) {
      return {
        success: false,
        code: "ACCOUNT_INACTIVE",
        message: "当前会员账号已停用，请联系管理员处理"
      };
    }

    const transactionLockedUntil = toTimestamp(
      transactionUser.passwordLockedUntil
    );

    if (transactionLockedUntil > Date.now()) {
      return {
        success: false,
        code: "PASSWORD_LOCKED",
        retryAfterMs: transactionLockedUntil - Date.now(),
        message: "密码尝试次数过多，请稍后再试"
      };
    }

    if (!verifyPassword(password, transactionUser)) {
      const failureCount = Math.max(
        0,
        Number(transactionUser.passwordFailureCount) || 0
      ) + 1;
      const shouldLock = failureCount >= MAX_PASSWORD_FAILURES;

      await transactionUserDocument.update({
        data: {
          passwordFailureCount: shouldLock ? 0 : failureCount,
          passwordLockedUntil: shouldLock
            ? new Date(Date.now() + PASSWORD_LOCK_MS)
            : null,
          updateTime: db.serverDate()
        }
      });

      return {
        success: false,
        code: shouldLock ? "PASSWORD_LOCKED" : "INVALID_CREDENTIALS",
        message: shouldLock
          ? "密码尝试次数过多，请5分钟后再试"
          : "会员编号或密码不正确"
      };
    }

    const userUpdate = {
      passwordFailureCount: 0,
      passwordLockedUntil: null,
      lastLoginAt: db.serverDate(),
      updateTime: db.serverDate()
    };

    if (getPasswordAlgorithm(transactionUser) !== "scrypt-v1") {
      const passwordSalt = crypto.randomBytes(16).toString("hex");
      userUpdate.passwordSalt = passwordSalt;
      userUpdate.passwordHash = hashScryptPassword(password, passwordSalt);
      userUpdate.passwordAlgorithm = "scrypt-v1";
    }

    await transactionUserDocument.update({ data: userUpdate });
    await transactionSessionDocument.set({
      data: {
        openid,
        userId: candidate._id,
        memberId: candidate.memberId,
        status: "active",
        expiresAt,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        schemaVersion: 1
      }
    });

    return { success: true };
  });
  const transactionResult = unwrapTransactionResult(rawTransactionResult);

  if (!transactionResult.success) {
    return transactionResult;
  }

  return {
    success: true,
    registered: true,
    loggedIn: true,
    accountStatus: "active",
    sessionExpiresAtMs: expiresAt.getTime(),
    user: publicProfile(candidate)
  };
}

async function logoutAction(openid) {
  const sessionId = createSessionId(openid);
  const sessionDocument = db.collection("memberSessions").doc(sessionId);
  const existingSession = await getDocumentOrNull(sessionDocument);

  if (!existingSession) {
    return { success: true, loggedIn: false };
  }

  if (existingSession.openid !== openid) {
    throw new Error("member session identity mismatch");
  }

  await sessionDocument.update({
    data: {
      status: "revoked",
      revokedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });

  return { success: true, loggedIn: false };
}

async function resetPasswordAction(openid, event) {
  const memberId = String(event.memberId || "").trim().toUpperCase();
  const phone = String(event.phone || "").trim();
  const newPassword = String(event.newPassword || "");

  if (
    !memberId ||
    !/^1[3-9]\d{9}$/.test(phone) ||
    !/^\d{6}$/.test(newPassword)
  ) {
    return {
      success: false,
      code: "RECOVERY_INFORMATION_MISMATCH",
      message: "会员编号、手机号或新密码格式不正确"
    };
  }

  const userResult = await db
    .collection("users")
    .where({ openid, memberId })
    .limit(1)
    .get();
  const candidate = userResult.data[0];

  if (!candidate || !isActiveUser(candidate)) {
    return {
      success: false,
      code: "RECOVERY_INFORMATION_MISMATCH",
      message: "会员编号或登记手机号不匹配"
    };
  }

  const recoveryLockedUntil = toTimestamp(candidate.recoveryLockedUntil);

  if (recoveryLockedUntil > Date.now()) {
    return {
      success: false,
      code: "RECOVERY_LOCKED",
      retryAfterMs: recoveryLockedUntil - Date.now(),
      message: "密码重置信息尝试次数过多，请稍后再试"
    };
  }

  const sessionId = createSessionId(openid);
  const rawTransactionResult = await db.runTransaction(async (transaction) => {
    const userDocument = transaction.collection("users").doc(candidate._id);
    const sessionDocument = transaction
      .collection("memberSessions")
      .doc(sessionId);
    const transactionUser = await getDocumentOrNull(userDocument);

    if (
      !transactionUser ||
      transactionUser.openid !== openid ||
      transactionUser.memberId !== memberId ||
      !isActiveUser(transactionUser)
    ) {
      return {
        success: false,
        code: "RECOVERY_INFORMATION_MISMATCH",
        message: "会员编号或登记手机号不匹配"
      };
    }

    const transactionRecoveryLockedUntil = toTimestamp(
      transactionUser.recoveryLockedUntil
    );

    if (transactionRecoveryLockedUntil > Date.now()) {
      return {
        success: false,
        code: "RECOVERY_LOCKED",
        retryAfterMs: transactionRecoveryLockedUntil - Date.now(),
        message: "密码重置信息尝试次数过多，请稍后再试"
      };
    }

    if (transactionUser.phone !== phone) {
      const failureCount = Math.max(
        0,
        Number(transactionUser.recoveryFailureCount) || 0
      ) + 1;
      const shouldLock = failureCount >= MAX_RECOVERY_FAILURES;

      await userDocument.update({
        data: {
          recoveryFailureCount: shouldLock ? 0 : failureCount,
          recoveryLockedUntil: shouldLock
            ? new Date(Date.now() + RECOVERY_LOCK_MS)
            : null,
          updateTime: db.serverDate()
        }
      });

      return {
        success: false,
        code: shouldLock
          ? "RECOVERY_LOCKED"
          : "RECOVERY_INFORMATION_MISMATCH",
        message: shouldLock
          ? "密码重置信息尝试次数过多，请15分钟后再试"
          : "会员编号或登记手机号不匹配"
      };
    }

    const passwordSalt = crypto.randomBytes(16).toString("hex");
    await userDocument.update({
      data: {
        passwordSalt,
        passwordHash: hashScryptPassword(newPassword, passwordSalt),
        passwordAlgorithm: "scrypt-v1",
        passwordFailureCount: 0,
        passwordLockedUntil: null,
        recoveryFailureCount: 0,
        recoveryLockedUntil: null,
        passwordResetAt: db.serverDate(),
        updateTime: db.serverDate()
      }
    });

    const existingSession = await getDocumentOrNull(sessionDocument);

    if (existingSession) {
      if (existingSession.openid !== openid) {
        throw new Error("member session identity mismatch");
      }

      await sessionDocument.update({
        data: {
          status: "revoked",
          revokedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }

    return { success: true };
  });
  const transactionResult = unwrapTransactionResult(rawTransactionResult);

  if (!transactionResult.success) {
    return transactionResult;
  }

  return {
    success: true,
    loggedIn: false,
    message: "密码已重置，请使用新密码登录"
  };
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;

    if (!openid) {
      return {
        success: false,
        code: "MISSING_OPENID",
        message: "无法识别当前微信用户"
      };
    }

    const action = String(event.action || "status");

    switch (action) {
      case "list":
        return await listAction(openid);
      case "status":
        return await statusAction(openid);
      case "login":
        return await loginAction(openid, event);
      case "logout":
        return await logoutAction(openid);
      case "resetPassword":
        return await resetPasswordAction(openid, event);
      default:
        return {
          success: false,
          code: "INVALID_ACTION",
          message: "不支持的会员操作"
        };
    }
  } catch (error) {
    console.error("login error:", error);

    return {
      success: false,
      message: "会员认证服务暂不可用"
    };
  }
};
