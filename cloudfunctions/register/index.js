const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const REGISTRATION_NOTICE_VERSION = "registration-notice-2026-07-12";
const READER_RULES_VERSION = "reader-rules-v1";
const MAX_MEMBERS_PER_GUARDIAN = 2;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MEMBER_PASSWORD_PATTERN = /^[\u4e00-\u9fa5]{3,5}$/;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64, SCRYPT_OPTIONS)
    .toString("hex");
}

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

function createUserDocumentId(openid, guardianSlot) {
  return guardianSlot === 0
    ? createDeterministicId("user-openid", openid)
    : createDeterministicId("user-openid-slot", [openid, guardianSlot]);
}

function createMemberSuffix(openid, guardianSlot) {
  const value =
    guardianSlot === 0
      ? createDeterministicId("member-id", openid)
      : createDeterministicId("member-id", [openid, guardianSlot]);

  return value.slice(0, 12).toUpperCase();
}

function getGuardianPhoneClaimSecret() {
  return String(process.env.GUARDIAN_PHONE_CLAIM_SECRET || "").trim();
}

function createGuardianPhoneFingerprint(phone, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(phone)
    .digest("hex");
}

function maskPhone(phone) {
  if (!phone || phone.length !== 11) {
    return "";
  }

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

function publicProfile(user) {
  return {
    userId: user._id,
    memberId: user.memberId,
    nickname: user.nickname,
    birthYear: user.birthYear,
    city: user.city,
    phoneMasked: maskPhone(user.phone),
    guardianPhoneVerificationStatus:
      user.guardianPhoneVerificationStatus || "unverified",
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

function existingAccountResult(users) {
  const activeUsers = users.filter(isActiveUser);

  if (activeUsers.length > 0) {
    return {
      success: false,
      registered: true,
      code: "ALREADY_REGISTERED",
      message: "当前微信已有少年会员，请登录或选择新增会员",
      profiles: activeUsers.map(publicProfile),
      canAddMember: users.length < MAX_MEMBERS_PER_GUARDIAN
    };
  }

  const user = users[0] || {};
  return {
    success: false,
    code: "ACCOUNT_INACTIVE",
    accountStatus: user.registerStatus || "inactive",
    message: "当前会员账号已停用，请联系管理员处理"
  };
}

function memberLimitResult() {
  return {
    success: false,
    code: "MEMBER_LIMIT_REACHED",
    message: "一个监护人微信最多可管理两位少年会员"
  };
}

function determineGuardianSlot(users) {
  const usedSlots = new Set();

  users.forEach((user) => {
    if (Number.isInteger(user.guardianSlot)) {
      usedSlots.add(user.guardianSlot);
    } else {
      // Every pre-multi-member account is the guardian's first member.
      usedSlots.add(0);
    }
  });

  for (let slot = 0; slot < MAX_MEMBERS_PER_GUARDIAN; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return -1;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
      const nickname = String(event.nickname || "")
        .trim()
        .replace(/\s+/g, "");
    const birthYear = Number(event.birthYear);
    const city = String(event.city || "").trim();
    const password = String(event.password || "");
    const phone = String(event.phone || "").trim();
    const addMember = event.addMember === true;
    const consents =
      event.consents && typeof event.consents === "object"
        ? event.consents
        : {};
    const currentYear = new Date().getUTCFullYear();

    if (!openid) {
      return {
        success: false,
        code: "MISSING_OPENID",
        message: "无法识别当前微信用户"
      };
    }

    if (!/^[\u4e00-\u9fa5]{3,5}$/.test(nickname)) {
      return {
        success: false,
        message: "会员代号应为3至5位汉字"
      };
    }

    if (
      !Number.isInteger(birthYear) ||
      birthYear < 2000 ||
      birthYear > currentYear
    ) {
      return {
        success: false,
        message: "出生年份不正确"
      };
    }

    if (!city || city.length > 30) {
      return {
        success: false,
        message: "请填写正确的注册县域"
      };
    }

    if (!MEMBER_PASSWORD_PATTERN.test(password)) {
      return {
        success: false,
        message: "会员密码应为3至5位汉字"
      };
    }

    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return {
        success: false,
        message: "监护人手机号格式不正确"
      };
    }

    if (
      consents.noticeVersion !== REGISTRATION_NOTICE_VERSION ||
      consents.rulesVersion !== READER_RULES_VERSION
    ) {
      return {
        success: false,
        code: "CONSENT_REQUIRED",
        message: "请从注册第一步开始阅读并同意提示与规则"
      };
    }

    const guardianPhoneClaimSecret = getGuardianPhoneClaimSecret();

    if (guardianPhoneClaimSecret.length < 32) {
      console.error("GUARDIAN_PHONE_CLAIM_SECRET is missing or too short");
      return {
        success: false,
        code: "CONFIGURATION_ERROR",
        message: "注册服务暂不可用，请联系管理员"
      };
    }

    const guardianResult = await db
      .collection("users")
      .where({ openid })
      .limit(3)
      .get();
    const guardianUsers = guardianResult.data;

    if (guardianUsers.length > 0 && !addMember) {
      return existingAccountResult(guardianUsers);
    }

    if (guardianUsers.length >= MAX_MEMBERS_PER_GUARDIAN) {
      return memberLimitResult();
    }

    if (guardianUsers.some((user) => !isActiveUser(user))) {
      return existingAccountResult(guardianUsers.filter((user) => !isActiveUser(user)));
    }

    if (
      guardianUsers.length > 0 &&
      guardianUsers.some((user) => String(user.phone || "") !== phone)
    ) {
      return {
        success: false,
        code: "GUARDIAN_PHONE_MISMATCH",
        message: "新增会员须使用当前监护人已登记的手机号"
      };
    }

    // Protect pre-claim accounts and prevent a different guardian WeChat from
    // reserving a phone that already belongs to another guardian.
    const legacyGuardianResult = await db
      .collection("users")
      .where({ phone })
      .limit(3)
      .get();

    if (legacyGuardianResult.data.some((user) => user.openid !== openid)) {
      return {
        success: false,
        code: "GUARDIAN_ALREADY_REGISTERED",
        message: "该监护人手机号已绑定其他微信账号"
      };
    }

    const guardianSlot = determineGuardianSlot(guardianUsers);

    if (guardianSlot < 0) {
      return memberLimitResult();
    }

    const userDocumentId = createUserDocumentId(openid, guardianSlot);
    const phoneFingerprint = createGuardianPhoneFingerprint(
      phone,
      guardianPhoneClaimSecret
    );
    const phoneClaimId = phoneFingerprint.slice(0, 32);
    const memberId = `${nickname}${birthYear}${createMemberSuffix(
      openid,
      guardianSlot
    )}`;
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, passwordSalt);
    const sessionId = createSessionId(openid);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const rawTransactionResult = await db.runTransaction(async (transaction) => {
      const userDocument = transaction
        .collection("users")
        .doc(userDocumentId);
      const phoneClaimDocument = transaction
        .collection("guardianPhoneClaims")
        .doc(phoneClaimId);
      const sessionDocument = transaction
        .collection("memberSessions")
        .doc(sessionId);
      const existingGuardianDocuments = guardianUsers.map((user) =>
        transaction.collection("users").doc(user._id)
      );
      const [existingUser, existingPhoneClaim, ...transactionGuardianUsers] =
        await Promise.all([
          getDocumentOrNull(userDocument),
          getDocumentOrNull(phoneClaimDocument),
          ...existingGuardianDocuments.map(getDocumentOrNull)
        ]);

      if (existingUser) {
        return guardianSlot === 0
          ? existingAccountResult([existingUser])
          : memberLimitResult();
      }

      if (
        transactionGuardianUsers.some(
          (user, index) =>
            !user ||
            user.openid !== openid ||
            user._id !== guardianUsers[index]._id ||
            !isActiveUser(user) ||
            user.phone !== phone
        )
      ) {
        return {
          success: false,
          code: "GUARDIAN_ACCOUNT_CHANGED",
          message: "监护人账号状态已变化，请重新进入注册页"
        };
      }

      const claimedGuardianOpenid =
        existingPhoneClaim &&
        String(
          existingPhoneClaim.guardianOpenid || existingPhoneClaim.openid || ""
        );

      if (
        existingPhoneClaim &&
        (claimedGuardianOpenid !== openid ||
          (existingPhoneClaim.phoneFingerprint &&
            existingPhoneClaim.phoneFingerprint !== phoneFingerprint))
      ) {
        return {
          success: false,
          code: "GUARDIAN_ALREADY_REGISTERED",
          message: "该监护人手机号已绑定其他微信账号"
        };
      }

      await userDocument.set({
        data: {
          openid,
          memberId,
          nickname,
          birthYear,
          city,
          phone,
          guardianSlot,
          guardianPhoneVerificationStatus: "unverified",
          passwordSalt,
          passwordHash,
          passwordAlgorithm: "scrypt-v1",
          passwordFailureCount: 0,
          passwordLockedUntil: null,
          recoveryFailureCount: 0,
          recoveryLockedUntil: null,
          starUsed: 0,
          registerStatus: "active",
          agreements: {
            registrationNoticeVersion: REGISTRATION_NOTICE_VERSION,
            readerRulesVersion: READER_RULES_VERSION,
            agreedAt: db.serverDate()
          },
          schemaVersion: 3,
          accountSchemaVersion: 1,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });

      const memberUserIds = Array.from(
        new Set([
          ...transactionGuardianUsers.map((user) => user._id),
          userDocumentId
        ])
      ).slice(0, MAX_MEMBERS_PER_GUARDIAN);

      if (existingPhoneClaim) {
        await phoneClaimDocument.update({
          data: {
            openid,
            guardianOpenid: openid,
            memberUserIds,
            memberCount: memberUserIds.length,
            updateTime: db.serverDate(),
            schemaVersion: 2
          }
        });
      } else {
        await phoneClaimDocument.set({
          data: {
            userId: memberUserIds[0],
            openid,
            guardianOpenid: openid,
            memberUserIds,
            memberCount: 1,
            phoneFingerprint,
            phoneLast4: phone.slice(-4),
            claimStatus: "reserved",
            verificationStatus: "unverified",
            schemaVersion: 2,
            createTime: db.serverDate(),
            updateTime: db.serverDate()
          }
        });
      }

      await sessionDocument.set({
        data: {
          openid,
          userId: userDocumentId,
          memberId,
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
      sessionExpiresAtMs: expiresAt.getTime(),
      canAddMember: guardianUsers.length + 1 < MAX_MEMBERS_PER_GUARDIAN,
      user: {
        userId: userDocumentId,
        memberId,
        nickname,
        birthYear,
        city,
        phoneMasked: maskPhone(phone),
        guardianPhoneVerificationStatus: "unverified",
        starTotal: 0,
        starUsed: 0,
        starRemain: 0
      }
    };
  } catch (error) {
    console.error("register error:", error);

    return {
      success: false,
      message: "注册失败，请稍后重试"
    };
  }
};
