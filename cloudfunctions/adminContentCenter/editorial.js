const crypto = require("crypto");

const EDITORIAL_SCHEMA_VERSION = 1;
const CHINA_TIME_OFFSET_MINUTES = 8 * 60;
const MIN_EVENT_YEAR = 2000;
const MAX_EVENT_YEAR = 2100;

const EDITORIAL_KINDS = Object.freeze({
  ZHI: "zhi",
  QUIZ: "quiz"
});

const EDITORIAL_COLLECTIONS = Object.freeze({
  [EDITORIAL_KINDS.ZHI]: "zhiEntries",
  [EDITORIAL_KINDS.QUIZ]: "quizQuestions"
});

const TARGET_ID_PATTERN = /^(?:zhi|quiz)-[a-f0-9]{28}$/;
const REVISION_PATTERN = /^r-[a-f0-9]{32}$/;
const SOURCE_DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Newlines and tabs are normal in message bodies, questions and explanations.
// Other C0/C1 controls are rejected before data reaches the database.
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const ZHI_LIMITS = Object.freeze({
  source: 120,
  label: 80,
  content: 2000
});

const QUIZ_LIMITS = Object.freeze({
  topic: 120,
  department: 160,
  source: 300,
  question: 3000,
  optionCountMinimum: 2,
  optionCountMaximum: 8,
  optionKey: 32,
  optionLabel: 40,
  optionText: 1000,
  correctFeedback: 500,
  wrongFeedback: 500,
  explanation: 5000,
  sortOrderMinimum: 0,
  sortOrderMaximum: 1000000
});

const ZHI_PAYLOAD_KEYS = new Set([
  "content",
  "eventAt",
  "label",
  "source"
]);
const QUIZ_PAYLOAD_KEYS = new Set([
  "correctFeedback",
  "correctKey",
  "department",
  "explanation",
  "options",
  "question",
  "sortOrder",
  "source",
  "topic",
  "wrongFeedback"
]);
const QUIZ_OPTION_KEYS = new Set(["key", "label", "text"]);
const DOCUMENT_CONTEXT_KEYS = new Set([
  "createdAt",
  "publishedAt",
  "revision",
  "revisionSeed",
  "sourceDraftId",
  "targetId",
  "targetSeed",
  "updatedAt"
]);

class EditorialValidationError extends Error {
  constructor(code, message, path = "", details = null) {
    super(message);
    this.name = "EditorialValidationError";
    this.code = code;
    if (path) {
      this.path = path;
    }
    if (details && typeof details === "object") {
      this.details = details;
    }
  }
}

function fail(code, message, path = "", details = null) {
  throw new EditorialValidationError(code, message, path, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) {
    fail(
      "EDITORIAL_INVALID_STRUCTURE",
      `${path} 必须是普通对象`,
      path
    );
  }
}

function assertAllowedKeys(value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(
        "EDITORIAL_UNKNOWN_FIELD",
        `${path} 包含不支持的字段：${key}`,
        `${path}.${key}`
      );
    }
  }
}

function normalizeText(
  value,
  path,
  maximum,
  { required = false, fallback = "" } = {}
) {
  if (value === undefined || value === null) {
    if (required && !fallback) {
      fail(
        "EDITORIAL_REQUIRED_FIELD",
        `${path} 不能为空`,
        path
      );
    }
    return fallback;
  }

  if (typeof value !== "string") {
    fail(
      "EDITORIAL_INVALID_TEXT",
      `${path} 必须是文字`,
      path
    );
  }

  let normalized;
  try {
    normalized = value
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .trim();
  } catch (error) {
    fail(
      "EDITORIAL_INVALID_TEXT",
      `${path} 包含无效文字`,
      path
    );
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    fail(
      "EDITORIAL_CONTROL_CHARACTER",
      `${path} 不能包含控制字符`,
      path
    );
  }

  if (!normalized && required) {
    fail(
      "EDITORIAL_REQUIRED_FIELD",
      `${path} 不能为空`,
      path
    );
  }

  if (normalized.length > maximum) {
    fail(
      "EDITORIAL_TEXT_TOO_LONG",
      `${path} 不能超过 ${maximum} 个字符`,
      path,
      { maximum, actual: normalized.length }
    );
  }

  return normalized || fallback;
}

function assertValidCalendarParts(year, month, day, hour, minute, second, path) {
  if (
    !Number.isInteger(year) ||
    year < MIN_EVENT_YEAR ||
    year > MAX_EVENT_YEAR ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    !Number.isInteger(second) ||
    second < 0 ||
    second > 59
  ) {
    fail(
      "EDITORIAL_INVALID_DATE",
      `${path} 不是有效日期`,
      path
    );
  }

  const verification = new Date(Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  ));

  if (
    verification.getUTCFullYear() !== year ||
    verification.getUTCMonth() !== month - 1 ||
    verification.getUTCDate() !== day ||
    verification.getUTCHours() !== hour ||
    verification.getUTCMinutes() !== minute ||
    verification.getUTCSeconds() !== second
  ) {
    fail(
      "EDITORIAL_INVALID_DATE",
      `${path} 不是有效日期`,
      path
    );
  }
}

function assertChinaYearRange(timestamp, path) {
  const chinaDate = new Date(
    timestamp + CHINA_TIME_OFFSET_MINUTES * 60 * 1000
  );
  const chinaYear = chinaDate.getUTCFullYear();

  if (chinaYear < MIN_EVENT_YEAR || chinaYear > MAX_EVENT_YEAR) {
    fail(
      "EDITORIAL_INVALID_DATE",
      `${path} 年份必须在 ${MIN_EVENT_YEAR} 至 ${MAX_EVENT_YEAR} 之间`,
      path
    );
  }
}

function parseStructuredDate(text, path) {
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))?)?$/
  );

  if (!match) {
    fail(
      "EDITORIAL_INVALID_DATE",
      `${path} 请使用 YYYY-MM-DD 或带时区的 ISO 日期时间`,
      path
    );
  }

  const hasTime = match[4] !== undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = hasTime ? Number(match[4]) : 0;
  const minute = hasTime ? Number(match[5]) : 0;
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined
    ? 0
    : Number(match[7].padEnd(3, "0"));

  assertValidCalendarParts(
    year,
    month,
    day,
    hour,
    minute,
    second,
    path
  );

  let offsetMinutes = CHINA_TIME_OFFSET_MINUTES;
  if (match[8] === "Z") {
    offsetMinutes = 0;
  } else if (match[9]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      fail(
        "EDITORIAL_INVALID_DATE",
        `${path} 的时区偏移无效`,
        path
      );
    }
    offsetMinutes =
      (match[9] === "-" ? -1 : 1) *
      (offsetHour * 60 + offsetMinute);
  }

  return Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  ) -
    offsetMinutes * 60 * 1000;
}

function normalizeDateValue(value, path, { chinaLocalStrings = false } = {}) {
  let timestamp = NaN;

  if (value instanceof Date) {
    timestamp = value.getTime();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    timestamp = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!text || CONTROL_CHARACTER_PATTERN.test(text)) {
      fail(
        "EDITORIAL_INVALID_DATE",
        `${path} 不是有效日期`,
        path
      );
    }

    if (chinaLocalStrings) {
      timestamp = parseStructuredDate(text, path);
    } else {
      const hasExplicitTimezone =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          text
        );
      if (!hasExplicitTimezone) {
        fail(
          "EDITORIAL_INVALID_DATE",
          `${path} 必须是带时区的 ISO 日期时间`,
          path
        );
      }
      timestamp = Date.parse(text);
    }
  }

  if (!Number.isFinite(timestamp)) {
    fail(
      "EDITORIAL_INVALID_DATE",
      `${path} 不是有效日期`,
      path
    );
  }

  assertChinaYearRange(timestamp, path);
  return new Date(timestamp);
}

function normalizeChinaEventAt(value, path = "payload.eventAt") {
  return normalizeDateValue(value, path, { chinaLocalStrings: true });
}

function normalizeOptionalInteger(
  value,
  path,
  fallback,
  minimum,
  maximum
) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(
      "EDITORIAL_INVALID_INTEGER",
      `${path} 必须是 ${minimum} 至 ${maximum} 之间的整数`,
      path,
      { minimum, maximum }
    );
  }

  return value;
}

function normalizeZhiPayload(rawPayload) {
  assertPlainObject(rawPayload, "payload");
  assertAllowedKeys(rawPayload, ZHI_PAYLOAD_KEYS, "payload");

  return {
    eventAt: normalizeChinaEventAt(rawPayload.eventAt),
    source: normalizeText(
      rawPayload.source,
      "payload.source",
      ZHI_LIMITS.source,
      { required: true }
    ),
    label: normalizeText(
      rawPayload.label,
      "payload.label",
      ZHI_LIMITS.label,
      { required: true }
    ),
    content: normalizeText(
      rawPayload.content,
      "payload.content",
      ZHI_LIMITS.content,
      { required: true }
    )
  };
}

function normalizeQuizOption(rawOption, index) {
  const path = `payload.options[${index}]`;
  assertPlainObject(rawOption, path);
  assertAllowedKeys(rawOption, QUIZ_OPTION_KEYS, path);

  const explicitKey = rawOption.key;
  const key = explicitKey === undefined || explicitKey === null || explicitKey === ""
    ? `option-${index + 1}`
    : normalizeText(
        explicitKey,
        `${path}.key`,
        QUIZ_LIMITS.optionKey,
        { required: true }
      );

  if (!OPTION_KEY_PATTERN.test(key)) {
    fail(
      "EDITORIAL_INVALID_OPTION_KEY",
      `${path}.key 只能由英文字母、数字、下划线或短横线组成，且必须以字母开头`,
      `${path}.key`
    );
  }

  return {
    key,
    label: normalizeText(
      rawOption.label,
      `${path}.label`,
      QUIZ_LIMITS.optionLabel,
      { fallback: `选项${index + 1}` }
    ),
    text: normalizeText(
      rawOption.text,
      `${path}.text`,
      QUIZ_LIMITS.optionText,
      { required: true }
    )
  };
}

function normalizeQuizOptions(rawOptions) {
  if (
    !Array.isArray(rawOptions) ||
    rawOptions.length < QUIZ_LIMITS.optionCountMinimum ||
    rawOptions.length > QUIZ_LIMITS.optionCountMaximum
  ) {
    fail(
      "EDITORIAL_INVALID_OPTIONS",
      `payload.options 必须包含 ${QUIZ_LIMITS.optionCountMinimum} 至 ${QUIZ_LIMITS.optionCountMaximum} 个选项`,
      "payload.options"
    );
  }

  const options = rawOptions.map(normalizeQuizOption);
  const keySet = new Set();
  const textSet = new Set();

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const comparableKey = option.key.toLowerCase();
    const comparableText = option.text.toLocaleLowerCase("zh-CN");

    if (keySet.has(comparableKey)) {
      fail(
        "EDITORIAL_DUPLICATE_OPTION_KEY",
        `payload.options[${index}].key 与其他选项重复`,
        `payload.options[${index}].key`
      );
    }
    if (textSet.has(comparableText)) {
      fail(
        "EDITORIAL_DUPLICATE_OPTION_TEXT",
        `payload.options[${index}].text 与其他选项重复`,
        `payload.options[${index}].text`
      );
    }

    keySet.add(comparableKey);
    textSet.add(comparableText);
  }

  return options;
}

function normalizeQuizPayload(rawPayload) {
  assertPlainObject(rawPayload, "payload");
  assertAllowedKeys(rawPayload, QUIZ_PAYLOAD_KEYS, "payload");

  const options = normalizeQuizOptions(rawPayload.options);
  const correctKey = normalizeText(
    rawPayload.correctKey,
    "payload.correctKey",
    QUIZ_LIMITS.optionKey,
    { required: true }
  );

  if (!OPTION_KEY_PATTERN.test(correctKey)) {
    fail(
      "EDITORIAL_INVALID_OPTION_KEY",
      "payload.correctKey 格式无效",
      "payload.correctKey"
    );
  }

  const matchingOption = options.find(
    (option) => option.key.toLowerCase() === correctKey.toLowerCase()
  );
  if (!matchingOption) {
    fail(
      "EDITORIAL_CORRECT_KEY_NOT_FOUND",
      "正确答案必须对应现有选项",
      "payload.correctKey"
    );
  }

  return {
    topic: normalizeText(
      rawPayload.topic,
      "payload.topic",
      QUIZ_LIMITS.topic
    ),
    department: normalizeText(
      rawPayload.department,
      "payload.department",
      QUIZ_LIMITS.department
    ),
    source: normalizeText(
      rawPayload.source,
      "payload.source",
      QUIZ_LIMITS.source
    ),
    question: normalizeText(
      rawPayload.question,
      "payload.question",
      QUIZ_LIMITS.question,
      { required: true }
    ),
    options,
    correctKey: matchingOption.key,
    correctFeedback: normalizeText(
      rawPayload.correctFeedback,
      "payload.correctFeedback",
      QUIZ_LIMITS.correctFeedback
    ),
    wrongFeedback: normalizeText(
      rawPayload.wrongFeedback,
      "payload.wrongFeedback",
      QUIZ_LIMITS.wrongFeedback
    ),
    explanation: normalizeText(
      rawPayload.explanation,
      "payload.explanation",
      QUIZ_LIMITS.explanation
    ),
    sortOrder: normalizeOptionalInteger(
      rawPayload.sortOrder,
      "payload.sortOrder",
      0,
      QUIZ_LIMITS.sortOrderMinimum,
      QUIZ_LIMITS.sortOrderMaximum
    )
  };
}

function assertEditorialKind(kind) {
  if (!Object.values(EDITORIAL_KINDS).includes(kind)) {
    fail(
      "EDITORIAL_INVALID_KIND",
      "内容类型必须是 zhi 或 quiz",
      "kind"
    );
  }
}

function normalizeEditorialPayload(kind, rawPayload) {
  assertEditorialKind(kind);
  return kind === EDITORIAL_KINDS.ZHI
    ? normalizeZhiPayload(rawPayload)
    : normalizeQuizPayload(rawPayload);
}

function canonicalize(value, seen = new Set()) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      fail(
        "EDITORIAL_CANONICAL_VALUE_INVALID",
        "不能计算无效日期的摘要",
        "value"
      );
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      fail(
        "EDITORIAL_CANONICAL_VALUE_INVALID",
        "不能计算循环结构的摘要",
        "value"
      );
    }
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      fail(
        "EDITORIAL_CANONICAL_VALUE_INVALID",
        "不能计算循环结构的摘要",
        "value"
      );
    }
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        result[key] = canonicalize(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  fail(
    "EDITORIAL_CANONICAL_VALUE_INVALID",
    "内容中存在无法计算摘要的值",
    "value"
  );
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

function createEditorialTargetId(kind, seed) {
  assertEditorialKind(kind);
  if (seed === undefined) {
    fail(
      "EDITORIAL_TARGET_SEED_REQUIRED",
      "生成内容编号时必须提供稳定种子",
      "seed"
    );
  }

  return `${kind}-${canonicalHash([
    "editorial-target",
    EDITORIAL_SCHEMA_VERSION,
    kind,
    seed
  ]).slice(0, 28)}`;
}

function createEditorialRevision(kind, targetId, normalizedPayload, seed = "") {
  assertEditorialKind(kind);
  if (!TARGET_ID_PATTERN.test(targetId) || !targetId.startsWith(`${kind}-`)) {
    fail(
      "EDITORIAL_INVALID_TARGET_ID",
      "内容编号格式无效",
      "targetId"
    );
  }

  return `r-${canonicalHash([
    "editorial-revision",
    EDITORIAL_SCHEMA_VERSION,
    kind,
    targetId,
    normalizedPayload,
    seed
  ]).slice(0, 32)}`;
}

function normalizeDocumentContext(context) {
  if (context === undefined) {
    return {};
  }
  assertPlainObject(context, "context");
  assertAllowedKeys(context, DOCUMENT_CONTEXT_KEYS, "context");
  return context;
}

function resolveDocumentIdentity(kind, normalizedPayload, rawContext) {
  const context = normalizeDocumentContext(rawContext);
  let targetId = "";

  if (context.targetId !== undefined) {
    targetId = normalizeText(
      context.targetId,
      "context.targetId",
      64,
      { required: true }
    ).toLowerCase();
    if (
      !TARGET_ID_PATTERN.test(targetId) ||
      !targetId.startsWith(`${kind}-`)
    ) {
      fail(
        "EDITORIAL_INVALID_TARGET_ID",
        "context.targetId 格式无效",
        "context.targetId"
      );
    }
  } else {
    targetId = createEditorialTargetId(
      kind,
      context.targetSeed === undefined
        ? normalizedPayload
        : context.targetSeed
    );
  }

  let revision = "";
  if (context.revision !== undefined) {
    revision = normalizeText(
      context.revision,
      "context.revision",
      64,
      { required: true }
    ).toLowerCase();
    if (!REVISION_PATTERN.test(revision)) {
      fail(
        "EDITORIAL_INVALID_REVISION",
        "context.revision 格式无效",
        "context.revision"
      );
    }
  } else {
    revision = createEditorialRevision(
      kind,
      targetId,
      normalizedPayload,
      context.revisionSeed === undefined ? "" : context.revisionSeed
    );
  }

  return { context, targetId, revision };
}

function normalizeOptionalTimestamp(value, path) {
  return value === undefined
    ? null
    : normalizeDateValue(value, path, { chinaLocalStrings: false });
}

function buildBaseDocument(kind, normalizedPayload, rawContext, status) {
  const { context, targetId, revision } = resolveDocumentIdentity(
    kind,
    normalizedPayload,
    rawContext
  );
  const payloadHash = canonicalHash(normalizedPayload);
  const document = {
    _id: targetId,
    revision,
    status,
    schemaVersion: EDITORIAL_SCHEMA_VERSION,
    payloadHash,
    ...normalizedPayload
  };

  if (kind === EDITORIAL_KINDS.ZHI) {
    document.entryId = targetId;
  } else {
    document.questionId = targetId;
  }

  const createdAt = normalizeOptionalTimestamp(
    context.createdAt,
    "context.createdAt"
  );
  const updatedAt = normalizeOptionalTimestamp(
    context.updatedAt,
    "context.updatedAt"
  );
  if (createdAt) {
    document.createdAt = createdAt;
  }
  if (updatedAt) {
    document.updatedAt = updatedAt;
  }

  if (context.sourceDraftId !== undefined) {
    const sourceDraftId = normalizeText(
      context.sourceDraftId,
      "context.sourceDraftId",
      128,
      { required: true }
    );
    if (!SOURCE_DRAFT_ID_PATTERN.test(sourceDraftId)) {
      fail(
        "EDITORIAL_INVALID_SOURCE_DRAFT_ID",
        "context.sourceDraftId 格式无效",
        "context.sourceDraftId"
      );
    }
    document.sourceDraftId = sourceDraftId;
  }

  return document;
}

function buildEditorialDraftDocument(kind, rawPayload, context = {}) {
  const normalizedPayload = normalizeEditorialPayload(kind, rawPayload);
  return buildBaseDocument(
    kind,
    normalizedPayload,
    context,
    "draft"
  );
}

function buildEditorialPublishedDocument(kind, rawPayload, context = {}) {
  const normalizedPayload = normalizeEditorialPayload(kind, rawPayload);
  const normalizedContext = normalizeDocumentContext(context);
  if (normalizedContext.publishedAt === undefined) {
    fail(
      "EDITORIAL_PUBLISHED_AT_REQUIRED",
      "发布文档必须提供 context.publishedAt",
      "context.publishedAt"
    );
  }

  const document = buildBaseDocument(
    kind,
    normalizedPayload,
    normalizedContext,
    "published"
  );
  document.publishedAt = normalizeDateValue(
    normalizedContext.publishedAt,
    "context.publishedAt",
    { chinaLocalStrings: false }
  );
  return document;
}

function buildEditorialBundle(kind, rawPayload, context = {}) {
  const normalizedPayload = normalizeEditorialPayload(kind, rawPayload);
  const identity = resolveDocumentIdentity(kind, normalizedPayload, context);
  const fixedContext = {
    ...identity.context,
    targetId: identity.targetId,
    revision: identity.revision
  };

  return {
    kind,
    collection: EDITORIAL_COLLECTIONS[kind],
    targetId: identity.targetId,
    revision: identity.revision,
    payloadHash: canonicalHash(normalizedPayload),
    payload: normalizedPayload,
    draftDocument: buildBaseDocument(
      kind,
      normalizedPayload,
      fixedContext,
      "draft"
    ),
    publishedDocument:
      identity.context.publishedAt === undefined
        ? null
        : buildEditorialPublishedDocument(kind, normalizedPayload, fixedContext)
  };
}

function buildZhiDraftDocument(rawPayload, context = {}) {
  return buildEditorialDraftDocument(EDITORIAL_KINDS.ZHI, rawPayload, context);
}

function buildZhiPublishedDocument(rawPayload, context = {}) {
  return buildEditorialPublishedDocument(
    EDITORIAL_KINDS.ZHI,
    rawPayload,
    context
  );
}

function buildQuizDraftDocument(rawPayload, context = {}) {
  return buildEditorialDraftDocument(EDITORIAL_KINDS.QUIZ, rawPayload, context);
}

function buildQuizPublishedDocument(rawPayload, context = {}) {
  return buildEditorialPublishedDocument(
    EDITORIAL_KINDS.QUIZ,
    rawPayload,
    context
  );
}

module.exports = {
  CHINA_TIME_OFFSET_MINUTES,
  CONTROL_CHARACTER_PATTERN,
  DOCUMENT_CONTEXT_KEYS,
  EDITORIAL_COLLECTIONS,
  EDITORIAL_KINDS,
  EDITORIAL_SCHEMA_VERSION,
  EditorialValidationError,
  MAX_EVENT_YEAR,
  MIN_EVENT_YEAR,
  OPTION_KEY_PATTERN,
  QUIZ_LIMITS,
  REVISION_PATTERN,
  SOURCE_DRAFT_ID_PATTERN,
  TARGET_ID_PATTERN,
  ZHI_LIMITS,
  buildEditorialBundle,
  buildEditorialDraftDocument,
  buildEditorialPublishedDocument,
  buildQuizDraftDocument,
  buildQuizPublishedDocument,
  buildZhiDraftDocument,
  buildZhiPublishedDocument,
  canonicalHash,
  canonicalStringify,
  canonicalize,
  createEditorialRevision,
  createEditorialTargetId,
  normalizeChinaEventAt,
  normalizeEditorialPayload,
  normalizeQuizPayload,
  normalizeZhiPayload,
  resolveDocumentIdentity
};
