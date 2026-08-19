const {
  buildChangedPatch,
  clone,
  createMutationId,
  getErrorMessage,
  normalizeCapabilities,
  normalizeDraft,
  normalizeText,
  payloadToForm
} = require("../../utils/adminContent");

const BLOCK_TYPES = [
  { value: "text", label: "正文" },
  { value: "heading", label: "小标题" }
];
const QUIZ_OPTION_KEYS = "ABCDEFGH".split("");
const MAX_PUBLISH_BATCH_ATTEMPTS = 40;
const MAX_PUBLISH_TRANSPORT_RECOVERIES = 6;
const MAX_PUBLISH_RECONCILE_ATTEMPTS = 3;
const PUBLISH_RETRY_DELAY_MS = 120;

function callAdmin(action, data = {}) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
    return Promise.reject(new Error("云服务暂不可用"));
  }

  return wx.cloud.callFunction({
    name: "adminContentCenter",
    data: { action, ...data }
  }).then((response) => response && response.result || {});
}

function isHttpsUrl(value) {
  return typeof value === "string" &&
    /^https:\/\/[^\s\\]+$/i.test(value) &&
    !/[\u0000-\u001f]/.test(value);
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mergePublishDraft(source, fallbackDraft) {
  if (!isPlainObject(source)) return null;
  const fallback = isPlainObject(fallbackDraft) ? fallbackDraft : {};
  const hasPayload = Object.prototype.hasOwnProperty.call(source, "payload") &&
    isPlainObject(source.payload);
  return normalizeDraft({
    ...fallback,
    ...source,
    payload: hasPayload ? source.payload : fallback.payload
  });
}

function publishProgressMessage(result, attempt) {
  const processed = Number.isFinite(Number(result && result.processed))
    ? Math.max(0, Number(result.processed))
    : 0;
  const total = Number.isFinite(Number(result && result.total))
    ? Math.max(0, Number(result.total))
    : 0;
  const countLabel = total > 0 ? `（${processed}/${total}）` : `（第 ${attempt} 步）`;
  if (result && result.phase === "verifying-assets") {
    return `正在核验 Word 图片${countLabel}，请勿退出当前页面。`;
  }
  if (result && result.phase === "preparing-entries") {
    return `正在准备小专题目录${countLabel}，请勿退出当前页面。`;
  }
  return `正在分批发布内容${countLabel}，请勿退出当前页面。`;
}

function isRecoverablePublishTransportError(error) {
  const code = String(error && (error.errCode || error.code) || "").toUpperCase();
  const message = [
    error && error.errMsg,
    error && error.message
  ].filter(Boolean).join(" ").toUpperCase();
  const combined = `${code} ${message}`;
  if (
    /PERMISSION|FORBIDDEN|DENIED|INVALID|NOT[_ ]?FOUND|NOT_EXIST/.test(combined)
  ) {
    return false;
  }
  return code === "-504003" ||
    /FUNCTIONS_TIME_LIMIT_EXCEEDED|INVOKING TASK TIMED OUT|TIMED OUT|TIMEOUT|NETWORK|CONNECTION|ECONN|SOCKET|REQUEST:FAIL|SERVICE UNAVAILABLE|INTERNAL ERROR/.test(combined) ||
    /CLOUD\.CALLFUNCTION:FAIL/.test(combined);
}

function createPublishUserError(message, code) {
  const error = new Error(message);
  error.userMessage = message;
  error.code = code;
  return error;
}

function createPreviewToken(draftId) {
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${draftId.slice(0, 8)}-${randomPart}`;
}

function showConfirm(options) {
  return new Promise((resolve) => {
    if (typeof wx.showModal !== "function") {
      resolve(false);
      return;
    }
    wx.showModal({
      title: options.title,
      content: options.content,
      confirmText: options.confirmText || "确认",
      confirmColor: options.confirmColor || "#b93731",
      success: (result) => resolve(Boolean(result && result.confirm)),
      fail: () => resolve(false)
    });
  });
}

Page({
  data: {
    draftId: "",
    loading: true,
    authorized: false,
    pageError: "",
    actionMessage: "",
    capabilities: {
      upload: false,
      drafts: false,
      review: false,
      assetPreview: false,
      publish: false,
      transportMode: ""
    },
    draft: null,
    form: {},
    formDirty: false,
    blockTypeOptions: BLOCK_TYPES,
    structureModeLabels: ["替换整书章节", "沿用已发布章节"],
    busyAction: "",
    reviewNote: "",
    previewPlaying: false,
    previewedSnapshotHash: "",
    serverIssues: []
  },

  onLoad(options = {}) {
    this.pageDestroyed = false;
    this.isPageVisible = false;
    this.pendingMutationIds = {};
    const draftId = normalizeText(options.id || options.draftId, 32).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(draftId)) {
      this.setData({
        loading: false,
        pageError: "草稿编号无效，无法打开内容。"
      });
      return;
    }
    this.setData({ draftId });
  },

  onShow() {
    this.isPageVisible = true;
    if (this.data.draftId && !this.data.draft && !this.data.busyAction) {
      this.loadDraft();
    }
  },

  onHide() {
    this.isPageVisible = false;
    this.loadRequestId = (this.loadRequestId || 0) + 1;
    if (!this.previewOpeningNative) {
      this.actionRequestId = (this.actionRequestId || 0) + 1;
    }
    this.stopAudioPreview();
    if (!this.pageDestroyed) this.setData({ busyAction: "" });
  },

  onUnload() {
    this.pageDestroyed = true;
    this.isPageVisible = false;
    this.loadRequestId = (this.loadRequestId || 0) + 1;
    this.actionRequestId = (this.actionRequestId || 0) + 1;
    this.destroyAudioPreview();
  },

  async loadDraft({ quiet = false } = {}) {
    if (!this.data.draftId || this.pageDestroyed) {
      return;
    }
    const requestId = (this.loadRequestId || 0) + 1;
    this.loadRequestId = requestId;
    if (!quiet) {
      this.setData({ loading: true, pageError: "", actionMessage: "" });
    }

    try {
      const [status, draftResult] = await Promise.all([
        callAdmin("status"),
        callAdmin("getDraft", { draftId: this.data.draftId })
      ]);
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.loadRequestId
      ) {
        return;
      }
      if (!status.success || status.authorized !== true) {
        throw Object.assign(new Error(status.message || "当前微信没有内容管理权限"), {
          userMessage: status.message
        });
      }
      if (!draftResult.success) {
        throw Object.assign(new Error(draftResult.message || "草稿读取失败"), {
          code: draftResult.code,
          userMessage: draftResult.message
        });
      }
      const draft = normalizeDraft(draftResult.draft);
      if (!draft) {
        throw new Error("草稿数据无效，请联系系统维护人员");
      }
      this.applyDraft(draft, normalizeCapabilities(status));
    } catch (error) {
      console.error("load admin draft error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.loadRequestId
      ) {
        this.setData({
          loading: false,
          authorized: false,
          pageError: getErrorMessage(error, "草稿读取失败，请稍后重试。")
        });
      }
    }
  },

  applyDraft(draft, capabilities = this.data.capabilities) {
    const isEditorial = ["zhi-entry", "quiz-question"].includes(
      draft.assetType
    );
    const usesStructuredPreview = Boolean(
      isEditorial ||
      (
        ["manuscript", "special-topic"].includes(draft.assetType) &&
        draft.inspection &&
        draft.inspection.format === "docx-client-manifest"
      )
    );
    const visibleDraft = {
      ...draft,
      isEditorial,
      usesStructuredPreview,
      canEdit: Boolean(draft.canEdit && capabilities.drafts),
      canSubmit: Boolean(draft.canSubmit && capabilities.drafts),
      canReview: Boolean(draft.canReview && capabilities.review),
      canPublish: Boolean(draft.canPublish && capabilities.publish)
    };
    const keepsPreviewAudit = Boolean(
      this.data.draft &&
      this.data.draft.id === visibleDraft.id &&
      this.data.draft.snapshotHash === visibleDraft.snapshotHash &&
      this.data.previewedSnapshotHash === visibleDraft.snapshotHash
    );
    this.pendingMutationIds = {};
    this.setData({
      loading: false,
      authorized: true,
      pageError: "",
      capabilities,
      draft: visibleDraft,
      form: payloadToForm(visibleDraft),
      formDirty: false,
      reviewNote: visibleDraft.state === "in_review" ? "" : visibleDraft.reviewNote || "",
      previewedSnapshotHash: keepsPreviewAudit ? visibleDraft.snapshotHash : "",
      serverIssues: []
    });
  },

  retryLoad() {
    if (!this.data.loading) {
      this.loadDraft();
    }
  },

  async refreshDraft() {
    if (this.data.loading || this.data.busyAction || !this.data.draft) return;
    if (this.data.draft.canEdit) {
      const confirmed = await showConfirm({
        title: "重新载入草稿",
        content: "尚未保存的输入会被服务端最新版本覆盖。",
        confirmText: "重新载入"
      });
      if (!confirmed) return;
    }
    await this.loadDraft();
  },

  resetMutation(action) {
    if (this.pendingMutationIds) {
      delete this.pendingMutationIds[action];
    }
  },

  updateForm(mutator) {
    if (!this.data.draft || !this.data.draft.canEdit || this.data.busyAction) {
      return;
    }
    const form = clone(this.data.form, {});
    mutator(form);
    this.resetMutation("saveDraft");
    this.setData({
      form,
      formDirty: true,
      actionMessage: "",
      serverIssues: []
    });
  },

  onFieldInput(event) {
    const field = normalizeText(event && event.currentTarget && event.currentTarget.dataset.field, 64);
    if (!field) return;
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      form[field] = value;
    });
  },

  onSwitchChange(event) {
    const field = normalizeText(event && event.currentTarget && event.currentTarget.dataset.field, 64);
    if (!field) return;
    const value = Boolean(event && event.detail && event.detail.value);
    this.updateForm((form) => {
      form[field] = value;
    });
  },

  onEditorialDateChange(event) {
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      form.eventAt = value;
    });
  },

  onQuizOptionInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      if (Array.isArray(form.options) && form.options[index]) {
        form.options[index].text = value;
      }
    });
  },

  addQuizOption() {
    this.updateForm((form) => {
      if (!Array.isArray(form.options)) form.options = [];
      if (form.options.length >= QUIZ_OPTION_KEYS.length) return;
      form.options.push({
        key: QUIZ_OPTION_KEYS[form.options.length],
        text: ""
      });
      if (!form.correctKey) form.correctKey = form.options[0].key;
    });
  },

  removeQuizOption(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.updateForm((form) => {
      if (
        !Array.isArray(form.options) ||
        form.options.length <= 2 ||
        !form.options[index]
      ) {
        return;
      }
      const oldCorrectIndex = form.options.findIndex(
        (option) => option.key === form.correctKey
      );
      form.options.splice(index, 1);
      form.options = form.options.map((option, optionIndex) => ({
        key: QUIZ_OPTION_KEYS[optionIndex],
        text: option.text
      }));
      const nextCorrectIndex = oldCorrectIndex < 0 || oldCorrectIndex === index
        ? 0
        : oldCorrectIndex > index
          ? oldCorrectIndex - 1
          : oldCorrectIndex;
      form.correctKey = form.options[nextCorrectIndex].key;
    });
  },

  chooseQuizCorrectOption(event) {
    const key = normalizeText(event.currentTarget.dataset.key, 1).toUpperCase();
    this.updateForm((form) => {
      if (
        Array.isArray(form.options) &&
        form.options.some((option) => option.key === key)
      ) {
        form.correctKey = key;
      }
    });
  },

  confirmEditorialContent() {
    const draft = this.data.draft;
    if (
      !draft ||
      !draft.isEditorial ||
      !draft.canReview ||
      !draft.snapshotHash ||
      this.data.busyAction
    ) {
      return;
    }
    this.setData({
      previewedSnapshotHash: draft.snapshotHash,
      pageError: "",
      actionMessage: "已确认核对当前表单内容。"
    });
  },

  onStructureModeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    this.updateForm((form) => {
      form.structureMode = index === 1 ? "reuse-current" : "replace";
      if (form.structureMode === "reuse-current") {
        form.structureConfirmed = true;
      }
    });
  },

  onReviewNoteInput(event) {
    this.resetMutation("reviewDraft");
    this.setData({
      reviewNote: typeof (event && event.detail && event.detail.value) === "string"
        ? event.detail.value.slice(0, 1000)
        : ""
    });
  },

  onSectionFieldInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = normalizeText(event.currentTarget.dataset.field, 32);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      if (form.sections && form.sections[index] && ["heading", "kind"].includes(field)) {
        form.sections[index][field] = value;
      }
    });
  },

  onParagraphInput(event) {
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const paragraphIndex = Number(event.currentTarget.dataset.paragraphIndex);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const section = form.sections && form.sections[sectionIndex];
      if (section && Array.isArray(section.paragraphs) && section.paragraphs[paragraphIndex] !== undefined) {
        section.paragraphs[paragraphIndex] = value;
        const textBlocks = Array.isArray(section.blocks)
          ? section.blocks.filter((block) => block.type === "text")
          : [];
        if (textBlocks[paragraphIndex]) textBlocks[paragraphIndex].text = value;
      }
    });
  },

  addSection() {
    this.updateForm((form) => {
      if (!Array.isArray(form.sections)) form.sections = [];
      form.sections.push({
        kind: "story",
        heading: "",
        paragraphs: [""],
        blocks: [{ type: "text", text: "" }],
        textBlockCount: 1,
        hasEmbeddedImages: false
      });
    });
  },

  removeSection(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.updateForm((form) => {
      if (
        Array.isArray(form.sections) &&
        form.sections.length > 1 &&
        form.sections[index] &&
        !form.sections[index].hasEmbeddedImages
      ) {
        form.sections.splice(index, 1);
      }
    });
  },

  addParagraph(event) {
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    this.updateForm((form) => {
      const section = form.sections && form.sections[sectionIndex];
      if (section) {
        if (!Array.isArray(section.blocks)) {
          section.blocks = (Array.isArray(section.paragraphs)
            ? section.paragraphs
            : []).map((text) => ({ type: "text", text }));
        }
        section.blocks.push({ type: "text", text: "" });
        if (!Array.isArray(section.paragraphs)) section.paragraphs = [];
        section.paragraphs.push("");
        section.textBlockCount = section.paragraphs.length;
      }
    });
  },

  removeParagraph(event) {
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);
    this.updateForm((form) => {
      const section = form.sections && form.sections[sectionIndex];
      if (
        section &&
        Array.isArray(section.blocks) &&
        section.blocks[blockIndex] &&
        section.blocks[blockIndex].type === "text" &&
        section.blocks.filter((block) => block.type === "text").length > 1
      ) {
        section.blocks.splice(blockIndex, 1);
        section.paragraphs = section.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        section.textBlockCount = section.paragraphs.length;
      }
    });
  },

  onManuscriptBlockInput(event) {
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const section = form.sections && form.sections[sectionIndex];
      const block = section && Array.isArray(section.blocks)
        ? section.blocks[blockIndex]
        : null;
      if (!block || block.type !== "text") return;
      block.text = value;
      section.paragraphs = section.blocks
        .filter((item) => item.type === "text")
        .map((item) => item.text);
      section.textBlockCount = section.paragraphs.length;
    });
  },

  addTopicEntry() {
    this.updateForm((form) => {
      if (!Array.isArray(form.entries)) form.entries = [];
      form.entries.push({
        sortOrder: (form.entries.length + 1) * 10,
        blocks: [{
          type: "text",
          text: "",
          imageDraftId: "",
          embeddedAssetId: "",
          caption: ""
        }],
        hasEmbeddedImages: false
      });
    });
  },

  removeTopicEntry(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.updateForm((form) => {
      if (
        Array.isArray(form.entries) &&
        form.entries.length > 1 &&
        form.entries[index] &&
        !form.entries[index].hasEmbeddedImages
      ) {
        form.entries.splice(index, 1);
      }
    });
  },

  onTopicEntrySortInput(event) {
    const entryIndex = Number(event.currentTarget.dataset.entryIndex);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      if (form.entries && form.entries[entryIndex]) {
        form.entries[entryIndex].sortOrder = value;
      }
    });
  },

  addTopicBlock(event) {
    const entryIndex = Number(event.currentTarget.dataset.entryIndex);
    this.updateForm((form) => {
      const entry = form.entries && form.entries[entryIndex];
      if (entry) {
        if (!Array.isArray(entry.blocks)) entry.blocks = [];
        entry.blocks.push({
          type: "text",
          text: "",
          imageDraftId: "",
          embeddedAssetId: "",
          caption: ""
        });
      }
    });
  },

  removeTopicBlock(event) {
    const entryIndex = Number(event.currentTarget.dataset.entryIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);
    this.updateForm((form) => {
      const entry = form.entries && form.entries[entryIndex];
      if (
        entry &&
        Array.isArray(entry.blocks) &&
        entry.blocks.length > 1 &&
        entry.blocks[blockIndex] &&
        !entry.blocks[blockIndex].embeddedAssetId
      ) {
        entry.blocks.splice(blockIndex, 1);
      }
    });
  },

  onTopicBlockTypeChange(event) {
    const entryIndex = Number(event.currentTarget.dataset.entryIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);
    const option = BLOCK_TYPES[Number(event && event.detail && event.detail.value)];
    if (!option) return;
    this.updateForm((form) => {
      const block = form.entries && form.entries[entryIndex] &&
        form.entries[entryIndex].blocks && form.entries[entryIndex].blocks[blockIndex];
      if (block && !block.embeddedAssetId) block.type = option.value;
    });
  },

  onTopicBlockInput(event) {
    const entryIndex = Number(event.currentTarget.dataset.entryIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);
    const field = normalizeText(event.currentTarget.dataset.field, 32);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const block = form.entries && form.entries[entryIndex] &&
        form.entries[entryIndex].blocks && form.entries[entryIndex].blocks[blockIndex];
      if (block && ["text", "imageDraftId", "caption"].includes(field)) {
        block[field] = value;
      }
    });
  },

  addChapter() {
    this.updateForm((form) => {
      if (!Array.isArray(form.chapters)) form.chapters = [];
      const sequence = form.chapters.length + 1;
      form.chapters.push({
        chapterId: `chapter-${sequence}`,
        title: "",
        sortOrder: sequence * 10,
        sourceContentId: "",
        sourceContentRevision: "",
        sections: [{ kind: "story", heading: "", paragraphs: [""] }]
      });
    });
  },

  removeChapter(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    this.updateForm((form) => {
      if (Array.isArray(form.chapters)) form.chapters.splice(chapterIndex, 1);
    });
  },

  onChapterFieldInput(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const field = normalizeText(event.currentTarget.dataset.field, 40);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const chapter = form.chapters && form.chapters[chapterIndex];
      if (chapter && [
        "chapterId",
        "title",
        "sortOrder",
        "sourceContentId",
        "sourceContentRevision"
      ].includes(field)) {
        chapter[field] = value;
      }
    });
  },

  addChapterSection(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    this.updateForm((form) => {
      const chapter = form.chapters && form.chapters[chapterIndex];
      if (chapter) {
        if (!Array.isArray(chapter.sections)) chapter.sections = [];
        chapter.sections.push({ kind: "story", heading: "", paragraphs: [""] });
      }
    });
  },

  removeChapterSection(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    this.updateForm((form) => {
      const chapter = form.chapters && form.chapters[chapterIndex];
      if (chapter && Array.isArray(chapter.sections) && chapter.sections.length > 1) {
        chapter.sections.splice(sectionIndex, 1);
      }
    });
  },

  onChapterSectionFieldInput(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const field = normalizeText(event.currentTarget.dataset.field, 32);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const section = form.chapters && form.chapters[chapterIndex] &&
        form.chapters[chapterIndex].sections &&
        form.chapters[chapterIndex].sections[sectionIndex];
      if (section && ["heading", "kind"].includes(field)) section[field] = value;
    });
  },

  addChapterParagraph(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    this.updateForm((form) => {
      const section = form.chapters && form.chapters[chapterIndex] &&
        form.chapters[chapterIndex].sections &&
        form.chapters[chapterIndex].sections[sectionIndex];
      if (section) {
        if (!Array.isArray(section.paragraphs)) section.paragraphs = [];
        section.paragraphs.push("");
      }
    });
  },

  removeChapterParagraph(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const paragraphIndex = Number(event.currentTarget.dataset.paragraphIndex);
    this.updateForm((form) => {
      const section = form.chapters && form.chapters[chapterIndex] &&
        form.chapters[chapterIndex].sections &&
        form.chapters[chapterIndex].sections[sectionIndex];
      if (section && Array.isArray(section.paragraphs) && section.paragraphs.length > 1) {
        section.paragraphs.splice(paragraphIndex, 1);
      }
    });
  },

  onChapterParagraphInput(event) {
    const chapterIndex = Number(event.currentTarget.dataset.chapterIndex);
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const paragraphIndex = Number(event.currentTarget.dataset.paragraphIndex);
    const value = event && event.detail ? event.detail.value : "";
    this.updateForm((form) => {
      const section = form.chapters && form.chapters[chapterIndex] &&
        form.chapters[chapterIndex].sections &&
        form.chapters[chapterIndex].sections[sectionIndex];
      if (section && Array.isArray(section.paragraphs) &&
          section.paragraphs[paragraphIndex] !== undefined) {
        section.paragraphs[paragraphIndex] = value;
      }
    });
  },

  getMutationId(action) {
    if (!this.pendingMutationIds) this.pendingMutationIds = {};
    if (!this.pendingMutationIds[action]) {
      this.pendingMutationIds[action] = createMutationId(action);
    }
    return this.pendingMutationIds[action];
  },

  async runMutation(action, payload, successMessage) {
    if (this.data.busyAction || !this.data.draft) return null;
    const operationId = (this.actionRequestId || 0) + 1;
    this.actionRequestId = operationId;
    const requestId = this.getMutationId(action);
    this.setData({
      busyAction: action,
      pageError: "",
      actionMessage: "",
      serverIssues: []
    });
    try {
      const result = await callAdmin(action, { ...payload, requestId });
      if (this.pageDestroyed || operationId !== this.actionRequestId) return null;
      delete this.pendingMutationIds[action];
      if (!result.success) {
        const error = new Error(result.message || "操作失败");
        error.code = result.code;
        error.diagnosticCode = result.diagnosticCode || "";
        error.userMessage = result.message;
        error.issues = result.issues;
        throw error;
      }
      const draft = normalizeDraft(result.draft);
      if (!draft) throw new Error("服务端返回的草稿状态无效");
      this.applyDraft(draft);
      this.setData({ actionMessage: successMessage || "操作已完成" });
      return draft;
    } catch (error) {
      console.error(`admin draft ${action} error:`, error);
      if (!this.pageDestroyed && operationId === this.actionRequestId) {
        this.setData({
          pageError: getErrorMessage(error, "操作失败，请稍后重试。"),
          serverIssues: Array.isArray(error.issues)
            ? error.issues.map((issue) => normalizeText(issue, 180)).filter(Boolean)
            : []
        });
      }
      return null;
    } finally {
      if (!this.pageDestroyed && operationId === this.actionRequestId) {
        this.setData({ busyAction: "" });
      }
    }
  },

  isPublishOperationActive(operationId) {
    return Boolean(
      !this.pageDestroyed &&
      this.isPageVisible &&
      operationId === this.actionRequestId
    );
  },

  async reconcilePublishDraft(fallbackDraft, operationId) {
    let lastError = null;
    for (
      let attempt = 1;
      attempt <= MAX_PUBLISH_RECONCILE_ATTEMPTS;
      attempt += 1
    ) {
      if (!this.isPublishOperationActive(operationId)) return null;
      try {
        const result = await callAdmin("getDraft", { draftId: fallbackDraft.id });
        if (!this.isPublishOperationActive(operationId)) return null;
        if (!result.success) {
          const error = createPublishUserError(
            result.message || "暂时无法确认云端发布进度，请稍后重试。",
            result.code || "PUBLISH_RECONCILE_FAILED"
          );
          error.issues = result.issues;
          throw error;
        }
        const draft = mergePublishDraft(result.draft, fallbackDraft);
        if (!draft) {
          throw createPublishUserError(
            "云端返回的草稿状态无效，请重新打开草稿后再试。",
            "INVALID_RECONCILED_DRAFT"
          );
        }
        return draft;
      } catch (error) {
        lastError = error;
        if (
          !isRecoverablePublishTransportError(error) ||
          attempt >= MAX_PUBLISH_RECONCILE_ATTEMPTS
        ) {
          throw error;
        }
        await wait(PUBLISH_RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError || createPublishUserError(
      "暂时无法确认云端发布进度，请稍后重试。",
      "PUBLISH_RECONCILE_FAILED"
    );
  },

  async runPublishMutation(payload, successMessage) {
    const action = "publishDraft";
    if (this.data.busyAction || !this.data.draft) return null;

    const operationId = (this.actionRequestId || 0) + 1;
    this.actionRequestId = operationId;
    const requestId = this.getMutationId(action);
    let workingDraft = this.data.draft;
    let transportRecoveries = 0;

    this.setData({
      busyAction: action,
      pageError: "",
      actionMessage: "正在开始发布，请勿退出当前页面。",
      serverIssues: []
    });

    try {
      for (
        let attempt = 1;
        attempt <= MAX_PUBLISH_BATCH_ATTEMPTS;
        attempt += 1
      ) {
        if (!this.isPublishOperationActive(operationId)) return null;

        let result;
        try {
          result = await callAdmin(action, { ...payload, requestId });
        } catch (error) {
          if (!isRecoverablePublishTransportError(error)) throw error;
          transportRecoveries += 1;
          if (transportRecoveries > MAX_PUBLISH_TRANSPORT_RECOVERIES) {
            throw createPublishUserError(
              "云端处理时间较长，当前发布进度已保留。请稍后再次点击“发布已批准版本”继续。",
              "PUBLISH_PROGRESS_SAVED"
            );
          }

          if (!this.isPublishOperationActive(operationId)) return null;
          this.setData({
            actionMessage: "云端仍在处理，正在确认已保存的发布进度，请稍候……"
          });

          let reconciledDraft;
          try {
            reconciledDraft = await this.reconcilePublishDraft(
              workingDraft,
              operationId
            );
          } catch (reconcileError) {
            console.error("admin draft publish reconcile error:", reconcileError);
            throw createPublishUserError(
              "云端暂时无法确认发布进度，当前进度已保留。请稍后重新打开草稿再继续发布。",
              "PUBLISH_RECONCILE_UNAVAILABLE"
            );
          }
          if (!reconciledDraft) return null;

          if (reconciledDraft.state === "published") {
            delete this.pendingMutationIds[action];
            this.applyDraft(reconciledDraft);
            this.setData({
              actionMessage: successMessage || "内容已正式发布。"
            });
            return reconciledDraft;
          }
          if (reconciledDraft.state !== "approved") {
            delete this.pendingMutationIds[action];
            this.applyDraft(reconciledDraft);
            throw createPublishUserError(
              "草稿状态已经变化，已停止自动发布。请核对当前状态后再操作。",
              "PUBLISH_STATE_CHANGED"
            );
          }
          if (reconciledDraft.snapshotHash !== payload.expectedSnapshotHash) {
            delete this.pendingMutationIds[action];
            this.applyDraft(reconciledDraft);
            throw createPublishUserError(
              "审核通过的内容已经变化，已停止发布。请重新预览并审核后再试。",
              "PUBLISH_SNAPSHOT_CHANGED"
            );
          }

          workingDraft = reconciledDraft;
          if (!this.isPublishOperationActive(operationId)) return null;
          this.setData({
            actionMessage: "已确认草稿仍待发布，正在从云端保存的进度继续……"
          });
          await wait(PUBLISH_RETRY_DELAY_MS);
          continue;
        }

        if (!this.isPublishOperationActive(operationId)) return null;
        if (!result.success) {
          delete this.pendingMutationIds[action];
          const error = createPublishUserError(
            result.message || "发布失败，请稍后重试。",
            result.code || "PUBLISH_FAILED"
          );
          error.diagnosticCode = result.diagnosticCode || "";
          error.issues = result.issues;
          throw error;
        }

        if (result.pending === true) {
          this.setData({
            actionMessage: publishProgressMessage(result, attempt),
            pageError: ""
          });
          await wait(PUBLISH_RETRY_DELAY_MS);
          continue;
        }

        let publishedDraft = mergePublishDraft(result.draft, workingDraft);
        if (!publishedDraft) {
          publishedDraft = await this.reconcilePublishDraft(
            workingDraft,
            operationId
          );
        }
        if (!publishedDraft) return null;
        if (publishedDraft.state !== "published") {
          throw createPublishUserError(
            "云端尚未确认发布完成，当前进度已保留。请稍后重新打开草稿再继续。",
            "PUBLISH_NOT_CONFIRMED"
          );
        }

        delete this.pendingMutationIds[action];
        this.applyDraft(publishedDraft);
        this.setData({ actionMessage: successMessage || "内容已正式发布。" });
        return publishedDraft;
      }

      throw createPublishUserError(
        "本次内容步骤较多，自动处理已暂停，当前进度已保存。请稍后再次点击“发布已批准版本”继续。",
        "PUBLISH_BATCH_LIMIT_REACHED"
      );
    } catch (error) {
      console.error("admin draft publishDraft error:", error);
      if (this.isPublishOperationActive(operationId)) {
        const friendlyError = isRecoverablePublishTransportError(error)
          ? createPublishUserError(
              "云端处理时间较长，当前发布进度已保留。请稍后再次点击“发布已批准版本”继续。",
              "PUBLISH_PROGRESS_SAVED"
            )
          : error;
        this.setData({
          pageError: getErrorMessage(
            friendlyError,
            "发布未完成，当前进度已保留，请稍后重试。"
          ),
          actionMessage: "",
          serverIssues: Array.isArray(friendlyError.issues)
            ? friendlyError.issues
                .map((issue) => normalizeText(issue, 180))
                .filter(Boolean)
            : []
        });
      }
      return null;
    } finally {
      if (this.isPublishOperationActive(operationId)) {
        this.setData({ busyAction: "" });
      }
    }
  },

  saveDraft() {
    const draft = this.data.draft;
    if (!draft || !draft.canEdit || !this.data.capabilities.drafts) return Promise.resolve();
    return this.runMutation("saveDraft", {
      draftId: draft.id,
      expectedDraftVersion: draft.draftVersion,
      patch: buildChangedPatch(draft.assetType, this.data.form, draft)
    }, "草稿已保存，请核对完整性提示。 ");
  },

  async submitDraft() {
    let draft = this.data.draft;
    if (!draft || !draft.canEdit || !this.data.capabilities.drafts) return;
    if (this.data.formDirty) {
      draft = await this.saveDraft();
      if (!draft) return;
    }
    if (draft.issues.length > 0) {
      this.setData({ pageError: `暂不能送审：${draft.issues[0]}` });
      return;
    }
    const confirmed = await showConfirm({
      title: "确认送审",
      content: draft.usesStructuredPreview
        ? "送审后草稿将暂时锁定，审核员会核对当前表单内容。"
        : "送审后草稿将暂时锁定，审核员会按当前快照复核原件与内容。",
      confirmText: "送审"
    });
    if (!confirmed) return;
    await this.runMutation("submitDraft", {
      draftId: draft.id,
      expectedDraftVersion: draft.draftVersion
    }, "草稿已送审，等待内容复核。 ");
  },

  async reviewDraft(event) {
    const draft = this.data.draft;
    const decision = normalizeText(event.currentTarget.dataset.decision, 32);
    if (!draft || !draft.canReview || !this.data.capabilities.review) return;
    if (
      decision === "approve" &&
      this.data.previewedSnapshotHash !== draft.snapshotHash
    ) {
      this.setData({
        pageError: draft.usesStructuredPreview
          ? "批准前必须先核对当前表单内容。"
          : "批准前必须先打开并核对当前快照对应的原件。"
      });
      return;
    }
    const note = normalizeText(this.data.reviewNote, 1000);
    if (decision !== "approve" && !note) {
      this.setData({ pageError: "退回修改或驳回时必须填写原因。" });
      return;
    }
    const wording = decision === "approve"
      ? {
          title: draft.usesStructuredPreview ? "批准当前内容" : "批准当前快照",
          content: draft.usesStructuredPreview
            ? "请确认已经预览并核对当前表单内容。批准后将等待管理员发布。"
            : "请确认已经打开并核对原件。批准后将等待管理员发布。",
          text: "批准"
        }
      : decision === "request_changes"
        ? { title: "退回修改", content: "草稿会退回上传员继续编辑，退回原因将被保存。", text: "退回" }
        : { title: "驳回草稿", content: "驳回后当前草稿不能继续编辑，请谨慎操作。", text: "驳回" };
    const confirmed = await showConfirm({
      title: wording.title,
      content: wording.content,
      confirmText: wording.text
    });
    if (!confirmed) return;
    await this.runMutation("reviewDraft", {
      draftId: draft.id,
      expectedSnapshotHash: draft.snapshotHash,
      decision,
      note
    }, decision === "approve" ? "草稿已批准。" : "审核意见已保存。 ");
  },

  async publishDraft() {
    const draft = this.data.draft;
    if (!draft || !draft.canPublish || !this.data.capabilities.publish) return;
    const confirmed = await showConfirm({
      title: "确认正式发布",
      content: "发布会让读者端读取这个已批准版本。若目标已有更新，系统会拒绝覆盖。",
      confirmText: "发布"
    });
    if (!confirmed) return;
    await this.runPublishMutation({
      draftId: draft.id,
      expectedSnapshotHash: draft.snapshotHash,
      expectedTargetRevision: draft.basePublishedRevision || ""
    }, draft.assetType === "topic-image" ? "专题图片已准备完成。" : "内容已正式发布。 ");
  },

  async previewAsset() {
    let draft = this.data.draft;
    if (!draft || !this.data.capabilities.assetPreview || this.data.busyAction) return;
    if (
      this.data.formDirty &&
      draft.canEdit &&
      this.data.capabilities.drafts
    ) {
      draft = await this.saveDraft();
      if (!draft) return;
    }
    const operationId = (this.actionRequestId || 0) + 1;
    this.actionRequestId = operationId;
    this.setData({ busyAction: "preview", pageError: "", actionMessage: "" });
    try {
      const result = await callAdmin("getDraftAssetPreview", {
        draftId: draft.id,
        expectedSnapshotHash: draft.snapshotHash || ""
      });
      if (this.pageDestroyed || operationId !== this.actionRequestId) return;
      if (!result.success) {
        throw Object.assign(new Error(result.message || "内容预览失败"), {
          userMessage: result.message
        });
      }
      if (result.previewKind === "structured") {
        if (
          result.snapshotHash &&
          result.snapshotHash !== draft.snapshotHash
        ) {
          throw new Error("草稿内容刚刚发生变化，请重新载入后再预览");
        }
        if (
          result.assetType !== draft.assetType ||
          !isPlainObject(draft.payload)
        ) {
          throw new Error("发布效果预览数据无效，请重新载入后再试");
        }
        await this.openStructuredPreview(result, draft);
        return;
      }
      if (draft.usesStructuredPreview) {
        throw new Error("发布效果预览数据无效，请重新载入后再试");
      }
      if (!result.success || !isHttpsUrl(result.previewUrl)) {
        throw Object.assign(new Error(result.message || "预览链接获取失败"), {
          userMessage: result.message
        });
      }
      await this.openPreview(result.previewUrl, draft.assetType);
      if (!this.pageDestroyed && operationId === this.actionRequestId) {
        this.setData({
          actionMessage: "已打开当前草稿对应的原件。",
          previewedSnapshotHash:
            draft.state === "in_review" && this.data.capabilities.review
              ? draft.snapshotHash
              : this.data.previewedSnapshotHash
        });
      }
    } catch (error) {
      console.error("preview admin draft asset error:", error);
      if (!this.pageDestroyed && operationId === this.actionRequestId) {
        this.setData({
          pageError: getErrorMessage(
            error,
            draft.usesStructuredPreview
              ? "发布效果预览失败，请稍后重试。"
              : "原件预览失败，请稍后重试。"
          )
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.actionRequestId) {
        this.setData({ busyAction: "" });
      }
    }
  },

  openStructuredPreview(result, draft) {
    return new Promise((resolve, reject) => {
      const app = typeof getApp === "function" ? getApp() : null;
      if (
        !app ||
        !isPlainObject(app.globalData) ||
        typeof wx.navigateTo !== "function"
      ) {
        reject(new Error("当前微信版本无法打开发布效果预览"));
        return;
      }

      const token = createPreviewToken(draft.id);
      const cache = {
        token,
        draftId: draft.id,
        assetType: draft.assetType,
        targetId: result.targetId || draft.targetId || "",
        snapshotHash: result.snapshotHash || draft.snapshotHash || "",
        sourceMode: result.sourceMode || "",
        payload: draft.payload,
        createdAt: Date.now()
      };
      app.globalData.adminDraftPreview = cache;

      wx.navigateTo({
        url: `/pages/adminPreview/adminPreview?token=${encodeURIComponent(token)}`,
        success: () => {
          if (!this.pageDestroyed) {
            this.setData({
              actionMessage: draft.isEditorial
                ? "已打开当前表单的只读发布效果预览。"
                : "已打开当前结构化正文与内嵌图片的只读预览。",
              previewedSnapshotHash:
                draft.state === "in_review" && this.data.capabilities.review
                  ? draft.snapshotHash
                  : this.data.previewedSnapshotHash
            });
          }
          resolve();
        },
        fail: (error) => {
          if (app.globalData.adminDraftPreview === cache) {
            delete app.globalData.adminDraftPreview;
          }
          reject(Object.assign(
            new Error(error && error.errMsg || "发布效果预览页打开失败"),
            { userMessage: "发布效果预览页打开失败，请重新编译后再试。" }
          ));
        }
      });
    });
  },

  openPreview(url, assetType) {
    if (assetType === "audio") {
      this.destroyAudioPreview();
      if (typeof wx.createInnerAudioContext !== "function") {
        return Promise.reject(new Error("当前微信版本不支持录音预览"));
      }
      const audio = wx.createInnerAudioContext();
      this.previewAudio = audio;
      audio.autoplay = true;
      audio.src = url;
      if (typeof audio.onPlay === "function") {
        audio.onPlay(() => {
          if (!this.pageDestroyed) this.setData({ previewPlaying: true });
        });
      }
      const stop = () => {
        if (!this.pageDestroyed) this.setData({ previewPlaying: false });
      };
      if (typeof audio.onPause === "function") audio.onPause(stop);
      if (typeof audio.onEnded === "function") audio.onEnded(stop);
      if (typeof audio.onError === "function") {
        audio.onError(() => {
          stop();
          if (!this.pageDestroyed) {
            this.setData({ pageError: "录音加载失败，请重新获取预览。" });
          }
        });
      }
      if (typeof audio.play === "function") audio.play();
      return Promise.resolve();
    }

    if (assetType === "topic-image") {
      return new Promise((resolve, reject) => {
        if (typeof wx.previewImage !== "function") {
          reject(new Error("当前微信版本不支持图片预览"));
          return;
        }
        this.previewOpeningNative = true;
        wx.previewImage({
          current: url,
          urls: [url],
          success: (result) => {
            this.previewOpeningNative = false;
            resolve(result);
          },
          fail: (error) => {
            this.previewOpeningNative = false;
            reject(error);
          }
        });
      });
    }

    return new Promise((resolve, reject) => {
      if (typeof wx.downloadFile !== "function" || typeof wx.openDocument !== "function") {
        reject(new Error("当前微信版本不支持文档预览"));
        return;
      }
      wx.downloadFile({
        url,
        success: (downloadResult) => {
          const statusCode = Number(downloadResult && downloadResult.statusCode);
          const filePath = normalizeText(
            downloadResult && downloadResult.tempFilePath,
            2048
          );
          if (statusCode !== 200 || !filePath) {
            reject(new Error("原件下载失败"));
            return;
          }
          this.previewOpeningNative = true;
          wx.openDocument({
            filePath,
            showMenu: false,
            success: (result) => {
              this.previewOpeningNative = false;
              resolve(result);
            },
            fail: (error) => {
              this.previewOpeningNative = false;
              reject(error);
            }
          });
        },
        fail: reject
      });
    });
  },

  stopAudioPreview() {
    if (this.previewAudio && typeof this.previewAudio.stop === "function") {
      try {
        this.previewAudio.stop();
      } catch (error) {
        console.warn("stop admin preview audio error:", error);
      }
    } else if (this.previewAudio && typeof this.previewAudio.pause === "function") {
      try {
        this.previewAudio.pause();
      } catch (error) {
        console.warn("pause admin preview audio error:", error);
      }
    }
    if (!this.pageDestroyed) this.setData({ previewPlaying: false });
  },

  destroyAudioPreview() {
    if (this.previewAudio && typeof this.previewAudio.destroy === "function") {
      try {
        this.previewAudio.destroy();
      } catch (error) {
        console.warn("destroy admin preview audio error:", error);
      }
    }
    this.previewAudio = null;
    if (!this.pageDestroyed) this.setData({ previewPlaying: false });
  }
});
