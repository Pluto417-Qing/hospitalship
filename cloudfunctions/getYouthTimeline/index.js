const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CHINA_TIME_OFFSET = 8 * 60 * 60 * 1000;

function parseDateFilter(event) {
  const yearText = String(event.year || "").trim();
  const monthText = String(event.month || "").trim();

  if (!/^\d{4}$/.test(yearText)) {
    return null;
  }

  const year = Number(yearText);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return null;
  }

  if (monthText && !/^(?:0?[1-9]|1[0-2])$/.test(monthText)) {
    return null;
  }

  return {
    year,
    month: monthText ? Number(monthText) : 0
  };
}

function createChinaDateRange(year, month) {
  const startMonth = month ? month - 1 : 0;
  const endYear = month === 12 || !month ? year + 1 : year;
  const endMonth = month === 12 || !month ? 0 : month;

  return {
    start: new Date(Date.UTC(year, startMonth, 1) - CHINA_TIME_OFFSET),
    end: new Date(Date.UTC(endYear, endMonth, 1) - CHINA_TIME_OFFSET)
  };
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

function toChinaDateParts(timestamp) {
  const date = new Date(timestamp + CHINA_TIME_OFFSET);

  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0")
  };
}

function normalizeBoundedText(value, fallback, maximum) {
  const normalized = typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
  const text = normalized || fallback;

  if (
    !text ||
    text.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)
  ) {
    return "";
  }

  return text;
}

function normalizeEntry(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const eventAtMs = toTimestamp(item.eventAt);
  const id = normalizeBoundedText(item._id, "", 128);
  const source = normalizeBoundedText(
    item.source,
    "中国医院船科普栏目",
    120
  );
  const label = normalizeBoundedText(item.label, "正式消息", 80);
  const content = normalizeBoundedText(item.content, "", 2000);

  if (!eventAtMs || !id || !source || !label || !content) {
    return null;
  }

  return {
    id,
    ...toChinaDateParts(eventAtMs),
    source,
    label,
    content,
    eventAtMs
  };
}

function isMissingCollectionError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502005" ||
    /COLLECTION.*NOT.*EXIST/i.test(code) ||
    /collection.*(?:not exist|does not exist)/i.test(message) ||
    /集合.*不存在/.test(message)
  );
}

exports.main = async (event = {}) => {
  const dateFilter = parseDateFilter(event);

  if (!dateFilter) {
    return {
      success: false,
      code: "INVALID_DATE",
      message: "年份或月份不正确"
    };
  }

  const limitValue = Number(event.limit);
  const limit = Number.isInteger(limitValue)
    ? Math.min(50, Math.max(1, limitValue))
    : 50;
  const offsetValue = Number(event.offset);
  const offset = Number.isInteger(offsetValue)
    ? Math.min(10000, Math.max(0, offsetValue))
    : 0;
  const { start, end } = createChinaDateRange(
    dateFilter.year,
    dateFilter.month
  );
  const command = db.command;

  try {
    const result = await db
      .collection("zhiEntries")
      .where({
        status: "published",
        eventAt: command.gte(start).and(command.lt(end))
      })
      .orderBy("eventAt", "desc")
      .orderBy("_id", "desc")
      .skip(offset)
      .limit(limit + 1)
      .get();
    const hasMore = result.data.length > limit;
    const entries = result.data
      .slice(0, limit)
      .map(normalizeEntry)
      .filter(Boolean);
    const candidateNextOffset = offset + limit;
    const nextOffset =
      hasMore && candidateNextOffset > offset && candidateNextOffset <= 10000
        ? candidateNextOffset
        : null;

    return {
      success: true,
      source: "cloud",
      entries,
      hasMore: nextOffset !== null,
      nextOffset
    };
  } catch (error) {
    if (isMissingCollectionError(error)) {
      return {
        success: true,
        source: "unavailable",
        entries: [],
        hasMore: false,
        nextOffset: null
      };
    }

    console.error("getYouthTimeline error:", error);

    return {
      success: false,
      message: "少年志消息读取失败"
    };
  }
};
