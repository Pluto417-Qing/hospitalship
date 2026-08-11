const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_LEDGER_ROWS = 1000;
const MAX_TOPIC_ENTRIES = 200;
const CONTENT_ENTRY_WINDOW = 10;
const CONTENT_BLOCK_LIMIT = 40;
const CONTENT_IMAGE_LIMIT = 10;
const CONTENT_TEXT_LIMIT = 30000;
const TOPIC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createMemberSessionId(openid) {
  return sha256(JSON.stringify(["member-session", openid])).slice(0, 32);
}

function createPrimaryUserId(openid) {
  return sha256(JSON.stringify(["user-openid", openid])).slice(0, 32);
}

function createUnlockId(userId, topicId) {
  return sha256(
    JSON.stringify(["special-topic-unlock", userId, topicId])
  ).slice(0, 32);
}

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function normalizeLimit(value) {
  const number = Number(value);
  return Number.isInteger(number)
    ? Math.min(MAX_LIMIT, Math.max(1, number))
    : DEFAULT_LIMIT;
}

function normalizeOffset(value) {
  const number = Number(value);
  return Number.isInteger(number)
    ? Math.min(10000, Math.max(0, number))
    : 0;
}

function normalizeContentCursor(value) {
  const cursor = value && typeof value === "object" ? value : {};
  const entryOffset = Number(cursor.entryOffset);
  const blockOffset = Number(cursor.blockOffset);

  return {
    entryOffset: Number.isInteger(entryOffset)
      ? Math.min(MAX_TOPIC_ENTRIES, Math.max(0, entryOffset))
      : 0,
    blockOffset: Number.isInteger(blockOffset)
      ? Math.min(200, Math.max(0, blockOffset))
      : 0
  };
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
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMissingError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "-502005" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|collection).*(?:not found|does not exist|not exist)/i.test(message) ||
    /(?:文档|集合).*不存在/.test(message)
  );
}

async function readDocument(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }

    throw error;
  }
}

async function readTransactionDocument(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : result || null;
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }

    throw error;
  }
}

function unwrapTransactionResult(value) {
  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "result") &&
    typeof value.errMsg === "string" &&
    value.errMsg.includes("runTransaction")
  ) {
    return value.result;
  }

  return value;
}

function isActiveSession(session, openid) {
  return Boolean(
    session &&
      session.status === "active" &&
      normalizeText(session.userId, 128) &&
      (!session.openid || session.openid === openid) &&
      toTimestamp(session.expiresAt) > Date.now()
  );
}

function isActiveUser(user, userId, openid) {
  return Boolean(
    user &&
      normalizeText(user._id, 128) === userId &&
      normalizeText(user.openid, 128) === openid &&
      (!user.registerStatus || user.registerStatus === "active")
  );
}

async function resolveActiveMember(openid) {
  if (!openid) {
    return null;
  }

  const sessionId = createMemberSessionId(openid);
  const session = await readDocument(
    db.collection("memberSessions").doc(sessionId)
  );

  if (!isActiveSession(session, openid)) {
    return null;
  }

  const userId = normalizeText(session.userId, 128);
  const user = await readDocument(db.collection("users").doc(userId));

  if (!isActiveUser(user, userId, openid)) {
    return null;
  }

  return {
    sessionId,
    userId,
    user
  };
}

function normalizePublishedImageFileId(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.includes("..")
  ) {
    return "";
  }

  const separator = value.indexOf("/", "cloud://".length);
  const path = separator >= 0 ? value.slice(separator + 1) : "";
  return path.startsWith("published/images/") ? value : "";
}

function normalizeProtectedTopicImageFileId(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.includes("..")
  ) {
    return "";
  }

  const separator = value.indexOf("/", "cloud://".length);
  const path = separator >= 0 ? value.slice(separator + 1) : "";
  return path.startsWith("protected/special-topics/") ? value : "";
}

function normalizeTopic(document) {
  if (!document || document.status !== "published") {
    return null;
  }

  const id = normalizeText(document._id, 64);
  const topicId = normalizeText(document.topicId || id, 64);
  const title = normalizeText(document.title, 120);
  const currentRevision = normalizeText(document.currentRevision, 128);
  const unlockCostStars = Number(document.unlockCostStars);

  if (
    !TOPIC_ID_PATTERN.test(id) ||
    topicId !== id ||
    !title ||
    !currentRevision ||
    !Number.isInteger(unlockCostStars) ||
    unlockCostStars <= 0 ||
    unlockCostStars > 1000000
  ) {
    return null;
  }

  return {
    id,
    title,
    summary: normalizeText(document.summary || document.subtitle, 500),
    producer: normalizeText(document.producer || document.author, 120),
    previewCover: normalizePublishedImageFileId(
      document.previewCover || document.coverFileId || document.cover
    ),
    currentRevision,
    unlockCostStars,
    sortOrder: Number.isFinite(Number(document.sortOrder))
      ? Number(document.sortOrder)
      : 0,
    publishedAt: document.publishedAt || null
  };
}

function normalizeBlock(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const type = normalizeText(source.type || source.kind, 20).toLowerCase();

  if (type === "image") {
    const fileID = normalizeProtectedTopicImageFileId(
      source.fileID || source.imageFileID || source.src
    );

    return fileID
      ? {
          type: "image",
          fileID,
          caption: normalizeText(source.caption, 300)
        }
      : null;
  }

  if (type === "heading") {
    const text = normalizeText(source.text || source.content, 300);
    return text ? { type: "heading", text } : null;
  }

  const text = normalizeText(source.text || source.content, 10000);
  return text ? { type: "text", text } : null;
}

function normalizeEntry(document) {
  if (!document || document.status !== "published") {
    return null;
  }

  const id = normalizeText(document._id, 128);
  const rawBlocks = Array.isArray(document.blocks) ? document.blocks : [];
  const blocks = rawBlocks.slice(0, 200).map(normalizeBlock).filter(Boolean);

  if (blocks.length === 0) {
    const heading = normalizeText(document.heading || document.title, 300);
    const paragraphs = Array.isArray(document.paragraphs)
      ? document.paragraphs.slice(0, 200)
      : [];
    const image = normalizeProtectedTopicImageFileId(
      document.fileID || document.imageFileID || document.image
    );

    if (heading) {
      blocks.push({ type: "heading", text: heading });
    }

    paragraphs.forEach((paragraph) => {
      const text = normalizeText(paragraph, 10000);
      if (text) {
        blocks.push({ type: "text", text });
      }
    });

    if (image) {
      blocks.push({
        type: "image",
        fileID: image,
        caption: normalizeText(document.caption, 300)
      });
    }
  }

  return id && blocks.length > 0
    ? {
        id,
        sortOrder: Number.isFinite(Number(document.sortOrder))
          ? Number(document.sortOrder)
          : 0,
        blocks: blocks.map((block, index) => ({
          ...block,
          key: `${id}-block-${index + 1}`
        }))
      }
    : null;
}

function isSafeTemporaryURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("https://") ||
    /[\s\\\u0000-\u001f]/.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch (error) {
    return false;
  }
}

function createTopicImageURLCreateError() {
  const error = new Error("专题图片播放地址生成失败");
  error.code = "TOPIC_IMAGE_URL_CREATE_FAILED";
  return error;
}

async function createSignedPublishedImageURLs(fileIDs) {
  const requested = Array.from(new Set(fileIDs.filter(Boolean)));
  const requestedSet = new Set(requested);
  const signedByFileID = new Map();

  if (requested.length === 0 || typeof cloud.getTempFileURL !== "function") {
    return signedByFileID;
  }

  try {
    for (let offset = 0; offset < requested.length; offset += 50) {
      const batch = requested.slice(offset, offset + 50);
      const result = await cloud.getTempFileURL({ fileList: batch });
      const signedFiles = result && Array.isArray(result.fileList)
        ? result.fileList
        : [];

      signedFiles.forEach((file) => {
        if (
          file &&
          requestedSet.has(file.fileID) &&
          (file.status === undefined || Number(file.status) === 0) &&
          isSafeTemporaryURL(file.tempFileURL)
        ) {
          signedByFileID.set(file.fileID, file.tempFileURL);
        }
      });
    }
  } catch (error) {
    console.warn("specialTopicCenter preview cover URL signing failed");
    return new Map();
  }

  return signedByFileID;
}

async function createSignedEntries(entries) {
  const fileIDs = [];
  const seen = new Set();

  entries.forEach((entry) => {
    entry.blocks.forEach((block) => {
      if (block.type === "image" && block.fileID && !seen.has(block.fileID)) {
        seen.add(block.fileID);
        fileIDs.push(block.fileID);
      }
    });
  });

  if (fileIDs.length === 0) {
    return entries;
  }

  if (typeof cloud.getTempFileURL !== "function") {
    throw createTopicImageURLCreateError();
  }

  const signedByFileID = new Map();

  try {
    for (let offset = 0; offset < fileIDs.length; offset += 50) {
      const batch = fileIDs.slice(offset, offset + 50);
      const result = await cloud.getTempFileURL({ fileList: batch });
      const signedFiles = result && Array.isArray(result.fileList)
        ? result.fileList
        : [];

      signedFiles.forEach((file) => {
        if (
          file &&
          seen.has(file.fileID) &&
          (file.status === undefined || Number(file.status) === 0) &&
          isSafeTemporaryURL(file.tempFileURL)
        ) {
          signedByFileID.set(file.fileID, file.tempFileURL);
        }
      });
    }
  } catch (error) {
    throw createTopicImageURLCreateError();
  }

  if (signedByFileID.size !== fileIDs.length) {
    throw createTopicImageURLCreateError();
  }

  return entries.map((entry) => ({
    ...entry,
    blocks: entry.blocks.map((block) =>
      block.type === "image"
        ? {
            key: block.key,
            type: "image",
            src: signedByFileID.get(block.fileID),
            caption: block.caption
          }
        : block
    )
  }));
}

async function readTopicEntryRows(topic, entryOffset, limit) {
  const result = await db
    .collection("specialTopicEntries")
    .where({
      topicId: topic.id,
      topicRevision: topic.currentRevision,
      status: "published"
    })
    .orderBy("sortOrder", "asc")
    .orderBy("_id", "asc")
    .skip(entryOffset)
    .limit(limit)
    .get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function hasPublishedTopicContent(topic) {
  const rows = await readTopicEntryRows(topic, 0, MAX_TOPIC_ENTRIES);
  return rows.some((row) => Boolean(normalizeEntry(row)));
}

function blockTextLength(block) {
  return block && (block.type === "text" || block.type === "heading")
    ? String(block.text || "").length
    : 0;
}

function buildTopicContentPage(rows, cursor) {
  const chunks = [];
  let blockCount = 0;
  let imageCount = 0;
  let textLength = 0;
  const visibleRows = rows.slice(0, CONTENT_ENTRY_WINDOW);

  for (let rowIndex = 0; rowIndex < visibleRows.length; rowIndex += 1) {
    const entry = normalizeEntry(visibleRows[rowIndex]);
    const absoluteEntryOffset = cursor.entryOffset + rowIndex;

    if (!entry) {
      continue;
    }

    const start = rowIndex === 0
      ? Math.min(cursor.blockOffset, entry.blocks.length)
      : 0;
    const selectedBlocks = [];
    let nextBlockOffset = start;

    while (nextBlockOffset < entry.blocks.length) {
      const block = entry.blocks[nextBlockOffset];
      const nextImageCount = imageCount + (block.type === "image" ? 1 : 0);
      const nextTextLength = textLength + blockTextLength(block);
      const pageHasBlocks = blockCount > 0;
      const exceedsBudget =
        blockCount >= CONTENT_BLOCK_LIMIT ||
        nextImageCount > CONTENT_IMAGE_LIMIT ||
        (nextTextLength > CONTENT_TEXT_LIMIT && pageHasBlocks);

      if (exceedsBudget) {
        if (selectedBlocks.length > 0) {
          chunks.push({
            id: `${entry.id}-part-${start}`,
            sourceEntryId: entry.id,
            sortOrder: entry.sortOrder,
            blocks: selectedBlocks
          });
        }

        return {
          entries: chunks,
          hasMore: true,
          nextCursor: {
            entryOffset: absoluteEntryOffset,
            blockOffset: nextBlockOffset
          }
        };
      }

      selectedBlocks.push(block);
      blockCount += 1;
      imageCount = nextImageCount;
      textLength = nextTextLength;
      nextBlockOffset += 1;
    }

    if (selectedBlocks.length > 0) {
      chunks.push({
        id: `${entry.id}-part-${start}`,
        sourceEntryId: entry.id,
        sortOrder: entry.sortOrder,
        blocks: selectedBlocks
      });
    }

    if (
      blockCount >= CONTENT_BLOCK_LIMIT ||
      imageCount >= CONTENT_IMAGE_LIMIT ||
      textLength >= CONTENT_TEXT_LIMIT
    ) {
      const nextEntryOffset = absoluteEntryOffset + 1;
      const hasMore =
        rowIndex + 1 < rows.length ||
        rows.length > CONTENT_ENTRY_WINDOW;

      return {
        entries: chunks,
        hasMore,
        nextCursor: hasMore
          ? { entryOffset: nextEntryOffset, blockOffset: 0 }
          : null
      };
    }
  }

  const nextEntryOffset = cursor.entryOffset + visibleRows.length;
  const hasMore = rows.length > CONTENT_ENTRY_WINDOW;

  return {
    entries: chunks,
    hasMore,
    nextCursor: hasMore
      ? { entryOffset: nextEntryOffset, blockOffset: 0 }
      : null
  };
}

async function readTopicContentPage(topic, cursorValue) {
  const cursor = normalizeContentCursor(cursorValue);
  const rows = await readTopicEntryRows(
    topic,
    cursor.entryOffset,
    CONTENT_ENTRY_WINDOW + 1
  );
  const page = buildTopicContentPage(rows, cursor);

  return {
    ...page,
    entries: await createSignedEntries(page.entries)
  };
}

function calculateLedgerAmount(entry) {
  const hasAmount = Boolean(
    entry && Object.prototype.hasOwnProperty.call(entry, "amount")
  );
  const amount = Number(entry && entry.amount);

  if (hasAmount) {
    return Number.isFinite(amount) && Number.isInteger(amount) && amount > 0
      ? amount
      : -1;
  }

  return entry && entry.rewardType === "content-completion" ? 50 : 0;
}

async function readEarnedStars(member, openid) {
  const memberResultPromise = db
    .collection("rewardLedger")
    .where({
      userId: member.userId,
      status: "granted"
    })
    .limit(MAX_LEDGER_ROWS)
    .get();
  const includeLegacy = member.userId === createPrimaryUserId(openid);
  const legacyResultPromise = includeLegacy
    ? db
        .collection("rewardLedger")
        .where({
          openid,
          status: "granted"
        })
        .limit(MAX_LEDGER_ROWS)
        .get()
    : Promise.resolve({ data: [] });
  const [memberResult, legacyResult] = await Promise.all([
    memberResultPromise,
    legacyResultPromise
  ]);
  const memberRows = memberResult && Array.isArray(memberResult.data)
    ? memberResult.data
    : [];
  const legacyRows = legacyResult && Array.isArray(legacyResult.data)
    ? legacyResult.data.filter((row) => !row.userId)
    : [];
  const rowsBySource = new Map();

  [...legacyRows, ...memberRows].forEach((row) => {
    const sourceKey = normalizeText(
      row.contentId || row.sourceId || row._id,
      256
    );

    if (sourceKey) {
      rowsBySource.set(sourceKey, row);
    }
  });
  const rows = Array.from(rowsBySource.values());

  if (
    memberRows.length >= MAX_LEDGER_ROWS ||
    legacyRows.length >= MAX_LEDGER_ROWS ||
    rows.length >= MAX_LEDGER_ROWS
  ) {
    const error = new Error("奖励记录过多，需要先迁移钱包");
    error.code = "STAR_WALLET_MIGRATION_REQUIRED";
    throw error;
  }

  let total = 0;

  for (const row of rows) {
    if (
      (row.userId && row.userId !== member.userId) ||
      row.status !== "granted" ||
      (row.openid && row.openid !== openid)
    ) {
      const error = new Error("奖励记录归属异常");
      error.code = "STAR_LEDGER_IDENTITY_INVALID";
      throw error;
    }

    const amount = calculateLedgerAmount(row);

    if (amount < 0) {
      const error = new Error("奖励记录金额无效");
      error.code = "STAR_LEDGER_INVALID";
      throw error;
    }

    total += amount;

    if (!Number.isSafeInteger(total)) {
      const error = new Error("奖励余额超出可安全范围");
      error.code = "STAR_LEDGER_INVALID";
      throw error;
    }
  }

  return total;
}

async function listTopics(openid, event) {
  const offset = normalizeOffset(event.offset);
  const limit = normalizeLimit(event.limit);
  let result;

  try {
    result = await db
      .collection("specialTopics")
      .where({ status: "published" })
      .orderBy("publishedAt", "desc")
      .orderBy("_id", "desc")
      .skip(offset)
      .limit(limit + 1)
      .get();
  } catch (error) {
    if (isMissingError(error)) {
      return {
        success: true,
        source: "unavailable",
        memberLoggedIn: false,
        topics: [],
        hasMore: false,
        nextOffset: null
      };
    }

    throw error;
  }

  const rows = result && Array.isArray(result.data) ? result.data : [];
  const hasMore = rows.length > limit;
  const topics = rows.slice(0, limit).map(normalizeTopic).filter(Boolean);
  const signedCovers = await createSignedPublishedImageURLs(
    topics.map((topic) => topic.previewCover)
  );
  const member = await resolveActiveMember(openid);
  const unlockedIds = new Set();

  if (member) {
    try {
      const unlockResult = await db
        .collection("specialTopicUnlocks")
        .where({
          userId: member.userId,
          status: "unlocked"
        })
        .limit(1000)
        .get();

      (unlockResult.data || []).forEach((unlock) => {
        if (unlock.userId === member.userId) {
          unlockedIds.add(normalizeText(unlock.topicId, 64));
        }
      });
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
    }
  }

  return {
    success: true,
    source: "cloud",
    memberLoggedIn: Boolean(member),
    topics: topics.map((topic) => ({
      ...topic,
      previewCover: signedCovers.get(topic.previewCover) || "",
      unlocked: unlockedIds.has(topic.id)
    })),
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

async function openTopic(openid, event) {
  const topicId = normalizeText(event.topicId, 64);

  if (!TOPIC_ID_PATTERN.test(topicId)) {
    return {
      success: false,
      code: "INVALID_TOPIC_ID",
      message: "专题编号无效"
    };
  }

  const member = await resolveActiveMember(openid);

  if (!member) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员"
    };
  }

  const topicDocument = await readDocument(
    db.collection("specialTopics").doc(topicId)
  );
  const topic = normalizeTopic(topicDocument);

  if (!topic || topic.id !== topicId) {
    return {
      success: false,
      code: "TOPIC_NOT_AVAILABLE",
      message: "小专题尚未开放"
    };
  }

  const publicTopic = {
    ...topic,
    previewCover: ""
  };
  const unlockId = createUnlockId(member.userId, topicId);
  const directUnlock = await readDocument(
    db.collection("specialTopicUnlocks").doc(unlockId)
  );

  if (directUnlock) {
    if (
      directUnlock.userId !== member.userId ||
      directUnlock.topicId !== topicId ||
      directUnlock.status !== "unlocked"
    ) {
      throw new Error("special topic unlock identity mismatch");
    }

    return {
      success: true,
      source: "cloud",
      topic: publicTopic,
      topicRevision: topic.currentRevision,
      entries: [],
      hasMore: true,
      nextCursor: { entryOffset: 0, blockOffset: 0 },
      firstUnlock: false,
      chargedStars: 0,
      starRemain: null
    };
  }

  const earnedStars = await readEarnedStars(member, openid);
  const memberStarUsed = Number(member.user.starUsed || 0);

  if (
    !Number.isInteger(memberStarUsed) ||
    memberStarUsed < 0 ||
    memberStarUsed > earnedStars
  ) {
    return {
      success: false,
      code: "STAR_WALLET_INVALID",
      message: "红五星账户需要核对，暂时无法解锁"
    };
  }

  if (earnedStars - memberStarUsed < topic.unlockCostStars) {
    return {
      success: false,
      code: "INSUFFICIENT_STARS",
      message: "红五星余额不足",
      starRemain: earnedStars - memberStarUsed,
      requiredStars: topic.unlockCostStars
    };
  }

  let contentAvailable = false;

  try {
    contentAvailable = await hasPublishedTopicContent(topic);
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
  }

  if (!contentAvailable) {
    return {
      success: false,
      code: "TOPIC_CONTENT_UNAVAILABLE",
      message: "小专题内容尚未完整发布"
    };
  }

  const rawOutcome = await db.runTransaction(async (transaction) => {
    const sessionReference = transaction
      .collection("memberSessions")
      .doc(member.sessionId);
    const userReference = transaction.collection("users").doc(member.userId);
    const topicReference = transaction.collection("specialTopics").doc(topicId);
    const unlockReference = transaction
      .collection("specialTopicUnlocks")
      .doc(unlockId);
    const [session, user, currentTopicDocument, existingUnlock] =
      await Promise.all([
        readTransactionDocument(sessionReference),
        readTransactionDocument(userReference),
        readTransactionDocument(topicReference),
        readTransactionDocument(unlockReference)
      ]);

    if (
      !isActiveSession(session, openid) ||
      normalizeText(session.userId, 128) !== member.userId ||
      !isActiveUser(user, member.userId, openid)
    ) {
      return {
        success: false,
        code: "MEMBER_LOGIN_REQUIRED",
        message: "会员登录已失效，请重新登录"
      };
    }

    const currentTopic = normalizeTopic(currentTopicDocument);

    if (
      !currentTopic ||
      currentTopic.currentRevision !== topic.currentRevision ||
      currentTopic.unlockCostStars !== topic.unlockCostStars
    ) {
      return {
        success: false,
        code: "TOPIC_CHANGED_RETRY",
        message: "专题刚刚更新，请重试"
      };
    }

    const rawStarUsed = Number(user.starUsed || 0);

    if (existingUnlock) {
      if (
        existingUnlock.userId !== member.userId ||
        existingUnlock.topicId !== topicId ||
        existingUnlock.status !== "unlocked"
      ) {
        throw new Error("special topic unlock identity mismatch");
      }

      const hasSafeBalance =
        Number.isInteger(rawStarUsed) &&
        rawStarUsed >= 0 &&
        rawStarUsed <= earnedStars;

      return {
        success: true,
        firstUnlock: false,
        chargedStars: 0,
        starRemain: hasSafeBalance ? earnedStars - rawStarUsed : null
      };
    }

    if (
      !Number.isInteger(rawStarUsed) ||
      rawStarUsed < 0 ||
      rawStarUsed > earnedStars
    ) {
      return {
        success: false,
        code: "STAR_WALLET_INVALID",
        message: "红五星账户需要核对，暂时无法解锁"
      };
    }

    if (earnedStars - rawStarUsed < currentTopic.unlockCostStars) {
      return {
        success: false,
        code: "INSUFFICIENT_STARS",
        message: "红五星余额不足",
        starRemain: earnedStars - rawStarUsed,
        requiredStars: currentTopic.unlockCostStars
      };
    }

    const nextStarUsed = rawStarUsed + currentTopic.unlockCostStars;
    await userReference.update({
      data: {
        starUsed: nextStarUsed,
        updateTime: db.serverDate()
      }
    });
    await unlockReference.set({
      data: {
        openid,
        userId: member.userId,
        topicId,
        costStarsSnapshot: currentTopic.unlockCostStars,
        status: "unlocked",
        unlockedAt: db.serverDate(),
        schemaVersion: 1,
        createTime: db.serverDate()
      }
    });

    return {
      success: true,
      firstUnlock: true,
      chargedStars: currentTopic.unlockCostStars,
      starRemain: earnedStars - nextStarUsed
    };
  });
  const outcome = unwrapTransactionResult(rawOutcome);

  if (!outcome || !outcome.success) {
    return outcome || {
      success: false,
      code: "TOPIC_UNLOCK_FAILED",
      message: "小专题解锁失败"
    };
  }

  return {
    success: true,
    source: "cloud",
    topic: publicTopic,
    topicRevision: topic.currentRevision,
    entries: [],
    hasMore: true,
    nextCursor: { entryOffset: 0, blockOffset: 0 },
    firstUnlock: outcome.firstUnlock,
    chargedStars: outcome.chargedStars,
    starRemain: outcome.starRemain
  };
}

async function readTopicPage(openid, event) {
  const topicId = normalizeText(event.topicId, 64);
  const expectedRevision = normalizeText(event.expectedRevision, 128);

  if (!TOPIC_ID_PATTERN.test(topicId)) {
    return {
      success: false,
      code: "INVALID_TOPIC_ID",
      message: "专题编号无效"
    };
  }

  const member = await resolveActiveMember(openid);

  if (!member) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员"
    };
  }

  const unlockId = createUnlockId(member.userId, topicId);
  const [topicDocument, unlock] = await Promise.all([
    readDocument(db.collection("specialTopics").doc(topicId)),
    readDocument(db.collection("specialTopicUnlocks").doc(unlockId))
  ]);
  const topic = normalizeTopic(topicDocument);

  if (!topic || topic.id !== topicId) {
    return {
      success: false,
      code: "TOPIC_NOT_AVAILABLE",
      message: "小专题尚未开放"
    };
  }

  if (!expectedRevision || expectedRevision !== topic.currentRevision) {
    return {
      success: false,
      code: "TOPIC_CHANGED_RELOAD",
      message: "专题内容已更新，请重新打开"
    };
  }

  if (!unlock) {
    return {
      success: false,
      code: "TOPIC_UNLOCK_REQUIRED",
      message: "请先解锁当前小专题"
    };
  }

  if (
    unlock.userId !== member.userId ||
    unlock.topicId !== topicId ||
    unlock.status !== "unlocked"
  ) {
    throw new Error("special topic unlock identity mismatch");
  }

  const cursor = normalizeContentCursor(event.cursor);
  let page;

  try {
    page = await readTopicContentPage(topic, cursor);
  } catch (error) {
    if (isMissingError(error)) {
      page = { entries: [], hasMore: false, nextCursor: null };
    } else {
      throw error;
    }
  }

  if (
    page.entries.length === 0 &&
    !page.hasMore &&
    cursor.entryOffset === 0 &&
    cursor.blockOffset === 0
  ) {
    return {
      success: false,
      code: "TOPIC_CONTENT_UNAVAILABLE",
      message: "小专题内容尚未完整发布"
    };
  }

  return {
    success: true,
    source: "cloud",
    topicRevision: topic.currentRevision,
    entries: page.entries,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
  };
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);
    const action = normalizeText(event.action || "list", 20);

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    if (action === "list") {
      return await listTopics(openid, event);
    }

    if (action === "open") {
      return await openTopic(openid, event);
    }

    if (action === "readPage") {
      return await readTopicPage(openid, event);
    }

    return {
      success: false,
      code: "INVALID_ACTION",
      message: "不支持的专题操作"
    };
  } catch (error) {
    if (error && error.code) {
      return {
        success: false,
        code: error.code,
        message: error.message || "小专题服务暂不可用"
      };
    }

    console.error("specialTopicCenter error:", error);
    return {
      success: false,
      code: "SPECIAL_TOPIC_UNAVAILABLE",
      message: "小专题服务暂不可用"
    };
  }
};
