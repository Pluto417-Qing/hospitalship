const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const STAR_REWARD_PER_COMPLETION = 50;
const REWARD_TYPE = "content-completion";
const REWARD_LEDGER_SCHEMA_VERSION = 3;
const PAGE_SIZE = 100;
const MAX_DOCUMENTS = 10000;

function createSessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function createLegacyPrimaryUserId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["user-openid", openid]))
    .digest("hex")
    .slice(0, 32);
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

function isCollectionMissing(error) {
  const code = Number(error && error.errCode);
  const message = String((error && error.message) || "").toLowerCase();

  return (
    code === -502005 ||
    message.includes("collection does not exist") ||
    message.includes("collection not found")
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

function clampStarUsed(value, starTotal) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return Math.min(starTotal, Math.floor(numericValue));
}

function publicProfile(user) {
  return {
    userId: user._id,
    memberId: String(user.memberId || ""),
    nickname: String(user.nickname || "少年会员"),
    birthYear: user.birthYear,
    city: String(user.city || ""),
    phoneMasked: maskPhone(user.phone),
    guardianPhoneVerificationStatus:
      user.guardianPhoneVerificationStatus || "unverified",
    accountStatus: user.registerStatus || "active"
  };
}

function sortGuardianUsers(users) {
  return users.slice().sort((left, right) => {
    const leftSlot = Number.isInteger(left.guardianSlot)
      ? left.guardianSlot
      : 0;
    const rightSlot = Number.isInteger(right.guardianSlot)
      ? right.guardianSlot
      : 0;
    return leftSlot - rightSlot || String(left._id).localeCompare(String(right._id));
  });
}

async function listGuardianUsers(openid) {
  const result = await db
    .collection("users")
    .where({ openid })
    .limit(3)
    .get();
  return sortGuardianUsers(result.data);
}

async function readAllDocuments(collectionName, filter) {
  const documents = [];

  while (documents.length < MAX_DOCUMENTS) {
    const result = await db
      .collection(collectionName)
      .where(filter)
      .orderBy("_id", "asc")
      .skip(documents.length)
      .limit(PAGE_SIZE)
      .get();
    const batch = Array.isArray(result.data) ? result.data : [];
    documents.push(...batch);

    if (batch.length < PAGE_SIZE) {
      break;
    }
  }

  return documents.slice(0, MAX_DOCUMENTS);
}

function mergeMemberDocuments(memberDocuments, legacyDocuments) {
  const merged = new Map();

  // Insert legacy documents first so an already migrated member-scoped row
  // wins when both versions represent the same content.
  [...legacyDocuments, ...memberDocuments].forEach((item) => {
    if (item && item._id) {
      const contentId = String(item.contentId || "").trim();
      const key = contentId ? `content:${contentId}` : `document:${item._id}`;
      merged.set(key, item);
    }
  });

  return Array.from(merged.values());
}

function completedAtMs(record) {
  return toTimestamp(record && record.completedAt);
}

async function readMemberRecords(user, includeLegacyOpenidData) {
  const memberRecords = await readAllDocuments("records", {
    userId: user._id
  });

  if (!includeLegacyOpenidData) {
    return memberRecords;
  }

  const legacyRecords = await readAllDocuments("records", {
    openid: user.openid
  });

  return mergeMemberDocuments(
    memberRecords,
    legacyRecords.filter((record) => !record.userId)
  );
}

async function readMemberRewards(user, includeLegacyOpenidData) {
  const memberRewards = await readAllDocuments("rewardLedger", {
    userId: user._id,
    rewardType: REWARD_TYPE,
    status: "granted"
  });

  if (!includeLegacyOpenidData) {
    return memberRewards;
  }

  const legacyRewards = await readAllDocuments("rewardLedger", {
    openid: user.openid,
    rewardType: REWARD_TYPE,
    status: "granted"
  });

  return mergeMemberDocuments(
    memberRewards,
    legacyRewards.filter((reward) => !reward.userId)
  );
}

function loginRequiredResult(users, code = "MEMBER_LOGIN_REQUIRED") {
  const profiles = users.filter(isActiveUser).map(publicProfile);

  return {
    success: true,
    registered: users.length > 0,
    loggedIn: false,
    code,
    accountStatus:
      users.length > 0
        ? code === "MEMBER_SESSION_EXPIRED"
          ? "session-expired"
          : "login-required"
        : "unregistered",
    profiles,
    canAddMember: users.length < 2
  };
}

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    if (!openid) {
      return {
        success: false,
        code: "MISSING_OPENID",
        message: "无法识别当前微信用户"
      };
    }

    const guardianUsers = await listGuardianUsers(openid);

    if (guardianUsers.length === 0) {
      return loginRequiredResult([]);
    }

    const sessionId = createSessionId(openid);
    const session = await getDocumentOrNull(
      db.collection("memberSessions").doc(sessionId)
    );

    if (!session || session.openid !== openid || session.status !== "active") {
      return loginRequiredResult(guardianUsers);
    }

    if (toTimestamp(session.expiresAt) <= Date.now()) {
      return loginRequiredResult(guardianUsers, "MEMBER_SESSION_EXPIRED");
    }

    const user = await getDocumentOrNull(
      db.collection("users").doc(String(session.userId || ""))
    );

    if (
      !user ||
      user.openid !== openid ||
      user.memberId !== session.memberId
    ) {
      return loginRequiredResult(guardianUsers);
    }

    if (!isActiveUser(user)) {
      return {
        success: false,
        registered: true,
        loggedIn: false,
        code: "ACCOUNT_INACTIVE",
        accountStatus: user.registerStatus || "inactive",
        message: "当前会员账号已停用，请联系管理员处理",
        profiles: guardianUsers.filter(isActiveUser).map(publicProfile)
      };
    }

    const includeLegacyOpenidData =
      user._id === createLegacyPrimaryUserId(openid);
    const records = await readMemberRecords(user, includeLegacyOpenidData);
    const completedRecords = records
      .filter((record) => record.status === "completed")
      .sort((left, right) => {
        return (
          completedAtMs(right) - completedAtMs(left) ||
          String(right._id).localeCompare(String(left._id))
        );
      });
    const pendingReviewRecords = records
      .filter((record) => record.status === "pending_review")
      .sort((left, right) => {
        const leftTime = toTimestamp(left.submittedAt || left.updateTime);
        const rightTime = toTimestamp(right.submittedAt || right.updateTime);
        return (
          rightTime - leftTime ||
          String(right._id).localeCompare(String(left._id))
        );
      });
    const revisionRequiredRecords = records
      .filter((record) => record.status === "revision_required")
      .sort((left, right) => {
        const leftTime = toTimestamp(left.updateTime || left.submittedAt);
        const rightTime = toTimestamp(right.updateTime || right.submittedAt);
        return (
          rightTime - leftTime ||
          String(right._id).localeCompare(String(left._id))
        );
      });
    let rewards;
    let starSource = "reward-ledger";

    try {
      rewards = await readMemberRewards(user, includeLegacyOpenidData);
    } catch (error) {
      // Pre-ledger members may temporarily derive a migration balance from
      // completed records. Schema v3 members fail closed on an unavailable
      // ledger so a database fault can never mint stars.
      if (
        !isCollectionMissing(error) ||
        Number(user.schemaVersion || 0) >= REWARD_LEDGER_SCHEMA_VERSION
      ) {
        throw error;
      }

      rewards = [];
      starSource = "legacy-record-migration";
    }

    let rewardCount = rewards.length;

    if (
      Number(user.schemaVersion || 0) < REWARD_LEDGER_SCHEMA_VERSION &&
      rewardCount < completedRecords.length
    ) {
      rewardCount = completedRecords.length;
      starSource = "legacy-record-migration";
    }

    const starTotal = rewardCount * STAR_REWARD_PER_COMPLETION;
    const starUsed = clampStarUsed(user.starUsed, starTotal);
    const starRemain = starTotal - starUsed;
    const recordByContentId = new Map(
      records
        .filter((record) => typeof record.contentId === "string")
        .map((record) => [record.contentId, record])
    );
    const badgeSource =
      starSource === "reward-ledger"
        ? rewards
            .slice()
            .sort((left, right) => {
              const leftTime = toTimestamp(left.grantedAt || left.createTime);
              const rightTime = toTimestamp(right.grantedAt || right.createTime);
              return (
                rightTime - leftTime ||
                String(right._id).localeCompare(String(left._id))
              );
            })
            .map((reward) => {
              const record = recordByContentId.get(reward.contentId) || {};
              return {
                id: reward._id,
                title:
                  record.bookTitle ||
                  record.titleSnapshot ||
                  reward.bookTitle ||
                  reward.titleSnapshot ||
                  "阅读纪念章"
              };
            })
        : completedRecords.map((record) => ({
            id: record._id,
            title:
              record.bookTitle || record.titleSnapshot || "阅读纪念章"
          }));
    const badgeTotal = badgeSource.length;
    const badges = badgeSource.slice(0, 8);
    const pendingReviews = pendingReviewRecords.slice(0, 3).map((record) => ({
      id: record._id,
      contentId: String(record.contentId || ""),
      title:
        record.bookTitle || record.titleSnapshot || "未命名阅读内容",
      status: "pending_review"
    }));
    const revisionRequired = revisionRequiredRecords.slice(0, 3).map((record) => ({
      id: record._id,
      contentId: String(record.contentId || ""),
      title:
        record.bookTitle || record.titleSnapshot || "未命名阅读内容",
      status: "revision_required"
    }));

    return {
      success: true,
      registered: true,
      loggedIn: true,
      accountStatus: "active",
      sessionExpiresAtMs: toTimestamp(session.expiresAt),
      profiles: guardianUsers.filter(isActiveUser).map(publicProfile),
      canAddMember: guardianUsers.length < 2,
      user: {
        userId: user._id,
        memberId: user.memberId,
        nickname: user.nickname,
        birthYear: user.birthYear,
        city: user.city,
        phoneMasked: maskPhone(user.phone),
        guardianPhoneVerificationStatus:
          user.guardianPhoneVerificationStatus || "unverified",
        starTotal,
        starUsed,
        starRemain,
        starSource,
        badgeTotal,
        badges,
        pendingReviewCount: pendingReviewRecords.length,
        pendingReviews,
        revisionRequiredCount: revisionRequiredRecords.length,
        revisionRequired
      }
    };
  } catch (error) {
    console.error("getUser error:", error);

    return {
      success: false,
      message: "会员信息读取失败"
    };
  }
};
