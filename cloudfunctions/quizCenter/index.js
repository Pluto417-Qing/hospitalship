const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const QUESTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const OPTION_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八"];
const ATTEMPT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{7,127}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createMemberSessionId(openid) {
  return sha256(JSON.stringify(["member-session", openid])).slice(0, 32);
}

function createAttemptDocumentId(userId, clientAttemptId) {
  return sha256(
    JSON.stringify(["quiz-attempt", userId, clientAttemptId])
  ).slice(0, 32);
}

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
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

  return isActiveUser(user, userId, openid)
    ? { sessionId, userId, user }
    : null;
}

function normalizeOptions(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    return [];
  }

  const seen = new Set();
  const options = [];

  for (const source of value) {
    const key = normalizeText(source && source.key, 32);
    const text = normalizeText(source && source.text, 1000);

    if (!key || !text || seen.has(key)) {
      return [];
    }

    seen.add(key);
    options.push({
      key,
      label: normalizeText(source.label, 40) ||
        `选择${OPTION_LABELS[options.length] || options.length + 1}`,
      text
    });
  }

  return options;
}

function normalizeQuestion(document, includeAnswer = false) {
  if (!document || document.status !== "published") {
    return null;
  }

  const id = normalizeText(document._id, 64);
  const questionId = normalizeText(document.questionId || id, 64);
  const revision = normalizeText(document.revision, 128);
  const question = normalizeText(document.question, 3000);
  const options = normalizeOptions(document.options);
  const correctKey = normalizeText(document.correctKey, 32);

  if (
    !QUESTION_ID_PATTERN.test(id) ||
    questionId !== id ||
    !revision ||
    !question ||
    options.length < 2 ||
    !options.some((option) => option.key === correctKey)
  ) {
    return null;
  }

  const safe = {
    id,
    revision,
    topic: normalizeText(document.topic, 120),
    department: normalizeText(document.department, 160),
    source: normalizeText(document.source, 300),
    question,
    options,
    correctFeedback: normalizeText(document.correctFeedback, 500),
    wrongFeedback: normalizeText(document.wrongFeedback, 500),
    explanation: normalizeText(document.explanation, 5000),
    sortOrder: Number.isFinite(Number(document.sortOrder))
      ? Number(document.sortOrder)
      : 0
  };

  if (includeAnswer) {
    safe.correctKey = correctKey;
  }

  return safe;
}

function normalizeLimit(value) {
  const number = Number(value);
  return Number.isInteger(number)
    ? Math.min(MAX_LIMIT, Math.max(1, number))
    : DEFAULT_LIMIT;
}

async function listQuestions(event) {
  const limit = normalizeLimit(event.limit);

  try {
    const result = await db
      .collection("quizQuestions")
      .where({ status: "published" })
      .orderBy("publishedAt", "desc")
      .orderBy("_id", "desc")
      .limit(limit)
      .get();
    const questions = (result.data || [])
      .map((question) => normalizeQuestion(question, false))
      .filter(Boolean);

    return {
      success: true,
      source: "cloud",
      questions
    };
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }

    return {
      success: true,
      source: "cloud",
      questions: []
    };
  }
}

async function loadQuestionForAttempt(questionId) {
  try {
    const result = await db
      .collection("quizQuestions")
      .where({
        _id: questionId,
        status: "published"
      })
      .limit(1)
      .get();
    const question = normalizeQuestion(result.data && result.data[0], true);
    return question ? { question, source: "cloud" } : null;
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }

    return null;
  }
}

async function submitAttempt(openid, event) {
  const questionId = normalizeText(event.questionId, 64);
  const revision = normalizeText(event.revision, 128);
  const selectedKey = normalizeText(event.selectedKey, 32);
  const clientAttemptId = normalizeText(event.attemptId, 128);

  if (
    !QUESTION_ID_PATTERN.test(questionId) ||
    !revision ||
    !selectedKey ||
    !ATTEMPT_ID_PATTERN.test(clientAttemptId)
  ) {
    return {
      success: false,
      code: "INVALID_ATTEMPT",
      message: "答题记录参数无效"
    };
  }

  const member = await resolveActiveMember(openid);

  if (!member) {
    return {
      success: false,
      code: "MEMBER_LOGIN_REQUIRED",
      message: "请先登录少年会员再作答"
    };
  }

  const loaded = await loadQuestionForAttempt(questionId);

  if (!loaded) {
    return {
      success: false,
      code: "QUESTION_NOT_AVAILABLE",
      message: "题目不存在或尚未开放"
    };
  }

  const { question, source } = loaded;

  if (question.revision !== revision) {
    return {
      success: false,
      code: "QUESTION_REVISION_CHANGED",
      message: "题目已更新，请刷新后再作答"
    };
  }

  if (!question.options.some((option) => option.key === selectedKey)) {
    return {
      success: false,
      code: "INVALID_OPTION",
      message: "答案选项无效"
    };
  }

  const isCorrect = selectedKey === question.correctKey;
  const attemptDocumentId = createAttemptDocumentId(
    member.userId,
    clientAttemptId
  );
  const rawOutcome = await db.runTransaction(async (transaction) => {
    const sessionReference = transaction
      .collection("memberSessions")
      .doc(member.sessionId);
    const userReference = transaction.collection("users").doc(member.userId);
    const attemptReference = transaction
      .collection("quizAttempts")
      .doc(attemptDocumentId);
    const session = await readTransactionDocument(sessionReference);
    const user = await readTransactionDocument(userReference);
    const existingAttempt = await readTransactionDocument(attemptReference);
    const transactionQuestionDocument = source === "cloud"
      ? await readTransactionDocument(
          transaction.collection("quizQuestions").doc(questionId)
        )
      : null;

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

    if (source === "cloud") {
      const transactionQuestion = normalizeQuestion(
        transactionQuestionDocument,
        true
      );

      if (
        !transactionQuestion ||
        transactionQuestion.revision !== revision ||
        transactionQuestion.correctKey !== question.correctKey
      ) {
        return {
          success: false,
          code: "QUESTION_REVISION_CHANGED",
          message: "题目已更新，请刷新后再作答"
        };
      }
    }

    if (existingAttempt) {
      if (
        existingAttempt.userId !== member.userId ||
        existingAttempt.clientAttemptId !== clientAttemptId ||
        existingAttempt.questionId !== questionId ||
        existingAttempt.questionRevision !== revision ||
        existingAttempt.selectedKey !== selectedKey ||
        Boolean(existingAttempt.isCorrect) !== isCorrect
      ) {
        throw new Error("quiz attempt identity mismatch");
      }

      return {
        success: true,
        duplicate: true,
        answeredAt: existingAttempt.answeredAt || null
      };
    }

    await attemptReference.set({
      data: {
        openid,
        userId: member.userId,
        memberId: normalizeText(user.memberId, 128),
        clientAttemptId,
        questionId,
        questionRevision: revision,
        selectedKey,
        isCorrect,
        source,
        answeredAt: db.serverDate(),
        schemaVersion: 1,
        createTime: db.serverDate()
      }
    });

    return {
      success: true,
      duplicate: false,
      answeredAt: null
    };
  });
  const outcome = unwrapTransactionResult(rawOutcome);

  if (!outcome || !outcome.success) {
    return outcome || {
      success: false,
      code: "ATTEMPT_SAVE_FAILED",
      message: "答题记录保存失败"
    };
  }

  return {
    success: true,
    attempt: {
      id: attemptDocumentId,
      questionId,
      revision,
      selectedKey,
      isCorrect,
      duplicate: Boolean(outcome.duplicate),
      answeredAt: outcome.answeredAt || null
    },
    feedback: isCorrect ? question.correctFeedback : question.wrongFeedback,
    explanation: question.explanation
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
      return await listQuestions(event);
    }

    if (action === "submitAttempt") {
      return await submitAttempt(openid, event);
    }

    return {
      success: false,
      code: "INVALID_ACTION",
      message: "不支持的答题操作"
    };
  } catch (error) {
    console.error("quizCenter error:", error);
    return {
      success: false,
      code: "QUIZ_SERVICE_UNAVAILABLE",
      message: "答题服务暂不可用",
      cause: String(error && (error.errMsg || error.message || error.code) || error || "unknown").slice(0, 300)
    };
  }
};
