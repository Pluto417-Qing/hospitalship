const assert = require("assert");

const {
  EDITORIAL_COLLECTIONS,
  EDITORIAL_KINDS,
  EditorialValidationError,
  OPTION_KEY_PATTERN,
  QUIZ_LIMITS,
  REVISION_PATTERN,
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
  createEditorialRevision,
  createEditorialTargetId,
  normalizeChinaEventAt,
  normalizeEditorialPayload,
  normalizeQuizPayload,
  normalizeZhiPayload,
  resolveDocumentIdentity
} = require("./cloudfunctions/adminContentCenter/editorial");

function validZhi(overrides = {}) {
  return {
    eventAt: "2026-07-30",
    source: "中国医院船科普栏目",
    label: "医院船消息",
    content: "一条面向少年会员的正式消息。",
    ...overrides
  };
}

function validQuiz(overrides = {}) {
  return {
    topic: "食管癌的故事",
    department: "胸外科",
    source: "书稿第一章",
    question: "下列哪一项属于典型症状？",
    options: [
      {
        key: "one",
        label: "选择一",
        text: "进行性加重的吞咽梗阻感"
      },
      {
        key: "two",
        label: "选择二",
        text: "长期高温饮食"
      }
    ],
    correctKey: "one",
    correctFeedback: "回答正确。",
    wrongFeedback: "再想一想。",
    explanation: "进行性吞咽梗阻是典型症状。",
    sortOrder: 10,
    ...overrides
  };
}

function expectEditorialError(fn, code, path = "") {
  assert.throws(
    fn,
    (error) => {
      assert(error instanceof EditorialValidationError);
      assert.strictEqual(error.code, code);
      if (path) {
        assert.strictEqual(error.path, path);
      }
      return true;
    }
  );
}

function testChinaDatesAndZhiNormalization() {
  const normalized = normalizeZhiPayload(validZhi({
    source: "  中国医院船科普栏目  ",
    content: "  正式消息  "
  }));

  assert.strictEqual(
    normalized.eventAt.toISOString(),
    "2026-07-29T16:00:00.000Z"
  );
  assert.strictEqual(normalized.source, "中国医院船科普栏目");
  assert.strictEqual(normalized.content, "正式消息");
  assert.strictEqual(
    normalizeChinaEventAt("2026-07-30 08:15:30").toISOString(),
    "2026-07-30T00:15:30.000Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt("2026-07-30T08:15").toISOString(),
    "2026-07-30T00:15:00.000Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt("2026-07-30T00:15:30Z").toISOString(),
    "2026-07-30T00:15:30.000Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt("2026-07-30T00:15:30.125Z").toISOString(),
    "2026-07-30T00:15:30.125Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt("2026-07-30T08:15:30+08:00").toISOString(),
    "2026-07-30T00:15:30.000Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt(
      new Date("2026-07-30T00:15:30.000Z")
    ).toISOString(),
    "2026-07-30T00:15:30.000Z"
  );
  assert.strictEqual(
    normalizeChinaEventAt(
      new Date("2026-07-30T00:15:30.000Z").getTime()
    ).toISOString(),
    "2026-07-30T00:15:30.000Z"
  );

  const maximum = normalizeZhiPayload(validZhi({
    source: "来".repeat(ZHI_LIMITS.source),
    label: "标".repeat(ZHI_LIMITS.label),
    content: "文".repeat(ZHI_LIMITS.content)
  }));
  assert.strictEqual(maximum.source.length, ZHI_LIMITS.source);
  assert.strictEqual(maximum.label.length, ZHI_LIMITS.label);
  assert.strictEqual(maximum.content.length, ZHI_LIMITS.content);

  expectEditorialError(
    () => normalizeZhiPayload({ ...validZhi(), unknown: true }),
    "EDITORIAL_UNKNOWN_FIELD",
    "payload.unknown"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({ content: "带有\u0000字符" })),
    "EDITORIAL_CONTROL_CHARACTER",
    "payload.content"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({ content: "" })),
    "EDITORIAL_REQUIRED_FIELD",
    "payload.content"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({
      source: "来".repeat(ZHI_LIMITS.source + 1)
    })),
    "EDITORIAL_TEXT_TOO_LONG",
    "payload.source"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({ eventAt: "2026-02-30" })),
    "EDITORIAL_INVALID_DATE",
    "payload.eventAt"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({ eventAt: "July 30, 2026" })),
    "EDITORIAL_INVALID_DATE",
    "payload.eventAt"
  );
  expectEditorialError(
    () => normalizeZhiPayload(validZhi({ eventAt: "1999-12-31" })),
    "EDITORIAL_INVALID_DATE",
    "payload.eventAt"
  );
  expectEditorialError(
    () => normalizeZhiPayload(null),
    "EDITORIAL_INVALID_STRUCTURE",
    "payload"
  );
}

function testQuizNormalization() {
  const input = validQuiz();
  const snapshot = JSON.stringify(input);
  const normalized = normalizeQuizPayload(input);

  assert.strictEqual(JSON.stringify(input), snapshot);
  assert.strictEqual(normalized.options.length, 2);
  assert.strictEqual(normalized.correctKey, "one");
  assert.strictEqual(normalized.sortOrder, 10);
  assert(OPTION_KEY_PATTERN.test(normalized.options[0].key));

  const generatedKeys = normalizeQuizPayload(validQuiz({
    options: [
      { text: "答案甲" },
      { label: "第二项", text: "答案乙" }
    ],
    correctKey: "option-2",
    sortOrder: undefined
  }));
  assert.deepStrictEqual(
    generatedKeys.options,
    [
      { key: "option-1", label: "选择一", text: "答案甲" },
      { key: "option-2", label: "第二项", text: "答案乙" }
    ]
  );
  assert.strictEqual(generatedKeys.correctKey, "option-2");
  assert.strictEqual(generatedKeys.sortOrder, 0);

  const casePreserved = normalizeQuizPayload(validQuiz({
    options: [
      { key: "AnswerA", text: "甲" },
      { key: "AnswerB", text: "乙" }
    ],
    correctKey: "answera"
  }));
  assert.strictEqual(casePreserved.correctKey, "AnswerA");

  const maximum = normalizeQuizPayload(validQuiz({
    question: "问".repeat(QUIZ_LIMITS.question),
    correctFeedback: "对".repeat(QUIZ_LIMITS.correctFeedback),
    wrongFeedback: "错".repeat(QUIZ_LIMITS.wrongFeedback),
    explanation: "解".repeat(QUIZ_LIMITS.explanation),
    options: Array.from(
      { length: QUIZ_LIMITS.optionCountMaximum },
      (_, index) => ({
        key: `answer-${index + 1}`,
        label: `选项${index + 1}`,
        text: `答案${index + 1}`
      })
    ),
    correctKey: "answer-8",
    sortOrder: QUIZ_LIMITS.sortOrderMaximum
  }));
  assert.strictEqual(maximum.options.length, 8);
  assert.strictEqual(maximum.explanation.length, QUIZ_LIMITS.explanation);

  expectEditorialError(
    () => normalizeQuizPayload({ ...validQuiz(), status: "published" }),
    "EDITORIAL_UNKNOWN_FIELD",
    "payload.status"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      options: [
        { key: "one", text: "甲", score: 1 },
        { key: "two", text: "乙" }
      ]
    })),
    "EDITORIAL_UNKNOWN_FIELD",
    "payload.options[0].score"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({ options: [{ text: "只有一个" }] })),
    "EDITORIAL_INVALID_OPTIONS",
    "payload.options"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      options: Array.from({ length: 9 }, (_, index) => ({
        key: `choice-${index}`,
        text: `选项${index}`
      }))
    })),
    "EDITORIAL_INVALID_OPTIONS",
    "payload.options"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      options: [
        { key: "same", text: "甲" },
        { key: "SAME", text: "乙" }
      ],
      correctKey: "same"
    })),
    "EDITORIAL_DUPLICATE_OPTION_KEY",
    "payload.options[1].key"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      options: [
        { key: "one", text: "相同答案" },
        { key: "two", text: "相同答案" }
      ]
    })),
    "EDITORIAL_DUPLICATE_OPTION_TEXT",
    "payload.options[1].text"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      options: [
        { key: "1bad", text: "甲" },
        { key: "good", text: "乙" }
      ],
      correctKey: "good"
    })),
    "EDITORIAL_INVALID_OPTION_KEY",
    "payload.options[0].key"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({ correctKey: "missing" })),
    "EDITORIAL_CORRECT_KEY_NOT_FOUND",
    "payload.correctKey"
  );
  const multiline = normalizeQuizPayload(validQuiz({
    question: "问题第一行\r\n问题第二行",
    explanation: "解析第一段\n解析第二段"
  }));
  assert.strictEqual(multiline.question, "问题第一行\n问题第二行");
  assert.strictEqual(multiline.explanation, "解析第一段\n解析第二段");
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({ question: "问题\u0007第二行" })),
    "EDITORIAL_CONTROL_CHARACTER",
    "payload.question"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({
      explanation: "解".repeat(QUIZ_LIMITS.explanation + 1)
    })),
    "EDITORIAL_TEXT_TOO_LONG",
    "payload.explanation"
  );
  expectEditorialError(
    () => normalizeQuizPayload(validQuiz({ sortOrder: 1.5 })),
    "EDITORIAL_INVALID_INTEGER",
    "payload.sortOrder"
  );
}

function testCanonicalIdentityHelpers() {
  const first = {
    b: 2,
    a: 1,
    eventAt: new Date("2026-07-30T00:00:00.000Z")
  };
  const second = {
    eventAt: new Date("2026-07-30T00:00:00.000Z"),
    a: 1,
    b: 2
  };
  assert.strictEqual(canonicalStringify(first), canonicalStringify(second));
  assert.strictEqual(canonicalHash(first), canonicalHash(second));
  assert.strictEqual(canonicalHash(first).length, 64);

  const zhiTarget = createEditorialTargetId("zhi", "upload-001");
  const sameZhiTarget = createEditorialTargetId("zhi", "upload-001");
  const quizTarget = createEditorialTargetId("quiz", "upload-001");
  assert.strictEqual(zhiTarget, sameZhiTarget);
  assert.notStrictEqual(zhiTarget, quizTarget);
  assert(TARGET_ID_PATTERN.test(zhiTarget));
  assert(TARGET_ID_PATTERN.test(quizTarget));

  const payload = normalizeZhiPayload(validZhi());
  const revision = createEditorialRevision(
    "zhi",
    zhiTarget,
    payload,
    "first-import"
  );
  const changedRevision = createEditorialRevision(
    "zhi",
    zhiTarget,
    { ...payload, content: "不同内容" },
    "first-import"
  );
  assert(REVISION_PATTERN.test(revision));
  assert.notStrictEqual(revision, changedRevision);

  const identity = resolveDocumentIdentity("zhi", payload, {
    targetSeed: "upload-001",
    revisionSeed: "v1"
  });
  assert.strictEqual(identity.targetId, zhiTarget);
  assert(REVISION_PATTERN.test(identity.revision));

  expectEditorialError(
    () => createEditorialTargetId("news", "seed"),
    "EDITORIAL_INVALID_KIND",
    "kind"
  );
  expectEditorialError(
    () => createEditorialTargetId("zhi"),
    "EDITORIAL_TARGET_SEED_REQUIRED",
    "seed"
  );
  expectEditorialError(
    () => createEditorialRevision("zhi", "manual-id", payload),
    "EDITORIAL_INVALID_TARGET_ID",
    "targetId"
  );
  const circular = {};
  circular.self = circular;
  expectEditorialError(
    () => canonicalHash(circular),
    "EDITORIAL_CANONICAL_VALUE_INVALID",
    "value"
  );
}

function testDirectlyWritableDocuments() {
  const times = {
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    publishedAt: "2026-07-30T11:00:00.000Z"
  };
  const draft = buildZhiDraftDocument(validZhi(), {
    targetSeed: "zhi-upload",
    revisionSeed: "draft-one",
    sourceDraftId: "draft_zhi_001",
    ...times
  });
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(draft.entryId, draft._id);
  assert.strictEqual(draft.sourceDraftId, "draft_zhi_001");
  assert(draft.eventAt instanceof Date);
  assert(draft.createdAt instanceof Date);
  assert.strictEqual(draft.publishedAt, undefined);
  assert.strictEqual(draft.payloadHash.length, 64);

  const published = buildZhiPublishedDocument(validZhi(), {
    targetId: draft._id,
    revision: draft.revision,
    sourceDraftId: "draft_zhi_001",
    ...times
  });
  assert.strictEqual(published.status, "published");
  assert.strictEqual(published._id, draft._id);
  assert.strictEqual(published.revision, draft.revision);
  assert(published.publishedAt instanceof Date);
  assert.strictEqual(published.content, validZhi().content);

  const quizDraft = buildQuizDraftDocument(validQuiz(), {
    targetSeed: "quiz-upload",
    revisionSeed: "draft-one"
  });
  assert.strictEqual(quizDraft.status, "draft");
  assert.strictEqual(quizDraft.questionId, quizDraft._id);
  assert.strictEqual(quizDraft.correctKey, "one");
  assert.strictEqual(quizDraft.options.length, 2);

  const quizPublished = buildQuizPublishedDocument(validQuiz(), {
    targetId: quizDraft._id,
    revision: quizDraft.revision,
    publishedAt: times.publishedAt
  });
  assert.strictEqual(quizPublished.status, "published");
  assert.strictEqual(quizPublished.questionId, quizPublished._id);
  assert.strictEqual(quizPublished.publishedAt.toISOString(), times.publishedAt);

  const genericDraft = buildEditorialDraftDocument(
    EDITORIAL_KINDS.QUIZ,
    validQuiz(),
    { targetSeed: "generic" }
  );
  const genericPublished = buildEditorialPublishedDocument(
    EDITORIAL_KINDS.QUIZ,
    validQuiz(),
    {
      targetId: genericDraft._id,
      revision: genericDraft.revision,
      publishedAt: times.publishedAt
    }
  );
  assert.strictEqual(genericDraft.status, "draft");
  assert.strictEqual(genericPublished.status, "published");

  const bundle = buildEditorialBundle("quiz", validQuiz(), {
    targetSeed: "bundle",
    revisionSeed: "v1",
    publishedAt: times.publishedAt
  });
  assert.strictEqual(bundle.collection, "quizQuestions");
  assert.strictEqual(bundle.collection, EDITORIAL_COLLECTIONS.quiz);
  assert.strictEqual(bundle.draftDocument._id, bundle.targetId);
  assert.strictEqual(bundle.publishedDocument._id, bundle.targetId);
  assert.strictEqual(bundle.payloadHash, bundle.draftDocument.payloadHash);

  const draftOnlyBundle = buildEditorialBundle("zhi", validZhi(), {
    targetSeed: "bundle-draft"
  });
  assert.strictEqual(draftOnlyBundle.collection, "zhiEntries");
  assert.strictEqual(draftOnlyBundle.publishedDocument, null);

  assert.deepStrictEqual(
    normalizeEditorialPayload("zhi", validZhi()),
    normalizeZhiPayload(validZhi())
  );
  assert.deepStrictEqual(
    normalizeEditorialPayload("quiz", validQuiz()),
    normalizeQuizPayload(validQuiz())
  );

  expectEditorialError(
    () => buildQuizPublishedDocument(validQuiz(), {}),
    "EDITORIAL_PUBLISHED_AT_REQUIRED",
    "context.publishedAt"
  );
  expectEditorialError(
    () => buildZhiDraftDocument(validZhi(), { unexpected: true }),
    "EDITORIAL_UNKNOWN_FIELD",
    "context.unexpected"
  );
  expectEditorialError(
    () => buildZhiDraftDocument(validZhi(), { targetId: "article-1" }),
    "EDITORIAL_INVALID_TARGET_ID",
    "context.targetId"
  );
  expectEditorialError(
    () => buildZhiDraftDocument(validZhi(), { revision: "v1" }),
    "EDITORIAL_INVALID_REVISION",
    "context.revision"
  );
  expectEditorialError(
    () => buildZhiDraftDocument(validZhi(), { sourceDraftId: "../draft" }),
    "EDITORIAL_INVALID_SOURCE_DRAFT_ID",
    "context.sourceDraftId"
  );
  expectEditorialError(
    () => buildZhiPublishedDocument(validZhi(), {
      publishedAt: "2026-07-30 11:00:00"
    }),
    "EDITORIAL_INVALID_DATE",
    "context.publishedAt"
  );
}

function main() {
  testChinaDatesAndZhiNormalization();
  testQuizNormalization();
  testCanonicalIdentityHelpers();
  testDirectlyWritableDocuments();
  console.log("管理员少年志消息与少年爱题目模型测试通过。");
}

main();
