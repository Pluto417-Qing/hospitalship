const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

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

function matches(document, filter) {
  return Object.entries(filter || {}).every(
    ([key, value]) => document[key] === value
  );
}

class MemoryDatabase {
  constructor() {
    this.stores = new Map();
    this.transactionTail = Promise.resolve();
  }

  getStore(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }

    return this.stores.get(name);
  }

  getDocuments(name) {
    return Array.from(this.getStore(name), ([documentId, data]) => ({
      _id: documentId,
      ...clone(data)
    }));
  }

  createDocumentReference(name, documentId) {
    const store = this.getStore(name);

    return {
      get: async () => {
        if (!store.has(documentId)) {
          const error = new Error("document does not exist");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }

        return {
          data: {
            _id: documentId,
            ...clone(store.get(documentId))
          }
        };
      },
      set: async ({ data }) => {
        store.set(documentId, clone(data));
      },
      update: async ({ data }) => {
        if (!store.has(documentId)) {
          const error = new Error("document does not exist");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }

        store.set(documentId, {
          ...store.get(documentId),
          ...clone(data)
        });
      }
    };
  }

  createQuery(name, filter = {}, offset = 0, limit = null) {
    const read = () => {
      let documents = this.getDocuments(name).filter((document) =>
        matches(document, filter)
      );
      documents = documents.slice(offset);

      if (Number.isInteger(limit)) {
        documents = documents.slice(0, limit);
      }

      return documents;
    };

    return {
      get: async () => ({ data: read() }),
      count: async () => ({ total: read().length }),
      skip: (nextOffset) =>
        this.createQuery(name, filter, nextOffset, limit),
      limit: (nextLimit) =>
        this.createQuery(name, filter, offset, nextLimit),
      orderBy: () => this.createQuery(name, filter, offset, limit)
    };
  }

  createCollection(name, transactionOnly = false) {
    const collection = {
      doc: (documentId) => this.createDocumentReference(name, documentId)
    };

    if (!transactionOnly) {
      collection.where = (filter) => this.createQuery(name, filter);
    }

    return collection;
  }

  collection(name) {
    return this.createCollection(name, false);
  }

  serverDate() {
    return new Date();
  }

  runTransaction(callback) {
    const execution = this.transactionTail.then(() =>
      callback({
        collection: (name) => this.createCollection(name, true)
      })
    );
    this.transactionTail = execution.catch(() => undefined);
    return execution.then((result) => ({ result }));
  }
}

function loadFunction(name, database, openid) {
  const filename = path.resolve(__dirname, "cloudfunctions", name, "index.js");
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const localRequire = Module.createRequire(filename);
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init: () => {},
    database: () => database,
    getWXContext: () => ({ OPENID: openid })
  };
  const sandbox = {
    Buffer,
    Date,
    console,
    module,
    exports: module.exports,
    __dirname: path.dirname(filename),
    __filename: filename,
    process: {
      env: {
        GUARDIAN_PHONE_CLAIM_SECRET:
          "test-only-guardian-phone-claim-secret-2026"
      }
    },
    require: (request) =>
      request === "wx-server-sdk" ? cloud : localRequire(request)
  };

  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.main;
}

function registrationEvent(overrides = {}) {
  return {
    nickname: "海船号",
    birthYear: 2012,
    city: "北京 海淀区",
    password: "海船号",
    phone: "13800138000",
    consents: {
      noticeVersion: "registration-notice-2026-07-12",
      rulesVersion: "reader-rules-v1"
    },
    ...overrides
  };
}

function sessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

async function run() {
  const database = new MemoryDatabase();
  const guardianOpenid = "guardian-openid-a";
  const register = loadFunction("register", database, guardianOpenid);
  const login = loadFunction("login", database, guardianOpenid);
  const getUser = loadFunction("getUser", database, guardianOpenid);

  const first = await register(registrationEvent());
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.loggedIn, true);
  assert.strictEqual(database.getDocuments("users").length, 1);
  assert.strictEqual(database.getDocuments("memberSessions").length, 1);
  assert.strictEqual(
    database.getDocuments("memberSessions")[0]._id,
    sessionId(guardianOpenid)
  );
  assert.strictEqual(
    database.getDocuments("memberSessions")[0].userId,
    first.user.userId
  );

  const birthYearDatabase = new MemoryDatabase();
  const registerBirthYear = loadFunction(
    "register",
    birthYearDatabase,
    "guardian-openid-birth-year"
  );
  assert.strictEqual(
    (await registerBirthYear(registrationEvent({ birthYear: 1949 }))).success,
    true
  );

  const maximumBirthYearDatabase = new MemoryDatabase();
  const registerMaximumBirthYear = loadFunction(
    "register",
    maximumBirthYearDatabase,
    "guardian-openid-maximum-birth-year"
  );
  assert.strictEqual(
    (await registerMaximumBirthYear(registrationEvent({ birthYear: 2049 }))).success,
    true
  );
  assert.strictEqual(
    (await registerMaximumBirthYear(
      registrationEvent({ addMember: true, birthYear: 2050, nickname: "越界号" })
    )).message,
    "出生年份不正确"
  );

  const firstProfile = await getUser();
  assert.strictEqual(firstProfile.success, true);
  assert.strictEqual(firstProfile.loggedIn, true);
  assert.strictEqual(firstProfile.user.memberId, first.user.memberId);

  const accidentalRepeat = await register(registrationEvent());
  assert.strictEqual(accidentalRepeat.code, "ALREADY_REGISTERED");
  assert.strictEqual(accidentalRepeat.canAddMember, true);

  const differentPhone = await register(
    registrationEvent({
      addMember: true,
      nickname: "另一号",
      phone: "13900139000"
    })
  );
  assert.strictEqual(differentPhone.code, "GUARDIAN_PHONE_MISMATCH");

  const second = await register(
    registrationEvent({
      addMember: true,
      nickname: "和平号",
      birthYear: 2014,
      password: "和平船"
    })
  );
  assert.strictEqual(second.success, true);
  assert.notStrictEqual(second.user.memberId, first.user.memberId);
  assert.strictEqual(database.getDocuments("users").length, 2);
  assert.strictEqual(
    database.getDocuments("memberSessions")[0].userId,
    second.user.userId
  );
  assert.strictEqual(
    database.getDocuments("guardianPhoneClaims")[0].memberCount,
    2
  );

  const third = await register(
    registrationEvent({ addMember: true, nickname: "第三号" })
  );
  assert.strictEqual(third.code, "MEMBER_LIMIT_REACHED");

  const otherGuardian = await loadFunction(
    "register",
    database,
    "guardian-openid-b"
  )(registrationEvent({ nickname: "跨区号" }));
  assert.strictEqual(otherGuardian.code, "GUARDIAN_ALREADY_REGISTERED");

  const logout = await login({ action: "logout" });
  assert.strictEqual(logout.success, true);
  const loggedOutProfile = await getUser();
  assert.strictEqual(loggedOutProfile.registered, true);
  assert.strictEqual(loggedOutProfile.loggedIn, false);
  assert.strictEqual(loggedOutProfile.profiles.length, 2);

  const wrongPassword = await login({
    action: "login",
    memberId: first.user.memberId,
    password: "错误码"
  });
  assert.strictEqual(wrongPassword.code, "INVALID_CREDENTIALS");

  const firstLogin = await login({
    action: "login",
    memberId: first.user.memberId,
    password: "海船号"
  });
  assert.strictEqual(firstLogin.success, true);
  assert.strictEqual(firstLogin.user.memberId, first.user.memberId);
  assert.strictEqual((await getUser()).user.memberId, first.user.memberId);

  await database.collection("users").doc(first.user.userId).update({
    data: { starUsed: 30 }
  });
  await database.collection("rewardLedger").doc("reward-first-a").set({
    data: {
      userId: first.user.userId,
      memberId: first.user.memberId,
      contentId: "content-a",
      rewardType: "content-completion",
      status: "granted"
    }
  });
  await database.collection("rewardLedger").doc("reward-first-b").set({
    data: {
      userId: first.user.userId,
      memberId: first.user.memberId,
      contentId: "content-b",
      rewardType: "content-completion",
      status: "granted"
    }
  });
  await database.collection("records").doc("record-first").set({
    data: {
      userId: first.user.userId,
      memberId: first.user.memberId,
      contentId: "content-a",
      bookTitle: "第一位孩子的纪念章",
      status: "completed",
      completedAt: new Date()
    }
  });
  await database.collection("rewardLedger").doc("legacy-reward-same-content").set({
    data: {
      openid: guardianOpenid,
      contentId: "content-a",
      rewardType: "content-completion",
      status: "granted",
      grantedAt: new Date(Date.now() - 1000)
    }
  });
  await database.collection("records").doc("legacy-record-same-content").set({
    data: {
      openid: guardianOpenid,
      contentId: "content-a",
      bookTitle: "不应覆盖新记录的旧标题",
      status: "completed",
      completedAt: new Date(Date.now() - 1000)
    }
  });
  const firstRewards = await getUser();
  assert.strictEqual(firstRewards.user.starTotal, 100);
  assert.strictEqual(firstRewards.user.starUsed, 30);
  assert.strictEqual(firstRewards.user.starRemain, 70);
  assert.strictEqual(firstRewards.user.badges.length, 2);
  assert.strictEqual(firstRewards.user.badgeTotal, 2);

  await database.collection("records").doc("record-first").update({
    data: {
      status: "pending_review",
      completedAt: null,
      comment: "覆盖后的待人工复审读后感"
    }
  });
  const pendingReviewRewards = await getUser();
  assert.strictEqual(pendingReviewRewards.user.starTotal, 100);
  assert.strictEqual(pendingReviewRewards.user.starUsed, 30);
  assert.strictEqual(pendingReviewRewards.user.starRemain, 70);
  assert.strictEqual(pendingReviewRewards.user.badgeTotal, 2);
  assert.strictEqual(pendingReviewRewards.user.pendingReviewCount, 1);
  assert.strictEqual(pendingReviewRewards.user.pendingReviews.length, 1);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      pendingReviewRewards.user.pendingReviews[0],
      "comment"
    ),
    false
  );
  assert.strictEqual(
    pendingReviewRewards.user.badges.some(
      (badge) => badge.title === "第一位孩子的纪念章"
    ),
    true
  );

  const secondLogin = await login({
    action: "login",
    memberId: second.user.memberId,
    password: "和平船"
  });
  assert.strictEqual(secondLogin.success, true);
  const secondRewards = await getUser();
  assert.strictEqual(secondRewards.user.starTotal, 0);
  assert.strictEqual(secondRewards.user.starUsed, 0);
  assert.strictEqual(secondRewards.user.badges.length, 0);

  assert.strictEqual(
    (
      await login({
        action: "login",
        memberId: first.user.memberId,
        password: "海船号"
      })
    ).success,
    true
  );

  const resetMismatch = await login({
    action: "resetPassword",
    memberId: first.user.memberId,
    phone: "13900139000",
    newPassword: "新海船"
  });
  assert.strictEqual(resetMismatch.code, "RECOVERY_INFORMATION_MISMATCH");

  const reset = await login({
    action: "resetPassword",
    memberId: first.user.memberId,
    phone: "13800138000",
    newPassword: "新海船"
  });
  assert.strictEqual(reset.success, true);
  assert.strictEqual((await getUser()).loggedIn, false);

  const oldPassword = await login({
    action: "login",
    memberId: first.user.memberId,
    password: "海船号"
  });
  assert.strictEqual(oldPassword.code, "INVALID_CREDENTIALS");
  const newPassword = await login({
    action: "login",
    memberId: first.user.memberId,
    password: "新海船"
  });
  assert.strictEqual(newPassword.success, true);

  const sessionDocument = database
    .collection("memberSessions")
    .doc(sessionId(guardianOpenid));
  await sessionDocument.update({
    data: { expiresAt: new Date(Date.now() - 1000) }
  });
  const expired = await login({ action: "status" });
  assert.strictEqual(expired.loggedIn, false);
  assert.strictEqual(expired.code, "MEMBER_SESSION_EXPIRED");

  const concurrentDatabase = new MemoryDatabase();
  const concurrentRegister = loadFunction(
    "register",
    concurrentDatabase,
    "guardian-openid-concurrent"
  );
  assert.strictEqual(
    (await concurrentRegister(registrationEvent({ nickname: "第一号" }))).success,
    true
  );
  const concurrentAdds = await Promise.all([
    concurrentRegister(
      registrationEvent({
        addMember: true,
        nickname: "第二号",
        password: "第二船"
      })
    ),
    concurrentRegister(
      registrationEvent({
        addMember: true,
        nickname: "第三号",
        password: "第三船"
      })
    )
  ]);
  assert.strictEqual(
    concurrentAdds.filter((result) => result.success).length,
    1
  );
  assert.strictEqual(
    concurrentAdds.filter(
      (result) => result.code === "MEMBER_LIMIT_REACHED"
    ).length,
    1
  );
  assert.strictEqual(concurrentDatabase.getDocuments("users").length, 2);

  const recoveryDatabase = new MemoryDatabase();
  const recoveryOpenid = "guardian-openid-recovery-lock";
  const recoveryRegister = loadFunction(
    "register",
    recoveryDatabase,
    recoveryOpenid
  );
  const recoveryLogin = loadFunction(
    "login",
    recoveryDatabase,
    recoveryOpenid
  );
  const recoveryMember = await recoveryRegister(
    registrationEvent({ nickname: "锁定号" })
  );
  let recoveryFailure;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    recoveryFailure = await recoveryLogin({
      action: "resetPassword",
      memberId: recoveryMember.user.memberId,
      phone: "13900139000",
      newPassword: "重置船"
    });
  }

  assert.strictEqual(recoveryFailure.code, "RECOVERY_LOCKED");
  assert.strictEqual(
    (
      await recoveryLogin({
        action: "resetPassword",
        memberId: recoveryMember.user.memberId,
        phone: "13800138000",
        newPassword: "重置船"
      })
    ).code,
    "RECOVERY_LOCKED"
  );

  const loginTemplate = fs.readFileSync(
    path.join(
      __dirname,
      "miniprogram/pages/memberLogin/memberLogin.wxml"
    ),
    "utf8"
  );
  const profileTemplate = fs.readFileSync(
    path.join(
      __dirname,
      "miniprogram/pages/memberProfile/memberProfile.wxml"
    ),
    "utf8"
  );
  const memberSource = fs.readFileSync(
    path.join(__dirname, "miniprogram/pages/member/member.js"),
    "utf8"
  );
  const settingsTemplate = fs.readFileSync(
    path.join(
      __dirname,
      "miniprogram/pages/memberSettings/memberSettings.wxml"
    ),
    "utf8"
  );
  assert.strictEqual(loginTemplate.includes("会员编号"), false);
  assert.strictEqual(loginTemplate.includes("{{item.birthYear}}"), true);
  assert.strictEqual(profileTemplate.includes("{{user.memberId}}"), true);
  assert.strictEqual(memberSource.includes('intent.type === "text"'), true);
  assert.strictEqual(
    memberSource.includes('intent.type === "catalog-comment"'),
    true
  );
  assert.strictEqual(settingsTemplate.includes("切换会员"), true);

  console.log("会员多账号、密码登录、切换和重置测试通过");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
