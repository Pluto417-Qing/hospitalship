const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 10;
const MAX_OFFSET = 10000;
const MAX_CHAPTER_SECTIONS = 40;
const MAX_SECTION_PARAGRAPHS = 100;
const MAX_PARAGRAPH_CHARACTERS = 10000;
const MAX_CHAPTER_CHARACTERS = 120000;

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, number));
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

function createEntitlementId(userId, bookId) {
  return createDeterministicId("book-entitlement", [userId, bookId]);
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

async function getDocumentOrNull(collectionName, documentId) {
  try {
    const result = await db.collection(collectionName).doc(documentId).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFound(error)) {
      return null;
    }

    throw error;
  }
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

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

async function resolveMember(openid) {
  const sessionId = createSessionId(openid);
  const session = await getDocumentOrNull("memberSessions", sessionId);

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

  const expiresAt = getTimeValue(session.expiresAt);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return {
      success: false,
      code: "MEMBER_SESSION_EXPIRED",
      message: "会员登录已过期，请重新登录"
    };
  }

  const userId = normalizeText(session.userId, 128);
  const user = await getDocumentOrNull("users", userId);

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

  return {
    success: true,
    userId,
    memberId: normalizeText(session.memberId || user.memberId, 128)
  };
}

function normalizeSections(value) {
  if (!Array.isArray(value) || value.length > MAX_CHAPTER_SECTIONS) {
    return null;
  }

  const sections = [];
  let totalCharacters = 0;

  for (const source of value) {
    const rawParagraphs = Array.isArray(source && source.paragraphs)
      ? source.paragraphs
      : [];

    if (rawParagraphs.length > MAX_SECTION_PARAGRAPHS) {
      return null;
    }

    const heading = normalizeText(source && source.heading, 160);
    const paragraphs = [];
    totalCharacters += heading.length;

    for (const rawParagraph of rawParagraphs) {
      if (typeof rawParagraph !== "string") {
        return null;
      }

      const paragraph = rawParagraph.trim();

      if (paragraph.length > MAX_PARAGRAPH_CHARACTERS) {
        return null;
      }

      if (paragraph) {
        paragraphs.push(paragraph);
        totalCharacters += paragraph.length;
      }

      if (totalCharacters > MAX_CHAPTER_CHARACTERS) {
        return null;
      }
    }

    if (heading || paragraphs.length > 0) {
      sections.push({ heading, paragraphs });
    }
  }

  return sections.length > 0 ? sections : null;
}

function normalizeChapter(document, bookId, bookRevision) {
  const id = normalizeText(document && document._id, 128);
  const title = normalizeText(document && document.title, 160);
  const sections = normalizeSections(document && document.sections);

  if (
    !id ||
    !title ||
    normalizeText(document && document.bookId, 64) !== bookId ||
    normalizeText(document && document.bookRevision, 128) !== bookRevision ||
    document.status !== "published" ||
    !sections
  ) {
    const error = new Error("book chapter schema mismatch");
    error.code = "BOOK_SCHEMA_INVALID";
    throw error;
  }

  return {
    id,
    title,
    sortOrder: Number.isFinite(Number(document.sortOrder))
      ? Number(document.sortOrder)
      : 0,
    sections
  };
}

function normalizeProtectedPdf(book) {
  const source = book && book.pdf && typeof book.pdf === "object"
    ? book.pdf
    : {};
  const fileID = normalizeText(source.fileID || book.pdfFileID, 1024);
  const mimeType = normalizeText(source.mimeType || "application/pdf", 80)
    .toLowerCase();

  if (
    !fileID.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(fileID) ||
    fileID.includes("..") ||
    mimeType !== "application/pdf"
  ) {
    return {
      available: false,
      sourceFileID: "",
      fileName: "",
      mimeType: "application/pdf",
      code: "PDF_NOT_AVAILABLE"
    };
  }

  const separator = fileID.indexOf("/", "cloud://".length);
  const cloudPath = separator >= 0 ? fileID.slice(separator + 1) : "";

  if (
    !cloudPath.startsWith("protected/books/") ||
    cloudPath.length <= "protected/books/".length
  ) {
    return {
      available: false,
      sourceFileID: "",
      fileName: "",
      mimeType: "application/pdf",
      code: "PDF_NOT_AVAILABLE"
    };
  }

  return {
    available: true,
    sourceFileID: fileID,
    fileName: normalizeText(source.fileName, 180) || `${book.title}.pdf`,
    mimeType
  };
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

async function createPdfDelivery(book) {
  const pdf = normalizeProtectedPdf(book);

  if (!pdf.available) {
    return {
      available: false,
      downloadReady: false,
      code: "PDF_NOT_AVAILABLE",
      message: "本书PDF尚未发布"
    };
  }

  if (typeof cloud.getTempFileURL !== "function") {
    return {
      available: true,
      downloadReady: false,
      code: "PDF_DELIVERY_NOT_CONFIGURED",
      message: "PDF安全下载服务尚未配置",
      fileName: pdf.fileName,
      mimeType: pdf.mimeType
    };
  }

  try {
    const result = await cloud.getTempFileURL({
      fileList: [pdf.sourceFileID]
    });
    const file = result && Array.isArray(result.fileList)
      ? result.fileList[0]
      : null;
    const downloadUrl = normalizeText(file && file.tempFileURL, 4096);

    if (
      !file ||
      normalizeText(file.fileID, 1024) !== pdf.sourceFileID ||
      (file.status !== undefined && Number(file.status) !== 0) ||
      !isSafeTemporaryURL(downloadUrl)
    ) {
      throw new Error("temporary PDF URL was not issued");
    }

    return {
      available: true,
      downloadReady: true,
      code: "PDF_READY",
      downloadUrl,
      fileName: pdf.fileName,
      mimeType: pdf.mimeType
    };
  } catch (error) {
    console.error("getFullBookAccess PDF delivery error:", error);
    return {
      available: true,
      downloadReady: false,
      code: "PDF_DELIVERY_FAILED",
      message: "PDF安全下载服务暂不可用",
      fileName: pdf.fileName,
      mimeType: pdf.mimeType
    };
  }
}

async function readChapters(bookId, revision, offset, limit) {
  const result = await db
    .collection("bookChapters")
    .where({
      bookId,
      bookRevision: revision,
      status: "published"
    })
    .orderBy("sortOrder", "asc")
    .orderBy("_id", "asc")
    .skip(offset)
    .limit(limit + 1)
    .get();

  if (!result || !Array.isArray(result.data)) {
    throw new Error("bookChapters returned an invalid result");
  }

  return {
    hasMore: result.data.length > limit,
    chapters: result.data
      .slice(0, limit)
      .map((item) => normalizeChapter(item, bookId, revision))
  };
}

exports.main = async (event = {}) => {
  const bookId = normalizeText(event.bookId, 64);
  const offset = normalizeInteger(event.offset, 0, 0, MAX_OFFSET);
  const limit = normalizeInteger(
    event.limit,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );

  if (!STABLE_ID_PATTERN.test(bookId)) {
    return {
      success: false,
      code: "INVALID_BOOK_ID",
      message: "书稿编号无效"
    };
  }

  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);

    if (!openid) {
      return {
        success: false,
        code: "OPENID_UNAVAILABLE",
        message: "无法识别当前微信用户"
      };
    }

    const member = await resolveMember(openid);

    if (!member.success) {
      return member;
    }

    const entitlementId = createEntitlementId(member.userId, bookId);
    const entitlement = await getDocumentOrNull(
      "bookEntitlements",
      entitlementId
    );

    if (
      !entitlement ||
      entitlement.status !== "active" ||
      normalizeText(entitlement.userId, 128) !== member.userId ||
      normalizeText(entitlement.bookId, 64) !== bookId
    ) {
      return {
        success: false,
        code: "BOOK_ACCESS_LOCKED",
        message: "完成本书任一篇读后感并通过审核后，即可阅读全本"
      };
    }

    const book = await getDocumentOrNull("books", bookId);
    const revision = normalizeText(book && book.currentRevision, 128);

    if (
      !book ||
      normalizeText(book._id, 64) !== bookId ||
      normalizeText(book.bookId, 64) !== bookId ||
      book.status !== "published" ||
      !normalizeText(book.title, 160) ||
      !revision
    ) {
      return {
        success: false,
        code: "BOOK_NOT_AVAILABLE",
        message: "完整书稿尚未发布"
      };
    }

    const page = await readChapters(bookId, revision, offset, limit);
    const nextOffset = page.hasMore ? offset + page.chapters.length : null;
    const pdf = await createPdfDelivery(book);

    return {
      success: true,
      access: "unlocked",
      book: {
        id: bookId,
        title: normalizeText(book.title, 160),
        subtitle: normalizeText(book.subtitle, 240),
        currentRevision: revision,
        chapters: page.chapters,
        pdf
      },
      offset,
      limit,
      hasMore: nextOffset !== null,
      nextOffset
    };
  } catch (error) {
    console.error("getFullBookAccess error:", error);

    return {
      success: false,
      code: error && error.code === "BOOK_SCHEMA_INVALID"
        ? "BOOK_SCHEMA_INVALID"
        : "BOOK_READ_FAILED",
      message: "完整书稿读取失败"
    };
  }
};
