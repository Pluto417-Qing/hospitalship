const crypto = require("crypto");
const { LIBRARY_VERSION, TERM_GROUPS } = require("./moderation-terms");

const MAX_REMOTE_TERMS = 1000;
const SEPARATOR_PATTERN = /[\s\u200b\u200c\u200d\u2060\ufeff`~!@#$%^&*()_+\-=\[\]{};:'"\\|,.<>/?，。！？、；：“”‘’（）【】《》·…—]/g;

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(SEPARATOR_PATTERN, "");
}

function createEntry(term, category, action) {
  const original = String(term || "").trim();
  const normalized = normalizeForMatch(original);

  // The supplied library contains several single-character entries. Blind
  // substring matching for them would reject ordinary phrases such as “生日”.
  if (!original || Array.from(normalized).length < 2) {
    return null;
  }

  return {
    term: original,
    normalized,
    category: String(category || "自定义词库").trim() || "自定义词库",
    // 产品规则要求所有敏感词命中都保存为待人工复审；远端旧数据中
    // 即使仍带有 block，也只能降级为 review，不能直接拒绝少年读者。
    action: "review"
  };
}

function getBuiltInEntries() {
  return TERM_GROUPS.flatMap((group) =>
    group.terms
      .map((term) => createEntry(term, group.category, group.action))
      .filter(Boolean)
  );
}

async function getRemoteEntries(db) {
  try {
    const result = await db
      .collection("moderationTerms")
      .where({ status: "active" })
      .limit(MAX_REMOTE_TERMS)
      .get();

    return (result.data || [])
      .map((item) => createEntry(item.term, item.category, item.action))
      .filter(Boolean);
  } catch (error) {
    const code = String(error && (error.errCode || error.code || ""));
    const message = String(error && (error.errMsg || error.message || ""));
    const collectionMissing =
      code === "-502005" ||
      /COLLECTION.*NOT.*EXIST/i.test(code) ||
      /collection.*(?:not exist|does not exist)/i.test(message) ||
      /集合.*不存在/.test(message);

    if (collectionMissing) {
      return [];
    }

    throw error;
  }
}

function createLibraryVersion(remoteEntries) {
  if (!remoteEntries.length) {
    return LIBRARY_VERSION;
  }

  const snapshot = remoteEntries
    .map((entry) => [
      entry.normalized,
      entry.category,
      entry.action
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 12);

  return `${LIBRARY_VERSION}+remote-${digest}`;
}

function findMatch(normalizedComment, entries, action) {
  return entries
    .filter((entry) => entry.action === action)
    .sort((left, right) => right.normalized.length - left.normalized.length)
    .find((entry) => normalizedComment.includes(entry.normalized)) || null;
}

async function inspectComment(db, comment) {
  const normalizedComment = normalizeForMatch(comment);
  const remoteEntries = await getRemoteEntries(db);
  const entries = [...getBuiltInEntries(), ...remoteEntries];
  const libraryVersion = createLibraryVersion(remoteEntries);
  const review = findMatch(normalizedComment, entries, "review");

  return {
    allowed: true,
    decision: review ? "review" : "approved",
    requiresReview: Boolean(review),
    reviewRecommended: Boolean(review),
    reviewCategory: review ? review.category : "",
    version: libraryVersion
  };
}

module.exports = {
  inspectComment,
  normalizeForMatch
};
