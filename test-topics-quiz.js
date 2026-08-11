const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;

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

function createDatabase(seed = {}, options = {}) {
  const stores = new Map();
  const missingCollections = new Set(options.missingCollections || []);
  let transactionTail = Promise.resolve();

  Object.entries(seed).forEach(([name, documents]) => {
    const store = new Map();
    documents.forEach((document) => {
      store.set(document._id, clone(document));
    });
    stores.set(name, store);
  });

  function getStore(name) {
    if (!stores.has(name)) {
      stores.set(name, new Map());
    }
    return stores.get(name);
  }

  function missingError(collectionName) {
    const error = new Error(`collection ${collectionName} does not exist`);
    error.errCode = -502005;
    return error;
  }

  function documentReference(collectionName, documentId) {
    return {
      async get() {
        if (missingCollections.has(collectionName)) {
          throw missingError(collectionName);
        }

        const document = getStore(collectionName).get(documentId);
        if (!document) {
          const error = new Error("document not found");
          error.errCode = -502004;
          throw error;
        }
        return { data: clone(document) };
      },
      async set({ data }) {
        missingCollections.delete(collectionName);
        getStore(collectionName).set(documentId, {
          _id: documentId,
          ...clone(data)
        });
      },
      async update({ data }) {
        const current = getStore(collectionName).get(documentId);
        if (!current) {
          const error = new Error("document not found");
          error.errCode = -502004;
          throw error;
        }
        getStore(collectionName).set(documentId, {
          ...current,
          ...clone(data),
          _id: documentId
        });
      }
    };
  }

  function queryReference(collectionName, filter = {}) {
    const state = {
      filter,
      orderBy: [],
      skip: 0,
      limit: Infinity
    };
    const query = {
      where(nextFilter) {
        state.filter = nextFilter || {};
        return query;
      },
      orderBy(field, direction) {
        state.orderBy.push({ field, direction });
        return query;
      },
      skip(value) {
        state.skip = Number(value) || 0;
        return query;
      },
      limit(value) {
        state.limit = Number(value);
        return query;
      },
      async get() {
        if (missingCollections.has(collectionName)) {
          throw missingError(collectionName);
        }

        const rows = [...getStore(collectionName).values()]
          .filter((document) =>
            Object.entries(state.filter).every(
              ([key, expected]) => document[key] === expected
            )
          )
          .sort((left, right) => {
            for (const ordering of state.orderBy) {
              const leftValue = left[ordering.field];
              const rightValue = right[ordering.field];
              if (leftValue === rightValue) {
                continue;
              }
              const comparison = leftValue < rightValue ? -1 : 1;
              return ordering.direction === "desc" ? -comparison : comparison;
            }
            return 0;
          })
          .slice(state.skip, state.skip + state.limit)
          .map(clone);
        return { data: rows };
      }
    };
    return query;
  }

  function collection(name) {
    const query = queryReference(name);
    return {
      doc(documentId) {
        return documentReference(name, documentId);
      },
      where(filter) {
        return query.where(filter);
      },
      orderBy(field, direction) {
        return query.orderBy(field, direction);
      },
      skip(value) {
        return query.skip(value);
      },
      limit(value) {
        return query.limit(value);
      },
      get() {
        return query.get();
      }
    };
  }

  const database = {
    collection,
    serverDate() {
      return new Date();
    },
    async runTransaction(callback) {
      const run = transactionTail.then(() => callback({ collection }));
      transactionTail = run.catch(() => undefined);
      const result = await run;
      return { result, errMsg: "runTransaction:ok" };
    },
    documents(name) {
      return [...getStore(name).values()].map(clone);
    },
    document(name, id) {
      return clone(getStore(name).get(id));
    }
  };

  return database;
}

function loadCloudFunction(relativePath, { database, openid, tempURL = true }) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test-env",
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };

  if (typeof tempURL === "function") {
    cloud.getTempFileURL = tempURL;
  } else if (tempURL) {
    cloud.getTempFileURL = async ({ fileList }) => ({
      fileList: fileList.map((fileID, index) => ({
        fileID,
        status: 0,
        tempFileURL: `https://signed.example/audio-${index + 1}.mp3?token=test`
      }))
    });
  }

  const module = { exports: {} };
  const sandbox = {
    URL,
    Buffer,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    module,
    exports: module.exports,
    require(request) {
      return request === "wx-server-sdk" ? cloud : require(request);
    }
  };
  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.main;
}

function sessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function createMemberSeed(openid = "openid-one") {
  const userId = "user-one";
  return {
    openid,
    userId,
    users: [
      {
        _id: userId,
        openid,
        memberId: "KID001",
        registerStatus: "active",
        schemaVersion: 3,
        starUsed: 0
      }
    ],
    memberSessions: [
      {
        _id: sessionId(openid),
        openid,
        userId,
        memberId: "KID001",
        status: "active",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    ]
  };
}

async function testAudioMembershipAndSignedURLs() {
  const member = createMemberSeed();
  const baseSeed = {
    users: member.users,
    contents: [
      {
        _id: "audio-story",
        contentId: "audio-story",
        status: "published",
        currentRevision: "r1",
        audioStatus: "published",
        publishedAudioTrackCount: 1,
        title: "Audio story"
      }
    ],
    audioTracks: [
      {
        _id: "track-one",
        contentId: "audio-story",
        contentRevision: "r1",
        status: "published",
        trackNo: 1,
        mimeType: "audio/mpeg",
        fileID: "cloud://env/published/audio/audio-story/r1/one.mp3"
      }
    ]
  };
  const guestDatabase = createDatabase(baseSeed);
  const guestMain = loadCloudFunction("cloudfunctions/getAudioManifest/index.js", {
    database: guestDatabase,
    openid: member.openid
  });
  const denied = await guestMain({ contentId: "audio-story" });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, "MEMBER_LOGIN_REQUIRED");
  assert.strictEqual(JSON.stringify(denied).includes("fileID"), false);

  const expiredDatabase = createDatabase({
    ...baseSeed,
    memberSessions: member.memberSessions.map((session) => ({
      ...session,
      expiresAt: new Date(Date.now() - 1000)
    }))
  });
  const expiredMain = loadCloudFunction("cloudfunctions/getAudioManifest/index.js", {
    database: expiredDatabase,
    openid: member.openid
  });
  const expired = await expiredMain({ contentId: "audio-story" });
  assert.strictEqual(expired.code, "MEMBER_LOGIN_REQUIRED");

  const database = createDatabase({
    ...baseSeed,
    memberSessions: member.memberSessions
  });
  const main = loadCloudFunction("cloudfunctions/getAudioManifest/index.js", {
    database,
    openid: member.openid
  });
  const allowed = await main({ contentId: "audio-story" });
  assert.strictEqual(allowed.success, true);
  assert.strictEqual(allowed.available, true);
  assert.strictEqual(allowed.manifest.accessPolicy.audio, "member");
  assert.strictEqual(allowed.manifest.tracks[0].src.startsWith("https://"), true);
  assert.strictEqual(JSON.stringify(allowed).includes("cloud://"), false);
  assert.strictEqual(JSON.stringify(allowed).includes("fileID"), false);

  const unsignedMain = loadCloudFunction("cloudfunctions/getAudioManifest/index.js", {
    database,
    openid: member.openid,
    tempURL: false
  });
  const unsigned = await unsignedMain({ contentId: "audio-story" });
  assert.strictEqual(unsigned.success, false);
  assert.strictEqual(unsigned.code, "AUDIO_URL_CREATE_FAILED");
}

async function testSpecialTopicFirstUnlockAndConcurrency() {
  const member = createMemberSeed();
  const topic = (id, cost, order) => ({
    _id: id,
    topicId: id,
    title: `Topic ${id}`,
    summary: "Published topic",
    previewCover:
      `cloud://env/published/images/special-topics/${id}/cover.jpg`,
    status: "published",
    currentRevision: "r1",
    unlockCostStars: cost,
    sortOrder: order
  });
  const entry = (topicId) => ({
    _id: `${topicId}-entry`,
    topicId,
    topicRevision: "r1",
    status: "published",
    sortOrder: 1,
    blocks: [
      { type: "text", text: `Content ${topicId}` },
      ...(topicId === "topic-one"
        ? [{
            type: "image",
            fileID: "cloud://env/protected/special-topics/topic-one/r1/one.jpg",
            caption: "Topic image"
          }]
        : [])
    ]
  });
  let zeroBalanceTempURLCalls = 0;
  const zeroBalanceDatabase = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    rewardLedger: [],
    specialTopics: [topic("topic-one", 60, 1)],
    specialTopicEntries: [entry("topic-one")],
    specialTopicUnlocks: []
  });
  const zeroBalanceMain = loadCloudFunction(
    "cloudfunctions/specialTopicCenter/index.js",
    {
      database: zeroBalanceDatabase,
      openid: member.openid,
      tempURL: async ({ fileList }) => {
        zeroBalanceTempURLCalls += 1;
        return {
          fileList: fileList.map((fileID) => ({
            fileID,
            status: 0,
            tempFileURL: "https://signed.example/should-not-be-used.jpg"
          }))
        };
      }
    }
  );
  const zeroBalanceOpen = await zeroBalanceMain({
    action: "open",
    topicId: "topic-one"
  });

  assert.strictEqual(zeroBalanceOpen.success, false);
  assert.strictEqual(zeroBalanceOpen.code, "INSUFFICIENT_STARS");
  assert.strictEqual(zeroBalanceOpen.requiredStars, 60);
  assert.strictEqual(zeroBalanceOpen.starRemain, 0);
  assert.strictEqual(zeroBalanceTempURLCalls, 0);
  assert.strictEqual(
    zeroBalanceDatabase.document("users", member.userId).starUsed,
    0
  );
  assert.strictEqual(
    zeroBalanceDatabase.documents("specialTopicUnlocks").length,
    0
  );
  const lockedRead = await zeroBalanceMain({
    action: "readPage",
    topicId: "topic-one",
    expectedRevision: "r1"
  });

  assert.strictEqual(lockedRead.success, false);
  assert.strictEqual(lockedRead.code, "TOPIC_UNLOCK_REQUIRED");
  assert.strictEqual(zeroBalanceTempURLCalls, 0);

  const database = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    rewardLedger: [
      {
        _id: "reward-a",
        openid: member.openid,
        userId: member.userId,
        status: "granted",
        rewardType: "content-completion",
        amount: 30
      },
      {
        _id: "reward-b",
        openid: member.openid,
        userId: member.userId,
        status: "granted",
        rewardType: "content-completion"
      }
    ],
    specialTopics: [
      topic("topic-one", 60, 1),
      topic("topic-two", 10, 2),
      topic("topic-three", 20, 3)
    ],
    specialTopicEntries: [
      entry("topic-one"),
      entry("topic-two"),
      entry("topic-three")
    ],
    specialTopicUnlocks: []
  });
  const main = loadCloudFunction("cloudfunctions/specialTopicCenter/index.js", {
    database,
    openid: member.openid
  });
  const catalog = await main({ action: "list" });
  assert.strictEqual(catalog.success, true);
  assert.strictEqual(catalog.memberLoggedIn, true);
  assert.strictEqual(catalog.topics[0].unlocked, false);
  assert.strictEqual(
    catalog.topics.every((item) => item.previewCover.startsWith("https://")),
    true
  );
  assert.strictEqual(JSON.stringify(catalog).includes("cloud://"), false);

  const first = await main({ action: "open", topicId: "topic-one" });
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.firstUnlock, true);
  assert.strictEqual(first.chargedStars, 60);
  assert.strictEqual(first.starRemain, 20);
  assert.strictEqual(first.topic.previewCover, "");
  assert.strictEqual(first.entries.length, 0);
  assert.strictEqual(first.hasMore, true);
  assert.strictEqual(first.nextCursor.entryOffset, 0);
  assert.strictEqual(first.nextCursor.blockOffset, 0);
  assert.strictEqual(JSON.stringify(first).includes("cloud://"), false);
  assert.strictEqual(database.document("users", member.userId).starUsed, 60);

  const firstPage = await main({
    action: "readPage",
    topicId: "topic-one",
    expectedRevision: first.topic.currentRevision
  });
  assert.strictEqual(firstPage.success, true);
  assert.strictEqual(firstPage.entries.length, 1);
  assert.strictEqual(
    firstPage.entries[0].blocks[1].src.startsWith("https://"),
    true
  );
  assert.strictEqual(firstPage.hasMore, false);
  assert.strictEqual(firstPage.nextCursor, null);
  assert.strictEqual(JSON.stringify(firstPage).includes("fileID"), false);
  assert.strictEqual(JSON.stringify(firstPage).includes("cloud://"), false);

  const repeated = await main({ action: "open", topicId: "topic-one" });
  assert.strictEqual(repeated.success, true);
  assert.strictEqual(repeated.firstUnlock, false);
  assert.strictEqual(repeated.chargedStars, 0);
  assert.strictEqual(database.document("users", member.userId).starUsed, 60);

  const concurrent = await Promise.all([
    main({ action: "open", topicId: "topic-two" }),
    main({ action: "open", topicId: "topic-two" }),
    main({ action: "open", topicId: "topic-two" })
  ]);
  assert.strictEqual(concurrent.filter((result) => result.firstUnlock).length, 1);
  assert.strictEqual(
    concurrent.reduce((sum, result) => sum + result.chargedStars, 0),
    10
  );
  assert.strictEqual(database.document("users", member.userId).starUsed, 70);

  const insufficient = await main({ action: "open", topicId: "topic-three" });
  assert.strictEqual(insufficient.success, false);
  assert.strictEqual(insufficient.code, "INSUFFICIENT_STARS");
  assert.strictEqual(database.document("users", member.userId).starUsed, 70);
  assert.strictEqual(database.documents("specialTopicUnlocks").length, 2);
  assert.strictEqual(database.documents("rewardLedger").length, 2);

  const unsignedMain = loadCloudFunction(
    "cloudfunctions/specialTopicCenter/index.js",
    {
      database,
      openid: member.openid,
      tempURL: false
    }
  );
  const unsignedCatalog = await unsignedMain({ action: "list" });
  const unsignedOpen = await unsignedMain({
    action: "open",
    topicId: "topic-one"
  });
  const unsignedRead = await unsignedMain({
    action: "readPage",
    topicId: "topic-one",
    expectedRevision: unsignedOpen.topic.currentRevision
  });

  assert.strictEqual(unsignedCatalog.success, true);
  assert.strictEqual(
    unsignedCatalog.topics.every((item) => item.previewCover === ""),
    true
  );
  assert.strictEqual(JSON.stringify(unsignedCatalog).includes("cloud://"), false);
  assert.strictEqual(unsignedOpen.success, true);
  assert.strictEqual(unsignedOpen.topic.previewCover, "");
  assert.strictEqual(JSON.stringify(unsignedOpen).includes("cloud://"), false);
  assert.strictEqual(unsignedRead.success, false);
  assert.strictEqual(unsignedRead.code, "TOPIC_IMAGE_URL_CREATE_FAILED");
  assert.strictEqual(JSON.stringify(unsignedRead).includes("cloud://"), false);
  assert.strictEqual(JSON.stringify(unsignedRead).includes("fileID"), false);

  const guestDatabase = createDatabase({
    users: member.users,
    specialTopics: [topic("topic-one", 60, 1)],
    specialTopicEntries: [entry("topic-one")]
  });
  const guestMain = loadCloudFunction("cloudfunctions/specialTopicCenter/index.js", {
    database: guestDatabase,
    openid: member.openid
  });
  const guestOpen = await guestMain({ action: "open", topicId: "topic-one" });
  assert.strictEqual(guestOpen.code, "MEMBER_LOGIN_REQUIRED");
  const guestRead = await guestMain({
    action: "readPage",
    topicId: "topic-one",
    expectedRevision: "r1"
  });
  assert.strictEqual(guestRead.code, "MEMBER_LOGIN_REQUIRED");
}

async function testSpecialTopicContentPaginationIsBounded() {
  const member = createMemberSeed("openid-pagination");
  const publishedTopic = (id, order) => ({
    _id: id,
    topicId: id,
    title: `Topic ${id}`,
    summary: "Paged topic",
    status: "published",
    currentRevision: "r1",
    unlockCostStars: 1,
    sortOrder: order
  });
  const publishedEntry = (id, topicId, blocks) => ({
    _id: id,
    topicId,
    topicRevision: "r1",
    status: "published",
    sortOrder: 1,
    blocks
  });
  const imageBatchSizes = [];
  const database = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    rewardLedger: [
      {
        _id: "pagination-reward",
        openid: member.openid,
        userId: member.userId,
        status: "granted",
        rewardType: "content-completion",
        amount: 100
      }
    ],
    specialTopics: [
      publishedTopic("topic-text", 1),
      publishedTopic("topic-images", 2)
    ],
    specialTopicEntries: [
      publishedEntry(
        "topic-text-entry",
        "topic-text",
        Array.from({ length: 45 }, (_, index) => ({
          type: "text",
          text: `Paragraph ${index + 1}`
        }))
      ),
      publishedEntry(
        "topic-images-entry",
        "topic-images",
        Array.from({ length: 12 }, (_, index) => ({
          type: "image",
          fileID:
            `cloud://env/protected/special-topics/topic-images/r1/${index + 1}.jpg`,
          caption: `Image ${index + 1}`
        }))
      )
    ],
    specialTopicUnlocks: []
  });
  const main = loadCloudFunction("cloudfunctions/specialTopicCenter/index.js", {
    database,
    openid: member.openid,
    tempURL: async ({ fileList }) => {
      imageBatchSizes.push(fileList.length);
      return {
        fileList: fileList.map((fileID, index) => ({
          fileID,
          status: 0,
          tempFileURL:
            `https://signed.example/topic-image-${imageBatchSizes.length}-${index + 1}.jpg`
        }))
      };
    }
  });

  const textOpen = await main({ action: "open", topicId: "topic-text" });
  const imageOpen = await main({ action: "open", topicId: "topic-images" });
  assert.strictEqual(textOpen.success, true);
  assert.strictEqual(imageOpen.success, true);
  assert.strictEqual(imageBatchSizes.length, 0);

  const textFirst = await main({
    action: "readPage",
    topicId: "topic-text",
    expectedRevision: textOpen.topic.currentRevision
  });
  assert.strictEqual(textFirst.success, true);
  assert.strictEqual(textFirst.entries.length, 1);
  assert.strictEqual(textFirst.entries[0].blocks.length, 40);
  assert.strictEqual(textFirst.hasMore, true);
  assert.strictEqual(textFirst.nextCursor.entryOffset, 0);
  assert.strictEqual(textFirst.nextCursor.blockOffset, 40);

  const textSecond = await main({
    action: "readPage",
    topicId: "topic-text",
    expectedRevision: textOpen.topic.currentRevision,
    cursor: textFirst.nextCursor
  });
  assert.strictEqual(textSecond.success, true);
  assert.strictEqual(textSecond.entries.length, 1);
  assert.strictEqual(textSecond.entries[0].blocks.length, 5);
  assert.strictEqual(textSecond.hasMore, false);
  assert.strictEqual(textSecond.nextCursor, null);
  assert.strictEqual(
    textFirst.entries[0].blocks.length +
      textSecond.entries[0].blocks.length,
    45
  );

  const imageFirst = await main({
    action: "readPage",
    topicId: "topic-images",
    expectedRevision: imageOpen.topic.currentRevision
  });
  assert.strictEqual(imageFirst.success, true);
  assert.strictEqual(imageFirst.entries.length, 1);
  assert.strictEqual(imageFirst.entries[0].blocks.length, 10);
  assert.strictEqual(imageFirst.hasMore, true);
  assert.strictEqual(imageFirst.nextCursor.entryOffset, 0);
  assert.strictEqual(imageFirst.nextCursor.blockOffset, 10);

  const imageSecond = await main({
    action: "readPage",
    topicId: "topic-images",
    expectedRevision: imageOpen.topic.currentRevision,
    cursor: imageFirst.nextCursor
  });
  assert.strictEqual(imageSecond.success, true);
  assert.strictEqual(imageSecond.entries.length, 1);
  assert.strictEqual(imageSecond.entries[0].blocks.length, 2);
  assert.strictEqual(imageSecond.hasMore, false);
  assert.strictEqual(imageSecond.nextCursor, null);
  assert.strictEqual(JSON.stringify(imageFirst).includes("fileID"), false);
  assert.strictEqual(JSON.stringify(imageSecond).includes("fileID"), false);
  assert.deepStrictEqual(imageBatchSizes, [10, 2]);
}

async function testSpecialTopicReadPageRejectsRevisionChanges() {
  const member = createMemberSeed("openid-revision-change");
  const database = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    rewardLedger: [
      {
        _id: "revision-change-reward",
        openid: member.openid,
        userId: member.userId,
        status: "granted",
        rewardType: "content-completion",
        amount: 5
      }
    ],
    specialTopics: [
      {
        _id: "topic-revision-change",
        topicId: "topic-revision-change",
        title: "Revision-bound topic",
        summary: "The next page must stay on the opened revision",
        status: "published",
        currentRevision: "r1",
        unlockCostStars: 1,
        sortOrder: 1
      }
    ],
    specialTopicEntries: [
      {
        _id: "topic-revision-change-r1-entry",
        topicId: "topic-revision-change",
        topicRevision: "r1",
        status: "published",
        sortOrder: 1,
        blocks: Array.from({ length: 41 }, (_, index) => ({
          type: "text",
          text: `Revision r1 paragraph ${index + 1}`
        }))
      }
    ],
    specialTopicUnlocks: []
  });
  const main = loadCloudFunction("cloudfunctions/specialTopicCenter/index.js", {
    database,
    openid: member.openid
  });

  const opened = await main({
    action: "open",
    topicId: "topic-revision-change"
  });
  assert.strictEqual(opened.success, true);
  assert.strictEqual(opened.topic.currentRevision, "r1");

  const firstPage = await main({
    action: "readPage",
    topicId: "topic-revision-change",
    expectedRevision: opened.topic.currentRevision
  });
  assert.strictEqual(firstPage.success, true);
  assert.strictEqual(firstPage.entries[0].blocks.length, 40);
  assert.strictEqual(firstPage.hasMore, true);

  await database
    .collection("specialTopics")
    .doc("topic-revision-change")
    .update({ data: { currentRevision: "r2" } });

  const stalePage = await main({
    action: "readPage",
    topicId: "topic-revision-change",
    expectedRevision: opened.topic.currentRevision,
    cursor: firstPage.nextCursor
  });
  assert.strictEqual(stalePage.success, false);
  assert.strictEqual(stalePage.code, "TOPIC_CHANGED_RELOAD");
}

async function testSpecialTopicInvalidTrailingRowDoesNotFailAtEnd() {
  const member = createMemberSeed("openid-invalid-topic-tail");
  const database = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    rewardLedger: [
      {
        _id: "invalid-tail-reward",
        openid: member.openid,
        userId: member.userId,
        status: "granted",
        rewardType: "content-completion",
        amount: 5
      }
    ],
    specialTopics: [
      {
        _id: "topic-invalid-tail",
        topicId: "topic-invalid-tail",
        title: "Topic with an invalid trailing row",
        summary: "Invalid stored rows must not turn the end into an error",
        status: "published",
        currentRevision: "r1",
        unlockCostStars: 1,
        sortOrder: 1
      }
    ],
    specialTopicEntries: [
      {
        _id: "topic-invalid-tail-valid-entry",
        topicId: "topic-invalid-tail",
        topicRevision: "r1",
        status: "published",
        sortOrder: 1,
        blocks: Array.from({ length: 40 }, (_, index) => ({
          type: "text",
          text: `Valid paragraph ${index + 1}`
        }))
      },
      {
        _id: "topic-invalid-tail-empty-entry",
        topicId: "topic-invalid-tail",
        topicRevision: "r1",
        status: "published",
        sortOrder: 2,
        blocks: []
      }
    ],
    specialTopicUnlocks: []
  });
  const main = loadCloudFunction("cloudfunctions/specialTopicCenter/index.js", {
    database,
    openid: member.openid
  });

  const opened = await main({
    action: "open",
    topicId: "topic-invalid-tail"
  });
  assert.strictEqual(opened.success, true);

  const firstPage = await main({
    action: "readPage",
    topicId: "topic-invalid-tail",
    expectedRevision: opened.topic.currentRevision
  });
  assert.strictEqual(firstPage.success, true);
  assert.strictEqual(firstPage.entries.length, 1);
  assert.strictEqual(firstPage.entries[0].blocks.length, 40);

  if (firstPage.hasMore) {
    const terminalPage = await main({
      action: "readPage",
      topicId: "topic-invalid-tail",
      expectedRevision: opened.topic.currentRevision,
      cursor: firstPage.nextCursor
    });
    assert.strictEqual(terminalPage.success, true);
    assert.strictEqual(Array.isArray(terminalPage.entries), true);
    assert.strictEqual(terminalPage.entries.length, 0);
    assert.strictEqual(terminalPage.hasMore, false);
    assert.strictEqual(terminalPage.nextCursor, null);
  } else {
    assert.strictEqual(firstPage.nextCursor, null);
  }
}

async function testQuizAttemptsArePersistedWithoutRewards() {
  const member = createMemberSeed();
  const publishedQuestion = {
    _id: "quiz-admin-published",
    questionId: "quiz-admin-published",
    revision: "quiz-revision-1",
    status: "published",
    publishedAt: new Date(),
    sortOrder: 1,
    topic: "管理员发布题目",
    department: "测试科室",
    source: "管理员结构化草稿发布",
    question: "哪一个选项是正确答案？",
    options: [
      { key: "one", label: "选择一", text: "正确选项" },
      { key: "two", label: "选择二", text: "错误选项" }
    ],
    correctKey: "one",
    correctFeedback: "回答正确",
    wrongFeedback: "回答错误",
    explanation: "本题仅来自已发布的 quizQuestions 文档。"
  };
  const database = createDatabase({
    users: member.users,
    memberSessions: member.memberSessions,
    quizQuestions: [publishedQuestion],
    quizAttempts: [],
    rewardLedger: []
  });
  const main = loadCloudFunction("cloudfunctions/quizCenter/index.js", {
    database,
    openid: member.openid
  });
  const list = await main({ action: "list" });
  assert.strictEqual(list.success, true);
  assert.strictEqual(list.source, "cloud");
  assert.strictEqual(list.questions.length, 1);
  assert.strictEqual(list.questions[0].id, publishedQuestion._id);
  assert.strictEqual(JSON.stringify(list).includes("correctKey"), false);

  const event = {
    action: "submitAttempt",
    questionId: publishedQuestion._id,
    revision: publishedQuestion.revision,
    selectedKey: "one",
    attemptId: "attempt:admin-published:fixed"
  };
  const first = await main(event);
  const duplicate = await main(event);
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.attempt.isCorrect, true);
  assert.strictEqual(first.attempt.duplicate, false);
  assert.strictEqual(duplicate.success, true);
  assert.strictEqual(duplicate.attempt.duplicate, true);
  assert.strictEqual(database.documents("quizAttempts").length, 1);

  const wrong = await main({
    ...event,
    selectedKey: "two",
    attemptId: "attempt:0001:second"
  });
  assert.strictEqual(wrong.success, true);
  assert.strictEqual(wrong.attempt.isCorrect, false);
  assert.strictEqual(database.documents("quizAttempts").length, 2);
  assert.strictEqual(database.documents("rewardLedger").length, 0);
  assert.strictEqual(database.document("users", member.userId).starUsed, 0);
  assert.strictEqual(
    database.documents("quizAttempts").every((attempt) => attempt.source === "cloud"),
    true
  );
  assert.strictEqual(JSON.stringify(first).includes("score"), false);
  assert.strictEqual(JSON.stringify(first).includes("reward"), false);

  const guestDatabase = createDatabase({
    users: member.users,
    quizQuestions: [publishedQuestion]
  });
  const guestMain = loadCloudFunction("cloudfunctions/quizCenter/index.js", {
    database: guestDatabase,
    openid: member.openid
  });
  const guestAttempt = await guestMain(event);
  assert.strictEqual(guestAttempt.code, "MEMBER_LOGIN_REQUIRED");
}

async function testQuizNeverFallsBackWhenPublishedQuestionsAreUnavailable() {
  const member = createMemberSeed();
  const event = {
    action: "submitAttempt",
    questionId: "0001",
    revision: "2026-07-14-v1",
    selectedKey: "one",
    attemptId: "attempt:missing-question:fixed"
  };

  for (const database of [
    createDatabase(
      {
        users: member.users,
        memberSessions: member.memberSessions,
        quizAttempts: []
      },
      { missingCollections: ["quizQuestions"] }
    ),
    createDatabase({
      users: member.users,
      memberSessions: member.memberSessions,
      quizQuestions: [],
      quizAttempts: []
    })
  ]) {
    const main = loadCloudFunction("cloudfunctions/quizCenter/index.js", {
      database,
      openid: member.openid
    });
    const list = await main({ action: "list" });
    assert.strictEqual(list.success, true);
    assert.strictEqual(list.source, "cloud");
    assert.deepStrictEqual(Array.from(list.questions), []);

    const attempt = await main(event);
    assert.strictEqual(attempt.success, false);
    assert.strictEqual(attempt.code, "QUESTION_NOT_AVAILABLE");
    assert.strictEqual(database.documents("quizAttempts").length, 0);
  }
}

function testClientIntegrationSources() {
  const zhen = fs.readFileSync(
    path.join(root, "miniprogram/pages/zhen/zhen.js"),
    "utf8"
  );
  const ai = fs.readFileSync(
    path.join(root, "miniprogram/pages/ai/ai.js"),
    "utf8"
  );
  const detail = fs.readFileSync(
    path.join(root, "miniprogram/pages/specialTopicDetail/specialTopicDetail.js"),
    "utf8"
  );
  const quizServer = fs.readFileSync(
    path.join(root, "cloudfunctions/quizCenter/index.js"),
    "utf8"
  );
  assert(zhen.includes('name: "specialTopicCenter"'));
  assert(zhen.includes("specialTopicDetail"));
  assert(detail.includes('action: "open"'));
  assert(detail.includes('action: "readPage"'));
  assert(detail.includes("onReachBottom"));
  assert(ai.includes('action: "submitAttempt"'));
  assert(ai.includes("答题不统计总成绩，也不会发放红五星"));
  assert.strictEqual(ai.includes("localQuestionBank"), false);
  assert.strictEqual(ai.includes("内置审定题目"), false);
  assert.strictEqual(quizServer.includes("BUILT_IN_QUESTIONS"), false);
  assert.strictEqual(quizServer.includes('source: "built-in"'), false);
}

async function main() {
  await testAudioMembershipAndSignedURLs();
  await testSpecialTopicFirstUnlockAndConcurrency();
  await testSpecialTopicContentPaginationIsBounded();
  await testSpecialTopicReadPageRejectsRevisionChanges();
  await testSpecialTopicInvalidTrailingRowDoesNotFailAtEnd();
  await testQuizAttemptsArePersistedWithoutRewards();
  await testQuizNeverFallsBackWhenPublishedQuestionsAreUnavailable();
  testClientIntegrationSources();
  console.log("专题、答题记录与会员音频测试通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
