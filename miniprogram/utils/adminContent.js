const ASSET_TYPE_LABELS = Object.freeze({
  manuscript: "书稿",
  audio: "录音",
  "special-topic": "小专题",
  "zhi-entry": "少年志消息",
  "quiz-question": "少年爱题目",
  "full-book-pdf": "完整书稿 PDF",
  "topic-image": "专题图片"
});

const DRAFT_STATE_META = Object.freeze({
  editing: { label: "编辑中", tone: "editing" },
  in_review: { label: "待复核", tone: "review" },
  changes_requested: { label: "退回修改", tone: "warning" },
  approved: { label: "已批准", tone: "approved" },
  rejected: { label: "已驳回", tone: "rejected" },
  published: { label: "已发布", tone: "published" }
});

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function clone(value, fallback) {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return fallback;
  }
}

function normalizeCapabilities(result) {
  const source = result && result.capabilities &&
    typeof result.capabilities === "object"
    ? result.capabilities
    : {};

  return {
    upload: source.upload === true,
    drafts: source.drafts === true,
    review: source.review === true,
    moderation: source.moderation === true,
    assetPreview: source.assetPreview === true,
    publish: source.publish === true,
    transportMode: normalizeText(
      source.uploadMode || source.transportMode,
      32
    )
  };
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getAssetLabel(assetType) {
  return ASSET_TYPE_LABELS[normalizeText(assetType, 32)] || "其他资料";
}

function getDraftStateMeta(state) {
  return DRAFT_STATE_META[normalizeText(state, 32)] || {
    label: "状态未知",
    tone: "muted"
  };
}

function normalizeDraft(source) {
  const item = source && typeof source === "object" ? source : {};
  const id = normalizeText(item.id || item.draftId || item._id, 32).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return null;
  }

  const state = normalizeText(item.state, 32).toLowerCase();
  const stateMeta = getDraftStateMeta(state);
  const issues = Array.isArray(item.issues)
    ? item.issues.map((issue) => normalizeText(issue, 180)).filter(Boolean).slice(0, 20)
    : [];
  const review = item.review && typeof item.review === "object"
    ? item.review
    : null;

  return {
    id,
    assetType: normalizeText(item.assetType, 32),
    assetLabel: getAssetLabel(item.assetType),
    kind: normalizeText(item.kind, 32),
    targetId: normalizeText(item.targetId, 64),
    revision: normalizeText(item.revision, 128),
    basePublishedRevision: normalizeText(item.basePublishedRevision, 128),
    baseAssetRevision: normalizeText(item.baseAssetRevision, 128),
    draftVersion: Number.isInteger(Number(item.draftVersion))
      ? Number(item.draftVersion)
      : 0,
    state,
    stateLabel: stateMeta.label,
    stateTone: stateMeta.tone,
    payload: clone(item.payload, {}),
    issues,
    issueSummary: issues[0] || "",
    inspection: clone(item.inspection, {}),
    snapshotHash: normalizeText(item.snapshotHash, 64).toLowerCase(),
    review: review
      ? {
          round: Number(review.round) || 0,
          decision: normalizeText(review.decision, 32),
          note: normalizeText(review.note, 1000),
          submittedAt: review.submittedAt || null,
          reviewedAt: review.reviewedAt || null
        }
      : null,
    reviewNote: normalizeText(review && review.note, 1000),
    publication: clone(item.publication, null),
    createdAt: item.createdAt || null,
    updateTime: item.updateTime || null,
    updateLabel: formatTime(item.updateTime || item.createdAt),
    title: normalizeText(item.payload && item.payload.title, 160) ||
      normalizeText(item.payload && item.payload.label, 160) ||
      normalizeText(item.payload && item.payload.question, 160) ||
      normalizeText(item.payload && item.payload.caption, 160) ||
      normalizeText(item.targetId, 64),
    canEdit: ["editing", "changes_requested"].includes(state),
    canSubmit: ["editing", "changes_requested"].includes(state) && issues.length === 0,
    canReview: state === "in_review",
    canPublish: state === "approved"
  };
}

function normalizeDrafts(result) {
  const source = result && Array.isArray(result.drafts) ? result.drafts : [];
  return source.map(normalizeDraft).filter(Boolean);
}

function createMutationId(prefix = "admin") {
  const safePrefix = normalizeText(prefix, 20)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "admin";
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return `${safePrefix}-${time}-${random}`;
}

function getErrorMessage(error, fallback) {
  return normalizeText(
    error && (error.userMessage || error.message || error.errMsg),
    240
  ) || fallback;
}

function toFiniteNumber(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ensureSections(value) {
  const source = Array.isArray(value) ? value : [];
  const sections = source.map((section) => {
    const paragraphs = Array.isArray(section && section.paragraphs)
      ? section.paragraphs.map((paragraph) =>
          typeof paragraph === "string" ? paragraph : ""
        )
      : [];
    const sourceBlocks = Array.isArray(section && section.blocks)
      ? section.blocks
      : [];
    const blocks = sourceBlocks.length > 0
      ? sourceBlocks.map((block) => {
          if (block && block.type === "image") {
            return {
              type: "image",
              embeddedAssetId: normalizeText(block.embeddedAssetId, 32).toLowerCase(),
              caption: typeof block.caption === "string" ? block.caption : ""
            };
          }
          return {
            type: "text",
            text: typeof (block && block.text) === "string" ? block.text : ""
          };
        })
      : paragraphs.map((paragraph) => ({ type: "text", text: paragraph }));

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "" });
    }
    const textBlocks = blocks.filter((block) => block.type === "text");
    if (textBlocks.length === 0) {
      blocks.push({ type: "text", text: "" });
    }
    const synchronizedParagraphs = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    return {
      kind: normalizeText(section && section.kind, 32) || "story",
      heading: typeof (section && section.heading) === "string"
        ? section.heading
        : "",
      paragraphs: synchronizedParagraphs,
      blocks,
      textBlockCount: synchronizedParagraphs.length,
      hasEmbeddedImages: blocks.some(
        (block) => block.type === "image" && block.embeddedAssetId
      )
    };
  });

  if (sections.length === 0) {
    sections.push({
      kind: "story",
      heading: "",
      paragraphs: [""],
      blocks: [{ type: "text", text: "" }],
      textBlockCount: 1,
      hasEmbeddedImages: false
    });
  }
  return sections;
}

function ensureTopicEntries(value) {
  const source = Array.isArray(value) ? value : [];
  const entries = source.map((entry, entryIndex) => {
    const blocks = Array.isArray(entry && entry.blocks)
      ? entry.blocks.map((block) => ({
          type: ["heading", "image"].includes(block && block.type)
            ? block.type
            : "text",
          text: typeof (block && block.text) === "string" ? block.text : "",
          imageDraftId: typeof (block && block.imageDraftId) === "string"
            ? block.imageDraftId
            : "",
          embeddedAssetId: typeof (block && block.embeddedAssetId) === "string"
            ? block.embeddedAssetId
            : "",
          caption: typeof (block && block.caption) === "string"
            ? block.caption
            : ""
        }))
      : [];
    return {
      sortOrder: toFiniteNumber(
        entry && entry.sortOrder,
        (entryIndex + 1) * 10
      ),
      blocks,
      hasEmbeddedImages: blocks.some(
        (block) => block.type === "image" && block.embeddedAssetId
      )
    };
  });

  if (entries.length === 0) {
    entries.push({
      sortOrder: 10,
      blocks: [{
        type: "text",
        text: "",
        imageDraftId: "",
        embeddedAssetId: "",
        caption: ""
      }],
      hasEmbeddedImages: false
    });
  }
  entries.forEach((entry) => {
    if (entry.blocks.length === 0) {
      entry.blocks.push({
        type: "text",
        text: "",
        imageDraftId: "",
        embeddedAssetId: "",
        caption: ""
      });
    }
  });
  return entries;
}

function ensureBookChapters(value, bookId) {
  const source = Array.isArray(value) ? value : [];
  return source.map((chapter, index) => {
    const fullId = normalizeText(chapter && chapter.chapterId, 64).toLowerCase();
    const prefix = `${normalizeText(bookId, 64).toLowerCase()}-`;
    return {
      chapterId: fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId,
      title: typeof (chapter && chapter.title) === "string" ? chapter.title : "",
      sortOrder: toFiniteNumber(chapter && chapter.sortOrder, (index + 1) * 10),
      sourceContentId: typeof (chapter && chapter.sourceContentId) === "string"
        ? chapter.sourceContentId
        : "",
      sourceContentRevision:
        typeof (chapter && chapter.sourceContentRevision) === "string"
          ? chapter.sourceContentRevision
          : "",
      sections: ensureSections(chapter && chapter.sections)
    };
  });
}

function formatChinaDateInput(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const source = value && typeof value === "object" && value.$date
    ? value.$date
    : value;
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${chinaDate.getUTCFullYear()}-${pad(
    chinaDate.getUTCMonth() + 1
  )}-${pad(chinaDate.getUTCDate())}`;
}

function ensureQuizOptions(value, correctKey) {
  const letters = "ABCDEFGH".split("");
  const source = Array.isArray(value) ? value.slice(0, letters.length) : [];
  const correctIndex = source.findIndex(
    (option) => normalizeText(option && option.key, 32) ===
      normalizeText(correctKey, 32)
  );
  const options = source.map((option, index) => ({
    key: letters[index],
    text: typeof (option && option.text) === "string" ? option.text : ""
  }));

  while (options.length < 2) {
    const index = options.length;
    options.push({ key: letters[index], text: "" });
  }

  return {
    options,
    correctKey: letters[correctIndex >= 0 ? correctIndex : 0]
  };
}

function payloadToForm(draft) {
  const payload = clone(draft && draft.payload, {});
  const assetType = normalizeText(draft && draft.assetType, 32);
  const form = { ...payload };

  if (assetType === "manuscript") {
    const views = Array.isArray(payload.catalogViews) ? payload.catalogViews : [];
    form.catalogBook = views.includes("book");
    form.catalogSummary = views.includes("summary");
    form.sections = ensureSections(payload.sections);
  } else if (assetType === "special-topic") {
    form.entries = ensureTopicEntries(payload.entries);
  } else if (assetType === "full-book-pdf") {
    form.structureMode = [
      "reuse-current",
      "from-published-contents",
      "replace"
    ].includes(payload.structureMode)
      ? payload.structureMode
      : "replace";
    form.chapters = ensureBookChapters(payload.chapters, draft && draft.targetId);
  } else if (assetType === "zhi-entry") {
    form.eventAt = formatChinaDateInput(payload.eventAt);
  } else if (assetType === "quiz-question") {
    const quizOptions = ensureQuizOptions(payload.options, payload.correctKey);
    form.options = quizOptions.options;
    form.correctKey = quizOptions.correctKey;
  }

  return form;
}

function cleanSections(value) {
  return (Array.isArray(value) ? value : [])
    .map((section) => {
      const sourceBlocks = Array.isArray(section && section.blocks)
        ? section.blocks
        : [];
      let blocks = sourceBlocks.map((block) => {
        if (block && block.type === "image") {
          const embeddedAssetId = normalizeText(
            block.embeddedAssetId,
            32
          ).toLowerCase();
          return embeddedAssetId
            ? {
                type: "image",
                embeddedAssetId,
                caption: normalizeText(block.caption, 300)
              }
            : null;
        }
        const text = normalizeText(block && block.text, 10000);
        return text ? { type: "text", text } : null;
      }).filter(Boolean);

      if (blocks.length === 0) {
        blocks = (Array.isArray(section && section.paragraphs)
          ? section.paragraphs
          : [])
          .map((paragraph) => normalizeText(paragraph, 10000))
          .filter(Boolean)
          .map((text) => ({ type: "text", text }));
      }
      const paragraphs = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text);
      return {
        kind: normalizeText(section && section.kind, 32) || "story",
        heading: normalizeText(section && section.heading, 120),
        paragraphs,
        ...(blocks.some((block) => block.type === "image") ? { blocks } : {})
      };
    })
    .filter((section) =>
      section.heading ||
      section.paragraphs.length > 0 ||
      (Array.isArray(section.blocks) && section.blocks.length > 0)
    );
}

function buildPatch(assetType, form, targetId) {
  const source = form && typeof form === "object" ? form : {};
  if (assetType === "manuscript") {
    const catalogViews = [];
    if (source.catalogBook) catalogViews.push("book");
    if (source.catalogSummary) catalogViews.push("summary");
    return {
      bookId: normalizeText(source.bookId, 64).toLowerCase(),
      title: normalizeText(source.title, 120),
      subtitle: normalizeText(source.subtitle, 240),
      sourceLabel: normalizeText(source.sourceLabel, 120),
      department: normalizeText(source.department, 80),
      catalogViews,
      sortOrder: Math.trunc(toFiniteNumber(source.sortOrder, 0)),
      coverFileID: normalizeText(source.coverFileID, 2048),
      disclaimer: normalizeText(source.disclaimer, 1000),
      sections: cleanSections(source.sections),
      ...(Array.isArray(source.embeddedAssets)
        ? { embeddedAssets: clone(source.embeddedAssets, []) }
        : {}),
      structureConfirmed: source.structureConfirmed === true
    };
  }

  if (assetType === "audio") {
    return {
      title: normalizeText(source.title, 120),
      narrator: normalizeText(source.narrator, 80),
      language: normalizeText(source.language, 32) || "zh-CN",
      durationSeconds: toFiniteNumber(source.durationSeconds, 0),
      bitrate: Math.trunc(toFiniteNumber(source.bitrate, 0))
    };
  }

  if (assetType === "special-topic") {
    return {
      title: normalizeText(source.title, 120),
      summary: normalizeText(source.summary, 500),
      producer: normalizeText(source.producer, 120),
      unlockCostStars: Math.trunc(toFiniteNumber(source.unlockCostStars, 0)),
      sortOrder: Math.trunc(toFiniteNumber(source.sortOrder, 0)),
      previewCoverFileID: normalizeText(source.previewCoverFileID, 2048),
      entries: (Array.isArray(source.entries) ? source.entries : []).map(
        (entry, entryIndex) => ({
          sortOrder: Math.trunc(
            toFiniteNumber(entry && entry.sortOrder, (entryIndex + 1) * 10)
          ),
          blocks: (Array.isArray(entry && entry.blocks) ? entry.blocks : [])
            .map((block) => {
              const type = ["heading", "image"].includes(block && block.type)
                ? block.type
                : "text";
              if (type === "image") {
                const embeddedAssetId = normalizeText(
                  block.embeddedAssetId,
                  32
                ).toLowerCase();
                if (embeddedAssetId) {
                  return {
                    type,
                    embeddedAssetId,
                    caption: normalizeText(block.caption, 300)
                  };
                }
                return {
                  type,
                  imageDraftId: normalizeText(block.imageDraftId, 32).toLowerCase(),
                  caption: normalizeText(block.caption, 300)
                };
              }
              return {
                type,
                text: normalizeText(block && block.text, type === "heading" ? 300 : 10000)
              };
            })
            .filter((block) =>
              block.type === "image"
                ? block.embeddedAssetId || block.imageDraftId
                : block.text
            )
        })
      ).filter((entry) => entry.blocks.length > 0),
      ...(Array.isArray(source.embeddedAssets)
        ? { embeddedAssets: clone(source.embeddedAssets, []) }
        : {}),
      structureConfirmed: source.structureConfirmed === true
    };
  }

  if (assetType === "full-book-pdf") {
    const structureMode = [
      "reuse-current",
      "from-published-contents",
      "replace"
    ].includes(source.structureMode)
      ? source.structureMode
      : "replace";
    const bookId = normalizeText(targetId, 64).toLowerCase();
    return {
      title: normalizeText(source.title, 160),
      subtitle: normalizeText(source.subtitle, 240),
      fileName: normalizeText(source.fileName, 180) || `${bookId}.pdf`,
      structureMode,
      chapters: structureMode === "replace"
        ? (Array.isArray(source.chapters) ? source.chapters : []).map(
            (chapter, index) => ({
              chapterId: normalizeText(chapter && chapter.chapterId, 64).toLowerCase(),
              title: normalizeText(chapter && chapter.title, 160),
              sortOrder: Math.trunc(
                toFiniteNumber(chapter && chapter.sortOrder, (index + 1) * 10)
              ),
              sourceContentId: normalizeText(chapter && chapter.sourceContentId, 64).toLowerCase(),
              sourceContentRevision: normalizeText(
                chapter && chapter.sourceContentRevision,
                128
              ),
              sections: cleanSections(chapter && chapter.sections)
            })
          )
        : [],
      structureConfirmed: [
        "reuse-current",
        "from-published-contents"
      ].includes(structureMode) ||
        source.structureConfirmed === true
    };
  }

  if (assetType === "zhi-entry") {
    return {
      eventAt: normalizeText(source.eventAt, 10),
      source: normalizeText(source.source, 120),
      label: normalizeText(source.label, 80),
      content: normalizeText(source.content, 2000)
    };
  }

  if (assetType === "quiz-question") {
    const letters = "ABCDEFGH".split("");
    const options = (Array.isArray(source.options) ? source.options : [])
      .slice(0, letters.length)
      .map((option, index) => ({
        key: letters[index],
        label: `选择${letters[index]}`,
        text: normalizeText(option && option.text, 1000)
      }));
    const availableKeys = options.map((option) => option.key);
    const requestedCorrectKey = normalizeText(source.correctKey, 1).toUpperCase();
    return {
      topic: normalizeText(source.topic, 120),
      department: normalizeText(source.department, 160),
      source: normalizeText(source.source, 300),
      question: normalizeText(source.question, 3000),
      options,
      correctKey: availableKeys.includes(requestedCorrectKey)
        ? requestedCorrectKey
        : availableKeys[0] || "",
      correctFeedback: normalizeText(source.correctFeedback, 500),
      wrongFeedback: normalizeText(source.wrongFeedback, 500),
      explanation: normalizeText(source.explanation, 5000),
      sortOrder: Math.trunc(toFiniteNumber(source.sortOrder, 0))
    };
  }

  return { caption: normalizeText(source.caption, 300) };
}

function buildChangedPatch(assetType, form, draft) {
  const targetId = normalizeText(draft && draft.targetId, 64).toLowerCase();
  const nextPatch = buildPatch(assetType, form, targetId);
  const currentPatch = buildPatch(
    assetType,
    payloadToForm(draft),
    targetId
  );

  return Object.keys(nextPatch).reduce((changed, key) => {
    if (JSON.stringify(nextPatch[key]) !== JSON.stringify(currentPatch[key])) {
      changed[key] = nextPatch[key];
    }
    return changed;
  }, {});
}

module.exports = {
  ASSET_TYPE_LABELS,
  DRAFT_STATE_META,
  buildChangedPatch,
  buildPatch,
  clone,
  createMutationId,
  formatTime,
  getAssetLabel,
  getDraftStateMeta,
  getErrorMessage,
  formatChinaDateInput,
  normalizeCapabilities,
  normalizeDraft,
  normalizeDrafts,
  normalizeText,
  payloadToForm
};
